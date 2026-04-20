import { createHash } from 'node:crypto';

import { generateDiffString } from './classic';
import { buildFileVersionToken, type FileVersionToken, type Workspace } from './workspace';

export { buildFileVersionToken } from './workspace';

export interface PatchRowRef {
  id: string;
  rowIndex: number;
}

export interface FileSnapshot {
  absolutePath: string;
  displayPath: string;
  version: FileVersionToken;
  text: string | null;
}

export type PlannedFileMutation =
  | {
      kind: 'write';
      absolutePath: string;
      displayPath: string;
      before: FileSnapshot;
      afterText: string;
      contributingRows: PatchRowRef[];
    }
  | {
      kind: 'delete';
      absolutePath: string;
      displayPath: string;
      before: FileSnapshot;
      contributingRows: PatchRowRef[];
    }
  | {
      kind: 'move';
      absolutePath: string;
      displayPath: string;
      sourcePath: string;
      targetPath: string;
      source: FileSnapshot;
      target: FileSnapshot;
      replaceTargetBeforeMove?: boolean;
      afterText: string;
      contributingRows: PatchRowRef[];
    };

export interface MutationPlan<Row> {
  rows: Row[];
  mutations: PlannedFileMutation[];
  sourceVersions: FileVersionToken[];
  summaryText?: string;
}

export interface MutationCommitFailure<Row> {
  index: number;
  row: Row | undefined;
  error: string;
  appliedRows: Row[];
  notRunRows: Row[];
  rollbackAttempted: boolean;
  rollbackSucceeded: boolean;
}

export interface MutationCommitResult<Row> {
  ok: boolean;
  rows: Row[];
  diff?: string;
  diffInputs?: Array<{
    displayPath: string;
    beforeText: string;
    afterText: string;
  }>;
  firstChangedLine?: number;
  summaryText?: string;
  failure?: MutationCommitFailure<Row>;
}

interface CommitMutationPlanOptions {
  rollbackOnFailure?: boolean;
  includeDiff?: boolean;
  signal?: AbortSignal;
}

interface RollbackSnapshot {
  absolutePath: string;
  text: string | null;
}

class MutationApplyError extends Error {
  readonly rollbackJournal: RollbackSnapshot[];
  readonly causeError: unknown;

  constructor(causeError: unknown, rollbackJournal: RollbackSnapshot[]) {
    super(causeError instanceof Error ? causeError.message : String(causeError));
    this.name = 'MutationApplyError';
    this.rollbackJournal = rollbackJournal;
    this.causeError = causeError;
  }
}

export interface SourceVersionMismatch {
  expected: FileVersionToken;
  current: FileVersionToken;
  error: string;
}

