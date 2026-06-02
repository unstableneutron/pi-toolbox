import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageDiagnostic,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Usage,
} from '@earendil-works/pi-ai';

import { buildResponsesBody } from './body.ts';
import { shortHash, writeDebugLog } from './debug.ts';
import {
  buildContinuationRequestBody,
  buildSocketCacheKey,
  clearContinuation,
  getContinuation,
  headersFingerprint,
  setContinuation,
} from './continuation-cache.ts';
import { buildRequestHeaders, buildWebSocketHeaders } from './headers.ts';
import { resolveRequestProfile } from './profile.ts';
import { recoverResponseByRetrieve } from './retrieve-recovery.ts';
import {
  cloneHeadersWithTraceparent,
  createTraceContext,
  createTraceContextForTraceId,
  type TraceContext,
} from './trace-context.ts';
import {
  assistantMessageToResponseItems,
  createResponsesEventProcessor,
  getOutputText,
} from './responses-adapter.ts';
import type { OpenAIWebSocketResponsesSettings } from './settings.ts';
import {
  attachTransportDiagnostic,
  createTransportDiagnostics,
  extractTransportDiagnostics,
  type TransportDiagnosticsCollector,
} from './transport-diagnostics.ts';
import { resolveWebSocketResponsesUrl } from './urls.ts';
import {
  runWebSocketResponse,
  type WebSocketConnectionMetadata,
  type WebSocketLifecycleObserver,
  WebSocketMidstreamError,
} from './websocket.ts';

export const API = 'openai-websocket-responses';

export function buildWebSocketResponseHeaders(
  connection: WebSocketConnectionMetadata,
  requestUrl: string,
): Record<string, string> {
  return {
    connection: 'Upgrade',
    upgrade: 'websocket',
    'x-pi-connection-id': connection.connectionId,
    'x-pi-connection-cache-status': connection.cacheStatus,
    'x-pi-request-url': requestUrl,
  };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createOutput(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: API,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function formatProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^(?:WebSocket|Retrieve recovery|Response .* was not found)/i.test(message)) {
    return `Connection error: ${message}`;
  }
  return message;
}

type PersistUnattachedDiagnostic = (diagnostic: AssistantMessageDiagnostic) => void;

function optionHeader(options: SimpleStreamOptions | undefined, name: string): string | undefined {
  const headers = options?.headers ?? {};
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return typeof match?.[1] === 'string' ? match[1] : undefined;
}

function traceFields(trace: TraceContext | undefined): Record<string, string> {
  return trace
    ? { traceparent: trace.traceparent, traceId: trace.traceId, spanId: trace.spanId }
    : {};
}

function persistMessageTransportDiagnostics(
  persist: PersistUnattachedDiagnostic | undefined,
  message: AssistantMessage,
): void {
  if (!persist) return;
  for (const diagnostic of extractTransportDiagnostics(message)) {
    try {
      persist(diagnostic);
    } catch {
      // Session-log fallback diagnostics are best-effort and must not affect model streaming.
    }
  }
}

function pushFinalEvent(
  stream: AssistantMessageEventStream,
  event:
    | { type: 'done'; reason: 'stop' | 'length' | 'toolUse'; message: AssistantMessage }
    | { type: 'error'; reason: 'error' | 'aborted'; error: AssistantMessage },
  message: AssistantMessage,
  persist: PersistUnattachedDiagnostic | undefined,
): void {
  try {
    stream.push(event);
  } catch {
    persistMessageTransportDiagnostics(persist, message);
  } finally {
    stream.end();
  }
}

