import { describe, expect, test } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';

import {
  renderApplyPatchCall,
  renderApplyPatchResult,
  renderComputerToolCall,
  renderExecCommandCall,
  renderExecCommandResult,
  renderViewImageCall,
  renderViewImageResult,
  renderWriteStdinCall,
} from './rendering';

const theme = {
  bold: (text: string) => text,
  fg: (_role: string, text: string) => text,
};

function renderLines(component: { render(width: number): string[] }): string[] {
  return component.render(120).map((line) => line.trimEnd());
}

describe('tool renderers', () => {
  test('renders compact exec command calls and collapsed output previews', () => {
    expect(renderLines(renderExecCommandCall({ cmd: 'rg --files src | head' }, theme))).toEqual([
      '$ rg --files src | head',
    ]);
    expect(
      renderLines(renderExecCommandCall({ cmd: 'sleep 1', yield_time_ms: 50_000 }, theme)),
    ).toEqual(['$ sleep 1 (wait ≤30.0s)']);
    expect(
      renderLines(renderExecCommandCall({ cmd: 'echo 1\necho 2\necho 3\necho 4\necho 5' }, theme)),
    ).toEqual(['$ echo 1', '> echo 2', '> echo 3', '> echo 4', '> echo 5']);

    const collapsed = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'unused formatted result' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 1.25,
          output: 'first line\nsecond line\nthird line\nfourth line',
          exit_code: 0,
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    expect(renderLines(collapsed)).toEqual([
      '',
      '... (1 earlier lines, Ctrl+O to expand)',
      'second line',
      'third line',
      'fourth line',
      '',
      'Took 1.3s',
    ]);
  });

  test('renders collapsed multi-line exec commands with head and tail lines', () => {
    const command = Array.from({ length: 72 }, (_unused, index) => `line ${index + 1}`).join('\n');

    expect(renderLines(renderExecCommandCall({ cmd: command }, theme))).toEqual([
      '$ line 1',
      '> line 2',
      '> line 3',
      '... (66 more lines)',
      '> line 70',
      '> line 71',
      '> line 72',
    ]);
  });

  test('renders collapsed exec output with latest rows clipped independently', () => {
    const longRows = Array.from(
      { length: 51 },
      (_unused, index) =>
        `2026-06-21T20:07:${String(index).padStart(2, '0')}.302695Z INFO ${'x'.repeat(120)}`,
    );
    const rendered = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'unused formatted result' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 5.5,
          exec_session_id: 1,
          output: longRows.join('\n'),
          original_token_count: 12_345,
          exit_code: 0,
        },
      },
      { expanded: false, isPartial: false },
      theme,
    ).render(92);

    expect(rendered).toHaveLength(7);
    expect(rendered[0]?.trimEnd()).toBe('');
    expect(rendered[1]?.trimEnd()).toBe('... (48 earlier lines, Ctrl+O to expand)');
    expect(rendered.slice(2, 5).every((line) => visibleWidth(line) <= 92)).toBe(true);
    expect(rendered[2]).toContain('20:07:48');
    expect(rendered[3]).toContain('20:07:49');
    expect(rendered[4]).toContain('20:07:50');
    expect(rendered[5]?.trimEnd()).toBe('');
    expect(rendered[6]?.trimEnd()).toBe('Exec #1 exited 0 · Took 5.5s · 12.3k tokens');
  });

  test('separates multi-line collapsed exec output from the call', () => {
    const rendered = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'unused formatted result' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0.2,
          output: 'one\ntwo',
          exit_code: 0,
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    expect(renderLines(rendered)).toEqual(['', 'one', 'two', '', 'Took 0.2s']);
  });

  test('renders running exec sessions with session status', () => {
    const rendered = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'server ready' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0.1,
          exec_session_id: 7,
          output: 'server ready',
          session_id: 7,
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    expect(renderLines(rendered)).toEqual([
      '',
      'server ready',
      '',
      'Exec #7 still running after 0.1s',
    ]);

    const partial = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'server ready' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0.1,
          exec_session_id: 7,
          output: 'server ready',
          session_id: 7,
        },
      },
      { expanded: false, isPartial: true },
      theme,
    );

    expect(renderLines(partial)).toEqual(['', 'server ready', '', 'Exec #7 elapsed 0.1s']);
  });

  test('renders completed exec sessions with id-aware status', () => {
    const rendered = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'done' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0.3,
          exec_session_id: 15,
          output: 'done',
          exit_code: 0,
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    expect(renderLines(rendered)).toEqual(['', 'done', '', 'Exec #15 exited 0 · Took 0.3s']);
  });

  test('separates one-line collapsed exec output from the call and status', () => {
    const rendered = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'boom' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0.3,
          exec_session_id: 5,
          output: 'boom',
          original_token_count: 2,
          exit_code: 3,
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    expect(renderLines(rendered)).toEqual([
      '',
      'boom',
      '',
      'Exec #5 exited 3 · Took 0.3s · 2 tokens',
    ]);
  });

  test('preserves spacing for embedded exec error statuses', () => {
    const rendered = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'boom\n\nExec #4 exited 3 · Took 0.3s · 2 tokens' }],
      },
      { expanded: false, isPartial: false },
      theme,
      { isError: true },
    );

    expect(renderLines(rendered)).toEqual([
      '',
      'boom',
      '',
      'Exec #4 exited 3 · Took 0.3s · 2 tokens',
    ]);
  });

  test('renders failed exec sessions with id-aware status', () => {
    const rendered = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'failed' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0.4,
          exec_session_id: 15,
          output: 'failed',
          exit_code: 2,
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    expect(renderLines(rendered)).toEqual(['', 'failed', '', 'Exec #15 exited 2 · Took 0.4s']);
  });

  test('renders no-output exec statuses as a single result line', () => {
    expect(
      renderLines(
        renderExecCommandResult(
          {
            content: [{ type: 'text', text: '' }],
            details: {
              chunk_id: 'abc123',
              wall_time_seconds: 0,
              exec_session_id: 11,
              output: '',
              session_id: 11,
            },
          },
          { expanded: false, isPartial: true },
          theme,
        ),
      ),
    ).toEqual(['Exec #11 elapsed 0.0s']);

    expect(
      renderLines(
        renderExecCommandResult(
          {
            content: [{ type: 'text', text: '' }],
            details: {
              chunk_id: 'abc123',
              wall_time_seconds: 5,
              exec_session_id: 11,
              output: '',
              session_id: 11,
            },
          },
          { expanded: false, isPartial: false },
          theme,
        ),
      ),
    ).toEqual(['Exec #11 still running after 5.0s · no output yet']);

    expect(
      renderLines(
        renderExecCommandResult(
          {
            content: [{ type: 'text', text: '' }],
            details: {
              chunk_id: 'abc123',
              wall_time_seconds: 0.2,
              exec_session_id: 11,
              output: '',
              exit_code: 0,
            },
          },
          { expanded: false, isPartial: false },
          theme,
        ),
      ),
    ).toEqual(['Exec #11 exited 0 · Took 0.2s · no output']);
  });

  test('truncates collapsed exec output rows to the render width', () => {
    const veryLongLine = `line ${'x'.repeat(120)}`;
    const rendered = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'unused formatted result' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 1,
          output: ['first hidden line', veryLongLine, 'short middle', veryLongLine].join('\n'),
          exit_code: 0,
        },
      },
      { expanded: false, isPartial: false },
      theme,
    ).render(32);

    expect(rendered.every((line) => visibleWidth(line) <= 32)).toBe(true);
    expect(rendered.some((line) => line.includes('... (1 earlier lines'))).toBe(true);
    expect(rendered.some((line) => line.includes('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'))).toBe(false);
  });

  test('keeps custom exec output rows within the render width', () => {
    const rendered = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'unused formatted result' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0.2,
          output: 'short',
          exit_code: 0,
        },
      },
      { expanded: false, isPartial: false },
      theme,
    ).render(32);

    expect(rendered.every((line) => visibleWidth(line) <= 32)).toBe(true);
    expect(rendered.map((line) => line.trimEnd())).toEqual(['', 'short', '', 'Took 0.2s']);
  });

  test('normalizes tabs to painted spaces in exec output rows', () => {
    const rendered = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'unused formatted result' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0.2,
          output: '320\tname: gemini-2.5-flash',
          exit_code: 0,
        },
      },
      { expanded: false, isPartial: false },
      theme,
    ).render(80);

    const outputLine = rendered.find((line) => line.includes('320')) ?? '';
    expect(outputLine).not.toContain('\t');
    expect(outputLine.trimEnd()).toBe('320   name: gemini-2.5-flash');
    expect(visibleWidth(outputLine)).toBeLessThanOrEqual(80);
  });

  test('keeps collapsed exec ellipsis inside output styling', () => {
    const red = '\u001b[31m';
    const reset = '\u001b[0m';
    const ansiTheme = {
      bold: (text: string) => text,
      fg: (role: string, text: string) => (role === 'toolOutput' ? `${red}${text}${reset}` : text),
    };

    const rendered = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'unused formatted result' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0.2,
          output: 'abcdef',
          exit_code: 0,
        },
      },
      { expanded: false, isPartial: false },
      ansiTheme,
    ).render(5);

    const outputLine = rendered.find((line) => line.includes('abcd'));
    expect(outputLine).toBe(`${red}abcd…${reset}`);
    expect(outputLine).not.toContain(`${reset}…`);
    expect(visibleWidth(outputLine ?? '')).toBe(5);
  });

  test('caps expanded exec output rendering and shows a cutoff hint', () => {
    const output = Array.from({ length: 205 }, (_unused, index) => `line ${index + 1}`).join('\n');
    const rendered = renderExecCommandResult(
      {
        content: [{ type: 'text', text: output }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0.2,
          output,
          exit_code: 0,
        },
      },
      { expanded: true, isPartial: false },
      theme,
    )
      .render(120)
      .map((line) => line.trimEnd());

    expect(rendered.slice(0, 2)).toEqual(['line 1', 'line 2']);
    expect(rendered).toContain(
      '... (45 middle lines omitted; rerun with a narrower command to inspect)',
    );
    expect(rendered).toContain('line 205');
    expect(rendered).not.toContain('line 100');
    expect(rendered).toContain('Took 0.2s');
    expect(rendered.length).toBeLessThan(205);
  });

  test('wraps expanded exec output rows to the render width', () => {
    const output = [
      '===== 2026-06-21T11:09:07-0700 =====',
      '  PID STAT  %CPU %MEM    RSS      TIME COMMAND',
      '61868 S      2.5  0.1  62400   0:11.01 /Users/thinh_nguyen/.local/bin/herdr server',
    ].join('\n');

    const rendered = renderExecCommandResult(
      {
        content: [{ type: 'text', text: output }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0.5,
          exec_session_id: 3,
          output,
          session_id: 3,
        },
      },
      { expanded: true, isPartial: true },
      theme,
    )
      .render(57)
      .map((line) => line.trimEnd());

    expect(rendered.every((line) => visibleWidth(line) <= 57)).toBe(true);
    expect(rendered).toContain('61868 S      2.5  0.1  62400   0:11.01');
    expect(rendered).toContain('/Users/thinh_nguyen/.local/bin/herdr server');
    expect(rendered).toContain('Exec #3 elapsed 0.5s');
  });

  test('expanded exec output keeps head and tail while collapsing the middle', () => {
    const output = Array.from({ length: 240 }, (_unused, index) => `line ${index + 1}`).join('\n');
    const rendered = renderExecCommandResult(
      {
        content: [{ type: 'text', text: output }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0.2,
          output,
          exit_code: 0,
        },
      },
      { expanded: true, isPartial: false },
      theme,
    )
      .render(40)
      .map((line) => line.trimEnd());

    expect(rendered.slice(0, 3)).toEqual(['line 1', 'line 2', 'line 3']);
    expect(rendered.some((line) => line.includes('80 middle lines omitted'))).toBe(true);
    expect(rendered).toContain('line 240');
    expect(rendered).not.toContain('line 120');
  });

  test('renders sed range exec chains as read operations and suppresses successful raw output', () => {
    const command =
      "sed -n '520,620p' src/a.ts && printf '\\n--- b ---\\n' && sed -n '1,220p' src/b.ts";

    expect(
      renderLines(renderExecCommandCall({ cmd: command, yield_time_ms: 50_000 }, theme)),
    ).toEqual([
      'exec 2 operations',
      '✓ read   src/a.ts:520-620 · 101L',
      '✓ read   src/b.ts:1-220 · 220L',
    ]);

    const collapsed = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'raw sed output that should not be shown collapsed' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0.2,
          command,
          output: 'raw sed output that should not be shown collapsed',
          exit_code: 0,
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    expect(renderLines(collapsed)).toEqual(['Took 0.2s']);

    const slowCollapsed = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'raw sed output that should not be shown collapsed' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 1.2,
          command,
          output: 'raw sed output that should not be shown collapsed',
          exit_code: 0,
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    expect(renderLines(slowCollapsed)).toEqual(['Took 1.2s']);
  });

  test('renders multi-file sed range exec calls as read operations and suppresses output', () => {
    const command =
      "sed -n '1,120p' ~/.claude/agents/commit-message-generator.md ~/.claude/agents/gather-git-diff-context.md";
    const state: Record<string, unknown> = {};
    const call = renderExecCommandCall({ cmd: command }, theme, { state });
    const result = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'raw sed output that should not be shown collapsed' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0.2,
          command,
          output: 'raw sed output that should not be shown collapsed',
          original_token_count: 1_800,
          exit_code: 0,
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { args: { cmd: command }, state },
    );

    expect(renderLines(call)).toEqual([
      'exec 2 operations',
      '✓ read   ~/.claude/agents/commit-message-generator.md:1-120 · 120L',
      '✓ read   ~/.claude/agents/gather-git-diff-context.md:1-120 · 120L',
    ]);
    expect(renderLines(result)).toEqual(['Took 0.2s · 1.8k tokens']);
  });

  test('renders multi-read token count in the result without mutating the call', () => {
    const command = "sed -n '1,20p' src/a.ts && sed -n '40,80p' src/b.ts";
    const state: Record<string, unknown> = {};
    const call = renderExecCommandCall({ cmd: command }, theme, { state });
    const result = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'raw output' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0.2,
          command,
          output: 'raw output',
          original_token_count: 2_500,
          exit_code: 0,
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { args: { cmd: command }, state },
    );

    expect(renderLines(call)).toEqual([
      'exec 2 operations',
      '✓ read   src/a.ts:1-20 · 20L',
      '✓ read   src/b.ts:40-80 · 41L',
    ]);
    expect(renderLines(result)).toEqual(['Took 0.2s · 2.5k tokens']);
  });

  test('renders single-read token count in the result without mutating the call', () => {
    const command = "sed -n '1,12p' src/a.ts";
    const state: Record<string, unknown> = {};
    const call = renderExecCommandCall({ cmd: command }, theme, { state });
    const result = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'raw output' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0.2,
          command,
          output: 'raw output',
          original_token_count: 45,
          exit_code: 0,
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { args: { cmd: command }, state },
    );

    expect(renderLines(call)).toEqual(['read src/a.ts:1-12 · 12L']);
    expect(renderLines(result)).toEqual(['Took 0.2s · 45 tokens']);
  });

  test('renders single sed range exec calls as one compact read line', () => {
    expect(
      renderLines(
        renderExecCommandCall(
          { cmd: "sed -n '1,12p' extensions/pi-codex-app-server-use/src/file.txt" },
          theme,
        ),
      ),
    ).toEqual(['read extensions/pi-codex-app-server-use/src/file.txt:1-12 · 12L']);
    expect(
      renderExecCommandCall(
        { cmd: "sed -n '1,12p' extensions/pi-codex-app-server-use/src/file.txt" },
        theme,
      ).render(42),
    ).toEqual(['read extensions/.../file.txt:1-12 · 12L']);
  });

  test('renders newline-separated sed read batches as exec operations', () => {
    const command = `sed -n '1,260p' src/config.rs
printf '\n--- default config git insertion area ---\n'
sed -n '104,174p' src/main.rs
printf '\n--- workspace open ---\n'
sed -n '596,680p' src/workspace.rs
printf '\n--- discovery ---\n'
sed -n '1,160p' src/workspace/git/discovery.rs`;

    expect(renderLines(renderExecCommandCall({ cmd: command }, theme))).toEqual([
      'exec 4 operations',
      '✓ read   src/config.rs:1-260 · 260L',
      '✓ read   src/main.rs:104-174 · 71L',
      '✓ read   src/workspace.rs:596-680 · 85L',
      '✓ read   src/workspace/git/discovery.rs:1-160 · 160L',
    ]);
  });

  test('does not collapse redirected printf typo as read operations', () => {
    const command =
      "sed -n '1,260p' src/config.rs\nprintf '\\n--- default config git insertion area ---\\n' > sed -n '104,174p' src/main.rs";

    expect(renderLines(renderExecCommandCall({ cmd: command }, theme))).toEqual([
      "$ sed -n '1,260p' src/config.rs",
      "> printf '\\n--- default config git insertion area ---\\n' > sed -n '104,174p' src/main.rs",
    ]);
  });

  test('renders expanded sed read batches as full bash input', () => {
    const command =
      "sed -n '1,260p' extensions/bash-rewrite/bash-rewrite.ts\nsed -n '1,260p' extensions/bash-rewrite/bash-rewrite.test.ts";

    expect(renderLines(renderExecCommandCall({ cmd: command }, theme, { expanded: true }))).toEqual(
      [
        "$ sed -n '1,260p' extensions/bash-rewrite/bash-rewrite.ts",
        "> sed -n '1,260p' extensions/bash-rewrite/bash-rewrite.test.ts",
      ],
    );
  });

  test('renders long sed read paths with middle ellipsis before line ranges', () => {
    const command =
      "sed -n '1,12p' extensions/pi-codex-app-server-use/src/file.txt && sed -n '20p' extensions/pi-codex-app-server-use/src/other.txt";

    expect(
      renderExecCommandCall({ cmd: command }, theme)
        .render(50)
        .map((line) => line.trimEnd()),
    ).toEqual([
      'exec 2 operations',
      '✓ read   extensions/.../file.txt:1-12 · 12L',
      '✓ read   extensions/.../other.txt:20 · 1L',
    ]);
  });

  test('renders write_stdin and apply_patch calls compactly', () => {
    expect(renderLines(renderWriteStdinCall({ session_id: 7, chars: 'q' }, theme))).toEqual([
      'exec #7 send 1 char (wait ≤0.3s)',
    ]);
    expect(
      renderLines(renderWriteStdinCall({ session_id: 7, yield_time_ms: 500_000 }, theme)),
    ).toEqual(['exec #7 poll (wait ≤300.0s)']);
    expect(
      renderLines(
        renderApplyPatchCall(
          {
            input:
              '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: src/b.ts\n+ok\n*** End Patch',
          },
          theme,
        ),
      ),
    ).toEqual(
      expect.arrayContaining([expect.stringContaining('edit'), expect.stringContaining('create')]),
    );
  });

  test('renders apply_patch token count in an explicit result status', () => {
    const state: Record<string, unknown> = {};
    const call = renderApplyPatchCall(
      {
        input:
          '*** Begin Patch\n*** Update File: extensions/pi-codex-app-server-use/src/rendering.ts\n@@\n-old\n+new\n*** End Patch',
      },
      theme,
      { state },
    );
    const result = renderApplyPatchResult(
      {
        content: [{ type: 'text', text: 'Applied patch with 1 operation\n' }],
        details: { original_token_count: 45 },
      },
      { expanded: false, isPartial: false },
      theme,
      { state },
    );

    expect(renderLines(call)[0]).toBe('apply_patch 1 operation');
    expect(renderLines(call)[1]).toContain(
      'edit   extensions/pi-codex-app-server-use/src/rendering.ts  +1/-1L · 6B',
    );
    expect(renderLines(call)[1]).not.toContain('✓');
    expect(renderLines(result)).toEqual(['Applied · 45 tokens']);
  });

  test('renders no-output write_stdin results separately from immutable calls', () => {
    const state: Record<string, unknown> = {};
    const call = renderWriteStdinCall({ session_id: 4, yield_time_ms: 5000 }, theme, { state });
    const result = renderExecCommandResult(
      {
        content: [{ type: 'text', text: '' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0,
          exec_session_id: 4,
          output: '',
          exit_code: 0,
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { args: { session_id: 4, yield_time_ms: 5000 }, state },
    );

    expect(renderLines(call)).toEqual(['exec #4 poll (wait ≤5.0s)']);
    expect(renderLines(result)).toEqual(['Exec #4 exited 0 · Took 0.0s · no output']);
  });

  test('renders separate write_stdin result status as muted text', () => {
    const styledTheme = {
      bold: (text: string) => text,
      fg: (role: string, text: string) => (role === 'muted' ? `<muted>${text}</muted>` : text),
    };
    const state: Record<string, unknown> = {};
    const call = renderWriteStdinCall({ session_id: 4, yield_time_ms: 5000 }, styledTheme, {
      state,
    });
    const result = renderExecCommandResult(
      {
        content: [{ type: 'text', text: '' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 0,
          exec_session_id: 4,
          output: '',
          exit_code: 0,
        },
      },
      { expanded: false, isPartial: false },
      styledTheme,
      { args: { session_id: 4, yield_time_ms: 5000 }, state },
    );

    expect(renderLines(call)).toEqual(['exec #4 poll<muted> (wait ≤5.0s)</muted>']);
    expect(renderLines(result)).toEqual([
      '<muted>Exec #4 exited 0 · Took 0.0s · no output</muted>',
    ]);
  });

  test('renders no-output exec status separately from immutable calls', () => {
    const state: Record<string, unknown> = {};
    const call = renderExecCommandCall({ cmd: 'sleep 6', yield_time_ms: 5000 }, theme, { state });
    const result = renderExecCommandResult(
      {
        content: [{ type: 'text', text: '' }],
        details: {
          chunk_id: 'abc123',
          wall_time_seconds: 5,
          exec_session_id: 5,
          output: '',
          session_id: 5,
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { args: { cmd: 'sleep 6', yield_time_ms: 5000 }, state },
    );

    expect(call.render(80).map((line) => line.trimEnd())).toEqual(['$ sleep 6 (wait ≤5.0s)']);
    const narrow = call.render(30).map((line) => line.trimEnd());
    expect(narrow).toEqual(['$ sleep 6 (wait ≤5.0s)']);
    expect(narrow.every((line) => visibleWidth(line) <= 30)).toBe(true);
    expect(renderLines(result)).toEqual(['Exec #5 still running after 5.0s · no output yet']);
  });

  test('clamps long exec command calls to the render width', () => {
    const rendered = renderExecCommandCall(
      {
        cmd: "pwd && ls -la && find .. -maxdepth 3 -name 'models.json' -o -name 'AGENTS.md' -o -name 'package.json'",
        yield_time_ms: 10_000,
      },
      theme,
    ).render(112);

    expect(rendered).toHaveLength(1);
    expect(rendered.every((line) => visibleWidth(line) <= 112)).toBe(true);
  });

  test('keeps command truncation ellipsis inside title styling', () => {
    const reset = '\u001b[0m';
    const styledTheme = {
      bold: (text: string) => text,
      fg: (role: string, text: string) =>
        role === 'toolTitle' ? `\u001b[42m${text}${reset}` : text,
    };

    const [line] = renderExecCommandCall(
      { cmd: `env PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH" cargo test` },
      styledTheme,
    ).render(64);

    expect(line).toContain('…');
    expect(line).not.toContain(`${reset}…`);
    expect(visibleWidth(line ?? '')).toBeLessThanOrEqual(64);
  });

  test('strips terminal controls from raw exec commands before rendering', () => {
    const rendered = renderExecCommandCall(
      { cmd: `printf '\u001b]0;title\u0007\u001b[31m${'x'.repeat(80)}'` },
      theme,
    ).render(40);

    expect(rendered.join('\n')).not.toContain('\u001b');
    expect(rendered.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  test('renders explicit successful apply_patch status and shows failures', () => {
    expect(
      renderLines(
        renderApplyPatchResult(
          { content: [{ type: 'text', text: 'apply_patch completed with no output' }] },
          { expanded: false, isPartial: false },
          theme,
        ),
      ),
    ).toEqual(['Applied']);
    expect(
      renderLines(
        renderApplyPatchResult(
          { content: [{ type: 'text', text: 'apply_patch failed: bad patch' }] },
          { expanded: false, isPartial: false },
          theme,
        ),
      ),
    ).toEqual(['apply_patch failed: bad patch']);
  });

  test('memoizes custom component renders by one current width', () => {
    const call = renderExecCommandCall({ cmd: 'printf hello' }, theme);
    const wideCall = call.render(80);
    expect(call.render(80)).toBe(wideCall);
    const narrowCall = call.render(30);
    expect(narrowCall).not.toBe(wideCall);
    expect(call.render(30)).toBe(narrowCall);
    call.invalidate();
    expect(call.render(30)).not.toBe(narrowCall);

    const result = renderExecCommandResult(
      {
        content: [{ type: 'text', text: 'hello' }],
        details: { output: 'hello', wall_time_seconds: 0.1, exit_code: 0 },
      },
      { expanded: false, isPartial: false },
      theme,
    );
    const wideResult = result.render(80);
    expect(result.render(80)).toBe(wideResult);
    const narrowResult = result.render(30);
    expect(narrowResult).not.toBe(wideResult);
    expect(result.render(30)).toBe(narrowResult);
  });

  test('uses a deterministic completed status when exec metadata is absent', () => {
    expect(
      renderLines(
        renderExecCommandResult(
          { content: [{ type: 'text', text: '' }] },
          { expanded: false, isPartial: false },
          theme,
        ),
      ),
    ).toEqual(['Completed · no output']);
  });

  test('keeps exec calls immutable when no-output results arrive', () => {
    const state: Record<string, unknown> = {};
    const call = renderExecCommandCall({ cmd: 'sleep 1', yield_time_ms: 500 }, theme, { state });
    const before = renderLines(call);
    const result = renderExecCommandResult(
      {
        content: [{ type: 'text', text: '' }],
        details: {
          output: '',
          wall_time_seconds: 0.5,
          exit_code: 0,
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { args: { cmd: 'sleep 1', yield_time_ms: 500 }, state },
    );

    expect(renderLines(call)).toEqual(before);
    expect(renderLines(result)).toEqual(['Took 0.5s · no output']);
  });

  test('renders view_image and computer use calls compactly', () => {
    expect(renderLines(renderViewImageCall({ path: 'scene.png' }, theme))).toEqual([
      '• Viewed Image',
      '  └ scene.png',
    ]);
    const imageLines = renderLines(
      renderViewImageResult(
        { content: [{ type: 'image', mimeType: 'image/png', data: 'abc' }] },
        { expanded: false, isPartial: false },
        theme,
      ),
    );
    expect(imageLines.slice(0, 2)).toEqual(['• Image loaded', '  └ 1 image']);
    expect(imageLines.length).toBeGreaterThan(2);
    expect(
      renderLines(
        renderComputerToolCall(
          'computer_click',
          { app: 'Finder', element_index: '10', click_count: 2 },
          theme,
        ),
      ),
    ).toEqual(['• Clicked', '  └ Finder · #10']);
  });
});
