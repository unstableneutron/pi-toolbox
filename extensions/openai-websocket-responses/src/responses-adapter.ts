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

type ResponsesEvent = Record<string, any>;
type ResponsesInputItem = Record<string, any>;

function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  );
}

function parseJsonObject(value: string | undefined): Record<string, any> {
  if (!value?.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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

function textSignatureItemId(signature: string | undefined): string | undefined {
  const id = parseJsonObject(signature).id;
  return typeof id === 'string' ? id : undefined;
}

function textSignaturePhase(signature: string | undefined): string | undefined {
  const phase = parseJsonObject(signature).phase;
  return typeof phase === 'string' ? phase : undefined;
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

export function buildResponsesInput<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];

  if (context.systemPrompt?.trim()) {
    input.push({
      role: model.reasoning ? 'developer' : 'system',
      content: sanitizeSurrogates(context.systemPrompt),
    });
  }

  let assistantIndex = 0;
  for (const message of context.messages) {
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        const text = sanitizeSurrogates(message.content);
        if (text.trim()) input.push({ role: 'user', content: [{ type: 'input_text', text }] });
        continue;
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
      if (content.length > 0) input.push({ role: 'user', content });
      continue;
    }

    if (message.role === 'assistant') {
      let textBlockIndex = 0;
      for (const block of message.content) {
        if (block.type === 'thinking' && block.thinkingSignature) {
          try {
            input.push(JSON.parse(block.thinkingSignature) as ResponsesInputItem);
          } catch {
            // Ignore malformed opaque signatures.
          }
          continue;
        }
        if (block.type === 'text') {
          const fallbackId = `msg_pi_${assistantIndex}_${textBlockIndex}`;
          const id = textSignatureItemId(block.textSignature) ?? fallbackId;
          textBlockIndex++;
          input.push({
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: sanitizeSurrogates(block.text), annotations: [] },
            ],
            status: 'completed',
            id,
          });
          continue;
        }
        if (block.type === 'toolCall') {
          const { callId, itemId } = splitToolCallId(block.id);
          input.push({
            type: 'function_call',
            id: itemId,
            call_id: callId,
            name: block.name,
            arguments: JSON.stringify(block.arguments),
          });
        }
      }
      assistantIndex++;
      continue;
    }

    if (message.role === 'toolResult') {
      const outputText = textFromContent(message.content);
      const { callId } = splitToolCallId(message.toolCallId);
      input.push({
        type: 'function_call_output',
        call_id: callId,
        output: sanitizeSurrogates(outputText),
      });
    }
  }

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

export function applyResponseUsage<TApi extends Api>(
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
  if (output.content.some((block) => block.type === 'toolCall') && output.stopReason === 'stop') {
    output.stopReason = 'toolUse';
  }
}

