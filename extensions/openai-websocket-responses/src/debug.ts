import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';

import type { OpenAIWebSocketResponsesSettings } from './settings.ts';

const DEFAULT_DEBUG_LOG_FILE = join(
  homedir(),
  '.pi',
  'agent',
  'openai-websocket-responses.debug.jsonl',
);

export function shortHash(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function resolveLogFile(path: string | undefined): string {
  if (!path) return DEFAULT_DEBUG_LOG_FILE;
  return isAbsolute(path) ? path : join(process.cwd(), path);
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (/authorization|api[-_]?key|token|secret/i.test(key)) return [key, '<redacted>'];
      return [key, sanitize(item)];
    }),
  );
}

export function writeDebugLog(
  settings: OpenAIWebSocketResponsesSettings,
  event: string,
  details: Record<string, unknown> = {},
): void {
  if (!settings.debug.enabled) return;
  const logFile = resolveLogFile(settings.debug.logFile);
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    const sanitizedDetails = sanitize(details) as Record<string, unknown>;
    appendFileSync(
      logFile,
      `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...sanitizedDetails })}\n`,
      'utf8',
    );
  } catch {
    // Debug logging must never affect provider behavior.
  }
}
