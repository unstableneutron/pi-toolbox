import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  readOpenAIWebSocketResponsesPrimeSettings,
  type OpenAIWebSocketResponsesSettings,
} from './src/settings.ts';

const PRIME_RESPONSES_APIS = ['openai-codex-responses', 'openai-responses'] as const;
const PRIME_HOOK_SOURCE = 'prime-agent:openai-websocket-responses';
const WRAPPED = Symbol.for('openai-websocket-responses.prime-hook.wrapped');

type Stream = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

type ApiProviderLike = {
  api: Api;
  stream: Stream;
  streamSimple: Stream;
};

type ApiRegistry = {
  getApiProvider(api: Api): ApiProviderLike | undefined;
  registerApiProvider(provider: ApiProviderLike, sourceId?: string): void;
};

type MarkableStream = Stream & { [WRAPPED]?: true };

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function configuredTransport(
  model: Pick<Model<Api>, 'provider' | 'id'>,
  settings: OpenAIWebSocketResponsesSettings,
): 'auto' | 'sse' | 'websocket' | undefined {
  const providerModel = `${model.provider}/${model.id}`;
  let result: 'auto' | 'sse' | 'websocket' | undefined;
  for (const [pattern, transport] of Object.entries(settings.patch.transportByProviderModel)) {
    if (globToRegExp(pattern).test(providerModel)) result = transport;
  }
  return result;
}

function shouldHook(
  model: Pick<Model<Api>, 'api' | 'provider' | 'id'>,
  settings: OpenAIWebSocketResponsesSettings,
): boolean {
  if (!settings.patch.enabled || !matchesAny(model.api, settings.patch.apis)) return false;
  const providerModel = `${model.provider}/${model.id}`;
  if (matchesAny(providerModel, settings.patch.excludeProviderModels)) return false;
  return (
    matchesAny(model.provider, settings.patch.providers) ||
    matchesAny(providerModel, settings.patch.providerModels) ||
    configuredTransport(model, settings) !== undefined
  );
}

function isMarked(stream: Stream): boolean {
  return (stream as MarkableStream)[WRAPPED] === true;
}

function mark(stream: Stream): Stream {
  Object.defineProperty(stream, WRAPPED, { value: true });
  return stream;
}

function hookPrimeStream(
  original: Stream,
  settingsProvider: () => OpenAIWebSocketResponsesSettings,
): Stream {
  if (isMarked(original)) return original;

  return mark((model, context, options) => {
    const settings = settingsProvider();
    if (!shouldHook(model, settings)) return original(model, context, options);

    const transport = configuredTransport(model, settings);
    // Prime provides the actual Responses transports. The hook only selects a
    // user-configured transport. With the default auto policy it forwards the
    // exact original options, preserving Prime's native Codex WebSocket reuse,
    // Codex SSE fallback, and regular Responses SSE behavior.
    return transport && transport !== 'auto'
      ? original(model, context, { ...options, transport })
      : original(model, context, options);
  });
}

export function installPrimeOpenAIWebSocketResponsesHooks(
  registry: ApiRegistry,
  settingsProvider: () => OpenAIWebSocketResponsesSettings,
): void {
  for (const api of PRIME_RESPONSES_APIS) {
    const provider = registry.getApiProvider(api);
    if (
      !provider ||
      (provider.api !== 'openai-codex-responses' && provider.api !== 'openai-responses')
    ) {
      continue;
    }
    if (isMarked(provider.stream) && isMarked(provider.streamSimple)) continue;

    registry.registerApiProvider(
      {
        api,
        stream: hookPrimeStream(provider.stream, settingsProvider),
        streamSimple: hookPrimeStream(provider.streamSimple, settingsProvider),
      },
      PRIME_HOOK_SOURCE,
    );

    // Prime wraps registered streams to enforce API/model consistency. Mark
    // those public registry wrappers too, so a package reload cannot stack the
    // hook on top of itself.
    const registered = registry.getApiProvider(api);
    if (registered) {
      mark(registered.stream);
      mark(registered.streamSimple);
    }
  }
}

async function loadPrimeApiRegistry(): Promise<ApiRegistry | undefined> {
  try {
    const piAi = await import('@earendil-works/pi-ai');
    const registry = piAi as unknown as Partial<ApiRegistry>;
    return typeof registry.getApiProvider === 'function' &&
      typeof registry.registerApiProvider === 'function'
      ? (registry as ApiRegistry)
      : undefined;
  } catch {
    return undefined;
  }
}

export default async function openAIWebSocketResponsesPrime(pi: ExtensionAPI): Promise<void> {
  const registry = await loadPrimeApiRegistry();
  if (!registry) return;

  let currentCtx: ExtensionContext | undefined;
  const install = () =>
    installPrimeOpenAIWebSocketResponsesHooks(registry, () =>
      readOpenAIWebSocketResponsesPrimeSettings(currentCtx?.cwd),
    );

  install();
  pi.on('session_start', (_event, ctx) => {
    currentCtx = ctx;
    // Prime resets its API-provider registry during reload. Reapply the thin
    // selector over the newly restored native providers.
    install();
  });
  pi.on('session_shutdown', () => {
    currentCtx = undefined;
  });
}
