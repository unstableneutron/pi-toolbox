import { describe, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPatchSession } from './patch-session';
import { createVirtualWorkspace, PatchPlanFailedError } from './patch';
import { createOverlayWorkspace } from './workspace';

describe('PatchSession', () => {
  test('staging remains strict for mixed success patches', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/a.txt': 'old a\n',
      '/repo/b.txt': 'old b\n',
    });
    const session = createPatchSession('/repo', workspace);

    const patch = `*** Begin Patch
*** Update File: a.txt
@@
-missing
+new a
*** Update File: b.txt
@@
-old b
+new b
*** End Patch`;
    const update = session.update(patch);
    await session.whenIdle();

    expect(update.rows.map((row) => row.path)).toEqual(['a.txt', 'b.txt']);
    await expect(session.finalize(patch)).rejects.toThrow(PatchPlanFailedError);
  });

  test('stages only newly sealed operations on later updates', async () => {
    const workspace = createOverlayWorkspace('/repo', { '/repo/demo.txt': 'alpha\n' });
    const session = createPatchSession('/repo', workspace);

    const first = session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta`);
    const second = session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** Add File: notes.md
+draft`);

    await session.whenIdle();
    const settled = session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** Add File: notes.md
+draft
*** End Patch`);
    await session.whenIdle();
    const restaged = session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** Add File: notes.md
+draft
*** End Patch`);

    expect(first.rows[0]?.state).toBe('streaming');
    expect(second.rows[0]?.state).toBe('staging');
    expect(second.rows[0]?.id).toBe(first.rows[0]?.id);
    expect(second.firstInvalidatedRowIndex).toBeUndefined();
    expect(settled.rows[0]?.state).toBe('staged');
    expect(settled.rows[1]?.state).toBe('staging');
    expect(restaged.rows[1]?.state).toBe('staged');
    expect(restaged.stagedPlan).toBeDefined();
  });

  test('append-only growth keeps stagedPlan populated with sensible mutation counts', async () => {
    const workspace = createOverlayWorkspace('/repo', { '/repo/demo.txt': 'alpha\n' });
    const session = createPatchSession('/repo', workspace);

    session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** End Patch`);
    await session.whenIdle();

    const oneOpSettled = session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** End Patch`);

    expect(oneOpSettled.stagedPlan?.rows).toHaveLength(1);
    expect(oneOpSettled.stagedPlan?.mutations).toHaveLength(1);

    session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** Add File: notes.md
+draft
*** End Patch`);
    await session.whenIdle();

    const twoOpsSettled = session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** Add File: notes.md
+draft
*** End Patch`);

    expect(twoOpsSettled.stagedPlan).toBeDefined();
    expect(twoOpsSettled.stagedPlan?.rows).toHaveLength(2);
    expect(twoOpsSettled.stagedPlan?.mutations).toHaveLength(2);
  });

  test('append-only staged-plan merges keep row ids unique and row refs aligned', async () => {
    const workspace = createOverlayWorkspace('/repo', { '/repo/demo.txt': 'alpha\n' });
    const session = createPatchSession('/repo', workspace);

    session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** End Patch`);
    await session.whenIdle();

    session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** Add File: notes.md
+draft
*** End Patch`);
    await session.whenIdle();

    const settled = session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** Add File: notes.md
+draft
*** End Patch`);

    const stagedPlan = settled.stagedPlan;
    expect(stagedPlan).toBeDefined();
    const rowIds = stagedPlan!.rows.map((row) => row.id);
    expect(new Set(rowIds).size).toBe(rowIds.length);

    for (const mutation of stagedPlan!.mutations) {
      for (const ref of mutation.contributingRows) {
        expect(stagedPlan!.rows[ref.rowIndex]?.id).toBe(ref.id);
      }
    }
  });

  test('append-only updates touching an already-mutated path rebuild to coalesced mutations', async () => {
    const workspace = createOverlayWorkspace('/repo', { '/repo/demo.txt': 'alpha\none\n' });
    const session = createPatchSession('/repo', workspace);

    session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** End Patch`);
    await session.whenIdle();

    session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** Update File: demo.txt
