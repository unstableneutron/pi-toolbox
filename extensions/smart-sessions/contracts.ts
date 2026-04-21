export const ROLLING_SUMMARY_SIDECAR_VERSION = 1;
export const WINDOW_TITLE_MAX_WORDS = 4;
export const SESSION_TITLE_MAX_WORDS = 12;
export const SESSION_TITLE_MAX_CHARS = 96;
export const SHORT_SUMMARY_MAX_CHARS = 240;

export interface RollingSessionSummary {
  shortTitle: string;
  longTitle: string;
  shortSummary: string;
  summaryBullets: string[];
  timelineItems: string[];
  rewriteCount: number;
  checkpointEntryId: string;
  conversationHash: string;
  generatedAt: string;
}

export interface RollingSummarySidecar {
  version: typeof ROLLING_SUMMARY_SIDECAR_VERSION;
  sessionId: string;
  current?: RollingSessionSummary;
  previous?: RollingSessionSummary;
}

export function createEmptyRollingSummarySidecar(sessionId: string): RollingSummarySidecar {
  return {
    version: ROLLING_SUMMARY_SIDECAR_VERSION,
    sessionId,
    current: undefined,
    previous: undefined,
  };
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function isRollingSessionSummary(value: unknown): value is RollingSessionSummary {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.shortTitle === 'string' &&
    typeof candidate.longTitle === 'string' &&
    typeof candidate.shortSummary === 'string' &&
    isStringArray(candidate.summaryBullets) &&
    isStringArray(candidate.timelineItems) &&
    typeof candidate.rewriteCount === 'number' &&
    typeof candidate.checkpointEntryId === 'string' &&
    typeof candidate.conversationHash === 'string' &&
    typeof candidate.generatedAt === 'string'
  );
}

function normalizeWords(value: string): string[] {
  return value
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/["'`\u201c\u201d\u2018\u2019]/g, ' ')
    .replace(/[^A-Za-z0-9\s-]/g, ' ')
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

export function compactText(value: string, maxChars: number): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, Math.max(0, maxChars - 1)).trim()}…`;
}

export function compactName(
  value: string,
  maxWords: number,
  maxChars?: number,
): string | undefined {
  const words = normalizeWords(value).slice(0, maxWords);
  if (words.length === 0) return undefined;

  let name = words.join(' ').trim();
  if (maxChars && name.length > maxChars) {
    name = name.slice(0, maxChars).trim();
  }

  return name || undefined;
}

export function sanitizeBulletList(value: string[]): string[] {
  return value
    .map((item) =>
      item
        .replace(/^[-*]\s+/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}
