import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  applyPatchOperations,
  buildPatchPlan,
  createStreamingPatchParser,
  createRealWorkspace,
  createVirtualWorkspace,
  parsePatch,
  parsePatchStreaming,
} from './patch';
import { PatchContextMatchError, PatchPlanFailedError } from './patch';
import { AmbiguousFindReplaceOnceError } from './patch';
import { commitMutationPlan } from './mutation-plan';
import { createOverlayWorkspace } from './workspace';

describe('parsePatch', () => {
  test('parses add, update, and delete operations', () => {
    const operations = parsePatch(`*** Begin Patch
*** Add File: new.txt
+hello
*** Update File: src/app.ts
@@
-foo
+bar
*** Delete File: old.txt
*** End Patch`);

    expect(operations.map((operation) => operation.kind)).toEqual(['add', 'update', 'delete']);
  });

  test('parses move-to update operations, including rename-only patches', () => {
    const operations = parsePatch(`*** Begin Patch
*** Update File: src/app.ts
*** Move to: src/renamed.ts
*** End Patch`);

    expect(operations).toEqual([
      {
        kind: 'update',
        path: 'src/app.ts',
        moveTo: 'src/renamed.ts',
        chunks: [],
      },
    ]);
  });

  test('rejects unified-diff numbered hunk header with actionable error', () => {
    // Caught via cross-provider validation: gpt-5.4 and gemini-2.5-flash
    // both emitted `@@ -1,1 +1,1 @@` (standard unified-diff) on first
    // attempts. The old error said "Failed to find anchor '-1,1 +1,1 @@'"
    // which did not hint that the line numbers are the problem.
    const patch = [
      '*** Begin Patch',
      '*** Update File: demo.txt',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    expect(() => parsePatch(patch)).toThrow(
      /Unified-diff style hunk header not supported.*Line numbers are ignored/s,
    );
  });

  test('rejects bare *** separator with actionable error', () => {
    // Caught via cross-provider validation: gemini-2.5-flash inserted
    // bare `***` lines between Update File blocks (legacy Codex hunk
    // separator). The old error said "Expected update hunk to start
    // with @@ context marker, got: '***'" which did not explain that
    // the `***` itself is the stray line.
    const patch = [
      '*** Begin Patch',
      '*** Update File: demo.txt',
      '@@',
      '-old',
      '+new',
      '***',
      '*** Update File: demo.txt',
      '@@',
      '-foo',
      '+bar',
      '*** End Patch',
    ].join('\n');
    expect(() => parsePatch(patch)).toThrow(
      /Stray '\*\*\*' line inside an Update File block.*Remove the bare '\*\*\*' line/s,
    );
  });

  test('accepts a trailing newline after end patch', () => {
    const operations = parsePatch(`*** Begin Patch
*** Delete File: old.txt
*** End Patch
`);

    expect(operations).toEqual([{ kind: 'delete', path: 'old.txt' }]);
  });
  test('parses multiple @@ anchors for a single update hunk', () => {
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: demo.txt',
        '@@ class Example',
        '@@ def method():',
        '-value = 1',
        '+value = 2',
        '*** End Patch',
      ].join('\n'),
    );

    expect(operations).toEqual([
      {
        kind: 'update',
        path: 'demo.txt',
        chunks: [
          expect.objectContaining({
            changeContext: ['class Example', 'def method():'],
            oldLines: ['value = 1'],
            newLines: ['value = 2'],
          }),
        ],
      },
    ]);
  });
});

describe('parsePatchStreaming', () => {
  test('derives single edit preview metrics from patch text', () => {
    const preview = parsePatchStreaming(`*** Begin Patch
*** Update File: src/foo.ts
@@
-alpha
+beta
+gamma
`).operations;

    expect(preview).toEqual([
      {
        id: expect.any(String),
        kind: 'edit',
        path: 'src/foo.ts',
        addedLines: 2,
        removedLines: 1,
        modifiedBytes: expect.any(Number),
        renameOnly: false,
        state: 'streaming',
      },
    ]);
  });

  test('derives move, create, and delete preview rows from patch text', () => {
    const preview = parsePatchStreaming(`*** Begin Patch
*** Update File: a.txt
*** Move to: b.txt
*** Add File: c.txt
+# Heading
*** Delete File: d.txt`).operations;

    expect(
      preview.map((row) => [row.kind, row.path, 'targetPath' in row ? row.targetPath : undefined]),
    ).toEqual([
      ['move', 'a.txt', 'b.txt'],
      ['create', 'c.txt', undefined],
      ['delete', 'd.txt', undefined],
    ]);
  });

  test('keeps repeated same-file operations separate and ordered', () => {
    const preview = parsePatchStreaming(`*** Begin Patch
*** Update File: src/foo.ts
@@
-alpha
+beta
*** Update File: src/foo.ts
@@
-beta
+gamma
*** End Patch`).operations;

    expect(preview.map((row) => [row.kind, row.path])).toEqual([
      ['edit', 'src/foo.ts'],
      ['edit', 'src/foo.ts'],
    ]);
  });

  test('ignores incomplete trailing streamed input and exposes patchComplete', () => {
    const result = parsePatchStreaming(`*** Begin Patch
*** Update File: src/foo.ts
@@
-alpha
+be`);

    expect(result.patchComplete).toBe(false);
    expect(result.operations[0]?.state).toBe('streaming');
  });

  test('marks a fully streamed patch with trailing newline as complete', () => {
    const result = parsePatchStreaming(`*** Begin Patch
*** Delete File: old.txt
*** End Patch
`);

    expect(result.patchComplete).toBe(true);
    expect(result.operations[0]?.state).toBe('streamed');
  });

  test('keeps an update with an open hunk header visible while streaming', () => {
    const result = parsePatchStreaming(`*** Begin Patch
*** Update File: src/foo.ts
@@
`);

    expect(result.patchComplete).toBe(false);
    expect(result.operations).toEqual([
      {
        id: expect.any(String),
        kind: 'edit',
        path: 'src/foo.ts',
        addedLines: 0,
        removedLines: 0,
        modifiedBytes: 0,
        renameOnly: false,
        state: 'streaming',
      },
    ]);
  });
  test('keeps an update with an open FindReplaceOnce chunk visible while streaming', () => {
    const partials = [
      '*** Begin Patch\n*** Update File: src/foo.ts\n*** FindReplaceOnce:\n',
      '*** Begin Patch\n*** Update File: src/foo.ts\n*** FindReplaceOnce:\n<<<<<<< SEARCH\n',
      '*** Begin Patch\n*** Update File: src/foo.ts\n*** FindReplaceOnce:\n<<<<<<< SEARCH\nold\n',
      '*** Begin Patch\n*** Update File: src/foo.ts\n*** FindReplaceOnce:\n<<<<<<< SEARCH\nold\n======= REPLACE\n',
      '*** Begin Patch\n*** Update File: src/foo.ts\n*** FindReplaceOnce:\n<<<<<<< SEARCH\nold\n======= REPLACE\nnew\n',
    ];

    for (const partial of partials) {
      const result = parsePatchStreaming(partial);
      expect(result.patchComplete).toBe(false);
      expect(result.operations).toEqual([
        {
          id: expect.any(String),
          kind: 'edit',
          path: 'src/foo.ts',
          addedLines: 0,
          removedLines: 0,
          modifiedBytes: 0,
          renameOnly: false,
          state: 'streaming',
        },
      ]);
    }
  });

  test('keeps an update with multiple open @@ anchors visible while streaming', () => {
    const result = parsePatchStreaming(
      ['*** Begin Patch', '*** Update File: src/foo.ts', '@@ class Foo', '@@ def bar():'].join(
        '\n',
      ),
    );

    expect(result.patchComplete).toBe(false);
    expect(result.operations).toEqual([
      {
        id: expect.any(String),
        kind: 'edit',
        path: 'src/foo.ts',
        addedLines: 0,
        removedLines: 0,
        modifiedBytes: 0,
        renameOnly: false,
        state: 'streaming',
      },
    ]);
  });

  test('parsePatchStreaming exposes sealed operations separately from the trailing open op', () => {
    const streaming = parsePatchStreaming(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** Add File: notes.md
+draft`);

    expect(streaming.sealedOperations).toHaveLength(1);
    expect(streaming.operations).toHaveLength(2);
    expect(streaming.operations[0]?.state).toBe('streamed');
    expect(streaming.operations[1]?.state).toBe('streaming');
    expect(streaming.trailingOpenOperation?.path).toBe('notes.md');
  });

  test('parsePatchStreaming preserves stable op ids across incremental updates', () => {
    const first = parsePatchStreaming(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta`);
    const second = parsePatchStreaming(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
*** Add File: notes.md
+draft`);

    expect(first.operations[0]?.id).toBe(second.operations[0]?.id);
  });

  test('parsePatchStreaming keeps update id stable while streamed hunk grows', () => {
    const first = parsePatchStreaming(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta`);
    const second = parsePatchStreaming(`*** Begin Patch
*** Update File: demo.txt
@@
-alpha
+beta
+gamma`);

    expect(first.operations[0]?.id).toBe(second.operations[0]?.id);
  });

  test('incremental streaming parser matches full parsing across append-only growth', () => {
    const parser = createStreamingPatchParser();
    const snapshots = [
      ['*** Begin Patch', '*** Update File: demo.txt', '@@', '-alpha'].join('\n'),
      [
        '*** Begin Patch',
        '*** Update File: demo.txt',
        '@@',
        '-alpha',
        '+beta',
        '*** Add File: notes.md',
        '+draft',
      ].join('\n'),
      [
        '*** Begin Patch',
        '*** Update File: demo.txt',
        '@@',
        '-alpha',
        '+beta',
        '*** Add File: notes.md',
        '+draft',
        '*** End Patch',
      ].join('\n'),
    ];

    for (const patchText of snapshots) {
      expect(parser.update(patchText)).toEqual(parsePatchStreaming(patchText));
    }
  });
});

