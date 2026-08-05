import { describe, expect, test, vi } from 'vitest';

import {
  createRemoteExecutorExtension,
  createRemoteExecutorTools,
  createRemoteMcpProxyTool,
} from './index';
import { ExecutorOutputStore } from './src/output-store';
import type { ExecutorEndpoint, ExecutorMcpInspection, JsonValue } from './src/types';

const endpoint: ExecutorEndpoint = {
  mcpUrl: 'https://executor.example.com/mcp',
  auth: { kind: 'bearer', token: 'must-not-leak' },
  requestTimeoutMs: 5000,
  yieldAfterMs: 1000,
  maxOutputBytes: 12_288,
  maxOutputLines: 300,
  source: 'environment',
};

function context(hasUI = false, setStatus = vi.fn()) {
  return {
    cwd: '/repo',
    hasUI,
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      editor: vi.fn(),
      setStatus,
    },
    isProjectTrusted: vi.fn(() => true),
  } as never;
}

function completed(result: JsonValue) {
  return {
    text: JSON.stringify(result),
    structuredContent: { status: 'completed', result },
    isError: false,
  } as const;
}

describe('native Executor Pi tools', () => {
  test('uses formal names for the core tools', () => {
    const tools = createRemoteExecutorTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'executor_find_tools',
      'executor_describe_tool',
      'executor_execute',
      'executor_list_guides',
      'executor_get_guide',
      'executor_get_job',
      'executor_cancel_job',
      'executor_read_output',
    ]);
  });

  test('keeps optional finder parameters out of OpenAI strict mode', () => {
    const finder = createRemoteExecutorTools()[0]!;
    const parameters = finder.parameters as {
      required?: string[];
      properties?: { limit?: { maximum?: number } };
    };
    expect(parameters.required).toEqual(['query']);
    expect(parameters.properties?.limit?.maximum).toBe(50);
    expect(finder.constrainedSampling).toBeUndefined();
  });

  test('finds concise integration matches without describing every result', async () => {
    const executeCode = vi.fn(async (_endpoint: ExecutorEndpoint, _code: string) =>
      completed({
        matches: [
          {
            kind: 'integration',
            path: 'github.user.main.issues.list',
            description: 'List issues.',
          },
        ],
        total: 1,
        hasMore: false,
      }),
    );
    const finder = createRemoteExecutorTools({
      dependencies: { resolveEndpoint: async () => endpoint, executeCode },
    })[0]!;

    const result = await finder.execute(
      'find-1',
      { query: 'github issues' },
      undefined,
      undefined,
      context(),
    );

    const code = executeCode.mock.calls[0]?.[1] ?? '';
    expect(code).toContain('tools.search');
    expect(code).toContain('"limit":20');
    expect(code).not.toContain('tools.describe.tool');
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(result.content)).not.toContain('score');
    expect(JSON.stringify(result.details)).not.toContain('must-not-leak');
  });

  test('activates matching deferred native tools', async () => {
    let active = false;
    const activate = vi.fn((names: string[]) => {
      active = true;
      return names;
    });
    const finder = createRemoteExecutorTools({
      nativeTools: {
        list: () => [
          {
            name: 'executor_create_artifact',
            remoteName: 'create-artifact',
            description: 'Create an interactive dashboard artifact.',
            active,
          },
        ],
        activate,
      },
    })[0]!;

    const result = await finder.execute(
      'find-native',
      { query: 'create dashboard', scope: 'native' },
      undefined,
      undefined,
      context(),
    );

    expect(activate).toHaveBeenCalledWith(['executor_create_artifact']);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('executor_create_artifact'),
    });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('"active":true') });
  });

  test('describes one exact integration path', async () => {
    const executeCode = vi.fn(async (_endpoint: ExecutorEndpoint, _code: string) =>
      completed({
        path: 'github.user.main.issues.list',
        description: 'List issues.',
        input: '{ state?: string }',
        output: '{ issues: Issue[] }',
      }),
    );
    const describeTool = createRemoteExecutorTools({
      dependencies: { resolveEndpoint: async () => endpoint, executeCode },
    })[1]!;

    await describeTool.execute(
      'describe-1',
      { path: 'github.user.main.issues.list' },
      undefined,
      undefined,
      context(),
    );

    expect(executeCode.mock.calls[0]?.[1]).toContain('tools.describe.tool');
    expect(executeCode.mock.calls[0]?.[1]).toContain('github.user.main.issues.list');
  });

  test('routes executor_execute through the remote execute tool', async () => {
    const executeCode = vi.fn(async (_endpoint: ExecutorEndpoint, _code: string) =>
      completed({ answer: 42 }),
    );
    const execute = createRemoteExecutorTools({
      dependencies: { resolveEndpoint: async () => endpoint, executeCode },
    })[2]!;
    const controller = new AbortController();
    const result = await execute.execute(
      'execute-1',
      { code: 'return { answer: 42 }' },
      controller.signal,
      undefined,
      context(),
    );

    expect(executeCode).toHaveBeenCalledWith(
      endpoint,
      'return { answer: 42 }',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeoutMs: 5000,
        onProgress: expect.any(Function),
      }),
    );
    expect(result.content[0]).toMatchObject({ text: '{"answer":42}' });
  });

  test('redacts common credential fields from model-visible JSON', async () => {
    const executeCode = vi.fn(async () =>
      completed({ user: 'alice', password: 'private', nested: { access_token: 'token' } }),
    );
    const execute = createRemoteExecutorTools({
      dependencies: { resolveEndpoint: async () => endpoint, executeCode },
    })[2]!;

    const result = await execute.execute(
      'redact-1',
      { code: 'return credentials' },
      undefined,
      undefined,
      context(),
    );
    expect(result.content[0]).toMatchObject({
      text: '{"user":"alice","password":"[REDACTED]","nested":{"access_token":"[REDACTED]"}}',
    });
    expect(JSON.stringify(result.details)).not.toContain('private');
  });

  test('yields slow execution and returns the result through executor_get_job', async () => {
    const slowEndpoint = { ...endpoint, yieldAfterMs: 1_000 };
    const executeCode = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return completed({ slow: 'done' });
    });
    const tools = createRemoteExecutorTools({
      dependencies: { resolveEndpoint: async () => slowEndpoint, executeCode },
    });

    const started = await tools[2]!.execute(
      'slow-1',
      { code: 'return { slow: "done" }', yieldMs: 5 },
      undefined,
      undefined,
      context(),
    );
    const running = JSON.parse((started.content[0] as { text: string }).text) as {
      status: string;
      jobId: string;
    };
    expect(running.status).toBe('running');

    const completedResult = await tools[5]!.execute(
      'poll-1',
      { jobId: running.jobId, yieldMs: 100 },
      undefined,
      undefined,
      context(),
    );
    expect(completedResult.content[0]).toMatchObject({ text: '{"slow":"done"}' });
  });

  test('spills large output and reads it through executor_read_output', async () => {
    const boundedEndpoint = {
      ...endpoint,
      maxOutputBytes: 1024,
      maxOutputLines: 10,
    };
    const source = 'x'.repeat(3000);
    const outputs = new ExecutorOutputStore();
    const tools = createRemoteExecutorTools({
      outputs,
      dependencies: {
        resolveEndpoint: async () => boundedEndpoint,
        executeCode: async () => completed(source),
      },
    });

    const result = await tools[2]!.execute(
      'large-1',
      { code: 'return largeResult' },
      undefined,
      undefined,
      context(),
    );
    const outputId = (result.details as { outputId?: string }).outputId;
    expect(outputId).toBeTruthy();
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('nextOffset=') });

    const page = await tools[7]!.execute(
      'page-1',
      { outputId: outputId!, offset: 1000, limit: 500 },
      undefined,
      undefined,
      context(),
    );
    expect((page.content[0] as { text: string }).text.startsWith('x'.repeat(500))).toBe(true);
    await outputs.clear();
  });

  test('splits remote skills into list and get guide tools', async () => {
    const callTool = vi.fn(async (_endpoint, _name, args: Record<string, unknown>) => ({
      text:
        'name' in args
          ? '# execute\n\nGuide text.'
          : '- `execute` — Execute workflow.\n- `artifact-style` — Artifact style rules.',
      structuredContent: null,
      isError: false,
    }));
    const tools = createRemoteExecutorTools({
      dependencies: { resolveEndpoint: async () => endpoint, callTool },
    });
    const listGuides = tools[3]!;
    const getGuide = tools[4]!;

    const listResult = await listGuides.execute('guides-1', {}, undefined, undefined, context());
    const guideResult = await getGuide.execute(
      'guide-1',
      { guide: 'execute' },
      undefined,
      undefined,
      context(),
    );

    expect(listResult.content[0]).toMatchObject({
      text: expect.stringContaining('artifact-style'),
    });
    expect(guideResult.content[0]).toEqual({ type: 'text', text: '# execute\n\nGuide text.' });
    expect(callTool).toHaveBeenLastCalledWith(
      endpoint,
      'skills',
      { name: 'execute' },
      expect.any(Object),
    );
  });

  test('adapts artifact names, schemas, outputs, and execution modes', async () => {
    const callTool = vi.fn(async () => ({
      text: 'Saved "Test" as artifact artifact-1.',
      structuredContent: {
        status: 'fallback_url',
        artifactId: 'artifact-1',
        url: 'https://executor.example.com/artifacts/artifact-1',
        code: 'must not enter model-visible output',
      },
      isError: false,
    }));
    const tool = createRemoteMcpProxyTool(
      {
        name: 'create-artifact',
        description: 'Very long remote instructions that the Pi adapter replaces.',
        inputSchema: { type: 'object', properties: {} },
      },
      { dependencies: { resolveEndpoint: async () => endpoint, callTool } },
    );

    expect(tool.name).toBe('executor_create_artifact');
    expect(tool.executionMode).toBe('sequential');
    expect(tool.description).toContain('executor_edit_artifact');
    expect(tool.parameters).toMatchObject({
      required: ['code'],
      properties: { code: { type: 'string' } },
    });

    const result = await tool.execute(
      'artifact-1',
      { code: 'export function App() {}', title: 'Test' },
      undefined,
      undefined,
      context(),
    );
    expect(callTool).toHaveBeenCalledWith(
      endpoint,
      'create-artifact',
      { code: 'export function App() {}', title: 'Test' },
      expect.any(Object),
    );
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('"operation":"created"'),
    });
    expect(JSON.stringify(result.content)).not.toContain('must not enter model-visible output');
    expect(JSON.stringify(result.details)).toContain('must not enter model-visible output');
  });

  test('rewrites remote artifact references to formal Pi names', async () => {
    const tool = createRemoteMcpProxyTool(
      { name: 'list-artifacts', inputSchema: { type: 'object', properties: {} } },
      {
        dependencies: {
          resolveEndpoint: async () => endpoint,
          callTool: async () => ({
            text: 'No saved artifacts. Use create-artifact to make one.',
            structuredContent: null,
            isError: false,
          }),
        },
      },
    );

    const result = await tool.execute('list-1', {}, undefined, undefined, context());
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'No saved artifacts. Use executor_create_artifact to make one.',
    });
  });

  test('registers artifact tools as deferred during session start', async () => {
    let sessionStart:
      | ((event: unknown, ctx: ReturnType<typeof context>) => Promise<void>)
      | undefined;
    const registered = new Map<string, { name: string }>();
    let active: string[] = [];
    const pi = {
      registerTool: vi.fn((tool: { name: string }) => {
        registered.set(tool.name, tool);
        active = [...new Set([...active, tool.name])];
      }),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: typeof sessionStart) => {
        if (event === 'session_start') sessionStart = handler;
      }),
      getAllTools: vi.fn(() => [...registered.values()]),
      getActiveTools: vi.fn(() => active),
      setActiveTools: vi.fn((names: string[]) => {
        active = names;
      }),
    };
    const extension = createRemoteExecutorExtension({
      dependencies: {
        resolveEndpoint: async () => endpoint,
        inspect: async (): Promise<ExecutorMcpInspection> => ({
          tools: [
            { name: 'execute', inputSchema: { type: 'object' } },
            { name: 'skills', inputSchema: { type: 'object' } },
            { name: 'list-artifacts', inputSchema: { type: 'object' } },
          ],
          resources: [],
        }),
      },
    });

    extension(pi as never);
    expect([...registered.keys()]).toEqual([
      'executor_find_tools',
      'executor_describe_tool',
      'executor_execute',
      'executor_list_guides',
      'executor_get_guide',
      'executor_get_job',
      'executor_cancel_job',
      'executor_read_output',
    ]);
    const setStatus = vi.fn();
    await sessionStart!({}, context(true, setStatus));
    expect([...registered.keys()]).toContain('executor_list_artifacts');
    expect(active).not.toContain('executor_list_artifacts');
    expect(setStatus).toHaveBeenCalledWith(
      'executor',
      'executor[environment]: https://executor.example.com/mcp',
    );
  });

  test('throws remote failures so Pi marks the result as an error', async () => {
    const execute = createRemoteExecutorTools({
      dependencies: {
        resolveEndpoint: async () => {
          throw new Error('daemon unavailable');
        },
      },
    })[2]!;

    await expect(
      execute.execute('execute-error', { code: 'return 1' }, undefined, undefined, context()),
    ).rejects.toThrow('daemon unavailable');
  });
});
