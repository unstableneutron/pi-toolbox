import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';

import bashRewriteExtension, {
  BASH_REWRITE_API_VERSION,
  BASH_REWRITE_PROVIDER_PRIORITY_RULE,
  BASH_REWRITE_TARGET_POLICY,
  bashCommandContainsExpensiveTool,
} from './index';

const PACKAGE_JSON_PATH = fileURLToPath(new URL('./package.json', import.meta.url));
const PACKAGE_GREP_COMMAND = `grep -n "pi-bash-rewrite" ${JSON.stringify(PACKAGE_JSON_PATH)}`;

function createHarness(activeTools = ['bash', 'read', 'ls', 'fff_grep', 'fff_find_files']) {
  const tools: any[] = [];
  const handlers = new Map<string, Function>();
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  const pi = {
    registerTool(tool: any) {
      tools.push(tool);
    },
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
    getActiveTools() {
      return activeTools;
    },
    events: {
      on(event: string, handler: (data: unknown) => void) {
        const list = eventHandlers.get(event) ?? [];
        list.push(handler);
        eventHandlers.set(event, list);
        return () => {
          eventHandlers.set(
            event,
            (eventHandlers.get(event) ?? []).filter((candidate) => candidate !== handler),
          );
        };
      },
      emit(event: string, data: unknown) {
        for (const handler of eventHandlers.get(event) ?? []) handler(data);
      },
    },
  } as any;

  bashRewriteExtension(pi);
  return { tools, handlers, eventHandlers, pi };
}

