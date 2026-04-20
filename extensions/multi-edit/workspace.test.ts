import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  buildFileVersionToken,
  createFilesystemBackedOverlayWorkspace,
  createOverlayWorkspace,
  createRealWorkspace,
} from './workspace';

describe('createOverlayWorkspace', () => {
  test('forks from an existing workspace without mutating the parent overlay', async () => {
    const root = createOverlayWorkspace('/repo', {
      '/repo/demo.txt': 'alpha\n',
    });
    const child = root.fork();

    await child.writeText('/repo/demo.txt', 'beta\n');

    await expect(root.readText('/repo/demo.txt')).resolves.toBe('alpha\n');
    await expect(child.readText('/repo/demo.txt')).resolves.toBe('beta\n');
  });

  test('fork snapshots known parent state for a path at fork time', async () => {
    const root = createOverlayWorkspace('/repo', {
      '/repo/demo.txt': 'alpha\n',
    });
    const child = root.fork();

    await root.writeText('/repo/demo.txt', 'beta\n');

    await expect(root.readText('/repo/demo.txt')).resolves.toBe('beta\n');
    await expect(child.readText('/repo/demo.txt')).resolves.toBe('alpha\n');
  });

  test('reports metadata without hashing unchanged missing files', async () => {
    const root = createOverlayWorkspace('/repo', {});
    await expect(root.stat('/repo/missing.txt')).resolves.toMatchObject({
      exists: false,
      kind: 'missing',
    });

    await expect(buildFileVersionToken(root, '/repo/missing.txt')).resolves.toMatchObject({
      exists: false,
      sha256: undefined,
    });
  });

  test('supports buffer reads and atomic helpers', async () => {
    const root = createOverlayWorkspace('/repo', {
      '/repo/a.txt': 'alpha\n',
    });

    await root.writeTextAtomic('/repo/a.txt', 'beta\n');
    await root.renameAtomic('/repo/a.txt', '/repo/b.txt');

    await expect(root.exists('/repo/a.txt')).resolves.toBe(false);
    await expect(root.readBuffer('/repo/b.txt')).resolves.toEqual(Buffer.from('beta\n', 'utf8'));
  });

  test('overlay renameAtomic refuses to overwrite an existing target', async () => {
    const root = createOverlayWorkspace('/repo', {
      '/repo/a.txt': 'alpha\n',
      '/repo/b.txt': 'beta\n',
    });

    await expect(root.renameAtomic('/repo/a.txt', '/repo/b.txt')).rejects.toThrow(
      'Target already exists',
    );
  });
});

describe('createFilesystemBackedOverlayWorkspace', () => {
  test('lazily snapshots disk content on first access', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-edit-fs-overlay-'));
    try {
      const filePath = join(dir, 'demo.txt');
      await writeFile(filePath, 'alpha\n', 'utf8');

      const workspace = createFilesystemBackedOverlayWorkspace(dir);
      await expect(workspace.readText(filePath)).resolves.toBe('alpha\n');

      await writeFile(filePath, 'beta\n', 'utf8');
      await expect(workspace.readText(filePath)).resolves.toBe('alpha\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('createRealWorkspace', () => {
  test('writeTextAtomic writes via temp path and renameAtomic avoids clobbering existing target', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-edit-workspace-'));
    try {
      const workspace = createRealWorkspace();
      const source = join(dir, 'src.txt');
      const target = join(dir, 'dst.txt');

      await workspace.writeTextAtomic(source, 'alpha\n');
      await expect(readFile(source, 'utf8')).resolves.toBe('alpha\n');

      await writeFile(target, 'existing\n', 'utf8');
      await expect(workspace.renameAtomic(source, target)).rejects.toThrow('Target already exists');
      await expect(readFile(source, 'utf8')).resolves.toBe('alpha\n');
      await expect(readFile(target, 'utf8')).resolves.toBe('existing\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('writeTextAtomic preserves executable mode when replacing existing regular file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-edit-workspace-mode-'));
    try {
      const workspace = createRealWorkspace();
      const scriptPath = join(dir, 'script.sh');

      await writeFile(scriptPath, '#!/bin/sh\necho alpha\n', 'utf8');
      await chmod(scriptPath, 0o755);

      await workspace.writeTextAtomic(scriptPath, '#!/bin/sh\necho beta\n');

      await expect(readFile(scriptPath, 'utf8')).resolves.toContain('beta');
      const mode = (await stat(scriptPath)).mode & 0o777;
      expect(mode).toBe(0o755);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('writeTextAtomic preserves symlink path and updates symlink target content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-edit-workspace-symlink-'));
    try {
      const workspace = createRealWorkspace();
      const targetPath = join(dir, 'target.txt');
      const linkPath = join(dir, 'link.txt');

      await writeFile(targetPath, 'alpha\n', 'utf8');
      await symlink(targetPath, linkPath);

      await workspace.writeTextAtomic(linkPath, 'beta\n');

      await expect(readFile(targetPath, 'utf8')).resolves.toBe('beta\n');
      const linkStat = await lstat(linkPath);
      expect(linkStat.isSymbolicLink()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