describe('applyPatchOperations', () => {
  test('applies patch updates in a virtual workspace', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/src/app.ts': 'foo\r\n',
    });
    const operations = parsePatch(`*** Begin Patch
*** Update File: src/app.ts
@@
-foo
+bar
*** End Patch`);

    const results = await applyPatchOperations(operations, workspace, '/repo', undefined, {
      collectDiff: true,
    });

    expect(results[0]).toMatchObject({ path: 'src/app.ts', message: 'Updated src/app.ts.' });
    expect(await workspace.readText('/repo/src/app.ts')).toBe('bar\r\n');
  });
  test('applies stacked @@ anchors by narrowing to the intended repeated block', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/demo.py': [
        'class Example',
        'def method():',
        'value = 1',
        '',
        'class Other',
        'def method():',
        'value = 1',
      ].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: demo.py',
        '@@ class Other',
        '@@ def method():',
        '-value = 1',
        '+value = 2',
        '*** End Patch',
      ].join('\n'),
    );

    await applyPatchOperations(operations, workspace, '/repo');

    await expect(workspace.readText('/repo/demo.py')).resolves.toBe(
      [
        'class Example',
        'def method():',
        'value = 1',
        '',
        'class Other',
        'def method():',
        'value = 2',
      ].join('\n'),
    );
  });

  test('updates existing disk files with an unseeded virtual workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-edit-virtual-fs-'));
    try {
      const filePath = join(dir, 'src', 'app.ts');
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(filePath, 'foo\n', 'utf8');
      const workspace = createVirtualWorkspace(dir);
      const operations = parsePatch(`*** Begin Patch
*** Update File: src/app.ts
@@
-foo
+bar
*** End Patch`);

      await expect(applyPatchOperations(operations, workspace, dir)).resolves.toHaveLength(1);
      await expect(workspace.readText(filePath)).resolves.toBe('bar\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('moves files without changing contents', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/src/app.ts': 'foo\r\n',
    });
    const operations = parsePatch(`*** Begin Patch
*** Update File: src/app.ts
*** Move to: src/renamed.ts
*** End Patch`);

    const results = await applyPatchOperations(operations, workspace, '/repo', undefined, {
      collectDiff: true,
    });

    expect(results[0]).toMatchObject({
      path: 'src/renamed.ts',
      message: 'Moved src/app.ts to src/renamed.ts.',
    });
    await expect(workspace.readText('/repo/src/app.ts')).rejects.toThrow('File not found');
    expect(await workspace.readText('/repo/src/renamed.ts')).toBe('foo\r\n');
  });

  test('moves files and applies update chunks before writing target', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/src/app.ts': 'foo\n',
    });
    const operations = parsePatch(`*** Begin Patch
*** Update File: src/app.ts
*** Move to: src/renamed.ts
@@
-foo
+bar
*** End Patch`);

    const results = await applyPatchOperations(operations, workspace, '/repo', undefined, {
      collectDiff: true,
    });

    expect(results[0]).toMatchObject({
      path: 'src/renamed.ts',
      message: 'Moved src/app.ts to src/renamed.ts and updated contents.',
    });
    await expect(workspace.readText('/repo/src/app.ts')).rejects.toThrow('File not found');
    expect(await workspace.readText('/repo/src/renamed.ts')).toBe('bar\n');
  });

  test('insert-only update hunk applies at current context instead of EOF', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/src/app.ts': 'alpha\nmarker\nomega\n',
    });
    const operations = parsePatch(`*** Begin Patch
*** Update File: src/app.ts
@@ marker
+inserted
*** End Patch`);

    await applyPatchOperations(operations, workspace, '/repo');

    expect(await workspace.readText('/repo/src/app.ts')).toBe('alpha\nmarker\ninserted\nomega\n');
  });

  test('later hunks still match after an insert-only hunk in same patch', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/src/app.ts': 'a\nb\nc\nd\n',
    });
    const operations = parsePatch(`*** Begin Patch
*** Update File: src/app.ts
@@ b
+x
+y
@@
-d
+D
*** End Patch`);

    await applyPatchOperations(operations, workspace, '/repo');

    expect(await workspace.readText('/repo/src/app.ts')).toBe('a\nb\nx\ny\nc\nD\n');
  });

  test('update preserves missing final newline', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/src/app.ts': 'foo',
    });
    const operations = parsePatch(`*** Begin Patch
*** Update File: src/app.ts
@@
-foo
+bar
*** End Patch`);

    await applyPatchOperations(operations, workspace, '/repo');

    expect(await workspace.readText('/repo/src/app.ts')).toBe('bar');
  });

  test('add-file fails when destination already exists', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/new.txt': 'existing\n',
    });
    const operations = parsePatch(`*** Begin Patch
*** Add File: new.txt
+replacement
*** End Patch`);

    await expect(applyPatchOperations(operations, workspace, '/repo')).rejects.toThrow(
      /already exists/,
    );
    expect(await workspace.readText('/repo/new.txt')).toBe('existing\n');
  });

  test('captures text delete metadata without undercounting files lacking trailing newline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-edit-delete-text-'));
    try {
      const filePath = join(dir, 'note.txt');
      await writeFile(filePath, 'hello', 'utf8');
      const operations = parsePatch(`*** Begin Patch
*** Delete File: ${filePath}
*** End Patch`);

      const results = await applyPatchOperations(
        operations,
        createRealWorkspace(),
        dir,
        undefined,
        {
          collectDiff: true,
        },
      );

      expect(results[0]?.operation).toMatchObject({
        kind: 'delete',
        contentKind: 'text',
        byteLength: 5,
        lineCount: 1,
        state: 'applied',
      });
      expect(results[0]?.diff).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('captures binary delete metadata without generating a textual diff', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-edit-delete-binary-'));
    try {
      const filePath = join(dir, 'data.bin');
      await writeFile(filePath, Buffer.from([0, 1, 2, 3]));
      const operations = parsePatch(`*** Begin Patch
*** Delete File: ${filePath}
*** End Patch`);

      const results = await applyPatchOperations(
        operations,
        createRealWorkspace(),
        dir,
        undefined,
        {
          collectDiff: true,
        },
      );

      expect(results[0]?.operation).toMatchObject({
        kind: 'delete',
        contentKind: 'binary',
        byteLength: 4,
        state: 'applied',
      });
      expect(results[0]?.diff).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('buildPatchPlan', () => {
  test('reuses one snapshot read for version tokens and text snapshots per path', async () => {
    const virtual = createOverlayWorkspace('/repo', { '/repo/demo.txt': 'alpha\n' });
    const snapshotBase = createOverlayWorkspace('/repo', { '/repo/demo.txt': 'alpha\n' });
    let readBufferCalls = 0;
    const snapshotWorkspace = {
      ...snapshotBase,
      async readBuffer(absolutePath: string) {
        readBufferCalls += 1;
        return snapshotBase.readBuffer(absolutePath);
      },
    };

    const ops = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: demo.txt',
        '@@',
        '-alpha',
        '+beta',
        '*** End Patch',
      ].join('\n'),
    );

    await buildPatchPlan(ops, virtual, '/repo', snapshotWorkspace);

    expect(readBufferCalls).toBe(1);
  });

  test('commits against real workspace without false source version mismatches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-edit-plan-commit-'));
    try {
      const filePath = join(dir, 'src', 'app.ts');
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(filePath, 'foo\n', 'utf8');

      const ops = parsePatch(`*** Begin Patch
*** Update File: src/app.ts
@@
-foo
+bar
*** End Patch`);
      const plan = await buildPatchPlan(
        ops,
        createVirtualWorkspace(dir),
        dir,
        createRealWorkspace(),
      );
      const commit = await commitMutationPlan(plan, createRealWorkspace(), {
        rollbackOnFailure: true,
      });

      expect(commit.ok).toBe(true);
      await expect(createRealWorkspace().readText(filePath)).resolves.toBe('bar\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('coalesces add-then-move into a final write mutation', async () => {
    const workspace = createOverlayWorkspace('/repo', {});
    const ops = parsePatch(`*** Begin Patch
*** Add File: a.txt
+hello
*** Update File: a.txt
*** Move to: b.txt
*** End Patch`);

    const plan = await buildPatchPlan(ops, workspace, '/repo');

    expect(plan.mutations).toHaveLength(1);
    expect(plan.mutations[0]).toMatchObject({
      kind: 'write',
      absolutePath: '/repo/b.txt',
    });
    expect((plan.mutations[0] as any).afterText).toBe('hello\n');
  });

  test('coalesces add-then-delete to no-op mutations', async () => {
    const workspace = createOverlayWorkspace('/repo', {});
    const ops = parsePatch(`*** Begin Patch
*** Add File: tmp.txt
+hello
*** Delete File: tmp.txt
*** End Patch`);

    const plan = await buildPatchPlan(ops, workspace, '/repo');
    expect(plan.mutations).toEqual([]);
  });

  test('rejects binary deletes in plan/commit mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-edit-plan-binary-'));
    try {
      const filePath = join(dir, 'data.bin');
      await writeFile(filePath, Buffer.from([0, 1, 2, 3]));

      const ops = parsePatch(`*** Begin Patch
*** Delete File: data.bin
*** End Patch`);

      await expect(
        buildPatchPlan(ops, createVirtualWorkspace(dir), dir, createRealWorkspace()),
      ).rejects.toThrow(/Binary file mutations are not supported/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('updates UTF-8 text files with multi-byte characters (em-dashes, box-drawing, arrows)', async () => {
    // Regression: the binary-detection heuristic used to flag valid UTF-8 as
    // binary because continuation bytes (0x80-0xBF) fall inside the
    // "suspicious" range 0x7F-0x9F once you ignore the UTF-8 context. A file
    // dense in em-dashes (0xE2 0x80 0x94), arrows (0xE2 0x86 0x92, 0xE2 0x96
    // 0xBC), and box-drawing glyphs (0xE2 0x94 0x82) easily crossed the 10%
    // threshold and rejected Update ops with "Binary file mutations are not
    // supported".
    const dir = await mkdtemp(join(tmpdir(), 'multi-edit-utf8-'));
    try {
      const filePath = join(dir, 'docs.md');
      const originalHeader = '# Architecture \u2014 overview';
      const body = [
        '',
        '```',
        '\u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510      \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
        '\u2502  client  \u2502 \u2500\u2500\u25b6 \u2502  server  \u2502',
        '\u2502   (CLI)  \u2502 \u25c0\u2500\u2500 \u2502  (agent) \u2502',
        '\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518      \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
        '```',
        '',
        'Flow \u2014 the client sends a request \u2192 the server replies \u25bc',
        '',
        'Notes \u2014 em-dashes, arrows, and box-drawing all use UTF-8',
        'continuation bytes in the 0x80\u20130xBF range.',
        '',
      ].join('\n');
      const originalText = `${originalHeader}\n\n${body}`;
      await writeFile(filePath, originalText, 'utf8');

      // Build the patch string via concatenation so the test file itself
      // does not contain literal top-level patch markers.
      const BEGIN = '*** Begin ' + 'Patch';
      const END = '*** End ' + 'Patch';
      const patchText = [
        BEGIN,
        '*** Update File: docs.md',
        '*** FindReplaceOnce:',
        '<<<<<<< SEARCH',
        '# Architecture \u2014 overview',
        '======= REPLACE',
        '# Architecture \u2014 overview (revised)',
        '>>>>>>> REPLACE',
        END,
      ].join('\n');

      const ops = parsePatch(patchText);

      const plan = await buildPatchPlan(
        ops,
        createVirtualWorkspace(dir),
        dir,
        createRealWorkspace(),
      );
      expect(plan.mutations).toHaveLength(1);
      expect(plan.mutations[0]).toMatchObject({ kind: 'write' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('still rejects genuinely binary files (non-UTF-8) from Update ops', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-edit-utf8-neg-'));
    try {
      const filePath = join(dir, 'data.bin');
      // Invalid UTF-8: lone 0x80 continuation bytes with no preceding lead
      // byte. No nulls, so the null-byte fast path does not fire; this
      // exercises the byte-level fallback heuristic after UTF-8 decoding
      // has thrown.
      const bytes: number[] = [];
      for (let i = 0; i < 512; i++) {
        bytes.push(0x80 + (i % 0x20));
      }
      await writeFile(filePath, Buffer.from(bytes));

      const BEGIN = '*** Begin ' + 'Patch';
      const END = '*** End ' + 'Patch';
      const patchText = [BEGIN, '*** Delete File: data.bin', END].join('\n');
      const ops = parsePatch(patchText);

      await expect(
        buildPatchPlan(ops, createVirtualWorkspace(dir), dir, createRealWorkspace()),
      ).rejects.toThrow(/Binary file mutations are not supported/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('preserves move semantics when a moved file is updated again', async () => {
    const workspace = createOverlayWorkspace('/repo', { '/repo/a.txt': 'alpha\n' });
    const ops = parsePatch(`*** Begin Patch
*** Update File: a.txt
*** Move to: b.txt
*** Update File: b.txt
@@
-alpha
+beta
*** End Patch`);

    const plan = await buildPatchPlan(ops, workspace, '/repo');
    expect(plan.mutations).toHaveLength(1);
    expect(plan.mutations[0]).toMatchObject({
      kind: 'move',
      sourcePath: '/repo/a.txt',
      targetPath: '/repo/b.txt',
    });
    expect((plan.mutations[0] as any).afterText).toBe('beta\n');
  });

  test('keeps add-file targets in sourceVersions so commit can detect external creation', async () => {
    const workspace = createOverlayWorkspace('/repo', {});
    const ops = parsePatch(`*** Begin Patch
*** Add File: notes.md
+draft
*** End Patch`);

    const plan = await buildPatchPlan(ops, workspace, '/repo');
    expect(plan.sourceVersions.some((token) => token.absolutePath.endsWith('/notes.md'))).toBe(
      true,
    );
  });

  test('rename chain plus later edit commits once and leaves no orphan source path', async () => {
    const workspace = createOverlayWorkspace('/repo', { '/repo/a.txt': 'alpha\n' });
    const ops = parsePatch(`*** Begin Patch
*** Update File: a.txt
*** Move to: b.txt
*** Update File: b.txt
*** Move to: c.txt
*** Update File: c.txt
@@
-alpha
+beta
*** End Patch`);

    const plan = await buildPatchPlan(ops, workspace, '/repo');
    const result = await commitMutationPlan(plan, workspace, { rollbackOnFailure: true });

    expect(result.ok).toBe(true);
    expect(plan.mutations).toHaveLength(1);
    await expect(workspace.exists('/repo/a.txt')).resolves.toBe(false);
    await expect(workspace.exists('/repo/b.txt')).resolves.toBe(false);
    await expect(workspace.readText('/repo/c.txt')).resolves.toBe('beta\n');
  });

  test('delete-then-rename into the same target succeeds in plan/commit mode', async () => {
    const workspace = createOverlayWorkspace('/repo', {
      '/repo/source.txt': 'alpha\n',
      '/repo/target.txt': 'old\n',
    });
    const ops = parsePatch(`*** Begin Patch
*** Delete File: target.txt
*** Update File: source.txt
*** Move to: target.txt
*** End Patch`);

    const plan = await buildPatchPlan(ops, workspace, '/repo');
    const result = await commitMutationPlan(plan, workspace, { rollbackOnFailure: true });

    expect(result.ok).toBe(true);
    await expect(workspace.exists('/repo/source.txt')).resolves.toBe(false);
    await expect(workspace.readText('/repo/target.txt')).resolves.toBe('alpha\n');
  });

  test('summaryText notes lenient-divider chunks so the agent can correct them', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/foo.ts': 'const a = 1;\n',
    });
    const ops = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '*** FindReplaceOnce:',
        '<<<<<<< SEARCH',
        'const a = 1;',
        '=======',
        'const a = 42;',
        '>>>>>>> REPLACE',
        '*** End Patch',
      ].join('\n'),
    );

    const plan = await buildPatchPlan(ops, workspace, '/repo');
    expect(plan.summaryText).toContain("accepted bare '=======' as the SEARCH/REPLACE divider");
    expect(plan.summaryText).toContain('foo.ts');
    expect(plan.summaryText).toContain("Prefer '======= REPLACE'");
  });
});

// Phase 0 baseline characterization tests. These lock in current
// behavior so later phases (P0 near-miss diagnostics, lookahead
// evaluation, FindReplace variants) change it deliberately. When
// Phase 1 lands, these tests are expected to be updated to reflect
// the richer error format.
describe('near-miss baseline (phase 0 characterization)', () => {
  test('whitespace-drift slippage throws generic "Failed to find expected lines"', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/src/app.ts': ['const a = 1;', 'const b = 2;', 'const c = 3;'].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: src/app.ts',
        '@@',
        '-const x = 100;',
        '-const y = 200;',
        '+const x = 999;',
        '+const y = 888;',
        '*** End Patch',
      ].join('\n'),
    );

    await expect(applyPatchOperations(operations, workspace, '/repo')).rejects.toThrow(
      /Failed to find expected lines in src\/app\.ts/,
    );
  });

  test('single-token drift in context throws generic failure with no near-miss detail', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/src/app.ts': ['const config = loadConfig();', 'return config.port;'].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: src/app.ts',
        '@@',
        '-const config = FETCH();',
        '-return config.port;',
        '+const config = FETCH();',
        '+return config.port ?? 3000;',
        '*** End Patch',
      ].join('\n'),
    );

    const attempt = applyPatchOperations(operations, workspace, '/repo');
    await expect(attempt).rejects.toThrow(/Failed to find expected lines in src\/app\.ts/);
    // Phase 1: error.message no longer echoes the pattern; the rich
    // payload lives on error.failure for downstream rendering.
    await attempt.catch((error: unknown) => {
      expect(error).toBeInstanceOf(PatchContextMatchError);
      const failure = (error as PatchContextMatchError).failure;
      expect(failure.kind).toBe('context-not-found');
      expect(failure.filePath).toBe('src/app.ts');
      expect(failure.expectedLines).toEqual(['const config = FETCH();', 'return config.port;']);
      expect(failure.nearestMatch).toBeDefined();
      expect(failure.nearestMatch!.startLine).toBe(1);
      expect(failure.nearestMatch!.score).toBeGreaterThan(0);
      expect(failure.nearestMatch!.score).toBeLessThan(1);
      // Per-line signals: line 2 ("return config.port;") matches
      // exactly; line 1 ("const config = FETCH();") drifted.
      expect(failure.nearestMatch!.perLineSignals[0].matched).toBe(false);
      expect(failure.nearestMatch!.perLineSignals[1].matched).toBe(true);
    });
  });

  test('anchor miss throws PatchContextMatchError with nearby identifiers', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/src/app.py': [
        'def foo_helper(x):',
        '    return x + 1',
        '',
        'def handle_foo(y):',
        '    return y * 2',
      ].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: src/app.py',
        '@@ def nonexistent',
        '-    return x + 1',
        '+    return x + 2',
        '*** End Patch',
      ].join('\n'),
    );

    const attempt = applyPatchOperations(operations, workspace, '/repo');
    await expect(attempt).rejects.toThrow(
      /Failed to find anchor 'def nonexistent' in src\/app\.py/,
    );
    await attempt.catch((error: unknown) => {
      expect(error).toBeInstanceOf(PatchContextMatchError);
      const failure = (error as PatchContextMatchError).failure;
      expect(failure.kind).toBe('anchor-not-found');
      expect(failure.anchor).toBe('def nonexistent');
      // Nearby identifiers surfaced by token-overlap ranking.
      const ids = failure.nearbyIdentifiers ?? [];
      const matchedTexts = ids.map((e) => e.text);
      expect(matchedTexts).toEqual(
        expect.arrayContaining(['def foo_helper(x):', 'def handle_foo(y):']),
      );
    });
  });

  test('buildPatchPlan evaluates all ops via lookahead and aggregates failures', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/a.ts': 'alpha\n',
      '/repo/b.ts': 'bravo\n',
      '/repo/c.ts': 'charlie\n',
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: a.ts',
        '@@',
        '-alpha',
        '+ALPHA',
        '*** Update File: b.ts',
        '@@',
        '-bravoooo',
        '+BRAVO',
        '*** Update File: c.ts',
        '@@',
        '-charlieeee',
        '+CHARLIE',
        '*** End Patch',
      ].join('\n'),
    );

    const attempt = buildPatchPlan(operations, workspace, '/repo');
    await expect(attempt).rejects.toBeInstanceOf(PatchPlanFailedError);
    await attempt.catch((error: unknown) => {
      const err = error as PatchPlanFailedError;
      // All three ops evaluated; op 1 would apply cleanly, ops 2 and
      // 3 failed (two separate PatchContextMatchError captures).
      expect(err.statuses).toHaveLength(3);
      expect(err.statuses[0]!.wouldApply).toBe(true);
      expect(err.statuses[1]!.wouldApply).toBe(false);
      expect(err.statuses[2]!.wouldApply).toBe(false);
      expect(err.failures).toHaveLength(2);
      expect(err.statuses[1]!.path).toBe('b.ts');
      expect(err.statuses[2]!.path).toBe('c.ts');
    });
  });
});

