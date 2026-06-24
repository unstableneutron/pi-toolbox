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
} from '@earendil-works/pi-ai/compat';

import { shouldPatchModel } from './match.ts';
import type { OpenAIWebSocketResponsesSettings } from './settings.ts';
import { extractTransportDiagnostics, mergeTransportDiagnostics } from './transport-diagnostics.ts';
import { createTraceContextForTraceId, type TraceContext } from './trace-context.ts';
import type { WebSocketLifecycleObserver } from './websocket.ts';

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

type PipeResult = 'done' | 'error' | undefined;

function emitLifecycle(
  onLifecycleEvent: WebSocketLifecycleObserver | undefined,
  event: Parameters<WebSocketLifecycleObserver>[0],
): void {
  try {
    onLifecycleEvent?.(event);
  } catch {
    // Lifecycle observers are UI/diagnostic-only and must not affect fallback transport.
  }
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const candidate = error as Record<string, unknown>;
    if (typeof candidate.errorMessage === 'string') return candidate.errorMessage;
    if (typeof candidate.message === 'string') return candidate.message;
  }
  return typeof error === 'string' ? error : undefined;
}

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
    Object.entries(headers ?? {}).filter(
      (entry): entry is [string, string] =>
        entry[0].toLowerCase() !== 'traceparent' && entry[1] !== null,
    ),
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
): Promise<PipeResult> {
  let result: PipeResult;
  try {
    for await (const event of source) {
      if (fallbackDiagnostics.length > 0 && event.type === 'done') {
        result = 'done';
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
        result = 'error';
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
    return result;
  } finally {
    target.end();
  }
}

async function pipeSseFallback<TOptions extends StreamOptions>(input: {
  options: TOptions | undefined;
  originalStream: StreamForOptions<TOptions>;
  proxy: AssistantMessageEventStream;
  fallbackDiagnostics: ReturnType<typeof extractTransportDiagnostics>;
  fallbackTrace?: TraceContext;
  onLifecycleEvent?: WebSocketLifecycleObserver;
  message?: string;
}): Promise<void> {
  emitLifecycle(input.onLifecycleEvent, {
    type: 'transport_fallback',
    reason: 'websocket_failed_before_stream_start',
    from: 'websocket',
    to: 'sse',
    message: input.message,
  });
  try {
    const result = await pipeStream(
      input.originalStream(sseOptions(input.options, input.fallbackTrace)),
      input.proxy,
      input.fallbackDiagnostics,
      input.fallbackTrace,
    );
    if (result === 'done') {
      emitLifecycle(input.onLifecycleEvent, {
        type: 'transport_fallback_completed',
        from: 'websocket',
        to: 'sse',
      });
      return;
    }
    if (result === 'error') {
      emitLifecycle(input.onLifecycleEvent, {
        type: 'transport_fallback_failed',
        from: 'websocket',
        to: 'sse',
      });
    }
  } catch (error) {
    emitLifecycle(input.onLifecycleEvent, {
      type: 'transport_fallback_failed',
      from: 'websocket',
      to: 'sse',
      message: errorMessage(error),
    });
    throw error;
  }
}

function streamWithAutoSseFallback<TOptions extends StreamOptions>(
  options: TOptions | undefined,
  websocketStream: StreamForOptions<TOptions>,
  originalStream: StreamForOptions<TOptions>,
  onLifecycleEvent?: WebSocketLifecycleObserver,
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
          await pipeSseFallback({
            options,
            originalStream,
            proxy,
            fallbackDiagnostics,
            fallbackTrace,
            onLifecycleEvent,
            message: errorMessage(event.error),
          });
          return;
        }
        started = true;
        proxy.push(event);
      }
    } catch (error) {
      if (!started) {
        const fallbackDiagnostics = extractTransportDiagnostics(error as { diagnostics?: any[] });
        const fallbackTrace = traceFromDiagnostics(fallbackDiagnostics);
        await pipeSseFallback({
          options,
          originalStream,
          proxy,
          fallbackDiagnostics,
          fallbackTrace,
          onLifecycleEvent,
          message: errorMessage(error),
        });
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
  onLifecycleEvent?: WebSocketLifecycleObserver,
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
        onLifecycleEvent,
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
        onLifecycleEvent,
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
  onLifecycleEvent?: WebSocketLifecycleObserver,
): void {
  for (const provider of getApiProviders()) {
    const settings = settingsProvider();
    if (!settings.patch.enabled || !settings.patch.apis.includes(provider.api)) continue;
    registerApiProvider(
      wrapProviderForWebSocketResponses(
        provider as ApiProvider<any>,
        settingsProvider,
        websocketStream,
        onLifecycleEvent,
      ),
    );
  }
}
