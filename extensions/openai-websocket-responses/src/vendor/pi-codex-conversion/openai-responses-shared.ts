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

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Model,
  TextContent,
  Tool,
  ToolCall,
} from '@earendil-works/pi-ai/compat';

import { shortHash } from '../../debug.ts';
import { parsePartialJson } from '../../partial-json.ts';

type Usage = AssistantMessage['usage'];

function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage['cost'] {
  const longWrite = usage.cacheWrite1h ?? 0;
  const shortWrite = usage.cacheWrite - longWrite;
  usage.cost.input = (model.cost.input / 1_000_000) * usage.input;
  usage.cost.output = (model.cost.output / 1_000_000) * usage.output;
  usage.cost.cacheRead = (model.cost.cacheRead / 1_000_000) * usage.cacheRead;
  usage.cost.cacheWrite =
    (model.cost.cacheWrite * shortWrite + model.cost.input * 2 * longWrite) / 1_000_000;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage.cost;
}

import {
  TerminalResponseError,
  isRetryableEmptyResponseFailure,
} from '../../../../shared/openai-responses-terminal';
import {
  analyzeResponsesReasoningSignature,
  createResponsesReplayState,
  encodeResponsesTextSignatureV1,
  noteResponsesReasoningForReplay,
  responsesDependentItemId,
  responsesFunctionCallInput,
  responsesTextSignatureItemId,
  responsesTextSignaturePhase,
  sanitizeResponsesText,
  splitResponsesToolCallId,
} from '../../../../shared/openai-responses-replay';

export { isRetryableEmptyResponseFailure };

type ResponsesEvent = Record<string, any>;
type ResponsesInputItem = Record<string, any>;
type Message = Context['messages'][number];
type BuildResponsesInputOptions = {
  includeSystemPrompt?: boolean;
  deferredTools?: ReadonlyMap<string, Tool>;
};

type BuildResponsesToolsOptions = {
  deferLoading?: boolean;
};
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
      return parsedObject(parsePartialJson(value));
    } catch {
      return {};
    }
  }
}

export function buildResponsesInstructions(
  context: Pick<Context, 'systemPrompt'>,
): string | undefined {
  return context.systemPrompt?.trim() ? sanitizeResponsesText(context.systemPrompt) : undefined;
}

