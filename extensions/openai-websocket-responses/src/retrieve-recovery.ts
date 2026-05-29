import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  ToolCall,
} from '@earendil-works/pi-ai';

import {
  appendSyntheticTextDelta,
  applyCompletedResponse,
  ensureTextBlock,
  extractResponseOutputText,
  isFinalizedTextBlock,
  responseMessageTextSignature,
} from './responses-adapter.ts';
import type { OpenAIWebSocketResponsesSettings } from './settings.ts';
import { resolveRetrieveResponseUrl } from './urls.ts';

export interface RetrieveRecoveryResult {
  response: Record<string, any>;
  recoveredText: string;
  emittedSyntheticDeltas: number;
}

type PartialToolCall = ToolCall & { partialJson?: string };

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(new Error('Request was aborted'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isTerminalStatus(status: string | undefined): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'incomplete'
  );
}

function responseErrorMessage(response: Record<string, any>): string {
  return response.error?.message || response.incomplete_details?.reason || JSON.stringify(response);
}

function parseArguments(value: unknown): Record<string, any> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function reasoningIdFromSignature(signature: string | undefined): string | undefined {
  if (!signature) return undefined;
  try {
    const parsed = JSON.parse(signature) as { id?: unknown };
    return typeof parsed.id === 'string' ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

function reasoningText(item: Record<string, any>): string {
  return (Array.isArray(item.summary) ? item.summary : [])
    .map((part) => part?.text)
    .filter((text): text is string => typeof text === 'string')
    .join('\n\n');
}

function emitRecoveredReasoningItems(
  response: Record<string, any>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): void {
  const items = Array.isArray(response.output) ? response.output : [];
  const existingReasoningIds = new Set(
    output.content
      .filter((block) => block.type === 'thinking')
      .map((block) => reasoningIdFromSignature(block.thinkingSignature))
      .filter((id): id is string => typeof id === 'string'),
  );

  for (const item of items) {
    if (item?.type !== 'reasoning' || typeof item.id !== 'string') continue;
    if (existingReasoningIds.has(item.id)) continue;
    const block = {
      type: 'thinking' as const,
      thinking: reasoningText(item),
      thinkingSignature: JSON.stringify(item),
    };
    const firstTextIndex = output.content.findIndex((content) => content.type === 'text');
    const contentIndex = firstTextIndex >= 0 ? firstTextIndex : output.content.length;
    output.content.splice(contentIndex, 0, block as AssistantMessage['content'][number]);
    stream.push({ type: 'thinking_start', contentIndex, partial: output });
    stream.push({ type: 'thinking_end', contentIndex, content: block.thinking, partial: output });
    existingReasoningIds.add(item.id);
  }
}

function emitRecoveredToolCalls(
  response: Record<string, any>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): void {
  const items = Array.isArray(response.output) ? response.output : [];
  const existing = new Map<string, { block: PartialToolCall; index: number }>();
  output.content.forEach((block, index) => {
    if (block.type === 'toolCall')
      existing.set(block.id, { block: block as PartialToolCall, index });
  });
  for (const item of items) {
    if (item?.type !== 'function_call') continue;
    const callId = typeof item.call_id === 'string' ? item.call_id : undefined;
    const itemId = typeof item.id === 'string' ? item.id : undefined;
    const name = typeof item.name === 'string' ? item.name : undefined;
    if (!callId || !itemId || !name) continue;
    const id = `${callId}|${itemId}`;
    const argumentsJson = typeof item.arguments === 'string' ? item.arguments : '';
    const existingEntry = existing.get(id);
    if (existingEntry) {
      const toolCall = existingEntry.block;
      if (toolCall.partialJson === undefined) continue;
      const partialJson = toolCall.partialJson;
      if (argumentsJson.startsWith(partialJson)) {
        const delta = argumentsJson.slice(partialJson.length);
        if (delta)
          stream.push({
            type: 'toolcall_delta',
            contentIndex: existingEntry.index,
            delta,
            partial: output,
          });
      }
      toolCall.arguments = parseArguments(argumentsJson);
      delete toolCall.partialJson;
      stream.push({
        type: 'toolcall_end',
        contentIndex: existingEntry.index,
        toolCall,
        partial: output,
      });
      continue;
    }
    const toolCall = {
      type: 'toolCall' as const,
      id,
      name,
      arguments: parseArguments(item.arguments),
    };
    const contentIndex = output.content.length;
    output.content.push(toolCall);
    stream.push({ type: 'toolcall_start', contentIndex, partial: output });
    const fullArgumentsJson = argumentsJson || JSON.stringify(toolCall.arguments);
    if (fullArgumentsJson)
      stream.push({
        type: 'toolcall_delta',
        contentIndex,
        delta: fullArgumentsJson,
        partial: output,
      });
    stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: output });
    existing.set(id, { block: toolCall, index: contentIndex });
  }
}

