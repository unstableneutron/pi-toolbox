import {
  applyPatchOperations,
  buildPatchPlan,
  createStreamingPatchParser,
  createRealWorkspace,
  parsePatch,
  type PatchOperation,
  type PatchPreviewRow,
} from './patch';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { verifySourceVersions } from './mutation-plan';
import type { MutationPlan } from './mutation-plan';
import type { OverlayWorkspace } from './workspace';

export interface PatchSessionUpdate {
  rows: PatchPreviewRow[];
  stagedPlan?: MutationPlan<PatchPreviewRow>;
  firstInvalidatedRowIndex?: number;
}

export interface PatchSessionFinalizeResult {
  plan: MutationPlan<PatchPreviewRow>;
  reusedStage: boolean;
  rows: PatchPreviewRow[];
}

interface PatchSession {
  update(patchText: string): PatchSessionUpdate;
  finalize(finalPatchText: string): Promise<PatchSessionFinalizeResult>;
  whenIdle(): Promise<void>;
}

function operationSignature(operation: PatchOperation): string {
  if (operation.kind === 'add') {
    return `add:${operation.path}:${operation.contents}`;
  }
  if (operation.kind === 'delete') {
    return `delete:${operation.path}`;
  }

  return JSON.stringify({
    kind: 'update',
    path: operation.path,
    moveTo: operation.moveTo ?? null,
    chunks: operation.chunks,
  });
}

function findFirstChangedOperationIndex(
  previous: PatchOperation[],
  next: PatchOperation[],
): number | undefined {
  const sharedLength = Math.min(previous.length, next.length);
  for (let index = 0; index < sharedLength; index++) {
    if (operationSignature(previous[index]!) !== operationSignature(next[index]!)) {
      return index;
    }
  }

  if (next.length < previous.length) {
    return next.length;
  }

  return undefined;
}

function mergePatchSessionRows(
  rows: PatchPreviewRow[],
  stagedPrefixCount: number,
  sealedCount: number,
  firstInvalidatedRowIndex: number | undefined,
): PatchPreviewRow[] {
  return rows.map((row, index) => {
    if (index < stagedPrefixCount) {
      return { ...row, state: 'staged' };
    }

    if (index >= sealedCount) {
      return row;
    }

    if (index === firstInvalidatedRowIndex) {
      return { ...row, state: 'invalidated' };
    }

    return { ...row, state: 'staging' };
  });
}

function findStagedPrefixCount(staged: PatchOperation[], next: PatchOperation[]): number {
  const max = Math.min(staged.length, next.length);
  for (let index = 0; index < max; index++) {
    if (operationSignature(staged[index]!) !== operationSignature(next[index]!)) {
      return index;
    }
  }
  return max;
}

function mergeSourceVersions(
  prefix: MutationPlan<PatchPreviewRow>['sourceVersions'],
  delta: MutationPlan<PatchPreviewRow>['sourceVersions'],
): MutationPlan<PatchPreviewRow>['sourceVersions'] {
  const byPath = new Map(prefix.map((token) => [token.absolutePath, token]));
  for (const token of delta) {
    if (!byPath.has(token.absolutePath)) {
      byPath.set(token.absolutePath, token);
    }
  }
  return [...byPath.values()];
}

function offsetPlanRows(
  plan: MutationPlan<PatchPreviewRow>,
  rowOffset: number,
): MutationPlan<PatchPreviewRow> {
  return {
    ...plan,
    mutations: plan.mutations.map((mutation) => ({
      ...mutation,
      contributingRows: mutation.contributingRows.map((ref) => ({
        ...ref,
        rowIndex: ref.rowIndex + rowOffset,
      })),
    })),
  };
}