export function createResponsesEventProcessor<TApi extends Api>(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<TApi>,
): { apply(event: ResponsesEvent): void } {
  let currentItem: ResponsesEvent | null = null;
  let currentBlock: TextContent | ToolCall | (Record<string, any> & { type: 'thinking' }) | null =
    null;

  const apply = (event: ResponsesEvent): void => {
    const type = event.type;
    if (event.response?.id) output.responseId = event.response.id;

    if (type === 'response.created') {
      output.responseId = event.response?.id ?? output.responseId;
      return;
    }

    if (type === 'response.output_item.added') {
      const item = event.item ?? {};
      currentItem = item;
      if (item.type === 'message') {
        currentBlock = { type: 'text', text: '' };
        output.content.push(currentBlock as TextContent);
        stream.push({ type: 'text_start', contentIndex: blockIndex(output), partial: output });
      } else if (item.type === 'function_call') {
        currentBlock = {
          type: 'toolCall',
          id: `${item.call_id}|${item.id}`,
          name: item.name,
          arguments: parseJsonObject(item.arguments),
          partialJson: item.arguments || '',
        } as ToolCall & { partialJson: string };
        output.content.push(currentBlock as ToolCall);
        stream.push({ type: 'toolcall_start', contentIndex: blockIndex(output), partial: output });
      } else if (item.type === 'reasoning') {
        currentBlock = { type: 'thinking', thinking: '' };
        output.content.push(currentBlock as any);
        stream.push({ type: 'thinking_start', contentIndex: blockIndex(output), partial: output });
      }
      return;
    }

    if (type === 'response.reasoning_summary_part.added' && currentItem?.type === 'reasoning') {
      currentItem.summary = currentItem.summary ?? [];
      currentItem.summary.push(event.part);
      return;
    }

    if (
      type === 'response.reasoning_summary_text.delta' &&
      currentItem?.type === 'reasoning' &&
      currentBlock?.type === 'thinking'
    ) {
      currentItem.summary = currentItem.summary ?? [];
      const lastPart = currentItem.summary.at(-1);
      if (lastPart) {
        const delta = String(event.delta ?? '');
        currentBlock.thinking += delta;
        lastPart.text = `${lastPart.text ?? ''}${delta}`;
        stream.push({
          type: 'thinking_delta',
          contentIndex: blockIndex(output),
          delta,
          partial: output,
        });
      }
      return;
    }

    if (
      type === 'response.reasoning_text.delta' &&
      currentItem?.type === 'reasoning' &&
      currentBlock?.type === 'thinking'
    ) {
      const delta = String(event.delta ?? '');
      currentBlock.thinking += delta;
      stream.push({
        type: 'thinking_delta',
        contentIndex: blockIndex(output),
        delta,
        partial: output,
      });
      return;
    }

    if (type === 'response.content_part.added' && currentItem?.type === 'message') {
      currentItem.content = currentItem.content ?? [];
      currentItem.content.push(event.part);
      return;
    }

    if (type === 'response.output_text.delta' && currentBlock?.type === 'text') {
      const delta = String(event.delta ?? '');
      currentBlock.text += delta;
      stream.push({ type: 'text_delta', contentIndex: blockIndex(output), delta, partial: output });
      return;
    }

    if (type === 'response.function_call_arguments.delta' && currentBlock?.type === 'toolCall') {
      const block = currentBlock as ToolCall & { partialJson: string };
      const delta = String(event.delta ?? '');
      block.partialJson += delta;
      block.arguments = parseJsonObject(block.partialJson);
      stream.push({
        type: 'toolcall_delta',
        contentIndex: blockIndex(output),
        delta,
        partial: output,
      });
      return;
    }

    if (type === 'response.output_item.done') {
      const item = event.item ?? {};
      if (item.type === 'reasoning' && currentBlock?.type === 'thinking') {
        const summaryText = (item.summary ?? []).map((part: any) => part.text).join('\n\n');
        const contentText = (item.content ?? []).map((part: any) => part.text).join('\n\n');
        currentBlock.thinking = summaryText || contentText || currentBlock.thinking;
        currentBlock.thinkingSignature = JSON.stringify(item);
        stream.push({
          type: 'thinking_end',
          contentIndex: blockIndex(output),
          content: currentBlock.thinking,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === 'message' && currentBlock?.type === 'text') {
        currentBlock.text = (item.content ?? [])
          .map((part: any) => (part.type === 'output_text' ? part.text : (part.refusal ?? '')))
          .join('');
        currentBlock.textSignature = encodeTextSignatureV1(item.id, item.phase);
        stream.push({
          type: 'text_end',
          contentIndex: blockIndex(output),
          content: currentBlock.text,
          partial: output,
        });
        currentBlock = null;
      } else if (item.type === 'function_call') {
        const block = currentBlock as (ToolCall & { partialJson?: string }) | null;
        const toolCall: ToolCall =
          block?.type === 'toolCall'
            ? block
            : {
                type: 'toolCall',
                id: `${item.call_id}|${item.id}`,
                name: item.name,
                arguments: {},
              };
        toolCall.arguments = parseJsonObject(block?.partialJson || item.arguments || '{}');
        delete (toolCall as ToolCall & { partialJson?: string }).partialJson;
        stream.push({
          type: 'toolcall_end',
          contentIndex: blockIndex(output),
          toolCall,
          partial: output,
        });
        currentBlock = null;
      }
      return;
    }

    if (type === 'response.completed' || type === 'response.done') {
      applyCompletedResponse(output, model, event.response ?? {});
      return;
    }

    if (type === 'error') throw new Error(event.message || event.code || JSON.stringify(event));
    if (
      type === 'response.failed' ||
      type === 'response.incomplete' ||
      type === 'response.cancelled'
    ) {
      const response = event.response ?? {};
      throw new Error(
        response.error?.message ||
          response.incomplete_details?.reason ||
          JSON.stringify(response || event),
      );
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

export function assistantMessageToResponseItems(output: AssistantMessage): unknown[] {
  const items: unknown[] = [];
  let textIndex = 0;
  for (let index = 0; index < output.content.length; index++) {
    const block = output.content[index]!;
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
    } else if (block.type === 'toolCall') {
      const { callId, itemId } = splitToolCallId(block.id);
      items.push({
        type: 'function_call',
        id: itemId,
        call_id: callId,
        name: block.name,
        arguments: JSON.stringify(block.arguments),
      });
    }
  }
  return items;
}
