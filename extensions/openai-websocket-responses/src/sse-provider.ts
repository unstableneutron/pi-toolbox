import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Usage,
} from '@earendil-works/pi-ai/compat';

import { buildResponsesBody } from './body.ts';
import { buildRequestHeaders } from './headers.ts';
import { resolveRequestProfile } from './profile.ts';
import { createResponsesEventProcessor } from './responses-adapter.ts';
import type { OpenAIWebSocketResponsesSettings } from './settings.ts';
import { parseSseJson } from './sse.ts';
import { resolveSseResponsesUrl } from './urls.ts';

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
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function requestSignal(options: SimpleStreamOptions | undefined): AbortSignal | undefined {
  if (!options?.timeoutMs || options.timeoutMs <= 0) return options?.signal;
  const timeout = AbortSignal.timeout(options.timeoutMs);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

function isTerminalEvent(type: unknown): boolean {
  return (
    type === 'response.completed' ||
    type === 'response.done' ||
    type === 'response.incomplete' ||
    type === 'response.failed' ||
    type === 'response.cancelled'
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createOpenAISseResponsesStream(
  settingsProvider: () => OpenAIWebSocketResponsesSettings,
  fetchProvider: () => typeof fetch = () => fetch,
): (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const output = createOutput(model);
      try {
        const settings = settingsProvider();
        const profile = resolveRequestProfile(model, settings);
        const headers = buildRequestHeaders(model, options, profile);
        headers.set('accept', 'text/event-stream');
        headers.set('content-type', 'application/json');
        const url = resolveSseResponsesUrl(model, settings, headers, profile);
        let payload: unknown = {
          ...buildResponsesBody(model, context, options, profile, settings.request),
          stream: true,
          store: false,
        };
        const replacement = await options?.onPayload?.(payload, model);
        if (replacement !== undefined) payload = replacement;

        const response = await fetchProvider()(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: requestSignal(options),
        });
        await options?.onResponse?.(
          { status: response.status, headers: Object.fromEntries(response.headers.entries()) },
          model,
        );
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`OpenAI Responses SSE HTTP ${response.status}: ${body.slice(0, 1000)}`);
        }

        stream.push({ type: 'start', partial: output });
        const processor = createResponsesEventProcessor(output, stream, model);
        let terminal = false;
        for await (const event of parseSseJson(response)) {
          if (isTerminalEvent(event.type)) terminal = true;
          processor.apply(event);
        }
        if (!terminal) throw new Error('OpenAI Responses SSE ended before a terminal event');
        if (options?.signal?.aborted) throw new Error('Request was aborted');
        if (output.stopReason === 'error') throw new Error('OpenAI Responses request failed');

        stream.push({
          type: 'done',
          reason: output.stopReason as 'stop' | 'length' | 'toolUse',
          message: output,
        });
        stream.end();
      } catch (error) {
        for (const block of output.content as Array<Record<string, any>>) {
          delete block.partialJson;
        }
        output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
        output.errorMessage = errorMessage(error);
        stream.push({ type: 'error', reason: output.stopReason, error: output });
        stream.end();
      }
    })();
    return stream;
  };
}
