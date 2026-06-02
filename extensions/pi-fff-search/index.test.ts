import { describe, expect, test, vi } from 'vitest';
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent';

import createPiFffSearchExtensionDefault, {
  bashCommandContainsExpensiveTool,
  createPiFffSearchExtension,
  forwardToolCall,
  renderBashRewritePreview,
  renderBashRewriteResult,
} from './index';
import { runLocalFallback } from './fallback';
import {
  formatCollapsedResultText,
  formatExpandedResultText,
  formatToolCallText,
} from './rendering';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  details?: Record<string, unknown>;
};

type ThemeLike = ReturnType<typeof createTheme>;

type RegisteredTool = {
  name: string;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  renderCall?: (
    args: Record<string, unknown>,
    theme: ThemeLike,
    context?: { cwd: string },
  ) => unknown;
  renderResult?: (
    result: ToolResult,
    state: { expanded: boolean; isPartial: boolean },
    theme: ThemeLike,
    context?: { cwd: string },
  ) => unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    details: Record<string, unknown>;
  }>;
};

type RunRipgrepFallback = NonNullable<Parameters<typeof forwardToolCall>[0]['runRipgrepFallback']>;

function createHarness(options?: Parameters<typeof createPiFffSearchExtension>[0]) {
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
    },
  } as any;

  createPiFffSearchExtension(options)(pi);

  return { tools, handlers };
}

function createTheme() {
  return {
    bold: (text: string) => text,
    fg: (_token: string, text: string) => text,
  };
}

function createTaggedTheme() {
  return {
    bold: (text: string) => `<b>${text}</b>`,
    fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
  };
}

function renderText(component: unknown, width = 120): string {
  expect(component).toMatchObject({ render: expect.any(Function) });
  return (component as { render: (width: number) => string[] }).render(width).join('\n');
}

function renderTextTrimmed(component: unknown, width = 120): string {
  return renderText(component, width)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
}

describe('pi-fff-search rendering helpers', () => {
  test('formats find-files collapsed summary with top paths', () => {
    expect(
      formatCollapsedResultText('fff_find_files', {
        contentText: 'base_path: /repo\n\nsrc/router.ts\nsrc/router.test.ts\nsrc/coordinator.ts',
        details: {
          toolName: 'fff_find_files',
          resolvedWithin: '/repo',
          publicRequest: { tool: 'fff_find_files', query: 'router', within: '/repo' } as any,
        },
      }),
    ).toBe('3 files\n  · src/router.ts\n  · src/router.test.ts\n    … 1 more');
  });

  test('formats search collapsed summary grouped by file counts', () => {
    expect(
      formatCollapsedResultText('fff_search_terms', {
        contentText:
          'base_path: /repo/src\n\nmain.zig:617: try w.interface.print(\nmain.zig:621: try w.interface.flush();\nremote.zig:448: var candidates = try nat.gatherHostCandidates(',
        details: {
          toolName: 'fff_search_terms',
          resolvedWithin: '/repo/src',
          publicRequest: {
            tool: 'fff_search_terms',
            terms: ['interface', 'gatherHostCandidates'],
            within: '/repo/src',
          } as any,
        },
      }),
    ).toBe('2 files · 3 matches\n  · main.zig — 2\n  · remote.zig — 1');
  });

  test('formats expanded grep result with dense file index and top preview', () => {
    expect(
      formatExpandedResultText('fff_grep', {
        contentText:
          'base_path: /repo/src\n\nrouter.ts:10: const planRequest = true;\nrouter.ts:14: planRequest();\nplanner.ts:9: export function planRequest() {}',
        details: {
          toolName: 'fff_grep',
          resolvedWithin: '/repo/src',
          publicRequest: {
            tool: 'fff_grep',
            patterns: ['plan(Request)?'],
            literal: false,
            within: '/repo/src',
          } as any,
        },
      }),
    ).toBe(
      [
        '2 files · 3 matches',
        '  Files',
        '  · router.ts — 2',
        '  · planner.ts — 1',
        '  Top file',
        '  router.ts — 2 matches',
        '    10: const planRequest = true;',
        '    14: planRequest();',
      ].join('\n'),
    );
  });

  test('truncates oversized expanded previews instead of echoing giant single lines', () => {
    const huge = `${'x'.repeat(320)}${'y'.repeat(320)}`;
    const rendered = formatExpandedResultText('fff_search_terms', {
      contentText: `base_path: /repo\n\nthreads/session.json:12: ${huge}`,
      details: {
        toolName: 'fff_search_terms',
        resolvedWithin: '/repo',
        publicRequest: {
          tool: 'fff_search_terms',
          terms: ['session'],
          within: '/repo',
        } as any,
      },
    });

    expect(rendered).toContain('threads/session.json — 1 matches');
    expect(rendered).toContain('[truncated');
    expect(rendered).not.toContain(huge);
  });

  test('formats call text with tool-specific summary and filters', () => {
    expect(
      formatToolCallText('fff_grep', {
        pattern: 'plan(Request)?',
        within: '/repo/src',
        glob: '**/*.ts',
        literal: false,
        case_sensitive: true,
        extensions: ['ts'],
        exclude_paths: ['dist'],
        limit: 5,
      }),
    ).toBe(
      'FFF Grep:  plan(Request)?\n  within: /repo/src  glob: **/*.ts  case-sensitive  ext: ts  exclude: dist  limit: 5',
    );
  });

  test('formats grep call text with a literal indicator when literal=true', () => {
    expect(
      formatToolCallText('fff_grep', {
        patterns: ['provider: "anthropic"'],
        literal: true,
        within: '/repo',
      }),
    ).toBe('FFF Grep:  provider: "anthropic"\n  within: /repo  literal');
  });

  test('omits the literal/regex indicator when literal=false (regex is the default)', () => {
    expect(
      formatToolCallText('fff_grep', {
        patterns: ['plan(Request)?'],
        literal: false,
        within: '/repo',
      }),
    ).toBe('FFF Grep:  plan(Request)?\n  within: /repo');
  });

  test('formats call text for find-files and search-terms without default limit noise', () => {
    expect(formatToolCallText('fff_find_files', { query: 'router', within: '/repo' })).toBe(
      'FFF Find Files:  router\n  within: /repo',
    );
    expect(
      formatToolCallText('fff_search_terms', {
        terms: ['router', 'coordinator'],
        within: '/repo/src',
        limit: 20,
      }),
    ).toBe('FFF Search Terms:  router, coordinator\n  within: /repo/src');
  });

  test('omits placeholder within strings from call text metadata', () => {
    expect(
      formatToolCallText('fff_find_files', {
        query: 'vim mode',
        within: 'undefined',
        glob: '**/*',
        extensions: ['ts', 'md', 'json'],
      }),
    ).toBe('FFF Find Files:  vim mode\n  glob: **/*  ext: ts, md, json');
  });

  test('shortens within paths relative to home when that display is shorter', () => {
    vi.stubEnv('HOME', '/Users/example');
    expect(
      formatToolCallText('fff_find_files', {
        query: 'router',
        within: '/Users/example/workspace/repos/example-repo',
      }),
    ).toBe('FFF Find Files:  router\n  within: ~/workspace/repos/example-repo');
    expect(
      formatToolCallText('fff_find_files', {
        query: 'router',
        within: '/opt/bin/foo',
      }),
    ).toBe('FFF Find Files:  router\n  within: /opt/bin/foo');
    vi.unstubAllEnvs();
  });

  test('shortens within paths relative to renderer cwd when that is clearer than home-relative display', () => {
    vi.stubEnv('HOME', '/Users/example');

    expect(
      formatToolCallText(
        'fff_find_files',
        {
          query: 'router',
          within:
            '/Users/example/workspace/repos/example-monorepo-repo/projects/example-service/src',
        },
        { cwd: '/Users/example/workspace/repos/example-monorepo-repo' },
      ),
    ).toBe('FFF Find Files:  router\n  within: projects/example-service/src');

    vi.unstubAllEnvs();
  });

  test('elides a within-relative prefix from repo-relative result rows', () => {
    expect(
      formatCollapsedResultText('fff_search_terms', {
        contentText:
          'base_path: /repo\n\n' +
          'projects/example-service/src/main/java/com/example/workflow/actions/PlotActions.java:10: alpha\n' +
          'projects/example-service/src/main/java/com/example/workflow/actions/ScouterActions.java:12: beta',
        details: {
          toolName: 'fff_search_terms',
          resolvedWithin:
            '/repo/projects/example-service/src/main/java/com/example/workflow/actions',
          publicRequest: {
            tool: 'fff_search_terms',
            terms: ['alpha', 'beta'],
            within: '/repo/projects/example-service/src/main/java/com/example/workflow/actions',
          } as any,
        },
        cwd: '/repo',
        width: 120,
      }),
    ).toBe(
      ['2 files · 2 matches', '  · PlotActions.java — 1', '  · ScouterActions.java — 1'].join('\n'),
    );
  });

  test('compacts a long file row on narrow widths without repeating the full prefix', () => {
    const rendered = formatCollapsedResultText('fff_search_terms', {
      contentText:
        'base_path: /repo\n\n' +
        'projects/example-service/src/test/java/com/example/example-service/pipeline/generation/workflow/verylongexamplepackagenamewithmanydescriptivewords/SampleWorkflowTest.java:7: alpha',
      details: {
        toolName: 'fff_search_terms',
        resolvedWithin: '/repo/projects/example-service/src/test',
        publicRequest: {
          tool: 'fff_search_terms',
          terms: ['alpha'],
          within: '/repo/projects/example-service/src/test',
        } as any,
      },
      cwd: '/repo',
      width: 40,
    });

    expect(rendered).toContain('1 files · 1 matches');
    expect(rendered).toContain('SampleWorkflowTest');
    expect(rendered).not.toContain('projects/example-service/src/test/java/com/example');
  });

  test('collapses redundant example java package prefixes before generic shrinking', () => {
    const rendered = formatCollapsedResultText('fff_search_terms', {
      contentText:
        'base_path: /repo\n\n' +
        'projects/example-service/src/test/java/com/example/example-service/pipeline/generation/workflow/verylongexamplepackagenamewithmanydescriptivewords/SampleWorkflowTest.java:7: alpha',
      details: {
        toolName: 'fff_search_terms',
        resolvedWithin: '/repo',
        publicRequest: {
          tool: 'fff_search_terms',
          terms: ['alpha'],
          within: '/repo',
        } as any,
      },
      cwd: '/repo',
      width: 150,
    });

    expect(rendered).toContain(
      'src/test/.../pipeline/generation/workflow/verylongexamplepackagenamewithmanydescriptivewords/SampleWorkflowTest.java',
    );
    expect(rendered).not.toContain('src/test/java/com/example/example-service');
  });

  test('does not repeat within lines in no-match display summaries', () => {
    expect(
      formatCollapsedResultText('fff_search_terms', {
        contentText: 'base_path: /repo/src\n\n(no matches)',
        details: {
          toolName: 'fff_search_terms',
          resolvedWithin: '/repo/src',
          publicRequest: {
            tool: 'fff_search_terms',
            terms: ['router'],
            within: '/repo/src',
          } as any,
        },
        cwd: '/repo',
        width: 80,
      }),
    ).toBe('No matches');
    expect(
      formatCollapsedResultText('fff_find_files', {
        contentText: 'base_path: /repo/src\n\n(no files found)',
        details: {
          toolName: 'fff_find_files',
          resolvedWithin: '/repo/src',
          publicRequest: { tool: 'fff_find_files', query: 'router', within: '/repo/src' } as any,
        },
        cwd: '/repo',
        width: 80,
      }),
    ).toBe('0 files');
  });

  test('falls back to compact raw preview when payload is malformed', () => {
    expect(
      formatExpandedResultText('fff_search_terms', {
        contentText: 'not the expected payload',
        details: {
          toolName: 'fff_search_terms',
          resolvedWithin: '/repo',
          publicRequest: { tool: 'fff_search_terms', terms: ['router'], within: '/repo' } as any,
        },
      }),
    ).toContain('not the expected payload');
  });

  test('falls back when base_path header is present without the expected blank separator', () => {
    expect(
      formatExpandedResultText('fff_search_terms', {
        contentText: 'base_path: /repo\nrouter.ts:1: hit',
        details: {
          toolName: 'fff_search_terms',
          resolvedWithin: '/repo',
          publicRequest: { tool: 'fff_search_terms', terms: ['router'], within: '/repo' } as any,
        },
      }),
    ).toBe('base_path: /repo\nrouter.ts:1: hit');
  });
});

