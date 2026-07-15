import {
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Tool,
} from '@earendil-works/pi-ai/compat';

import {
  buildResponsesInput,
  buildResponsesInstructions,
  buildResponsesTools,
} from './responses-adapter.ts';
import { resolveRequestProfile, type ResolvedRequestProfile } from './profile.ts';

const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
const VALID_TEXT_VERBOSITIES = new Set(['low', 'medium', 'high']);
const VALID_REASONING_SUMMARIES = new Set(['auto', 'concise', 'detailed']);
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

type TextVerbosity = 'low' | 'medium' | 'high';
type ReasoningSummary = 'auto' | 'concise' | 'detailed';
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
type OpenAIWebSocketResponsesStreamOptions = SimpleStreamOptions & {
  textVerbosity?: TextVerbosity;
  reasoningSummary?: ReasoningSummary;
  serviceTier?: string;
};

type ThinkingCompatModel = Model<Api> & {
  thinkingLevelMap?: Partial<Record<ThinkingLevel | 'off', string | null>>;
  thinking?: {
    efforts?: readonly string[];
    effortMap?: Partial<Record<ThinkingLevel | 'off', string>>;
  };
};

export interface RequestStoreSettings {
  storeByProviderModel?: Record<string, boolean>;
}

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

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchesGlob(value: string, pattern: string): boolean {
  return globToRegExp(pattern).test(value);
}

function storeOverrideForProviderModel(
  providerModel: string,
  storeSettings: RequestStoreSettings | undefined,
): boolean | undefined {
  for (const [pattern, store] of Object.entries(storeSettings?.storeByProviderModel ?? {})) {
    if (matchesGlob(providerModel, pattern)) return store;
  }
  return undefined;
}

function resolveStore(
  model: Model<Api>,
  profile: ResolvedRequestProfile,
  storeSettings?: RequestStoreSettings,
): boolean {
  if (profile === 'codex') return false;
  const providerModel = `${model.provider}/${model.id}`;
  return storeOverrideForProviderModel(providerModel, storeSettings) ?? model.provider !== 'openai';
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function clampThinkingLevelCompat(
  model: ThinkingCompatModel,
  requested: unknown,
): ThinkingLevel | undefined {
  if (!isThinkingLevel(requested) || !model.reasoning) return undefined;

  const legacyMap = model.thinkingLevelMap;
  if (legacyMap && requested in legacyMap) {
    return legacyMap[requested] === null ? undefined : requested;
  }

  const supportedEfforts = model.thinking?.efforts;
  if (supportedEfforts && supportedEfforts.length > 0) {
    if (supportedEfforts.includes(requested)) return requested;
    const requestedIndex = THINKING_LEVELS.indexOf(requested);
    const supported = THINKING_LEVELS.filter((level) => supportedEfforts.includes(level));
    if (supported.length === 0) return undefined;
    return supported.reduce((best, level) =>
      Math.abs(THINKING_LEVELS.indexOf(level) - requestedIndex) <
      Math.abs(THINKING_LEVELS.indexOf(best) - requestedIndex)
        ? level
        : best,
    );
  }

  return requested;
}

function mapThinkingEffort(model: ThinkingCompatModel, effort: ThinkingLevel): string | undefined {
  const legacyMapped = model.thinkingLevelMap?.[effort];
  if (legacyMapped !== undefined) return legacyMapped ?? undefined;
  return model.thinking?.effortMap?.[effort] ?? effort;
}

function supportsToolSearch(model: Model<Api>): boolean {
  return (
    (model.compat as { supportsToolSearch?: boolean } | undefined)?.supportsToolSearch === true
  );
}

function splitDeferredTools(
  context: Context,
  enabled: boolean,
): { immediate: Tool[]; deferred: Map<string, Tool> } {
  const uniqueTools = new Map<string, Tool>();
  for (const tool of context.tools ?? []) uniqueTools.set(tool.name, tool);
  if (!enabled) return { immediate: [...uniqueTools.values()], deferred: new Map() };

  const deferredNames = new Set<string>();
  const usedNames = new Set<string>();
  for (const message of context.messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'toolCall') usedNames.add(block.name);
      }
      continue;
    }
    if (message.role === 'toolResult') {
      for (const name of message.addedToolNames ?? []) {
        if (!usedNames.has(name)) deferredNames.add(name);
      }
    }
  }

  const immediate: Tool[] = [];
  const deferred = new Map<string, Tool>();
  for (const [name, tool] of uniqueTools) {
    if (deferredNames.has(name)) deferred.set(name, tool);
    else immediate.push(tool);
  }
  return { immediate, deferred };
}

export function buildResponsesBody(
  model: Model<Api>,
  context: Context,
  options?: OpenAIWebSocketResponsesStreamOptions,
  profile: ResolvedRequestProfile = resolveRequestProfile(model),
  storeSettings?: RequestStoreSettings,
): ResponsesBody {
  const compatModel = model as ThinkingCompatModel;
  const clampedReasoning = clampThinkingLevelCompat(compatModel, options?.reasoning);
  const effort = clampedReasoning ? mapThinkingEffort(compatModel, clampedReasoning) : undefined;
  const toolPlacement = splitDeferredTools(context, supportsToolSearch(model));
  const tools = buildResponsesTools(toolPlacement.immediate);
  const promptCacheKey =
    options?.cacheRetention === 'none' && shouldHonorCacheDisabled(profile)
      ? undefined
      : clampOpenAIPromptCacheKey(options?.sessionId);
  const body: ResponsesBody = {
    model: model.headers?.['x-azure-deployment'] ?? model.id,
    input: buildResponsesInput(model, context, {
      includeSystemPrompt: false,
      deferredTools: toolPlacement.deferred,
    }),
    instructions: buildResponsesInstructions(context) ?? 'You are a helpful assistant.',
    store: resolveStore(model, profile, storeSettings),
    text: { verbosity: resolveTextVerbosity(options) },
    include: ['reasoning.encrypted_content'],
    tool_choice: 'auto',
    parallel_tool_calls: true,
  };
  if (shouldSendMaxOutputTokens(profile) && options?.maxTokens !== undefined) {
    body.max_output_tokens = options.maxTokens;
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