describe('atomicity contract (phase 0 characterization)', () => {
  test('successive calls: first patch commits, second fails, first preserved', async () => {
    // Each apply_patch call is its own transaction. Successful calls
    // persist regardless of what later calls do. This is how agents
    // get "partial success" semantics: split independent ops into
    // multiple calls.
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/a.ts': 'alpha\n',
      '/repo/b.ts': 'bravo\n',
    });

    const firstOps = parsePatch(
      ['*** Begin Patch', '*** Update File: a.ts', '@@', '-alpha', '+ALPHA', '*** End Patch'].join(
        '\n',
      ),
    );
    await applyPatchOperations(firstOps, workspace, '/repo');
    await expect(workspace.readText('/repo/a.ts')).resolves.toBe('ALPHA\n');

    // Second call targets b.ts with a pattern that will not match.
    const secondOps = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: b.ts',
        '@@',
        '-totally wrong pattern',
        '+replacement',
        '*** End Patch',
      ].join('\n'),
    );
    await expect(applyPatchOperations(secondOps, workspace, '/repo')).rejects.toThrow();

    // First call's write is still present; second call touched nothing.
    await expect(workspace.readText('/repo/a.ts')).resolves.toBe('ALPHA\n');
    await expect(workspace.readText('/repo/b.ts')).resolves.toBe('bravo\n');
  });
});

