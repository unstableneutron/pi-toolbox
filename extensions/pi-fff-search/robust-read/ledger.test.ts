import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { DEFAULT_ROBUST_READ_CONFIG } from './config';
import { SessionReadLedger } from './ledger';
import { createRobustReader } from './reader';

const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'robust-read-ledger-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('session read ledger', () => {
  test('detects unchanged repeated reads without sharing state across sessions', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'file.txt'), 'alpha\nbeta');
    const ledger = new SessionReadLedger();
    const reader = createRobustReader(DEFAULT_ROBUST_READ_CONFIG, {}, ledger);
    const first = await reader.read({ path: 'file.txt' }, { cwd, sessionId: 'one' });
    const repeated = await reader.read({ path: 'file.txt' }, { cwd, sessionId: 'one' });
    const otherSession = await reader.read({ path: 'file.txt' }, { cwd, sessionId: 'two' });
    expect(first.kind).toBe('text');
    expect(repeated.kind).toBe('text');
    expect(repeated.kind === 'text' && repeated.details.unchanged).toBe(true);
    expect(repeated.kind === 'text' && repeated.content).toContain('File unchanged');
    expect(otherSession.kind === 'text' && otherSession.details.unchanged).not.toBe(true);
  });

  test('requires reads only for existing files and allows new files', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'existing.txt'), 'one');
    const ledger = new SessionReadLedger();
    await expect(
      ledger.checkMutation('session', 'new.txt', cwd, {
        enforceReadBeforeWrite: true,
        rejectStaleWrites: true,
      }),
    ).resolves.toEqual({ block: false });
    await expect(
      ledger.checkMutation('session', 'existing.txt', cwd, {
        enforceReadBeforeWrite: true,
        rejectStaleWrites: false,
      }),
    ).resolves.toMatchObject({ block: true, reason: expect.stringContaining('Read-before-write') });
  });

  test('rejects stale mutations and trusts a successfully recorded mutation', async () => {
    const cwd = await workspace();
    const path = join(cwd, 'state.txt');
    await writeFile(path, 'one');
    const ledger = new SessionReadLedger();
    const reader = createRobustReader(DEFAULT_ROBUST_READ_CONFIG, {}, ledger);
    await reader.read({ path }, { cwd, sessionId: 'session' });
    await writeFile(path, 'two plus external change');
    await expect(
      ledger.checkMutation('session', path, cwd, {
        enforceReadBeforeWrite: false,
        rejectStaleWrites: true,
      }),
    ).resolves.toMatchObject({ block: true, reason: expect.stringContaining('Stale read') });

    await ledger.recordMutation('session', path, cwd);
    await expect(
      ledger.checkMutation('session', path, cwd, {
        enforceReadBeforeWrite: true,
        rejectStaleWrites: true,
      }),
    ).resolves.toEqual({ block: false });
  });

  test('rejects a path that was deleted or whose symlink target changed after reading', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'first.txt'), 'first');
    await writeFile(join(cwd, 'second.txt'), 'second');
    await symlink('first.txt', join(cwd, 'alias.txt'));
    const ledger = new SessionReadLedger();
    const reader = createRobustReader(DEFAULT_ROBUST_READ_CONFIG, {}, ledger);
    await reader.read({ path: 'alias.txt' }, { cwd, sessionId: 'session' });

    await rm(join(cwd, 'alias.txt'));
    await symlink('second.txt', join(cwd, 'alias.txt'));
    await expect(
      ledger.checkMutation('session', 'alias.txt', cwd, {
        enforceReadBeforeWrite: false,
        rejectStaleWrites: true,
      }),
    ).resolves.toMatchObject({ block: true, reason: expect.stringContaining('different file') });

    await rm(join(cwd, 'alias.txt'));
    await expect(
      ledger.checkMutation('session', 'alias.txt', cwd, {
        enforceReadBeforeWrite: false,
        rejectStaleWrites: true,
      }),
    ).resolves.toMatchObject({ block: true, reason: expect.stringContaining('removed') });
  });
});
