/**
 * Vendored/adapted Responses conversion and stream handling.
 *
 * Source: @howaboua/pi-codex-conversion
 * File: packages/pi-codex-conversion/src/providers/openai-responses-shared.ts
 * Upstream snapshot: c916aa4960ee85074e333574592b8d30a37eda62
 * License: MIT
 *
 * Local adaptation notes:
 * - Keep Azure/LFM-compatible request semantics from this extension.
 * - Do not force default `instructions`, Codex headers, native web/image tools,
 *   or ChatGPT-specific service-tier behavior.
 * - Preserve the upstream per-output-index stream state machine, opaque reasoning
 *   item replay, text item signatures, partial JSON parsing, failed-message filtering,
 *   and synthetic missing tool results.
 */

import {
  calculateCost,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Model,
  type TextContent,
  type Tool,
  type ToolCall,
} from '@earendil-works/pi-ai';
import { parse as partialParse } from 'partial-json';

type ResponsesEvent = Record<string, any>;
type ResponsesInputItem = Record<string, any>;
type Message = Context['messages'][number];
type BuildResponsesInputOptions = { includeSystemPrompt?: boolean };
type ThinkingBlock = Record<string, any> & {
  type: 'thinking';
  thinking: string;
  thinkingSignature?: string;
};
type ToolCallBlock = ToolCall & { partialJson?: string };
type HiddenResponseItemBlock = { type: 'response_item'; item: ResponsesInputItem };
type InternalAssistantContent = AssistantMessage['content'][number] | HiddenResponseItemBlock;

type ReasoningState = {
  kind: 'reasoning';
  blockIndex: number;
  block: ThinkingBlock;
  summaryParts: Map<number, { text: string }>;
};
type MessageState = {
  kind: 'message';
  blockIndex: number;
  block: TextContent;
  parts: Map<number, { type: 'output_text' | 'refusal'; text: string }>;
};
type FunctionCallState = { kind: 'function_call'; blockIndex: number; block: ToolCallBlock };
type OutputState = ReasoningState | MessageState | FunctionCallState;

function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  );
}

function parsedObject(value: unknown): Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function parseResponsesJsonObject(value: string | undefined): Record<string, any> {
  if (!value?.trim()) return {};
  try {
    return parsedObject(JSON.parse(value) as unknown);
  } catch {
    try {
      return parsedObject(partialParse(value) as unknown);
    } catch {
      return {};
    }
  }
}

export function buildResponsesInstructions(
  context: Pick<Context, 'systemPrompt'>,
): string | undefined {
  return context.systemPrompt?.trim() ? sanitizeSurrogates(context.systemPrompt) : undefined;
}