// Phase 1 (P0): near-miss diagnostics.
//
// These tests drive the new data shape — nearest match, per-line
// signals, margins, scan truncation, anchor near-identifiers — and
// verify the `PatchContextMatchError` carries enough information to
// recover without a re-read.
describe('near-miss diagnostics (phase 1)', () => {
  test('builds a nearest-match payload with pattern-width actualLines and margin', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/src/app.ts': [
        'export function one() {',
        '  return 1;',
        '}',
        '',
        'export async function loadResolverConfig(): Promise<Config> {',
        '  await initConfigLoader();',
        '  const config = await loadConfig();',
        '  return config.port ?? 3000;',
        '}',
        '',
        'export function three() {',
        '  return 3;',
        '}',
      ].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: src/app.ts',
        '@@',
        '-  const config = loadConfig();',
        '-  return config.port;',
        '+  const config = await loadConfig();',
        '+  return config.port ?? 3000;',
        '*** End Patch',
      ].join('\n'),
    );

    const attempt = applyPatchOperations(operations, workspace, '/repo');
    await attempt.catch((error: unknown) => {
      expect(error).toBeInstanceOf(PatchContextMatchError);
      const failure = (error as PatchContextMatchError).failure;
      expect(failure.kind).toBe('context-not-found');
      expect(failure.nearestMatch).toBeDefined();
      const near = failure.nearestMatch!;
      // Pattern-width actualLines aligned with expected.
      expect(near.actualLines).toHaveLength(2);
      expect(near.actualLines[0]).toBe('  const config = await loadConfig();');
      expect(near.actualLines[1]).toBe('  return config.port ?? 3000;');
      // Margin gives surrounding context without paying for a wide window.
      expect(near.marginBefore.length).toBeLessThanOrEqual(3);
      expect(near.marginAfter.length).toBeLessThanOrEqual(3);
      expect(near.marginBefore[near.marginBefore.length - 1]).toBe('  await initConfigLoader();');
      expect(near.marginAfter[0]).toBe('}');
      // Line number is 1-indexed; pointing at first actual line.
      expect(near.startLine).toBe(7);
    });
  });

  test('per-line signals tag each pattern line with matched + tier', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/src/app.ts': ['line one', 'LINE TWO', 'line three'].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: src/app.ts',
        '@@',
        '-line one',
        '-  line two  ', // trim-tier match
        '-line three',
        '+replaced',
        '*** End Patch',
      ].join('\n'),
    );
    const attempt = applyPatchOperations(operations, workspace, '/repo');
    await attempt.catch((error: unknown) => {
      expect(error).toBeInstanceOf(PatchContextMatchError);
      const near = (error as PatchContextMatchError).failure.nearestMatch!;
      const signals = near.perLineSignals;
      expect(signals).toHaveLength(3);
      expect(signals[0]).toMatchObject({ matched: true, tier: 'exact' });
      // "  line two  " vs "LINE TWO" — differs in case and whitespace;
      // all four tiers treat them as different (trim does not normalize
      // case). So this line drifts.
      expect(signals[1].matched).toBe(false);
      expect(signals[2]).toMatchObject({ matched: true, tier: 'exact' });
    });
  });

  test('no close match returns tierTried=none with score 0', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/src/app.ts': ['alpha', 'bravo', 'charlie'].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: src/app.ts',
        '@@',
        '-totally unrelated line',
        '+replacement',
        '*** End Patch',
      ].join('\n'),
    );
    const attempt = applyPatchOperations(operations, workspace, '/repo');
    await attempt.catch((error: unknown) => {
      const near = (error as PatchContextMatchError).failure.nearestMatch!;
      // Soft similarity can surface a tiny non-zero score even when no
      // tier matched (incidental character-bigram overlap). Report
      // tierTried='none' so the agent knows no tier-level match exists.
      expect(near.score).toBeLessThan(0.2);
      expect(near.tierTried).toBe('none');
    });
  });

  test('anchor miss collects nearby identifiers ranked by token overlap', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/src/app.py': [
        'def foo_helper(x):',
        '    return x + 1',
        '',
        'def handle_foo(y):',
        '    return y * 2',
        '',
        'def unrelated():',
        '    return 3',
      ].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: src/app.py',
        '@@ def foo',
        '-    return x + 1',
        '+    return x + 2',
        '*** End Patch',
      ].join('\n'),
    );
    const attempt = applyPatchOperations(operations, workspace, '/repo');
    await attempt.catch((error: unknown) => {
      const failure = (error as PatchContextMatchError).failure;
      expect(failure.kind).toBe('anchor-not-found');
      const ids = failure.nearbyIdentifiers ?? [];
      // "def foo" tokens = {def, foo}; lines sharing both score highest.
      const texts = ids.map((e) => e.text);
      expect(texts).toContain('def foo_helper(x):');
      expect(texts).toContain('def handle_foo(y):');
      // Unrelated identifiers may still appear via "def" overlap but
      // sort after the two-token hits.
      expect(texts.indexOf('def foo_helper(x):')).toBeLessThan(texts.indexOf('def unrelated():'));
    });
  });

  test('scanTruncated flag set when file exceeds sampling threshold', async () => {
    // Build a file just over the sampling threshold.
    const lines: string[] = [];
    for (let i = 0; i < 6000; i++) {
      lines.push(`line ${i}`);
    }
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/big.txt': lines.join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: big.txt',
        '@@',
        '-not present in file at all',
        '+replacement',
        '*** End Patch',
      ].join('\n'),
    );
    const attempt = applyPatchOperations(operations, workspace, '/repo');
    await attempt.catch((error: unknown) => {
      const failure = (error as PatchContextMatchError).failure;
      expect(failure.scanTruncated).toBe(true);
    });
  });
});

