import { describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import multiEditExtension from './index';
import * as mutationPlanModule from './mutation-plan';

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

function getApplyPatchTool() {
  const tools: any[] = [];
  multiEditExtension({
    registerTool(tool: any) {
      tools.push(tool);
    },
  } as any);
  return tools.find((tool) => tool.name === 'apply_patch');
}

function getEditTool() {
  const tools: any[] = [];
  multiEditExtension({
    registerTool(tool: any) {
      tools.push(tool);
    },
  } as any);
  return tools.find((tool) => tool.name === 'edit');
}

describe('multi-edit extension', () => {
  test('registers edit and apply_patch tools and appends prompt guidance', async () => {
    const tools: any[] = [];
    const handlers = new Map<string, Function[]>();
    const pi = {
      registerTool(tool: any) {
        tools.push(tool);
      },
      on(event: string, handler: Function) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    } as any;

    multiEditExtension(pi);

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('edit');
    expect(tools[0].parameters.properties.path).toBeDefined();
    expect(tools[0].parameters.properties.edits).toBeDefined();
    expect(tools[0].parameters.properties.patch).toBeDefined();

    expect(tools[1].name).toBe('apply_patch');
    expect(tools[1].parameters.properties.patch).toBeDefined();

    const beforeAgentStart = handlers.get('before_agent_start')?.[0];
    expect(beforeAgentStart).toBeTypeOf('function');
    if (!beforeAgentStart) {
      throw new Error('Expected before_agent_start handler');
    }
    const result = await beforeAgentStart({ systemPrompt: 'BASE' }, {});
    expect(result.systemPrompt).toContain('Always use apply_patch for manual code edits.');
    expect(result.systemPrompt).toContain('Do not use bash or shell file-mutation commands');
    expect(result.systemPrompt).toContain('when apply_patch or edit would suffice');
    expect(result.systemPrompt).toContain(
      'Use edit for exact text replacements with { path, edits[] }.',
    );
    expect(result.systemPrompt).toContain(
      'Use edit for exact text replacements with { path, edits[] }.',
    );

    // Cross-provider validation progression:
    //   1) Delimiters were being guessed wrong — we added a verbatim
    //      example.
    //   2) Unified-diff numbered hunks and bare '***' separators —
    //      guidance must explicitly call both out.
    //   3) Models assumed '@@ <label>' was a substring match — we
    //      added the WHOLE-LINE clarification.
    //   4) Residual @@ confusion (anchor preservation and the diff
    //      mental model) pushed us to make FindReplaceOnce the
    //      default and demote @@ to a rare-case shape. These
    //      assertions lock in the current ordering and copy.
    expect(result.systemPrompt).toContain('Canonical example');
    expect(result.systemPrompt).toContain(
      'DEFAULT: use *** FindReplaceOnce: for nearly every edit',
    );
    expect(result.systemPrompt).toContain('*** FindReplaceOnce:');
    expect(result.systemPrompt).toContain('*** FindReplaceAll:');
    expect(result.systemPrompt).toContain('<<<<<<< SEARCH');
    expect(result.systemPrompt).toContain('======= REPLACE');
    expect(result.systemPrompt).toContain('>>>>>>> REPLACE');
    // The canonical example should NOT feature a context-label anchor
    // since that was the primary source of residual confusion. Bare
    // @@ stays in the example so agents know the shape is available.
    expect(result.systemPrompt).not.toContain('@@ class UserService');
    // Unresolved template-literal fragments would break the example.
    expect(result.systemPrompt).not.toMatch(/\$\{'/);
    // Error-shape guidance remains.
    expect(result.systemPrompt).toContain('@@ -10,7 +10,7 @@');
    expect(result.systemPrompt).toContain('do not insert bare "***"');
    expect(result.systemPrompt).toContain('WHOLE-LINE anchor');
    // Final-round validation: gemini-2.5-flash wrote "+ hello" in
    // Add File and got leading spaces on every line. Guidance must
    // explicitly state no space after "+".
    expect(result.systemPrompt).toContain('NO space between the "+" and the content');
    // The "use @@ only when..." framing must be present.
    expect(result.systemPrompt).toMatch(
      /Use @@ hunks (only|ONLY) when you need several coordinated/,
    );
    expect(result.systemPrompt).toContain('apply_patch applies valid independent operations');
    expect(result.systemPrompt).not.toContain('Each apply_patch call is atomic');
    expect(result.systemPrompt).toContain(
      'All chunks within one *** Update File: block match against the ORIGINAL file state',
    );

    expect(tools[1].description).toBe(
      'Apply a Codex-style patch payload. Default to *** FindReplaceOnce: blocks for almost every edit (unique SEARCH/REPLACE). Use *** FindReplaceAll: for deliberate whole-line mass substitutions. Use @@ hunks only for complex coordinated edits that FindReplace would fracture. One payload can mix shapes.',
    );
    expect(tools[1].description).toContain('FindReplaceOnce');
    expect(tools[1].description).toContain('FindReplaceAll');
    expect(tools[1].description).toContain('Default to');
    expect(tools[1].parameters.properties.patch.description).toContain(
      'The patch value must be raw patch text only, with no Markdown fences, surrounding prose, or commentary.',
    );
    expect(tools[1].parameters.properties.patch.description).toContain(
      'Use this exact structure: *** Begin Patch / *** End Patch.',
    );
    expect(tools[1].parameters.properties.patch.description).toContain(
      'A pure rename may use *** Update File: followed immediately by *** Move to: with no @@ hunks.',
    );
    expect(tools[1].parameters.properties.patch.description).toContain(
      'For Add File, every content line must start with +.',
    );
    expect(tools[1].parameters.properties.patch.description).toContain(
      'Do not use git/unified diff syntax such as diff --git, ---, +++, or line-number hunks.',
    );
    expect(tools[1].parameters.properties.patch.description).toContain(
      'Use *** End of File when needed for EOF-sensitive changes.',
    );
    expect(tools[1].parameters.properties.patch.description).toContain(
      'stack multiple @@ context headers when needed',
    );
    expect(tools[1].promptGuidelines).toContain(
      'Use apply_patch with the exact patch envelope: *** Begin Patch ... *** End Patch.',
    );
    expect(tools[1].promptGuidelines).toContain(
      'For apply_patch, the patch value must be raw patch text only: no Markdown fences, no prose, no commentary.',
    );
    expect(tools[1].promptGuidelines).toContain(
      'For apply_patch, a rename-only patch may use *** Update File: plus *** Move to: with no @@ hunks.',
    );
    expect(tools[1].promptGuidelines).toContain(
      'For apply_patch, do not use git/unified diff syntax such as diff --git, ---, +++, or line-number hunks.',
    );
    expect(tools[1].promptGuidelines).toContain(
      'In apply_patch *** Update File: blocks, prefer *** FindReplaceOnce: for nearly every edit. Paste the exact text to change into SEARCH and what it should become into REPLACE. Delimiters: <<<<<<< SEARCH / ======= REPLACE / >>>>>>> REPLACE, each on its own line.',
    );
    expect(tools[1].promptGuidelines).toContain(
      'Use apply_patch *** FindReplaceAll: only when you deliberately want every whole-line occurrence replaced. Verify the reported match count.',
    );
    expect(tools[1].promptGuidelines).toContain(
      'Use apply_patch @@ hunks only when you need several coordinated -/+ changes in close proximity that would be awkward to split into separate FindReplaceOnce blocks. Do not reach for @@ for simple single-block rewrites.',
    );
    expect(tools[1].promptGuidelines).toContain(
      'In apply_patch, @@ is a bare marker on its own line. Line numbers are ignored (no @@ -10,7 +10,7 @@). There is no hunk separator — do not insert bare *** lines between chunks.',
    );
    // @@ context label is WHOLE-LINE and preserved as context.
    expect(tools[1].promptGuidelines.some((g: string) => g.includes('WHOLE-LINE match'))).toBe(
      true,
    );
    expect(tools[1].promptGuidelines).toContain(
      'In apply_patch, all chunks in one *** Update File: block match against the original file state, not against prior chunks within the same block. Split dependent edits into separate blocks or separate apply_patch calls.',
    );
    expect(tools[1].promptGuidelines).toContain(
      'apply_patch may partially apply independent operations. If a partial result reports failed or skipped files, read those files before retrying and avoid rereading applied files unless a specific dependency requires it.',
    );
    expect(tools[1].promptGuidelines).not.toContain(
      'Prefer apply_patch for manual code edits, file creation/deletion, and renames when a patch would suffice.',
    );
    expect(tools[1].promptGuidelines).not.toContain(
      'Use edit for exact text replacements with { path, edits[] }.',
    );
  });

  test('disables edit and write for gpt-5.4-based models', async () => {
    const tools: any[] = [];
    const handlers = new Map<string, Function[]>();
    let activeTools: string[] = ['read', 'edit', 'write', 'apply_patch'];
    const allTools = activeTools.map((name) => ({ name }));
    const pi = {
      registerTool(tool: any) {
        tools.push(tool);
      },
      on(event: string, handler: Function) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      getAllTools() {
        return allTools;
      },
      setActiveTools(names: string[]) {
        activeTools = [...names];
      },
    } as any;

    multiEditExtension(pi);

    const beforeAgentStart = handlers.get('before_agent_start')?.[0];
    expect(beforeAgentStart).toBeTypeOf('function');
    if (!beforeAgentStart) {
      throw new Error('Expected before_agent_start handler');
    }
    const result = await beforeAgentStart(
      { systemPrompt: 'BASE' },
      { model: { id: 'gpt-5.4', provider: 'openai' } },
    );

    expect(activeTools).toEqual(['read', 'apply_patch']);
    expect(result.systemPrompt).toContain('Always use apply_patch for manual code edits.');
    expect(result.systemPrompt).toContain('when apply_patch would suffice');
    expect(result.systemPrompt).toContain('*** FindReplaceOnce:');
    expect(result.systemPrompt).toContain('*** FindReplaceAll:');
    expect(result.systemPrompt).not.toContain(
      'Use edit for exact text replacements with { path, edits[] }.',
    );
    expect(result.systemPrompt).not.toContain('apply_patch or edit would suffice');
    expect(result.systemPrompt).not.toContain('copy/write commands');
  });

  test('keeps edit and write enabled for non-target models', async () => {
    const handlers = new Map<string, Function[]>();
    let activeTools: string[] = ['read', 'edit', 'write', 'apply_patch'];
    const allTools = activeTools.map((name) => ({ name }));
    const pi = {
      registerTool() {},
      on(event: string, handler: Function) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      getAllTools() {
        return allTools;
      },
      setActiveTools(names: string[]) {
        activeTools = [...names];
      },
    } as any;

    multiEditExtension(pi);

    const beforeAgentStart = handlers.get('before_agent_start')?.[0];
    expect(beforeAgentStart).toBeTypeOf('function');
    if (!beforeAgentStart) {
      throw new Error('Expected before_agent_start handler');
    }
    await beforeAgentStart(
      { systemPrompt: 'BASE' },
      { model: { id: 'claude-sonnet-4-6', provider: 'anthropic' } },
    );

    expect(activeTools).toEqual(['read', 'edit', 'write', 'apply_patch']);
  });

  test('blocks disabled tools at tool_call time for matching models', async () => {
    const handlers = new Map<string, Function[]>();
    const pi = {
      registerTool() {},
      on(event: string, handler: Function) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      getAllTools() {
        return [];
      },
      setActiveTools() {},
    } as any;

    multiEditExtension(pi);

    const toolCall = handlers.get('tool_call')?.[0];
    expect(toolCall).toBeTypeOf('function');
    if (!toolCall) {
      throw new Error('Expected tool_call handler');
    }
    const blocked = await toolCall(
      { toolName: 'write' },
      { model: { id: 'gpt-5.3-codex', provider: 'openai' } },
    );

    expect(blocked).toEqual({
      block: true,
      reason: "Tool 'write' is disabled for model 'openai/gpt-5.3-codex'; use apply_patch instead.",
    });
  });

  test('renderCall shows a header plus speculative preview rows before execution starts', () => {
    const tool = getApplyPatchTool();
    const component = tool.renderCall(
      {
        patch: `*** Begin Patch\n*** Update File: src/foo.ts\n@@\n-alpha\n+beta\n*** End Patch`,
      },
      createTheme(),
      { isPartial: true, executionStarted: false, argsComplete: false },
    );

    const rendered = component.render(160).join('\n');
    expect(rendered).toContain('apply_patch  1 operation');
    expect(rendered).toContain('◌ edit   src/foo.ts');
  });

  test('renderCall supports raw string patch args for the unified preview block', () => {
    const tool = getApplyPatchTool();
    const component = tool.renderCall(
      `*** Begin Patch\n*** Update File: src/foo.ts\n@@\n-alpha\n+beta\n*** End Patch`,
      createTheme(),
      { isPartial: true, executionStarted: false, argsComplete: false },
    );

    const rendered = component.render(160).join('\n');
    expect(rendered).toContain('apply_patch  1 operation');
    expect(rendered).toContain('◌ edit   src/foo.ts');
  });

  test('renderCall keeps previous preview rows during append-only parse regressions', () => {
    const tool = getApplyPatchTool();
    const state: Record<string, unknown> = {};
    const initialPatch = `*** Begin Patch
*** Update File: src/one.ts
@@
-alpha
+beta
*** Update File: src/two.ts
@@`;

    const initial = tool.renderCall({ patch: initialPatch }, createTheme(), {
      isPartial: true,
      executionStarted: false,
      argsComplete: false,
      state,
    });

    expect(initial.render(160).join('\n')).toContain('edit   src/two.ts');

    const regressed = tool.renderCall({ patch: `${initialPatch}\noops` }, createTheme(), {
      isPartial: true,
      executionStarted: false,
      argsComplete: false,
      state,
    });

    const rendered = regressed.render(160).join('\n');
    expect(rendered).toContain('apply_patch  2 operations');
    expect(rendered).toContain('src/one.ts');
    expect(rendered).toContain('src/two.ts');
  });

  test('renderCall collapses to a static header once args are complete', () => {
    const tool = getApplyPatchTool();
    const component = tool.renderCall(
      {
        patch: `*** Begin Patch\n*** Update File: src/foo.ts\n@@\n-alpha\n+beta\n*** End Patch`,
      },
      createTheme(),
      { isPartial: true, executionStarted: false, argsComplete: true },
    );

    const rendered = component.render(160).join('\n');
    expect(rendered).toContain('apply_patch  1 operation');
    expect(rendered).not.toContain('apply_patch: edit src/foo.ts');
  });

  test('renderCall does not show preview rows during resumed non-partial rendering', () => {
    const tool = getApplyPatchTool();
    const component = tool.renderCall(
      {
        patch: `*** Begin Patch\n*** Update File: src/foo.ts\n@@\n-alpha\n+beta\n*** End Patch`,
      },
      createTheme(),
      { isPartial: false, executionStarted: false, argsComplete: false },
    );

    const rendered = component.render(160).join('\n');
    expect(rendered).toContain('apply_patch  1 operation');
    expect(rendered).not.toContain('apply_patch: edit src/foo.ts');
  });

  test('renderCall resume keeps non-partial output free of cached speculative rows', () => {
    const tool = getApplyPatchTool();
    const component = tool.renderCall(
      {
        patch: `*** Begin Patch\n*** Update File: src/foo.ts\n@@\n-alpha\n+beta\n*** End Patch`,
      },
      createTheme(),
      {
        isPartial: false,
        executionStarted: false,
        argsComplete: false,
        state: {
          applyPatchRows: [
            {
              kind: 'edit',
              path: 'src/foo.ts',
              addedLines: 1,
              removedLines: 1,
              modifiedBytes: 9,
              renameOnly: false,
              state: 'staged',
            },
          ],
        },
      },
    );

    const rendered = component.render(160).join('\n');
    expect(rendered).toContain('apply_patch  1 operation');
    expect(rendered).not.toContain('edit   src/foo.ts  +1/-1L · 9B');
  });

  test('resume rendering does not show speculative rows when only staged/final rows are known', () => {
    const tool = getApplyPatchTool();
    const component = tool.renderCall(
      {
        patch: `*** Begin Patch\n*** Update File: demo.txt\n@@\n-alpha\n+beta\n*** End Patch`,
      },
      createTheme(),
      {
        isPartial: false,
        executionStarted: true,
        argsComplete: true,
        state: {
          applyPatchRows: [
            {
              id: 'op-0001',
              kind: 'edit',
              path: 'demo.txt',
              addedLines: 1,
              removedLines: 1,
              modifiedBytes: 4,
              renameOnly: false,
              state: 'staged',
            },
          ],
        },
      },
    );

    const text = component.render(120).join('\n');
    expect(text).toContain('apply_patch  1 operation');
    expect(text).not.toContain('○ edit');
    expect(text).not.toContain('apply_patch: edit demo.txt');
  });

  test('renderResult shows collapsed completed rows for a single operation', () => {
    const tool = getApplyPatchTool();
    const component = tool.renderResult(
      {
        content: [{ type: 'text', text: 'Applied patch with 1 operation(s).' }],
        details: {
          diff: 'File: src/foo.ts\n-1 alpha\n+1 beta',
          operations: [
            {
              kind: 'edit',
              path: 'src/foo.ts',
              addedLines: 1,
              removedLines: 1,
              modifiedBytes: 9,
              renameOnly: false,
              state: 'applied',
            },
          ],
        },
      },
      { expanded: false, isPartial: false },
      createTheme(),
      { args: { patch: '' }, isError: false },
    );

    const rendered = component.render(160).join('\n');
    expect(rendered).toContain('✓ edit   src/foo.ts');
    expect(rendered).not.toContain('apply_patch');
  });

  test('renderResult shows collapsed completed rows for multi-op output', () => {
    const tool = getApplyPatchTool();
    const component = tool.renderResult(
      {
        content: [{ type: 'text', text: 'Applied patch with 2 operation(s).' }],
        details: {
          operations: [
            {
              kind: 'edit',
              path: 'src/foo.ts',
              addedLines: 1,
              removedLines: 1,
              modifiedBytes: 9,
              renameOnly: false,
              state: 'applied',
            },
            {
              kind: 'create',
              path: 'src/bar.ts',
              addedLines: 3,
              removedLines: 0,
              modifiedBytes: 18,
              renameOnly: false,
              state: 'applied',
            },
          ],
        },
      },
      { expanded: false, isPartial: false },
      createTheme(),
      { args: { patch: '' }, isError: false },
    );

    const rendered = component.render(160).join('\n');
    expect(rendered).toContain('✓ edit   src/foo.ts');
    expect(rendered).toContain('✓ create src/bar.ts');
    expect(rendered).not.toContain('↳ completed');
  });

  test('renderResult keeps expanded completed view on the diff renderer', () => {
    const tool = getApplyPatchTool();
    const component = tool.renderResult(
      {
        content: [{ type: 'text', text: 'Applied patch with 1 operation(s).' }],
        details: {
          diff: 'File: src/foo.ts\n-1 alpha\n+1 beta',
          operations: [
            {
              kind: 'edit',
              path: 'src/foo.ts',
              addedLines: 1,
              removedLines: 1,
              modifiedBytes: 9,
              renameOnly: false,
              state: 'applied',
            },
          ],
        },
      },
      { expanded: true, isPartial: false },
      createTheme(),
      { args: { patch: '' }, isError: false },
    );

    expect(component.render(160).join('\n')).toContain('diff');
    expect(component.render(160).join('\n')).toContain('beta');
  });

  test('renderResult materializes lazy diff inputs only for expanded rendering', () => {
    const tool = getApplyPatchTool();
    const result = {
      content: [{ type: 'text', text: 'Applied patch with 1 operation(s).' }],
      details: {
        operations: [
          {
            kind: 'edit',
            path: 'src/foo.ts',
            addedLines: 1,
            removedLines: 1,
            modifiedBytes: 9,
            renameOnly: false,
            state: 'applied',
          },
        ],
        diffInputs: [
          {
            displayPath: 'src/foo.ts',
            beforeText: 'alpha\n',
            afterText: 'beta\n',
          },
        ],
      },
    };

    const collapsed = tool.renderResult(
      result,
      { expanded: false, isPartial: false },
      createTheme(),
      { args: { patch: '' }, isError: false },
    );
    const expanded = tool.renderResult(
      result,
      { expanded: true, isPartial: false },
      createTheme(),
      { args: { patch: '' }, isError: false },
    );

    expect(collapsed.render(160).join('\n')).toContain('✓ edit   src/foo.ts');
    expect(expanded.render(160).join('\n')).toContain('diff');
    expect(expanded.render(160).join('\n')).toContain('beta');
  });

  test('renderResult shows failed rows when operation metadata is available on error', () => {
    const tool = getApplyPatchTool();
    const component = tool.renderResult(
      {
        content: [{ type: 'text', text: 'Failed to apply patch.' }],
        details: {
          operations: [
            {
              kind: 'edit',
              path: 'src/foo.ts',
              addedLines: 1,
              removedLines: 1,
              modifiedBytes: 9,
              renameOnly: false,
              state: 'failed',
            },
          ],
        },
      },
      { expanded: false, isPartial: false },
      createTheme(),
      { args: { patch: '' }, isError: true },
    );

    expect(component.render(160).join('\n')).toContain('✗');
    expect(component.render(160).join('\n')).toContain('edit   src/foo.ts');
  });

  test('renderResult preserves applied rows when later rows fail', () => {
    const tool = getApplyPatchTool();
    const component = tool.renderResult(
      {
        content: [{ type: 'text', text: 'Failed to apply patch.' }],
        details: {
          operations: [
            {
              kind: 'edit',
              path: 'src/one.ts',
              addedLines: 1,
              removedLines: 1,
              modifiedBytes: 9,
              renameOnly: false,
              state: 'applied',
            },
            {
              kind: 'edit',
              path: 'src/two.ts',
              addedLines: 1,
              removedLines: 1,
              modifiedBytes: 9,
              renameOnly: false,
              state: 'streamed',
            },
          ],
        },
      },
      { expanded: false, isPartial: false },
      createTheme(),
      { args: { patch: '' }, isError: true },
    );

    const rendered = component.render(160).join('\n');
    expect(rendered).toContain('✓ edit   src/one.ts');
    expect(rendered).toContain('✗ edit   src/two.ts');
  });

  test('renderResult preserves untouched trailing rows when explicit failed rows are provided', () => {
    const tool = getApplyPatchTool();
    const component = tool.renderResult(
      {
        content: [{ type: 'text', text: 'Failed to apply patch.' }],
        details: {
          operations: [
            {
              kind: 'edit',
              path: 'src/one.ts',
              addedLines: 1,
              removedLines: 1,
              modifiedBytes: 9,
              renameOnly: false,
              state: 'applied',
            },
            {
              kind: 'edit',
              path: 'src/two.ts',
              addedLines: 1,
              removedLines: 1,
              modifiedBytes: 9,
              renameOnly: false,
              state: 'failed',
            },
            {
              kind: 'delete',
              path: 'src/three.ts',
              state: 'streamed',
            },
          ],
        },
      },
      { expanded: false, isPartial: false },
      createTheme(),
      { args: { patch: '' }, isError: true },
    );

    const rendered = component.render(160).join('\n');
    expect(rendered).toContain('✓ edit   src/one.ts');
    expect(rendered).toContain('✗ edit   src/two.ts');
    expect(rendered).toContain('○ delete src/three.ts');
  });

  test('renderResult converts cached preview rows to failed rows when no explicit failure rows exist', () => {
    const tool = getApplyPatchTool();
    const component = tool.renderResult(
      {
        content: [{ type: 'text', text: 'Patch failed.' }],
        details: {},
      },
      { expanded: false, isPartial: false },
      createTheme(),
      {
        args: { patch: '' },
        isError: true,
        state: {
          applyPatchRows: [
            {
              kind: 'edit',
              path: 'src/foo.ts',
              addedLines: 1,
              removedLines: 1,
              modifiedBytes: 9,
              renameOnly: false,
              state: 'streaming',
            },
          ],
        },
      },
    );

    const rendered = component.render(160).join('\n');
    expect(rendered).toContain('✗');
    expect(rendered).not.toContain('○ +1/-1L');
  });

  test('renderResult keeps delete-only expanded output metadata-first', () => {
    const tool = getApplyPatchTool();
    const component = tool.renderResult(
      {
        content: [{ type: 'text', text: 'Applied patch with 1 operation(s).' }],
        details: {
          operations: [
            {
              kind: 'delete',
              path: 'src/obsolete.ts',
              state: 'applied',
              contentKind: 'text',
              byteLength: 12,
              lineCount: 2,
            },
          ],
        },
      },
      { expanded: true, isPartial: false },
      createTheme(),
      { args: { patch: '' }, isError: false },
    );

    const rendered = component.render(160).join('\n');
    expect(rendered).toContain('✓ delete src/obsolete.ts');
    expect(rendered).toContain('text · 2L · 12B');
  });

  test('renderResult appends delete metadata in expanded mixed-operation output', () => {
    const tool = getApplyPatchTool();
    const component = tool.renderResult(
      {
        content: [{ type: 'text', text: 'Applied patch with 2 operation(s).' }],
        details: {
          diff: 'File: src/foo.ts\n-1 alpha\n+1 beta',
          operations: [
            {
              kind: 'edit',
              path: 'src/foo.ts',
              addedLines: 1,
              removedLines: 1,
              modifiedBytes: 9,
              renameOnly: false,
              state: 'applied',
            },
            {
              kind: 'delete',
              path: 'src/obsolete.ts',
              state: 'applied',
              contentKind: 'text',
              byteLength: 12,
              lineCount: 2,
            },
          ],
        },
      },
      { expanded: true, isPartial: false },
      createTheme(),
      { args: { patch: '' }, isError: false },
    );

    const rendered = component.render(160).join('\n');
    expect(rendered).toContain('diff');
    expect(rendered).toContain('beta');
    expect(rendered).toContain('✓ delete src/obsolete.ts');
    expect(rendered).toContain('text · 2L · 12B');
  });

  test('renderCall collapses to a static header once execution starts', () => {
    const tool = getApplyPatchTool();
    const component = tool.renderCall(
      {
        patch: `*** Begin Patch\n*** Update File: src/foo.ts\n@@\n-alpha\n+beta\n*** End Patch`,
      },
      createTheme(),
      {
        isPartial: false,
        executionStarted: true,
        argsComplete: true,
        state: {
          applyPatchRows: [
            {
              kind: 'edit',
              path: 'src/foo.ts',
              addedLines: 1,
              removedLines: 1,
              modifiedBytes: 9,
              renameOnly: false,
              state: 'applied',
            },
          ],
        },
      },
    );

    expect(component.render(160).join('\n')).toContain('apply_patch  1 operation');
    expect(component.render(160).join('\n')).not.toContain('apply_patch: edit src/foo.ts');
  });

  test('execute emits an immediate applying update before real patch operations complete', async () => {
    const tool = getApplyPatchTool();
    const dir = await mkdtemp(join(tmpdir(), 'apply-patch-live-update-'));

    try {
      const filePath = join(dir, 'demo.txt');
      await writeFile(filePath, 'alpha\n', 'utf8');

      const updates: any[] = [];
      await tool.execute(
        'tool-call-id',
        {
          patch: `*** Begin Patch
*** Update File: ${filePath}
@@
-alpha
+beta
*** Add File: ${join(dir, 'new.txt')}
+hello
*** End Patch`,
        },
        undefined,
        (partialResult: any) => {
          updates.push(partialResult);
        },
        { cwd: dir },
      );

      expect(updates.length).toBeGreaterThan(0);
      expect(updates[0]?.details?.operations).toEqual([
        expect.objectContaining({ kind: 'edit', state: 'committing' }),
        expect.objectContaining({ kind: 'create', state: 'committing' }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('apply_patch execution reports reusedStage when finalized from session state', async () => {
    const tool = getApplyPatchTool();
    const dir = await mkdtemp(join(tmpdir(), 'apply-patch-reused-stage-'));

    try {
      const filePath = join(dir, 'demo.txt');
      await writeFile(filePath, 'alpha\n', 'utf8');
      const patchText = `*** Begin Patch
*** Update File: ${filePath}
@@
-alpha
+beta
*** End Patch`;
      const state: Record<string, unknown> = {};

      tool.renderCall({ patch: patchText }, createTheme(), {
        isPartial: true,
        argsComplete: false,
        state,
        cwd: dir,
      });

      const result = await tool.execute(
        'tool-call-id',
        { patch: patchText },
        undefined,
        undefined,
        { cwd: dir, state },
      );

      expect(result.details?.execution?.reusedStage).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('apply_patch returns partial success details when independent operations apply', async () => {
    const tool = getApplyPatchTool();
    const cwd = await mkdtemp(join(tmpdir(), 'multi-edit-partial-'));

    try {
      await writeFile(join(cwd, 'a.txt'), 'old a\n', 'utf8');
      await writeFile(join(cwd, 'b.txt'), 'old b\n', 'utf8');

      const result = await tool.execute(
        'call-partial',
        {
          patch: `*** Begin Patch
*** Update File: a.txt
@@
-old a
+new a
*** Update File: missing.txt
@@
-old missing
+new missing
*** Update File: b.txt
@@
-old b
+new b
*** End Patch`,
        },
        undefined,
        undefined,
        { cwd, state: {} },
      );

      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toContain('partially applied 2 of 3 operations');
      expect(result.content[0]?.text).toContain('Failed details:');
      expect(result.content[0]?.text).toContain('- op-0002 update missing.txt: File not found:');
      expect(result.details.execution.partial).toBe(true);
      expect(result.details.execution.appliedRows.map((row: any) => row.path)).toEqual([
        'a.txt',
        'b.txt',
      ]);
      expect(result.details.execution.failedRows.map((row: any) => row.path)).toEqual([
        'missing.txt',
      ]);
      expect(result.details.execution.failedDiagnostics).toEqual([
        expect.objectContaining({
          opId: 'op-0002',
          path: 'missing.txt',
          diagnostic: expect.stringContaining('File not found:'),
        }),
      ]);
      await expect(readFile(join(cwd, 'a.txt'), 'utf8')).resolves.toBe('new a\n');
      await expect(readFile(join(cwd, 'b.txt'), 'utf8')).resolves.toBe('new b\n');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('apply_patch reports failed and skipped diagnostics when a later op is blocked', async () => {
    const tool = getApplyPatchTool();
    const cwd = await mkdtemp(join(tmpdir(), 'multi-edit-partial-skipped-'));

    try {
      await writeFile(join(cwd, 'b.txt'), 'old b\nshared b\n', 'utf8');
      await writeFile(join(cwd, 'c.txt'), 'old c\n', 'utf8');
      const begin = '*** Begin ' + 'Patch';
      const end = '*** End ' + 'Patch';

      const result = await tool.execute(
        'call-partial-skipped',
        {
          patch: `${begin}
*** Update File: b.txt
*** FindReplaceOnce:
<<<<<<< SEARCH
not in b
======= REPLACE
new b
>>>>>>> REPLACE
*** Update File: b.txt
*** FindReplaceOnce:
<<<<<<< SEARCH
shared b
======= REPLACE
shared b should skip
>>>>>>> REPLACE
*** Update File: c.txt
@@
-old c
+new c
${end}`,
        },
        undefined,
        undefined,
        { cwd, state: {} },
      );

      expect(result.isError).not.toBe(true);
      expect(result.content[0]?.text).toContain('partially applied 1 of 3 operations');
      expect(result.content[0]?.text).toContain('Failed details:');
      expect(result.content[0]?.text).toContain(
        '- op-0001 update b.txt: No match for expected lines "not in b"',
      );
      expect(result.content[0]?.text).toContain('nearest line 1 is "old b"');
      expect(result.content[0]?.text).toContain('Skipped details:');
      expect(result.content[0]?.text).toContain(
        '- op-0002 update b.txt: skipped because an earlier failed operation touched b.txt.',
      );
      expect(result.details.execution.failedDiagnostics).toEqual([
        expect.objectContaining({
          opId: 'op-0001',
          path: 'b.txt',
          diagnostic: expect.stringContaining('No match for expected lines "not in b"'),
        }),
      ]);
      expect(result.details.execution.skippedDiagnostics).toEqual([
        expect.objectContaining({
          opId: 'op-0002',
          path: 'b.txt',
          diagnostic: 'skipped because an earlier failed operation touched b.txt.',
        }),
      ]);
      await expect(readFile(join(cwd, 'b.txt'), 'utf8')).resolves.toBe('old b\nshared b\n');
      await expect(readFile(join(cwd, 'c.txt'), 'utf8')).resolves.toBe('new c\n');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('apply_patch returns hard error when no operations apply', async () => {
    const tool = getApplyPatchTool();
    const cwd = await mkdtemp(join(tmpdir(), 'multi-edit-partial-none-'));

    try {
      await writeFile(join(cwd, 'a.txt'), 'old a\n', 'utf8');
      const result = await tool.execute(
        'call-partial-none',
        {
          patch: `*** Begin Patch
*** Update File: a.txt
@@
-missing
+new
*** End Patch`,
        },
        undefined,
        undefined,
        { cwd, state: {} },
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Failed to apply patch');
      await expect(readFile(join(cwd, 'a.txt'), 'utf8')).resolves.toBe('old a\n');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('apply_patch success persists compact diff instead of lazy diff inputs', async () => {
    const tool = getApplyPatchTool();
    const dir = await mkdtemp(join(tmpdir(), 'apply-patch-compact-diff-'));

    try {
      const filePath = join(dir, 'demo.txt');
      await writeFile(filePath, 'alpha\n', 'utf8');

      const result = await tool.execute(
        'tool-call-id',
        {
          patch: `*** Begin Patch
*** Update File: ${filePath}
@@
-alpha
+beta
*** End Patch`,
        },
        undefined,
        undefined,
        { cwd: dir },
      );

      expect(result.details?.diff).toContain('beta');
      expect(result.details?.firstChangedLine).toBe(1);
      expect(result.details?.diffInputs).toBeUndefined();
      expect(result.details?.execution).toMatchObject({
        ok: true,
        mode: 'logicalAtomicPerFile',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('executePatch returns structured failure details', async () => {
    const tool = getApplyPatchTool();
    const dir = await mkdtemp(join(tmpdir(), 'apply-patch-structured-failure-'));
    const filePath = join(dir, 'a.txt');
    await writeFile(filePath, 'alpha\n', 'utf8');

    const commitSpy = vi.spyOn(mutationPlanModule, 'commitMutationPlan').mockResolvedValue({
      ok: false,
      rows: [
        {
          id: 'op-0001',
          kind: 'edit',
          path: filePath,
          addedLines: 1,
          removedLines: 1,
          modifiedBytes: 9,
          renameOnly: false,
          state: 'streamed',
        },
        {
          id: 'op-0002',
          kind: 'move',
          path: filePath,
          targetPath: join(dir, 'c.txt'),
          addedLines: 0,
          removedLines: 0,
          modifiedBytes: 0,
          renameOnly: true,
          state: 'streamed',
        },
        {
          id: 'op-0003',
          kind: 'edit',
          path: join(dir, 'c.txt'),
          addedLines: 1,
          removedLines: 1,
          modifiedBytes: 9,
          renameOnly: false,
          state: 'streamed',
        },
      ],
      failure: {
        index: 0,
        row: undefined,
        error: 'Synthetic coalesced failure',
        appliedRows: [
          {
            id: 'op-0001',
            kind: 'edit',
            path: filePath,
            addedLines: 1,
            removedLines: 1,
            modifiedBytes: 9,
            renameOnly: false,
            state: 'streamed',
          },
        ],
        notRunRows: [
          {
            id: 'op-0002',
            kind: 'move',
            path: filePath,
            targetPath: join(dir, 'c.txt'),
            addedLines: 0,
            removedLines: 0,
            modifiedBytes: 0,
            renameOnly: true,
            state: 'streamed',
          },
          {
            id: 'op-0003',
            kind: 'edit',
            path: join(dir, 'c.txt'),
            addedLines: 1,
            removedLines: 1,
            modifiedBytes: 9,
            renameOnly: false,
            state: 'streamed',
          },
        ],
        rollbackAttempted: true,
        rollbackSucceeded: true,
      },
    });

    try {
      const result = await tool.execute(
        'tool-call-id',
        {
          patch: `*** Begin Patch
*** Update File: ${filePath}
*** Move to: ${join(dir, 'c.txt')}
*** Update File: ${join(dir, 'c.txt')}
@@
-alpha
+beta
*** End Patch`,
        },
        undefined,
        undefined,
        { cwd: dir },
      );

      expect(commitSpy).toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(result.details?.execution?.failure?.appliedRows).toHaveLength(1);
      expect(result.details?.execution?.failure?.notRunRows).toHaveLength(2);
      expect(result.details?.operations).toEqual([
        expect.objectContaining({ id: 'op-0001', state: 'applied' }),
        expect.objectContaining({ id: 'op-0002', state: 'failed' }),
      ]);
    } finally {
      commitSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('executePatch surfaces near-miss rendering on plan-phase context-match failure', async () => {
    const tool = getApplyPatchTool();
    const dir = await mkdtemp(join(tmpdir(), 'apply-patch-near-miss-'));
    const filePath = join(dir, 'foo.ts');
    await writeFile(
      filePath,
      [
        'export function one() {',
        '  return 1;',
        '}',
        '',
        'export async function loadResolverConfig() {',
        '  await initConfigLoader();',
        '  const config = await loadConfig();',
        '  return config.port ?? 3000;',
        '}',
      ].join('\n') + '\n',
      'utf8',
    );

    try {
      const result = await tool.execute(
        tool,
        {
          patch: [
            '*** Begin Patch',
            `*** Update File: ${filePath}`,
            '@@',
            '-  const config = loadConfig();',
            '-  return config.port;',
            '+  const config = await loadConfig();',
            '+  return config.port ?? 3000;',
            '*** End Patch',
          ].join('\n'),
        },
        undefined,
        undefined,
        { cwd: dir },
      );

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: 'text'; text: string }>)[0]!.text;
      // Lookahead aggregates even a single failure into a plan-failed
      // response. Header names the counts; the per-op body carries
      // the unified-diff near-miss rendering.
      expect(text).toMatch(/Failed to apply patch\. 1 operation would fail/);
      expect(text).toMatch(/Near-miss in .*foo\.ts at line \d+ \(\d+% similar/);
      expect(text).toMatch(/^\s+\d+ - +const config = loadConfig\(\);$/m);
      expect(text).toMatch(/^\s+\d+ \+ +const config = await loadConfig\(\);$/m);
      // Structured payload attached: aggregated list of failures.
      expect(result.details?.planFailures).toHaveLength(1);
      expect(result.details?.planFailures[0]).toMatchObject({
        kind: 'context-not-found',
        expectedLines: ['  const config = loadConfig();', '  return config.port;'],
      });
      expect(result.details?.planFailures[0].nearestMatch).toBeDefined();
      expect(result.details?.execution).toMatchObject({ ok: false, phase: 'plan' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('executePatch surfaces anchor-miss rendering with nearby identifiers', async () => {
    const tool = getApplyPatchTool();
    const dir = await mkdtemp(join(tmpdir(), 'apply-patch-anchor-miss-'));
    const filePath = join(dir, 'foo.py');
    await writeFile(
      filePath,
      ['def foo_helper(x):', '    return x + 1', '', 'def handle_foo(y):', '    return y * 2'].join(
        '\n',
      ) + '\n',
      'utf8',
    );

    try {
      const result = await tool.execute(
        tool,
        {
          patch: [
            '*** Begin Patch',
            `*** Update File: ${filePath}`,
            '@@ def nonexistent',
            '-    return x + 1',
            '+    return x + 2',
            '*** End Patch',
          ].join('\n'),
        },
        undefined,
        undefined,
        { cwd: dir },
      );

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: 'text'; text: string }>)[0]!.text;
      expect(text).toMatch(/Failed to apply patch\. 1 operation would fail/);
      expect(text).toMatch(/Failed to find anchor 'def nonexistent'/);
      expect(text).toContain('Nearby identifiers:');
      expect(text).toContain('def foo_helper(x):');
      expect(result.details?.planFailures[0]).toMatchObject({
        kind: 'anchor-not-found',
        anchor: 'def nonexistent',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('classic edit returns execution details with mode and compact diff', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-edit-classic-'));
    const filePath = join(dir, 'demo.txt');
    await writeFile(filePath, 'alpha\n', 'utf8');

    try {
      const editTool = getEditTool();
      const result = await editTool.execute(
        'tool-call-id',
        { path: filePath, edits: [{ oldText: 'alpha', newText: 'beta' }] },
        undefined,
        undefined,
        { cwd: dir },
      );

      expect(result.details?.execution).toMatchObject({
        ok: true,
        mode: 'logicalAtomicPerFile',
      });
      expect(result.details?.diff).toContain('beta');
      expect(result.details?.firstChangedLine).toBe(1);
      expect(result.details?.diffInputs).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('classic edit surfaces rollback metadata from commit failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-edit-classic-failure-'));
    const filePath = join(dir, 'demo.txt');
    await writeFile(filePath, 'alpha\n', 'utf8');

    const commitSpy = vi.spyOn(mutationPlanModule, 'commitMutationPlan').mockResolvedValue({
      ok: false,
      rows: [],
      failure: {
        index: 0,
        row: undefined,
        error: 'Synthetic failure',
        appliedRows: [],
        notRunRows: [],
        rollbackAttempted: true,
        rollbackSucceeded: true,
      },
    });

    try {
      const editTool = getEditTool();
      const result = await editTool.execute(
        'tool-call-id',
        { path: filePath, edits: [{ oldText: 'alpha', newText: 'beta' }] },
        undefined,
        undefined,
        { cwd: dir },
      );

      expect(commitSpy).toHaveBeenCalled();
      expect(result.details?.execution?.mode).toBe('logicalAtomicPerFile');
      expect(result.details?.execution?.failure).toMatchObject({
        rollbackAttempted: true,
        rollbackSucceeded: true,
      });
    } finally {
      commitSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('classic edit versions the same content snapshot used for before.text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multi-edit-classic-version-snapshot-'));
    const filePath = join(dir, 'demo.txt');
    await writeFile(filePath, 'alpha\n', 'utf8');

    const snapshotSpy = vi.spyOn(mutationPlanModule, 'buildFileVersionTokenFromTextSnapshot');
    const legacyTokenSpy = vi.spyOn(mutationPlanModule, 'buildFileVersionToken');
    const commitSpy = vi
      .spyOn(mutationPlanModule, 'commitMutationPlan')
      .mockImplementation(async (plan: any) => ({
        ok: true,
        rows: plan.rows,
        diff: '',
        summaryText: plan.summaryText,
      }));

    try {
      const editTool = getEditTool();
      await editTool.execute(
        'tool-call-id',
        { path: filePath, edits: [{ oldText: 'alpha', newText: 'beta' }] },
        undefined,
        undefined,
        { cwd: dir },
      );

      expect(legacyTokenSpy).not.toHaveBeenCalled();
      expect(snapshotSpy).toHaveBeenCalledWith(filePath, 'alpha\n', expect.any(Number));

      const planned = commitSpy.mock.calls[0]?.[0] as any;
      expect(planned).toBeDefined();
      const mutation = planned.mutations[0];
      expect(mutation.before.text).toBe('alpha\n');
      expect(planned.sourceVersions[0]).toEqual(mutation.before.version);
      expect(planned.sourceVersions[0].sha256).toBe(
        createHash('sha256').update('alpha\n', 'utf8').digest('hex'),
      );
    } finally {
      snapshotSpy.mockRestore();
      legacyTokenSpy.mockRestore();
      commitSpy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