function textFromContent(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((item): item is TextContent => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function encodeTextSignatureV1(id: string, phase?: string): string {
  return JSON.stringify({ v: 1, id, ...(phase ? { phase } : {}) });
}

function parseTextSignature(
  signature: string | undefined,
): { id: string; phase?: string } | undefined {
  if (!signature) return undefined;
  if (signature.startsWith('{')) {
    try {
      const parsed = JSON.parse(signature) as { v?: number; id?: unknown; phase?: unknown };
      if (parsed.v === 1 && typeof parsed.id === 'string') {
        return typeof parsed.phase === 'string'
          ? { id: parsed.id, phase: parsed.phase }
          : { id: parsed.id };
      }
    } catch {
      // Fall through to legacy plain-id signatures.
    }
  }
  return { id: signature };
}

function textSignatureItemId(signature: string | undefined): string | undefined {
  return parseTextSignature(signature)?.id;
}

function textSignaturePhase(signature: string | undefined): string | undefined {
  return parseTextSignature(signature)?.phase;
}

function isHiddenResponseItemBlock(
  block: InternalAssistantContent,
): block is HiddenResponseItemBlock {
  return block.type === 'response_item' && !!block.item;
}

function sanitizeHiddenResponseItem(item: Record<string, any>): ResponsesInputItem | undefined {
  if (item.type !== 'web_search_call') return undefined;
  if (typeof item.id !== 'string' || !item.id) return undefined;
  return JSON.parse(JSON.stringify(item)) as ResponsesInputItem;
}

export function responseMessageTextSignature(response: Record<string, any>): string | undefined {
  const item = (Array.isArray(response.output) ? response.output : []).find(
    (candidate) => candidate?.type === 'message' && typeof candidate.id === 'string',
  );
  return item ? encodeTextSignatureV1(item.id, item.phase) : undefined;
}

export function isFinalizedTextBlock(block: TextContent): boolean {
  return !!textSignatureItemId(block.textSignature);
}

function splitToolCallId(id: string): { callId: string; itemId?: string } {
  const [callId, itemId] = id.split('|');
  return { callId: callId || id, itemId };
}

function functionCallInput(block: ToolCall): ResponsesInputItem {
  const { callId, itemId } = splitToolCallId(block.id);
  return {
    type: 'function_call',
    id: itemId,
    call_id: callId,
    name: block.name,
    arguments: JSON.stringify(block.arguments),
  };
}

function toolResultInput(message: Extract<Message, { role: 'toolResult' }>): ResponsesInputItem {
  const outputText = textFromContent(message.content);
  const { callId } = splitToolCallId(message.toolCallId);
  return {
    type: 'function_call_output',
    call_id: callId,
    output: sanitizeSurrogates(outputText),
  };
}

function syntheticToolResultInput(block: ToolCall): ResponsesInputItem {
  const { callId } = splitToolCallId(block.id);
  return { type: 'function_call_output', call_id: callId, output: 'No result provided' };
}

function userInput(message: Extract<Message, { role: 'user' }>): ResponsesInputItem | undefined {
  if (typeof message.content === 'string') {
    const text = sanitizeSurrogates(message.content);
    return text.trim() ? { role: 'user', content: [{ type: 'input_text', text }] } : undefined;
  }
  const content = message.content.map((item) =>
    item.type === 'text'
      ? { type: 'input_text', text: sanitizeSurrogates(item.text) }
      : {
          type: 'input_image',
          detail: 'auto',
          image_url: `data:${item.mimeType};base64,${item.data}`,
        },
  );
  return content.length > 0 ? { role: 'user', content } : undefined;
}

function assistantMessageItems(
  message: Extract<Message, { role: 'assistant' }>,
  index: number,
): ResponsesInputItem[] {
  const output: ResponsesInputItem[] = [];
  let textBlockIndex = 0;
  for (const block of message.content as InternalAssistantContent[]) {
    if (isHiddenResponseItemBlock(block)) {
      output.push(block.item);
      continue;
    }
    if (block.type === 'thinking' && block.thinkingSignature) {
      try {
        output.push(JSON.parse(block.thinkingSignature) as ResponsesInputItem);
      } catch {
        // Ignore malformed opaque signatures.
      }
      continue;
    }
    if (block.type === 'text') {
      const fallbackId = `msg_pi_${index}_${textBlockIndex}`;
      const signature = parseTextSignature(block.textSignature);
      textBlockIndex++;
      output.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: sanitizeSurrogates(block.text), annotations: [] }],
        status: 'completed',
        id: signature?.id ?? fallbackId,
        ...(signature?.phase ? { phase: signature.phase } : {}),
      });
      continue;
    }
    if (message.stopReason === 'toolUse' && block.type === 'toolCall') {
      output.push(functionCallInput(block));
    }
  }
  return output;
}

