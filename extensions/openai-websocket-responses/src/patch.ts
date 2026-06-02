import {
  createAssistantMessageEventStream,
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
import { extractTransportDiagnostics, mergeTransportDiagnostics } from './transport-diagnostics.ts';
import { createTraceContextForTraceId, type TraceContext } from './trace-context.ts';

type StreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

const WRAPPED = Symbol.for('openai-websocket-responses.wrapped');

type WrappedFunction = Function & { [WRAPPED]?: boolean };

type StreamForOptions<TOptions extends StreamOptions> = (
  options?: TOptions,
) => AssistantMessageEventStream;

function isSseTransport(options: StreamOptions | undefined): boolean {
  return options?.transport === 'sse';
}

function canFallbackToSse(options: StreamOptions | undefined): boolean {
  return options?.transport === undefined || options.transport === 'auto';
}

function traceFromDiagnostics(
  diagnostics: ReturnType<typeof extractTransportDiagnostics>,
): TraceContext | undefined {
  const traceId = diagnostics.find(
    (diagnostic) => typeof diagnostic.details?.logicalTraceId === 'string',
  )?.details?.logicalTraceId;
  return typeof traceId === 'string' ? createTraceContextForTraceId(traceId) : undefined;
}

function traceFields(trace: TraceContext | undefined): Record<string, string> {
  return trace
    ? { traceparent: trace.traceparent, traceId: trace.traceId, spanId: trace.spanId }
    : {};
}

function headersWithoutTraceparent(
  headers: StreamOptions['headers'] | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() !== 'traceparent'),
  );
}

function sseOptions<TOptions extends StreamOptions>(
  options: TOptions | undefined,
  trace: TraceContext | undefined,
): TOptions {
  if (!trace) return { ...options, transport: 'sse' } as TOptions;
  return {
    ...options,
    transport: 'sse',
    headers: { ...headersWithoutTraceparent(options?.headers), traceparent: trace.traceparent },
  } as unknown as TOptions;
}

async function pipeStream(
  source: AssistantMessageEventStream,
  target: AssistantMessageEventStream,
  fallbackDiagnostics = [] as ReturnType<typeof extractTransportDiagnostics>,
  fallbackTrace?: TraceContext,
): Promise<void> {
  try {
    for await (const event of source) {
      if (fallbackDiagnostics.length > 0 && event.type === 'done') {
        mergeTransportDiagnostics(event.message, fallbackDiagnostics, {
          fallbackTransport: 'sse',
          finalResponseId: event.message.responseId,
          finalTransport: 'sse',
          outcome: 'sse_fallback_after_websocket_failure',
          ...traceFields(fallbackTrace),
          timelineEvent: {
            type: 'sse_fallback',
            reason: 'websocket_failed_before_stream_start',
            ...traceFields(fallbackTrace),
          },
        });
      }
      if (fallbackDiagnostics.length > 0 && event.type === 'error') {
        mergeTransportDiagnostics(event.error, fallbackDiagnostics, {
          fallbackTransport: 'sse',
          finalResponseId: event.error.responseId,
          finalTransport: 'sse',
          outcome: 'sse_fallback_after_websocket_failure',
          ...traceFields(fallbackTrace),
          timelineEvent: {
            type: 'sse_fallback',
            reason: 'websocket_failed_before_stream_start',
            ...traceFields(fallbackTrace),
          },
        });
      }
      target.push(event);
    }
  } finally {
    target.end();
  }
}

function streamWithAutoSseFallback<TOptions extends StreamOptions>(
  options: TOptions | undefined,
  websocketStream: StreamForOptions<TOptions>,
  originalStream: StreamForOptions<TOptions>,
): AssistantMessageEventStream {
  if (isSseTransport(options)) return originalStream(sseOptions(options, undefined));
  if (!canFallbackToSse(options)) return websocketStream(options);

  const proxy = createAssistantMessageEventStream();
  void (async () => {
    let started = false;
    try {
      const source = websocketStream(options);
      for await (const event of source) {
        if (!started && event.type === 'error') {
          const fallbackDiagnostics = extractTransportDiagnostics(event.error);
          const fallbackTrace = traceFromDiagnostics(fallbackDiagnostics);
          await pipeStream(
            originalStream(sseOptions(options, fallbackTrace)),
            proxy,
            fallbackDiagnostics,
            fallbackTrace,
          );
          return;
        }
        started = true;
        proxy.push(event);
      }
    } catch (error) {
      if (!started) {
        const fallbackDiagnostics = extractTransportDiagnostics(error as { diagnostics?: any[] });
        const fallbackTrace = traceFromDiagnostics(fallbackDiagnostics);
        await pipeStream(
          originalStream(sseOptions(options, fallbackTrace)),
          proxy,
          fallbackDiagnostics,
          fallbackTrace,
        );
        return;
      }
      throw error;
    } finally {
      proxy.end();
    }
  })();
  return proxy;
}

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
    if (shouldPatchModel(model, settings)) {
      return streamWithAutoSseFallback(
        options,
        (nextOptions) => websocketStream(model, context, nextOptions),
        (nextOptions) => originalStreamSimple.call(provider, model, context, nextOptions),
      );
    }
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
    if (shouldPatchModel(model, settings)) {
      return streamWithAutoSseFallback(
        options,
        (nextOptions) => websocketStream(model, context, nextOptions as SimpleStreamOptions),
        (nextOptions) => originalStream.call(provider, model, context, nextOptions),
      );
    }
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
