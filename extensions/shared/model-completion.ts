import {
  complete,
  completeSimple,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ModelsApiStreamOptions,
  type ProviderHeaders,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai/compat';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';

function mergeHeaders(
  resolved: ProviderHeaders | undefined,
  request: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
  return resolved || request ? { ...resolved, ...request } : undefined;
}

/**
 * Use Pi's request-time model runtime when the provider has configured auth.
 * Keep the compatibility path for keyless local providers, which the 0.84.1
 * ModelRegistry.complete() auth preflight does not yet accept.
 */
export async function completeWithModelRegistry<TApi extends Api>(
  modelRegistry: ModelRegistry,
  model: Model<TApi>,
  context: Context,
  options?: ModelsApiStreamOptions<TApi>,
): Promise<AssistantMessage> {
  if (modelRegistry.hasConfiguredAuth(model) || options?.apiKey) {
    return modelRegistry.complete(model, context, options);
  }

  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);

  const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
  const transformHeaders = options?.transformHeaders;
  const providerOptions = { ...options } as unknown as ModelsApiStreamOptions<TApi>;
  delete providerOptions.transformHeaders;
  let headers = mergeHeaders(auth.headers, providerOptions.headers);
  if (transformHeaders) headers = await transformHeaders(headers ?? {});
  const env = auth.env || providerOptions.env ? { ...auth.env, ...providerOptions.env } : undefined;
  return complete(requestModel, context, {
    ...providerOptions,
    apiKey: providerOptions.apiKey ?? auth.apiKey,
    headers,
    env,
  });
}

/** Resolve Pi request auth while preserving pi-ai's simple-option mapping. */
export async function completeSimpleWithResolvedAuth<TApi extends Api>(
  modelRegistry: ModelRegistry,
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);

  const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
  const providerOptions: SimpleStreamOptions = { ...options };
  const headers = mergeHeaders(auth.headers, providerOptions.headers);
  const env = auth.env || providerOptions.env ? { ...auth.env, ...providerOptions.env } : undefined;
  return completeSimple(requestModel, context, {
    ...providerOptions,
    apiKey: providerOptions.apiKey ?? auth.apiKey,
    headers,
    env,
  });
}