function textFromContent(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((item): item is TextContent => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function toolResultOutput(
  content: (TextContent | ImageContent)[],
  supportsImages: boolean,
): string | ResponsesInputItem[] {
  const text = sanitizeResponsesText(textFromContent(content));
  const hasText = text.length > 0;
  const hasImages = content.some((item) => item.type === 'image');
  if (!hasImages || !supportsImages) {
    return hasText ? text : hasImages ? '(see attached image)' : '(no tool output)';
  }

  return content.map((item) =>
    item.type === 'text'
      ? { type: 'input_text', text: sanitizeResponsesText(item.text) }
      : {
          type: 'input_image',
          detail: 'auto',
          image_url: `data:${item.mimeType};base64,${item.data}`,
        },
  );
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
  return item ? encodeResponsesTextSignatureV1(item.id, item.phase) : undefined;
}

export function isFinalizedTextBlock(block: TextContent): boolean {
  return !!responsesTextSignatureItemId(block.textSignature);
}

function toolResultInput<TApi extends Api>(
  message: Extract<Message, { role: 'toolResult' }>,
  model: Model<TApi>,
): ResponsesInputItem {
  const { callId } = splitResponsesToolCallId(message.toolCallId);
  return {
    type: 'function_call_output',
    call_id: callId,
    output: toolResultOutput(message.content, model.input.includes('image')),
  };
}

function syntheticToolResultInput(block: ToolCall): ResponsesInputItem {
  const { callId } = splitResponsesToolCallId(block.id);
  return { type: 'function_call_output', call_id: callId, output: 'No result provided' };
}

function userInput(message: Extract<Message, { role: 'user' }>): ResponsesInputItem | undefined {
  if (typeof message.content === 'string') {
    const text = sanitizeResponsesText(message.content);
    return text.trim() ? { role: 'user', content: [{ type: 'input_text', text }] } : undefined;
  }
  const content = message.content.map((item) =>
    item.type === 'text'
      ? { type: 'input_text', text: sanitizeResponsesText(item.text) }
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
  const replayState = createResponsesReplayState();
  for (const block of message.content as InternalAssistantContent[]) {
    if (isHiddenResponseItemBlock(block)) {
      if (!replayState.hasUnreplayableReasoningBeforeItem) output.push(block.item);
      continue;
    }
    if (block.type === 'thinking') {
      const item = noteResponsesReasoningForReplay(replayState, block.thinkingSignature);
      if (item) output.push(item);
      continue;
    }
    if (block.type === 'text') {
      const fallbackId = `msg_pi_${index}_${textBlockIndex}`;
      const signatureId = responsesTextSignatureItemId(block.textSignature);
      const phase = responsesTextSignaturePhase(block.textSignature);
      textBlockIndex++;
      const id = responsesDependentItemId(replayState, signatureId ?? fallbackId);
      output.push({
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: sanitizeResponsesText(block.text), annotations: [] },
        ],
        status: 'completed',
        ...(id ? { id } : {}),
        ...(phase ? { phase } : {}),
      });
      continue;
    }
    if (message.stopReason === 'toolUse' && block.type === 'toolCall') {
      output.push(
        responsesFunctionCallInput(block, {
          includeItemId: !replayState.hasUnreplayableReasoningBeforeItem,
        }),
      );
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
    const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
    input.push({
      role: model.reasoning && compat?.supportsDeveloperRole !== false ? 'developer' : 'system',
      content: instructions,
    });
  }

  let assistantIndex = 0;
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();
  const loadedToolNames = new Set<string>();

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
        input.push(toolResultInput(message, model));

        const addedTools: Tool[] = [];
        for (const name of message.addedToolNames ?? []) {
          const tool = options.deferredTools?.get(name);
          if (!tool || loadedToolNames.has(name)) continue;
          loadedToolNames.add(name);
          addedTools.push(tool);
        }
        if (addedTools.length > 0) {
          const names = addedTools.map((tool) => tool.name);
          const searchCallId = `pi_tool_load_${shortHash(
            `${message.toolCallId}:${names.join(',')}`,
          )}`;
          input.push({
            type: 'tool_search_call',
            call_id: searchCallId,
            execution: 'client',
            status: 'completed',
            arguments: { query: names.join(' '), limit: names.length },
          });
          input.push({
            type: 'tool_search_output',
            call_id: searchCallId,
            execution: 'client',
            status: 'completed',
            tools: buildResponsesTools(addedTools, { deferLoading: true }),
          });
        }
      }
    }
  }

  insertSyntheticToolResults();
  return input;
}

export function buildResponsesTools(
  tools: readonly Tool[] | undefined,
  options: BuildResponsesToolsOptions = {},
): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
    ...(options.deferLoading ? { defer_loading: true } : {}),
  }));
}

function mapStopReason(status: string | undefined): AssistantMessage['stopReason'] {
  if (status === 'incomplete') return 'length';
  if (status === 'failed' || status === 'cancelled') return 'error';
  return 'stop';
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
  const cacheWriteTokens = usage.input_tokens_details?.cache_write_tokens ?? 0;
  output.usage.input = Math.max(0, (usage.input_tokens ?? 0) - cachedTokens - cacheWriteTokens);
  output.usage.output = usage.output_tokens ?? 0;
  output.usage.cacheRead = cachedTokens;
  output.usage.cacheWrite = cacheWriteTokens;
  output.usage.reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0;
  output.usage.totalTokens = usage.total_tokens ?? 0;
  output.usage.cost = calculateCost(model, output.usage);
}

