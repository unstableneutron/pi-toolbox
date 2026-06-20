import { afterEach, describe, expect, test, vi } from 'vitest';

describe('pi-fff-search startup laziness', () => {
  afterEach(() => {
    vi.doUnmock('fff-router');
    vi.resetModules();
  });

  test('imports and registers tools without loading fff-router runtime modules', async () => {
    vi.resetModules();
    vi.doMock('fff-router', () => {
      throw new Error('fff-router should be loaded lazily');
    });

    const mod = await import('./index');
    const tools: Array<{ name: string }> = [];
    const handlers = new Map<string, unknown>();
    const eventHandlers = new Map<string, unknown>();
    const pi = {
      registerTool(tool: { name: string }) {
        tools.push(tool);
      },
      on(event: string, handler: unknown) {
        handlers.set(event, handler);
      },
      events: {
        on(event: string, handler: unknown) {
          eventHandlers.set(event, handler);
          return () => eventHandlers.delete(event);
        },
      },
    } as any;

    mod.createPiFffSearchExtension({
      overrideBuiltinRead: false,
      overrideBuiltinGrep: false,
      overrideBuiltinFind: false,
    })(pi);

    expect(tools.map((tool) => tool.name)).toEqual(['fff_find_files', 'fff_grep']);
    expect(handlers.has('before_agent_start')).toBe(true);
  });

  test('defers builtin override template construction until Pi invokes the extension', async () => {
    vi.resetModules();
    const mod = await import('./index');
    const makeTool = (name: string) => () => ({
      name,
      label: name,
      description: `${name} description`,
      parameters: {},
      execute: vi.fn(),
    });
    const createBuiltInReadTool = vi.fn(makeTool('read'));
    const createBuiltInGrepTool = vi.fn(makeTool('grep'));
    const createBuiltInFindTool = vi.fn(makeTool('find'));
    const createBuiltInLsTool = vi.fn(makeTool('ls'));

    const extension = mod.createPiFffSearchExtension({
      createBuiltInReadTool: createBuiltInReadTool as any,
      createBuiltInGrepTool: createBuiltInGrepTool as any,
      createBuiltInFindTool: createBuiltInFindTool as any,
      createBuiltInLsTool: createBuiltInLsTool as any,
    });

    expect(createBuiltInReadTool).not.toHaveBeenCalled();
    expect(createBuiltInGrepTool).not.toHaveBeenCalled();
    expect(createBuiltInFindTool).not.toHaveBeenCalled();
    expect(createBuiltInLsTool).not.toHaveBeenCalled();

    extension({
      registerTool: vi.fn(),
      on: vi.fn(),
      events: { on: vi.fn(() => vi.fn()) },
    } as any);

    expect(createBuiltInReadTool).toHaveBeenCalledTimes(1);
    expect(createBuiltInGrepTool).toHaveBeenCalledTimes(1);
    expect(createBuiltInFindTool).toHaveBeenCalledTimes(1);
    expect(createBuiltInLsTool).toHaveBeenCalledTimes(1);
  });
});
