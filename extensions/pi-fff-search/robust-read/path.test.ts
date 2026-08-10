import { constants, type Stats } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { DEFAULT_ROBUST_READ_CONFIG } from './config';
import { RobustReadError } from './errors';
import { resolveValidatedTarget, specialFileKind } from './path';
import { createRobustReader } from './reader';

const temporaryDirectories: string[] = [];
const servers: Server[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'robust-read-path-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('resolveValidatedTarget', () => {
  test('accepts regular files and follows safe symlink chains', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'target.txt'), 'safe');
    await symlink('target.txt', join(cwd, 'second'));
    await symlink('second', join(cwd, 'first'));
    const target = await resolveValidatedTarget('first', cwd, DEFAULT_ROBUST_READ_CONFIG);
    expect(target.canonicalPath).toBe(await realpath(join(cwd, 'target.txt')));
    expect(target.stats.isFile()).toBe(true);
  });

  test('returns directories for the adapter ls flow', async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, 'folder'));
    const target = await resolveValidatedTarget('folder', cwd, DEFAULT_ROBUST_READ_CONFIG);
    expect(target.stats.isDirectory()).toBe(true);
  });

  test('rejects FIFOs, sockets, devices, and symlinks to special files', async () => {
    const cwd = await workspace();
    const fifo = join(cwd, 'live.pipe');
    execFileSync('mkfifo', [fifo]);
    const socket = join(cwd, 'live.sock');
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(socket, resolveListen);
    });
    await symlink('live.pipe', join(cwd, 'innocent.txt'));

    for (const path of [fifo, socket, join(cwd, 'innocent.txt'), '/dev/null']) {
      await expect(
        resolveValidatedTarget(path, cwd, DEFAULT_ROBUST_READ_CONFIG),
      ).rejects.toMatchObject({ code: 'not_regular' });
    }
  });

  test('classifies block devices and unknown non-regular targets', () => {
    const stats = (kind: 'block' | 'unknown') =>
      ({
        isFIFO: () => false,
        isSocket: () => false,
        isCharacterDevice: () => false,
        isBlockDevice: () => kind === 'block',
      }) as Stats;
    expect(specialFileKind(stats('block'))).toBe('block device');
    expect(specialFileKind(stats('unknown'))).toBe('special non-regular file');
    expect(constants.S_IFBLK).toBeGreaterThan(0);
  });

  test('reports broken symlinks and symlink loops', async () => {
    const cwd = await workspace();
    await symlink('missing', join(cwd, 'broken'));
    await symlink('loop-b', join(cwd, 'loop-a'));
    await symlink('loop-a', join(cwd, 'loop-b'));
    await expect(
      resolveValidatedTarget('broken', cwd, DEFAULT_ROBUST_READ_CONFIG),
    ).rejects.toMatchObject({ code: 'broken_symlink' });
    await expect(
      resolveValidatedTarget('loop-a', cwd, DEFAULT_ROBUST_READ_CONFIG),
    ).rejects.toMatchObject({ code: 'symlink_loop' });
  });

  test('recovers one safe NFC/NFD and punctuation-equivalent sibling', async () => {
    const cwd = await workspace();
    const actual = `Meeting notes' cafe\u0301-final.txt`;
    await writeFile(join(cwd, actual), 'agenda');
    const requested = 'Meeting\u202fnotes\u2019 café–final.txt';
    const target = await resolveValidatedTarget(requested, cwd, DEFAULT_ROBUST_READ_CONFIG);
    expect(target.canonicalPath).toBe(await realpath(join(cwd, actual)));
    expect(target.recoveredFrom).toBe(requested);
  });

  test('keeps the recovery notice and content inside the exact response budget', async () => {
    const cwd = await workspace();
    const stem = 'n'.repeat(160);
    const actual = `${stem}-file.txt`;
    const requested = `${stem}–file.txt`;
    await writeFile(
      join(cwd, actual),
      Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n'),
    );
    const reader = createRobustReader({
      ...DEFAULT_ROBUST_READ_CONFIG,
      maxResponseBytes: 512,
      deduplicateReads: false,
    });
    const result = await reader.read({ path: requested }, { cwd, sessionId: 'session' });
    expect(result.kind).toBe('text');
    if (result.kind !== 'text') return;
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(512);
    expect(result.details.responseBytes).toBe(Buffer.byteLength(result.content, 'utf8'));
    expect(result.details.nextOffset).toBeGreaterThan(1);
    expect(result.content).toContain('Use offset=');
  });

  test('chooses the only safe equivalent and ignores a special-file twin', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'report-final.txt'), 'safe');
    execFileSync('mkfifo', [join(cwd, 'report—final.txt')]);
    const target = await resolveValidatedTarget(
      'report–final.txt',
      cwd,
      DEFAULT_ROBUST_READ_CONFIG,
    );
    expect(target.canonicalPath).toBe(await realpath(join(cwd, 'report-final.txt')));
  });

  test('chooses the only safe equivalent and ignores a broken-link twin', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'report-final.txt'), 'safe');
    await symlink('missing.txt', join(cwd, 'report—final.txt'));
    const target = await resolveValidatedTarget(
      'report–final.txt',
      cwd,
      DEFAULT_ROBUST_READ_CONFIG,
    );
    expect(target.canonicalPath).toBe(await realpath(join(cwd, 'report-final.txt')));
  });

  test('never selects an ambiguous equivalent and returns at most five candidates', async () => {
    const cwd = await workspace();
    const candidates = [
      "report-final's.txt",
      'report—final’s.txt',
      'report−final‘s.txt',
      'report‐finalʼs.txt',
      'report－final＇s.txt',
      'report–final’s.txt',
    ];
    await Promise.all(candidates.map((name) => writeFile(join(cwd, name), name)));
    let caught: unknown;
    try {
      await resolveValidatedTarget('report‑finalʼs.txt', cwd, DEFAULT_ROBUST_READ_CONFIG);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RobustReadError);
    expect(caught).toMatchObject({ code: 'ambiguous_path' });
    expect((caught as RobustReadError).candidates).toHaveLength(5);
  });

  test('bounds sibling enumeration before attempting recovery', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'a.txt'), 'a');
    await writeFile(join(cwd, 'b.txt'), 'b');
    await writeFile(join(cwd, 'wanted—file.txt'), 'match');
    await expect(
      resolveValidatedTarget('wanted-file.txt', cwd, {
        ...DEFAULT_ROBUST_READ_CONFIG,
        siblingScanLimit: 1,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