export function buildResponsesInput<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options: BuildResponsesInputOptions = {},
): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];

  const instructions = buildResponsesInstructions(context);
  if (instructions && options.includeSystemPrompt !== false) {
    input.push({
      role: model.reasoning ? 'developer' : 'system',
      content: instructions,
    });
  }

  let assistantIndex = 0;
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();

  const insertSyntheticToolResults = () => {
    if (pendingToolCalls.length === 0) return;
    for (const toolCall of pendingToolCalls) {
      if (!existingToolResultIds.has(toolCall.id)) input.push(syntheticToolResultInput(toolCall));
    }
    pendingToolCalls = [];
    existingToolResultIds = new Set();
  };

  for (const message of context.messages) {
    if (message.role === 'user') {
      insertSyntheticToolResults();
      const item = userInput(message);
      if (item) input.push(item);
      continue;
    }

    if (message.role === 'assistant') {
      insertSyntheticToolResults();
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        assistantIndex++;
        continue;
      }
      input.push(...assistantMessageItems(message, assistantIndex));
      pendingToolCalls =
        message.stopReason === 'toolUse'
          ? message.content.filter((block): block is ToolCall => block.type === 'toolCall')
          : [];
      existingToolResultIds = new Set();
      assistantIndex++;
      continue;
    }

    if (message.role === 'toolResult') {
      if (pendingToolCalls.some((toolCall) => toolCall.id === message.toolCallId)) {
        existingToolResultIds.add(message.toolCallId);
        input.push(toolResultInput(message));
      }
    }
  }

  insertSyntheticToolResults();
  return input;
}

export function buildResponsesTools(tools: Tool[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  }));
}

function mapStopReason(status: string | undefined): AssistantMessage['stopReason'] {
  if (status === 'incomplete') return 'length';
  if (status === 'failed' || status === 'cancelled') return 'error';
  return 'stop';
}

function terminalResponseMessage(response: Record<string, any>): string | undefined {
  const message = response.error?.message || response.incomplete_details?.reason;
  if (typeof message === 'string' && message.length > 0) return message;
  return undefined;
}

function hasTerminalResponseDetails(response: Record<string, any>): boolean {
  return (
    response.error != null ||
    response.incomplete_details != null ||
    response.content_filters != null ||
    response.moderation != null
  );
}

function terminalResponseOutputItems(response: Record<string, any>): number | undefined {
  return Array.isArray(response.output) ? response.output.length : undefined;
}

function formatTerminalResponseError(type: string, response: Record<string, any>): string {
  const message = terminalResponseMessage(response);
  if (message) return message;

  const status = typeof response.status === 'string' ? response.status : 'unknown';
  const details = [
    typeof response.id === 'string' ? `response_id=${response.id}` : undefined,
    typeof response.model === 'string' ? `model=${response.model}` : undefined,
    typeof response.previous_response_id === 'string'
      ? `previous_response_id=${response.previous_response_id}`
      : undefined,
  ].filter((detail): detail is string => typeof detail === 'string');
  const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
  return `Responses API returned ${type} with status=${status} without error details${suffix}`;
}

export class TerminalResponseError extends Error {
  readonly eventType: string;
  readonly status: string;
  readonly responseId?: string;
  readonly model?: string;
  readonly previousResponseId?: string;
  readonly hasDetails: boolean;
  readonly outputItems?: number;

  constructor(type: string, response: Record<string, any>) {
    super(formatTerminalResponseError(type, response));
    this.name = 'TerminalResponseError';
    this.eventType = type;
    this.status = typeof response.status === 'string' ? response.status : 'unknown';
    this.responseId = typeof response.id === 'string' ? response.id : undefined;
    this.model = typeof response.model === 'string' ? response.model : undefined;
    this.previousResponseId =
      typeof response.previous_response_id === 'string' ? response.previous_response_id : undefined;
    this.hasDetails = hasTerminalResponseDetails(response);
    this.outputItems = terminalResponseOutputItems(response);
  }
}

export function isRetryableEmptyResponseFailure(error: unknown): error is TerminalResponseError {
  return (
    error instanceof TerminalResponseError &&
    error.eventType === 'response.failed' &&
    error.status === 'failed' &&
    !error.hasDetails &&
    (error.outputItems === undefined || error.outputItems === 0)
  );
}

function stripToolCalls(output: AssistantMessage): void {
  output.content = output.content.filter((block) => block.type !== 'toolCall');
}

function blockIndex(output: AssistantMessage): number {
  return output.content.length - 1;
}

export function getOutputText(output: AssistantMessage): string {
  return output.content
    .filter((item): item is TextContent => item.type === 'text')
    .map((item) => item.text)
    .join('');
}

