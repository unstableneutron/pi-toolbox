export const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
export const DEFAULT_WRITE_YIELD_TIME_MS = 250;
export const DEFAULT_EMPTY_WRITE_YIELD_TIME_MS = 5_000;
const MIN_YIELD_TIME_MS = 250;
const MIN_NON_INTERACTIVE_EXEC_YIELD_TIME_MS = 5_000;
const MIN_EMPTY_WRITE_YIELD_TIME_MS = 5_000;
const MAX_YIELD_TIME_MS = 30_000;
const DEFAULT_MAX_EMPTY_WRITE_YIELD_TIME_MS = 300_000;

function formatYieldDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatYieldLimit(ms: number): string {
  return `wait ≤${formatYieldDuration(ms)}`;
}

function clampYieldTime(value: number | undefined, fallback: number): number {
  return Math.min(MAX_YIELD_TIME_MS, Math.max(MIN_YIELD_TIME_MS, value ?? fallback));
}

export function clampExecYieldTime(
  value: number | undefined,
  fallback = DEFAULT_EXEC_YIELD_TIME_MS,
  isInteractive = false,
): number {
  const clamped = clampYieldTime(value, fallback);
  return isInteractive ? clamped : Math.max(MIN_NON_INTERACTIVE_EXEC_YIELD_TIME_MS, clamped);
}

export function clampWriteYieldTime(
  value: number | undefined,
  fallback: number,
  isEmptyPoll: boolean,
): number {
  if (!isEmptyPoll) return clampYieldTime(value, fallback);
  return Math.min(
    DEFAULT_MAX_EMPTY_WRITE_YIELD_TIME_MS,
    Math.max(MIN_EMPTY_WRITE_YIELD_TIME_MS, value ?? fallback),
  );
}

export function effectiveWriteYieldTime(value: number | undefined, isEmptyPoll: boolean): number {
  return clampWriteYieldTime(
    value,
    isEmptyPoll ? DEFAULT_EMPTY_WRITE_YIELD_TIME_MS : DEFAULT_WRITE_YIELD_TIME_MS,
    isEmptyPoll,
  );
}