describe('lookahead evaluation (phase 1)', () => {
  test('single failure in a multi-op patch: other ops still evaluated and marked would-apply', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/a.ts': 'alpha\n',
      '/repo/b.ts': 'bravo\n',
      '/repo/c.ts': 'charlie\n',
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: a.ts',
        '@@',
        '-alpha',
        '+ALPHA',
        '*** Update File: b.ts',
        '@@',
        '-totally wrong',
        '+x',
        '*** Update File: c.ts',
        '@@',
        '-charlie',
        '+CHARLIE',
        '*** End Patch',
      ].join('\n'),
    );

    await buildPatchPlan(operations, workspace, '/repo').catch((error: unknown) => {
      const err = error as PatchPlanFailedError;
      expect(err.statuses).toHaveLength(3);
      expect(err.statuses[0]!.wouldApply).toBe(true);
      expect(err.statuses[1]!.wouldApply).toBe(false);
      expect(err.statuses[2]!.wouldApply).toBe(true);
      expect(err.failures).toHaveLength(1);
    });
  });

  test('multiple failures are all captured with distinct contexts', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/x.ts': 'first\n',
      '/repo/y.ts': 'second\n',
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: x.ts',
        '@@',
        '-wrong one',
        '+r1',
        '*** Update File: y.ts',
        '@@',
        '-wrong two',
        '+r2',
        '*** End Patch',
      ].join('\n'),
    );

    await buildPatchPlan(operations, workspace, '/repo').catch((error: unknown) => {
      const err = error as PatchPlanFailedError;
      expect(err.failures).toHaveLength(2);
      expect(err.failures[0]!.filePath).toBe('x.ts');
      expect(err.failures[1]!.filePath).toBe('y.ts');
      expect(err.failures[0]!.expectedLines).toEqual(['wrong one']);
      expect(err.failures[1]!.expectedLines).toEqual(['wrong two']);
    });
  });

  test('all-success path returns a normal MutationPlan (no change on happy path)', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/a.ts': 'alpha\n',
      '/repo/b.ts': 'bravo\n',
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: a.ts',
        '@@',
        '-alpha',
        '+ALPHA',
        '*** Update File: b.ts',
        '@@',
        '-bravo',
        '+BRAVO',
        '*** End Patch',
      ].join('\n'),
    );

    const plan = await buildPatchPlan(operations, workspace, '/repo');
    expect(plan.rows).toHaveLength(2);
    expect(plan.mutations).toHaveLength(2);
  });

  test('later ops that depend on a failed earlier op surface their own honest failure', async () => {
    // Op 1 is meant to replace "alpha" with "gamma" in shared.ts;
    // it fails due to context drift. Op 2 is meant to then edit
    // "gamma" (op 1's intended output) — since op 1 did not stage,
    // op 2 evaluates against the original "alpha" and fails with
    // a distinct near-miss. Both failures are reported honestly.
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/shared.ts': 'alpha\n',
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: shared.ts',
        '@@',
        '-WRONGalpha',
        '+gamma',
        '*** Update File: shared.ts',
        '@@',
        '-gamma',
        '+delta',
        '*** End Patch',
      ].join('\n'),
    );

    await buildPatchPlan(operations, workspace, '/repo').catch((error: unknown) => {
      const err = error as PatchPlanFailedError;
      expect(err.statuses).toHaveLength(2);
      expect(err.statuses[0]!.wouldApply).toBe(false);
      expect(err.statuses[1]!.wouldApply).toBe(false);
    });
  });
});

