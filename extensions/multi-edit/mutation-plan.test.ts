import { describe, expect, test } from 'vitest';

import { createOverlayWorkspace, type Workspace } from './workspace';
import {
  buildFileVersionToken,
  commitMutationPlan,
  type MutationPlan,
  type PlannedFileMutation,
} from './mutation-plan';

type TestRow = { id: string; state: string };

function asFailingWorkspace(workspace: Workspace, failPath: string): Workspace {
  let failed = false;
  return {
    ...workspace,
    async writeTextAtomic(
      absolutePath: string,
      content: string,
      options?: { noReplace?: boolean },
    ): Promise<void> {
      if (!failed && absolutePath === failPath) {
        failed = true;
        throw new Error(`Synthetic write failure for ${absolutePath}`);
      }
      await workspace.writeTextAtomic(absolutePath, content, options);
    },
  };
}

function asDeleteFailingWorkspace(workspace: Workspace, failPath: string): Workspace {
  return {
    ...workspace,
    async deleteFile(absolutePath: string): Promise<void> {
      if (absolutePath === failPath) {
        throw new Error(`Synthetic delete failure for ${absolutePath}`);
      }
      await workspace.deleteFile(absolutePath);
    },
  };
}

describe('commitMutationPlan', () => {
  test('writes a prepared mutation and generates a unified diff', async () => {
    const workspace = createOverlayWorkspace('/repo', {
      '/repo/demo.txt': 'alpha\n',
    });
    const before = await buildFileVersionToken(workspace, '/repo/demo.txt');
    const plan: MutationPlan<TestRow> = {
      rows: [{ id: 'op-0001', state: 'streamed' }],
      sourceVersions: [before],
      mutations: [
        {
          kind: 'write',
          absolutePath: '/repo/demo.txt',
          displayPath: 'demo.txt',
          before: {
            absolutePath: '/repo/demo.txt',
            displayPath: 'demo.txt',
            version: before,
            text: 'alpha\n',
          },
          afterText: 'beta\n',
          contributingRows: [{ id: 'op-0001', rowIndex: 0 }],
        },
      ],
    };

    const result = await commitMutationPlan(plan, workspace, { rollbackOnFailure: true });

    expect(result.ok).toBe(true);
    expect(result.diff).toContain('@@ -1 +1 @@');
    expect(result.diff).toContain('-alpha');
    expect(result.diff).toContain('+beta');
  });

  test('rejects obvious metadata mismatches without reading file contents up front', async () => {
    let readBufferCalls = 0;
    const workspace: Workspace = {
      async readText() {
        throw new Error('readText should not be called');
      },
      async readBuffer() {
        readBufferCalls += 1;
        throw new Error('readBuffer should not be called');
      },
      async stat(absolutePath: string) {
        return {
          absolutePath,
          exists: true,
          size: 6,
          mtimeMs: 2,
          kind: 'text' as const,
        };
      },
      async exists() {
        return true;
      },
      async checkWriteAccess() {},
      async writeText() {},
      async writeTextAtomic() {},
      async deleteFile() {},
      async renameAtomic() {},
    };
    const plan: MutationPlan<TestRow> = {
      rows: [{ id: 'op-0001', state: 'streamed' }],
      sourceVersions: [
        {
          absolutePath: '/repo/demo.txt',
          exists: true,
          size: 6,
          mtimeMs: 1,
          sha256: 'stale',
        },
      ],
      mutations: [
        {
          kind: 'write',
          absolutePath: '/repo/demo.txt',
          displayPath: 'demo.txt',
          before: {
            absolutePath: '/repo/demo.txt',
            displayPath: 'demo.txt',
            version: {
              absolutePath: '/repo/demo.txt',
              exists: true,
              size: 6,
              mtimeMs: 1,
              sha256: 'stale',
            },
            text: 'alpha\n',
          },
          afterText: 'beta\n',
          contributingRows: [{ id: 'op-0001', rowIndex: 0 }],
        },
      ],
    };

    const result = await commitMutationPlan(plan, workspace, { rollbackOnFailure: true });

    expect(result.ok).toBe(false);
    expect(result.failure?.error).toContain('Source file changed before commit');
    expect(readBufferCalls).toBe(0);
  });

  test('maps a stale source-version mismatch to the affected later row', async () => {
    const workspace = createOverlayWorkspace('/repo', {
      '/repo/a.txt': 'alpha\n',
      '/repo/b.txt': 'bravo\n',
    });
    const beforeA = await buildFileVersionToken(workspace, '/repo/a.txt');
    const beforeB = await buildFileVersionToken(workspace, '/repo/b.txt');
    const plan: MutationPlan<TestRow> = {
      rows: [
        { id: 'op-0001', state: 'streamed' },
        { id: 'op-0002', state: 'streamed' },
      ],
      sourceVersions: [beforeA, beforeB],
      mutations: [
        {
          kind: 'write',
          absolutePath: '/repo/a.txt',
          displayPath: 'a.txt',
          before: {
            absolutePath: '/repo/a.txt',
            displayPath: 'a.txt',
            version: beforeA,
            text: 'alpha\n',
          },
          afterText: 'ALPHA\n',
          contributingRows: [{ id: 'op-0001', rowIndex: 0 }],
        },
        {
          kind: 'write',
          absolutePath: '/repo/b.txt',
          displayPath: 'b.txt',
          before: {
            absolutePath: '/repo/b.txt',
            displayPath: 'b.txt',
            version: beforeB,
            text: 'bravo\n',
          },
          afterText: 'BRAVO\n',
          contributingRows: [{ id: 'op-0002', rowIndex: 1 }],
        },
      ],
    };

    await workspace.writeText('/repo/b.txt', 'external\n');
    const result = await commitMutationPlan(plan, workspace, { rollbackOnFailure: true });

    expect(result.ok).toBe(false);
    expect(result.failure?.index).toBe(1);
    expect(result.failure?.row?.id).toBe('op-0002');
    expect(result.failure?.notRunRows.map((row) => row.id)).toEqual(['op-0002']);
  });

  test('maps a failed coalesced mutation back to all contributing rows', async () => {
    const workspace = createOverlayWorkspace('/repo', {
      '/repo/demo.txt': 'alpha\n',
    });
    const before = await buildFileVersionToken(workspace, '/repo/demo.txt');
    const plan: MutationPlan<TestRow> = {
      rows: [
        { id: 'op-0001', state: 'streamed' },
        { id: 'op-0002', state: 'streamed' },
      ],
      sourceVersions: [before],
      mutations: [
        {
          kind: 'write',
          absolutePath: '/repo/demo.txt',
          displayPath: 'demo.txt',
          before: {
            absolutePath: '/repo/demo.txt',
            displayPath: 'demo.txt',
            version: before,
            text: 'alpha\n',
          },
          afterText: 'gamma\n',
          contributingRows: [
            { id: 'op-0001', rowIndex: 0 },
            { id: 'op-0002', rowIndex: 1 },
          ],
        },
      ],
    };

    await workspace.writeText('/repo/demo.txt', 'external\n');
    const result = await commitMutationPlan(plan, workspace, { rollbackOnFailure: true });

    expect(result.ok).toBe(false);
    expect(result.failure?.notRunRows).toHaveLength(2);
  });

  test('rolls back prior writes in reverse order and preserves row mapping', async () => {
    const workspace = createOverlayWorkspace('/repo', {
      '/repo/a.txt': 'alpha\n',
      '/repo/b.txt': 'bravo\n',
    });
    const beforeA = await buildFileVersionToken(workspace, '/repo/a.txt');
    const beforeB = await buildFileVersionToken(workspace, '/repo/b.txt');
    const rows: TestRow[] = [
      { id: 'op-0001', state: 'streamed' },
      { id: 'op-0002', state: 'streamed' },
    ];
    const plan: MutationPlan<TestRow> = {
      rows,
      sourceVersions: [beforeA, beforeB],
      mutations: [
        {
          kind: 'write',
          absolutePath: '/repo/a.txt',
          displayPath: 'a.txt',
          before: {
            absolutePath: '/repo/a.txt',
            displayPath: 'a.txt',
            version: beforeA,
            text: 'alpha\n',
          },
          afterText: 'ALPHA\n',
          contributingRows: [{ id: 'op-0001', rowIndex: 0 }],
        },
        {
          kind: 'write',
          absolutePath: '/repo/b.txt',
          displayPath: 'b.txt',
          before: {
            absolutePath: '/repo/b.txt',
            displayPath: 'b.txt',
            version: beforeB,
            text: 'bravo\n',
          },
          afterText: 'BRAVO\n',
          contributingRows: [{ id: 'op-0002', rowIndex: 1 }],
        },
      ] satisfies PlannedFileMutation[],
    };

    const failingWorkspace = asFailingWorkspace(workspace, '/repo/b.txt');
    const result = await commitMutationPlan(plan, failingWorkspace, { rollbackOnFailure: true });

    expect(result.ok).toBe(false);
    expect(result.failure?.rollbackAttempted).toBe(true);
    expect(result.failure?.rollbackSucceeded).toBe(true);
    expect(result.failure?.appliedRows.map((row) => row.id)).toEqual(['op-0001']);
    expect(result.failure?.notRunRows.map((row) => row.id)).toEqual(['op-0002']);
    await expect(workspace.readText('/repo/a.txt')).resolves.toBe('alpha\n');
  });

  test('marks rollbackSucceeded false when delete cleanup fails', async () => {
    const workspace = createOverlayWorkspace('/repo', {
      '/repo/b.txt': 'bravo\n',
    });
    const beforeNew = await buildFileVersionToken(workspace, '/repo/new.txt');
    const beforeB = await buildFileVersionToken(workspace, '/repo/b.txt');
    const rows: TestRow[] = [
      { id: 'op-0001', state: 'streamed' },
      { id: 'op-0002', state: 'streamed' },
    ];
    const plan: MutationPlan<TestRow> = {
      rows,
      sourceVersions: [beforeNew, beforeB],
      mutations: [
        {
          kind: 'write',
          absolutePath: '/repo/new.txt',
          displayPath: 'new.txt',
          before: {
            absolutePath: '/repo/new.txt',
            displayPath: 'new.txt',
            version: beforeNew,
            text: null,
          },
          afterText: 'new\n',
          contributingRows: [{ id: 'op-0001', rowIndex: 0 }],
        },
        {
          kind: 'write',
          absolutePath: '/repo/b.txt',
          displayPath: 'b.txt',
          before: {
            absolutePath: '/repo/b.txt',
            displayPath: 'b.txt',
            version: beforeB,
            text: 'bravo\n',
          },
          afterText: 'BRAVO\n',
          contributingRows: [{ id: 'op-0002', rowIndex: 1 }],
        },
      ],
    };

    const failingWorkspace = asFailingWorkspace(workspace, '/repo/b.txt');
    const rollbackDeleteFailingWorkspace = asDeleteFailingWorkspace(
      failingWorkspace,
      '/repo/new.txt',
    );

    const result = await commitMutationPlan(plan, rollbackDeleteFailingWorkspace, {
      rollbackOnFailure: true,
    });

    expect(result.ok).toBe(false);
    expect(result.failure?.rollbackAttempted).toBe(true);
    expect(result.failure?.rollbackSucceeded).toBe(false);
    await expect(workspace.readText('/repo/new.txt')).resolves.toBe('new\n');
  });

  test('fails add-style writes when an expected-absent target appears before apply', async () => {
    const workspace = createOverlayWorkspace('/repo', {});
    const before = await buildFileVersionToken(workspace, '/repo/new.txt');
    const plan: MutationPlan<TestRow> = {
      rows: [{ id: 'op-0001', state: 'streamed' }],
      sourceVersions: [before],
      mutations: [
        {
          kind: 'write',
          absolutePath: '/repo/new.txt',
          displayPath: 'new.txt',
          before: {
            absolutePath: '/repo/new.txt',
            displayPath: 'new.txt',
            version: before,
            text: null,
          },
          afterText: 'planned\n',
          contributingRows: [{ id: 'op-0001', rowIndex: 0 }],
        },
      ],
    };

    let raced = false;
    const racedWorkspace: Workspace = {
      ...workspace,
      async writeTextAtomic(
        absolutePath: string,
        content: string,
        options?: { noReplace?: boolean },
      ): Promise<void> {
        if (!raced && absolutePath === '/repo/new.txt') {
          raced = true;
          await workspace.writeText('/repo/new.txt', 'intruder\n');
        }
        await workspace.writeTextAtomic(absolutePath, content, options);
      },
    };

    const result = await commitMutationPlan(plan, racedWorkspace, { rollbackOnFailure: false });

    expect(result.ok).toBe(false);
    expect(result.failure?.error).toContain('already exists');
    await expect(workspace.readText('/repo/new.txt')).resolves.toBe('intruder\n');
  });

  test('rollback-on-failure does not delete an external file from add/create race', async () => {
    const workspace = createOverlayWorkspace('/repo', {
      '/repo/a.txt': 'alpha\n',
    });
    const beforeA = await buildFileVersionToken(workspace, '/repo/a.txt');
    const beforeNew = await buildFileVersionToken(workspace, '/repo/new.txt');
    const plan: MutationPlan<TestRow> = {
      rows: [
        { id: 'op-0001', state: 'streamed' },
        { id: 'op-0002', state: 'streamed' },
      ],
      sourceVersions: [beforeA, beforeNew],
      mutations: [
        {
          kind: 'write',
          absolutePath: '/repo/a.txt',
          displayPath: 'a.txt',
          before: {
            absolutePath: '/repo/a.txt',
            displayPath: 'a.txt',
            version: beforeA,
            text: 'alpha\n',
          },
          afterText: 'ALPHA\n',
          contributingRows: [{ id: 'op-0001', rowIndex: 0 }],
        },
        {
          kind: 'write',
          absolutePath: '/repo/new.txt',
          displayPath: 'new.txt',
          before: {
            absolutePath: '/repo/new.txt',
            displayPath: 'new.txt',
            version: beforeNew,
            text: null,
          },
          afterText: 'planned\n',
          contributingRows: [{ id: 'op-0002', rowIndex: 1 }],
        },
      ],
    };

    let raced = false;
    const racedWorkspace: Workspace = {
      ...workspace,
      async writeTextAtomic(
        absolutePath: string,
        content: string,
        options?: { noReplace?: boolean },
      ): Promise<void> {
        if (!raced && absolutePath === '/repo/new.txt') {
          raced = true;
          await workspace.writeText('/repo/new.txt', 'intruder\n');
        }
        await workspace.writeTextAtomic(absolutePath, content, options);
      },
    };

    const result = await commitMutationPlan(plan, racedWorkspace, { rollbackOnFailure: true });

    expect(result.ok).toBe(false);
    expect(result.failure?.rollbackAttempted).toBe(true);
    expect(result.failure?.rollbackSucceeded).toBe(true);
    await expect(workspace.readText('/repo/a.txt')).resolves.toBe('alpha\n');
    await expect(workspace.readText('/repo/new.txt')).resolves.toBe('intruder\n');
  });

  test('rollback-on-failure does not recreate externally deleted file in delete race', async () => {
    const workspace = createOverlayWorkspace('/repo', {
      '/repo/a.txt': 'alpha\n',
      '/repo/doomed.txt': 'doomed\n',
    });
    const beforeA = await buildFileVersionToken(workspace, '/repo/a.txt');
    const beforeDoomed = await buildFileVersionToken(workspace, '/repo/doomed.txt');
    const plan: MutationPlan<TestRow> = {
      rows: [
        { id: 'op-0001', state: 'streamed' },
        { id: 'op-0002', state: 'streamed' },
      ],
      sourceVersions: [beforeA, beforeDoomed],
      mutations: [
        {
          kind: 'write',
          absolutePath: '/repo/a.txt',
          displayPath: 'a.txt',
          before: {
            absolutePath: '/repo/a.txt',
            displayPath: 'a.txt',
            version: beforeA,
            text: 'alpha\n',
          },
          afterText: 'ALPHA\n',
          contributingRows: [{ id: 'op-0001', rowIndex: 0 }],
        },
        {
          kind: 'delete',
          absolutePath: '/repo/doomed.txt',
          displayPath: 'doomed.txt',
          before: {
            absolutePath: '/repo/doomed.txt',
            displayPath: 'doomed.txt',
            version: beforeDoomed,
            text: 'doomed\n',
          },
          contributingRows: [{ id: 'op-0002', rowIndex: 1 }],
        },
      ],
    };

    let raced = false;
    const racedWorkspace: Workspace = {
      ...workspace,
      async deleteFile(absolutePath: string): Promise<void> {
        if (!raced && absolutePath === '/repo/doomed.txt') {
          raced = true;
          await workspace.deleteFile('/repo/doomed.txt');
        }
        await workspace.deleteFile(absolutePath);
      },
    };

    const result = await commitMutationPlan(plan, racedWorkspace, { rollbackOnFailure: true });

    expect(result.ok).toBe(false);
    expect(result.failure?.rollbackAttempted).toBe(true);
    expect(result.failure?.rollbackSucceeded).toBe(true);
    await expect(workspace.readText('/repo/a.txt')).resolves.toBe('alpha\n');
    await expect(workspace.readText('/repo/doomed.txt')).rejects.toThrow('File not found');
  });

  test('fails move renames when expected-absent target appears before apply', async () => {
    const workspace = createOverlayWorkspace('/repo', {
      '/repo/source.txt': 'alpha\n',
    });
    const beforeSource = await buildFileVersionToken(workspace, '/repo/source.txt');
    const beforeTarget = await buildFileVersionToken(workspace, '/repo/target.txt');
    const plan: MutationPlan<TestRow> = {
      rows: [{ id: 'op-0001', state: 'streamed' }],
      sourceVersions: [beforeSource, beforeTarget],
      mutations: [
        {
          kind: 'move',
          absolutePath: '/repo/target.txt',
          displayPath: 'target.txt',
          sourcePath: '/repo/source.txt',
          targetPath: '/repo/target.txt',
          source: {
            absolutePath: '/repo/source.txt',
            displayPath: 'source.txt',
            version: beforeSource,
            text: 'alpha\n',
          },
          target: {
            absolutePath: '/repo/target.txt',
            displayPath: 'target.txt',
            version: beforeTarget,
            text: null,
          },
          afterText: 'alpha\n',
          contributingRows: [{ id: 'op-0001', rowIndex: 0 }],
        },
      ],
    };

    let raced = false;
    const racedWorkspace: Workspace = {
      ...workspace,
      async renameAtomic(
        sourcePath: string,
        targetPath: string,
        options?: { noReplace?: boolean },
      ): Promise<void> {
        if (!raced && targetPath === '/repo/target.txt') {
          raced = true;
          await workspace.writeText('/repo/target.txt', 'intruder\n');
        }
        await workspace.renameAtomic(sourcePath, targetPath, options);
      },
    };

    const result = await commitMutationPlan(plan, racedWorkspace, { rollbackOnFailure: false });

    expect(result.ok).toBe(false);
    expect(result.failure?.error).toContain('already exists');
    await expect(workspace.readText('/repo/source.txt')).resolves.toBe('alpha\n');
    await expect(workspace.readText('/repo/target.txt')).resolves.toBe('intruder\n');
  });

  test('fails a later mutation when file changes between mutation applies', async () => {
    const workspace = createOverlayWorkspace('/repo', {
      '/repo/a.txt': 'alpha\n',
      '/repo/b.txt': 'bravo\n',
    });
    const beforeA = await buildFileVersionToken(workspace, '/repo/a.txt');
    const beforeB = await buildFileVersionToken(workspace, '/repo/b.txt');
    const plan: MutationPlan<TestRow> = {
      rows: [
        { id: 'op-0001', state: 'streamed' },
        { id: 'op-0002', state: 'streamed' },
      ],
      sourceVersions: [beforeA, beforeB],
      mutations: [
        {
          kind: 'write',
          absolutePath: '/repo/a.txt',
          displayPath: 'a.txt',
          before: {
            absolutePath: '/repo/a.txt',
            displayPath: 'a.txt',
            version: beforeA,
            text: 'alpha\n',
          },
          afterText: 'ALPHA\n',
          contributingRows: [{ id: 'op-0001', rowIndex: 0 }],
        },
        {
          kind: 'write',
          absolutePath: '/repo/b.txt',
          displayPath: 'b.txt',
          before: {
            absolutePath: '/repo/b.txt',
            displayPath: 'b.txt',
            version: beforeB,
            text: 'bravo\n',
          },
          afterText: 'BRAVO\n',
          contributingRows: [{ id: 'op-0002', rowIndex: 1 }],
        },
      ],
    };

    let injected = false;
    const racedWorkspace: Workspace = {
      ...workspace,
      async writeTextAtomic(
        absolutePath: string,
        content: string,
        options?: { noReplace?: boolean },
      ): Promise<void> {
        if (!injected && absolutePath === '/repo/a.txt') {
          injected = true;
          await workspace.writeText('/repo/b.txt', 'external\n');
        }
        await workspace.writeTextAtomic(absolutePath, content, options);
      },
    };

    const result = await commitMutationPlan(plan, racedWorkspace, { rollbackOnFailure: false });

    expect(result.ok).toBe(false);
    expect(result.failure?.index).toBe(1);
    expect(result.failure?.error).toContain('source changed before apply');
    await expect(workspace.readText('/repo/a.txt')).resolves.toBe('ALPHA\n');
    await expect(workspace.readText('/repo/b.txt')).resolves.toBe('external\n');
  });

  test('rollback-on-failure preserves external source deletion on partial move failure', async () => {
    const workspace = createOverlayWorkspace('/repo', {
      '/repo/a.txt': 'alpha\n',
      '/repo/source.txt': 'source\n',
    });
    const beforeA = await buildFileVersionToken(workspace, '/repo/a.txt');
    const beforeSource = await buildFileVersionToken(workspace, '/repo/source.txt');
    const beforeTarget = await buildFileVersionToken(workspace, '/repo/target.txt');
    const plan: MutationPlan<TestRow> = {
      rows: [
        { id: 'op-0001', state: 'streamed' },
        { id: 'op-0002', state: 'streamed' },
      ],
      sourceVersions: [beforeA, beforeSource, beforeTarget],
      mutations: [
        {
          kind: 'write',
          absolutePath: '/repo/a.txt',
          displayPath: 'a.txt',
          before: {
            absolutePath: '/repo/a.txt',
            displayPath: 'a.txt',
            version: beforeA,
            text: 'alpha\n',
          },
          afterText: 'ALPHA\n',
          contributingRows: [{ id: 'op-0001', rowIndex: 0 }],
        },
        {
          kind: 'move',
          absolutePath: '/repo/target.txt',
          displayPath: 'target.txt',
          sourcePath: '/repo/source.txt',
          targetPath: '/repo/target.txt',
          source: {
            absolutePath: '/repo/source.txt',
            displayPath: 'source.txt',
            version: beforeSource,
            text: 'source\n',
          },
          target: {
            absolutePath: '/repo/target.txt',
            displayPath: 'target.txt',
            version: beforeTarget,
            text: null,
          },
          afterText: 'changed\n',
          contributingRows: [{ id: 'op-0002', rowIndex: 1 }],
        },
      ],
    };

    let raced = false;
    const racedWorkspace: Workspace = {
      ...workspace,
      async deleteFile(absolutePath: string): Promise<void> {
        if (!raced && absolutePath === '/repo/source.txt') {
          raced = true;
          await workspace.deleteFile('/repo/source.txt');
        }
        await workspace.deleteFile(absolutePath);
      },
    };

    const result = await commitMutationPlan(plan, racedWorkspace, { rollbackOnFailure: true });

    expect(result.ok).toBe(false);
    expect(result.failure?.rollbackAttempted).toBe(true);
    expect(result.failure?.rollbackSucceeded).toBe(true);
    await expect(workspace.readText('/repo/a.txt')).resolves.toBe('alpha\n');
    await expect(workspace.readText('/repo/source.txt')).rejects.toThrow('File not found');
    await expect(workspace.readText('/repo/target.txt')).rejects.toThrow('File not found');
  });

  test('rollback-on-failure preserves an intruding external change detected by preconditions', async () => {
    const workspace = createOverlayWorkspace('/repo', {
      '/repo/a.txt': 'alpha\n',
      '/repo/b.txt': 'bravo\n',
    });
    const beforeA = await buildFileVersionToken(workspace, '/repo/a.txt');
    const beforeB = await buildFileVersionToken(workspace, '/repo/b.txt');
    const plan: MutationPlan<TestRow> = {
      rows: [
        { id: 'op-0001', state: 'streamed' },
        { id: 'op-0002', state: 'streamed' },
      ],
      sourceVersions: [beforeA, beforeB],
      mutations: [
        {
          kind: 'write',
          absolutePath: '/repo/a.txt',
          displayPath: 'a.txt',
          before: {
            absolutePath: '/repo/a.txt',
            displayPath: 'a.txt',
            version: beforeA,
            text: 'alpha\n',
          },
          afterText: 'ALPHA\n',
          contributingRows: [{ id: 'op-0001', rowIndex: 0 }],
        },
        {
          kind: 'write',
          absolutePath: '/repo/b.txt',
          displayPath: 'b.txt',
          before: {
            absolutePath: '/repo/b.txt',
            displayPath: 'b.txt',
            version: beforeB,
            text: 'bravo\n',
          },
          afterText: 'BRAVO\n',
          contributingRows: [{ id: 'op-0002', rowIndex: 1 }],
        },
      ],
    };

    let injected = false;
    const racedWorkspace: Workspace = {
      ...workspace,
      async writeTextAtomic(
        absolutePath: string,
        content: string,
        options?: { noReplace?: boolean },
      ): Promise<void> {
        if (!injected && absolutePath === '/repo/a.txt') {
          injected = true;
          await workspace.writeText('/repo/b.txt', 'intruder\n');
        }
        await workspace.writeTextAtomic(absolutePath, content, options);
      },
    };

    const result = await commitMutationPlan(plan, racedWorkspace, { rollbackOnFailure: true });

    expect(result.ok).toBe(false);
    expect(result.failure?.rollbackAttempted).toBe(true);
    expect(result.failure?.rollbackSucceeded).toBe(true);
    await expect(workspace.readText('/repo/a.txt')).resolves.toBe('alpha\n');
    await expect(workspace.readText('/repo/b.txt')).resolves.toBe('intruder\n');
  });
});
