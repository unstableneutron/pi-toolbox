import type {
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
} from '@mariozechner/pi-ai';

import { PROXIED_PROVIDER_ERROR_CODES, ProxiedProviderError } from './http';

/**
 * AWS-related env vars that can silently derail a proxied Bedrock request
 * pointed at a non-AWS gateway (e.g. fusion-hub). We clear them in-process
 * before delegating so the wrapper is self-contained regardless of what
 * the surrounding shell exports.
 *
 * Grouped by failure mode for auditability. None of these are needed when
 * we talk to fusion-hub via `AWS_BEARER_TOKEN_BEDROCK` +
 * `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`; each has been observed or
 * code-path-verified to break the request if left set.
 */
const AWS_ENV_VARS_TO_NEUTRALIZE: readonly string[] = [
  // Credential resolution. pi-ai pins `config.credentials` to a dummy pair
  // when a bearer token is present, but the SDK's lazy credential-provider
  // chain can still observe these and derail signing in some code paths.
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  // Endpoint resolution. We pin the fusion-hub URL via the
  // bedrock-specific env var; the generic / FIPS / dual-stack flags can
  // override it depending on SDK version.
  'AWS_ENDPOINT_URL',
  'AWS_USE_FIPS_ENDPOINT',
  'AWS_USE_DUALSTACK_ENDPOINT',
  // TLS. fusion-hub presents a valid public cert; a custom CA bundle
  // breaks the handshake.
  'AWS_CA_BUNDLE',
  // Proxy. pi-ai auto-wires `proxy-agent` + `NodeHttpHandler` if any of
  // these is set, routing fusion-hub traffic through the proxy — usually
  // undesired from a dev laptop.
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  // Skip-auth. With `AWS_BEDROCK_SKIP_AUTH=1` pi-ai installs dummy
  // credentials instead of the bearer placeholder. Our bearer middleware
  // still runs, but it's one more branch of divergence we don't need.
  'AWS_BEDROCK_SKIP_AUTH',
];

/**
 * Region pin. pi-ai's Bedrock path resolves region as:
 *   options.region → AWS_REGION → AWS_DEFAULT_REGION → (profile lookup if
 *   AWS_PROFILE is set, else us-east-1).
 *
 * We want `us-east-1` regardless of shell env, because fusion-hub's
 * bearer-token endpoint lives at a region-independent path and the SDK's
 * signing / SDK metadata just needs *some* region to construct the
 * client.
 */
const PINNED_AWS_REGION = 'us-east-1';

/**
 * Create a thin proxied-transport wrapper over pi-ai's stock
 * `streamSimpleBedrock`, which is passed in as `originalStreamSimple`
 * (typically `getRequiredApiProvider('bedrock-converse-stream').streamSimple`).
 *
 * Proxied Bedrock routes (e.g. facade → proxy.example.com) need
 * three things that pi-ai's AWS SDK client doesn't configure from model
 * fields:
 *
 *   1. `Authorization: Bearer <iap-token>` instead of SigV4 signing.
 *   2. An endpoint override to the fusion-hub URL instead of the default
 *      `bedrock-runtime.<region>.amazonaws.com`.
 *   3. A hermetic AWS env so ambient shell state (AWS_PROFILE, proxies,
 *      custom CA bundles, ...) can't silently derail the request.
 *
 * pi-ai 0.67.67 supports (1) and (2) natively via environment variables,
 * plus `AWS_BEDROCK_FORCE_HTTP1` for the Node http2 authorization-header
 * collision (see detailed comment below). We neutralize the rest in-
 * process to address (3).
 *
 * Permanent, process-wide env mutation is intentional. JS is single-
 * threaded and pi-ai's `streamBedrock` reads env vars synchronously
 * before the first `await` in its async body, so setting them
 * immediately before delegating is race-free: no other code runs between
 * the assignments and pi-ai capturing them into the client / middleware
 * closure. Restoring env after the call would be brittle — some SDK
 * reads (TLS CA bundle, lazy endpoint resolution) happen later on the
 * first request, and restoring too early re-introduces the very
 * misconfiguration we just removed. pi itself doesn't invoke any other
 * AWS APIs from the same process, so keeping the env clean for the
 * process lifetime is the simplest correct behavior.
 *
 * The bearer token comes from `options.headers.Authorization`, which pi-ai
 * resolves via the model's `apiKey` config (e.g. `DEVAIGATEWAY_API_KEY` →
 * the `iap-auth` command) per request, so the token naturally refreshes
 * each time pi builds a new stream.
 *
 * `AWS_BEDROCK_FORCE_HTTP1=1` works around a pi-ai 0.67.67 middleware
 * bug: its bearer middleware writes lowercase `authorization` on the
 * request headers but doesn't delete SigV4's capitalized
 * `Authorization`. Both survive into the outgoing request, and AWS
 * SDK's default `NodeHttp2Handler` hits Node's
 * `ERR_HTTP2_HEADER_SINGLE_VALUE` and refuses to send.
 * `NodeHttpHandler` (HTTP/1.1) merges the case-variant duplicates so
 * the bearer wins. Should be fixed upstream, but HTTP/1.1 is a clean
 * workaround.
 *
 * We accept `originalStreamSimple` as a parameter rather than importing
 * `@mariozechner/pi-ai/bedrock-provider` directly because pi's extension
 * loader (jiti) doesn't honor package.json `exports` subpaths, and pi-ai
 * doesn't re-export the provider module from its main entry point.
 */
export function createStreamSimpleProxiedBedrock(
  originalStreamSimple: StreamFunction<'bedrock-converse-stream', SimpleStreamOptions>,
): StreamFunction<'bedrock-converse-stream', SimpleStreamOptions> {
  return (
    model: Model<'bedrock-converse-stream'>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    if (!model.baseUrl) {
      throw new ProxiedProviderError(
        PROXIED_PROVIDER_ERROR_CODES.INVALID_BASE_URL,
        `Missing baseUrl for proxied provider: ${model.provider}`,
      );
    }

    const authHeader = getAuthorizationHeader(options?.headers);
    const token =
      typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';
    if (!token) {
      throw new ProxiedProviderError(
        PROXIED_PROVIDER_ERROR_CODES.MISSING_AUTH,
        `Missing auth for proxied provider: ${model.provider}`,
      );
    }

    neutralizeAwsEnv();
    process.env.AWS_REGION = PINNED_AWS_REGION;
    process.env.AWS_DEFAULT_REGION = PINNED_AWS_REGION;
    process.env.AWS_BEARER_TOKEN_BEDROCK = token;
    process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = model.baseUrl;
    process.env.AWS_BEDROCK_FORCE_HTTP1 = '1';

    return originalStreamSimple(model, context, options);
  };
}

function neutralizeAwsEnv(): void {
  for (const name of AWS_ENV_VARS_TO_NEUTRALIZE) {
    delete process.env[name];
  }
}

function getAuthorizationHeader(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'authorization') return value;
  }
  return undefined;
}
