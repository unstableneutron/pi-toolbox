import {
  type AssistantMessage,
  type Model,
  type UserMessage,
  completeSimple,
} from '@earendil-works/pi-ai';

type ModelFamily = 'openai' | 'claude' | 'gemini' | 'other';

const REFUSAL_PATTERNS = [
  /\bcannot assist\b/i,
  /\bcan'?t help with\b/i,
  /\bcan'?t comply\b/i,
  /\bunable to help\b/i,
  /\bmust decline\b/i,
  /i\s*'?m sorry,?\s*but\s*i\s*cannot assist/i,
];

const REVIEW_MODEL_IDS: Record<ModelFamily, string[]> = {
  openai: ['claude-opus-4-6', 'gemini-3.1-pro'],
  claude: ['gpt-5.4', 'gemini-3.1-pro'],
  gemini: ['gpt-5.4', 'gemini-3.1-pro'],
  other: ['claude-opus-4-6', 'gpt-5.4'],
};

const REVIEW_PROMPT = `You are reviewing an assistant refusal in a coding session.

Explain briefly why the refusal likely happened, then produce one rewritten follow-up user message that preserves the user's intent but reframes it to maximize the chance of a useful response.

Return exactly this format:
REASON: <one sentence>
REWRITE:
<one rewritten user message>`;

interface ReviewCallInput {
  model: Model<any>;
  apiKey: string;
  headers?: { [key: string]: string };
  transcriptText: string;
  signal?: AbortSignal;
}

interface ReviewCallResult {
  reason: string;
  rewrite: string;
}

export function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((part): part is { type: 'text'; text: string } => 'text' === part?.type)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n');
}

export function extractAssistantText(
  message: Pick<AssistantMessage, 'content'> | undefined,
): string {
  return extractTextContent(message?.content);
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function isSubstantiveAnswerSegment(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }

  return 6 <= countWords(normalized) || 40 <= normalized.length;
}

export function isLikelyRefusalText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }

  if (!REFUSAL_PATTERNS.some((pattern) => pattern.test(text))) {
    return false;
  }

  const segments = text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((segment) => segment.trim())
    .filter(Boolean);

  const substantiveSegments = segments.filter(
    (segment) =>
      !REFUSAL_PATTERNS.some((pattern) => pattern.test(segment)) &&
      isSubstantiveAnswerSegment(segment),
  );

  return 0 === substantiveSegments.length;
}

export function inferModelFamily(
  model: Pick<Model<any>, 'id' | 'api' | 'provider'> | undefined,
): ModelFamily {
  const id = model?.id?.toLowerCase() ?? '';
  const api = model?.api?.toLowerCase?.() ?? '';

  if (
    id.startsWith('gpt-') ||
    id.startsWith('o') ||
    id.includes('codex') ||
    api.includes('openai')
  ) {
    return 'openai';
  }
  if (id.startsWith('claude-') || api.includes('anthropic')) {
    return 'claude';
  }
  if (id.startsWith('gemini-') || id.startsWith('google/gemini-') || api.includes('google')) {
    return 'gemini';
  }
  return 'other';
}

export function findPreferredModel(
  preferredId: string,
  availableModels: Model<any>[],
): Model<any> | undefined {
  const exactMatch = availableModels.find((model) => model.id === preferredId);
  if (exactMatch) {
    return exactMatch;
  }

  const normalizedPreferredId = preferredId.toLowerCase();
  return availableModels.find((model) => {
    const normalizedId = model.id.toLowerCase();
    return (
      normalizedId === normalizedPreferredId || normalizedId.startsWith(`${normalizedPreferredId}-`)
    );
  });
}

export function pickReviewModels(
  activeModel: Pick<Model<any>, 'id' | 'api' | 'provider'> | undefined,
  availableModels: Model<any>[],
): Model<any>[] {
  const family = inferModelFamily(activeModel);
  const preferredIds = REVIEW_MODEL_IDS[family];

  // Preserve the configured fallback order exactly, even when a later fallback
  // happens to match the active model id.
  return preferredIds
    .map((id) => findPreferredModel(id, availableModels))
    .filter((model): model is Model<any> => !!model);
}

export function buildRefusalStatus(modelId: string, phase: 'review' | 'rewrite'): string {
  return 'review' === phase
    ? `↻ Refusal detected; asking ${modelId} for review...`
    : `↻ ${modelId} suggested a rewrite; retrying...`;
}

export function parseReviewResponse(text: string): ReviewCallResult | undefined {
  const match = text.match(/^REASON:\s*(.+)\nREWRITE:\n([\s\S]+)$/m);
  if (!match?.[1] || !match?.[2]) {
    return undefined;
  }

  const reason = match[1].trim();
  const rewrite = match[2].trim();
  if (!reason || !rewrite) {
    return undefined;
  }
  return { reason, rewrite };
}

export function buildReviewTranscript(input: { userText: string; refusalText: string }): string {
  return [
    '<user>',
    input.userText.trim(),
    '</user>',
    '<refusal>',
    input.refusalText.trim(),
    '</refusal>',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function requestRefusalRewrite(
  input: ReviewCallInput,
): Promise<ReviewCallResult | undefined> {
  const message: UserMessage = {
    role: 'user',
    content: [{ type: 'text', text: input.transcriptText }],
    timestamp: Date.now(),
  };

  const response = await completeSimple(
    input.model,
    { systemPrompt: REVIEW_PROMPT, messages: [message] },
    {
      apiKey: input.apiKey,
      headers: input.headers,
      reasoning: 'high',
      maxTokens: 512,
      signal: input.signal,
    },
  );

  if ('stop' !== response.stopReason) {
    return undefined;
  }

  const text = extractAssistantText(response as AssistantMessage);
  return parseReviewResponse(text);
}
