import {
  createAssistantMessageEventStream,
  getApiProvider,
  registerApiProvider,
  stream as dispatchStream,
  streamSimple as dispatchStreamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StreamFunction,
  type StreamOptions,
} from '@mariozechner/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';

import {
  findProxiedProviderRewrite,
  isProviderProxied,
  loadProxiedProviderRewrites,
  loadProxiedProviders,
  normalizeModelAliasSourceRefs,
  type ProxiedProviderRewritesMap,
  type ProxiedProvidersMap,
} from './settings';

type RoutedStreamOptions = (StreamOptions | SimpleStreamOptions) & {
  __proxiedProviderVisited?: string[];
};

type RuntimeState = {
  cwd: string;
  proxiedProviders: ProxiedProvidersMap;
  rewrites: ProxiedProviderRewritesMap;
  modelRegistry?: ExtensionContext['modelRegistry'];
};

type TargetModelResolution =
  | { ok: true; model: Model<Api> }
  | { ok: false; kind: 'provider_missing' | 'ambiguous' | 'not_found'; error: string };

type ResolvedProxyRoute = {
  sourceRef: string;
  visitedKey: string;
  targetProvider: string;
  targetRefs: string[];
};

type RouteProvenance = {
  matchedProvider: string;
  matchedModel: string;
};

const MAX_ROUTING_DEPTH = 8;

/**
 * Marker we stamp on every wrapped stream function so we can detect
 * our own wrappers already being in place and avoid re-wrapping them
 * (which would layer closures and multiply per-request overhead on
 * every refresh event).
 *
 * We need this because pi-coding-agent's `ModelRegistry.refresh()` —
 * invoked from the interactive model picker on open, among other
 * places — calls `resetApiProviders()` from `@mariozechner/pi-ai`,
 * wiping every `registerApiProvider` entry. `refresh()` then only
 * re-applies providers registered through
 * `modelRegistry.registerProvider(name, config)` (the
 * `pi.registerProvider` extension API). This extension registers
 * *API-level* wrappers (one per Api, not per named provider) by
 * calling `registerApiProvider` directly from pi-ai, so those
 * registrations are not tracked by ModelRegistry and do not survive
 * `refresh()`.
 *
 * To stay correct across refreshes we re-register our wrappers on
 * every lifecycle event in `bindRuntimeState`. The marker lets us
 * no-op when the current provider in pi-ai's registry is already
 * ours.
 */
const WRAPPED_MARKER: unique symbol = Symbol.for('pi.proxied-providers.wrapped');

type MarkableStream = StreamFunction<Api, StreamOptions> & { [WRAPPED_MARKER]?: true };
type MarkableSimpleStream = StreamFunction<Api, SimpleStreamOptions> & {
  [WRAPPED_MARKER]?: true;
};

function isAlreadyWrapped(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as { [WRAPPED_MARKER]?: true })[WRAPPED_MARKER] === true;
}

let runtimeState: RuntimeState | undefined;

function adaptSimpleAsStream<TApi extends Api>(
  streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): StreamFunction<TApi, StreamOptions> {
  return (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions);
}

export function buildDelegatingStream<TApi extends Api, TOptions extends StreamOptions>(
  original: StreamFunction<TApi, TOptions>,
  proxied: StreamFunction<TApi, TOptions>,
  shouldProxy: (provider: string) => boolean,
): StreamFunction<TApi, TOptions> {
  return (model, context, options) =>
    shouldProxy(model.provider)
      ? proxied(model, context, options)
      : original(model, context, options);
}

function getRequiredApiProvider(api: Api) {
  const provider = getApiProvider(api);
  if (!provider) {
    throw new Error(`Missing built-in API provider for ${api}`);
  }
  return provider;
}

