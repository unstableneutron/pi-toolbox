import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import type { FileIdentity } from './types';
import { identitiesEqual, identityFromStats } from './types';

interface LedgerEntry {
  identity: FileIdentity;
  regions: Set<string>;
}

function expandHome(filePath: string): string {
  if (filePath === '~') return homedir();
  if (filePath.startsWith('~/')) return join(homedir(), filePath.slice(2));
  return filePath;
}

function absolutePath(filePath: string, cwd: string): string {
  const expanded = expandHome(filePath);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function isNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'ENOENT' ||
      (error as { code?: unknown }).code === 'ENOTDIR')
  );
}

export class SessionReadLedger {
  private readonly sessions = new Map<string, Map<string, LedgerEntry>>();
  private readonly aliases = new Map<string, Map<string, string>>();

  clear(sessionId?: string): void {
    if (sessionId) {
      this.sessions.delete(sessionId);
      this.aliases.delete(sessionId);
    } else {
      this.sessions.clear();
      this.aliases.clear();
    }
  }

  isUnchanged(
    sessionId: string,
    canonicalPath: string,
    identity: FileIdentity,
    region: string,
  ): boolean {
    const entry = this.sessions.get(sessionId)?.get(canonicalPath);
    return Boolean(entry && identitiesEqual(entry.identity, identity) && entry.regions.has(region));
  }

  recordRead(
    sessionId: string,
    canonicalPath: string,
    identity: FileIdentity,
    region: string,
    aliasPath?: string,
  ): void {
    const files = this.sessions.get(sessionId) ?? new Map<string, LedgerEntry>();
    this.sessions.set(sessionId, files);
    if (aliasPath) {
      const aliases = this.aliases.get(sessionId) ?? new Map<string, string>();
      this.aliases.set(sessionId, aliases);
      aliases.set(resolve(aliasPath), canonicalPath);
    }
    const current = files.get(canonicalPath);
    if (!current || !identitiesEqual(current.identity, identity)) {
      files.set(canonicalPath, { identity, regions: new Set([region]) });
      return;
    }
    current.regions.add(region);
  }

  async checkMutation(
    sessionId: string,
    requestedPath: string,
    cwd: string,
    options: { enforceReadBeforeWrite: boolean; rejectStaleWrites: boolean },
  ): Promise<{ block: boolean; reason?: string }> {
    const requestedAbsolutePath = absolutePath(requestedPath, cwd);
    const previousCanonicalPath = this.aliases.get(sessionId)?.get(requestedAbsolutePath);
    let canonicalPath: string;
    let identity: FileIdentity;
    try {
      canonicalPath = await realpath(requestedAbsolutePath);
      identity = identityFromStats(await stat(canonicalPath));
    } catch (error) {
      if (isNotFound(error)) {
        if (previousCanonicalPath && options.rejectStaleWrites) {
          return {
            block: true,
            reason: `Stale read: '${requestedPath}' was removed or replaced after this session read it. Read the current path before modifying it.`,
          };
        }
        return { block: false };
      }
      if (options.enforceReadBeforeWrite || options.rejectStaleWrites) {
        return {
          block: true,
          reason: `Cannot safely verify read state for '${requestedPath}'. Read the path successfully before modifying it.`,
        };
      }
      return { block: false };
    }

    if (
      previousCanonicalPath &&
      previousCanonicalPath !== canonicalPath &&
      options.rejectStaleWrites
    ) {
      return {
        block: true,
        reason: `Stale read: '${requestedPath}' now resolves to a different file. Read it again before modifying it.`,
      };
    }
    const entry = this.sessions.get(sessionId)?.get(canonicalPath);
    if (!entry && options.enforceReadBeforeWrite) {
      return {
        block: true,
        reason: `Read-before-write enforcement: read '${requestedPath}' successfully before modifying it. Newly created files are allowed.`,
      };
    }
    if (entry && !identitiesEqual(entry.identity, identity) && options.rejectStaleWrites) {
      return {
        block: true,
        reason: `Stale read: '${requestedPath}' changed after this session read it. Read the file again before modifying it.`,
      };
    }
    return { block: false };
  }

  async recordMutation(sessionId: string, requestedPath: string, cwd: string): Promise<void> {
    try {
      const requestedAbsolutePath = absolutePath(requestedPath, cwd);
      const canonicalPath = await realpath(requestedAbsolutePath);
      const identity = identityFromStats(await stat(canonicalPath));
      const files = this.sessions.get(sessionId) ?? new Map<string, LedgerEntry>();
      this.sessions.set(sessionId, files);
      files.set(canonicalPath, { identity, regions: new Set() });
      const aliases = this.aliases.get(sessionId) ?? new Map<string, string>();
      this.aliases.set(sessionId, aliases);
      aliases.set(requestedAbsolutePath, canonicalPath);
    } catch {
      // Tool result remains authoritative; missing/remote paths are not ledger-tracked.
    }
  }
}
