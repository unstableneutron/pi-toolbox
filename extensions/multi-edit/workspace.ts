import { constants } from 'node:fs';
import {
  access as fsAccess,
  chmod as fsChmod,
  link as fsLink,
  lstat as fsLstat,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  rename as fsRename,
  stat as fsStat,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export interface WorkspaceStat {
  absolutePath: string;
  exists: boolean;
  size: number | undefined;
  mtimeMs: number | undefined;
  kind: 'text' | 'binary' | 'missing';
}

export interface FileVersionToken {
  absolutePath: string;
  exists: boolean;
  size: number | undefined;
  mtimeMs: number | undefined;
  sha256: string | undefined;
}

export interface Workspace {
  readText(absolutePath: string): Promise<string>;
  readBuffer(absolutePath: string): Promise<Buffer>;
  stat(absolutePath: string): Promise<WorkspaceStat>;
  exists(absolutePath: string): Promise<boolean>;
  checkWriteAccess(absolutePath: string): Promise<void>;
  writeText(absolutePath: string, content: string): Promise<void>;
  writeTextAtomic(
    absolutePath: string,
    content: string,
    options?: { noReplace?: boolean },
  ): Promise<void>;
  deleteFile(absolutePath: string): Promise<void>;
  renameAtomic(
    sourcePath: string,
    targetPath: string,
    options?: { noReplace?: boolean },
  ): Promise<void>;
}

export interface OverlayWorkspace extends Workspace {
  fork(): OverlayWorkspace;
}

type OverlayEntry =
  | {
      kind: 'text';
      content: string;
    }
  | {
      kind: 'deleted';
    };

type OverlayBaseLoader = (absolutePath: string) => Promise<OverlayEntry | undefined>;

export function createRealWorkspace(): Workspace {
  return {
    readText: (absolutePath: string) => fsReadFile(absolutePath, 'utf-8'),
    readBuffer: (absolutePath: string) => fsReadFile(absolutePath),
    stat: async (absolutePath: string) => {
      try {
        const result = await fsStat(absolutePath);
        return {
          absolutePath,
          exists: true,
          size: result.size,
          mtimeMs: result.mtimeMs,
          kind: 'text' as const,
        };
      } catch {
        return {
          absolutePath,
          exists: false,
          size: undefined,
          mtimeMs: undefined,
          kind: 'missing' as const,
        };
      }
    },
    writeText: async (absolutePath: string, content: string) => {
      await fsMkdir(dirname(absolutePath), { recursive: true });
      await fsWriteFile(absolutePath, content, 'utf-8');
    },
    writeTextAtomic: async (
      absolutePath: string,
      content: string,
      options?: { noReplace?: boolean },
    ) => {
      await fsMkdir(dirname(absolutePath), { recursive: true });
      if (options?.noReplace) {
        await fsWriteFile(absolutePath, content, { encoding: 'utf-8', flag: 'wx' });
        return;
      }

      const existingEntry = await fsLstat(absolutePath).catch(() => undefined);
      if (existingEntry?.isSymbolicLink()) {
        // Preserve symlink semantics by writing through to the target.
        await fsWriteFile(absolutePath, content, 'utf-8');
        return;
      }

      const tempPath = `${absolutePath}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await fsWriteFile(tempPath, content, 'utf-8');
        if (existingEntry?.isFile()) {
          await fsChmod(tempPath, existingEntry.mode & 0o7777);
        }
        await fsRename(tempPath, absolutePath);
      } catch (error) {
        await fsUnlink(tempPath).catch(() => undefined);
        throw error;
      }
    },
    deleteFile: (absolutePath: string) => fsUnlink(absolutePath),
    renameAtomic: async (
      sourcePath: string,
      targetPath: string,
      options?: { noReplace?: boolean },
    ) => {
      const sourceExists = await fsAccess(sourcePath, constants.F_OK)
        .then(() => true)
        .catch(() => false);
      if (!sourceExists) {
        throw new Error(`File not found: ${sourcePath}`);
      }
      await fsMkdir(dirname(targetPath), { recursive: true });
      if (options?.noReplace) {
        try {
          await fsLink(sourcePath, targetPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(`Target already exists: ${targetPath}`);
          }
          throw error;
        }
        await fsUnlink(sourcePath);
        return;
      }
      const targetExists = await fsAccess(targetPath, constants.F_OK)
        .then(() => true)
        .catch(() => false);
      if (targetExists) {
        throw new Error(`Target already exists: ${targetPath}`);
      }
      await fsRename(sourcePath, targetPath);
    },
    exists: async (absolutePath: string) => {
      try {
        await fsAccess(absolutePath, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    checkWriteAccess: async (absolutePath: string) => {
      const exists = await fsAccess(absolutePath, constants.F_OK)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        await fsAccess(absolutePath, constants.R_OK | constants.W_OK);
      } else {
        await fsMkdir(dirname(absolutePath), { recursive: true });
      }
    },
  };
}

function createOverlayFromParent(
  cwd: string,
  rootState: Map<string, string | null>,
  loadBaseEntry?: OverlayBaseLoader,
): OverlayWorkspace {
  const overlay = new Map<string, OverlayEntry>();
  const knownBase = new Map<string, OverlayEntry>(
    [...rootState.entries()].map(([path, content]) => [
      path,
      content === null ? ({ kind: 'deleted' } as const) : ({ kind: 'text', content } as const),
    ]),
  );

  function rememberMissing(absolutePath: string): OverlayEntry {
    const missingEntry = { kind: 'deleted' } as const;
    if (!knownBase.has(absolutePath)) {
      knownBase.set(absolutePath, missingEntry);
    }
    return missingEntry;
  }

  async function resolveEntry(absolutePath: string): Promise<OverlayEntry | undefined> {
    if (overlay.has(absolutePath)) {
      return overlay.get(absolutePath);
    }

    if (knownBase.has(absolutePath)) {
      return knownBase.get(absolutePath);
    }

    if (loadBaseEntry) {
      const loaded = await loadBaseEntry(absolutePath);
      if (loaded) {
        knownBase.set(absolutePath, loaded);
        return loaded;
      }
    }

    return rememberMissing(absolutePath);
  }

  function snapshotVisibleKnownState(): Map<string, string | null> {
    const snapshot = new Map<string, string | null>();
    const paths = new Set([...knownBase.keys(), ...overlay.keys()]);
    for (const absolutePath of paths) {
      const entry = overlay.get(absolutePath) ?? knownBase.get(absolutePath);
      if (!entry || entry.kind === 'deleted') {
        snapshot.set(absolutePath, null);
      } else {
        snapshot.set(absolutePath, entry.content);
      }
    }
    return snapshot;
  }

  async function stat(absolutePath: string): Promise<WorkspaceStat> {
    const entry = await resolveEntry(absolutePath);
    if (!entry || entry.kind === 'deleted') {
      return {
        absolutePath,
        exists: false,
        size: undefined,
        mtimeMs: undefined,
        kind: 'missing',
      };
    }

    return {
      absolutePath,
      exists: true,
      size: Buffer.byteLength(entry.content, 'utf8'),
      mtimeMs: undefined,
      kind: 'text',
    };
  }

  async function readText(absolutePath: string): Promise<string> {
    const entry = await resolveEntry(absolutePath);
    if (!entry || entry.kind === 'deleted') {
      throw new Error(`File not found: ${absolutePath.replace(`${cwd}/`, '')}`);
    }
    return entry.content;
  }

  async function exists(absolutePath: string): Promise<boolean> {
    return (await stat(absolutePath)).exists;
  }

  return {
    readText,
    async readBuffer(absolutePath: string): Promise<Buffer> {
      return Buffer.from(await readText(absolutePath), 'utf8');
    },
    stat,
    exists,
    async checkWriteAccess(): Promise<void> {},
    async writeText(absolutePath: string, content: string): Promise<void> {
      overlay.set(absolutePath, { kind: 'text', content });
    },
    async writeTextAtomic(
      absolutePath: string,
      content: string,
      options?: { noReplace?: boolean },
    ): Promise<void> {
      if (options?.noReplace && (await exists(absolutePath))) {
        throw new Error(`Target already exists: ${absolutePath.replace(`${cwd}/`, '')}`);
      }
      overlay.set(absolutePath, { kind: 'text', content });
    },
    async deleteFile(absolutePath: string): Promise<void> {
      if (!(await exists(absolutePath))) {
        throw new Error(`File not found: ${absolutePath.replace(`${cwd}/`, '')}`);
      }
      overlay.set(absolutePath, { kind: 'deleted' });
    },
    async renameAtomic(
      sourcePath: string,
      targetPath: string,
      _options?: { noReplace?: boolean },
    ): Promise<void> {
      const content = await readText(sourcePath);
      if (await exists(targetPath)) {
        throw new Error(`Target already exists: ${targetPath.replace(`${cwd}/`, '')}`);
      }
      overlay.set(targetPath, { kind: 'text', content });
      overlay.set(sourcePath, { kind: 'deleted' });
    },
    fork() {
      return createOverlayFromParent(cwd, snapshotVisibleKnownState(), loadBaseEntry);
    },
  };
}

export function createOverlayWorkspace(
  cwd: string,
  initialState?: Record<string, string | null>,
): OverlayWorkspace {
  const rootState = new Map(Object.entries(initialState ?? {}));
  return createOverlayFromParent(cwd, rootState);
}

export function createFilesystemBackedOverlayWorkspace(
  cwd: string,
  initialState?: Record<string, string | null>,
): OverlayWorkspace {
  const rootState = new Map(Object.entries(initialState ?? {}));
  const loadBaseEntry: OverlayBaseLoader = async (absolutePath: string) => {
    try {
      const content = await fsReadFile(absolutePath, 'utf-8');
      return { kind: 'text', content };
    } catch {
      return undefined;
    }
  };

  return createOverlayFromParent(cwd, rootState, loadBaseEntry);
}

export async function buildFileVersionToken(
  workspace: Workspace,
  absolutePath: string,
  options?: {
    includeHash?: boolean;
    stat?: WorkspaceStat;
    buffer?: Buffer;
  },
): Promise<FileVersionToken> {
  const fileStat = options?.stat ?? (await workspace.stat(absolutePath));
  if (!fileStat.exists) {
    return {
      absolutePath,
      exists: false,
      size: undefined,
      mtimeMs: undefined,
      sha256: undefined,
    };
  }

  if (options?.includeHash === false || fileStat.kind !== 'text') {
    return {
      absolutePath,
      exists: true,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      sha256: undefined,
    };
  }

  const buffer = options?.buffer ?? (await workspace.readBuffer(absolutePath));
  return {
    absolutePath,
    exists: true,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}
