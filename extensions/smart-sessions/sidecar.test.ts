import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { getAgentDirMock } = vi.hoisted(() => ({
  getAgentDirMock: vi.fn(),
}));

vi.mock('@mariozechner/pi-coding-agent', () => ({
  getAgentDir: getAgentDirMock,
}));

import type { RollingSessionSummary } from './contracts';
import { readRollingSummarySidecar, writeRollingSummaryCurrent } from './sidecar';

let agentDir = '';

const first: RollingSessionSummary = {
  shortTitle: 'Fix notify',
  longTitle: 'Unify notify title and rolling session summary state',
  shortSummary: 'Need user signoff on summary storage path',
  summaryBullets: ['Blocked: waiting on storage-path decision.'],
  timelineItems: ['Asked whether summary state should stay in the session log.'],
  rewriteCount: 0,
  checkpointEntryId: 'entry-2',
  conversationHash: 'hash-1',
  generatedAt: '2026-04-15T00:00:00.000Z',
};

const second: RollingSessionSummary = {
  ...first,
  shortTitle: 'Ship sidecar',
  shortSummary: 'Sidecar approved; implement bounded current/previous state',
  checkpointEntryId: 'entry-5',
  conversationHash: 'hash-2',
  generatedAt: '2026-04-15T00:10:00.000Z',
};

describe('rolling summary sidecar', () => {
  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'smart-sessions-sidecar-'));
    getAgentDirMock.mockReturnValue(agentDir);
  });

  afterEach(() => {
    rmSync(agentDir, { force: true, recursive: true });
    getAgentDirMock.mockReset();
  });

  test('returns undefined state when the sidecar is missing', () => {
    expect(readRollingSummarySidecar('session-1')).toEqual({
      version: 1,
      sessionId: 'session-1',
      current: undefined,
      previous: undefined,
    });
  });

  test('rolls the old current summary into previous on each write', () => {
    writeRollingSummaryCurrent('session-1', first);
    writeRollingSummaryCurrent('session-1', second);

    expect(readRollingSummarySidecar('session-1')).toEqual({
      version: 1,
      sessionId: 'session-1',
      current: second,
      previous: first,
    });
  });
});
