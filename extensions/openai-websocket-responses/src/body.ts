import {
  clampThinkingLevel,
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';

import {
  buildResponsesInput,
  buildResponsesInstructions,
  buildResponsesTools,
} from './responses-adapter.ts';
import { resolveRequestProfile, type ResolvedRequestProfile } from './profile.ts';

const DEFAULT_GPT_STYLE_MAX_OUTPUT_TOKENS = 128000;
const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
const VALID_TEXT_VERBOSITIES = new Set(['low', 'medium', 'high']);
const VALID_REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed']);

type TextVerbosity = 'low' | 'medium' | 'high';
type ReasoningSummary = 'auto' | 'concise' | 'detailed';
type OpenAIWebSocketResponsesStreamOptions = SimpleStreamOptions & {
  textVerbosity?: TextVerbosity;
  reasoningSummary?: ReasoningSummary;
  serviceTier?: string;
};

export interface ResponsesBody {
  model: string;
  input: unknown[];
  instructions?: string;
  store?: boolean;
  previous_response_id?: string;
  max_output_tokens?: number;
  reasoning?: { effort: string; summary?: ReasoningSummary };
  text?: { verbosity: TextVerbosity };
  include?: string[];
  prompt_cache_key?: string;
  prompt_cache_retention?: '24h';
  service_tier?: string;
  tools?: unknown[];
  tool_choice?: 'auto';
  parallel_tool_calls?: boolean;
  temperature?: number;
  [key: string]: unknown;
}

function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const chars = Array.from(key);
  return chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH
    ? key
    : chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join('');
}

function resolveTextVerbosity(options?: OpenAIWebSocketResponsesStreamOptions): TextVerbosity {
  return VALID_TEXT_VERBOSITIES.has(options?.textVerbosity ?? '')
    ? (options?.textVerbosity as TextVerbosity)
    : 'low';
}

function resolveReasoningSummary(
  options?: OpenAIWebSocketResponsesStreamOptions,
): ReasoningSummary {
  return VALID_REASONING_SUMMARIES.has(options?.reasoningSummary ?? '')
    ? (options?.reasoningSummary as ReasoningSummary)
    : 'auto';
}

function shouldSendMaxOutputTokens(profile: ResolvedRequestProfile): boolean {
  return profile !== 'codex';
}

function shouldHonorCacheDisabled(profile: ResolvedRequestProfile): boolean {
  return profile !== 'codex';
}

function shouldSendLongCacheRetention(profile: ResolvedRequestProfile): boolean {
  return profile !== 'codex';
}

function shouldSendServiceTier(profile: ResolvedRequestProfile): boolean {
  return profile === 'codex';
}

export function buildResponsesBody(
  model: Model<Api>,
  context: Context,
  options?: OpenAIWebSocketResponsesStreamOptions,
  profile: ResolvedRequestProfile = resolveRequestProfile(model),
): ResponsesBody {
  const clampedReasoning = options?.reasoning
    ? clampThinkingLevel(model, options.reasoning)
    : undefined;
  const effort =
    clampedReasoning && clampedReasoning !== 'off'
      ? (model.thinkingLevelMap?.[clampedReasoning] ?? clampedReasoning)
      : undefined;
  const tools = buildResponsesTools(context.tools);
  const promptCacheKey =
    options?.cacheRetention === 'none' && shouldHonorCacheDisabled(profile)
      ? undefined
      : clampOpenAIPromptCacheKey(options?.sessionId);
  const body: ResponsesBody = {
    model: model.headers?.['x-azure-deployment'] ?? model.id,
    input: buildResponsesInput(model, context, { includeSystemPrompt: false }),
    instructions: buildResponsesInstructions(context) ?? 'You are a helpful assistant.',
    store: false,
    text: { verbosity: resolveTextVerbosity(options) },
    include: ['reasoning.encrypted_content'],
    tool_choice: 'auto',
    parallel_tool_calls: true,
  };
  if (shouldSendMaxOutputTokens(profile)) {
    body.max_output_tokens =
      options?.maxTokens ?? model.maxTokens ?? DEFAULT_GPT_STYLE_MAX_OUTPUT_TOKENS;
  }
  if (promptCacheKey) {
    body.prompt_cache_key = promptCacheKey;
    if (options?.cacheRetention === 'long' && shouldSendLongCacheRetention(profile)) {
      body.prompt_cache_retention = '24h';
    }
  }
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (options?.serviceTier !== undefined && shouldSendServiceTier(profile)) {
    body.service_tier = String(options.serviceTier);
  }
  if (effort !== undefined && effort !== null) {
    body.reasoning = { effort, summary: resolveReasoningSummary(options) };
  }
  if (tools) body.tools = tools;
  return body;
}
