import {
  registerApiProvider,
  getApiProviders,
  type Api,
  type ApiProvider,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StreamOptions,
} from '@earendil-works/pi-ai';

import { shouldPatchModel } from './match.ts';
import type { OpenAIWebSocketResponsesSettings } from './settings.ts';

type StreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

const WRAPPED = Symbol.for('openai-websocket-responses.wrapped');

type WrappedFunction = Function & { [WRAPPED]?: boolean };

export function wrapProviderForWebSocketResponses<TProvider extends ApiProvider<any>>(
  provider: TProvider,
  settingsProvider: () => OpenAIWebSocketResponsesSettings,
  websocketStream: StreamSimple,
): TProvider {
  const originalStreamSimple = provider.streamSimple as StreamSimple & WrappedFunction;
  if (originalStreamSimple[WRAPPED]) return provider;

  const wrappedStreamSimple = ((
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => {
    const settings = settingsProvider();
    if (shouldPatchModel(model, settings)) return websocketStream(model, context, options);
    return originalStreamSimple.call(provider, model, context, options);
  }) as StreamSimple & WrappedFunction;
  Object.defineProperty(wrappedStreamSimple, WRAPPED, { value: true });

  const originalStream = provider.stream as unknown as (
    model: Model<Api>,
    context: Context,
    options?: StreamOptions,
  ) => AssistantMessageEventStream;
  const wrappedStream = ((model: Model<Api>, context: Context, options?: StreamOptions) => {
    const settings = settingsProvider();
    if (shouldPatchModel(model, settings))
      return websocketStream(model, context, options as SimpleStreamOptions);
    return originalStream.call(provider, model, context, options);
  }) as typeof originalStream & WrappedFunction;
  Object.defineProperty(wrappedStream, WRAPPED, { value: true });

  return {
    ...provider,
    stream: wrappedStream as TProvider['stream'],
    streamSimple: wrappedStreamSimple as TProvider['streamSimple'],
  };
}

export function installOpenAIWebSocketResponsesPatch(
  settingsProvider: () => OpenAIWebSocketResponsesSettings,
  websocketStream: StreamSimple,
): void {
  for (const provider of getApiProviders()) {
    const settings = settingsProvider();
    if (!settings.patch.enabled || !settings.patch.apis.includes(provider.api)) continue;
    registerApiProvider(
      wrapProviderForWebSocketResponses(
        provider as ApiProvider<any>,
        settingsProvider,
        websocketStream,
      ),
    );
  }
}
