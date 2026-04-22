import { describe, expect, test } from 'vitest';

import multiEditExtension from './index';
import { renderApplyPatchRows, renderApplyPatchSummary } from './display/apply-patch-summary';

function createTheme() {
  return {
    fg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
    getFgAnsi() {
      return '';
    },
    getBgAnsi() {
      return '';
    },
  };
}

function createAnsiTheme() {
  return {
    fg(_color: string, text: string) {
      return `\x1b[31m${text}\x1b[39m`;
    },
    bold(text: string) {
      return `\x1b[1m${text}\x1b[22m`;
    },
    getFgAnsi() {
      return '';
    },
    getBgAnsi() {
      return '';
    },
  };
}

describe('multi-edit display renderer', () => {
  test('renders a single-operation summary as one line', () => {
    const text = renderApplyPatchSummary(
      [
        {
          kind: 'edit',
          path: 'src/foo.ts',
          addedLines: 15,
          removedLines: 3,
          modifiedBytes: 12_300,
          renameOnly: false,
          state: 'streaming',
        },
      ],
      createTheme(),
    )
      .render(160)
      .join('\n');

    expect(text).toContain('apply_patch: edit src/foo.ts');
    expect(text).toContain('○ +15/-3L · 12K');
  });

  test('renders multi-operation summary as header plus rows', () => {
    const text = renderApplyPatchSummary(
      [
        {
          kind: 'edit',
          path: 'src/foo.ts',
          addedLines: 15,
          removedLines: 3,
          modifiedBytes: 12_300,
          renameOnly: false,
          state: 'applied',
        },
        {
          kind: 'create',
          path: 'scratch/demo.md',
          addedLines: 4,
          removedLines: 0,
          modifiedBytes: 58,
          renameOnly: false,
          state: 'applying',
        },
        { kind: 'delete', path: 'notes.txt', state: 'streamed' },
      ],
      createTheme(),
    )
      .render(160)
      .join('\n');

    expect(text).toContain('apply_patch: 3 operations');
    expect(text).toContain('✓ edit');
    expect(text).toContain('▶ create');
    expect(text).toContain('○ delete');
    expect(text).toContain('meta');
  });

  test('renders rows without a header when requested explicitly', () => {
    const text = renderApplyPatchRows(
      [
        {
          kind: 'edit',
          path: 'src/foo.ts',
          addedLines: 15,
          removedLines: 3,
          modifiedBytes: 12_300,
          renameOnly: false,
          state: 'streaming',
        },
      ],
      createTheme(),
    )
      .render(160)
      .join('\n');

    expect(text).toContain('○ edit   src/foo.ts');
    expect(text).not.toContain('apply_patch');
  });

  test('renders staged and invalidated markers with restaging label', () => {
    const text = renderApplyPatchRows(
      [
        {
          kind: 'edit',
          path: 'src/foo.ts',
          addedLines: 1,
          removedLines: 1,
          modifiedBytes: 9,
          renameOnly: false,
          state: 'staged',
        },
        {
          kind: 'create',
          path: 'src/bar.ts',
          addedLines: 2,
          removedLines: 0,
          modifiedBytes: 10,
          renameOnly: false,
          state: 'invalidated',
        },
      ],
      createTheme(),
    )
      .render(160)
      .join('\n');

    expect(text).toContain('◆ edit');
    expect(text).toContain('◇ create');
    expect(text).toContain('restaging');
  });

  test('truncates long single-operation summaries on narrow widths', () => {
    const lines = renderApplyPatchSummary(
      [
        {
          kind: 'edit',
          path: 'src/components/really/very/long/path/to/file-name.ts',
          addedLines: 15,
          removedLines: 3,
          modifiedBytes: 12_300,
          renameOnly: false,
          state: 'streaming',
        },
      ],
      createTheme(),
    ).render(48);

    expect(lines.join('\n')).toContain('apply_patch: edit');
    expect(lines.join('\n')).toContain('12K');
    expect(lines.join('\n')).toContain('...');
  });

  test('middle-truncates long paths without dropping trailing filename or metrics', () => {
    const text = renderApplyPatchSummary(
      [
        {
          kind: 'create',
          path: 'scratch/apply-patch-demo/really/very/long/path/to/remove-me.txt',
          addedLines: 1,
          removedLines: 0,
          modifiedBytes: 15,
          renameOnly: false,
          state: 'applied',
        },
      ],
      createTheme(),
    )
      .render(72)
      .join('\n');

    expect(text).toContain('...');
    expect(text).toContain('remove-me.txt');
    expect(text).toContain('+1L · 15B');
  });

  test('keeps metrics visible when truncating a narrow multi-row path', () => {
    const text = renderApplyPatchSummary(
      [
        {
          kind: 'create',
          path: 'scratch/apply-patch-demo/final-sanity-check-with-a-very-long-name-for-three-dot-truncation.md',
          addedLines: 4,
          removedLines: 0,
          modifiedBytes: 101,
          renameOnly: false,
          state: 'applied',
        },
        {
          kind: 'edit',
          path: 'scratch/apply-patch-demo/alpha.md',
          addedLines: 1,
          removedLines: 0,
          modifiedBytes: 42,
          renameOnly: false,
          state: 'applied',
        },
      ],
      createTheme(),
    )
      .render(96)
      .join('\n');

    expect(text).toContain('...');
    expect(text).toContain('+4L · 101B');
  });

  test('does not inject full ansi resets into truncated path segments', () => {
    const text = renderApplyPatchSummary(
      [
        {
          kind: 'create',
          path: 'scratch/apply-patch-demo/resume-sanity-check-with-a-very-very-long-name-for-three-dot-rendering.md',
          addedLines: 4,
          removedLines: 0,
          modifiedBytes: 101,
          renameOnly: false,
          state: 'applied',
        },
        {
          kind: 'edit',
          path: 'scratch/apply-patch-demo/alpha.md',
          addedLines: 1,
          removedLines: 0,
          modifiedBytes: 42,
          renameOnly: false,
          state: 'applied',
        },
      ],
      createAnsiTheme(),
    )
      .render(96)
      .join('\n');

    expect(text).not.toContain('\x1b[0m');
  });

  test('renders edit diffs through the custom diff renderer', () => {
    const tools: any[] = [];
    multiEditExtension({
      registerTool(tool: any) {
        tools.push(tool);
      },
    } as any);

    const tool = tools[0];
    const component = tool.renderResult(
      {
        content: [{ type: 'text', text: 'Applied 1 edit(s).' }],
        details: {
          diff: 'File: scratch/demo.txt\n-1 alpha\n+1 ALPHA',
          firstChangedLine: 1,
        },
      },
      { expanded: true, isPartial: false },
      createTheme(),
      {
        args: { path: 'scratch/demo.txt', edits: [{ oldText: 'alpha', newText: 'ALPHA' }] },
        isError: false,
      },
    );

    const rendered = component.render(160).join('\n');
    expect(rendered).toContain('diff');
    expect(rendered).toContain('ALPHA');
  });

  test('apply_patch streaming preview shows a placeholder while rows are empty', () => {
    const tools: any[] = [];
    multiEditExtension({
      registerTool(tool: any) {
        tools.push(tool);
      },
    } as any);

    const applyPatch = tools.find((t) => t.name === 'apply_patch');
    expect(applyPatch).toBeDefined();

    // Bytes 0-14 window: tool call started, but not even "*** Begin Patch"
    // is fully received. Parser returns no rows. The renderer should
    // still reassure the user that something is arriving.
    const renderCallArgs = { patch: '*** B' };
    const component = applyPatch.renderCall(renderCallArgs, createTheme(), {
      cwd: '/repo',
      isPartial: true,
      argsComplete: false,
      state: {},
      executionStarted: false,
    });

    const rendered = component.render(120).join('\n');
    expect(rendered).toContain('apply_patch');
    expect(rendered).toMatch(/receiving|streaming|…/i);
  });

  test('apply_patch streaming preview shows a row with "…" placeholder once the colon arrives but the path has not', () => {
    const tools: any[] = [];
    multiEditExtension({
      registerTool(tool: any) {
        tools.push(tool);
      },
    } as any);

    const applyPatch = tools.find((t) => t.name === 'apply_patch');
    expect(applyPatch).toBeDefined();

    // Bytes 16-30 window: op kind committed ("*** Add File:"), path not
    // yet. After Fix A, the streaming parser emits a row with an empty
    // path; formatPath renders it as a muted "…" so the user sees
    // immediate structure.
    const renderCallArgs = {
      patch: '*** Begin Patch\n*** Add File:',
    };
    const component = applyPatch.renderCall(renderCallArgs, createTheme(), {
      cwd: '/repo',
      isPartial: true,
      argsComplete: false,
      state: {},
      executionStarted: false,
    });

    const rendered = component.render(120).join('\n');
    expect(rendered).toContain('create');
    expect(rendered).toContain('…');
  });
});