function refreshRuntimeState(ctx?: ExtensionContext): RuntimeState {
  const cwd = ctx?.cwd ?? process.cwd();
  runtimeState = {
    cwd,
    proxiedProviders: loadProxiedProviders(cwd),
    rewrites: loadProxiedProviderRewrites(cwd),
    modelRegistry: ctx?.modelRegistry ?? runtimeState?.modelRegistry,
  };
  return runtimeState;
}

function getRuntimeState(): RuntimeState {
  return runtimeState ?? refreshRuntimeState();
}

function createErrorMessage(model: Model<Api>, errorMessage: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage,
    timestamp: Date.now(),
  };
}

function rewriteEventModel(
  event: any,
  provider: string,
  modelId: string,
  sourceProvider?: string,
  sourceModelId?: string,
  provenance?: RouteProvenance,
): any {
  const rewriteMessage = (message: any) => ({
    ...message,
    provider,
    model: modelId,
    ...(sourceProvider && { sourceProvider }),
    ...(sourceModelId && { sourceModel: sourceModelId }),
    ...(provenance?.matchedProvider && { matchedProvider: provenance.matchedProvider }),
    ...(provenance?.matchedModel && { matchedModel: provenance.matchedModel }),
  });

  if (event.type === 'start') {
    return { ...event, partial: rewriteMessage(event.partial) };
  }

  if (event.type === 'done') {
    return { ...event, message: rewriteMessage(event.message) };
  }

  if (event.type === 'error') {
    return { ...event, error: rewriteMessage(event.error) };
  }

  if ('partial' in event && event.partial) {
    return { ...event, partial: rewriteMessage(event.partial) };
  }

  return event;
}

function createImmediateErrorStream(
  model: Model<Api>,
  errorMessage: string,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: 'error',
    reason: 'error',
    error: createErrorMessage(model, errorMessage),
  });
  stream.end();
  return stream;
}

function formatAmbiguousTarget(provider: string, targetRef: string, matches: Model<Api>[]): string {
  const matchList = matches.map((match) => `${match.provider}/${match.id}`).join(', ');
  return `Ambiguous target ${provider}/${targetRef}; matches: ${matchList}`;
}

export function resolveTargetProviderModel(
  availableModels: Model<Api>[],
  targetProvider: string,
  targetRef: string,
): TargetModelResolution {
  const normalizedProvider = targetProvider.toLowerCase();
  const providerModels = availableModels.filter(
    (model) => model.provider.toLowerCase() === normalizedProvider,
  );
  if (providerModels.length === 0) {
    return {
      ok: false,
      kind: 'provider_missing',
      error: `Target provider ${targetProvider} has no registered models`,
    };
  }

  const normalizedTargetRef = targetRef.trim().toLowerCase();
  const exactIdMatches = providerModels.filter(
    (model) => model.id.toLowerCase() === normalizedTargetRef,
  );
  if (exactIdMatches.length === 1) {
    return { ok: true, model: exactIdMatches[0] };
  }
  if (exactIdMatches.length > 1) {
    return {
      ok: false,
      kind: 'ambiguous',
      error: formatAmbiguousTarget(targetProvider, targetRef, exactIdMatches),
    };
  }

  const exactNameMatches = providerModels.filter(
    (model) => model.name?.toLowerCase() === normalizedTargetRef,
  );
  if (exactNameMatches.length === 1) {
    return { ok: true, model: exactNameMatches[0] };
  }
  if (exactNameMatches.length > 1) {
    return {
      ok: false,
      kind: 'ambiguous',
      error: formatAmbiguousTarget(targetProvider, targetRef, exactNameMatches),
    };
  }

  const targetCandidates = normalizeModelAliasSourceRefs(targetRef).map((candidate) =>
    candidate.toLowerCase(),
  );
  const providerModelCandidates = providerModels.map((model) => ({
    model,
    candidates: new Set(
      [model.id, model.name]
        .filter((value): value is string => Boolean(value))
        .flatMap((value) =>
          normalizeModelAliasSourceRefs(value).map((candidate) => candidate.toLowerCase()),
        ),
    ),
  }));

  for (const candidate of targetCandidates) {
    const candidateMatches = providerModelCandidates
      .filter(({ candidates }) => candidates.has(candidate))
      .map(({ model }) => model);
    if (candidateMatches.length === 1) {
      return { ok: true, model: candidateMatches[0] };
    }
    if (candidateMatches.length > 1) {
      return {
        ok: false,
        kind: 'ambiguous',
        error: formatAmbiguousTarget(targetProvider, targetRef, candidateMatches),
      };
    }
  }

  return {
    ok: false,
    kind: 'not_found',
    error: `Target ${targetProvider}/${targetRef} not found`,
  };
}