function mergePlans(
  prefixPlan: MutationPlan<PatchPreviewRow> | undefined,
  deltaPlan: MutationPlan<PatchPreviewRow>,
): MutationPlan<PatchPreviewRow> {
  if (!prefixPlan) {
    return deltaPlan;
  }

  const rowOffset = prefixPlan.rows.length;
  const usedRowIds = new Set(
    prefixPlan.rows.map((row) => row.id).filter((id): id is string => typeof id === 'string'),
  );
  const deltaIdByOriginalRowIndex = new Map<number, string>();
  const adjustedDeltaRows = deltaPlan.rows.map((row, index) => {
    const baseId = row.id ?? `op-${String(rowOffset + index + 1).padStart(4, '0')}`;
    let nextId = baseId;
    let suffix = 2;
    while (usedRowIds.has(nextId)) {
      nextId = `${baseId}~${suffix}`;
      suffix += 1;
    }
    usedRowIds.add(nextId);
    deltaIdByOriginalRowIndex.set(index, nextId);
    return {
      ...row,
      id: nextId,
    };
  });

  const adjustedDeltaMutations = offsetPlanRows(deltaPlan, rowOffset).mutations.map((mutation) => ({
    ...mutation,
    contributingRows: mutation.contributingRows.map((ref) => {
      const originalRowIndex = ref.rowIndex - rowOffset;
      return {
        ...ref,
        id: deltaIdByOriginalRowIndex.get(originalRowIndex) ?? ref.id,
      };
    }),
  }));

  return {
    rows: [...prefixPlan.rows, ...adjustedDeltaRows],
    mutations: [...prefixPlan.mutations, ...adjustedDeltaMutations],
    sourceVersions: mergeSourceVersions(prefixPlan.sourceVersions, deltaPlan.sourceVersions),
    summaryText: `Applied patch with ${prefixPlan.rows.length + adjustedDeltaRows.length} operation(s).`,
  };
}

function resolveOperationPaths(cwd: string, operation: PatchOperation): string[] {
  const resolvePatchPath = (filePath: string) =>
    isAbsolute(filePath) ? resolvePath(filePath) : resolvePath(cwd, filePath);

  if (operation.kind === 'update' && operation.moveTo) {
    return [resolvePatchPath(operation.path), resolvePatchPath(operation.moveTo)];
  }

  return [resolvePatchPath(operation.path)];
}

function mutationTouchedPaths(
  mutation: MutationPlan<PatchPreviewRow>['mutations'][number],
): string[] {
  if (mutation.kind === 'move') {
    return [mutation.sourcePath, mutation.targetPath];
  }
  return [mutation.absolutePath];
}

function hasDeltaPathOverlap(
  cwd: string,
  prefixPlan: MutationPlan<PatchPreviewRow> | undefined,
  deltaOps: PatchOperation[],
): boolean {
  if (!prefixPlan || deltaOps.length === 0) {
    return false;
  }

  const touched = new Set(
    prefixPlan.mutations.flatMap((mutation) => mutationTouchedPaths(mutation)),
  );
  for (const operation of deltaOps) {
    for (const path of resolveOperationPaths(cwd, operation)) {
      if (touched.has(path)) {
        return true;
      }
    }
  }
  return false;
}

