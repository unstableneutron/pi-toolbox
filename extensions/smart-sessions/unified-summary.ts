import {
  completeSimple,
  type Api,
  type Model,
  type UserMessage,
} from '@earendil-works/pi-ai/compat';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  compactName,
  compactText,
  isStringArray,
  sanitizeBulletList,
  SESSION_TITLE_MAX_CHARS,
  SESSION_TITLE_MAX_WORDS,
  SHORT_SUMMARY_MAX_CHARS,
  WINDOW_TITLE_MAX_WORDS,
  type RollingSessionSummary,
} from './contracts';

interface PreferredModelSpec {
  provider: string;
  id: string;
}

const SUMMARY_MODEL_PREFERENCES: PreferredModelSpec[] = [
  { provider: 'openai', id: 'gpt-5.4-mini' },
  { provider: 'anthropic', id: 'claude-sonnet-4-6' },
];

const SUMMARIZE_TIMEOUT_MS = 45_000;
const SUMMARIZE_MAX_TOKENS = 1400;

const UNIFIED_SUMMARY_PROMPT = `You update a rolling coding-session summary.

Input includes:
- prior compressed summary, if any
- fresh raw conversation since the previous checkpoint

Return valid JSON with exactly these fields:
- shortTitle
- longTitle
- shortSummary
- summaryBullets
- timelineItems

Rules:
- shortTitle must be extremely short and scan-friendly
- longTitle should be descriptive enough for a session list
- shortSummary must focus 90-95 percent on the most recent activity
- if user action is needed, shortSummary must lead with that
- summaryBullets should be concise bullet-ready sentences
- timelineItems should be chronological and end with the latest activity
- do not include markdown fences or explanatory prose outside the JSON object`;

function extractResponseText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeFenceMatch?.[1]) {
    return codeFenceMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

type ParsedRollingSummary = Omit<
  RollingSessionSummary,
  'rewriteCount' | 'checkpointEntryId' | 'conversationHash' | 'generatedAt'
>;

export function parseRollingSummaryResponse(text: string): ParsedRollingSummary {
  const parsed = JSON.parse(extractJsonObject(text)) as Record<string, unknown>;
  if (typeof parsed.shortTitle !== 'string') throw new Error('shortTitle is required');
  if (typeof parsed.longTitle !== 'string') throw new Error('longTitle is required');
  if (typeof parsed.shortSummary !== 'string') throw new Error('shortSummary is required');
  if (!isStringArray(parsed.summaryBullets)) throw new Error('summaryBullets must be strings');
  if (!isStringArray(parsed.timelineItems)) throw new Error('timelineItems must be strings');

  const shortTitle = compactName(parsed.shortTitle, WINDOW_TITLE_MAX_WORDS);
  const longTitle = compactName(parsed.longTitle, SESSION_TITLE_MAX_WORDS, SESSION_TITLE_MAX_CHARS);
  const shortSummary = compactText(parsed.shortSummary, SHORT_SUMMARY_MAX_CHARS);
  const summaryBullets = sanitizeBulletList(parsed.summaryBullets);
  const timelineItems = sanitizeBulletList(parsed.timelineItems);

  if (!shortTitle) throw new Error('shortTitle is invalid');
  if (!longTitle) throw new Error('longTitle is invalid');
  if (!shortSummary) throw new Error('shortSummary is invalid');
  if (summaryBullets.length === 0) throw new Error('summaryBullets is required');
  if (timelineItems.length === 0) throw new Error('timelineItems is required');

  return {
    shortTitle,
    longTitle,
    shortSummary,
    summaryBullets,
    timelineItems,
  };
}

async function resolveCandidateModels(ctx: ExtensionContext): Promise<Array<Model<Api>>> {
  const models: Array<Model<Api>> = [];
  const seen = new Set<string>();

  const add = (model: Model<Api> | null | undefined) => {
    if (!model) return;
    const key = `${model.provider}:${model.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    models.push(model);
  };

  for (const preferred of SUMMARY_MODEL_PREFERENCES) {
    add(ctx.modelRegistry.find(preferred.provider, preferred.id));
  }
  add(ctx.model);
  return models;
}

export async function generateRollingSummary(
  ctx: ExtensionContext,
  payload: {
    previousSummary: string;
    freshConversation: string;
    mode: 'incremental' | 'rebuild';
    metadata: {
      sessionId: string;
      currentShortTitle: string | null;
      currentLongTitle: string | null;
      freshMessageCount: number;
      totalMessageCount: number;
      elapsedSincePreviousSummaryMs: number | null;
      isFirstSummary: boolean;
    };
  },
  externalSignal?: AbortSignal,
): Promise<{ ok: true; result: ParsedRollingSummary } | { ok: false; reason: string }> {
  const models = await resolveCandidateModels(ctx);
  if (models.length === 0) return { ok: false, reason: 'no model available' };

  const messages: UserMessage[] = [
    {
      role: 'user',
      timestamp: Date.now(),
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    },
  ];

  for (const model of models) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) continue;

    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(() => controller.abort(), SUMMARIZE_TIMEOUT_MS);
    externalSignal?.addEventListener('abort', abort, { once: true });

    try {
      const response = await completeSimple(
        model,
        { systemPrompt: UNIFIED_SUMMARY_PROMPT, messages },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens: SUMMARIZE_MAX_TOKENS,
          signal: controller.signal,
        },
      );

      if (response.stopReason === 'error') continue;
      if (response.stopReason === 'aborted') {
        if (externalSignal?.aborted) return { ok: false, reason: 'cancelled' };
        continue;
      }

      return { ok: true, result: parseRollingSummaryResponse(extractResponseText(response)) };
    } catch {
      if (externalSignal?.aborted) return { ok: false, reason: 'cancelled' };
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abort);
    }
  }

  return { ok: false, reason: externalSignal?.aborted ? 'cancelled' : 'request failed' };
}
