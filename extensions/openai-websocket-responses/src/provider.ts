import type {
  Api,
  AssistantMessage,
  AssistantMessageDiagnostic,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  Usage,
} from '@earendil-works/pi-ai/compat';

import {
  buildResponsesBody,
  getResponsesGrammarToolInputProperties,
  type ResponsesBody,
} from './body.ts';
import { shortHash, writeDebugLog } from './debug.ts';
import {
  buildContinuationRequestBody,
  buildSocketCacheKey,
  clearContinuation,
  getContinuation,
  headersFingerprint,
  setContinuation,
} from './continuation-cache.ts';
import { buildRequestHeaders, buildWebSocketHeaders, headersDiagnosticFields } from './headers.ts';
import { resolveRequestProfile } from './profile.ts';
import { recoverResponseByRetrieve } from './retrieve-recovery.ts';
import {
  cloneHeadersWithTraceparent,
  createTraceContext,
  createTraceContextForTraceId,
  type TraceContext,
} from './trace-context.ts';
import { isReplaySafeOpenAIResponsesTransportDiagnosticDetails } from '../../shared/openai-responses-retry';
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
  shouldIncludeSuccessTimeline,
  type TransportDiagnosticsCollector,
} from './transport-diagnostics.ts';
import { resolveWebSocketResponsesUrl } from './urls.ts';
import {
  responseCreatePayloadBytes,
  runWebSocketResponse,
  type WebSocketConnectionMetadata,
  type WebSocketLifecycleObserver,
  WebSocketMidstreamError,
} from './websocket.ts';

export const API = 'openai-websocket-responses';

const DIRECT_CODEX_BACKEND_HOST = 'chatgpt.com';
const DIRECT_CODEX_BACKEND_PATH = '/backend-api/codex/responses';

export interface MissingCodexAccountIdWarningEvent {
  url: string;
  model: Model<Api>;
}

type MissingCodexAccountIdWarningHandler = (event: MissingCodexAccountIdWarningEvent) => void;

function isDirectChatGPTCodexBackendUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.hostname === DIRECT_CODEX_BACKEND_HOST && url.pathname === DIRECT_CODEX_BACKEND_PATH;
  } catch {
    return false;
  }
}

function shouldWarnMissingCodexAccountId(profile: string, url: string, headers: Headers): boolean {
  return (
    profile === 'codex' && !headers.has('chatgpt-account-id') && isDirectChatGPTCodexBackendUrl(url)
  );
}

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

export function summarizeResponsesInputItemIds(body: Pick<ResponsesBody, 'input'>): {
  count: number;
  hash?: string;
} {
  const ids = body.input.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const id = (item as Record<string, unknown>).id;
    return typeof id === 'string' && id.length > 0 ? [id] : [];
  });
  return { count: ids.length, hash: shortHash(ids.join('\u0000')) };
}

function createOutput(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: API,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    // Match the documented/stream-pattern contract: stay pending until a
    // terminal Responses event sets a real stop reason.
    stopReason: 'pending',
    timestamp: Date.now(),
  };
}

class LocalAssistantMessageEventStream implements AsyncIterable<AssistantMessageEvent> {
  private queue: AssistantMessageEvent[] = [];
  private waiting: Array<{
    resolve: (value: IteratorResult<AssistantMessageEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private done = false;
  private failed = false;
  private error: unknown;
  private resultSettled = false;
  private readonly finalResultPromise: Promise<AssistantMessage>;
  private resolveFinalResult!: (message: AssistantMessage) => void;
  private rejectFinalResult!: (error: unknown) => void;

  constructor() {
    this.finalResultPromise = new Promise((resolve, reject) => {
      this.resolveFinalResult = resolve;
      this.rejectFinalResult = reject;
    });
    this.finalResultPromise.catch(() => {});
  }

  push(event: AssistantMessageEvent): void {
    if (this.done) return;
    if (event.type === 'done' || event.type === 'error') {
      this.done = true;
      this.resultSettled = true;
      this.resolveFinalResult(event.type === 'done' ? event.message : event.error);
    }
    this.deliver(event);
  }

  deliver(event: AssistantMessageEvent): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve({ value: event, done: false });
    else this.queue.push(event);
  }

  end(result?: AssistantMessage): void {
    this.done = true;
    if (result !== undefined) {
      this.resultSettled = true;
      this.resolveFinalResult(result);
    } else if (!this.resultSettled) {
      this.resultSettled = true;
      this.rejectFinalResult(new Error('Stream ended without a final result'));
    }
    while (this.waiting.length > 0) {
      this.waiting.shift()!.resolve({ value: undefined as any, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.done) return;
    this.done = true;
    this.failed = true;
    this.error = error;
    this.resultSettled = true;
    this.rejectFinalResult(error);
    while (this.waiting.length > 0) this.waiting.shift()!.reject(error);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.failed) {
        throw this.error;
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve, reject) =>
          this.waiting.push({ resolve, reject }),
        );
        if (result.done) return;
        yield result.value;
      }
    }
  }

  result(): Promise<AssistantMessage> {
    return this.finalResultPromise;
  }
}