function expandFriendlyTargetRefs(targetRefs: string[]): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const push = (ref: string) => {
    const trimmed = ref.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  for (const ref of targetRefs) {
    push(ref);
    push(ref.replace(/-nomoderation$/i, ''));
  }

  return candidates;
}

export function resolveConfiguredTargetModel(
  availableModels: Model<Api>[],
  targetProvider: string,
  targetRefs: string[],
): TargetModelResolution {
  let lastNotFound: TargetModelResolution | undefined;
  const candidates = expandFriendlyTargetRefs(targetRefs);

  for (const targetRef of candidates) {
    const resolved = resolveTargetProviderModel(availableModels, targetProvider, targetRef);
    if (resolved.ok) {
      return resolved;
    }
    if (resolved.kind !== 'not_found') {
      return resolved;
    }
    lastNotFound = resolved;
  }

  return (
    lastNotFound ?? {
      ok: false,
      kind: 'not_found',
      error: `Target ${targetProvider}/${targetRefs[0] ?? ''} not found`,
    }
  );
}

export function resolveProxyRoute(
  sourceModel: Model<Api>,
  sourceModelName: string | undefined,
  state: RuntimeState,
): ResolvedProxyRoute | undefined {
  const hit = findProxiedProviderRewrite(
    state.rewrites,
    sourceModel.provider,
    sourceModel.id,
    sourceModelName,
  );
  if (!hit) return undefined;
  if (hit.target.kind === 'exclude') return undefined;

  // When no explicit target model is given (provider-wide rewrites), fall
  // back to the source model's id/name so resolveConfiguredTargetModel can
  // locate the equivalent entry in the target provider's registry.
  const targetRefs = hit.target.targetModel
    ? [hit.target.targetModel]
    : sourceModelName && sourceModelName !== sourceModel.id
      ? [sourceModel.id, sourceModelName]
      : [sourceModel.id];

  return {
    sourceRef: hit.sourceRef,
    visitedKey: `rewrite:${hit.sourceRef}`,
    targetProvider: hit.target.targetProvider,
    targetRefs,
  };
}