describe('tier visibility / usedFuzzy (phase 1.5)', () => {
  test('applies via trim tier and reports usedFuzzy=true on the op result', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      // File has the actual content with curly-quote drift the patch
      // does not carry — fuzzy tier normalizes them to the same form.
      '/repo/foo.ts': 'const greeting = \u201Chello\u201D;\n',
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '@@',
        '-const greeting = "hello";',
        '+const greeting = "hi";',
        '*** End Patch',
      ].join('\n'),
    );
    const results = await applyPatchOperations(operations, workspace, '/repo');
    expect(results).toHaveLength(1);
    expect(results[0]!.usedFuzzy).toBe(true);
  });

  test('applies via exact tier leaves usedFuzzy unset', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/foo.ts': 'const x = 1;\n',
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '@@',
        '-const x = 1;',
        '+const x = 2;',
        '*** End Patch',
      ].join('\n'),
    );
    const results = await applyPatchOperations(operations, workspace, '/repo');
    expect(results[0]!.usedFuzzy).toBeUndefined();
  });

  test('zero-width char in file still matches patch via fuzzy tier', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      // Zero-width space between 'h' and 'i' — invisible, renders the
      // same as 'hi'. Patch is without the ZWSP.
      '/repo/foo.ts': 'const x = "h\u200Bi";\n',
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '@@',
        '-const x = "hi";',
        '+const x = "bye";',
        '*** End Patch',
      ].join('\n'),
    );
    const results = await applyPatchOperations(operations, workspace, '/repo');
    expect(results[0]!.usedFuzzy).toBe(true);
  });
});