export function createPatchSession(cwd: string, workspace: OverlayWorkspace): PatchSession {
  const parser = createStreamingPatchParser();
  let stagedOps: PatchOperation[] = [];
  let stagedPlan: MutationPlan<PatchPreviewRow> | undefined;
  let stagedWorkspace: OverlayWorkspace | undefined;
  let stageQueue: Promise<void> = Promise.resolve();
  let stageSucceeded = true;

  const signatureList = (operations: PatchOperation[]) => operations.map(operationSignature);

  const signaturesMatch = (left: PatchOperation[], right: PatchOperation[]) => {
    const leftSignatures = signatureList(left);
    const rightSignatures = signatureList(right);
    if (leftSignatures.length !== rightSignatures.length) {
      return false;
    }
    for (let index = 0; index < leftSignatures.length; index++) {
      if (leftSignatures[index] !== rightSignatures[index]) {
        return false;
      }
    }
    return true;
  };

  const hasSuspiciousPlanShape = (
    plan: MutationPlan<PatchPreviewRow> | undefined,
    operationCount: number,
  ) => {
    if (!plan) {
      return true;
    }
    if (plan.rows.length !== operationCount) {
      return true;
    }
    if (operationCount > 0 && plan.mutations.length === 0) {
      return true;
    }

    const rowIds = new Set<string>();
    for (const row of plan.rows) {
      if (!row.id) {
        return true;
      }
      if (rowIds.has(row.id)) {
        return true;
      }
      rowIds.add(row.id);
    }

    for (const mutation of plan.mutations) {
      if (mutation.contributingRows.length === 0) {
        return true;
      }
      for (const ref of mutation.contributingRows) {
        if (ref.rowIndex < 0 || ref.rowIndex >= plan.rows.length) {
          return true;
        }
        const rowId = plan.rows[ref.rowIndex]?.id;
        if (!rowId || rowId !== ref.id) {
          return true;
        }
      }
    }

    return false;
  };

  const rebuildPlan = async (operations: PatchOperation[]) => {
    const virtualWorkspace = workspace.fork();
    const snapshotWorkspace = createRealWorkspace();
    return buildPatchPlan(operations, virtualWorkspace, cwd, snapshotWorkspace);
  };

  return {
    update(patchText: string): PatchSessionUpdate {
      const streaming = parser.update(patchText);
      const nextSealed = streaming.sealedOperations;
      const firstInvalidatedRowIndex = findFirstChangedOperationIndex(stagedOps, nextSealed);
      const stagedPrefixCount = findStagedPrefixCount(stagedOps, nextSealed);
      const rows = mergePatchSessionRows(
        streaming.operations,
        stagedPrefixCount,
        nextSealed.length,
        firstInvalidatedRowIndex,
      );

      const hasChanged =
        nextSealed.length !== stagedOps.length || firstInvalidatedRowIndex !== undefined;
      if (nextSealed.length > 0 && hasChanged) {
        const nextSnapshot = nextSealed.map((operation) => ({ ...operation }));
        stageQueue = stageQueue
          .catch(() => undefined)
          .then(async () => {
            stageSucceeded = true;
            const firstInvalidatedAgainstCurrent = findFirstChangedOperationIndex(
              stagedOps,
              nextSnapshot,
            );
            const appendOnly =
              firstInvalidatedAgainstCurrent === undefined &&
              nextSnapshot.length >= stagedOps.length;

            if (appendOnly && stagedOps.length > 0 && stagedPlan) {
              const deltaOps = nextSnapshot.slice(stagedOps.length);
              if (deltaOps.length === 0) {
                return;
              }

              if (hasDeltaPathOverlap(cwd, stagedPlan, deltaOps)) {
                const rebuiltWorkspace = workspace.fork();
                const snapshotWorkspace = createRealWorkspace();
                const rebuiltPlan = await buildPatchPlan(
                  nextSnapshot,
                  rebuiltWorkspace,
                  cwd,
                  snapshotWorkspace,
                );
                await applyPatchOperations(nextSnapshot, rebuiltWorkspace, cwd, undefined, {
                  collectDiff: false,
                });
                stagedPlan = rebuiltPlan;
                stagedOps = nextSnapshot;
                stagedWorkspace = rebuiltWorkspace;
                return;
              }

              const baseWorkspace = stagedWorkspace?.fork() ?? workspace.fork();
              const snapshotWorkspace = createRealWorkspace();
              if (!stagedWorkspace) {
                await applyPatchOperations(stagedOps, baseWorkspace, cwd, undefined, {
                  collectDiff: false,
                });
              }
              const deltaPlan = await buildPatchPlan(
                deltaOps,
                baseWorkspace,
                cwd,
                snapshotWorkspace,
              );
              await applyPatchOperations(deltaOps, baseWorkspace, cwd, undefined, {
                collectDiff: false,
              });

              stagedPlan = mergePlans(stagedPlan, deltaPlan);
              stagedOps = nextSnapshot;
              stagedWorkspace = baseWorkspace;
              return;
            }

            const baseWorkspace = workspace.fork();
            const snapshotWorkspace = createRealWorkspace();
            if (nextSnapshot.length === 0) {
              stagedOps = nextSnapshot;
              stagedWorkspace = baseWorkspace;
              stagedPlan = undefined;
              return;
            }

            const rebuiltPlan = await buildPatchPlan(
              nextSnapshot,
              baseWorkspace,
              cwd,
              snapshotWorkspace,
            );
            await applyPatchOperations(nextSnapshot, baseWorkspace, cwd, undefined, {
              collectDiff: false,
            });
            stagedPlan = rebuiltPlan;
            stagedOps = nextSnapshot;
            stagedWorkspace = baseWorkspace;
          })
          .catch(() => {
            stageSucceeded = false;
          });
      }

      return {
        rows,
        stagedPlan,
        firstInvalidatedRowIndex,
      };
    },
    async finalize(finalPatchText: string): Promise<PatchSessionFinalizeResult> {
      const finalOps = parsePatch(finalPatchText);
      await stageQueue;

      const stageCanBeReused =
        stageSucceeded &&
        signaturesMatch(stagedOps, finalOps) &&
        !hasSuspiciousPlanShape(stagedPlan, finalOps.length);

      if (stageCanBeReused && stagedPlan) {
        const mismatches = await verifySourceVersions(
          createRealWorkspace(),
          stagedPlan.sourceVersions,
          { mode: 'metadata' },
        );
        if (mismatches.length === 0) {
          return {
            plan: stagedPlan,
            reusedStage: true,
            rows: stagedPlan.rows,
          };
        }
      }

      const rebuiltPlan = await rebuildPlan(finalOps);
      return {
        plan: rebuiltPlan,
        reusedStage: false,
        rows: rebuiltPlan.rows,
      };
    },
    async whenIdle() {
      await stageQueue;
    },
  };
}