function buildConfiguredStream(
  sourceModel: Model<Api>,
  context: Context,
  options: RoutedStreamOptions | undefined,
  dispatcher: typeof dispatchStream | typeof dispatchStreamSimple,
): AssistantMessageEventStream | undefined {
  const state = getRuntimeState();
  const sourceRegistryModel = state.modelRegistry?.find(sourceModel.provider, sourceModel.id);
  const visited = options?.__proxiedProviderVisited ?? [];
  const resolvedRoute = resolveProxyRoute(
    sourceModel,
    sourceRegistryModel?.name ?? sourceModel.name,
    state,
  );
  if (!resolvedRoute) {
    return undefined;
  }

  const modelRegistry = state.modelRegistry;
  if (!modelRegistry) {
    return createImmediateErrorStream(
      sourceModel,
      `No model registry available to resolve proxied route for ${resolvedRoute.sourceRef}`,
    );
  }

  const resolvedTarget = resolveConfiguredTargetModel(
    modelRegistry.getAll(),
    resolvedRoute.targetProvider,
    resolvedRoute.targetRefs,
  );
  if (!resolvedTarget.ok) {
    return createImmediateErrorStream(
      sourceModel,
      `${resolvedTarget.error} for ${resolvedRoute.sourceRef}`,
    );
  }
  const targetModel = resolvedTarget.model;

  if (targetModel.provider === sourceModel.provider && targetModel.id === sourceModel.id) {
    return undefined;
  }

  if (visited.includes(resolvedRoute.visitedKey) || visited.length >= MAX_ROUTING_DEPTH) {
    return createImmediateErrorStream(
      sourceModel,
      `Routing loop detected while routing ${resolvedRoute.sourceRef}`,
    );
  }

  const provenance: RouteProvenance = {
    matchedProvider: sourceModel.provider,
    matchedModel: sourceModel.id,
  };
  const stream = createAssistantMessageEventStream();
  void (async () => {
    try {
      const auth = await modelRegistry.getApiKeyAndHeaders(targetModel);
      if (!auth.ok) {
        throw new Error(auth.error);
      }

      const routed = dispatcher(targetModel, context, {
        ...options,
        apiKey: auth.apiKey,
        headers: auth.headers,
        __proxiedProviderVisited: [...visited, resolvedRoute.visitedKey],
      } as StreamOptions & SimpleStreamOptions & Record<string, unknown>);

      for await (const event of routed) {
        stream.push(
          rewriteEventModel(
            event,
            targetModel.provider,
            targetModel.id,
            sourceModel.provider,
            sourceModel.id,
            provenance,
          ),
        );
      }
      stream.end();
    } catch (error) {
      stream.push({
        type: 'error',
        reason: 'error',
        error: createErrorMessage(
          sourceModel,
          error instanceof Error ? error.message : String(error),
        ),
      });
      stream.end();
    }
  })();

  return stream;
}

function buildRoutingStream<TApi extends Api, TOptions extends StreamOptions>(options: {
  original: StreamFunction<TApi, TOptions>;
  proxied?: StreamFunction<TApi, TOptions>;
  shouldProxy: (provider: string) => boolean;
  dispatcher: typeof dispatchStream | typeof dispatchStreamSimple;
}): StreamFunction<TApi, TOptions> {
  const { original, proxied, shouldProxy, dispatcher } = options;

  return (model, context, streamOptions) => {
    const routed = buildConfiguredStream(
      model as Model<Api>,
      context,
      streamOptions as RoutedStreamOptions | undefined,
      dispatcher,
    );
    if (routed) {
      return routed;
    }

    if (proxied && shouldProxy(model.provider)) {
      return proxied(model, context, streamOptions);
    }

    return original(model, context, streamOptions);
  };
}

function registerWrappedApi<TApi extends Api>(options: {
  api: TApi;
  sourceId: string;
  proxiedSimple?: StreamFunction<TApi, SimpleStreamOptions>;
  proxiedSimpleFactory?: (
    originalStreamSimple: StreamFunction<TApi, SimpleStreamOptions>,
  ) => StreamFunction<TApi, SimpleStreamOptions>;
}): void {
  const original = getRequiredApiProvider(options.api);

  // If pi-ai's registry already has our wrapper installed for this api
  // (typical steady-state between refreshes), skip to avoid stacking
  // closures on every lifecycle event. See WRAPPED_MARKER comment.
  if (isAlreadyWrapped(original.stream) && isAlreadyWrapped(original.streamSimple)) {
    return;
  }

  const proxiedSimple =
    options.proxiedSimple ?? options.proxiedSimpleFactory?.(original.streamSimple);
  const proxiedStream = proxiedSimple ? adaptSimpleAsStream(proxiedSimple) : undefined;

  const wrappedStream = buildRoutingStream({
    original: original.stream,
    proxied: proxiedStream,
    shouldProxy: (provider) => isProviderProxied(provider, getRuntimeState().proxiedProviders),
    dispatcher: dispatchStream,
  });
  const wrappedStreamSimple = buildRoutingStream({
    original: original.streamSimple,
    proxied: proxiedSimple,
    shouldProxy: (provider) => isProviderProxied(provider, getRuntimeState().proxiedProviders),
    dispatcher: dispatchStreamSimple,
  });

  (wrappedStream as MarkableStream)[WRAPPED_MARKER] = true;
  (wrappedStreamSimple as MarkableSimpleStream)[WRAPPED_MARKER] = true;

  registerApiProvider(
    {
      api: options.api,
      stream: wrappedStream,
      streamSimple: wrappedStreamSimple,
    },
    `extension:proxied-providers:${options.sourceId}`,
  );
}