describe('FindReplaceOnce (phase 2)', () => {
  test('basic single-occurrence find-and-replace', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/foo.ts': [
        'const config = loadConfig();',
        'return config.port;',
        '',
        'const unrelated = 1;',
      ].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '*** FindReplaceOnce:',
        '<<<<<<< SEARCH',
        'const config = loadConfig();',
        'return config.port;',
        '======= REPLACE',
        'const config = await loadConfig();',
        'return config.port ?? 3000;',
        '>>>>>>> REPLACE',
        '*** End Patch',
      ].join('\n'),
    );
    await applyPatchOperations(operations, workspace, '/repo');
    await expect(workspace.readText('/repo/foo.ts')).resolves.toBe(
      [
        'const config = await loadConfig();',
        'return config.port ?? 3000;',
        '',
        'const unrelated = 1;',
      ].join('\n'),
    );
  });

  test('parser break condition: *** Update File: + *** FindReplaceOnce: parses as one op', () => {
    const ops = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '*** FindReplaceOnce:',
        '<<<<<<< SEARCH',
        'alpha',
        '======= REPLACE',
        'beta',
        '>>>>>>> REPLACE',
        '*** End Patch',
      ].join('\n'),
    );
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.kind).toBe('update');
    if (op.kind === 'update') {
      expect(op.chunks).toHaveLength(1);
      expect(op.chunks[0]!.source).toBe('find-replace-once');
      expect(op.chunks[0]!.mustBeUnique).toBe(true);
      expect(op.chunks[0]!.oldLines).toEqual(['alpha']);
      expect(op.chunks[0]!.newLines).toEqual(['beta']);
    }
  });

  test('ambiguous SEARCH throws AmbiguousFindReplaceOnceError with match locations', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/foo.ts': ['const x = 1;', 'const y = 2;', 'const x = 1;'].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '*** FindReplaceOnce:',
        '<<<<<<< SEARCH',
        'const x = 1;',
        '======= REPLACE',
        'const x = 42;',
        '>>>>>>> REPLACE',
        '*** End Patch',
      ].join('\n'),
    );
    await expect(applyPatchOperations(operations, workspace, '/repo')).rejects.toBeInstanceOf(
      AmbiguousFindReplaceOnceError,
    );
    await applyPatchOperations(operations, workspace, '/repo').catch((error: unknown) => {
      const err = error as AmbiguousFindReplaceOnceError;
      expect(err.matchLines).toEqual([1, 3]);
    });
  });

  test('zero matches throws PatchContextMatchError with near-miss', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/foo.ts': ['const x = 1;'].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '*** FindReplaceOnce:',
        '<<<<<<< SEARCH',
        'const notHere = 99;',
        '======= REPLACE',
        'const notHere = 88;',
        '>>>>>>> REPLACE',
        '*** End Patch',
      ].join('\n'),
    );
    await expect(applyPatchOperations(operations, workspace, '/repo')).rejects.toBeInstanceOf(
      PatchContextMatchError,
    );
  });

  test('empty REPLACE deletes the matched region', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/foo.ts': ['line one', 'delete me', 'line three'].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '*** FindReplaceOnce:',
        '<<<<<<< SEARCH',
        'delete me',
        '======= REPLACE',
        '>>>>>>> REPLACE',
        '*** End Patch',
      ].join('\n'),
    );
    await applyPatchOperations(operations, workspace, '/repo');
    await expect(workspace.readText('/repo/foo.ts')).resolves.toBe(
      ['line one', 'line three'].join('\n'),
    );
  });

  test('SEARCH containing bare ======= line parses correctly (divider is "======= REPLACE")', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      // File has literal merge-conflict markers embedded (e.g.,
      // committed on purpose to document conflict resolution).
      '/repo/docs.md': [
        '<<<<<<< HEAD',
        'version from head',
        '=======',
        'version from branch',
        '>>>>>>> feature-branch',
      ].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: docs.md',
        '*** FindReplaceOnce:',
        '<<<<<<< SEARCH',
        '<<<<<<< HEAD',
        'version from head',
        '=======',
        'version from branch',
        '>>>>>>> feature-branch',
        '======= REPLACE',
        'merged version',
        '>>>>>>> REPLACE',
        '*** End Patch',
      ].join('\n'),
    );
    await applyPatchOperations(operations, workspace, '/repo');
    await expect(workspace.readText('/repo/docs.md')).resolves.toBe('merged version');
  });

  test('FindReplaceOnce mixed with @@ hunk in same Update File block', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/foo.ts': ['const a = 1;', 'const b = 2;', 'const c = 3;'].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '*** FindReplaceOnce:',
        '<<<<<<< SEARCH',
        'const a = 1;',
        '======= REPLACE',
        'const a = 100;',
        '>>>>>>> REPLACE',
        '@@',
        '-const c = 3;',
        '+const c = 300;',
        '*** End Patch',
      ].join('\n'),
    );
    await applyPatchOperations(operations, workspace, '/repo');
    await expect(workspace.readText('/repo/foo.ts')).resolves.toBe(
      ['const a = 100;', 'const b = 2;', 'const c = 300;'].join('\n'),
    );
  });

  test("accepts bare '=======' as divider (lenient fallback) and flags the chunk", async () => {
    // Frontier models often emit the aider / git-conflict middle
    // marker (bare `=======`) instead of the canonical
    // `======= REPLACE`. Accept it as a forgiveness fallback and
    // flag the chunk so the tool surface can nudge the agent.
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/foo.ts': ['const a = 1;', 'const b = 2;'].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '*** FindReplaceOnce:',
        '<<<<<<< SEARCH',
        'const a = 1;',
        '=======',
        'const a = 42;',
        '>>>>>>> REPLACE',
        '*** End Patch',
      ].join('\n'),
    );
    expect(operations).toHaveLength(1);
    const op = operations[0];
    expect(op?.kind).toBe('update');
    if (op?.kind === 'update') {
      expect(op.chunks).toHaveLength(1);
      expect(op.chunks[0]?.lenientDivider).toBe(true);
    }
    await applyPatchOperations(operations, workspace, '/repo');
    await expect(workspace.readText('/repo/foo.ts')).resolves.toBe(
      ['const a = 42;', 'const b = 2;'].join('\n'),
    );
  });

  test("explicit '======= REPLACE' wins over an earlier bare '=======' in SEARCH content", async () => {
    // Safety property: files with literal `=======` content (markdown
    // HRs, RST underlines, committed conflict fixtures) stay
    // unambiguous when the agent uses the explicit divider. The
    // lenient fallback must only kick in when the strict form is
    // absent.
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/docs.md': ['# Title', '', '=======', '', 'body'].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: docs.md',
        '*** FindReplaceOnce:',
        '<<<<<<< SEARCH',
        '# Title',
        '',
        '=======',
        '',
        'body',
        '======= REPLACE',
        '# Updated',
        '',
        '---',
        '',
        'new body',
        '>>>>>>> REPLACE',
        '*** End Patch',
      ].join('\n'),
    );
    expect(operations).toHaveLength(1);
    const op = operations[0];
    if (op?.kind === 'update') {
      expect(op.chunks[0]?.lenientDivider).toBeUndefined();
    }
    await applyPatchOperations(operations, workspace, '/repo');
    await expect(workspace.readText('/repo/docs.md')).resolves.toBe(
      ['# Updated', '', '---', '', 'new body'].join('\n'),
    );
  });

  test("two bare '=======' lines with no strict divider fail with candidate line numbers", () => {
    expect(() =>
      parsePatch(
        [
          '*** Begin Patch',
          '*** Update File: docs.md',
          '*** FindReplaceOnce:',
          '<<<<<<< SEARCH',
          'one',
          '=======',
          'two',
          '=======',
          'three',
          '>>>>>>> REPLACE',
          '*** End Patch',
        ].join('\n'),
      ),
    ).toThrow(/ambiguous bare '=======' lines at input lines 6, 8/);
  });
});

