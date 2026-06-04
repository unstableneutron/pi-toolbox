import { describe, expect, test, vi } from 'vitest';

import bashRewriteExtension from './index';

function createHarness(
  activeTools = ['bash', 'read', 'ls', 'fff_grep', 'fff_find_files', 'apply_patch'],
) {
  const tools: any[] = [];
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  const pi = {
    registerTool(tool: any) {
      tools.push(tool);
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
  return { tools, pi };
}

describe('bash-rewrite safe prefixes', () => {
  test('dispatches cd-prefixed grep with the cd target as provider cwd', async () => {
    const { tools, pi } = createHarness();
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'base_path: /repo/sub/src\n\nmain.rs:1: foo' }],
      details: {},
    }));

    pi.events.on('bash-rewrite:collect-providers', (payload: any) => {
      payload.register({ id: 'test-fff', priority: 100, tools: ['fff_grep'], execute });
    });

    await tools[0].execute(
      'tool-call',
      { command: 'cd /repo/sub && grep -rn "foo" src | head -3' },
      undefined,
      undefined,
      { cwd: '/repo' },
    );

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'fff_grep' }),
      expect.objectContaining({
        originalCommand: 'cd /repo/sub && grep -rn "foo" src | head -3',
        ctx: expect.objectContaining({ cwd: '/repo/sub' }),
      }),
    );
  });

  test('dispatches cd-prefixed apply_patch heredoc with the cd target as provider cwd', async () => {
    const { tools, pi } = createHarness();
    const execute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'Applied patch with 1 operation(s).' }],
      details: {},
    }));

    pi.events.on('bash-rewrite:collect-providers', (payload: any) => {
      payload.register({
        id: 'test-apply-patch',
        priority: 200,
        tools: ['apply_patch'],
        fallbackOnExecuteError: false,
        execute,
      });
    });

    const command = `cd /repo/sub && apply_patch <<'PATCH'
*** Begin Patch
*** Add File: scratch/example.txt
+hello
*** End Patch
PATCH`;

    await tools[0].execute('tool-call', { command }, undefined, undefined, { cwd: '/repo' });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'apply_patch',
        params: {
          patch: '*** Begin Patch\n*** Add File: scratch/example.txt\n+hello\n*** End Patch\n',
        },
        recognizer: 'apply-patch-heredoc',
      }),
      expect.objectContaining({
        originalCommand: command,
        ctx: expect.objectContaining({ cwd: '/repo/sub' }),
      }),
    );
  });
});
