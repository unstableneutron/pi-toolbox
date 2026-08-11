import { describe, expect, test, vi } from 'vitest';

import {
  createRemoteExecutorExtension,
  createRemoteExecutorTools,
  createRemoteMcpProxyTool,
} from './index';
import { DEFERRED_TOOLS_PROTOCOL_VERSION } from '../shared/deferred-tools-protocol';
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
  test('uses formal names and description-only prompt metadata for deferred tools', () => {
    const tools = createRemoteExecutorTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'executor_search_tools',
      'executor_describe_tool',
      'executor_execute',
      'executor_list_guides',
      'executor_get_guide',
      'executor_get_job',
      'executor_cancel_job',
      'executor_read_output',
    ]);
    expect(tools.every((tool) => tool.renderCall && tool.renderResult)).toBe(true);
    expect(tools.every((tool) => tool.promptSnippet === undefined)).toBe(true);
    expect(tools.every((tool) => tool.promptGuidelines === undefined)).toBe(true);
  });

  test('keeps optional search parameters out of OpenAI strict mode', () => {
    const search = createRemoteExecutorTools()[0]!;
    const parameters = search.parameters as {
      required?: string[];
      properties?: { limit?: { maximum?: number }; kinds?: { maxItems?: number } };
    };
    expect(parameters.required).toEqual(['query']);
    expect(parameters.properties?.limit?.maximum).toBe(50);
    expect(parameters.properties?.kinds?.maxItems).toBe(4);
    expect(search.constrainedSampling).toBeUndefined();
  });

  test('returns compact integration matches without describing every result', async () => {
    const executeCode = vi.fn(async (_endpoint: ExecutorEndpoint, _code: string) =>
      completed({
        items: [{ path: 'github.user.main.issues.list', summary: 'List issues.' }],
        total: 1,
      }),
    );
    const search = createRemoteExecutorTools({
      dependencies: { resolveEndpoint: async () => endpoint, executeCode },
    })[0]!;

    const result = await search.execute(
      'search-1',
      { query: 'github issues', kinds: ['integration'] },
      undefined,
      undefined,
      context(),
    );

    const code = executeCode.mock.calls[0]?.[1] ?? '';
    expect(code).toContain('tools.search');
    expect(code).toContain('"limit":20');
    expect(code).not.toContain('tools.describe.tool');
    expect(result.content[0]).toEqual({
      type: 'text',
      text: '{"items":[{"path":"github.user.main.issues.list","kind":"integration","summary":"List issues."}],"total":1}',
    });
    expect(JSON.stringify(result.content)).not.toContain('score');
    expect(JSON.stringify(result.details)).not.toContain('must-not-leak');
  });

  test('activates integration bridge tools when a search loads matches', async () => {
    const activateTools = vi.fn((names: string[]) => names);
    const search = createRemoteExecutorTools({
      activateTools,
      dependencies: {
        resolveEndpoint: async () => endpoint,
        executeCode: async () =>
          completed({
            items: [{ path: 'github.issues.list', summary: 'List GitHub issues.' }],
            total: 1,
          }),
      },
    })[0]!;

    await search.execute(
      'search-load-integration',
      { query: 'GitHub issues', kinds: ['integration'], load: true },
      undefined,
      undefined,
      context(),
    );

    expect(activateTools).toHaveBeenCalledWith(['executor_describe_tool', 'executor_execute']);
  });

  test('continues integration pagination with the same namespace', async () => {
    const executeCode = vi.fn(async (_endpoint: ExecutorEndpoint, code: string) =>
      completed({
        items: [
          {
            path: code.includes('"offset":1') ? 'github.second' : 'github.first',
            summary: 'GitHub tool.',
          },
        ],
        total: 2,
      }),
    );
    const search = createRemoteExecutorTools({
      dependencies: { resolveEndpoint: async () => endpoint, executeCode },
    })[0]!;

    const first = await search.execute(
      'search-page-1',
      { query: 'github', kinds: ['integration'], namespace: 'github', limit: 1 },
      undefined,
      undefined,
      context(),
    );
    const firstPage = JSON.parse((first.content[0] as { text: string }).text) as {
      nextCursor: string;
    };
    await search.execute(
      'search-page-2',
      {
        query: 'github',
        kinds: ['integration'],
        namespace: 'github',
        limit: 1,
        cursor: firstPage.nextCursor,
      },
      undefined,
      undefined,
      context(),
    );

    expect(firstPage.nextCursor).toBe('0.1.0');
    expect(executeCode.mock.calls[1]?.[1]).toContain('"namespace":"github"');
    expect(executeCode.mock.calls[1]?.[1]).toContain('"offset":1');
  });

  test('rejects a non-advancing remote pagination offset', async () => {
    const search = createRemoteExecutorTools({
      dependencies: {
        resolveEndpoint: async () => endpoint,
        executeCode: async () => completed({ items: [], total: 2, nextOffset: 0 }),
      },
    })[0]!;

    await expect(
      search.execute(
        'search-stalled',
        { query: 'github', kinds: ['integration'], limit: 1 },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow('Invalid Executor search response: nextOffset did not advance');
  });

  test('paginates mixed local and remote results without duplicates or gaps', async () => {
    const remotePaths = ['remote.tool.0', 'remote.tool.1', 'remote.tool.2'];
    const executeCode = vi.fn(async (_endpoint: ExecutorEndpoint, code: string) => {
      const offset = Number(code.match(/"offset":(\d+)/)?.[1] ?? 0);
      const limit = Number(code.match(/"limit":(\d+)/)?.[1] ?? 1);
      const items = remotePaths.slice(offset, offset + limit).map((path) => ({
        path,
        summary: 'Remote Executor tool.',
      }));
      const nextOffset = offset + items.length;
      return completed({
        items,
        total: remotePaths.length,
        ...(nextOffset < remotePaths.length ? { nextOffset } : {}),
      });
    });
    const search = createRemoteExecutorTools({
      dependencies: { resolveEndpoint: async () => endpoint, executeCode },
    })[0]!;
    const paths: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 20; page += 1) {
      const result = await search.execute(
        `mixed-${page}`,
        { query: 'executor tool', limit: 2, ...(cursor ? { cursor } : {}) },
        undefined,
        undefined,
        context(),
      );
      const output = JSON.parse((result.content[0] as { text: string }).text) as {
        items: Array<{ path: string }>;
        nextCursor?: string;
      };
      paths.push(...output.items.map((item) => item.path));
      cursor = output.nextCursor;
      if (!cursor) break;
    }

    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual(expect.arrayContaining(remotePaths));
    expect(paths).toContain('executor_search_tools');
    expect(executeCode).toHaveBeenCalledTimes(remotePaths.length);
  });

  test('searches bridge and sandbox primitives without contacting Executor', async () => {
    const executeCode = vi.fn();
    const search = createRemoteExecutorTools({ dependencies: { executeCode } })[0]!;

    const result = await search.execute(
      'search-local',
      { query: 'describe tool shape', kinds: ['bridge', 'sandbox'] },
      undefined,
      undefined,
      context(),
    );
    const output = JSON.parse((result.content[0] as { text: string }).text) as {
      items: Array<{ path: string; kind: string }>;
    };

    expect(output.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'executor_describe_tool', kind: 'bridge' }),
        expect.objectContaining({ path: 'tools.describe.tool', kind: 'sandbox' }),
      ]),
    );
    expect(executeCode).not.toHaveBeenCalled();
  });

  test('loads matched native tools only when requested', async () => {
    let active = false;
    const activate = vi.fn((names: string[]) => {
      active = true;
      return names;
    });
    const search = createRemoteExecutorTools({
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

    const unloaded = await search.execute(
      'search-native-1',
      { query: 'create dashboard', kinds: ['native'] },
      undefined,
      undefined,
      context(),
    );
    expect(activate).not.toHaveBeenCalled();
    expect(unloaded.content[0]).toMatchObject({
      text: expect.stringContaining('"state":"loadable"'),
    });

    const loaded = await search.execute(
      'search-native-2',
      { query: 'create dashboard', kinds: ['native'], load: true },
      undefined,
      undefined,
      context(),
    );
    expect(activate).toHaveBeenCalledWith(['executor_create_artifact']);
    expect(loaded.content[0]).toMatchObject({ text: expect.stringContaining('"state":"loaded"') });
  });

  test('reports a native loading failure', async () => {
    const search = createRemoteExecutorTools({
      nativeTools: {
        list: () => [
          {
            name: 'executor_create_artifact',
            remoteName: 'create-artifact',
            description: 'Create an artifact.',
            active: false,
          },
        ],
        activate: () => [],
      },
    })[0]!;

    await expect(
      search.execute(
        'search-native-failed',
        { query: 'create artifact', kinds: ['native'], load: true },
        undefined,
        undefined,
        context(),
      ),
    ).rejects.toThrow('Failed to load Executor native tools: executor_create_artifact');
  });

  test('describes only the compact success-data contract', async () => {
    const executeCode = vi.fn(async (_endpoint: ExecutorEndpoint, _code: string) =>
      completed({
        path: 'github.user.main.issues.list',
        summary: 'List issues.',
        inputTypeScript: '{ state?: string | null | null }',
        dataTypeScript: '{ issues: Issue[]; cursor?: string | null | null; }',
        outputTypeScript: 'legacy envelope must not win',
        typeScriptDefinitions: {
          Issue: '{ id: string; }',
          ToolError: '{ code: string; message: string; }',
          ToolHttpMeta: '{ status: number; }',
        },
      }),
    );
    const describeTool = createRemoteExecutorTools({
      dependencies: { resolveEndpoint: async () => endpoint, executeCode },
    })[1]!;

    const result = await describeTool.execute(
      'describe-1',
      { path: 'github.user.main.issues.list' },
      undefined,
      undefined,
      context(),
    );

    expect(executeCode.mock.calls[0]?.[1]).toContain('tools.describe.tool');
    expect(executeCode.mock.calls[0]?.[1]).toContain('github.user.main.issues.list');
    expect(result.content[0]).toEqual({
      type: 'text',
      text: '{"path":"github.user.main.issues.list","kind":"integration","summary":"List issues.","input":"{ state?: string | null }","data":"{ issues: Issue[]; cursor?: string | null; }","definitions":{"Issue":"{ id: string; }"}}',
    });
  });

  test('preserves describe suggestions for an unknown integration path', async () => {
    const executeCode = vi.fn(async () =>
      completed({
        path: 'github.missing',
        error: {
          code: 'tool_not_found',
          message: 'Tool not found: github.missing',
          suggestions: ['github.user.main.issues.list'],
        },
      }),
    );
    const describeTool = createRemoteExecutorTools({
      dependencies: { resolveEndpoint: async () => endpoint, executeCode },
    })[1]!;

    const result = await describeTool.execute(
      'describe-missing',
      { path: 'github.missing' },
      undefined,
      undefined,
      context(),
    );

    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('github.user.main.issues.list'),
    });
  });

  test('keeps referenced shared definitions and handles legacy data ordering', async () => {
    const executeCode = vi.fn(async () =>
      completed({
        path: 'files.download',
        inputTypeScript: '{}',
        outputTypeScript:
          '{ ok: false; error: { data: string } } | { data: { issues: Issue[] }; ok: true }',
        typeScriptDefinitions: {
          Issue: '{ id: string; attachment: ToolFile | null | null; }',
          ToolFile: '{ name: string; data: string; }',
          ToolError: '{ code: string; }',
        },
      }),
    );
    const describeTool = createRemoteExecutorTools({
      dependencies: { resolveEndpoint: async () => endpoint, executeCode },
    })[1]!;

    const result = await describeTool.execute(
      'describe-legacy',
      { path: 'files.download' },
      undefined,
      undefined,
      context(),
    );

    expect(result.content[0]).toMatchObject({
      text: '{"path":"files.download","kind":"integration","input":"{}","data":"{ issues: Issue[] }","definitions":{"Issue":"{ id: string; attachment: ToolFile | null; }","ToolFile":"{ name: string; data: string; }"}}',
    });
  });

  test('extracts legacy success data without a trailing member semicolon', async () => {
    const executeCode = vi.fn(async () =>
      completed({
        path: 'records.get',
        outputTypeScript: '{ ok: true; data: { value: string } } | { ok: false; error: ToolError }',
      }),
    );
    const describeTool = createRemoteExecutorTools({
      dependencies: { resolveEndpoint: async () => endpoint, executeCode },
    })[1]!;

    const result = await describeTool.execute(
      'describe-no-semicolon',
      { path: 'records.get' },
      undefined,
      undefined,
      context(),
    );

    expect(result.content[0]).toMatchObject({
      text: '{"path":"records.get","kind":"integration","data":"{ value: string }"}',
    });
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
      { code: 'return { answer: 42 }', timeoutMs: 4000 },
      controller.signal,
      undefined,
      context(),
    );

    expect(executeCode).toHaveBeenCalledWith(
      endpoint,
      'return { answer: 42 }',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeoutMs: 4000,
        onProgress: expect.any(Function),
      }),
    );
    expect(result.content[0]).toMatchObject({ text: '{"answer":42}' });

    await execute.execute(
      'execute-clamped',
      { code: 'return { answer: 42 }', timeoutMs: 10_000 },
      controller.signal,
      undefined,
      context(),
    );
    expect(executeCode).toHaveBeenLastCalledWith(
      endpoint,
      'return { answer: 42 }',
      expect.objectContaining({ timeoutMs: endpoint.requestTimeoutMs }),
    );
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
    const activateTools = vi.fn((names: string[]) => names);
    const tools = createRemoteExecutorTools({
      activateTools,
      dependencies: { resolveEndpoint: async () => slowEndpoint, executeCode },
    });

    const started = await tools[2]!.execute(
      'slow-1',
      { code: 'return { slow: "done" }', waitMs: 5 },
      undefined,
      undefined,
      context(),
    );
    const running = JSON.parse((started.content[0] as { text: string }).text) as {
      state: string;
      jobId: string;
    };
    expect(running.state).toBe('running');
    expect(activateTools).toHaveBeenCalledWith(['executor_get_job', 'executor_cancel_job']);

    const completedResult = await tools[5]!.execute(
      'poll-1',
      { jobId: running.jobId, waitMs: 100 },
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
    const activateTools = vi.fn((names: string[]) => names);
    const tools = createRemoteExecutorTools({
      outputs,
      activateTools,
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
    expect(activateTools).toHaveBeenCalledWith(['executor_read_output']);
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

  test('activates job and output readers for native proxy results', async () => {
    const activateTools = vi.fn((names: string[]) => names);
    const slowEndpoint = { ...endpoint, yieldAfterMs: 5 };
    const slowProxy = createRemoteMcpProxyTool(
      {
        name: 'slow-native',
        description: 'Slow native capability.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        activateTools,
        dependencies: {
          resolveEndpoint: async () => slowEndpoint,
          callTool: async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return completed({ done: true });
          },
        },
      },
    );

    await slowProxy.execute('native-slow', {}, undefined, undefined, context());
    expect(activateTools).toHaveBeenCalledWith(['executor_get_job', 'executor_cancel_job']);

    activateTools.mockClear();
    const boundedEndpoint = { ...endpoint, maxOutputBytes: 1024, maxOutputLines: 10 };
    const largeProxy = createRemoteMcpProxyTool(
      {
        name: 'large-native',
        description: 'Large native capability.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        activateTools,
        dependencies: {
          resolveEndpoint: async () => boundedEndpoint,
          callTool: async () => completed('x'.repeat(3000)),
        },
      },
    );

    const largeResult = await largeProxy.execute(
      'native-large',
      {},
      undefined,
      undefined,
      context(),
    );
    expect((largeResult.details as { outputId?: string }).outputId).toBeTruthy();
    expect(activateTools).toHaveBeenCalledWith(['executor_read_output']);
  });

  test('splits remote skills into list and get guide tools', async () => {
    const callTool = vi.fn(async (_endpoint, _name, args: Record<string, unknown>) => ({
      text:
        args.name === 'execute'
          ? '# execute\n\nGuide text.\n\n## Workflow\n\nSandbox steps.'
          : args.name === 'artifact-style'
            ? '# artifact-style\n\nStyle rules.'
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
      { id: 'execute' },
      undefined,
      undefined,
      context(),
    );

    expect(listResult.content[0]).toEqual({
      type: 'text',
      text: '{"items":[{"id":"execute","summary":"Execute workflow."},{"id":"artifact-style","summary":"Artifact style rules."}]}',
    });
    expect(guideResult.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('## Pi bridge workflow'),
    });
    expect(callTool).toHaveBeenCalledWith(
      endpoint,
      'skills',
      { name: 'execute' },
      expect.any(Object),
    );

    const artifactGuide = await getGuide.execute(
      'guide-2',
      { id: 'artifact-style' },
      undefined,
      undefined,
      context(),
    );
    expect(artifactGuide.content[0]).toEqual({
      type: 'text',
      text: '# artifact-style\n\nStyle rules.',
    });
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
    expect(tool.renderCall).toBeTypeOf('function');
    expect(tool.renderResult).toBeTypeOf('function');
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
      events: { on: vi.fn() },
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
      'executor_search_tools',
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

  test('provides integration discovery to the general deferred-tool search', async () => {
    let providerHandler: ((value: unknown) => void) | undefined;
    const registered = new Map<string, { name: string }>();
    let active: string[] = [];
    const pi = {
      registerTool(tool: { name: string }) {
        registered.set(tool.name, tool);
        active = [...new Set([...active, tool.name])];
      },
      registerCommand: vi.fn(),
      on: vi.fn(),
      getAllTools: () => [...registered.values()],
      getActiveTools: () => active,
      setActiveTools(names: string[]) {
        active = names;
      },
      events: {
        on(channel: string, handler: (value: unknown) => void) {
          if (channel === 'pi-deferred-tools:search-provider') providerHandler = handler;
          return () => {};
        },
      },
    };
    createRemoteExecutorExtension({
      dependencies: {
        resolveEndpoint: async () => endpoint,
        executeCode: async () =>
          completed({
            items: [{ path: 'github.issues.list', summary: 'List GitHub issues.' }],
            total: 1,
          }),
      },
    })(pi as never);
    active = [];
    const pending: Array<Promise<unknown>> = [];

    providerHandler?.({
      version: DEFERRED_TOOLS_PROTOCOL_VERSION,
      query: 'GitHub issues',
      limit: 5,
      context: context(),
      pending,
    });
    const results = await Promise.all(pending);

    expect(results).toEqual([
      {
        provider: 'executor',
        items: [
          {
            path: 'github.issues.list',
            kind: 'integration',
            summary: 'List GitHub issues.',
          },
        ],
      },
    ]);
    expect(active).toEqual(expect.arrayContaining(['executor_describe_tool', 'executor_execute']));
    expect(registered.has('github.issues.list')).toBe(false);
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