/**
 * Install our wrappers over every API we care about. Idempotent: each
 * `registerWrappedApi` call is a no-op when the wrapper is already in
 * pi-ai's registry. Called once at extension load and again from
 * `bindRuntimeState` on every lifecycle event so we recover from
 * `ModelRegistry.refresh()` blowing away the registry.
 */
function registerAllWrappedApis(): void {
  registerWrappedApi({
    api: 'anthropic-messages',
    sourceId: 'anthropic-messages',
  });
  registerWrappedApi({
    api: 'openai-responses',
    sourceId: 'openai-responses',
  });
  registerWrappedApi({
    api: 'openai-completions',
    sourceId: 'openai-completions',
  });
  registerWrappedApi({
    api: 'google-generative-ai',
    sourceId: 'google-generative-ai',
  });
}

function bindRuntimeState(_event: unknown, ctx: ExtensionContext): void {
  refreshRuntimeState(ctx);
  // Re-install wrappers in case pi-ai's api-provider registry has been
  // reset since the last lifecycle event (e.g. by the model picker
  // calling ModelRegistry.refresh()).
  registerAllWrappedApis();
}

/**
 * Human-friendly summary of provider response headers that matter when a
 * request fails. Returns undefined when the headers are empty or irrelevant
 * to back-pressure decisions.
 */
function summarizeProviderResponseHeaders(headers: Record<string, string>): string | undefined {
  const picked: string[] = [];
  const consider = (key: string): void => {
    const value = headers[key] ?? headers[key.toLowerCase()];
    if (value !== undefined && value !== '') picked.push(`${key}=${value}`);
  };

  // Rate-limit + retry signals that most providers expose in some form.
  consider('retry-after');
  consider('x-ratelimit-remaining');
  consider('x-ratelimit-remaining-requests');
  consider('x-ratelimit-remaining-tokens');
  consider('x-ratelimit-reset');
  consider('x-ratelimit-reset-requests');
  consider('x-ratelimit-reset-tokens');
  // Provider-level identification is useful when diagnosing proxy routing.
  consider('server');
  consider('x-served-by');

  return picked.length > 0 ? picked.join(' ') : undefined;
}

function shouldDiagnoseResponseStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Minimal observer for provider responses. Logs back-pressure signals to
 * stderr when a request fails in a way the auto-retry logic reacts to.
 * Visible in `/log` and any process capturing stderr, and silent on the
 * happy path so it does not clutter normal sessions.
 *
 * Opt-out via `PI_PROXIED_PROVIDERS_DIAGNOSTICS=0`.
 */
function reportProviderResponse(event: { status: number; headers: Record<string, string> }): void {
  if (process.env.PI_PROXIED_PROVIDERS_DIAGNOSTICS === '0') return;
  if (!shouldDiagnoseResponseStatus(event.status)) return;

  const summary = summarizeProviderResponseHeaders(event.headers);
  if (summary) {
    console.warn(`[proxied-providers] provider response ${event.status} — ${summary}`);
  } else {
    console.warn(`[proxied-providers] provider response ${event.status}`);
  }
}

export default function (pi: ExtensionAPI) {
  registerAllWrappedApis();

  pi.on('session_start', bindRuntimeState);
  pi.on('before_agent_start', bindRuntimeState);
  pi.on('model_select', bindRuntimeState);
  pi.on('after_provider_response', (event) => {
    reportProviderResponse(event);
  });
}

export { reportProviderResponse, summarizeProviderResponseHeaders };
