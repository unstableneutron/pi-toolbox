import {
  clampThinkingLevel,
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';

import { buildResponsesInput, buildResponsesTools } from './responses-adapter.ts';

const DEFAULT_GPT_STYLE_MAX_OUTPUT_TOKENS = 128000;

export interface ResponsesBody {
  model: string;
  input: unknown[];
  store?: boolean;
  previous_response_id?: string;
  max_output_tokens?: number;
  reasoning?: { effort: string };
  tools?: unknown[];
  tool_choice?: 'auto';
  parallel_tool_calls?: boolean;
  temperature?: number;
  [key: string]: unknown;
}

export function buildResponsesBody(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): ResponsesBody {
  const clampedReasoning = options?.reasoning
    ? clampThinkingLevel(model, options.reasoning)
    : undefined;
  const effort =
    clampedReasoning && clampedReasoning !== 'off'
      ? (model.thinkingLevelMap?.[clampedReasoning] ?? clampedReasoning)
      : undefined;
  const tools = buildResponsesTools(context.tools);
  const body: ResponsesBody = {
    model: model.headers?.['x-azure-deployment'] ?? model.id,
    input: buildResponsesInput(model, context),
    max_output_tokens: options?.maxTokens ?? model.maxTokens ?? DEFAULT_GPT_STYLE_MAX_OUTPUT_TOKENS,
  };
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (effort !== undefined && effort !== null) body.reasoning = { effort };
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
    body.parallel_tool_calls = true;
  }
  return body;
}
