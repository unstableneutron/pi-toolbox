import { constants, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { RobustReadError } from './errors';
import type { RobustReadConfig, ValidatedTarget } from './types';

function expandHome(filePath: string): string {
  if (filePath === '~') return homedir();
  if (filePath.startsWith('~/')) return join(homedir(), filePath.slice(2));
  return filePath;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function specialFileKind(stats: Stats): string {
  if (stats.isFIFO()) return 'FIFO (named pipe)';
  if (stats.isSocket()) return 'socket';
  if (stats.isCharacterDevice()) return 'character device';
  if (stats.isBlockDevice()) return 'block device';
  return 'special non-regular file';
}

export function canonicalizeEquivalentName(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[\u00a0\u2007\u202f]/gu, ' ')
    .replace(/[\u2018\u2019\u02bc\uff07]/gu, "'")
    .replace(/[\u201c\u201d\u2033\uff02]/gu, '"')
    .replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/gu, '-');
}

async function validateCandidate(
  requestedPath: string,
  absolutePath: string,
  recoveredFrom?: string,
): Promise<ValidatedTarget> {
  let sourceStats: Stats;
  try {
    sourceStats = await lstat(absolutePath);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new RobustReadError('not_found', `File not found: ${requestedPath}`, {
        cause: error,
        requestedPath,
      });
    }
    if (code === 'ELOOP') {
      throw new RobustReadError('symlink_loop', `Symlink loop while resolving: ${requestedPath}`, {
        cause: error,
        requestedPath,
      });
    }
    throw error;
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    const code = errorCode(error);
    if (sourceStats.isSymbolicLink() && (code === 'ENOENT' || code === 'ENOTDIR')) {
      throw new RobustReadError('broken_symlink', `Broken symlink: ${requestedPath}`, {
        cause: error,
        requestedPath,
      });
    }
    if (code === 'ELOOP') {
      throw new RobustReadError('symlink_loop', `Symlink loop while resolving: ${requestedPath}`, {
        cause: error,
        requestedPath,
      });
    }
    throw error;
  }

  const stats = await lstat(canonicalPath);
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new RobustReadError(
      'not_regular',
      `Cannot read '${requestedPath}': final target is a ${specialFileKind(stats)}, not a regular file.`,
      { requestedPath },
    );
  }

  return { requestedPath, absolutePath, canonicalPath, stats, recoveredFrom };
}

async function recoverEquivalentSibling(
  requestedPath: string,
  absolutePath: string,
  config: RobustReadConfig,
): Promise<ValidatedTarget | null> {
  const requestedName = basename(absolutePath);
  if (!requestedName) return null;

  const parentPath = dirname(absolutePath);
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(parentPath);
  } catch {
    return null;
  }
  const parentStats = await lstat(canonicalParent);
  if (!parentStats.isDirectory()) return null;

  const targetName = canonicalizeEquivalentName(requestedName);
  const matches: string[] = [];
  const directory = await opendir(canonicalParent);
  let inspected = 0;
  try {
    for await (const entry of directory) {
      inspected += 1;
      if (inspected > config.siblingScanLimit) return null;
      if (entry.name !== requestedName && canonicalizeEquivalentName(entry.name) === targetName) {
        matches.push(entry.name);
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }

  const safeMatches: ValidatedTarget[] = [];
  for (const match of matches) {
    try {
      safeMatches.push(
        await validateCandidate(requestedPath, join(canonicalParent, match), requestedPath),
      );
    } catch (error) {
      if (
        !(error instanceof RobustReadError) ||
        !['not_regular', 'not_found', 'broken_symlink', 'symlink_loop'].includes(error.code)
      ) {
        throw error;
      }
    }
  }

  if (safeMatches.length === 1) return safeMatches[0];
  if (safeMatches.length > 1) {
    const candidates = safeMatches
      .map((candidate) => candidate.canonicalPath)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, config.maxPathSuggestions);
    throw new RobustReadError(
      'ambiguous_path',
      `Ambiguous path '${requestedPath}'. Safe equivalent candidates:\n${candidates.map((candidate) => `- ${candidate}`).join('\n')}`,
      { requestedPath, candidates },
    );
  }
  return null;
}

export async function resolveValidatedTarget(
  requestedPath: string,
  cwd: string,
  config: RobustReadConfig,
): Promise<ValidatedTarget> {
  const expanded = expandHome(requestedPath);
  const absolutePath = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  try {
    return await validateCandidate(requestedPath, absolutePath);
  } catch (error) {
    if (!(error instanceof RobustReadError) || error.code !== 'not_found') throw error;
  }

  const recovered = await recoverEquivalentSibling(requestedPath, absolutePath, config);
  if (recovered) return recovered;
  throw new RobustReadError('not_found', `File not found: ${requestedPath}`, { requestedPath });
}

export async function openValidatedRegular(target: ValidatedTarget): Promise<FileHandle> {
  if (target.stats.isDirectory()) {
    throw new RobustReadError('directory', `EISDIR: illegal operation on a directory, read`, {
      requestedPath: target.requestedPath,
    });
  }

  let handle: FileHandle;
  try {
    handle = await open(target.canonicalPath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw new RobustReadError(
      'changed_during_read',
      `File changed while opening '${target.requestedPath}'; read was not attempted.`,
      { cause: error, requestedPath: target.requestedPath },
    );
  }

  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) {
      throw new RobustReadError(
        'not_regular',
        `Cannot read '${target.requestedPath}': opened target is a ${specialFileKind(openedStats)}, not a regular file.`,
        { requestedPath: target.requestedPath },
      );
    }
    if (openedStats.dev !== target.stats.dev || openedStats.ino !== target.stats.ino) {
      throw new RobustReadError(
        'changed_during_read',
        `File identity changed while opening '${target.requestedPath}'; retry the read.`,
        { requestedPath: target.requestedPath },
      );
    }
    target.stats = openedStats;
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