describe('FindReplaceAll (phase 2)', () => {
  test('replaces every occurrence of a whole-line SEARCH', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      // FindReplace is line-based: SEARCH matches whole-line
      // occurrences in the winning tier. For mass substitution of
      // identical lines (e.g., a deprecated import or header),
      // FindReplaceAll is a one-shot. For symbol-level renames
      // across callsites with different arguments, agents should
      // use separate FindReplaceOnce blocks or classic edit.
      '/repo/foo.ts': [
        'import { old } from "legacy";',
        'const a = 1;',
        'import { old } from "legacy";',
        'const b = 2;',
        'import { old } from "legacy";',
      ].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '*** FindReplaceAll:',
        '<<<<<<< SEARCH',
        'import { old } from "legacy";',
        '======= REPLACE',
        'import { shiny } from "modern";',
        '>>>>>>> REPLACE',
        '*** End Patch',
      ].join('\n'),
    );
    const results = await applyPatchOperations(operations, workspace, '/repo');
    expect(results[0]!.replaceAllCount).toBe(3);
    await expect(workspace.readText('/repo/foo.ts')).resolves.toBe(
      [
        'import { shiny } from "modern";',
        'const a = 1;',
        'import { shiny } from "modern";',
        'const b = 2;',
        'import { shiny } from "modern";',
      ].join('\n'),
    );
  });

  test('single occurrence is not an error (ceiling not floor)', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/foo.ts': 'only one line here\n',
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '*** FindReplaceAll:',
        '<<<<<<< SEARCH',
        'only one line here',
        '======= REPLACE',
        'replacement line',
        '>>>>>>> REPLACE',
        '*** End Patch',
      ].join('\n'),
    );
    const results = await applyPatchOperations(operations, workspace, '/repo');
    expect(results[0]!.replaceAllCount).toBe(1);
  });

  test('zero matches raises the same P0 near-miss error as FindReplaceOnce', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/foo.ts': 'alpha\n',
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '*** FindReplaceAll:',
        '<<<<<<< SEARCH',
        'not present',
        '======= REPLACE',
        'replacement',
        '>>>>>>> REPLACE',
        '*** End Patch',
      ].join('\n'),
    );
    await expect(applyPatchOperations(operations, workspace, '/repo')).rejects.toBeInstanceOf(
      PatchContextMatchError,
    );
  });

  test('REPLACE containing SEARCH does not cause iterative replacement', async () => {
    // Single-pass replacement: positions are collected against the
    // original state. `foo → foo_v2` on `foo foo foo` yields
    // `foo_v2 foo_v2 foo_v2`, not runaway iteration.
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/foo.ts': ['foo', 'foo', 'foo'].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '*** FindReplaceAll:',
        '<<<<<<< SEARCH',
        'foo',
        '======= REPLACE',
        'foo_v2',
        '>>>>>>> REPLACE',
        '*** End Patch',
      ].join('\n'),
    );
    await applyPatchOperations(operations, workspace, '/repo');
    await expect(workspace.readText('/repo/foo.ts')).resolves.toBe(
      ['foo_v2', 'foo_v2', 'foo_v2'].join('\n'),
    );
  });

  test('empty REPLACE deletes all occurrences', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/foo.ts': ['keep', 'remove', 'keep', 'remove', 'keep'].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '*** FindReplaceAll:',
        '<<<<<<< SEARCH',
        'remove',
        '======= REPLACE',
        '>>>>>>> REPLACE',
        '*** End Patch',
      ].join('\n'),
    );
    const results = await applyPatchOperations(operations, workspace, '/repo');
    expect(results[0]!.replaceAllCount).toBe(2);
    await expect(workspace.readText('/repo/foo.ts')).resolves.toBe(
      ['keep', 'keep', 'keep'].join('\n'),
    );
  });

  test('tier fallback: 0 exact, N trim-tier matches → all N replaced via trim', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      // File has leading whitespace drift; patch SEARCH does not.
      // Exact tier fails everywhere; trim tier matches both lines.
      '/repo/foo.ts': ['  legacy_line', '  legacy_line'].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '*** FindReplaceAll:',
        '<<<<<<< SEARCH',
        'legacy_line',
        '======= REPLACE',
        'modern_line',
        '>>>>>>> REPLACE',
        '*** End Patch',
      ].join('\n'),
    );
    const results = await applyPatchOperations(operations, workspace, '/repo');
    // Trim-tier matches both lines (leading whitespace normalized).
    expect(results[0]!.replaceAllCount).toBe(2);
    expect(results[0]!.usedFuzzy).toBe(true);
  });

  test('can mix FindReplaceOnce, FindReplaceAll, and hunks in one block', async () => {
    const workspace = createVirtualWorkspace('/repo', {
      '/repo/foo.ts': ['header', 'legacy_line', 'legacy_line', 'unique_line', 'footer'].join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '*** FindReplaceOnce:',
        '<<<<<<< SEARCH',
        'unique_line',
        '======= REPLACE',
        'transformed_line',
        '>>>>>>> REPLACE',
        '*** FindReplaceAll:',
        '<<<<<<< SEARCH',
        'legacy_line',
        '======= REPLACE',
        'modern_line',
        '>>>>>>> REPLACE',
        '@@',
        '-header',
        '+HEADER',
        '*** End Patch',
      ].join('\n'),
    );
    await applyPatchOperations(operations, workspace, '/repo');
    await expect(workspace.readText('/repo/foo.ts')).resolves.toBe(
      ['HEADER', 'modern_line', 'modern_line', 'transformed_line', 'footer'].join('\n'),
    );
  });

  test('high match count (>20) surfaces a warning advisory in summaryText', async () => {
    // Build a file with 25 copies of a line so the advisory threshold
    // fires.
    const lines = Array.from({ length: 25 }, () => 'old_line');
    const workspace = createOverlayWorkspace('/repo', {
      '/repo/foo.ts': lines.join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '*** FindReplaceAll:',
        '<<<<<<< SEARCH',
        'old_line',
        '======= REPLACE',
        'new_line',
        '>>>>>>> REPLACE',
        '*** End Patch',
      ].join('\n'),
    );
    const plan = await buildPatchPlan(operations, workspace, '/repo');
    expect(plan.summaryText).toMatch(/Warning: FindReplaceAll in foo\.ts replaced 25 occurrences/);
  });

  test('modest match count (≤20) shows a plain Note in summaryText', async () => {
    const lines = Array.from({ length: 5 }, () => 'old_line');
    const workspace = createOverlayWorkspace('/repo', {
      '/repo/foo.ts': lines.join('\n'),
    });
    const operations = parsePatch(
      [
        '*** Begin Patch',
        '*** Update File: foo.ts',
        '*** FindReplaceAll:',
        '<<<<<<< SEARCH',
        'old_line',
        '======= REPLACE',
        'new_line',
        '>>>>>>> REPLACE',
        '*** End Patch',
      ].join('\n'),
    );
    const plan = await buildPatchPlan(operations, workspace, '/repo');
    expect(plan.summaryText).toMatch(/Note: FindReplaceAll in foo\.ts replaced 5 occurrences/);
    expect(plan.summaryText).not.toMatch(/Warning/);
  });
});