export function ensureTextBlock(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): { index: number; block: TextContent } {
  const existing = output.content.findIndex((item) => item.type === 'text');
  if (existing >= 0) return { index: existing, block: output.content[existing] as TextContent };
  const block: TextContent = { type: 'text', text: '' };
  output.content.push(block);
  const index = output.content.length - 1;
  stream.push({ type: 'text_start', contentIndex: index, partial: output });
  return { index, block };
}

export function appendSyntheticTextDelta(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  delta: string,
): void {
  if (!delta) return;
  const { index, block } = ensureTextBlock(output, stream);
  block.text += delta;
  stream.push({ type: 'text_delta', contentIndex: index, delta, partial: output });
}

function applyResponseUsage<TApi extends Api>(
  output: AssistantMessage,
  model: Model<TApi>,
  usage: Record<string, any> | undefined,
): void {
  if (!usage) return;
  const cachedTokens = usage.input_tokens_details?.cached_tokens ?? 0;
  output.usage.input = (usage.input_tokens ?? 0) - cachedTokens;
  output.usage.output = usage.output_tokens ?? 0;
  output.usage.cacheRead = cachedTokens;
  output.usage.totalTokens = usage.total_tokens ?? 0;
  output.usage.cost = calculateCost(model, output.usage);
}

export function applyCompletedResponse<TApi extends Api>(
  output: AssistantMessage,
  model: Model<TApi>,
  response: Record<string, any>,
): void {
  output.responseId = response.id ?? output.responseId;
  applyResponseUsage(output, model, response.usage);
  output.stopReason = mapStopReason(response.status);
  if (output.stopReason === 'length') {
    stripToolCalls(output);
    return;
  }
  if (output.content.some((block) => block.type === 'toolCall') && output.stopReason === 'stop') {
    output.stopReason = 'toolUse';
  }
}

function outputIndexForAdded(event: ResponsesEvent, implicitIndex: () => number): number {
  return typeof event.output_index === 'number' ? event.output_index : implicitIndex();
}

function contentIndex(event: ResponsesEvent): number {
  return typeof event.content_index === 'number' ? event.content_index : 0;
}

function summaryIndex(event: ResponsesEvent, fallback: number): number {
  return typeof event.summary_index === 'number' ? event.summary_index : fallback;
}

function renderReasoningSummary(parts: Map<number, { text: string }>): string {
  return Array.from(parts.entries())
    .sort(([a], [b]) => a - b)
    .map(([, part]) => part.text)
    .join('\n\n');
}

function renderMessageText(
  parts: Map<number, { type: 'output_text' | 'refusal'; text: string }>,
): string {
  return Array.from(parts.entries())
    .sort(([a], [b]) => a - b)
    .map(([, part]) => part.text)
    .join('');
}

function messageItemText(item: Record<string, any>): string {
  return (Array.isArray(item.content) ? item.content : [])
    .map((part) => (part?.type === 'output_text' ? part.text : (part?.refusal ?? '')))
    .filter((text): text is string => typeof text === 'string')
    .join('');
}

function reasoningItemText(item: Record<string, any>): string {
  const summaryText = (Array.isArray(item.summary) ? item.summary : [])
    .map((part) => part?.text)
    .filter((text): text is string => typeof text === 'string')
    .join('\n\n');
  const contentText = (Array.isArray(item.content) ? item.content : [])
    .map((part) => part?.text)
    .filter((text): text is string => typeof text === 'string')
    .join('\n\n');
  return summaryText || contentText;
}

function emitAppendedDelta(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  eventType: 'thinking_delta' | 'text_delta',
  contentIndexValue: number,
  previous: string,
  next: string,
): void {
  if (!next.startsWith(previous)) return;
  const delta = next.slice(previous.length);
  if (delta)
    stream.push({ type: eventType, contentIndex: contentIndexValue, delta, partial: output });
}