@@
-one
+two
*** End Patch`);
    await session.whenIdle();

    const settled = session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** Update File: demo.txt
@@
-one
+two
*** End Patch`);

    expect(settled.stagedPlan?.rows).toHaveLength(2);
    expect(settled.stagedPlan?.mutations).toHaveLength(1);
    expect(settled.stagedPlan?.mutations[0]?.contributingRows.map((ref) => ref.rowIndex)).toEqual([
      0, 1,
    ]);
  });

  test('restages from the first invalidated op instead of rebuilding the entire prefix', async () => {
    const workspace = createOverlayWorkspace('/repo', { '/repo/demo.txt': 'alpha\n' });
    const session = createPatchSession('/repo', workspace);

    session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** Add File: notes.md
+draft
*** End Patch`);

    await session.whenIdle();

    const next = session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+gamma
*** Add File: notes.md
+draft
*** End Patch`);

    await session.whenIdle();
    const settled = session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+gamma
*** Add File: notes.md
+draft
*** End Patch`);

    expect(next.firstInvalidatedRowIndex).toBe(0);
    expect(next.rows[0]?.state).toBe('invalidated');
    expect(next.rows[1]?.state).toBe('staging');
    expect(settled.rows[0]?.state).toBe('staged');
    expect(settled.rows[1]?.state).toBe('staged');
    expect(settled.stagedPlan).toBeDefined();
  });

  test('removing a previously sealed op keeps stagedPlan rows, mutations, and sourceVersions in sync', async () => {
    const workspace = createOverlayWorkspace('/repo', { '/repo/demo.txt': 'alpha\n' });
    const session = createPatchSession('/repo', workspace);

    session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** Add File: notes.md
+draft
*** End Patch`);
    await session.whenIdle();

    const beforeShrink = session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** Add File: notes.md
+draft
*** End Patch`);

    expect(beforeShrink.stagedPlan?.rows).toHaveLength(2);
    expect(beforeShrink.stagedPlan?.mutations).toHaveLength(2);

    session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** End Patch`);
    await session.whenIdle();

    const afterShrink = session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** End Patch`);

    expect(afterShrink.stagedPlan?.rows).toHaveLength(1);
    expect(afterShrink.stagedPlan?.mutations).toHaveLength(1);
    expect(
      afterShrink.stagedPlan?.mutations[0]?.contributingRows.every((ref) => ref.rowIndex < 1),
    ).toBe(true);
    expect(afterShrink.stagedPlan?.sourceVersions.map((token) => token.absolutePath)).toEqual([
      '/repo/demo.txt',
    ]);
  });

  test('removing the second sealed same-file update rebuilds to one correct coalesced mutation', async () => {
    const workspace = createOverlayWorkspace('/repo', { '/repo/demo.txt': 'alpha\none\n' });
    const session = createPatchSession('/repo', workspace);

    session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** Update File: demo.txt
@@
-one
+two
*** End Patch`);
    await session.whenIdle();

    const beforeShrink = session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** Update File: demo.txt
@@
-one
+two
*** End Patch`);

    expect(beforeShrink.stagedPlan?.rows).toHaveLength(2);
    expect(beforeShrink.stagedPlan?.mutations).toHaveLength(1);
    expect(
      beforeShrink.stagedPlan?.mutations[0]?.contributingRows.map((ref) => ref.rowIndex),
    ).toEqual([0, 1]);

    session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** End Patch`);
    await session.whenIdle();

    const afterShrink = session.update(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** End Patch`);

    expect(afterShrink.stagedPlan?.rows).toHaveLength(1);
    expect(afterShrink.stagedPlan?.mutations).toHaveLength(1);
    expect(
      afterShrink.stagedPlan?.mutations[0]?.contributingRows.map((ref) => ref.rowIndex),
    ).toEqual([0]);
  });

  test('reuses staged plan when versions still match', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'patch-session-finalize-reuse-'));
    const filePath = join(dir, 'demo.txt');
    await writeFile(filePath, 'alpha\n', 'utf8');

    try {
      const patchText = `*** Begin Patch
*** Update File: ${filePath}
@@
-alpha
+beta
*** End Patch`;
      const session = createPatchSession(dir, createVirtualWorkspace(dir));

      session.update(patchText);
      await session.whenIdle();

      const finalized = await session.finalize(patchText);
      expect(finalized.reusedStage).toBe(true);
      expect(finalized.plan.rows).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('queued updates rebuild safely when a newly staged prefix later diverges', async () => {
    const workspace = createOverlayWorkspace('/repo', { '/repo/demo.txt': 'alpha\n' });
    const session = createPatchSession('/repo', workspace);

    const firstPatch = `*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** End Patch`;
    const changedPatch = `*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+gamma
*** Add File: notes.md
+draft
*** End Patch`;

    session.update(firstPatch);
    session.update(changedPatch);
    await session.whenIdle();

    const finalized = await session.finalize(changedPatch);
    const demoMutation = finalized.plan.mutations.find(
      (mutation) => mutation.kind === 'write' && mutation.absolutePath === '/repo/demo.txt',
    );

    expect(demoMutation?.kind).toBe('write');
    if (demoMutation?.kind === 'write') {
      expect(demoMutation.afterText).toBe('gamma\n');
    }
  });

  test('does not reuse when add target appears after staging', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'patch-session-finalize-add-target-'));
    const newFilePath = join(dir, 'new.txt');

    try {
      const patchText = `*** Begin Patch
*** Add File: ${newFilePath}
+hello
*** End Patch`;
      const session = createPatchSession(dir, createVirtualWorkspace(dir));

      session.update(patchText);
      await session.whenIdle();
      await writeFile(newFilePath, 'already here\n', 'utf8');

      await expect(session.finalize(patchText)).rejects.toThrow('file already exists');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
