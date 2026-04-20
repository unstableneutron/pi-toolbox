import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getAgentDir } from '@mariozechner/pi-coding-agent';

import {
  createEmptyRollingSummarySidecar,
  isRollingSessionSummary,
  ROLLING_SUMMARY_SIDECAR_VERSION,
  type RollingSessionSummary,
  type RollingSummarySidecar,
} from './contracts';

export function getRollingSummarySidecarPath(sessionId: string): string {
  return join(getAgentDir(), 'smart-sessions', 'rolling-summary', `${sessionId}.json`);
}

export function readRollingSummarySidecar(sessionId: string): RollingSummarySidecar {
  const path = getRollingSummarySidecarPath(sessionId);
  if (!existsSync(path)) {
    return createEmptyRollingSummarySidecar(sessionId);
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RollingSummarySidecar>;
    return {
      version:
        parsed.version === ROLLING_SUMMARY_SIDECAR_VERSION
          ? parsed.version
          : ROLLING_SUMMARY_SIDECAR_VERSION,
      sessionId,
      current: isRollingSessionSummary(parsed.current) ? parsed.current : undefined,
      previous: isRollingSessionSummary(parsed.previous) ? parsed.previous : undefined,
    };
  } catch {
    return createEmptyRollingSummarySidecar(sessionId);
  }
}

export function writeRollingSummaryCurrent(
  sessionId: string,
  current: RollingSessionSummary,
): RollingSummarySidecar {
  const path = getRollingSummarySidecarPath(sessionId);
  const previousState = readRollingSummarySidecar(sessionId);

  const nextState: RollingSummarySidecar = {
    version: ROLLING_SUMMARY_SIDECAR_VERSION,
    sessionId,
    current,
    previous: previousState.current,
  };

  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
  renameSync(tempPath, path);

  return nextState;
}