describe('bash-rewrite orchestrator', () => {
  test('registers exactly one bash override', () => {
    const { tools } = createHarness();
    expect(tools.map((tool) => tool.name)).toEqual(['bash']);
  });

  test('exports the closed target and deterministic provider-priority contract', () => {
    expect(BASH_REWRITE_API_VERSION).toBe(1);
    expect(BASH_REWRITE_TARGET_POLICY).toBe('closed-v1');
    expect(BASH_REWRITE_PROVIDER_PRIORITY_RULE).toBe('higher-priority-then-provider-id');
  });

  test('dispatches grep rewrites to an event-collected provider', async () => {
    const { tools, pi } = createHarness();
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'base_path: /repo/src\n\nrouter.ts:1: foo' }],
      details: { providerDetails: true },
    }));

    pi.events.on('bash-rewrite:collect-providers', (payload: any) => {
      payload.register({
        id: 'test-fff',
        priority: 100,
        tools: ['fff_grep'],
        execute,
      });
    });

    const result = await tools[0].execute(
      'tool-call',
      { command: 'grep -rn "foo" src/ | head -20' },
      undefined,
      undefined,
      { cwd: '/repo' },
    );

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'fff_grep',
        params: expect.objectContaining({ patterns: ['foo'], limit: 20 }),
        recognizer: 'grep-search+head',
      }),
      expect.objectContaining({ originalCommand: 'grep -rn "foo" src/ | head -20' }),
    );
    expect(result.details).toMatchObject({
      providerDetails: true,
      routedVia: 'bash-to-fff_grep',
      rewriteProviderId: 'test-fff',
      rewriteRecognizer: 'grep-search+head',
    });
  });

  test('selects higher-priority providers and uses provider id as the tie-breaker', async () => {
    const { tools, pi } = createHarness();
    const calls: string[] = [];
    pi.events.on('bash-rewrite:collect-providers', (payload: any) => {
      for (const [id, priority] of [
        ['z-low', 10],
        ['z-high', 100],
        ['a-high', 100],
      ] as const) {
        payload.register({
          id,
          priority,
          tools: ['fff_grep'],
          async execute() {
            calls.push(id);
            return { content: [{ type: 'text', text: id }] };
          },
        });
      }
    });

    const result = await tools[0].execute(
      'tool-call',
      { command: 'grep -rn "foo" src/' },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    expect(calls).toEqual(['a-high']);
    expect(result.details.rewriteProviderId).toBe('a-high');
  });

  test('passes renderCall context through to rewrite provider previews', () => {
    const { tools, pi } = createHarness();
    const state = { marker: true };
    const renderPreview = vi.fn((_decision, _theme, runtime) => ({
      render: () => [`started=${String(runtime.executionStarted)}`],
    }));

    pi.events.on('bash-rewrite:collect-providers', (payload: any) => {
      payload.register({
        id: 'test-fff',
        priority: 100,
        tools: ['fff_grep'],
        execute: vi.fn(),
        renderPreview,
      });
    });

    const rendered = tools[0]
      .renderCall(
        { command: 'grep -rn "foo" src/ | head -20' },
        {},
        {
          cwd: '/repo',
          isPartial: false,
          executionStarted: true,
          argsComplete: true,
          state,
        },
      )
      .render(120)
      .join('\n');

    expect(rendered).toContain('started=true');
    expect(renderPreview).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        cwd: '/repo',
        isPartial: false,
        executionStarted: true,
        argsComplete: true,
        state,
      }),
    );
  });

  test('caches preview collection by command, cwd, and active-tool state', () => {
    const activeTools = ['bash', 'fff_grep'];
    const { tools, pi } = createHarness(activeTools);
    let collectCount = 0;
    pi.events.on('bash-rewrite:collect-providers', (payload: any) => {
      collectCount += 1;
      payload.register({
        id: 'test-fff',
        tools: ['fff_grep'],
        execute: vi.fn(),
        renderPreview: () => ({ render: () => ['preview'] }),
      });
    });
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const args = { command: 'grep -rn "foo" src/' };

    tools[0].renderCall(args, theme, { cwd: '/repo' }).render(80);
    tools[0].renderCall(args, theme, { cwd: '/repo' }).render(80);
    expect(collectCount).toBe(1);

    activeTools.push('read');
    tools[0].renderCall(args, theme, { cwd: '/repo' }).render(80);
    expect(collectCount).toBe(2);
  });

  test('refreshes providers at the next turn and does not reuse stale previews', async () => {
    const { tools, handlers, pi } = createHarness(['bash', 'fff_grep']);
    let providerAvailable = true;
    pi.events.on('bash-rewrite:collect-providers', (payload: any) => {
      if (!providerAvailable) return;
      payload.register({
        id: 'test-fff',
        tools: ['fff_grep'],
        execute: vi.fn(),
        renderPreview: () => ({ render: () => ['provider-preview'] }),
      });
    });
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const args = { command: 'grep -rn "foo" src/' };

    expect(tools[0].renderCall(args, theme, { cwd: '/repo' }).render(80)).toEqual([
      'provider-preview',
    ]);

    providerAvailable = false;
    const diagnostic = await handlers.get('before_agent_start')!({ systemPrompt: 'BASE' });
    const result = await tools[0].execute(
      'tool-call',
      { command: PACKAGE_GREP_COMMAND },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        sessionManager: {
          getSessionId: () => 'provider-refresh-test',
          getSessionFile: () => '/tmp/provider-refresh-test.jsonl',
        },
      },
    );

    expect(diagnostic.systemPrompt).toContain(
      'no provider is registered for active target(s): fff_grep',
    );
    expect(result.content[0].text).toContain('"name": "pi-bash-rewrite"');
    expect(result.content[0].text).not.toContain('base_path:');
  });

  test('renders legacy routedVia metadata for every provider tool', () => {
    const { tools, pi } = createHarness();
    const renderResult = vi.fn(() => ({ render: () => ['second-tool-renderer'] }));
    pi.events.on('bash-rewrite:collect-providers', (payload: any) => {
      payload.register({
        id: 'test-fff',
        tools: ['fff_grep', 'fff_find_files'],
        execute: vi.fn(),
        renderResult,
      });
    });

    const rendered = tools[0].renderResult(
      {
        content: [{ type: 'text', text: 'base_path: /repo\n\nsrc/file.ts' }],
        details: { routedVia: 'bash-to-fff_find_files', rewriteToParams: { query: 'file' } },
      },
      { expanded: false, isPartial: false },
      { fg: (_color: string, text: string) => text },
      { cwd: '/repo' },
    );

    expect(rendered.render(80)).toEqual(['second-tool-renderer']);
    expect(renderResult).toHaveBeenCalledOnce();
  });

  test('renders builtin read rewrite results without collecting external providers', () => {
    const { tools, pi } = createHarness();
    let collectCount = 0;
    pi.events.on('bash-rewrite:collect-providers', () => {
      collectCount += 1;
    });

    const result = {
      content: [{ type: 'text' as const, text: 'large output that should stay collapsed' }],
      details: {
        routedVia: 'bash-to-read',
        rewriteProviderId: 'bash-rewrite.builtin-read',
        rewriteToParams: { path: 'package.json' },
      },
    };

    const rendered = tools[0].renderResult(
      result,
      { expanded: false, isPartial: false },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      { cwd: '/repo', showImages: false, isError: false, state: {} },
    );

    expect(rendered.render(80)).toEqual([]);
    expect(collectCount).toBe(0);
  });

  test('keeps the expensive-command timeout when provider execution falls back', async () => {
    const { tools, pi } = createHarness();
    const execute = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    pi.events.on('bash-rewrite:collect-providers', (payload: any) => {
      payload.register({
        id: 'test-fff',
        tools: ['fff_grep'],
        fallbackOnExecuteError: true,
        execute,
      });
    });

    const result = await tools[0].execute(
      'tool-call',
      { command: PACKAGE_GREP_COMMAND },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        sessionManager: {
          getSessionId: () => 'fallback-test',
          getSessionFile: () => '/tmp/fallback-test.jsonl',
        },
      },
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(result.content[0].text).toMatch(/^\(60s timeout\)/);
  });

  test('reports missing providers once and passes through without activating tools', async () => {
    const { tools, handlers } = createHarness(['bash', 'fff_grep', 'apply_patch']);
    const beforeAgentStart = handlers.get('before_agent_start')!;
    const first = await beforeAgentStart({ systemPrompt: 'BASE' });
    const second = await beforeAgentStart({ systemPrompt: 'BASE' });
    const result = await tools[0].execute(
      'tool-call',
      { command: PACKAGE_GREP_COMMAND },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        sessionManager: {
          getSessionId: () => 'missing-provider-test',
          getSessionFile: () => '/tmp/missing-provider-test.jsonl',
        },
      },
    );

    expect(first.systemPrompt).toContain('no external providers are registered');
    expect(first.systemPrompt).toContain(
      'no provider is registered for active target(s): apply_patch, fff_grep',
    );
    expect(first.systemPrompt).toContain('this notice does not activate tools');
    expect(second).toBeUndefined();
    expect(result.content[0].text).toContain('"name": "pi-bash-rewrite"');
    expect(result.content[0].text).not.toContain('base_path:');
  });

  test('does not warn about deliberately inactive provider targets', async () => {
    const { handlers, pi } = createHarness(['bash', 'read']);
    pi.events.on('bash-rewrite:collect-providers', (payload: any) => {
      payload.register({
        id: 'test-fff',
        tools: ['fff_grep', 'fff_find_files'],
        execute: vi.fn(),
      });
    });

    const diagnostic = await handlers.get('before_agent_start')!({ systemPrompt: 'BASE' });

    expect(diagnostic).toBeUndefined();
  });

  test('never falls back to raw bash after a mutating provider error', async () => {
    const { tools, pi } = createHarness(['bash', 'apply_patch']);
    pi.events.on('bash-rewrite:collect-providers', (payload: any) => {
      payload.register({
        id: 'test-apply-patch',
        tools: ['apply_patch'],
        fallbackOnExecuteError: false,
        async execute() {
          throw new Error('patch provider rejected input');
        },
      });
    });
    const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Add File: scratch/should-not-exist.txt
+no
*** End Patch
PATCH`;

    await expect(
      tools[0].execute('tool-call', { command }, undefined, undefined, {
        cwd: process.cwd(),
        sessionManager: {
          getSessionId: () => 'mutating-provider-test',
          getSessionFile: () => '/tmp/mutating-provider-test.jsonl',
        },
      }),
    ).rejects.toThrow('patch provider rejected input');
  });

  test('fails closed and reports when the active-tool API is unavailable', async () => {
    const { tools, handlers, pi } = createHarness(['bash', 'read']);
    pi.getActiveTools = undefined;
    const beforeAgentStart = handlers.get('before_agent_start')!;
    const diagnostic = await beforeAgentStart({ systemPrompt: 'BASE' });
    const result = await tools[0].execute(
      'tool-call',
      { command: 'cat package.json | head -3' },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        sessionManager: {
          getSessionId: () => 'unavailable-tools-test',
          getSessionFile: () => '/tmp/unavailable-tools-test.jsonl',
        },
      },
    );

    expect(diagnostic.systemPrompt).toContain('active-tool list is unavailable');
    expect(result.content[0].text).not.toContain('Use offset=4 to continue');
  });

  test('passes through commands with Pi 0.82 live session environment', async () => {
    const { tools } = createHarness(['bash', 'read', 'ls']);

    const result = await tools[0].execute(
      'tool-call',
      {
        command:
          'printf "%s|%s|%s|%s|%s" "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"',
      },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        model: { provider: 'devai', id: 'gpt-5.6-sol' },
        thinkingLevel: 'medium',
        sessionManager: {
          getSessionId: () => 'session-082',
          getSessionFile: () => '/tmp/session-082.jsonl',
        },
      },
    );

    expect(result.content[0].text).toContain(
      'session-082|/tmp/session-082.jsonl|devai|gpt-5.6-sol|medium',
    );
  });
});

describe('bashCommandContainsExpensiveTool', () => {
  test.each([
    ['grep -r foo .', true],
    ['cat foo.ts | grep bar', true],
    ['tree -L 3 src', true],
    ['echo "grepper" | cat', false],
    ['node --inspect findfile.ts', false],
    ['pnpm install', false],
  ])('contains expensive token in %j -> %s', (command, expected) => {
    expect(bashCommandContainsExpensiveTool(command)).toBe(expected);
  });
});
