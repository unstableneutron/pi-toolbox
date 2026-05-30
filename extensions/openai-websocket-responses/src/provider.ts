import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
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
  assistantMessageToResponseItems,
  createResponsesEventProcessor,
  getOutputText,
} from './responses-adapter.ts';
import type { OpenAIWebSocketResponsesSettings } from './settings.ts';
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

export function createOpenAIWebSocketResponsesStream(
  settingsProvider: () => OpenAIWebSocketResponsesSettings,
  onLifecycleEvent?: WebSocketLifecycleObserver,
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
      try {
        const settings = settingsProvider();
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
        writeDebugLog(settings, 'continuation.decision', {
          cacheKeyHash: shortHash(cacheKey),
          decision: continuationRequest.decision,
          fullInputItems: fullBody.input?.length ?? 0,
          sentInputItems: body.input?.length ?? 0,
          hasPreviousResponseId: typeof body.previous_response_id === 'string',
        });
        if (
          continuationRequest.decision !== 'delta' &&
          continuationRequest.decision !== 'no_continuation'
        ) {
          clearContinuation(cacheKey);
        }

        const processor = createResponsesEventProcessor(output, stream, model);
        let started = false;
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
          await runWebSocketResponse(
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
            },
            async (event, connection) => {
              await start(connection);
              processor.apply(event);
            },
          );
        } catch (error) {
          if (
            !(error instanceof WebSocketMidstreamError) ||
            !settings.recovery.enabled ||
            !error.responseId
          ) {
            throw error;
          }
          await recoverResponseByRetrieve({
            model,
            settings,
            responseId: error.responseId,
            headers: requestHeaders,
            emittedText: getOutputText(output),
            output,
            stream,
            signal: options?.signal,
            profile,
          });
        }

        if (output.responseId) {
          setContinuation(cacheKey, {
            lastRequestBody: fullBody,
            lastResponseId: output.responseId,
            lastResponseItems: assistantMessageToResponseItems(output),
          });
        }
        if (options?.signal?.aborted) throw new Error('Request was aborted');
        stream.push({
          type: 'done',
          reason: output.stopReason as 'stop' | 'length' | 'toolUse',
          message: output,
        });
        stream.end();
      } catch (error) {
        clearContinuation(cacheKey);
        output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
        output.errorMessage = formatProviderError(error);
        stream.push({ type: 'error', reason: output.stopReason, error: output });
        stream.end();
      }
    })();
    return stream;
  };
}