export async function recoverResponseByRetrieve(request: {
  model: Model<Api>;
  settings: OpenAIWebSocketResponsesSettings;
  responseId: string;
  headers: Headers;
  emittedText: string;
  output: AssistantMessage;
  stream: AssistantMessageEventStream;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<RetrieveRecoveryResult> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const startedAt = Date.now();
  const deadline = startedAt + request.settings.recovery.timeoutMs;
  let emittedText = request.emittedText;
  let emittedSyntheticDeltas = 0;
  let lastError: string | undefined;
  const url = resolveRetrieveResponseUrl(
    request.model,
    request.settings,
    request.responseId,
    request.headers,
  );

  while (Date.now() <= deadline) {
    if (request.signal?.aborted) throw new Error('Request was aborted');
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: request.headers,
      signal: request.signal,
    });
    if (response.status === 404) {
      lastError = `Response ${request.responseId} was not found`;
      if (Date.now() - startedAt > request.settings.recovery.notFoundGraceMs)
        throw new Error(lastError);
      await sleep(request.settings.recovery.pollIntervalMs, request.signal);
      continue;
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Retrieve recovery failed with HTTP ${response.status}: ${body.slice(0, 1000)}`,
      );
    }

    const snapshot = (await response.json()) as Record<string, any>;
    const snapshotText = extractResponseOutputText(snapshot);
    if (snapshotText && !snapshotText.startsWith(emittedText)) {
      throw new Error('Retrieve recovery diverged from already emitted text');
    }

    const status = typeof snapshot.status === 'string' ? snapshot.status : undefined;
    if (status === 'completed') {
      emitRecoveredReasoningItems(snapshot, request.output, request.stream);
      if (snapshotText && request.settings.recovery.emitSyntheticDeltas) {
        const delta = snapshotText.slice(emittedText.length);
        if (delta) {
          appendSyntheticTextDelta(request.output, request.stream, delta);
          emittedText = snapshotText;
          emittedSyntheticDeltas++;
        }
      }
      emitRecoveredToolCalls(snapshot, request.output, request.stream);
      if (snapshotText || request.output.content.some((block) => block.type === 'text')) {
        const { index, block } = ensureTextBlock(request.output, request.stream);
        const alreadyFinalized = isFinalizedTextBlock(block);
        if (snapshotText && block.text !== snapshotText) block.text = snapshotText;
        block.textSignature ??= responseMessageTextSignature(snapshot);
        if (!alreadyFinalized) {
          request.stream.push({
            type: 'text_end',
            contentIndex: index,
            content: block.text,
            partial: request.output,
          });
        }
      }
      applyCompletedResponse(request.output, request.model, {
        ...snapshot,
        id: snapshot.id ?? request.responseId,
      });
      return { response: snapshot, recoveredText: snapshotText, emittedSyntheticDeltas };
    }
    if (snapshotText && request.settings.recovery.emitSyntheticDeltas) {
      const delta = snapshotText.slice(emittedText.length);
      if (delta) {
        appendSyntheticTextDelta(request.output, request.stream, delta);
        emittedText = snapshotText;
        emittedSyntheticDeltas++;
      }
    }
    if (isTerminalStatus(status)) throw new Error(responseErrorMessage(snapshot));

    await sleep(request.settings.recovery.pollIntervalMs, request.signal);
  }

  throw new Error(
    lastError ?? `Retrieve recovery timed out after ${request.settings.recovery.timeoutMs}ms`,
  );
}