export function createOpenAIWebSocketResponsesStream(
  settingsProvider: () => OpenAIWebSocketResponsesSettings,
  onLifecycleEvent?: WebSocketLifecycleObserver,
  shouldEnableIdleKeepalive?: () => boolean,
  persistUnattachedDiagnostic?: PersistUnattachedDiagnostic,
): (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const output = createOutput(model);
      let cacheKey: string | undefined;
      let transportDiagnostics: TransportDiagnosticsCollector | undefined;
      try {
        const settings = settingsProvider();
        const logicalTrace = settings.trace.enabled
          ? createTraceContext(optionHeader(options, 'traceparent'))
          : undefined;
        const profile = resolveRequestProfile(model, settings);
        const requestHeaders = buildRequestHeaders(model, options, profile);
        const websocketHeaders = buildWebSocketHeaders(model, options, profile);
        const url = resolveWebSocketResponsesUrl(model, settings, websocketHeaders, profile);
        if (!websocketHeaders.has('authorization'))
          throw new Error(`Missing Authorization header for ${url}`);

        if (options?.sessionId) {
          cacheKey = buildSocketCacheKey({
            sessionId: options.sessionId,
            url,
            provider: model.provider,
            modelId: model.id,
            headersFingerprint: headersFingerprint(websocketHeaders),
          });
        }

        const fullBody = buildResponsesBody(model, context, options, profile);
        const continuationRequest = buildContinuationRequestBody(
          getContinuation(cacheKey),
          fullBody,
        );
        const body = continuationRequest.body;
        transportDiagnostics = createTransportDiagnostics({
          configuredTransport: options?.transport ?? 'auto',
          previousResponseId:
            typeof body.previous_response_id === 'string' ? body.previous_response_id : undefined,
          url,
          logicalTraceId: logicalTrace?.traceId,
        });
        writeDebugLog(settings, 'continuation.decision', {
          cacheKeyHash: shortHash(cacheKey),
          decision: continuationRequest.decision,
          fullInputItems: fullBody.input?.length ?? 0,
          sentInputItems: body.input?.length ?? 0,
          hasPreviousResponseId: typeof body.previous_response_id === 'string',
          logicalTraceId: logicalTrace?.traceId,
        });
        if (
          continuationRequest.decision !== 'delta' &&
          continuationRequest.decision !== 'no_continuation'
        ) {
          clearContinuation(cacheKey);
        }

        const processor = createResponsesEventProcessor(output, stream, model);
        let started = false;
        let transportOutcome: string | undefined;
        const start = async (connection: WebSocketConnectionMetadata) => {
          if (started) return;
          started = true;
          await options?.onResponse?.(
            {
              status: 101,
              headers: buildWebSocketResponseHeaders(connection, url),
            },
            model,
          );
          stream.push({ type: 'start', partial: output });
        };

        try {
          const websocketResult = await runWebSocketResponse(
            {
              url,
              headers: websocketHeaders,
              body,
              fallbackBodyOnPreviousResponseNotFound:
                settings.recovery.enabled && continuationRequest.decision === 'delta'
                  ? fullBody
                  : undefined,
              settings,
              signal: options?.signal,
              cacheKey,
              onLifecycleEvent,
              enableIdleKeepalive: shouldEnableIdleKeepalive?.() ?? false,
              diagnostics: transportDiagnostics,
              trace: logicalTrace
                ? {
                    logicalTraceId: logicalTrace.traceId,
                    nextSpan: () => createTraceContextForTraceId(logicalTrace.traceId),
                  }
                : undefined,
            },
            async (event, connection) => {
              await start(connection);
              processor.apply(event);
            },
          );
          if (websocketResult.fallbackUsed) {
            transportOutcome = 'previous_response_not_found_fallback_succeeded';
            transportDiagnostics?.record('previous_response_not_found_fallback', {
              responseId: websocketResult.responseId,
            });
          } else if (transportDiagnostics?.hasEvent('ws_retry')) {
            transportOutcome = 'websocket_retry_succeeded';
          } else if (transportDiagnostics?.isSignificant()) {
            transportOutcome = 'websocket_succeeded_with_transport_events';
          }
        } catch (error) {
          if (
            !(error instanceof WebSocketMidstreamError) ||
            !settings.recovery.enabled ||
            !error.responseId
          ) {
            throw error;
          }
          const retrieveTrace = logicalTrace
            ? createTraceContextForTraceId(logicalTrace.traceId)
            : undefined;
          transportDiagnostics?.record('retrieve_recovery_start', {
            responseId: error.responseId,
            emittedTextBytes: new TextEncoder().encode(getOutputText(output)).byteLength,
            ...traceFields(retrieveTrace),
          });
          try {
            const recoveryResult = await recoverResponseByRetrieve({
              model,
              settings,
              responseId: error.responseId,
              headers: cloneHeadersWithTraceparent(requestHeaders, retrieveTrace),
              emittedText: getOutputText(output),
              output,
              stream,
              signal: options?.signal,
              profile,
            });
            transportOutcome = 'retrieve_recovered';
            transportDiagnostics?.record('retrieve_recovery_done', {
              polls: recoveryResult.polls,
              responseId: error.responseId,
              syntheticDeltas: recoveryResult.emittedSyntheticDeltas,
            });
          } catch (recoveryError) {
            transportDiagnostics?.record('retrieve_recovery_error', {
              message:
                recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
              responseId: error.responseId,
            });
            throw recoveryError;
          }
        }

        const canContinue = output.stopReason === 'stop' || output.stopReason === 'toolUse';
        if (canContinue && output.responseId) {
          setContinuation(cacheKey, {
            lastRequestBody: fullBody,
            lastResponseId: output.responseId,
            lastResponseItems: assistantMessageToResponseItems(output),
          });
        } else {
          clearContinuation(cacheKey);
        }
        if (options?.signal?.aborted) throw new Error('Request was aborted');
        attachTransportDiagnostic(output, transportDiagnostics, {
          finalResponseId: output.responseId,
          finalTransport: 'websocket',
          outcome: transportOutcome ?? 'completed',
        });
        if (output.stopReason === 'error') {
          pushFinalEvent(
            stream,
            { type: 'error', reason: 'error', error: output },
            output,
            persistUnattachedDiagnostic,
          );
          return;
        }
        pushFinalEvent(
          stream,
          {
            type: 'done',
            reason: output.stopReason as 'stop' | 'length' | 'toolUse',
            message: output,
          },
          output,
          persistUnattachedDiagnostic,
        );
      } catch (error) {
        clearContinuation(cacheKey);
        output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
        output.errorMessage = formatProviderError(error);
        attachTransportDiagnostic(output, transportDiagnostics, {
          error,
          finalResponseId:
            output.responseId ??
            (error instanceof WebSocketMidstreamError ? error.responseId : undefined),
          finalTransport: 'websocket',
          outcome: 'transport_error',
        });
        pushFinalEvent(
          stream,
          { type: 'error', reason: output.stopReason, error: output },
          output,
          persistUnattachedDiagnostic,
        );
      }
    })();
    return stream;
  };
}