export function createResponsesEventProcessor<TApi extends Api>(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<TApi>,
): { apply(event: ResponsesEvent): void } {
  const states = new Map<number, OutputState>();
  let nextImplicitOutputIndex = 0;
  let lastOutputIndex = 0;

  const allocateImplicitOutputIndex = () => nextImplicitOutputIndex++;
  const outputIndex = (event: ResponsesEvent) =>
    typeof event.output_index === 'number' ? event.output_index : lastOutputIndex;

  const createReasoningState = (index: number): ReasoningState => {
    const block: ThinkingBlock = { type: 'thinking', thinking: '' };
    output.content.push(block as AssistantMessage['content'][number]);
    const state: ReasoningState = {
      kind: 'reasoning',
      blockIndex: blockIndex(output),
      block,
      summaryParts: new Map(),
    };
    states.set(index, state);
    stream.push({ type: 'thinking_start', contentIndex: state.blockIndex, partial: output });
    return state;
  };

  const createMessageState = (index: number): MessageState => {
    const block: TextContent = { type: 'text', text: '' };
    output.content.push(block);
    const state: MessageState = {
      kind: 'message',
      blockIndex: blockIndex(output),
      block,
      parts: new Map(),
    };
    states.set(index, state);
    stream.push({ type: 'text_start', contentIndex: state.blockIndex, partial: output });
    return state;
  };

  const createFunctionCallState = (index: number, item: Record<string, any>): FunctionCallState => {
    const block: ToolCallBlock = {
      type: 'toolCall',
      id: `${item.call_id}|${item.id}`,
      name: item.name,
      arguments: parseResponsesJsonObject(item.arguments),
      partialJson: item.arguments || '',
    };
    output.content.push(block);
    const state: FunctionCallState = {
      kind: 'function_call',
      blockIndex: blockIndex(output),
      block,
    };
    states.set(index, state);
    stream.push({ type: 'toolcall_start', contentIndex: state.blockIndex, partial: output });
    return state;
  };

  const apply = (event: ResponsesEvent): void => {
    const type = event.type;
    if (event.response?.id) output.responseId = event.response.id;

    if (type === 'response.created') {
      output.responseId = event.response?.id ?? output.responseId;
      return;
    }

    if (type === 'response.output_item.added') {
      const index = outputIndexForAdded(event, allocateImplicitOutputIndex);
      lastOutputIndex = index;
      const item = event.item ?? {};
      if (item.type === 'reasoning') createReasoningState(index);
      else if (item.type === 'message') createMessageState(index);
      else if (item.type === 'function_call') createFunctionCallState(index, item);
      return;
    }

    if (type === 'response.reasoning_summary_part.added') {
      const state = states.get(outputIndex(event));
      if (state?.kind === 'reasoning') {
        state.summaryParts.set(summaryIndex(event, state.summaryParts.size), {
          text: event.part?.text ?? '',
        });
      }
      return;
    }

    if (type === 'response.reasoning_summary_text.delta') {
      const state = states.get(outputIndex(event));
      if (state?.kind === 'reasoning') {
        const index = summaryIndex(
          event,
          state.summaryParts.size === 0 ? 0 : state.summaryParts.size - 1,
        );
        const part = state.summaryParts.get(index) ?? { text: '' };
        part.text += String(event.delta ?? '');
        state.summaryParts.set(index, part);
        const previous = state.block.thinking;
        const next = renderReasoningSummary(state.summaryParts);
        state.block.thinking = next;
        emitAppendedDelta(stream, output, 'thinking_delta', state.blockIndex, previous, next);
      }
      return;
    }

    if (type === 'response.reasoning_summary_part.done') {
      const state = states.get(outputIndex(event));
      if (state?.kind === 'reasoning') {
        state.summaryParts.set(summaryIndex(event, state.summaryParts.size), {
          text: event.part?.text ?? '',
        });
        state.block.thinking = renderReasoningSummary(state.summaryParts);
      }
      return;
    }

    if (type === 'response.reasoning_text.delta') {
      const state = states.get(outputIndex(event));
      if (state?.kind === 'reasoning') {
        const delta = String(event.delta ?? '');
        state.block.thinking += delta;
        stream.push({
          type: 'thinking_delta',
          contentIndex: state.blockIndex,
          delta,
          partial: output,
        });
      }
      return;
    }

    if (type === 'response.content_part.added') {
      const state = states.get(outputIndex(event));
      const part = event.part ?? {};
      if (state?.kind === 'message' && (part.type === 'output_text' || part.type === 'refusal')) {
        state.parts.set(contentIndex(event), {
          type: part.type,
          text: part.type === 'output_text' ? (part.text ?? '') : (part.refusal ?? ''),
        });
      }
      return;
    }

    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      const state = states.get(outputIndex(event));
      if (state?.kind === 'message') {
        const index = contentIndex(event);
        const fallbackType = type === 'response.refusal.delta' ? 'refusal' : 'output_text';
        const part = state.parts.get(index) ?? { type: fallbackType, text: '' };
        part.text += String(event.delta ?? '');
        state.parts.set(index, part);
        const previous = state.block.text;
        const next = renderMessageText(state.parts);
        state.block.text = next;
        emitAppendedDelta(stream, output, 'text_delta', state.blockIndex, previous, next);
      }
      return;
    }

    if (type === 'response.function_call_arguments.delta') {
      const state = states.get(outputIndex(event));
      if (state?.kind === 'function_call') {
        const delta = String(event.delta ?? '');
        state.block.partialJson = (state.block.partialJson ?? '') + delta;
        state.block.arguments = parseResponsesJsonObject(state.block.partialJson);
        stream.push({
          type: 'toolcall_delta',
          contentIndex: state.blockIndex,
          delta,
          partial: output,
        });
      }
      return;
    }

    if (type === 'response.function_call_arguments.done') {
      const state = states.get(outputIndex(event));
      if (state?.kind === 'function_call') {
        const previous = state.block.partialJson ?? '';
        const partialJson = event.arguments ?? '';
        state.block.partialJson = partialJson;
        state.block.arguments = parseResponsesJsonObject(partialJson);
        if (partialJson.startsWith(previous)) {
          const delta = partialJson.slice(previous.length);
          if (delta)
            stream.push({
              type: 'toolcall_delta',
              contentIndex: state.blockIndex,
              delta,
              partial: output,
            });
        }
      }
      return;
    }

    if (type === 'response.output_item.done') {
      const index = outputIndex(event);
      const item = event.item ?? {};
      if (item.type === 'reasoning') {
        const state =
          states.get(index)?.kind === 'reasoning'
            ? (states.get(index) as ReasoningState)
            : createReasoningState(index);
        state.block.thinking = reasoningItemText(item) || state.block.thinking;
        state.block.thinkingSignature = JSON.stringify(item);
        stream.push({
          type: 'thinking_end',
          contentIndex: state.blockIndex,
          content: state.block.thinking,
          partial: output,
        });
        states.delete(index);
      } else if (item.type === 'message') {
        const state =
          states.get(index)?.kind === 'message'
            ? (states.get(index) as MessageState)
            : createMessageState(index);
        state.block.text = messageItemText(item);
        state.block.textSignature = encodeTextSignatureV1(item.id, item.phase);
        stream.push({
          type: 'text_end',
          contentIndex: state.blockIndex,
          content: state.block.text,
          partial: output,
        });
        states.delete(index);
      } else if (item.type === 'function_call') {
        const existing = states.get(index);
        const state =
          existing?.kind === 'function_call' ? existing : createFunctionCallState(index, item);
        state.block.arguments = parseResponsesJsonObject(
          state.block.partialJson || item.arguments || '{}',
        );
        delete state.block.partialJson;
        stream.push({
          type: 'toolcall_end',
          contentIndex: state.blockIndex,
          toolCall: state.block,
          partial: output,
        });
        states.delete(index);
      } else {
        const hiddenItem = sanitizeHiddenResponseItem(item);
        if (hiddenItem) {
          (output.content as InternalAssistantContent[]).push({
            type: 'response_item',
            item: hiddenItem,
          });
        }
        states.delete(index);
      }
      return;
    }

    if (
      type === 'response.completed' ||
      type === 'response.done' ||
      type === 'response.incomplete'
    ) {
      applyCompletedResponse(output, model, {
        ...event.response,
        status:
          event.response?.status ?? (type === 'response.incomplete' ? 'incomplete' : undefined),
      });
      return;
    }

    if (type === 'error') throw new Error(event.message || event.code || JSON.stringify(event));
    if (type === 'response.failed' || type === 'response.cancelled') {
      const response = event.response ?? {};
      throw new TerminalResponseError(type, response);
    }
  };

  return { apply };
}