function createEventStream(): AssistantMessageEventStream {
  return new LocalAssistantMessageEventStream() as unknown as AssistantMessageEventStream;
}

function formatProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^(?:WebSocket|Retrieve recovery|Response .* was not found)/i.test(message)) {
    return `Connection error: ${message}`;
  }
  return message;
}

function shouldEmitWebSocketRecoveryFailure(
  diagnostics: TransportDiagnosticsCollector | undefined,
): boolean {
  return Boolean(
    diagnostics?.hasEvent('ws_retry') ||
    diagnostics?.hasEvent('previous_response_not_found_fallback') ||
    diagnostics?.hasEvent('empty_response_failed_full_fallback') ||
    diagnostics?.hasEvent('retrieve_recovery_start'),
  );
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
  onMissingCodexAccountId?: MissingCodexAccountIdWarningHandler,
): (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
  return (model, context, options) => {
    const stream = createEventStream();
    void (async () => {
      const output = createOutput(model);
      let cacheKey: string | undefined;
      let websocketUrl: string | undefined;
      let transportDiagnostics: TransportDiagnosticsCollector | undefined;
      try {
        const settings = settingsProvider();
        const logicalTrace = settings.trace.enabled
          ? createTraceContext(optionHeader(options, 'traceparent'))
          : undefined;
        const profile = resolveRequestProfile(model, settings);
        const grammarToolInputProperties = getResponsesGrammarToolInputProperties(model, context);
        const requestHeaders = buildRequestHeaders(model, options, profile);
        const websocketHeaders = buildWebSocketHeaders(model, options, profile);
        const url = resolveWebSocketResponsesUrl(model, settings, websocketHeaders, profile);
        websocketUrl = url;
        if (shouldWarnMissingCodexAccountId(profile, url, websocketHeaders)) {
          try {
            onMissingCodexAccountId?.({ url, model });
          } catch {
            // TUI warnings are best-effort and must not affect model streaming.
          }
        }
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

        let fullBody = buildResponsesBody(model, context, options, profile, settings.request);
        const replacement = await options?.onPayload?.(fullBody, model);
        if (replacement !== undefined) {
          if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)) {
            throw new TypeError('OpenAI Responses onPayload must return an object or undefined');
          }
          fullBody = replacement as ResponsesBody;
        }
        const continuationRequest = buildContinuationRequestBody(
          getContinuation(cacheKey),
          fullBody,
        );
        const body = continuationRequest.body;
        const fullInputItems = fullBody.input?.length ?? 0;
        const sentInputItems = body.input?.length ?? 0;
        const fullInputItemIds = summarizeResponsesInputItemIds(fullBody);
        const sentInputItemIds = summarizeResponsesInputItemIds(body);
        transportDiagnostics = createTransportDiagnostics({
          configuredTransport: options?.transport ?? 'auto',
          previousResponseId:
            typeof body.previous_response_id === 'string' ? body.previous_response_id : undefined,
          url,
          logicalTraceId: logicalTrace?.traceId,
          ...headersDiagnosticFields(websocketHeaders),
        });
        transportDiagnostics.set({
          continuation: continuationRequest.decision,
          sentInputItems,
          sentInputItemIds: sentInputItemIds.count,
          sentInputItemIdsHash: sentInputItemIds.hash,
          ...(continuationRequest.decision === 'delta'
            ? {
                fullInputItems,
                fullInputItemIds: fullInputItemIds.count,
                fullInputItemIdsHash: fullInputItemIds.hash,
                fullBytes: responseCreatePayloadBytes(fullBody),
              }
            : {}),
        });
        writeDebugLog(settings, 'continuation.decision', {
          cacheKeyHash: shortHash(cacheKey),
          decision: continuationRequest.decision,
          fullInputItems: fullBody.input?.length ?? 0,
          sentInputItems: body.input?.length ?? 0,
          fullInputItemIds: fullInputItemIds.count,
          fullInputItemIdsHash: fullInputItemIds.hash,
          sentInputItemIds: sentInputItemIds.count,
          sentInputItemIdsHash: sentInputItemIds.hash,
          hasPreviousResponseId: typeof body.previous_response_id === 'string',
          logicalTraceId: logicalTrace?.traceId,
        });
        if (
          continuationRequest.decision !== 'delta' &&
          continuationRequest.decision !== 'no_continuation'
        ) {
          clearContinuation(cacheKey);
        }

        const processor = createResponsesEventProcessor(
          output,
          stream,
          model,
          grammarToolInputProperties,
        );
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
              if (event.type === 'error') {
                processor.apply(event);
                return;
              }
              await start(connection);
              processor.apply(event);
            },
          );
          if (websocketResult.fallbackUsed) {
            transportOutcome =
              websocketResult.fallbackReason === 'empty_response_failed_without_details'
                ? 'empty_response_failed_full_fallback_succeeded'
                : 'previous_response_not_found_fallback_succeeded';
            transportDiagnostics?.set({
              fallback:
                websocketResult.fallbackReason === 'empty_response_failed_without_details'
                  ? 'empty_response_failed_without_details'
                  : 'previous_response_not_found',
              sentInputItems: fullInputItems,
              sentInputItemIds: fullInputItemIds.count,
              sentInputItemIdsHash: fullInputItemIds.hash,
            });
            if (websocketResult.fallbackReason === 'empty_response_failed_without_details') {
              transportDiagnostics?.record('empty_response_failed_full_fallback', {
                responseId: websocketResult.responseId,
              });
            } else {
              transportDiagnostics?.record('previous_response_not_found_fallback', {
                responseId: websocketResult.responseId,
              });
            }
          } else if (transportDiagnostics?.hasEvent('ws_retry')) {
            transportOutcome = 'websocket_retry_succeeded';
          } else if (transportDiagnostics?.isSignificant()) {
            transportOutcome = 'websocket_succeeded_with_transport_events';
          }
        } catch (error) {
          if (
            !(error instanceof WebSocketMidstreamError) ||
            !settings.recovery.enabled ||
            !error.responseId ||
            isReplaySafeOpenAIResponsesTransportDiagnosticDetails(transportDiagnostics?.getFields())
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
          onLifecycleEvent?.({
            type: 'recovering',
            reason: 'midstream_error',
            action: 'retrieve_response_snapshot',
            urlHash: shortHash(url) ?? '',
            responseId: error.responseId,
            message: error.message,
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
              grammarToolInputProperties,
            });
            transportOutcome = 'retrieve_recovered';
            transportDiagnostics?.record('retrieve_recovery_done', {
              polls: recoveryResult.polls,
              responseId: error.responseId,
              syntheticDeltas: recoveryResult.emittedSyntheticDeltas,
            });
            onLifecycleEvent?.({
              type: 'recovered',
              mode: 'resumed',
              urlHash: shortHash(url) ?? '',
              responseId: error.responseId,
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
            lastResponseItems: assistantMessageToResponseItems(output, grammarToolInputProperties),
          });
        } else {
          clearContinuation(cacheKey);
        }
        if (options?.signal?.aborted) throw new Error('Request was aborted');
        const isSuccessfulWebsocketTurn =
          output.stopReason === 'stop' || output.stopReason === 'toolUse';
        attachTransportDiagnostic(output, transportDiagnostics, {
          finalResponseId: output.responseId,
          finalTransport: 'websocket',
          outcome: transportOutcome ?? 'completed',
          includeTimeline:
            isSuccessfulWebsocketTurn && transportDiagnostics
              ? shouldIncludeSuccessTimeline(settings, transportDiagnostics.getFields())
              : undefined,
          includeTimingFields: isSuccessfulWebsocketTurn
            ? settings.diagnostics.successTimingFields
            : undefined,
        });
        if (output.stopReason === 'pending') {
          throw new Error('OpenAI WebSocket Responses stream ended without a stop reason');
        }
        if (output.stopReason === 'error' || output.stopReason === 'aborted') {
          pushFinalEvent(
            stream,
            { type: 'error', reason: output.stopReason, error: output },
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
        if (shouldEmitWebSocketRecoveryFailure(transportDiagnostics)) {
          onLifecycleEvent?.({
            type: 'failed',
            reason: 'recovery_failed',
            urlHash: shortHash(websocketUrl) ?? '',
            responseId:
              output.responseId ??
              (error instanceof WebSocketMidstreamError ? error.responseId : undefined),
            message: output.errorMessage,
          });
        }
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