describe('pi-fff-search extension', () => {
  test('registers exactly the 2 public tools with Pi-specific stripped schemas', () => {
    const { tools } = createHarness({
      overrideBuiltinRead: false,
      overrideBuiltinGrep: false,
      overrideBuiltinFind: false,
      rewriteBuiltinBash: false,
    });

    expect(tools.map((tool) => tool.name)).toEqual(['fff_find_files', 'fff_grep']);

    const findFilesFields = Object.keys(tools[0]?.parameters.properties ?? {});
    const grepFields = Object.keys(tools[1]?.parameters.properties ?? {});

    expect(findFilesFields).not.toContain('cursor');
    expect(findFilesFields).not.toContain('output_mode');
    expect(grepFields).not.toContain('cursor');
    expect(grepFields).not.toContain('output_mode');
    expect(grepFields).not.toContain('context_lines');
  });

  test('preserves optional fields when stripping Pi-facing fff_grep schema', () => {
    const { tools } = createHarness({
      overrideBuiltinRead: false,
      overrideBuiltinGrep: false,
      overrideBuiltinFind: false,
      rewriteBuiltinBash: false,
    });
    const grepTool = tools.find((tool) => tool.name === 'fff_grep');

    expect(grepTool?.parameters.required).toEqual(['patterns', 'literal']);
    expect(grepTool?.parameters.required).not.toContain('case_sensitive');
    expect(grepTool?.parameters.required).not.toContain('context_lines');
  });

  test('can additionally register builtin read/grep/find overrides without changing default fff tools', () => {
    const { tools } = createHarness({
      overrideBuiltinRead: true,
      overrideBuiltinGrep: true,
      overrideBuiltinFind: true,
      rewriteBuiltinBash: false,
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      'fff_find_files',
      'fff_grep',
      'read',
      'grep',
      'find',
    ]);
  });

  test('also registers the builtin bash rewrite by default', () => {
    const { tools } = createHarness({
      overrideBuiltinRead: false,
      overrideBuiltinGrep: false,
      overrideBuiltinFind: false,
      // rewriteBuiltinBash left unset → defaults to true (REWRITE_BUILTIN_BASH).
    });

    expect(tools.map((tool) => tool.name)).toEqual(['fff_find_files', 'fff_grep', 'bash']);
  });

  test('injects repository search preference guidance into the system prompt', async () => {
    const { handlers } = createHarness();

    const result = (await handlers.get('before_agent_start')?.(
      { type: 'before_agent_start', prompt: 'find something', systemPrompt: 'Base prompt' },
      {},
    )) as { systemPrompt: string };

    expect(result.systemPrompt).toContain('For repository search, prefer `fff_*` tools first');
    expect(result.systemPrompt).toContain('fff_find_files');
    expect(result.systemPrompt).toContain('fff_grep');
    expect(result.systemPrompt).toContain('patterns');
    expect(result.systemPrompt).toContain('base_path:');
    expect(result.systemPrompt).toContain('path:line: text');
  });

  test('registers renderCall and renderResult for all FFF tools', () => {
    const { tools } = createHarness({
      overrideBuiltinRead: false,
      overrideBuiltinGrep: false,
      overrideBuiltinFind: false,
      rewriteBuiltinBash: false,
    });

    for (const tool of tools) {
      expect(typeof tool.renderCall).toBe('function');
      expect(typeof tool.renderResult).toBe('function');
    }
  });

  test('renderCall returns file-oriented summaries across all tools', () => {
    const { tools } = createHarness();
    const theme = createTheme();

    const grepText = renderText(
      tools.find((tool) => tool.name === 'fff_grep')!.renderCall!(
        {
          patterns: ['plan(Request)?', 'build(Request)?'],
          within: '/repo/src',
          case_sensitive: true,
        },
        theme,
      ),
    );
    const findText = renderText(
      tools.find((tool) => tool.name === 'fff_find_files')!.renderCall!(
        { query: 'router', within: '/repo/src' },
        theme,
      ),
    );
    expect(grepText.trimEnd()).toBe(
      'fff_grep  plan(Request)? | build(Request)?  within=/repo/src · case-sensitive',
    );
    expect(findText.trimEnd()).toBe('fff_find_files  router  within=/repo/src');
  });

  test('direct FFF renderCall styles compact call parts', () => {
    const { tools } = createHarness();
    const theme = createTaggedTheme();

    const rendered = tools.find((tool) => tool.name === 'fff_grep')!.renderCall!(
      {
        patterns: ['alpha|beta'],
        within: 'src',
        glob: '*.ts',
        limit: 50,
      },
      theme,
      { cwd: '/repo' } as any,
    );

    expect(renderTextTrimmed(rendered, 160)).toBe(
      '<toolTitle><b>fff_grep</b></toolTitle>  <accent>alpha | beta</accent>  <dim>within=src · glob=*.ts · limit=50</dim>',
    );
  });

  test('builtin grep override renderCall uses a compact FFF rewrite summary by default', () => {
    const { tools } = createHarness({
      overrideBuiltinRead: false,
      overrideBuiltinGrep: true,
      overrideBuiltinFind: false,
    });
    const theme = createTheme();

    const rendered = tools.find((tool) => tool.name === 'grep')!.renderCall!(
      {
        pattern: 'createReadTool\\(|createGrepTool\\(|createFindTool\\(',
        path: 'node_modules',
        glob: '**/*.{ts,js,mjs,cjs}',
        limit: 50,
      },
      theme,
      { cwd: '/repo' } as any,
    );

    expect(renderTextTrimmed(rendered, 220)).toBe(
      'grep → fff_grep  createReadTool\\( | createGrepTool\\( | createFindTool\\(  within=node_modules · glob=**/*.{ts,js,mjs,cjs} · limit=50',
    );
  });

  test('builtin grep override renderCall styles compact rewritten call parts', () => {
    const { tools } = createHarness({
      overrideBuiltinRead: false,
      overrideBuiltinGrep: true,
      overrideBuiltinFind: false,
    });
    const theme = createTaggedTheme();

    const rendered = tools.find((tool) => tool.name === 'grep')!.renderCall!(
      {
        pattern: 'warning',
        path: 'src',
        ignoreCase: true,
      },
      theme,
      { cwd: '/repo' } as any,
    );

    expect(renderTextTrimmed(rendered, 160)).toBe(
      '<dim>grep → </dim><toolTitle><b>fff_grep</b></toolTitle>  <accent>warning</accent>  <dim>within=src · ignoreCase</dim>',
    );
  });

  test('builtin grep override renderCall preserves ignoreCase in compact FFF summaries', () => {
    const { tools } = createHarness({
      overrideBuiltinRead: false,
      overrideBuiltinGrep: true,
      overrideBuiltinFind: false,
    });
    const theme = createTheme();

    const rendered = tools.find((tool) => tool.name === 'grep')!.renderCall!(
      {
        pattern: 'warning',
        path: 'src',
        ignoreCase: true,
      },
      theme,
      { cwd: '/repo' } as any,
    );

    expect(renderTextTrimmed(rendered, 120)).toBe(
      'grep → fff_grep  warning  within=src · ignoreCase',
    );
  });

  test('builtin grep override renderCall collapses long compact rewrite paths by width', () => {
    const { tools } = createHarness({
      overrideBuiltinRead: false,
      overrideBuiltinGrep: true,
      overrideBuiltinFind: false,
    });
    const theme = createTheme();

    const rendered = tools.find((tool) => tool.name === 'grep')!.renderCall!(
      {
        pattern: 'getToolDefinition|toolCallId|definition.execute|execute\\(',
        path: '/Users/thinh/.cache/aube/virtual-store/@earendil-works+pi-coding-agent@0.78.0_ws@8.21.0_zod@4.4.3_-954be6349bfa0d7d/node_modules/@earendil-works/pi-coding-agent/dist/core',
        glob: '*.js',
        context: 4,
        limit: 200,
      },
      theme,
      { cwd: '/Users/thinh/Projects/pi-toolbox' } as any,
    );

    const lines = renderTextTrimmed(rendered, 96).split('\n');
    expect(lines).toEqual([
      'grep → fff_grep  getToolDefinition | toolCallId | definition.execute | execute\\(',
      '  within=~/.../pi-coding-agent/dist/core · glob=*.js · ctx=4 · limit=200',
    ]);
    expect(lines.every((line) => line.length <= 96)).toBe(true);
  });

  test('builtin grep override renderCall survives a non-Text lastComponent from a previous frame', () => {
    // Regression: the outer tool-render context re-uses lastComponent across
    // frames. On the second frame it contains the wrapper returned by the
    // previous renderCall (a width-aware text / box-like component), not a
    // bare `Text`. If we forwarded that context into the builtin's
    // renderCall, the builtin would call `.setText(...)` on a component that
    // doesn't have one and crash the TUI:
    //   TypeError: text.setText is not a function
    const { tools } = createHarness({
      overrideBuiltinRead: false,
      overrideBuiltinGrep: true,
      overrideBuiltinFind: false,
    });
    const theme = createTheme();
    const grep = tools.find((tool) => tool.name === 'grep')!;

    const firstFrame = grep.renderCall!(
      {
        pattern: 'plan(Request)?',
        path: 'src',
        glob: '**/*.ts',
      },
      theme,
      { cwd: '/repo' } as any,
    ) as { render: (width: number) => unknown };
    // Force the first frame to finish lazy layout so any cached inner
    // primitives get populated the way they would in a real TUI loop.
    firstFrame.render(120);

    // The second frame is where the crash would fire: pi-tui passes the
    // previous frame's wrapper component in as `lastComponent`, the builtin
    // picks it up expecting a `Text`, and calls `.setText(...)` on it. The
    // render must be materialized (width-aware text is lazy) for the
    // builtin's renderCall to actually execute.
    const secondFrame = grep.renderCall!(
      {
        pattern: 'plan(Request)?',
        path: 'src',
        glob: '**/*.ts',
      },
      theme,
      { cwd: '/repo', lastComponent: firstFrame } as any,
    ) as { render: (width: number) => unknown };
    expect(() => secondFrame.render(120)).not.toThrow();
  });

  test('builtin find override renderCall keeps compact metadata to two lines on narrow screens', () => {
    const { tools } = createHarness({
      overrideBuiltinRead: false,
      overrideBuiltinGrep: false,
      overrideBuiltinFind: true,
    });
    const theme = createTheme();

    const rendered = tools.find((tool) => tool.name === 'find')!.renderCall!(
      {
        pattern: 'extensions/pi-fff-search/**/*rewrite*.ts',
        path: '.',
        limit: 20,
      },
      theme,
      { cwd: '/Users/thinh/Projects/pi-toolbox' } as any,
    );

    const lines = renderTextTrimmed(rendered, 58).split('\n');
    expect(lines).toEqual([
      'find → fff_find_files  rewrite',
      '  within=extensions/... · glob=**/*rewrite*.ts · limit=20',
    ]);
    expect(lines.every((line) => line.length <= 58)).toBe(true);
  });

  test('builtin find override renderCall uses a compact FFF rewrite summary by default', () => {
    const { tools } = createHarness({
      overrideBuiltinRead: false,
      overrideBuiltinGrep: false,
      overrideBuiltinFind: true,
    });
    const theme = createTheme();

    const rendered = tools.find((tool) => tool.name === 'find')!.renderCall!(
      {
        pattern: 'extensions/**/index.test.ts',
        path: '.',
        limit: 20,
      },
      theme,
      { cwd: '/repo' } as any,
    );

    expect(renderTextTrimmed(rendered, 220)).toBe(
      'find → fff_find_files  index  within=extensions · glob=**/index.test.ts · limit=20',
    );
  });

  test('builtin find override renderCall omits via FFF details when the pattern is not rewritten', () => {
    const { tools } = createHarness({
      overrideBuiltinRead: false,
      overrideBuiltinGrep: false,
      overrideBuiltinFind: true,
    });
    const theme = createTheme();

    const rendered = tools.find((tool) => tool.name === 'find')!.renderCall!(
      {
        pattern: 'scratch/**',
        path: '.',
        limit: 20,
      },
      theme,
      { cwd: '/repo' } as any,
    );

    expect(renderTextTrimmed(rendered, 220)).toBe('find scratch/** in . (limit 20)');
  });

  test('builtin read override shortens absolute paths in the call display', () => {
    const { tools } = createHarness({
      overrideBuiltinRead: true,
      overrideBuiltinGrep: false,
      overrideBuiltinFind: false,
      rewriteBuiltinBash: false,
    });
    const theme = createTheme();
    const read = tools.find((tool) => tool.name === 'read')!;

    const call = read.renderCall!(
      {
        path: '/Users/example/airlab/repos/treehouse/projects/sceptile/src/test/java/com/airbnb/sceptile/component/inventory/staticjson/ProtectionPlanStaticInventoryTest.java',
        offset: 700,
        limit: 190,
      },
      theme,
      {
        cwd: '/Users/example/airlab/repos/treehouse',
      } as any,
    );

    expect(renderTextTrimmed(call, 120)).toBe(
      'read projects/sceptile/src/test/.../staticjson/ProtectionPlanStaticInventoryTest.java:700-889 (ctrl+o to expand)',
    );
  });

  test('builtin read override preserves title, path, and range colors', () => {
    const { tools } = createHarness({
      overrideBuiltinRead: true,
      overrideBuiltinGrep: false,
      overrideBuiltinFind: false,
      rewriteBuiltinBash: false,
    });
    const theme = createTaggedTheme();
    const read = tools.find((tool) => tool.name === 'read')!;

    const call = read.renderCall!({ path: 'src/router.ts', offset: 20, limit: 5 }, theme, {
      cwd: '/repo',
      expanded: false,
    } as any);

    expect(renderTextTrimmed(call, 120)).toBe(
      '<toolTitle><b>read</b></toolTitle> <accent>src/router.ts</accent><warning>:20-24</warning><dim> (ctrl+o to expand)</dim>',
    );
  });

  test('builtin read override hides file contents in collapsed result', () => {
    const { tools } = createHarness({
      overrideBuiltinRead: true,
      overrideBuiltinGrep: false,
      overrideBuiltinFind: false,
      rewriteBuiltinBash: false,
    });
    const theme = createTheme();
    const read = tools.find((tool) => tool.name === 'read')!;

    const call = read.renderCall!({ path: 'src/router.ts', offset: 20, limit: 5 }, theme, {
      cwd: '/repo',
      expanded: false,
    } as any);
    const result = read.renderResult!(
      {
        content: [{ type: 'text', text: 'line 20\nline 21\nline 22' }],
      },
      { expanded: false, isPartial: false },
      theme,
      {
        args: { path: 'src/router.ts', offset: 20, limit: 5 },
        cwd: '/repo',
        showImages: false,
        isError: false,
      } as any,
    );

    expect(renderTextTrimmed(call, 120)).toBe('read src/router.ts:20-24 (ctrl+o to expand)');
    expect(renderTextTrimmed(result, 120)).toBe('');
  });

  test('builtin grep override summarizes collapsed results by file', () => {
    const { tools } = createHarness({
      overrideBuiltinRead: false,
      overrideBuiltinGrep: true,
      overrideBuiltinFind: false,
      rewriteBuiltinBash: false,
    });
    const theme = createTheme();
    const grep = tools.find((tool) => tool.name === 'grep')!;

    const rendered = grep.renderResult!(
      {
        content: [
          {
            type: 'text',
            text: 'router.ts:10: alpha\nrouter.ts:12: beta\nplanner.ts:5: gamma\nother.ts:3: delta',
          },
        ],
      },
      { expanded: false, isPartial: false },
      theme,
      { cwd: '/repo', showImages: false } as any,
    );

    expect(renderTextTrimmed(rendered, 120)).toBe(
      ['3 files · 4 matches', '  · router.ts — 2', '  · other.ts — 1', '    … 1 more files'].join(
        '\n',
      ),
    );
  });

  test('builtin find override summarizes collapsed results like fff_find_files', () => {
    const { tools } = createHarness({
      overrideBuiltinRead: false,
      overrideBuiltinGrep: false,
      overrideBuiltinFind: true,
      rewriteBuiltinBash: false,
    });
    const theme = createTheme();
    const find = tools.find((tool) => tool.name === 'find')!;

    const rendered = find.renderResult!(
      {
        content: [
          {
            type: 'text',
            text: 'src/router.ts\nsrc/router.test.ts\nsrc/coordinator.ts\n\n[1000 results limit reached]',
          },
        ],
      },
      { expanded: false, isPartial: false },
      theme,
      { cwd: '/repo', showImages: false } as any,
    );

    expect(renderTextTrimmed(rendered, 120)).toBe(
      ['3 files', '  · src/router.ts', '  · src/router.test.ts', '    … 1 more'].join('\n'),
    );
  });

  test('renderCall shortens within using renderer cwd when available', () => {
    vi.stubEnv('HOME', '/Users/example');
    const { tools } = createHarness();
    const theme = createTheme();

    const rendered = tools.find((tool) => tool.name === 'fff_find_files')!.renderCall!(
      {
        query: 'router',
        within: '/Users/example/workspace/repos/example-monorepo-repo/projects/example-service/src',
      },
      theme,
      { cwd: '/Users/example/workspace/repos/example-monorepo-repo' },
    );

    expect(renderText(rendered)).toContain('within=projects/example-service/src');
    vi.unstubAllEnvs();
  });

  test('renderCall reflows metadata at segment boundaries on narrow widths', () => {
    const { tools } = createHarness();
    const theme = createTheme();

    const rendered = tools.find((tool) => tool.name === 'fff_find_files')!.renderCall!(
      {
        query: 'vim mode',
        within: 'undefined',
        glob: '**/*',
        extensions: ['ts', 'md', 'json'],
        exclude_paths: ['dist', 'coverage', 'node_modules'],
        limit: 100,
      },
      theme,
    );

    expect(renderTextTrimmed(rendered, 45)).toBe(
      [
        'fff_find_files  vim mode',
        '  glob=**/* · ext=ts,md,json ·',
        'exclude=dist,coverage,node_modules ·',
        'limit=100',
      ].join('\n'),
    );
  });

  test('renderResult shows collapsed file-first summary', () => {
    const { tools } = createHarness();
    const tool = tools.find((candidate) => candidate.name === 'fff_grep');
    const theme = createTheme();

    const rendered = tool!.renderResult!(
      {
        content: [
          {
            type: 'text',
            text: 'base_path: /repo\n\nmain.zig:1: alpha\nmain.zig:2: beta\nother.zig:4: gamma',
          },
        ],
        details: {
          toolName: 'fff_grep',
          resolvedWithin: '/repo',
          publicRequest: { tool: 'fff_grep', patterns: ['alpha'], within: '/repo' },
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    expect(renderText(rendered)).toContain('2 files · 3 matches');
  });

  test('renderResult uses width-aware formatting instead of relying on incidental Text wrapping', () => {
    const { tools } = createHarness();
    const tool = tools.find((candidate) => candidate.name === 'fff_grep');
    const theme = createTheme();

    const rendered = tool!.renderResult!(
      {
        content: [
          {
            type: 'text',
            text:
              'base_path: /repo\n\n' +
              'projects/example-service/src/test/java/com/example/example-service/pipeline/generation/workflow/verylongexamplepackagenamewithmanydescriptivewords/SampleWorkflowTest.java:7: alpha',
          },
        ],
        details: {
          toolName: 'fff_grep',
          resolvedWithin: '/repo/projects/example-service/src/test',
          publicRequest: {
            tool: 'fff_grep',
            patterns: ['alpha'],
            literal: false,
            within: '/repo/projects/example-service/src/test',
          },
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { cwd: '/repo' },
    );

    const text = renderText(rendered, 40);
    expect(text).toContain('SampleWorkflowTest');
    expect(text).not.toContain('projects/example-service/src/test/java/com/example');
  });

  test('renderResult shows collapsed grep summary grouped by file', () => {
    const { tools } = createHarness();
    const tool = tools.find((candidate) => candidate.name === 'fff_grep');
    const theme = createTheme();

    const rendered = tool!.renderResult!(
      {
        content: [
          {
            type: 'text',
            text: 'base_path: /repo\n\nrouter.ts:10: a\nrouter.ts:11: b\nplanner.ts:2: c',
          },
        ],
        details: {
          toolName: 'fff_grep',
          resolvedWithin: '/repo',
          publicRequest: { tool: 'fff_grep', patterns: ['a'], within: '/repo' },
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    expect(renderText(rendered)).toContain('2 files · 3 matches');
  });

  test('renderResult shows expanded navigator list for grep', () => {
    const { tools } = createHarness();
    const tool = tools.find((candidate) => candidate.name === 'fff_grep');
    const theme = createTheme();

    const rendered = tool!.renderResult!(
      {
        content: [
          {
            type: 'text',
            text: 'base_path: /repo\n\nrouter.ts:10: a\nrouter.ts:11: b\nplanner.ts:2: c',
          },
        ],
        details: {
          toolName: 'fff_grep',
          resolvedWithin: '/repo',
          publicRequest: { tool: 'fff_grep', patterns: ['a'], within: '/repo' },
        },
      },
      { expanded: true, isPartial: false },
      theme,
    );

    const text = renderText(rendered);
    expect(text).toContain('router.ts — 2');
    expect(text).toContain('Top file');
  });

  test('renderResult shows expanded navigator list for find-files without preview block', () => {
    const { tools } = createHarness();
    const tool = tools.find((candidate) => candidate.name === 'fff_find_files');
    const theme = createTheme();

    const rendered = tool!.renderResult!(
      {
        content: [
          {
            type: 'text',
            text: 'base_path: /repo\n\nsrc/router.ts\nsrc/router.test.ts\nsrc/coordinator.ts',
          },
        ],
        details: {
          toolName: 'fff_find_files',
          resolvedWithin: '/repo',
          publicRequest: { tool: 'fff_find_files', query: 'router', within: '/repo' },
        },
      },
      { expanded: true, isPartial: false },
      theme,
    );

    const text = renderText(rendered);
    expect(text).toContain('src/router.ts');
    expect(text).not.toContain('Top file');
  });

  test('renderResult shows compact partial and empty states with scope context', () => {
    const { tools } = createHarness();
    const findTool = tools.find((candidate) => candidate.name === 'fff_find_files');
    const grepTool = tools.find((candidate) => candidate.name === 'fff_grep');
    const theme = createTheme();

    const partial = findTool!.renderResult!(
      {
        content: [{ type: 'text', text: 'Searching…' }],
        details: {
          toolName: 'fff_find_files',
          resolvedWithin: '/repo',
          publicRequest: { tool: 'fff_find_files', query: 'router', within: '/repo' },
        },
      },
      { expanded: false, isPartial: true },
      theme,
    );

    const searchPartial = grepTool!.renderResult!(
      {
        content: [{ type: 'text', text: 'Searching…' }],
        details: {
          toolName: 'fff_grep',
          resolvedWithin: '/repo/src',
          publicRequest: {
            tool: 'fff_grep',
            patterns: ['router', 'coordinator'],
            literal: false,
            within: '/repo/src',
          },
        },
      },
      { expanded: false, isPartial: true },
      theme,
    );

    const empty = findTool!.renderResult!(
      {
        content: [{ type: 'text', text: 'base_path: /repo\n\n(no files found)' }],
        details: {
          toolName: 'fff_find_files',
          resolvedWithin: '/repo',
          publicRequest: { tool: 'fff_find_files', query: 'router', within: '/repo' },
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    expect(renderText(partial)).toContain('Finding files');
    expect(renderText(searchPartial)).toContain('router | coordinator');
    expect(renderText(empty)).toContain('0 files');
    expect(renderText(empty)).not.toContain('/repo');
  });

  test('renderResult preserves explicit tool errors with compact heading', () => {
    const { tools } = createHarness();
    const tool = tools.find((candidate) => candidate.name === 'fff_grep');
    const theme = createTheme();

    const rendered = tool!.renderResult!(
      {
        content: [{ type: 'text', text: 'Error: OUTSIDE_ALLOWED_SCOPE: outside repo\nstack line' }],
        details: {
          toolName: 'fff_grep',
          resolvedWithin: '/repo',
          publicRequest: { tool: 'fff_grep', patterns: ['x'], within: '/repo' },
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    const text = renderText(rendered);
    expect(text).toContain('Search failed');
    expect(text).toContain('Error: OUTSIDE_ALLOWED_SCOPE');
    expect(text).not.toContain('stack line');
  });

  test('renderResult shows scope warnings plus fallback results without a hard failure heading', () => {
    const { tools } = createHarness();
    const tool = tools.find((candidate) => candidate.name === 'fff_find_files');
    const theme = createTheme();

    const rendered = tool!.renderResult!(
      {
        content: [
          {
            type: 'text',
            text: [
              'Warning: FFF unavailable for this within path only; auto-retried with a local search fallback.',
              'within: /Users/example/.pi/agent',
              'FFF still works for other within paths that are inside git repos or allowlisted prefixes.',
              "To enable FFF here too, add a parent prefix such as '~/.pi' to the allowlist in ~/.config/fff-routerd/config.json or config.jsonc.",
              'The daemon reloads this file automatically; no Pi restart is required.',
              '',
              'base_path: /Users/example/.pi/agent',
              '',
              'tests/sync-common-settings.test.ts',
            ].join('\n'),
          },
        ],
        details: {
          toolName: 'fff_find_files',
          resolvedWithin: '/Users/example/.pi/agent',
          publicRequest: {
            tool: 'fff_find_files',
            query: 'sync-common-settings',
            within: '/Users/example/.pi/agent',
          },
          resultKind: 'scope_warning',
          scopeWarningText: [
            'Warning: FFF unavailable for this within path only; auto-retried with a local search fallback.',
            'within: /Users/example/.pi/agent',
            'FFF still works for other within paths that are inside git repos or allowlisted prefixes.',
            "To enable FFF here too, add a parent prefix such as '~/.pi' to the allowlist in ~/.config/fff-routerd/config.json or config.jsonc.",
            'The daemon reloads this file automatically; no Pi restart is required.',
          ].join('\n'),
          fallbackText:
            'base_path: /Users/example/.pi/agent\n\n' + 'tests/sync-common-settings.test.ts',
          fallbackEngine: 'ripgrep',
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    const text = renderText(rendered);
    expect(text).toContain(
      '⚠ FFF unavailable for this path; local fallback used. Expand for allowlist fix.',
    );
    expect(text).not.toContain('To enable FFF here too');
    expect(text).toContain('1 files');
    expect(text).toContain('tests/sync-common-settings.test.ts');
    expect(text).not.toContain('Search failed');
  });

  test('renderResult does not duplicate the warning text when scope fallback fails', () => {
    const { tools } = createHarness();
    const tool = tools.find((candidate) => candidate.name === 'fff_find_files');
    const theme = createTheme();
    const warning = [
      'Warning: FFF unavailable for this within path only; auto-retried with a local search fallback.',
      'within: /Users/example/.pi/agent',
      'FFF still works for other within paths that are inside git repos or allowlisted prefixes.',
      'Use builtin search tools for this path until FFF is enabled here.',
    ].join('\n');

    const rendered = tool!.renderResult!(
      {
        content: [{ type: 'text', text: warning }],
        details: {
          toolName: 'fff_find_files',
          resolvedWithin: '/Users/example/.pi/agent',
          publicRequest: {
            tool: 'fff_find_files',
            query: 'sync-common-settings',
            within: '/Users/example/.pi/agent',
          },
          resultKind: 'scope_warning',
          scopeWarningText: warning,
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    const renderedText = renderText(rendered);
    expect(renderedText.match(/FFF unavailable for this path/g)?.length).toBe(1);
    expect(renderedText).not.toContain('0 files');
    expect(renderedText).not.toContain('Search failed');
  });

  test('renderResult falls back to condensed raw text when parsing fails', () => {
    const { tools } = createHarness();
    const tool = tools.find((candidate) => candidate.name === 'fff_grep');
    const theme = createTheme();

    const rendered = tool!.renderResult!(
      {
        content: [{ type: 'text', text: 'unexpected payload\nwith raw lines\nthat do not parse' }],
        details: {
          toolName: 'fff_grep',
          resolvedWithin: '/repo',
          publicRequest: { tool: 'fff_grep', patterns: ['raw'], within: '/repo' },
        },
      },
      { expanded: true, isPartial: false },
      theme,
    );

    expect(renderText(rendered)).toContain('unexpected payload');
  });

  test('renderResult falls back when a base_path header is malformed', () => {
    const { tools } = createHarness();
    const tool = tools.find((candidate) => candidate.name === 'fff_grep');
    const theme = createTheme();

    const rendered = tool!.renderResult!(
      {
        content: [{ type: 'text', text: 'base_path: /repo\nrouter.ts:1: hit' }],
        details: {
          toolName: 'fff_grep',
          resolvedWithin: '/repo',
          publicRequest: { tool: 'fff_grep', patterns: ['raw'], within: '/repo' },
        },
      },
      { expanded: true, isPartial: false },
      theme,
    );

    const text = renderText(rendered);
    expect(text).toContain('base_path: /repo');
    expect(text).toContain('router.ts:1: hit');
  });

  test('defaults omitted within to the Pi caller cwd and formats find-files output as text', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/repo',
        next_cursor: null,
        items: [{ path: 'router.ts' }, { path: 'coordinator.ts' }],
      },
    }));

    const result = await forwardToolCall({
      toolName: 'fff_find_files',
      params: { query: 'router' },
      cwd: '/repo',
      ensureDaemonRunning,
      callPublicToolOverHttp,
    });

    expect(ensureDaemonRunning).toHaveBeenCalledTimes(1);
    expect(callPublicToolOverHttp).toHaveBeenCalledWith({
      tool: 'fff_find_files',
      query: 'router',
      within: ['/repo'],
      extensions: [],
      excludePaths: [],
      limit: 20,
      cursor: null,
      outputMode: 'compact',
    });
    expect(result.text).toBe('base_path: /repo\n\nrouter.ts\ncoordinator.ts');
  });

  test('repairs common fff_grep alias fields before validation', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/repo/src',
        next_cursor: null,
        items: [{ path: 'app.ts', line: 1, text: 'createRouter()' }],
      },
    }));

    await forwardToolCall({
      toolName: 'fff_grep',
      params: {
        query: 'createRouter',
        path: 'src',
        glob: '*.ts',
        exclude_paths: '["node_modules"]',
        case_sensitive: false,
      },
      cwd: '/repo',
      ensureDaemonRunning,
      callPublicToolOverHttp,
    });

    expect(callPublicToolOverHttp).toHaveBeenCalledWith({
      tool: 'fff_grep',
      patterns: ['createRouter'],
      literal: true,
      within: ['/repo/src'],
      glob: '*.ts',
      caseSensitive: false,
      extensions: [],
      excludePaths: ['node_modules'],
      contextLines: 0,
      limit: 20,
      cursor: null,
      outputMode: 'compact',
    });
  });

  test('repairs bare fff_find_files strings to query objects', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/repo',
        next_cursor: null,
        items: [{ path: 'router.ts' }],
      },
    }));

    await forwardToolCall({
      toolName: 'fff_find_files',
      params: '**/*router*.ts' as unknown as Record<string, unknown>,
      cwd: '/repo',
      ensureDaemonRunning,
      callPublicToolOverHttp,
    });

    expect(callPublicToolOverHttp).toHaveBeenCalledWith({
      tool: 'fff_find_files',
      query: 'router',
      within: ['/repo'],
      glob: '**/*router*.ts',
      extensions: [],
      excludePaths: [],
      limit: 20,
      cursor: null,
      outputMode: 'compact',
    });
  });

  test('builtin grep override uses fff first and returns builtin-style grep output', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/repo',
        next_cursor: null,
        items: [{ path: 'router.ts', line: 3, text: 'createRouter()' }],
      },
    }));
    const builtinExecute = vi.fn(async () => {
      throw new Error('builtin grep should not run');
    });
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      overrideBuiltinGrep: true,
      createBuiltInGrepTool: ((cwd: string) => ({
        ...createGrepToolDefinition(cwd),
        execute: builtinExecute,
      })) as any,
    });

    const result = await tools
      .find((tool) => tool.name === 'grep')!
      .execute('tool-call', { pattern: 'createRouter' }, undefined, undefined, { cwd: '/repo' });

    expect(callPublicToolOverHttp).toHaveBeenCalledWith({
      tool: 'fff_grep',
      patterns: ['createRouter'],
      literal: false,
      within: ['/repo'],
      caseSensitive: true,
      extensions: [],
      excludePaths: [],
      contextLines: 0,
      limit: 20,
      cursor: null,
      outputMode: 'compact',
    });
    expect(result.content).toEqual([{ type: 'text', text: 'router.ts:3: createRouter()' }]);
    expect(builtinExecute).not.toHaveBeenCalled();
  });

  test('builtin grep override falls back to builtin grep on zero fff results using the original request', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/repo',
        next_cursor: null,
        items: [],
      },
    }));
    const builtinExecute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'builtin grep fallback result' }],
      details: undefined,
    }));
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      overrideBuiltinGrep: true,
      createBuiltInGrepTool: ((cwd: string) => ({
        ...createGrepToolDefinition(cwd),
        execute: builtinExecute,
      })) as any,
    });

    const params = {
      pattern: 'createRouter',
      path: 'src',
      glob: '**/*.ts',
      limit: 50,
    };
    const result = await tools
      .find((tool) => tool.name === 'grep')!
      .execute('tool-call', params, undefined, undefined, { cwd: '/repo' });

    expect(result.content).toEqual([{ type: 'text', text: 'builtin grep fallback result' }]);
    expect(builtinExecute).toHaveBeenCalledWith(
      'tool-call',
      params,
      expect.objectContaining({ aborted: false }),
      undefined,
      { cwd: '/repo' },
    );
  });

  test('builtin grep override uses escaped suspicious retry results before falling back to builtin grep', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          mode: 'compact' as const,
          base_path: '/repo/internal',
          next_cursor: null,
          items: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          mode: 'compact' as const,
          base_path: '/repo/internal',
          next_cursor: null,
          items: [{ path: 'core/validate.go', line: 24, text: 'func Validate(' }],
        },
      });
    const builtinExecute = vi.fn(async () => {
      throw new Error('builtin grep should not run');
    });
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      overrideBuiltinGrep: true,
      createBuiltInGrepTool: ((cwd: string) => ({
        ...createGrepToolDefinition(cwd),
        execute: builtinExecute,
      })) as any,
    });

    const result = await tools
      .find((tool) => tool.name === 'grep')!
      .execute('tool-call', { pattern: 'Validate(', path: 'internal' }, undefined, undefined, {
        cwd: '/repo',
      });

    expect(callPublicToolOverHttp).toHaveBeenNthCalledWith(1, {
      tool: 'fff_grep',
      patterns: ['Validate('],
      literal: false,
      within: ['/repo/internal'],
      caseSensitive: true,
      extensions: [],
      excludePaths: [],
      contextLines: 0,
      limit: 20,
      cursor: null,
      outputMode: 'compact',
    });
    expect(callPublicToolOverHttp).toHaveBeenNthCalledWith(2, {
      tool: 'fff_grep',
      // The repair now flips to literal:true rather than regex-escaping the pattern
      // locally; fff-router routes literal:true through multi_grep where the
      // original `Validate(` is matched as bytes.
      patterns: ['Validate('],
      literal: true,
      within: ['/repo/internal'],
      caseSensitive: true,
      extensions: [],
      excludePaths: [],
      contextLines: 0,
      limit: 20,
      cursor: null,
      outputMode: 'compact',
    });
    expect(result.content).toEqual([{ type: 'text', text: 'core/validate.go:24: func Validate(' }]);
    expect(builtinExecute).not.toHaveBeenCalled();
  });

  test('builtin find override tokenizes wildcard basenames for fff queries', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/repo',
        next_cursor: null,
        items: [{ path: 'src/router.ts' }, { path: 'src/coordinator.ts' }],
      },
    }));
    const builtinExecute = vi.fn(async () => {
      throw new Error('builtin find should not run');
    });
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      overrideBuiltinFind: true,
      createBuiltInFindTool: ((cwd: string) => ({
        ...createFindToolDefinition(cwd),
        execute: builtinExecute,
      })) as any,
    });

    const result = await tools
      .find((tool) => tool.name === 'find')!
      .execute('tool-call', { pattern: '**/*slack*' }, undefined, undefined, { cwd: '/repo' });

    expect(callPublicToolOverHttp).toHaveBeenCalledWith({
      tool: 'fff_find_files',
      query: 'slack',
      within: ['/repo'],
      glob: '**/*slack*',
      extensions: [],
      excludePaths: [],
      limit: 20,
      cursor: null,
      outputMode: 'compact',
    });
    expect(result.content).toEqual([{ type: 'text', text: 'src/router.ts\nsrc/coordinator.ts' }]);
    expect(builtinExecute).not.toHaveBeenCalled();
  });

  test('builtin find override falls back to builtin find on zero fff results using the original request', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/repo',
        next_cursor: null,
        items: [],
      },
    }));
    const builtinExecute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'builtin find fallback result' }],
      details: undefined,
    }));
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      overrideBuiltinFind: true,
      createBuiltInFindTool: ((cwd: string) => ({
        ...createFindToolDefinition(cwd),
        execute: builtinExecute,
      })) as any,
    });

    const params = {
      pattern: '**/*slack*',
      path: 'extensions',
      limit: 25,
    };
    const result = await tools
      .find((tool) => tool.name === 'find')!
      .execute('tool-call', params, undefined, undefined, { cwd: '/repo' });

    expect(result.content).toEqual([{ type: 'text', text: 'builtin find fallback result' }]);
    expect(builtinExecute).toHaveBeenCalledWith(
      'tool-call',
      params,
      expect.objectContaining({ aborted: false }),
      undefined,
      { cwd: '/repo' },
    );
  });

  test('builtin find override lifts literal path prefixes into within before calling fff', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/repo/src',
        next_cursor: null,
        items: [{ path: 'widgets/mmdr-renderer.test.ts' }],
      },
    }));
    const builtinExecute = vi.fn(async () => {
      throw new Error('builtin find should not run');
    });
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      overrideBuiltinFind: true,
      createBuiltInFindTool: ((cwd: string) => ({
        ...createFindToolDefinition(cwd),
        execute: builtinExecute,
      })) as any,
    });

    const result = await tools
      .find((tool) => tool.name === 'find')!
      .execute('tool-call', { pattern: 'src/**/mmdr-renderer.test.ts' }, undefined, undefined, {
        cwd: '/repo',
      });

    expect(callPublicToolOverHttp).toHaveBeenCalledWith({
      tool: 'fff_find_files',
      query: 'mmdr renderer',
      within: ['/repo/src'],
      glob: '**/mmdr-renderer.test.ts',
      extensions: [],
      excludePaths: [],
      limit: 20,
      cursor: null,
      outputMode: 'compact',
    });
    expect(result.content).toEqual([{ type: 'text', text: 'widgets/mmdr-renderer.test.ts' }]);
    expect(builtinExecute).not.toHaveBeenCalled();
  });

  test('builtin find override falls back to builtin find for broad directory sweeps', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/repo',
        next_cursor: null,
        items: [{ path: 'scratch/out.txt' }],
      },
    }));
    const builtinExecute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'builtin find result' }],
      details: undefined,
    }));
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      overrideBuiltinFind: true,
      createBuiltInFindTool: ((cwd: string) => ({
        ...createFindToolDefinition(cwd),
        execute: builtinExecute,
      })) as any,
    });

    const result = await tools
      .find((tool) => tool.name === 'find')!
      .execute('tool-call', { pattern: 'scratch/**' }, undefined, undefined, { cwd: '/repo' });

    expect(result.content).toEqual([{ type: 'text', text: 'builtin find result' }]);
    expect(callPublicToolOverHttp).not.toHaveBeenCalled();
    expect(builtinExecute).toHaveBeenCalledTimes(1);
  });

  test('builtin grep override falls back to builtin grep when broad fff scopes are rejected', async () => {
    vi.stubEnv('HOME', '/Users/example');
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/Users/example',
        next_cursor: null,
        items: [{ path: 'router.ts', line: 1, text: 'hit' }],
      },
    }));
    const builtinExecute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'builtin grep result' }],
      details: undefined,
    }));
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      overrideBuiltinGrep: true,
      createBuiltInGrepTool: ((cwd: string) => ({
        ...createGrepToolDefinition(cwd),
        execute: builtinExecute,
      })) as any,
    });

    const result = await tools
      .find((tool) => tool.name === 'grep')!
      .execute('tool-call', { pattern: 'hit', path: '~' }, undefined, undefined, {
        cwd: '/Users/example/.pi/agent',
      });

    expect(result.content).toEqual([{ type: 'text', text: 'builtin grep result' }]);
    expect(callPublicToolOverHttp).not.toHaveBeenCalled();
    expect(builtinExecute).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });

  test('builtin read override retries via fff-assisted path resolution after a miss', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/repo',
        next_cursor: null,
        items: [{ path: 'src/router.ts' }],
      },
    }));
    const builtinExecute = vi
      .fn()
      .mockRejectedValueOnce(new Error('ENOENT: no such file or directory'))
      .mockResolvedValueOnce({
        content: [{ type: 'text' as const, text: 'resolved read output' }],
        details: undefined,
      });
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      overrideBuiltinRead: true,
      createBuiltInReadTool: ((cwd: string) => ({
        ...createReadToolDefinition(cwd),
        execute: builtinExecute,
      })) as any,
    });

    const result = await tools
      .find((tool) => tool.name === 'read')!
      .execute('tool-call', { path: 'router.ts' }, undefined, undefined, { cwd: '/repo' });

    expect(callPublicToolOverHttp).toHaveBeenCalledWith({
      tool: 'fff_find_files',
      query: 'router.ts',
      within: ['/repo'],
      glob: '**/router.ts',
      extensions: [],
      excludePaths: [],
      limit: 10,
      cursor: null,
      outputMode: 'compact',
    });
    expect(builtinExecute).toHaveBeenNthCalledWith(
      2,
      'tool-call',
      { path: '/repo/src/router.ts' },
      expect.objectContaining({ aborted: false }),
      undefined,
      { cwd: '/repo' },
    );
    expect(result.content).toEqual([
      { type: 'text', text: 'Path (fixed): src/router.ts\n\nresolved read output' },
    ]);
  });

  test('builtin read override broadens missing manifest reads when scoped resolution misses', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          mode: 'compact' as const,
          base_path: '/repo/extensions/multi-edit',
          next_cursor: null,
          items: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          mode: 'compact' as const,
          base_path: '/repo',
          next_cursor: null,
          items: [{ path: 'package.json' }],
        },
      });
    const builtinExecute = vi
      .fn()
      .mockRejectedValueOnce(new Error('ENOENT: no such file or directory'))
      .mockResolvedValueOnce({
        content: [{ type: 'text' as const, text: '{"name":"pi-toolbox"}' }],
        details: undefined,
      });
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      overrideBuiltinRead: true,
      createBuiltInReadTool: ((cwd: string) => ({
        ...createReadToolDefinition(cwd),
        execute: builtinExecute,
      })) as any,
    });

    const result = await tools
      .find((tool) => tool.name === 'read')!
      .execute('tool-call', { path: 'extensions/multi-edit/package.json' }, undefined, undefined, {
        cwd: '/repo',
      });

    expect(callPublicToolOverHttp).toHaveBeenNthCalledWith(1, {
      tool: 'fff_find_files',
      query: 'package.json',
      within: ['/repo/extensions/multi-edit'],
      glob: 'package.json',
      extensions: [],
      excludePaths: [],
      limit: 10,
      cursor: null,
      outputMode: 'compact',
    });
    expect(callPublicToolOverHttp).toHaveBeenNthCalledWith(2, {
      tool: 'fff_find_files',
      query: 'package.json',
      within: ['/repo'],
      glob: '**/package.json',
      extensions: [],
      excludePaths: [],
      limit: 10,
      cursor: null,
      outputMode: 'compact',
    });
    expect(builtinExecute).toHaveBeenNthCalledWith(
      2,
      'tool-call',
      { path: '/repo/package.json' },
      expect.objectContaining({ aborted: false }),
      undefined,
      { cwd: '/repo' },
    );
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Path (fixed): package.json\nAuto-resolved missing read path extensions/multi-edit/package.json → package.json.\n\n{"name":"pi-toolbox"}',
      },
    ]);
  });

  test('builtin read override broadens from subdirectory cwd to git root', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          mode: 'compact' as const,
          base_path: '/repo/extensions/multi-edit',
          next_cursor: null,
          items: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          mode: 'compact' as const,
          base_path: '/repo',
          next_cursor: null,
          items: [{ path: 'package.json' }],
        },
      });
    const builtinExecute = vi
      .fn()
      .mockRejectedValueOnce(new Error('ENOENT: no such file or directory'))
      .mockResolvedValueOnce({
        content: [{ type: 'text' as const, text: '{"name":"pi-toolbox"}' }],
        details: undefined,
      });
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      overrideBuiltinRead: true,
      findGitRootForReadFallback: vi.fn(async () => '/repo'),
      createBuiltInReadTool: ((cwd: string) => ({
        ...createReadToolDefinition(cwd),
        execute: builtinExecute,
      })) as any,
    });

    const result = await tools
      .find((tool) => tool.name === 'read')!
      .execute('tool-call', { path: 'package.json' }, undefined, undefined, {
        cwd: '/repo/extensions/multi-edit',
      });

    expect(callPublicToolOverHttp).toHaveBeenNthCalledWith(2, {
      tool: 'fff_find_files',
      query: 'package.json',
      within: ['/repo'],
      glob: '**/package.json',
      extensions: [],
      excludePaths: [],
      limit: 10,
      cursor: null,
      outputMode: 'compact',
    });
    expect(builtinExecute).toHaveBeenNthCalledWith(
      2,
      'tool-call',
      { path: '/repo/package.json' },
      expect.objectContaining({ aborted: false }),
      undefined,
      { cwd: '/repo/extensions/multi-edit' },
    );
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Path (fixed): /repo/package.json\nAuto-resolved missing read path package.json → /repo/package.json.\n\n{"name":"pi-toolbox"}',
      },
    ]);
  });

  test('builtin read override broadens unique non-metadata path matches with strong overlap', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          mode: 'compact' as const,
          base_path: '/repo/src/server',
          next_cursor: null,
          items: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          mode: 'compact' as const,
          base_path: '/repo',
          next_cursor: null,
          items: [{ path: 'app/server/router.ts' }],
        },
      });
    const builtinExecute = vi
      .fn()
      .mockRejectedValueOnce(new Error('ENOENT: no such file or directory'))
      .mockResolvedValueOnce({
        content: [{ type: 'text' as const, text: 'export const router = true;' }],
        details: undefined,
      });
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      overrideBuiltinRead: true,
      findGitRootForReadFallback: vi.fn(async () => '/repo'),
      createBuiltInReadTool: ((cwd: string) => ({
        ...createReadToolDefinition(cwd),
        execute: builtinExecute,
      })) as any,
    });

    const result = await tools
      .find((tool) => tool.name === 'read')!
      .execute('tool-call', { path: 'src/server/router.ts' }, undefined, undefined, {
        cwd: '/repo',
      });

    expect(builtinExecute).toHaveBeenNthCalledWith(
      2,
      'tool-call',
      { path: '/repo/app/server/router.ts' },
      expect.objectContaining({ aborted: false }),
      undefined,
      { cwd: '/repo' },
    );
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Path (fixed): app/server/router.ts\nAuto-resolved missing read path src/server/router.ts → app/server/router.ts.\n\nexport const router = true;',
      },
    ]);
  });

  test('builtin read override does not broaden ambiguous non-manifest misses', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          mode: 'compact' as const,
          base_path: '/repo/src/missing',
          next_cursor: null,
          items: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          mode: 'compact' as const,
          base_path: '/repo',
          next_cursor: null,
          items: [{ path: 'src/config.ts' }],
        },
      });
    const builtinError = new Error('ENOENT: no such file or directory');
    const builtinExecute = vi.fn().mockRejectedValue(builtinError);
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      overrideBuiltinRead: true,
      createBuiltInReadTool: ((cwd: string) => ({
        ...createReadToolDefinition(cwd),
        execute: builtinExecute,
      })) as any,
    });

    await expect(
      tools
        .find((tool) => tool.name === 'read')!
        .execute('tool-call', { path: 'src/missing/config.ts' }, undefined, undefined, {
          cwd: '/repo',
        }),
    ).rejects.toThrow('ENOENT');

    expect(callPublicToolOverHttp).toHaveBeenCalledTimes(2);
    expect(builtinExecute).toHaveBeenCalledTimes(1);
  });

  test('builtin read override does not guess when fff path resolution is ambiguous', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/repo',
        next_cursor: null,
        items: [{ path: 'src/router.ts' }, { path: 'tests/router.ts' }],
      },
    }));
    const builtinError = new Error('ENOENT: no such file or directory');
    const builtinExecute = vi.fn().mockRejectedValue(builtinError);
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      overrideBuiltinRead: true,
      createBuiltInReadTool: ((cwd: string) => ({
        ...createReadToolDefinition(cwd),
        execute: builtinExecute,
      })) as any,
    });

    await expect(
      tools
        .find((tool) => tool.name === 'read')!
        .execute('tool-call', { path: 'router.ts' }, undefined, undefined, { cwd: '/repo' }),
    ).rejects.toThrow('ENOENT');

    expect(builtinExecute).toHaveBeenCalledTimes(1);
  });

  test('builtin read override auto-rewrites EISDIR to ls for directory paths', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn();
    const eisdirError = Object.assign(new Error('EISDIR: illegal operation on a directory, read'), {
      code: 'EISDIR',
    });
    const readExecute = vi.fn().mockRejectedValueOnce(eisdirError);
    const lsExecute = vi.fn().mockResolvedValueOnce({
      content: [{ type: 'text' as const, text: 'file-a.md\nfile-b.ts\nsub/' }],
      details: undefined,
    });
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      overrideBuiltinRead: true,
      createBuiltInReadTool: ((cwd: string) => ({
        ...createReadToolDefinition(cwd),
        execute: readExecute,
      })) as any,
      createBuiltInLsTool: ((cwd: string) => ({
        ...createLsToolDefinition(cwd),
        execute: lsExecute,
      })) as any,
    });

    const result = await tools
      .find((tool) => tool.name === 'read')!
      .execute('tool-call', { path: 'scratch' }, undefined, undefined, { cwd: '/repo' });

    expect(readExecute).toHaveBeenCalledTimes(1);
    expect(lsExecute).toHaveBeenCalledTimes(1);
    expect(lsExecute).toHaveBeenCalledWith(
      'tool-call',
      { path: 'scratch' },
      expect.objectContaining({ aborted: false }),
      undefined,
      { cwd: '/repo' },
    );
    expect(callPublicToolOverHttp).not.toHaveBeenCalled();
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Path (directory): scratch\nAuto-rewrote read → ls because the path is a directory.\n\nfile-a.md\nfile-b.ts\nsub/',
      },
    ]);
    expect(result.details).toMatchObject({
      routedVia: 'read-to-ls',
      rewrittenFromPath: 'scratch',
      rewrittenToTool: 'ls',
    });
  });

  test('builtin read override rethrows EISDIR when ls rewrite itself fails', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn();
    const eisdirError = Object.assign(new Error('EISDIR: illegal operation on a directory, read'), {
      code: 'EISDIR',
    });
    const readExecute = vi.fn().mockRejectedValueOnce(eisdirError);
    const lsExecute = vi.fn().mockRejectedValueOnce(new Error('ls blew up'));
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      overrideBuiltinRead: true,
      createBuiltInReadTool: ((cwd: string) => ({
        ...createReadToolDefinition(cwd),
        execute: readExecute,
      })) as any,
      createBuiltInLsTool: ((cwd: string) => ({
        ...createLsToolDefinition(cwd),
        execute: lsExecute,
      })) as any,
    });

    await expect(
      tools
        .find((tool) => tool.name === 'read')!
        .execute('tool-call', { path: 'scratch' }, undefined, undefined, { cwd: '/repo' }),
    ).rejects.toThrow('EISDIR');
    expect(lsExecute).toHaveBeenCalledTimes(1);
  });

  test('builtin bash rewrite can be disabled via rewriteBuiltinBash: false', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn();
    const bashExecute = vi.fn().mockResolvedValueOnce({
      content: [{ type: 'text' as const, text: 'raw bash output' }],
      details: undefined,
    });
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      // Explicitly turn off the bash rewrite. The default is now `true`
      // (REWRITE_BUILTIN_BASH); this test pins the opt-out path.
      rewriteBuiltinBash: false,
      createBuiltInBashTool: ((cwd: string) => ({
        ...createBashToolDefinition(cwd),
        execute: bashExecute,
      })) as any,
    });

    const bashTool = tools.find((tool) => tool.name === 'bash');
    expect(bashTool).toBeUndefined();
  });

  test('builtin bash override rewrites `cat FILE` → read and prepends notice', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn();
    const bashExecute = vi.fn();
    const readExecute = vi.fn().mockResolvedValueOnce({
      content: [{ type: 'text' as const, text: 'export const x = 1;' }],
      details: undefined,
    });
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      rewriteBuiltinBash: true,
      createBuiltInReadTool: ((cwd: string) => ({
        ...createReadToolDefinition(cwd),
        execute: readExecute,
      })) as any,
      createBuiltInBashTool: ((cwd: string) => ({
        ...createBashToolDefinition(cwd),
        execute: bashExecute,
      })) as any,
    });

    const result = await tools
      .find((tool) => tool.name === 'bash')!
      .execute('tool-call', { command: 'cat src/foo.ts' }, undefined, undefined, {
        cwd: '/repo',
      });

    expect(bashExecute).not.toHaveBeenCalled();
    expect(readExecute).toHaveBeenCalledWith(
      'tool-call',
      { path: 'src/foo.ts' },
      expect.objectContaining({ aborted: false }),
      undefined,
      { cwd: '/repo' },
    );
    // Body is the clean read-tool output — no prepended rewrite notice.
    // The rewrite marker lives in `details.rewriteCall` where the TUI
    // chip picks it up without double-printing into the visible body.
    expect(result.content).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(/^export const x = 1;$/),
      },
    ]);
    expect(result.details).toMatchObject({
      routedVia: 'bash-to-read',
      rewriteRecognizer: 'cat-file',
      rewriteFromCommand: 'cat src/foo.ts',
      rewriteCall: expect.stringMatching(/^cat → read\(/),
    });
  });

  test('builtin bash override rewrites `grep -rn PAT src/ | head -20` → fff_grep with limit', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/repo/src',
        next_cursor: null,
        items: [{ path: 'router.ts', line: 12, text: 'foo' }],
      },
    }));
    const bashExecute = vi.fn();
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      rewriteBuiltinBash: true,
      createBuiltInBashTool: ((cwd: string) => ({
        ...createBashToolDefinition(cwd),
        execute: bashExecute,
      })) as any,
    });

    const result = await tools
      .find((tool) => tool.name === 'bash')!
      .execute('tool-call', { command: 'grep -rn "foo" src/ | head -20' }, undefined, undefined, {
        cwd: '/repo',
      });

    expect(bashExecute).not.toHaveBeenCalled();
    expect(callPublicToolOverHttp).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'fff_grep',
        patterns: ['foo'],
        within: ['/repo/src'],
        limit: 20,
      }),
    );
    expect(result.details).toMatchObject({
      routedVia: 'bash-to-fff_grep',
      rewriteRecognizer: 'grep-search+head',
    });
  });

  test('builtin bash override passes through commands it does not recognize', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn();
    const bashExecute = vi.fn().mockResolvedValueOnce({
      content: [{ type: 'text' as const, text: 'raw bash output' }],
      details: { truncation: undefined },
    });
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      rewriteBuiltinBash: true,
      createBuiltInBashTool: ((cwd: string) => ({
        ...createBashToolDefinition(cwd),
        execute: bashExecute,
      })) as any,
    });

    const result = await tools
      .find((tool) => tool.name === 'bash')!
      .execute(
        'tool-call',
        { command: 'pnpm install --silent 2>&1 | tail -5' },
        undefined,
        undefined,
        { cwd: '/repo' },
      );

    expect(bashExecute).toHaveBeenCalledTimes(1);
    expect(callPublicToolOverHttp).not.toHaveBeenCalled();
    expect(result.content).toEqual([{ type: 'text', text: 'raw bash output' }]);
  });

  test('builtin bash override falls back to real bash when dispatch throws', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn();
    const readExecute = vi.fn().mockRejectedValueOnce(new Error('read blew up'));
    const bashExecute = vi.fn().mockResolvedValueOnce({
      content: [{ type: 'text' as const, text: 'cat ran anyway' }],
      details: undefined,
    });
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      rewriteBuiltinBash: true,
      overrideBuiltinRead: false,
      createBuiltInReadTool: ((cwd: string) => ({
        ...createReadToolDefinition(cwd),
        execute: readExecute,
      })) as any,
      createBuiltInBashTool: ((cwd: string) => ({
        ...createBashToolDefinition(cwd),
        execute: bashExecute,
      })) as any,
    });

    const result = await tools
      .find((tool) => tool.name === 'bash')!
      .execute('tool-call', { command: 'cat /tmp/x.txt' }, undefined, undefined, {
        cwd: '/repo',
      });

    expect(readExecute).toHaveBeenCalledTimes(1);
    expect(bashExecute).toHaveBeenCalledTimes(1);
    expect(result.content).toEqual([{ type: 'text', text: 'cat ran anyway' }]);
  });

  test('builtin bash override rewrites `find <path> -type f | head -1 | xargs cat | head -80` → read with limit', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn();
    const readExecute = vi.fn().mockResolvedValueOnce({
      content: [{ type: 'text' as const, text: 'first 80 lines here' }],
      details: undefined,
    });
    const bashExecute = vi.fn();
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      rewriteBuiltinBash: true,
      createBuiltInReadTool: ((cwd: string) => ({
        ...createReadToolDefinition(cwd),
        execute: readExecute,
      })) as any,
      createBuiltInBashTool: ((cwd: string) => ({
        ...createBashToolDefinition(cwd),
        execute: bashExecute,
      })) as any,
    });

    const result = await tools
      .find((tool) => tool.name === 'bash')!
      .execute(
        'tool-call',
        { command: 'find /a/b.ts -type f | head -1 | xargs cat 2>/dev/null | head -80' },
        undefined,
        undefined,
        { cwd: '/repo' },
      );

    expect(bashExecute).not.toHaveBeenCalled();
    expect(readExecute).toHaveBeenCalledWith(
      'tool-call',
      { path: '/a/b.ts', limit: 80 },
      expect.objectContaining({ aborted: false }),
      undefined,
      { cwd: '/repo' },
    );
    expect(result.details).toMatchObject({
      routedVia: 'bash-to-read',
      rewriteRecognizer: 'find-xargs-cat',
    });
  });

  test('rejects broad home within scopes without calling fff or fallback', async () => {
    vi.stubEnv('HOME', '/Users/example');
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/Users/example',
        next_cursor: null,
        items: [{ path: 'router.ts' }],
      },
    }));
    const runRipgrepFallback = vi.fn<RunRipgrepFallback>(async () => ({
      text: 'base_path: /Users/example\n\nrouter.ts',
      engine: 'ripgrep',
      hasHits: true,
    }));

    const result = await forwardToolCall({
      toolName: 'fff_find_files',
      params: { query: 'mild-orbit', within: '~' },
      cwd: '/Users/example/.pi/agent',
      ensureDaemonRunning,
      callPublicToolOverHttp,
      runRipgrepFallback,
    });

    expect(result.text).toContain('Error: WITHIN_SCOPE_TOO_BROAD');
    expect(result.text).toContain('within: ~');
    expect(result.text).toContain('Use a more specific `within` path');
    expect(ensureDaemonRunning).not.toHaveBeenCalled();
    expect(callPublicToolOverHttp).not.toHaveBeenCalled();
    expect(runRipgrepFallback).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  test('rejects root within scopes without calling fff or fallback', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/',
        next_cursor: null,
        items: [{ path: 'router.ts' }],
      },
    }));
    const runRipgrepFallback = vi.fn<RunRipgrepFallback>(async () => ({
      text: 'base_path: /\n\nrouter.ts',
      engine: 'ripgrep',
      hasHits: true,
    }));

    const result = await forwardToolCall({
      toolName: 'fff_find_files',
      params: { query: 'mild-orbit', within: '/' },
      cwd: '/Users/example/.pi/agent',
      ensureDaemonRunning,
      callPublicToolOverHttp,
      runRipgrepFallback,
    });

    expect(result.text).toContain('Error: WITHIN_SCOPE_TOO_BROAD');
    expect(result.text).toContain('within: /');
    expect(ensureDaemonRunning).not.toHaveBeenCalled();
    expect(callPublicToolOverHttp).not.toHaveBeenCalled();
    expect(runRipgrepFallback).not.toHaveBeenCalled();
  });

  test('rejects the /Users /home and /opt parents without calling fff or fallback', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/',
        next_cursor: null,
        items: [],
      },
    }));
    const runRipgrepFallback = vi.fn<RunRipgrepFallback>(async () => ({
      text: '',
      engine: 'ripgrep',
      hasHits: false,
    }));

    for (const within of ['/Users', '/home', '/opt', '/opt/']) {
      const result = await forwardToolCall({
        toolName: 'fff_grep',
        params: { patterns: ['foo'], literal: false, within },
        cwd: '/Users/example/.pi/agent',
        ensureDaemonRunning,
        callPublicToolOverHttp,
        runRipgrepFallback,
      });
      expect(result.text, `scope ${within} should be rejected`).toContain(
        'Error: WITHIN_SCOPE_TOO_BROAD',
      );
    }

    expect(ensureDaemonRunning).not.toHaveBeenCalled();
    expect(callPublicToolOverHttp).not.toHaveBeenCalled();
    expect(runRipgrepFallback).not.toHaveBeenCalled();
  });

  test('allows narrower children of broad parents to route through normally', async () => {
    // `/opt/homebrew/Cellar` is in the fff-routerd allowlist, so a scope
    // one level deeper than the rejected `/opt` parent must still reach
    // the daemon and not short-circuit with WITHIN_SCOPE_TOO_BROAD.
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/opt/homebrew/Cellar',
        next_cursor: null,
        items: [{ path: 'ripgrep/14.0.0/bin/rg' }],
      },
    }));

    const result = await forwardToolCall({
      toolName: 'fff_find_files',
      params: { query: 'rg', within: '/opt/homebrew/Cellar' },
      cwd: '/Users/example/.pi/agent',
      ensureDaemonRunning,
      callPublicToolOverHttp,
    });

    expect(result.text).not.toContain('WITHIN_SCOPE_TOO_BROAD');
    expect(ensureDaemonRunning).toHaveBeenCalledTimes(1);
    expect(callPublicToolOverHttp).toHaveBeenCalledTimes(1);
  });

  test('rewrites broad find-files scopes by lifting literal glob prefixes into within', async () => {
    vi.stubEnv('HOME', '/Users/example');
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/Users/example/.config',
        next_cursor: null,
        items: [{ path: 'nvim/init.lua' }],
      },
    }));

    const result = await forwardToolCall({
      toolName: 'fff_find_files',
      params: { query: 'vim', within: '~', glob: '.config/**' },
      cwd: '/Users/example/.pi/agent',
      ensureDaemonRunning,
      callPublicToolOverHttp,
    });

    expect(callPublicToolOverHttp).toHaveBeenCalledWith({
      tool: 'fff_find_files',
      query: 'vim',
      within: ['/Users/example/.config'],
      glob: '**',
      extensions: [],
      excludePaths: [],
      limit: 20,
      cursor: null,
      outputMode: 'compact',
    });
    expect(result.text).toBe('base_path: /Users/example/.config\n\nnvim/init.lua');
    vi.unstubAllEnvs();
  });

  test('rewrites broad grep scopes by lifting literal glob prefixes into within', async () => {
    vi.stubEnv('HOME', '/Users/example');
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/Users/example/.config',
        next_cursor: null,
        items: [{ path: 'nvim/init.lua', line: 1, text: 'vim.g.mapleader = " "' }],
      },
    }));

    const result = await forwardToolCall({
      toolName: 'fff_grep',
      params: { literal: false, patterns: ['mapleader'], within: '~', glob: '.config/**/*.lua' },
      cwd: '/Users/example/.pi/agent',
      ensureDaemonRunning,
      callPublicToolOverHttp,
    });

    expect(callPublicToolOverHttp).toHaveBeenCalledWith({
      tool: 'fff_grep',
      patterns: ['mapleader'],
      literal: false,
      within: ['/Users/example/.config'],
      glob: '**/*.lua',
      caseSensitive: false,
      extensions: [],
      excludePaths: [],
      contextLines: 0,
      limit: 20,
      cursor: null,
      outputMode: 'compact',
    });
    expect(result.text).toBe(
      'base_path: /Users/example/.config\n\nnvim/init.lua:1: vim.g.mapleader = " "',
    );
    vi.unstubAllEnvs();
  });

  test('still rejects broad scopes when the glob has no literal prefix to lift', async () => {
    vi.stubEnv('HOME', '/Users/example');
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/Users/example',
        next_cursor: null,
        items: [{ path: 'notes.txt' }],
      },
    }));

    const result = await forwardToolCall({
      toolName: 'fff_find_files',
      params: { query: 'notes', within: '~', glob: '**/*.txt' },
      cwd: '/Users/example/.pi/agent',
      ensureDaemonRunning,
      callPublicToolOverHttp,
    });

    expect(result.text).toContain('Error: WITHIN_SCOPE_TOO_BROAD');
    expect(ensureDaemonRunning).not.toHaveBeenCalled();
    expect(callPublicToolOverHttp).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  test('formats grep output as ripgrep-style path line text', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/repo/src',
        next_cursor: null,
        items: [{ path: 'router.ts', line: 1, text: 'plan(Request)?' }],
      },
    }));

    const result = await forwardToolCall({
      toolName: 'fff_grep',
      params: {
        patterns: ['plan(Request)?'],
        literal: false,
        within: 'src',
        case_sensitive: true,
      },
      cwd: '/repo',
      ensureDaemonRunning,
      callPublicToolOverHttp,
    });

    expect(callPublicToolOverHttp).toHaveBeenCalledWith({
      tool: 'fff_grep',
      patterns: ['plan(Request)?'],
      literal: false,
      caseSensitive: true,
      within: ['/repo/src'],
      extensions: [],
      excludePaths: [],
      limit: 20,
      cursor: null,
      outputMode: 'compact',
      contextLines: 0,
    });
    expect(result.text).toBe('base_path: /repo/src\n\nrouter.ts:1: plan(Request)?');
  });

  test('normalizes compact rendered multi-pattern text from the fff-mcp backend', async () => {
    const result = await forwardToolCall({
      toolName: 'fff_grep',
      params: { literal: false, patterns: ['router'] },
      cwd: '/repo',
      ensureDaemonRunning: async () => {},
      callPublicToolOverHttp: async () => ({
        ok: true,
        value: {
          mode: 'compact',
          base_path: '/repo',
          next_cursor: null,
          text: [
            '→ Read src/router.ts (only match)',
            '1/1 matches shown',
            'src/router.ts [def]',
            ' 12: export function router() {}',
            ' 13| return true;',
            '--',
          ].join('\n'),
        },
      }),
    });

    expect(result.text).toBe('base_path: /repo\n\nsrc/router.ts:12: export function router() {}');
  });

  test('normalizes compact rendered grep text from the fff-mcp backend', async () => {
    const result = await forwardToolCall({
      toolName: 'fff_grep',
      params: { literal: false, patterns: ['\\[tools\\]'] },
      cwd: '/repo',
      ensureDaemonRunning: async () => {},
      callPublicToolOverHttp: async () => ({
        ok: true,
        value: {
          mode: 'compact',
          base_path: '/repo',
          next_cursor: null,
          text: ['config.toml', ' 36: [tools]', 'conf.d/viteplus.toml', ' 4: [tools]'].join('\n'),
        },
      }),
    });

    expect(result.text).toBe(
      'base_path: /repo\n\nconfig.toml:36: [tools]\nconf.d/viteplus.toml:4: [tools]',
    );
  });

  test('treats compact rendered no-match text as empty and allows local fallback', async () => {
    const runRipgrepFallback = vi.fn<RunRipgrepFallback>(async (_args) => ({
      text: 'base_path: /repo\n\nrouter.ts:10: router',
      engine: 'ripgrep',
      hasHits: true,
    }));

    const result = await forwardToolCall({
      toolName: 'fff_grep',
      params: { literal: false, patterns: ['router'] },
      cwd: '/repo',
      ensureDaemonRunning: async () => {},
      callPublicToolOverHttp: async () => ({
        ok: true,
        value: {
          mode: 'compact',
          base_path: '/repo',
          next_cursor: null,
          text: '0 matches.',
        },
      }),
      runRipgrepFallback,
    });

    expect(runRipgrepFallback).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('base_path: /repo\n\nrouter.ts:10: router');
  });

  test('formats empty results with an explicit no-match marker', async () => {
    const result = await forwardToolCall({
      toolName: 'fff_grep',
      params: { literal: false, patterns: ['router'] },
      cwd: '/repo',
      ensureDaemonRunning: async () => {},
      callPublicToolOverHttp: async () => ({
        ok: true,
        value: {
          mode: 'compact',
          base_path: '/repo',
          next_cursor: null,
          items: [],
        },
      }),
    });

    expect(result.text).toBe('base_path: /repo\n\n(no matches)');
  });

  test('keeps full uncollapsed paths in tool output while the display layer compacts them', async () => {
    const result = await forwardToolCall({
      toolName: 'fff_grep',
      params: {
        literal: false,
        patterns: ['alpha'],
        within: '/repo/projects/example-service/src/test',
      },
      cwd: '/repo',
      ensureDaemonRunning: async () => {},
      callPublicToolOverHttp: async () => ({
        ok: true,
        value: {
          mode: 'compact',
          base_path: '/repo',
          next_cursor: null,
          items: [
            {
              path: 'projects/example-service/src/test/java/com/example/example-service/pipeline/generation/workflow/verylongexamplepackagenamewithmanydescriptivewords/SampleWorkflowTest.java',
              line: 7,
              text: 'alpha',
            },
          ],
        },
      }),
    });

    expect(result.text).toContain(
      'projects/example-service/src/test/java/com/example/example-service/pipeline/generation/workflow/verylongexamplepackagenamewithmanydescriptivewords/SampleWorkflowTest.java:7: alpha',
    );
    expect(result.text).not.toContain('/.../');
  });

  test('truncates oversized daemon text matches before returning them to the model', async () => {
    const huge = `prefix-${'x'.repeat(6000)}`;
    const result = await forwardToolCall({
      toolName: 'fff_grep',
      params: { literal: false, patterns: ['prefix'] },
      cwd: '/repo',
      ensureDaemonRunning: async () => {},
      callPublicToolOverHttp: async () => ({
        ok: true,
        value: {
          mode: 'compact',
          base_path: '/repo',
          next_cursor: null,
          items: [{ path: 'threads/session.json', line: 12, text: huge }],
        },
      }),
    });

    expect(result.text).toContain('threads/session.json:12: prefix-');
    expect(result.text).toContain('[truncated');
    expect(result.text).not.toContain(huge);
    expect(result.text.length).toBeLessThan(800);
  });

  test('retries empty find-files results once with filename fallback and uses fallback hits', async () => {
    const runRipgrepFallback = vi.fn<RunRipgrepFallback>(async (_args) => ({
      text: 'base_path: /repo\n\nrouter.ts\ncoordinator.ts',
      engine: 'fd',
      hasHits: true,
    }));

    const result = await forwardToolCall({
      toolName: 'fff_find_files',
      params: { query: 'router' },
      cwd: '/repo',
      ensureDaemonRunning: async () => {},
      callPublicToolOverHttp: async () => ({
        ok: true,
        value: {
          mode: 'compact',
          base_path: '/repo',
          next_cursor: null,
          items: [],
        },
      }),
      runRipgrepFallback,
    });

    expect(runRipgrepFallback).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('base_path: /repo\n\nrouter.ts\ncoordinator.ts');
    expect(result.details.searchNoticeMessage).toContain('Note: FFF returned 0 results');
    expect(result.details.searchNoticeMessage).toContain('local filename fallback');
    expect(result.details.searchNoticeMessage).toContain('outside the tracked project');
    expect(result.details.zeroResultFallbackEngine).toBe('fd');
  });

  test('retries empty grep results once with ripgrep fallback and uses fallback hits', async () => {
    const runRipgrepFallback = vi.fn<RunRipgrepFallback>(async (_args) => ({
      text: 'base_path: /repo\n\nrouter.ts:10: router\ncoordinator.ts:4: router',
      engine: 'ripgrep',
      hasHits: true,
    }));

    const result = await forwardToolCall({
      toolName: 'fff_grep',
      params: { literal: false, patterns: ['router'] },
      cwd: '/repo',
      ensureDaemonRunning: async () => {},
      callPublicToolOverHttp: async () => ({
        ok: true,
        value: {
          mode: 'compact',
          base_path: '/repo',
          next_cursor: null,
          items: [],
        },
      }),
      runRipgrepFallback,
    });

    expect(runRipgrepFallback).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('base_path: /repo\n\nrouter.ts:10: router\ncoordinator.ts:4: router');
    expect(result.details.searchNoticeMessage).toContain('Note: FFF returned 0 results');
    expect(result.details.searchNoticeMessage).toContain('local text fallback');
    expect(result.details.zeroResultFallbackEngine).toBe('ripgrep');
  });

  test('retries empty grep results once with suspicious patterns escaped before using local fallback', async () => {
    const callPublicToolOverHttp = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          mode: 'compact',
          base_path: '/repo/internal',
          next_cursor: null,
          items: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          mode: 'compact',
          base_path: '/repo/internal',
          next_cursor: null,
          items: [{ path: 'core/validate.go', line: 24, text: 'func Validate(' }],
        },
      });
    const runRipgrepFallback = vi.fn<RunRipgrepFallback>(async (_args) => ({
      text: 'base_path: /repo/internal\n\ncore/validate.go:24: func Validate(',
      engine: 'ripgrep',
      hasHits: true,
    }));

    const result = await forwardToolCall({
      toolName: 'fff_grep',
      params: {
        literal: false,
        patterns: ['func Test.*Validate', 'Validate('],
        within: 'internal',
      },
      cwd: '/repo',
      ensureDaemonRunning: async () => {},
      callPublicToolOverHttp,
      runRipgrepFallback,
    });

    expect(callPublicToolOverHttp).toHaveBeenNthCalledWith(1, {
      tool: 'fff_grep',
      patterns: ['func Test.*Validate', 'Validate('],
      literal: false,
      within: ['/repo/internal'],
      caseSensitive: false,
      extensions: [],
      excludePaths: [],
      contextLines: 0,
      limit: 20,
      cursor: null,
      outputMode: 'compact',
    });
    expect(callPublicToolOverHttp).toHaveBeenNthCalledWith(2, {
      tool: 'fff_grep',
      // Repair now retries the same patterns with literal:true (router routes
      // literal:true to fff-mcp's multi_grep, which treats metacharacters as bytes).
      patterns: ['func Test.*Validate', 'Validate('],
      literal: true,
      within: ['/repo/internal'],
      caseSensitive: false,
      extensions: [],
      excludePaths: [],
      contextLines: 0,
      limit: 20,
      cursor: null,
      outputMode: 'compact',
    });
    expect(result.text).toBe('base_path: /repo/internal\n\ncore/validate.go:24: func Validate(');
    expect(result.details.searchNoticeMessage).toContain(
      'retried as a literal search after detecting suspicious regex syntax',
    );
    expect(result.details.searchNoticeMessage).toContain('Validate(');
    expect(runRipgrepFallback).not.toHaveBeenCalled();
  });

  test('ignores suspicious-pattern retry failures and still uses local fallback', async () => {
    const callPublicToolOverHttp = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          mode: 'compact',
          base_path: '/repo/internal',
          next_cursor: null,
          items: [],
        },
      })
      .mockRejectedValueOnce(new Error('temporary retry failure'));
    const runRipgrepFallback = vi.fn<RunRipgrepFallback>(async (_args) => ({
      text: 'base_path: /repo/internal\n\ncore/validate.go:24: func Validate(',
      engine: 'ripgrep',
      hasHits: true,
    }));

    const result = await forwardToolCall({
      toolName: 'fff_grep',
      params: { literal: false, patterns: ['Validate('], within: 'internal' },
      cwd: '/repo',
      ensureDaemonRunning: async () => {},
      callPublicToolOverHttp,
      runRipgrepFallback,
    });

    expect(runRipgrepFallback).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('base_path: /repo/internal\n\ncore/validate.go:24: func Validate(');
    expect(result.details.searchNoticeMessage).toContain('local text fallback');
    expect(result.details.searchNoticeMessage).not.toContain(
      'retried as a literal search after detecting suspicious regex syntax',
    );
  });

  test('retries empty grep results once with ripgrep fallback and uses fallback hits', async () => {
    const runRipgrepFallback = vi.fn<RunRipgrepFallback>(async (_args) => ({
      text: 'base_path: /repo\n\nrouter.ts:10: plan(Request)?',
      engine: 'ripgrep',
      hasHits: true,
    }));

    const result = await forwardToolCall({
      toolName: 'fff_grep',
      params: { literal: false, patterns: ['plan(Request)?'] },
      cwd: '/repo',
      ensureDaemonRunning: async () => {},
      callPublicToolOverHttp: async () => ({
        ok: true,
        value: {
          mode: 'compact',
          base_path: '/repo',
          next_cursor: null,
          items: [],
        },
      }),
      runRipgrepFallback,
    });

    expect(runRipgrepFallback).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('base_path: /repo\n\nrouter.ts:10: plan(Request)?');
    expect(result.details.searchNoticeMessage).toContain('Note: FFF returned 0 results');
    expect(result.details.searchNoticeMessage).toContain('local text fallback');
    expect(result.details.zeroResultFallbackEngine).toBe('ripgrep');
  });

  test('keeps the original empty result when zero-result local fallback also finds nothing', async () => {
    const runRipgrepFallback = vi.fn<RunRipgrepFallback>(async (_args) => ({
      text: 'base_path: /repo\n\n(no files found)',
      engine: 'ripgrep',
      hasHits: false,
    }));

    const result = await forwardToolCall({
      toolName: 'fff_find_files',
      params: { query: 'router' },
      cwd: '/repo',
      ensureDaemonRunning: async () => {},
      callPublicToolOverHttp: async () => ({
        ok: true,
        value: {
          mode: 'compact',
          base_path: '/repo',
          next_cursor: null,
          items: [],
        },
      }),
      runRipgrepFallback,
    });

    expect(runRipgrepFallback).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('base_path: /repo\n\n(no files found)');
    expect(result.details.searchNoticeMessage).toBeUndefined();
    expect(result.details.zeroResultFallbackEngine).toBeUndefined();
  });

  test('does not use zero-result fallback when the primary search already has hits', async () => {
    const runRipgrepFallback = vi.fn<RunRipgrepFallback>(async (_args) => ({
      text: 'base_path: /repo\n\nrouter.ts',
      engine: 'ripgrep',
      hasHits: true,
    }));

    const result = await forwardToolCall({
      toolName: 'fff_find_files',
      params: { query: 'router' },
      cwd: '/repo',
      ensureDaemonRunning: async () => {},
      callPublicToolOverHttp: async () => ({
        ok: true,
        value: {
          mode: 'compact',
          base_path: '/repo',
          next_cursor: null,
          items: [{ path: 'router.ts' }],
        },
      }),
      runRipgrepFallback,
    });

    expect(runRipgrepFallback).not.toHaveBeenCalled();
    expect(result.text).toBe('base_path: /repo\n\nrouter.ts');
  });

  test('retries once after a daemon mismatch and records a user-visible restart note', async () => {
    const ensureDaemonRunning = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(
        new Error('daemon config mismatch; restart the daemon with the current configuration'),
      )
      .mockResolvedValueOnce(undefined);
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/repo',
        next_cursor: null,
        items: [{ path: 'router.ts' }],
      },
    }));

    const result = await forwardToolCall({
      toolName: 'fff_find_files',
      params: { query: 'router' },
      cwd: '/repo',
      ensureDaemonRunning,
      callPublicToolOverHttp,
    });

    expect(ensureDaemonRunning).toHaveBeenCalledTimes(2);
    expect(callPublicToolOverHttp).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('base_path: /repo\n\nrouter.ts');
    expect(result.details.daemonRestarted).toBe(true);
    expect(result.details.daemonRestartMessage).toContain('restarted the daemon');
    expect(result.details.daemonRestartMessage).toContain('retried the search once');
  });

  test('tool execution ensures the daemon is running and returns formatted text content', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/repo',
        next_cursor: null,
        items: [{ path: 'router.ts' }],
      },
    }));
    const { tools } = createHarness({ ensureDaemonRunning, callPublicToolOverHttp });

    const findTool = tools.find((tool) => tool.name === 'fff_find_files');
    expect(findTool).toBeDefined();

    const result = await findTool!.execute(
      'call-1',
      {
        query: 'router',
      },
      undefined,
      undefined,
      { cwd: '/repo' },
    );

    expect(ensureDaemonRunning).toHaveBeenCalledTimes(1);
    expect(callPublicToolOverHttp).toHaveBeenCalledTimes(1);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'base_path: /repo\n\nrouter.ts',
      },
    ]);
  });

  test('tool execution exposes zero-result fallback notice to the LLM via content blocks', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: '/repo',
        next_cursor: null,
        items: [],
      },
    }));
    const runRipgrepFallback = vi.fn(async () => ({
      text: 'base_path: /repo\n\nrouter.ts',
      engine: 'fd' as const,
    }));
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      runRipgrepFallback,
    } as any);

    const findTool = tools.find((tool) => tool.name === 'fff_find_files');
    expect(findTool).toBeDefined();

    const result = await findTool!.execute('call-1', { query: 'router' }, undefined, undefined, {
      cwd: '/repo',
    });

    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Note: FFF returned 0 results; local filename fallback found matches. Paths may include hidden files or be outside the tracked project / daemon-allowed scope.',
      },
      {
        type: 'text',
        text: 'base_path: /repo\n\nrouter.ts',
      },
    ]);
  });

  test('tool execution auto-retries with local fallback for outside-allowlist paths', async () => {
    const ensureDaemonRunning = vi.fn(async () => {});
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'OUTSIDE_ALLOWED_SCOPE' as const,
        message:
          "search_path '/Users/example/.pi/agent' is outside a git repo and not under an allowlisted non-git prefix",
      },
    }));
    const runRipgrepFallback = vi.fn(async () => ({
      text: 'base_path: /Users/example/.pi/agent\n\ntests/sync-common-settings.test.ts',
      engine: 'ripgrep' as const,
      hasHits: true,
    }));
    const { tools } = createHarness({
      ensureDaemonRunning,
      callPublicToolOverHttp,
      runRipgrepFallback,
    } as any);

    const findTool = tools.find((tool) => tool.name === 'fff_find_files');
    expect(findTool).toBeDefined();

    const result = await findTool!.execute(
      'call-1',
      {
        query: 'sync-common-settings',
        within: '/Users/example/.pi/agent',
      },
      undefined,
      undefined,
      { cwd: '/Users/example/.pi/agent' },
    );

    expect(runRipgrepFallback).toHaveBeenCalledTimes(1);
    expect(result.content[0]?.text).toContain(
      'Warning: FFF unavailable for this within path only; auto-retried with a local search fallback.',
    );
    expect(result.content[0]?.text).toContain('FFF still works for other within paths');
    expect(result.content[0]?.text).toContain('~/.config/fff-routerd/config.json');
    expect(result.content[0]?.text).toContain('config.jsonc');
    expect(result.content[0]?.text).toContain('~/.pi');
    expect(result.content[0]?.text).toContain('no Pi restart is required');
    expect(result.content[1]?.text).toBe(
      'base_path: /Users/example/.pi/agent\n\ntests/sync-common-settings.test.ts',
    );
    expect(result.details.resultKind).toBe('scope_warning');
    expect(result.details.fallbackEngine).toBe('ripgrep');
  });

  test('scope warning shortens within paths relative to home for display', async () => {
    vi.stubEnv('HOME', '/Users/example');
    const result = await forwardToolCall({
      toolName: 'fff_find_files',
      params: { query: 'sync-common-settings', within: '/Users/example/.pi/agent' },
      cwd: '/Users/example/.pi/agent',
      ensureDaemonRunning: async () => {},
      callPublicToolOverHttp: async () => ({
        ok: false,
        error: {
          code: 'OUTSIDE_ALLOWED_SCOPE',
          message: 'outside',
        },
      }),
      runRipgrepFallback: async (_args) => ({
        text: 'base_path: /Users/example/.pi/agent\n\ntests/sync-common-settings.test.ts',
        engine: 'ripgrep',
        hasHits: true,
      }),
    });

    expect(String(result.details.scopeWarningText)).toContain('within: ~/.pi/agent');
    expect(result.text).toBe(
      'base_path: /Users/example/.pi/agent\n\ntests/sync-common-settings.test.ts',
    );
    vi.unstubAllEnvs();
  });

  // Helpers: the builtin grep/find tools both return `{ content: [{ type: 'text', text }] }`.
  // These wrap that contract so test setup stays compact.
  const mockBuiltinText = (text: string) =>
    vi.fn(async () => ({ content: [{ type: 'text' as const, text }] }));

  test('runLocalFallback ranks likely source hits first, truncates giant lines, and reports a spill artifact', async () => {
    const huge = `{"text":"${'x'.repeat(5000)}"}`;
    const spillText = vi.fn(async () => '/tmp/pi-fff-raw-test.txt');
    const runBuiltinGrep = mockBuiltinText(
      [
        '.local/share/amp/threads/T-1.json:8745: ' + huge,
        '.dotfiles/bin/alert-and-notify.sh:1: echo hello',
        '.claude/settings.json:52: ~/.dotfiles/bin/alert-and-notify.sh',
      ].join('\n'),
    );

    const result = await runLocalFallback(
      {
        toolName: 'fff_search_terms',
        resolvedWithin: '/Users/example',
        publicRequest: {
          tool: 'fff_search_terms',
          terms: ['alert-and-notify.sh'],
          within: '/Users/example',
          extensions: ['md', 'sh', 'json'],
          excludePaths: [],
          limit: 50,
          cursor: null,
          outputMode: 'compact',
        } as any,
      },
      { runBuiltinGrep, spillText, rawSpillThresholdBytes: 1000 },
    );

    const bodyLines = result.text.split('\n').slice(2);
    expect(bodyLines[0]).toContain('.dotfiles/bin/alert-and-notify.sh:1: echo hello');
    expect(result.text).toContain('[truncated');
    expect(result.spill).toEqual({
      path: '/tmp/pi-fff-raw-test.txt',
      bytes: expect.any(Number),
      lines: 3,
    });
    expect(spillText).toHaveBeenCalledTimes(1);
  });

  test('runLocalFallback treats builtin "No matches found" as a clean no-match result', async () => {
    const runBuiltinGrep = mockBuiltinText('No matches found');

    const result = await runLocalFallback(
      {
        toolName: 'fff_search_terms',
        resolvedWithin: '/repo',
        publicRequest: {
          tool: 'fff_search_terms',
          terms: ['router'],
          within: '/repo',
          extensions: ['ts'],
          excludePaths: [],
          limit: 20,
          cursor: null,
          outputMode: 'compact',
        } as any,
      },
      { runBuiltinGrep },
    );

    expect(result.text).toBe('base_path: /repo\n\n(no matches)');
    expect(result.hasHits).toBe(false);
  });

  test('runLocalFallback find-files fallback honors requested extensions via post-filter', async () => {
    const runBuiltinFind = mockBuiltinText(
      ['src/router.ts', 'src/router.md', 'src/router.json'].join('\n'),
    );

    const result = await runLocalFallback(
      {
        toolName: 'fff_find_files',
        resolvedWithin: '/repo',
        publicRequest: {
          tool: 'fff_find_files',
          query: 'router',
          within: '/repo',
          extensions: ['ts', 'md'],
          excludePaths: [],
          limit: 20,
          cursor: null,
          outputMode: 'compact',
        } as any,
      },
      { runBuiltinFind },
    );

    expect(result.text).toContain('src/router.ts');
    expect(result.text).toContain('src/router.md');
    expect(result.text).not.toContain('src/router.json');
  });

  test('runLocalFallback find-files fallback honors requested glob via post-filter', async () => {
    const runBuiltinFind = mockBuiltinText(
      ['src/router.ts', 'docs/router.ts', 'src/router.md'].join('\n'),
    );

    const result = await runLocalFallback(
      {
        toolName: 'fff_find_files',
        resolvedWithin: '/repo',
        publicRequest: {
          tool: 'fff_find_files',
          query: 'router',
          within: '/repo',
          glob: 'src/**/*.ts',
          extensions: [],
          excludePaths: [],
          limit: 20,
          cursor: null,
          outputMode: 'compact',
        } as any,
      },
      { runBuiltinFind },
    );

    expect(result.text).toContain('src/router.ts');
    expect(result.text).not.toContain('docs/router.ts');
    expect(result.text).not.toContain('src/router.md');
  });

  test('runLocalFallback grep fallback honors requested extensions and exclude paths via post-filter', async () => {
    const runBuiltinGrep = mockBuiltinText(
      [
        'src/router.ts:10: planRequest()',
        'src/router.md:20: planRequest()',
        'dist/router.ts:30: planRequest()',
      ].join('\n'),
    );

    const result = await runLocalFallback(
      {
        toolName: 'fff_grep',
        resolvedWithin: '/repo',
        publicRequest: {
          tool: 'fff_grep',
          patterns: ['plan(Request)?'],
          literal: false,
          caseSensitive: true,
          within: '/repo',
          extensions: ['ts'],
          excludePaths: ['dist'],
          limit: 20,
          cursor: null,
          outputMode: 'compact',
          contextLines: 0,
        } as any,
      },
      { runBuiltinGrep },
    );

    expect(result.text).toContain('src/router.ts:10: planRequest()');
    expect(result.text).not.toContain('src/router.md');
    expect(result.text).not.toContain('dist/router.ts');
  });

  test('runLocalFallback grep fallback forwards the caller glob to the builtin', async () => {
    const runBuiltinGrep = mockBuiltinText('src/router.ts:10: planRequest()');

    await runLocalFallback(
      {
        toolName: 'fff_grep',
        resolvedWithin: '/repo',
        publicRequest: {
          tool: 'fff_grep',
          patterns: ['plan(Request)?'],
          literal: false,
          caseSensitive: true,
          within: '/repo',
          glob: 'src/**/*.ts',
          extensions: [],
          excludePaths: [],
          limit: 20,
          cursor: null,
          outputMode: 'compact',
          contextLines: 0,
        } as any,
      },
      { runBuiltinGrep },
    );

    expect(runBuiltinGrep).toHaveBeenCalledWith(
      expect.objectContaining({
        pattern: 'plan(Request)?',
        path: '/repo',
        glob: 'src/**/*.ts',
        literal: false,
        ignoreCase: false,
      }),
    );
  });

  test('runLocalFallback collapses grep multi-patterns into a regex alternation for the builtin', async () => {
    const runBuiltinGrep = mockBuiltinText('');

    await runLocalFallback(
      {
        toolName: 'fff_grep',
        resolvedWithin: '/repo',
        publicRequest: {
          tool: 'fff_grep',
          // Regex-mode multi-pattern: each entry wraps in `(?: ... )` before joining.
          patterns: ['plan(Request)?', 'build(Request)?'],
          literal: false,
          caseSensitive: true,
          within: '/repo',
          extensions: [],
          excludePaths: [],
          limit: 20,
          cursor: null,
          outputMode: 'compact',
          contextLines: 0,
        } as any,
      },
      { runBuiltinGrep },
    );

    expect(runBuiltinGrep).toHaveBeenCalledWith(
      expect.objectContaining({
        pattern: '(?:plan(Request)?)|(?:build(Request)?)',
        literal: false,
      }),
    );
  });

  test('runLocalFallback escapes regex metacharacters when combining literal multi-patterns', async () => {
    const runBuiltinGrep = mockBuiltinText('');

    await runLocalFallback(
      {
        toolName: 'fff_grep',
        resolvedWithin: '/repo',
        publicRequest: {
          tool: 'fff_grep',
          // Literal-mode multi-pattern: each entry is regex-escaped so the
          // alternation still matches bytes. Final `literal` is flipped to
          // false because we've encoded the literal semantics as regex.
          patterns: ['arr[0]', 'fn()'],
          literal: true,
          caseSensitive: true,
          within: '/repo',
          extensions: [],
          excludePaths: [],
          limit: 20,
          cursor: null,
          outputMode: 'compact',
          contextLines: 0,
        } as any,
      },
      { runBuiltinGrep },
    );

    expect(runBuiltinGrep).toHaveBeenCalledWith(
      expect.objectContaining({
        pattern: 'arr\\[0\\]|fn\\(\\)',
        literal: false,
      }),
    );
  });

  test('runLocalFallback honors suffix-style extension filters like d.ts', async () => {
    const runBuiltinFind = mockBuiltinText(['types/router.d.ts', 'types/router.ts'].join('\n'));

    const result = await runLocalFallback(
      {
        toolName: 'fff_find_files',
        resolvedWithin: '/repo',
        publicRequest: {
          tool: 'fff_find_files',
          query: 'router',
          within: '/repo',
          extensions: ['d.ts'],
          excludePaths: [],
          limit: 20,
          cursor: null,
          outputMode: 'compact',
        } as any,
      },
      { runBuiltinFind },
    );

    expect(result.text).toContain('types/router.d.ts');
    expect(result.text).not.toContain('types/router.ts');
  });

  test('runLocalFallback normalizes dotted extension filters (".d.ts" === "d.ts")', async () => {
    const runBuiltinGrep = mockBuiltinText('types/router.d.ts:10: planRequest()');

    const result = await runLocalFallback(
      {
        toolName: 'fff_grep',
        resolvedWithin: '/repo',
        publicRequest: {
          tool: 'fff_grep',
          patterns: ['plan(Request)?'],
          literal: false,
          caseSensitive: true,
          within: '/repo',
          extensions: ['.d.ts'],
          excludePaths: [],
          limit: 20,
          cursor: null,
          outputMode: 'compact',
          contextLines: 0,
        } as any,
      },
      { runBuiltinGrep },
    );

    expect(result.text).toContain('types/router.d.ts:10: planRequest()');
  });

  test('runLocalFallback scopes grep to a single file when within points to a file', async () => {
    const runBuiltinGrep = mockBuiltinText('router.d.ts:10: planRequest()');
    const stat = vi.fn(async () => ({ isFile: () => true }));

    const result = await runLocalFallback(
      {
        toolName: 'fff_grep',
        resolvedWithin: '/repo/src/router.d.ts',
        publicRequest: {
          tool: 'fff_grep',
          patterns: ['plan(Request)?'],
          literal: false,
          caseSensitive: true,
          within: '/repo/src/router.d.ts',
          extensions: ['d.ts'],
          excludePaths: [],
          limit: 20,
          cursor: null,
          outputMode: 'compact',
          contextLines: 0,
        } as any,
      },
      { runBuiltinGrep, stat: stat as any },
    );

    // The builtin receives the file path directly, not the enclosing directory,
    // so rg searches only that file.
    expect(runBuiltinGrep).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/repo/src/router.d.ts' }),
    );
    expect(result.text).toBe('base_path: /repo/src/router.d.ts\n\nrouter.d.ts:10: planRequest()');
  });

  test('runLocalFallback strips jj metadata paths that the builtin does not know to skip', async () => {
    const runBuiltinFind = mockBuiltinText(['.jj/store/index.ts', 'src/router.ts'].join('\n'));

    const result = await runLocalFallback(
      {
        toolName: 'fff_find_files',
        resolvedWithin: '/repo',
        publicRequest: {
          tool: 'fff_find_files',
          query: 'ts',
          within: '/repo',
          extensions: ['ts'],
          excludePaths: [],
          limit: 20,
          cursor: null,
          outputMode: 'compact',
        } as any,
      },
      { runBuiltinFind },
    );

    expect(result.text).toContain('src/router.ts');
    expect(result.text).not.toContain('.jj/store/index.ts');
  });

  test('runLocalFallback drops the builtin find trailer so it cannot surface as a phantom path', async () => {
    // The builtin find tool appends `\n\n[500 results limit reached...]`
    // after its last path on truncation. Before we stripped it, a query
    // like `limit` or `results` could fuzzy-match the trailer text and
    // return the bracketed notice as if it were a filename.
    const builtinOutput = [
      'src/router.ts',
      'src/planner.ts',
      '',
      '[500 results limit reached. Use limit=1000 for more, or refine pattern]',
    ].join('\n');
    const runBuiltinFind = mockBuiltinText(builtinOutput);

    const result = await runLocalFallback(
      {
        toolName: 'fff_find_files',
        resolvedWithin: '/repo',
        publicRequest: {
          tool: 'fff_find_files',
          // `limit` and `results` are both in the trailer text; without
          // stripping, fuzzyMatchPath would pick the trailer up.
          query: 'limit',
          within: '/repo',
          extensions: [],
          excludePaths: [],
          limit: 20,
          cursor: null,
          outputMode: 'compact',
        } as any,
      },
      { runBuiltinFind },
    );

    expect(result.text).not.toContain('[500 results limit reached');
    expect(result.text).not.toContain('limit=1000');
    expect(result.text).not.toContain('refine pattern');
  });

  test('runLocalFallback drops the builtin grep trailer and excludes it from spill metadata', async () => {
    // Same trailer story on the grep side: the bracketed notice does not
    // parse as `path:line:text`, but before the fix it still inflated
    // `rawLines.length` and landed in the spilled raw text.
    const matches = Array.from(
      { length: 40 },
      (_, i) => `src/file${i}.ts:${i}: planRequest()`,
    ).join('\n');
    const builtinOutput = `${matches}\n\n[500 matches limit reached. Use limit=1000 for more, or refine pattern]`;
    const runBuiltinGrep = mockBuiltinText(builtinOutput);
    const spillText = vi.fn(async (rawText: string) => {
      expect(rawText).not.toContain('[500 matches limit reached');
      return '/tmp/pi-fff-raw-test.txt';
    });

    const result = await runLocalFallback(
      {
        toolName: 'fff_grep',
        resolvedWithin: '/repo',
        publicRequest: {
          tool: 'fff_grep',
          patterns: ['plan(Request)?'],
          literal: false,
          caseSensitive: true,
          within: '/repo',
          extensions: ['ts'],
          excludePaths: [],
          limit: 100,
          cursor: null,
          outputMode: 'compact',
          contextLines: 0,
        } as any,
      },
      { runBuiltinGrep, spillText, rawSpillThresholdBytes: 500 },
    );

    expect(result.hasHits).toBe(true);
    expect(result.text).not.toContain('[500 matches limit reached');
    // Line count reflects the 40 match rows only, not the blank line
    // separator or the bracketed trailer.
    expect(result.spill?.lines).toBe(40);
    expect(spillText).toHaveBeenCalledTimes(1);
  });

  test('runLocalFallback preserves anchors and word boundaries across regex multi-patterns', async () => {
    // Anchored patterns like `^foo$` and `\bfoo\b` must still anchor per
    // alternative after combineGrepPatterns wraps them in `(?: ... )`.
    const runBuiltinGrep = mockBuiltinText('');

    await runLocalFallback(
      {
        toolName: 'fff_grep',
        resolvedWithin: '/repo',
        publicRequest: {
          tool: 'fff_grep',
          patterns: ['^foo$', '\\bbar\\b'],
          literal: false,
          caseSensitive: true,
          within: '/repo',
          extensions: [],
          excludePaths: [],
          limit: 20,
          cursor: null,
          outputMode: 'compact',
          contextLines: 0,
        } as any,
      },
      { runBuiltinGrep },
    );

    expect(runBuiltinGrep).toHaveBeenCalledWith(
      expect.objectContaining({
        pattern: '(?:^foo$)|(?:\\bbar\\b)',
        literal: false,
      }),
    );
  });

  test('runLocalFallback spills to a file when builtin output exceeds the raw threshold', async () => {
    const body = Array.from({ length: 40 }, (_, i) => `src/file${i}.ts:${i}: planRequest()`).join(
      '\n',
    );
    const runBuiltinGrep = mockBuiltinText(body);
    const spillText = vi.fn(async () => '/tmp/pi-fff-raw-test.txt');

    const result = await runLocalFallback(
      {
        toolName: 'fff_grep',
        resolvedWithin: '/repo',
        publicRequest: {
          tool: 'fff_grep',
          patterns: ['plan(Request)?'],
          literal: false,
          caseSensitive: true,
          within: '/repo',
          extensions: ['ts'],
          excludePaths: [],
          limit: 100,
          cursor: null,
          outputMode: 'compact',
          contextLines: 0,
        } as any,
      },
      { runBuiltinGrep, spillText, rawSpillThresholdBytes: 500 },
    );

    expect(result.hasHits).toBe(true);
    expect(result.text).toContain('src/file0.ts:0: planRequest()');
    expect(result.spill).toEqual({
      path: '/tmp/pi-fff-raw-test.txt',
      bytes: expect.any(Number),
      lines: 40,
    });
    expect(spillText).toHaveBeenCalledTimes(1);
  });

  test('tool execution exposes fallback spill notices to the model context', async () => {
    const { tools } = createHarness({
      ensureDaemonRunning: vi.fn(async () => {}),
      callPublicToolOverHttp: vi.fn(async () => ({
        ok: true as const,
        value: {
          mode: 'compact' as const,
          base_path: '/repo',
          next_cursor: null,
          items: [],
        },
      })),
      runRipgrepFallback: vi.fn(async () => ({
        text: 'base_path: /repo\n\nrouter.ts:10: router',
        engine: 'ripgrep' as const,
        spill: {
          path: '/tmp/pi-fff-raw-test.txt',
          bytes: 54321,
          lines: 42,
        },
      })),
    } as any);

    const tool = tools.find((candidate) => candidate.name === 'fff_grep');
    const result = await tool!.execute(
      'call-1',
      { patterns: ['router'], literal: false },
      undefined,
      undefined,
      {
        cwd: '/repo',
      },
    );

    expect(result.content.map((entry) => entry.text).join('\n\n')).toContain(
      '/tmp/pi-fff-raw-test.txt',
    );
    expect(result.content.map((entry) => entry.text).join('\n\n')).toContain('54321');
  });

  test('renderResult prepends the daemon restart notice before successful results', () => {
    const { tools } = createHarness();
    const tool = tools.find((candidate) => candidate.name === 'fff_find_files');
    const theme = createTheme();

    const rendered = tool!.renderResult!(
      {
        content: [{ type: 'text', text: 'base_path: /repo\n\nrouter.ts' }],
        details: {
          toolName: 'fff_find_files',
          resolvedWithin: '/repo',
          publicRequest: { tool: 'fff_find_files', query: 'router', within: '/repo' },
          daemonRestarted: true,
          daemonRestartMessage:
            'Notice: FFF daemon config changed; restarted the daemon and retried the search once.',
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    const text = renderText(rendered);
    expect(text).toContain('restarted the daemon');
    expect(text).toContain('retried the search once');
    expect(text).toContain('router.ts');
  });

  test('renderResult prepends the zero-result fallback notice before fallback results', () => {
    const { tools } = createHarness();
    const tool = tools.find((candidate) => candidate.name === 'fff_find_files');
    const theme = createTheme();

    const rendered = tool!.renderResult!(
      {
        content: [{ type: 'text', text: 'base_path: /repo\n\nrouter.ts' }],
        details: {
          toolName: 'fff_find_files',
          resolvedWithin: '/repo',
          publicRequest: { tool: 'fff_find_files', query: 'router', within: '/repo' },
          searchNoticeMessage:
            'Note: FFF returned 0 results; local filename fallback found matches. Paths may include hidden files or be outside the tracked project / daemon-allowed scope.',
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    const text = renderText(rendered);
    expect(text).toContain('FFF returned 0 results');
    expect(text).toContain('local filename fallback');
    expect(text).toContain('router.ts');
  });

  test('default export creates the extension factory without throwing', () => {
    expect(typeof createPiFffSearchExtensionDefault).toBe('function');
  });
});

// Pass-through bash commands that contain expensive search tools
// (grep/rg/find/fd/…) get their AbortSignal capped at a conservative
// timeout so the agent session cannot wedge on an unrewritten runaway
// traversal. These tests exercise the detection predicate only —
// signal-combining behavior relies on the platform's native
// AbortSignal.timeout + AbortSignal.any and is not mocked.
describe('bash-rewrite pretty rendering', () => {
  const theme = createTheme();

  test('renderBashRewritePreview shows compact "bash → fff_grep" chip for grep commands', () => {
    const rendered = renderBashRewritePreview(
      { command: 'grep -rn "createLsToolDefinition" src/' },
      theme,
      '/repo',
    );
    expect(rendered).not.toBeNull();
    const text = renderText(rendered);
    expect(text).toContain('bash →');
    expect(text).toContain('fff_grep  ');
    expect(text).toContain('createLsToolDefinition');
    expect(text).toContain('within=src/');
    // Compact chip is a single line — no newlines.
    expect(text.includes('\n')).toBe(false);
  });

  test('renderBashRewritePreview shows compact "bash → fff_find_files" chip for find commands', () => {
    const rendered = renderBashRewritePreview(
      { command: 'find src/ -name "*router*.ts"' },
      theme,
      '/repo',
    );
    expect(rendered).not.toBeNull();
    const text = renderText(rendered);
    expect(text).toContain('bash →');
    expect(text).toContain('fff_find_files  ');
    expect(text).toContain('router');
    expect(text).toContain('glob=*router*.ts');
    expect(text.includes('\n')).toBe(false);
  });

  test('renderBashRewritePreview surfaces literal flag when set', () => {
    const rendered = renderBashRewritePreview(
      { command: 'grep -F "foo(bar)" src/' },
      theme,
      '/repo',
    );
    const text = renderText(rendered);
    expect(text).toContain('literal');
  });

  test('renderBashRewritePreview joins multiple patterns with " | " in the chip', () => {
    const rendered = renderBashRewritePreview(
      { command: 'grep -n "foo\\|bar" src/router.ts' },
      theme,
      '/repo',
    );
    const text = renderText(rendered);
    expect(text).toContain('foo | bar');
  });

  test('renderBashRewritePreview shows "bash → read(...)" for sed range', () => {
    const rendered = renderBashRewritePreview(
      { command: "sed -n '10,20p' src/foo.ts" },
      theme,
      '/repo',
    );
    expect(rendered).not.toBeNull();
    const text = renderText(rendered);
    expect(text).toContain('bash →');
    expect(text).toContain('read(');
    expect(text).toContain('offset=10');
    expect(text).toContain('limit=11');
  });

  test('renderBashRewritePreview shows "bash → ls(...)" for ls', () => {
    const rendered = renderBashRewritePreview({ command: 'ls src/' }, theme, '/repo');
    expect(rendered).not.toBeNull();
    const text = renderText(rendered);
    expect(text).toContain('bash →');
    expect(text).toContain('ls(');
    expect(text).toContain('src/');
  });

  test('renderBashRewritePreview returns null for non-rewriteable commands', () => {
    expect(renderBashRewritePreview({ command: 'pnpm install' }, theme, '/repo')).toBeNull();
    expect(renderBashRewritePreview({ command: 'git status' }, theme, '/repo')).toBeNull();
    // Missing command (e.g. malformed params) also yields null, never a throw.
    expect(renderBashRewritePreview({}, theme, '/repo')).toBeNull();
    expect(renderBashRewritePreview(null, theme, '/repo')).toBeNull();
  });

  test('renderBashRewritePreview returns null for notice-only shapes (cat -A)', () => {
    // Notice-only classifier hits don't produce a decision; preview
    // should fall through (agent sees the builtin bash render plus
    // the prepended notice from execute()).
    expect(renderBashRewritePreview({ command: 'cat -A foo.ts' }, theme, '/repo')).toBeNull();
  });

  test('renderBashRewriteResult delegates to fff rendering for routedVia=bash-to-fff_grep', () => {
    // Content is the clean forwarded fff output — no rewrite notice prefix.
    // The rewrite marker lives in `details.rewriteCall`.
    const result = {
      content: [
        {
          type: 'text',
          text: 'base_path: /repo\n\nsrc/router.ts:12: found foo here',
        },
      ],
      details: {
        routedVia: 'bash-to-fff_grep',
        rewriteCall: 'grep → fff_grep(patterns=["foo"], within="src/")',
      },
    };
    const rendered = renderBashRewriteResult(result, { expanded: false, isPartial: false }, theme, {
      cwd: '/repo',
    });
    expect(rendered).not.toBeNull();
    const text = renderText(rendered);
    // fff rendering produces a structured summary — file path should
    // appear in the rendered output.
    expect(text).toContain('router.ts');
  });

  test('renderBashRewriteResult delegates to read native renderer for routedVia=bash-to-read', () => {
    // With rewriteToParams present, read's own renderResult is invoked so
    // the expanded TUI shows the same syntax-highlighted file view the user
    // would see if they'd called read directly. Native read results are
    // collapsed until expanded, so this assertion uses expanded mode.
    const result = {
      content: [{ type: 'text', text: 'export const x = 1;' }],
      details: {
        routedVia: 'bash-to-read',
        rewriteToParams: { path: 'src/foo.ts' },
      },
    };
    const rendered = renderBashRewriteResult(result, { expanded: true, isPartial: false }, theme, {
      cwd: '/repo',
    });
    expect(rendered).not.toBeNull();
    const text = renderText(rendered);
    expect(text).toContain('export const x = 1;');
  });

  test('renderBashRewriteResult delegates to ls native renderer for routedVia=bash-to-ls', () => {
    const result = {
      content: [{ type: 'text', text: 'src/\ntests/\n' }],
      details: {
        routedVia: 'bash-to-ls',
        rewriteToParams: { path: '/repo' },
      },
    };
    const rendered = renderBashRewriteResult(result, { expanded: false, isPartial: false }, theme, {
      cwd: '/repo',
    });
    expect(rendered).not.toBeNull();
    const text = renderText(rendered);
    // The ls renderer surfaces directory entries somehow (exact format is
    // an SDK implementation detail, so we only assert a non-empty render).
    expect(text.length).toBeGreaterThan(0);
  });

  test('renderBashRewriteResult falls through for bash-to-read without rewriteToParams', () => {
    // Missing rewriteToParams means we can't feed the read renderer the
    // context it needs; return null so pi falls back to the bash render.
    const result = {
      content: [{ type: 'text', text: 'file contents' }],
      details: { routedVia: 'bash-to-read' },
    };
    expect(
      renderBashRewriteResult(result, { expanded: false, isPartial: false }, theme, {
        cwd: '/repo',
      }),
    ).toBeNull();
  });

  test('renderBashRewriteResult returns null when details has no routedVia', () => {
    const result = {
      content: [{ type: 'text', text: 'plain bash output' }],
      details: { foo: 'bar' },
    };
    expect(
      renderBashRewriteResult(result, { expanded: false, isPartial: false }, theme, {
        cwd: '/repo',
      }),
    ).toBeNull();
  });
});

describe('bashCommandContainsExpensiveTool — pass-through timeout-cap predicate', () => {
  test.each([
    ['grep -r foo .', true],
    ['rg --files', true],
    ['find . -name foo', true],
    ['fd -t f pattern', true],
    ['fdfind pattern', true],
    ['egrep -r foo .', true],
    ['fgrep -r foo .', true],
    ['ag foo', true],
    ['ack foo', true],
    ['git grep --heading foo', true],
    ['cat foo.ts | grep bar', true],
    ['ls -la | rg "foo bar"', true],
    // `tree` is unstructured but can dump thousands of lines on a
    // monorepo; capped to protect the context window.
    ['tree .', true],
    ['tree -L 3 src', true],
    ['cd packages && tree', true],
    ['echo "grepper" | cat', false],
    ['node --inspect findfile.ts', false],
    ['pnpm install', false],
    ['git status', false],
    ['echo hello', false],
    ['cat foo.ts', false],
    ['sed -n "1,20p" foo.ts', false],
    // Word-boundary sanity: identifiers with "tree" as a substring
    // (no separator) must not trip the cap. `tree-sitter` DOES trip
    // the cap because `\btree\b` treats `-` as a word boundary —
    // consistent with how we handle `grep-helper` / `find-me.sh`.
    // The 60s ceiling is harmless for those rare false positives.
    ['cat treeeee.txt', false],
    ['node treetraversal.ts', false],
  ])('contains expensive token in %j -> %s', (command, expected) => {
    expect(bashCommandContainsExpensiveTool(command)).toBe(expected);
  });
});
