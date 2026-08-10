import type { RobustReadConfig } from './types';

export const DEFAULT_ROBUST_READ_CONFIG: RobustReadConfig = {
  maxLines: 2_000,
  maxResponseBytes: 50 * 1024,
  maxLineCharacters: 2_000,
  structuredSourceMaxBytes: 50 * 1024 * 1024,
  siblingScanLimit: 1_024,
  maxPathSuggestions: 5,
  streamChunkBytes: 64 * 1024,
  notebookOutputMaxCharacters: 16 * 1024,
  deduplicateReads: true,
  enforceReadBeforeWrite: false,
  rejectStaleWrites: false,
};

function integerFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function configuredInteger(
  override: number | undefined,
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
): number {
  if (override === undefined) return integerFromEnv(env, name, fallback, minimum);
  return Number.isSafeInteger(override) && override >= minimum ? override : fallback;
}

function booleanFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return fallback;
}

export function loadRobustReadConfig(
  overrides: Partial<RobustReadConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): RobustReadConfig {
  const defaults = DEFAULT_ROBUST_READ_CONFIG;
  return {
    maxLines: configuredInteger(
      overrides.maxLines,
      env,
      'PI_ROBUST_READ_MAX_LINES',
      defaults.maxLines,
      1,
    ),
    maxResponseBytes: configuredInteger(
      overrides.maxResponseBytes,
      env,
      'PI_ROBUST_READ_MAX_BYTES',
      defaults.maxResponseBytes,
      512,
    ),
    maxLineCharacters: configuredInteger(
      overrides.maxLineCharacters,
      env,
      'PI_ROBUST_READ_MAX_LINE_CHARS',
      defaults.maxLineCharacters,
      32,
    ),
    structuredSourceMaxBytes: configuredInteger(
      overrides.structuredSourceMaxBytes,
      env,
      'PI_ROBUST_READ_STRUCTURED_MAX_BYTES',
      defaults.structuredSourceMaxBytes,
      1,
    ),
    siblingScanLimit: configuredInteger(
      overrides.siblingScanLimit,
      env,
      'PI_ROBUST_READ_SIBLING_LIMIT',
      defaults.siblingScanLimit,
      1,
    ),
    maxPathSuggestions: configuredInteger(
      overrides.maxPathSuggestions,
      env,
      'PI_ROBUST_READ_MAX_SUGGESTIONS',
      defaults.maxPathSuggestions,
      1,
    ),
    streamChunkBytes: configuredInteger(
      overrides.streamChunkBytes,
      env,
      'PI_ROBUST_READ_CHUNK_BYTES',
      defaults.streamChunkBytes,
      256,
    ),
    notebookOutputMaxCharacters: configuredInteger(
      overrides.notebookOutputMaxCharacters,
      env,
      'PI_ROBUST_READ_NOTEBOOK_OUTPUT_CHARS',
      defaults.notebookOutputMaxCharacters,
      128,
    ),
    deduplicateReads:
      overrides.deduplicateReads ??
      booleanFromEnv(env, 'PI_ROBUST_READ_DEDUP', defaults.deduplicateReads),
    enforceReadBeforeWrite:
      overrides.enforceReadBeforeWrite ??
      booleanFromEnv(
        env,
        'PI_ROBUST_READ_ENFORCE_READ_BEFORE_WRITE',
        defaults.enforceReadBeforeWrite,
      ),
    rejectStaleWrites:
      overrides.rejectStaleWrites ??
      booleanFromEnv(env, 'PI_ROBUST_READ_REJECT_STALE_WRITES', defaults.rejectStaleWrites),
  };
}