export async function processResponsesEvents<TApi extends Api>(
  events: AsyncIterable<ResponsesEvent>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<TApi>,
): Promise<void> {
  const processor = createResponsesEventProcessor(output, stream, model);
  for await (const event of events) processor.apply(event);
}

export function extractResponseOutputText(response: Record<string, any>): string {
  const output = Array.isArray(response.output) ? response.output : [];
  return output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => (part?.type === 'output_text' ? part.text : (part?.refusal ?? '')))
    .filter((text): text is string => typeof text === 'string')
    .join('');
}

function responseOutputItems(response: Record<string, any>): Record<string, any>[] {
  return (Array.isArray(response.output) ? response.output : []).filter(
    (item): item is Record<string, any> => typeof item === 'object' && item !== null,
  );
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

export function appendRecoveredReasoningItems(
  response: Record<string, any>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): void {
  const existingReasoningIds = new Set(
    output.content
      .filter((block) => block.type === 'thinking')
      .map((block) => reasoningIdFromSignature(block.thinkingSignature))
      .filter((id): id is string => typeof id === 'string'),
  );

  for (const item of responseOutputItems(response)) {
    if (item.type !== 'reasoning' || typeof item.id !== 'string') continue;
    if (existingReasoningIds.has(item.id)) continue;
    const block: ThinkingBlock = {
      type: 'thinking',
      thinking: reasoningItemText(item),
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

export function appendRecoveredFunctionCalls(
  response: Record<string, any>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): void {
  const existing = new Map<string, { block: ToolCallBlock; index: number }>();
  output.content.forEach((block, index) => {
    if (block.type === 'toolCall') existing.set(block.id, { block: block as ToolCallBlock, index });
  });

  for (const item of responseOutputItems(response)) {
    if (item.type !== 'function_call') continue;
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
      if (argumentsJson.startsWith(toolCall.partialJson)) {
        const delta = argumentsJson.slice(toolCall.partialJson.length);
        if (delta)
          stream.push({
            type: 'toolcall_delta',
            contentIndex: existingEntry.index,
            delta,
            partial: output,
          });
      }
      toolCall.arguments = parseResponsesJsonObject(argumentsJson);
      delete toolCall.partialJson;
      stream.push({
        type: 'toolcall_end',
        contentIndex: existingEntry.index,
        toolCall,
        partial: output,
      });
      continue;
    }

    const toolCall: ToolCall = {
      type: 'toolCall',
      id,
      name,
      arguments: parseResponsesJsonObject(argumentsJson),
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

export function assistantMessageToResponseItems(output: AssistantMessage): unknown[] {
  const items: unknown[] = [];
  let textIndex = 0;
  for (const block of output.content as InternalAssistantContent[]) {
    if (isHiddenResponseItemBlock(block)) {
      items.push(block.item);
      continue;
    }
    if (block.type === 'thinking' && block.thinkingSignature) {
      try {
        items.push(JSON.parse(block.thinkingSignature) as unknown);
      } catch {
        // Ignore malformed opaque signatures.
      }
    } else if (block.type === 'text') {
      const fallbackId = `msg_pi_0_${textIndex}`;
      const id = textSignatureItemId(block.textSignature) ?? fallbackId;
      const phase = textSignaturePhase(block.textSignature);
      textIndex++;
      items.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: sanitizeSurrogates(block.text), annotations: [] }],
        status: 'completed',
        id,
        ...(phase ? { phase } : {}),
      });
    } else if (output.stopReason === 'toolUse' && block.type === 'toolCall') {
      items.push(functionCallInput(block));
    }
  }
  return items;
}