function applyCompletedResponse<TApi extends Api>(
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

function hasActionableAssistantOutput(output: AssistantMessage): boolean {
  return output.content.some(
    (block) =>
      block.type === 'toolCall' ||
      (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0),
  );
}

function appendTerminalText(
  response: Record<string, any>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): void {
  const terminalText = extractResponseOutputText(response);
  const emittedText = getOutputText(output);
  if (terminalText && !terminalText.startsWith(emittedText)) {
    throw new Error('OpenAI Responses terminal output diverged from streamed text');
  }

  let textIndex = -1;
  for (let index = output.content.length - 1; index >= 0; index--) {
    if (output.content[index]?.type === 'text') {
      textIndex = index;
      break;
    }
  }

  const missingText = terminalText.slice(emittedText.length);
  if (missingText) {
    if (textIndex < 0) {
      const created = ensureTextBlock(output, stream);
      textIndex = created.index;
    }
    const block = output.content[textIndex] as TextContent;
    block.text += missingText;
    stream.push({
      type: 'text_delta',
      contentIndex: textIndex,
      delta: missingText,
      partial: output,
    });
  }

  if (textIndex < 0) return;
  const block = output.content[textIndex] as TextContent;
  if (isFinalizedTextBlock(block)) return;
  block.textSignature ??= responseMessageTextSignature(response);
  stream.push({
    type: 'text_end',
    contentIndex: textIndex,
    content: block.text,
    partial: output,
  });
}

export function reconcileCompletedResponse<TApi extends Api>(
  response: Record<string, any>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<TApi>,
): void {
  const hadStreamedContent = output.content.length > 0;
  appendRecoveredReasoningItems(response, output, stream);
  appendTerminalText(response, output, stream);
  appendRecoveredFunctionCalls(response, output, stream);
  applyCompletedResponse(output, model, response);

  if (
    !hadStreamedContent &&
    Array.isArray(response.output) &&
    output.stopReason === 'stop' &&
    !hasActionableAssistantOutput(output)
  ) {
    throw new Error(
      'Model produced invalid content: response.completed contained no assistant text or function calls',
    );
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
  const reasoningBlocksById = new Map<string, ThinkingBlock>();
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

  const backfillReasoningSignatures = (responseOutput: unknown): void => {
    if (!Array.isArray(responseOutput)) return;
    for (const candidate of responseOutput) {
      const item = parsedObject(candidate);
      if (item.type !== 'reasoning' || typeof item.id !== 'string') continue;
      if (typeof item.encrypted_content !== 'string' || !item.encrypted_content) continue;
      const block = reasoningBlocksById.get(item.id);
      if (!block?.thinkingSignature) continue;
      const storedItem = parseResponsesJsonObject(block.thinkingSignature);
      if (storedItem.encrypted_content) continue;
      block.thinkingSignature = JSON.stringify({
        ...storedItem,
        encrypted_content: item.encrypted_content,
      });
    }
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
        if (typeof item.id === 'string') reasoningBlocksById.set(item.id, state.block);
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
        state.block.textSignature = encodeResponsesTextSignatureV1(item.id, item.phase);
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
      backfillReasoningSignatures(event.response?.output);
      const response = {
        ...event.response,
        status:
          event.response?.status ?? (type === 'response.incomplete' ? 'incomplete' : undefined),
      };
      if (type === 'response.incomplete' || response.status === 'incomplete') {
        applyCompletedResponse(output, model, response);
      } else if (response.status === 'failed' || response.status === 'cancelled') {
        applyCompletedResponse(output, model, response);
      } else {
        reconcileCompletedResponse(response, output, stream, model);
      }
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
  const analysis = analyzeResponsesReasoningSignature(signature);
  return analysis.kind === 'replayable-reasoning' ? analysis.id : undefined;
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
  const replayState = createResponsesReplayState();
  for (const block of output.content as InternalAssistantContent[]) {
    if (isHiddenResponseItemBlock(block)) {
      if (!replayState.hasUnreplayableReasoningBeforeItem) items.push(block.item);
      continue;
    }
    if (block.type === 'thinking') {
      const item = noteResponsesReasoningForReplay(replayState, block.thinkingSignature);
      if (item) items.push(item);
    } else if (block.type === 'text') {
      const fallbackId = `msg_pi_0_${textIndex}`;
      const id = responsesDependentItemId(
        replayState,
        responsesTextSignatureItemId(block.textSignature) ?? fallbackId,
      );
      const phase = responsesTextSignaturePhase(block.textSignature);
      textIndex++;
      items.push({
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: sanitizeResponsesText(block.text), annotations: [] },
        ],
        status: 'completed',
        ...(id ? { id } : {}),
        ...(phase ? { phase } : {}),
      });
    } else if (output.stopReason === 'toolUse' && block.type === 'toolCall') {
      items.push(
        responsesFunctionCallInput(block, {
          includeItemId: !replayState.hasUnreplayableReasoningBeforeItem,
        }),
      );
    }
  }
  return items;
}