export function buildFileVersionTokenFromTextSnapshot(
  absolutePath: string,
  text: string,
  mtimeMs: number | undefined,
): FileVersionToken {
  return {
    absolutePath,
    exists: true,
    size: Buffer.byteLength(text, 'utf8'),
    mtimeMs,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}

export async function verifySourceVersions(
  workspace: Workspace,
  sourceVersions: FileVersionToken[],
  options?: { mode?: 'metadata' | 'full' },
): Promise<SourceVersionMismatch[]> {
  const mismatches: SourceVersionMismatch[] = [];
  for (const token of sourceVersions) {
    const current = await buildFileVersionToken(workspace, token.absolutePath, {
      includeHash: options?.mode === 'full',
    });
    if (
      current.exists !== token.exists ||
      current.size !== token.size ||
      current.mtimeMs !== token.mtimeMs ||
      (options?.mode === 'full' && current.sha256 !== token.sha256)
    ) {
      mismatches.push({
        expected: token,
        current,
        error: `Source file changed before commit: ${token.absolutePath}`,
      });
    }
  }
  return mismatches;
}

function isVersionMatch(expected: FileVersionToken, current: FileVersionToken): boolean {
  return (
    current.exists === expected.exists &&
    current.size === expected.size &&
    current.mtimeMs === expected.mtimeMs &&
    current.sha256 === expected.sha256
  );
}

async function assertSnapshotMatches(
  workspace: Workspace,
  version: FileVersionToken,
  displayPath: string,
  operation: 'write' | 'delete' | 'move',
): Promise<void> {
  const current = await buildFileVersionToken(workspace, version.absolutePath, {
    includeHash: version.sha256 !== undefined,
  });
  if (isVersionMatch(version, current)) {
    return;
  }

  if (!version.exists && current.exists) {
    throw new Error(`Failed to ${operation} ${displayPath}: expected file to be absent`);
  }

  throw new Error(`Failed to ${operation} ${displayPath}: source changed before apply`);
}

function mutationTouchesPath(mutation: PlannedFileMutation, absolutePath: string): boolean {
  if (mutation.kind === 'move') {
    return mutation.sourcePath === absolutePath || mutation.targetPath === absolutePath;
  }
  return mutation.absolutePath === absolutePath;
}

function rowsFromRefs<Row>(allRows: Row[], refs: PatchRowRef[]): Row[] {
  const seen = new Set<number>();
  const ordered = [...refs].sort((a, b) => a.rowIndex - b.rowIndex);
  const mapped: Row[] = [];
  for (const ref of ordered) {
    if (seen.has(ref.rowIndex)) {
      continue;
    }
    seen.add(ref.rowIndex);
    const row = allRows[ref.rowIndex];
    if (row !== undefined) {
      mapped.push(row);
    }
  }
  return mapped;
}

function rollbackTextForPath(mutation: PlannedFileMutation, absolutePath: string): string | null {
  if (mutation.kind === 'write' || mutation.kind === 'delete') {
    return mutation.before.text;
  }

  if (absolutePath === mutation.sourcePath) {
    return mutation.source.text;
  }

  if (absolutePath === mutation.targetPath) {
    return mutation.target.text;
  }

  throw new Error(`Unexpected rollback path: ${absolutePath}`);
}

async function applyMutation(
  workspace: Workspace,
  mutation: PlannedFileMutation,
): Promise<RollbackSnapshot[]> {
  const rollbackJournal: RollbackSnapshot[] = [];
  const recordStep = (paths: string[]) => {
    for (const absolutePath of paths) {
      rollbackJournal.push({
        absolutePath,
        text: rollbackTextForPath(mutation, absolutePath),
      });
    }
  };

  const runStep = async (paths: string[], operation: () => Promise<void>) => {
    await operation();
    recordStep(paths);
  };

  try {
    if (mutation.kind === 'write') {
      await runStep([mutation.absolutePath], () =>
        workspace.writeTextAtomic(mutation.absolutePath, mutation.afterText, {
          noReplace: !mutation.before.version.exists,
        }),
      );
      return rollbackJournal;
    }

    if (mutation.kind === 'delete') {
      await runStep([mutation.absolutePath], () => workspace.deleteFile(mutation.absolutePath));
      return rollbackJournal;
    }

    if (mutation.afterText === mutation.source.text) {
      if (mutation.replaceTargetBeforeMove && mutation.target.version.exists) {
        await runStep([mutation.targetPath], () => workspace.deleteFile(mutation.targetPath));
        await runStep([mutation.sourcePath, mutation.targetPath], () =>
          workspace.renameAtomic(mutation.sourcePath, mutation.targetPath, {
            noReplace: true,
          }),
        );
        return rollbackJournal;
      }

      await runStep([mutation.sourcePath, mutation.targetPath], () =>
        workspace.renameAtomic(mutation.sourcePath, mutation.targetPath, {
          noReplace: !mutation.target.version.exists,
        }),
      );
      return rollbackJournal;
    }

    await runStep([mutation.targetPath], () =>
      workspace.writeTextAtomic(mutation.targetPath, mutation.afterText, {
        noReplace: !mutation.target.version.exists,
      }),
    );
    await runStep([mutation.sourcePath], () => workspace.deleteFile(mutation.sourcePath));
    return rollbackJournal;
  } catch (error) {
    throw new MutationApplyError(error, rollbackJournal);
  }
}

async function validateMutationPreconditions(
  workspace: Workspace,
  mutation: PlannedFileMutation,
): Promise<void> {
  if (mutation.kind === 'write') {
    await assertSnapshotMatches(workspace, mutation.before.version, mutation.displayPath, 'write');
    return;
  }

  if (mutation.kind === 'delete') {
    await assertSnapshotMatches(workspace, mutation.before.version, mutation.displayPath, 'delete');
    return;
  }

  await assertSnapshotMatches(workspace, mutation.source.version, mutation.displayPath, 'move');
  await assertSnapshotMatches(workspace, mutation.target.version, mutation.displayPath, 'move');
}

function mutationDiff(mutation: PlannedFileMutation): { diff: string; firstChangedLine?: number } {
  if (mutation.kind === 'write') {
    return generateDiffString(mutation.before.text ?? '', mutation.afterText);
  }

  if (mutation.kind === 'delete') {
    return generateDiffString(mutation.before.text ?? '', '');
  }

  return generateDiffString(mutation.source.text ?? '', mutation.afterText);
}

function mutationDiffInput(mutation: PlannedFileMutation): {
  displayPath: string;
  beforeText: string;
  afterText: string;
} {
  if (mutation.kind === 'write') {
    return {
      displayPath: mutation.displayPath,
      beforeText: mutation.before.text ?? '',
      afterText: mutation.afterText,
    };
  }

  if (mutation.kind === 'delete') {
    return {
      displayPath: mutation.displayPath,
      beforeText: mutation.before.text ?? '',
      afterText: '',
    };
  }

  return {
    displayPath: mutation.displayPath,
    beforeText: mutation.source.text ?? '',
    afterText: mutation.afterText,
  };
}

function findFirstChangedLine(beforeText: string, afterText: string): number | undefined {
  const beforeLines = beforeText.split('\n');
  const afterLines = afterText.split('\n');
  const shared = Math.min(beforeLines.length, afterLines.length);
  let index = 0;
  while (index < shared && beforeLines[index] === afterLines[index]) {
    index += 1;
  }

  return index === beforeLines.length && index === afterLines.length ? undefined : index + 1;
}

function buildNotRunRows<Row>(
  plan: MutationPlan<Row>,
  failedMutationIndex: number,
  includeFailedMutation = true,
): Row[] {
  const refs: PatchRowRef[] = [];
  const start = includeFailedMutation ? failedMutationIndex : failedMutationIndex + 1;
  for (let i = Math.max(0, start); i < plan.mutations.length; i++) {
    refs.push(...plan.mutations[i]!.contributingRows);
  }
  return rowsFromRefs(plan.rows, refs);
}

export async function commitMutationPlan<Row>(
  plan: MutationPlan<Row>,
  workspace: Workspace,
  options: CommitMutationPlanOptions = {},
): Promise<MutationCommitResult<Row>> {
  if (options.signal?.aborted) {
    throw new Error('Operation aborted');
  }

  const mismatches = await verifySourceVersions(workspace, plan.sourceVersions, {
    mode: 'metadata',
  });
  if (mismatches.length > 0) {
    const affectedMutationIndexes = new Set<number>();
    for (const mismatch of mismatches) {
      for (let i = 0; i < plan.mutations.length; i++) {
        if (mutationTouchesPath(plan.mutations[i]!, mismatch.expected.absolutePath)) {
          affectedMutationIndexes.add(i);
        }
      }
    }

    const orderedIndexes = [...affectedMutationIndexes].sort((a, b) => a - b);
    const failedIndex = orderedIndexes[0] ?? 0;
    const failedRefs = orderedIndexes.flatMap((index) => plan.mutations[index]!.contributingRows);
    const failedRows = rowsFromRefs(plan.rows, failedRefs);
    const mismatchError =
      mismatches.length === 1
        ? mismatches[0]!.error
        : `Source files changed before commit: ${mismatches
            .map((mismatch) => mismatch.expected.absolutePath)
            .join(', ')}`;

    return {
      ok: false,
      rows: plan.rows,
      summaryText: plan.summaryText,
      failure: {
        index: failedIndex,
        row: failedRows[0],
        error: mismatchError,
        appliedRows: [],
        notRunRows: failedRows.length > 0 ? failedRows : buildNotRunRows(plan, failedIndex, true),
        rollbackAttempted: false,
        rollbackSucceeded: false,
      },
    };
  }

  const rollbackStack: RollbackSnapshot[][] = [];
  const appliedRefs: PatchRowRef[] = [];
  const diffSegments: string[] = [];
  const diffInputs: NonNullable<MutationCommitResult<Row>['diffInputs']> = [];
  let firstChangedLine: number | undefined;

  for (let i = 0; i < plan.mutations.length; i++) {
    if (options.signal?.aborted) {
      throw new Error('Operation aborted');
    }

    const mutation = plan.mutations[i]!;

    try {
      await validateMutationPreconditions(workspace, mutation);
      const rollbackJournal = await applyMutation(workspace, mutation);
      rollbackStack.push(rollbackJournal);
      appliedRefs.push(...mutation.contributingRows);

      const nextDiffInput = mutationDiffInput(mutation);
      if (options.includeDiff !== false) {
        const nextDiff = mutationDiff(mutation);
        if (nextDiff.diff) {
          diffSegments.push(`File: ${mutation.displayPath}\n${nextDiff.diff}`);
        }
        if (firstChangedLine === undefined && nextDiff.firstChangedLine !== undefined) {
          firstChangedLine = nextDiff.firstChangedLine;
        }
      } else {
        diffInputs.push(nextDiffInput);
        if (firstChangedLine === undefined) {
          firstChangedLine = findFirstChangedLine(
            nextDiffInput.beforeText,
            nextDiffInput.afterText,
          );
        }
      }
    } catch (error) {
      if (error instanceof MutationApplyError && error.rollbackJournal.length > 0) {
        rollbackStack.push(error.rollbackJournal);
      }

      let rollbackAttempted = false;
      let rollbackSucceeded = false;

      if (options.rollbackOnFailure) {
        rollbackAttempted = true;
        rollbackSucceeded = true;
        for (let r = rollbackStack.length - 1; r >= 0; r--) {
          const snapshots = rollbackStack[r]!;
          for (let s = snapshots.length - 1; s >= 0; s--) {
            const snapshot = snapshots[s]!;
            try {
              if (snapshot.text === null) {
                await workspace.deleteFile(snapshot.absolutePath);
              } else {
                await workspace.writeTextAtomic(snapshot.absolutePath, snapshot.text);
              }
            } catch {
              rollbackSucceeded = false;
            }
          }
        }
      }

      const failedRows = rowsFromRefs(plan.rows, mutation.contributingRows);
      return {
        ok: false,
        rows: plan.rows,
        summaryText: plan.summaryText,
        failure: {
          index: i,
          row: failedRows[0],
          error:
            error instanceof MutationApplyError
              ? error.causeError instanceof Error
                ? error.causeError.message
                : String(error.causeError)
              : error instanceof Error
                ? error.message
                : String(error),
          appliedRows: rowsFromRefs(plan.rows, appliedRefs),
          notRunRows: buildNotRunRows(plan, i, true),
          rollbackAttempted,
          rollbackSucceeded,
        },
      };
    }
  }

  return {
    ok: true,
    rows: plan.rows,
    diff: options.includeDiff === false ? undefined : diffSegments.join('\n\n'),
    diffInputs: options.includeDiff === false ? diffInputs : undefined,
    firstChangedLine,
    summaryText: plan.summaryText,
  };
}
