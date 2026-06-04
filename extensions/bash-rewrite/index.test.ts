import { describe, expect, test, vi } from 'vitest';

import bashRewriteExtension, { bashCommandContainsExpensiveTool } from './index';

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

  test('passes through rewriteable commands when no provider for the target tool is loaded', async () => {
    const { tools } = createHarness(['bash', 'read', 'ls']);

    const result = await tools[0].execute(
      'tool-call',
      { command: 'printf provider-absent' },
      undefined,
      undefined,
      { cwd: process.cwd() },
    );

    expect(result.content[0].text).toContain('provider-absent');
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
