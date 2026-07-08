import fs from 'node:fs';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { ComputerUseSession } from './session';

const transientProcessError = {
  content: [
    {
      type: 'text',
      text: 'Error Domain=NSOSStatusErrorDomain Code=-600 "procNotFound: no eligible process with specified descriptor"',
    },
  ],
  isError: true,
};

const successfulListApps = {
  content: [{ type: 'text', text: 'Finder — /System/Library/CoreServices/Finder.app/' }],
};

function makeSessionWithClient(responses: unknown[]) {
  const session = new ComputerUseSession();
  const calls: unknown[] = [];
  const client = {
    close: vi.fn(),
    setElicitationHandler() {
      return () => {};
    },
    async callMcpTool(input: unknown) {
      calls.push(input);
      return responses.shift();
    },
  };

  (session as any).client = client;
  (session as any).threadId = 'thread-1';

  return { session, calls };
}

describe('ComputerUseSession.callTool', () => {
  test('retries transient Computer Use process errors for observation tools', async () => {
    const { session, calls } = makeSessionWithClient([transientProcessError, successfulListApps]);

    const result = await session.callTool({ cwd: '/tmp', hasUI: false } as any, 'list_apps', {});

    expect(result.rawResult).toBe(successfulListApps);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ server: 'computer-use', tool: 'list_apps' });
  });

  test('throws after Codex returns a final MCP error result', async () => {
    const { session } = makeSessionWithClient([transientProcessError, transientProcessError]);

    await expect(
      session.callTool({ cwd: '/tmp', hasUI: false } as any, 'list_apps', {}),
    ).rejects.toThrow('procNotFound: no eligible process with specified descriptor');
  });
});

describe('ComputerUseSession.callMcpTool', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('routes arbitrary Codex MCP server/tool calls through the shared thread', async () => {
    const rawNodeResult = { content: [{ type: 'text', text: 'hello from node' }] };
    const { session, calls } = makeSessionWithClient([rawNodeResult]);

    const result = await session.callMcpTool({ cwd: '/tmp', hasUI: false } as any, {
      server: 'node_repl',
      tool: 'js',
      arguments: { code: 'console.log("hello from node")' },
      timeoutMs: 5000,
    });

    expect(result.rawResult).toBe(rawNodeResult);
    expect(calls).toEqual([
      {
        server: 'node_repl',
        threadId: 'thread-1',
        tool: 'js',
        arguments: { code: 'console.log("hello from node")' },
        timeoutMs: 5000,
        _meta: {
          'x-codex-turn-metadata': {
            session_id: 'thread-1',
            thread_id: 'thread-1',
            thread_source: 'pi-codex-app-server-use',
            turn_id: 'pi-codex-app-server-use-turn-1',
          },
        },
      },
    ]);
  });

  test('does not attach Codex turn metadata to Computer Use calls', async () => {
    const { session, calls } = makeSessionWithClient([successfulListApps]);

    await session.callTool({ cwd: '/tmp', hasUI: false } as any, 'list_apps', {});

    expect(calls[0]).not.toHaveProperty('_meta');
  });

  test('passes AbortSignal to the shared app-server client for every MCP call', async () => {
    const rawNodeResult = { content: [{ type: 'text', text: 'hello from node' }] };
    const controller = new AbortController();
    const { session, calls } = makeSessionWithClient([rawNodeResult]);

    await session.callMcpTool(
      { cwd: '/tmp', hasUI: false } as any,
      {
        server: 'node_repl',
        tool: 'js',
        arguments: { code: '1 + 1' },
      },
      controller.signal,
    );

    expect(calls[0]).toHaveProperty('signal', controller.signal);
  });

  test('resets the bridge and retries once when Codex reports an unknown MCP server', async () => {
    const session = new ComputerUseSession();
    const firstClient = {
      close: vi.fn(),
      setElicitationHandler() {
        return () => {};
      },
      callMcpTool: vi.fn(async () => {
        throw new Error("unknown MCP server 'computer-use'");
      }),
    };
    const secondClient = {
      close: vi.fn(),
      setElicitationHandler() {
        return () => {};
      },
      callMcpTool: vi.fn(async () => successfulListApps),
    };
    const clients = [firstClient, secondClient];
    (session as any).getClient = vi.fn(async () => {
      const client = clients.shift() ?? secondClient;
      (session as any).client = client;
      return client;
    });
    (session as any).getThreadId = vi.fn(async (_ctx: unknown, client: unknown) =>
      client === firstClient ? 'thread-1' : 'thread-2',
    );

    const result = await session.callTool({ cwd: '/tmp', hasUI: false } as any, 'list_apps', {});

    expect(result.rawResult).toBe(successfulListApps);
    expect(firstClient.callMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({ server: 'computer-use', threadId: 'thread-1', tool: 'list_apps' }),
    );
    expect(firstClient.close).toHaveBeenCalledTimes(1);
    expect(secondClient.callMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({ server: 'computer-use', threadId: 'thread-2', tool: 'list_apps' }),
    );
  });

  test('resets the shared app-server bridge when a direct MCP tool call aborts', async () => {
    const session = new ComputerUseSession();
    const close = vi.fn();
    (session as any).client = {
      close,
      setElicitationHandler() {
        return () => {};
      },
      async callMcpTool() {
        throw new Error('Operation aborted');
      },
    };
    (session as any).threadId = 'thread-1';

    await expect(
      session.callMcpTool(
        { cwd: '/tmp', hasUI: false } as any,
        { server: 'node_repl', tool: 'js', timeoutMs: 5000 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Operation aborted');

    expect(close).toHaveBeenCalledTimes(1);
    expect((session as any).client).toBeUndefined();
    expect((session as any).threadId).toBeUndefined();
  });

  test('resets the shared app-server bridge when a direct MCP tool call times out', async () => {
    const session = new ComputerUseSession();
    const close = vi.fn();
    (session as any).client = {
      close,
      setElicitationHandler() {
        return () => {};
      },
      async callMcpTool() {
        throw new Error('mcpServer/tool/call timed out after 30000ms');
      },
    };
    (session as any).threadId = 'thread-1';

    await expect(
      session.callMcpTool({ cwd: '/tmp', hasUI: false } as any, {
        server: 'node_repl',
        tool: 'js',
        timeoutMs: 5000,
      }),
    ).rejects.toThrow('timed out');

    expect(close).toHaveBeenCalledTimes(1);
    expect((session as any).client).toBeUndefined();
    expect((session as any).threadId).toBeUndefined();
  });

  test('routes Chrome browser calls through the Chrome extension-host app-server bridge', async () => {
    const rawNodeResult = { content: [{ type: 'text', text: 'hello from chrome app-server' }] };
    const session = new ComputerUseSession();
    const chromeCalls: unknown[] = [];
    const chromeClient = {
      close: vi.fn(),
      setElicitationHandler() {
        return () => {};
      },
      async startThread() {
        return 'chrome-thread-1';
      },
      async callMcpTool(input: unknown) {
        chromeCalls.push(input);
        return rawNodeResult;
      },
    };
    (session as any).getChromeBridge = vi.fn(async () => ({
      browserClientPath: '/tmp/browser-client.mjs',
      client: chromeClient,
      key: 'test',
      localAppServerUrl: 'ws://127.0.0.1:12345?token=test',
    }));

    const result = await session.callBrowserMcpTool(
      { cwd: '/tmp', hasUI: false } as any,
      'chrome',
      { server: 'node_repl', tool: 'js', arguments: { code: 'await agent.browsers.list()' } },
    );

    expect(result.rawResult).toBe(rawNodeResult);
    expect(chromeCalls).toEqual([
      expect.objectContaining({
        arguments: { code: 'await agent.browsers.list()' },
        server: 'node_repl',
        threadId: 'chrome-thread-1',
        tool: 'js',
      }),
    ]);
    expect((session as any).getChromeBridge).toHaveBeenCalledWith(
      { cwd: '/tmp', hasUI: false },
      {},
      undefined,
    );
  });
});

describe('ComputerUseSession.getDiagnosticStatus', () => {
  test('reports bridge process, thread, paths, and summarized MCP server status', async () => {
    const { session } = makeSessionWithClient([]);
    const client = (session as any).client;
    client.getProcessInfo = () => ({ pid: 12345, killed: false, lastStderr: [] });
    client.listMcpServers = async () => ({
      data: [
        {
          name: 'computer-use',
          authStatus: 'unsupported',
          tools: {
            list_apps: {
              name: 'list_apps',
              description: 'List apps visible to Codex Computer Use.',
            },
            get_app_state: {
              name: 'get_app_state',
              description: 'Get screenshot and accessibility tree for an app.',
            },
          },
        },
        {
          name: 'node_repl',
          authStatus: 'unsupported',
          tools: {
            js: {
              name: 'js',
              description:
                'Run JavaScript in a persistent Node-backed kernel with top-level await and many details that should be truncated in the diagnostic output.',
            },
          },
        },
        {
          name: 'codex_apps',
          authStatus: 'unsupported',
          tools: {
            github_search_repositories: {
              name: 'github_search_repositories',
              description: 'Search for a repository by name or description.',
            },
          },
        },
      ],
    });

    const status = await session.getDiagnosticStatus({ cwd: '/tmp/example', hasUI: true } as any);

    expect(status).toContain('pi-codex-app-server-use diagnostics');
    expect(status).toContain('Expected bridge servers:');
    expect(status).toContain('✓ computer-use auth: unsupported tools: 2');
    expect(status).toContain('- list_apps — List apps visible to Codex Computer Use.');
    expect(status).toContain('✓ node_repl auth: unsupported tools: 1');
    expect(status).toContain('Other app-server MCP servers:');
    expect(status).toContain('- codex_apps auth: unsupported tools: 1');
    expect(status).not.toContain('"inputSchema"');
    expect(status).not.toContain('"data"');
  });

  test('reports connected Chrome/Brave bridge diagnostics in status and verbose JSON', async () => {
    const { session } = makeSessionWithClient([]);
    const client = (session as any).client;
    client.getProcessInfo = () => ({ pid: 12345, killed: false, lastStderr: [] });
    client.listMcpServers = async () => ({ data: [] });
    (session as any).chromeBridge = {
      browserClientPath: __filename,
      client: { close: vi.fn() },
      key: 'http://127.0.0.1:9224|extension-id',
      localAppServerUrl: 'ws://127.0.0.1:12345/app-server',
      threadId: 'chrome-thread-1',
    };

    const status = await session.getDiagnosticStatus({ cwd: '/tmp/example', hasUI: true } as any, {
      verbose: true,
    });

    expect(status).toContain('Chrome/Brave AppServer bridge:');
    expect(status).toContain('Status: connected');
    expect(status).toContain('Local AppServer URL: ws://127.0.0.1:12345/app-server');
    expect(status).toContain('Runtime browser client:');
    expect(status).toContain('Thread: chrome-thread-1');
    const match = status.match(/Verbose diagnostic JSON: (.+\.json)/);
    expect(match).not.toBeNull();
    const diagnostic = JSON.parse(fs.readFileSync(match![1], 'utf8'));
    expect(diagnostic.browserBridgeConfig).toMatchObject({
      appServerControlSocket: expect.any(String),
      appServerControlSocketHealth: expect.any(Object),
      chromeAppServerOrigin: expect.any(String),
      chromeBrowserClientSha256: expect.any(String),
      chromeDebugBaseUrl: expect.any(String),
      chromeExtensionId: expect.any(String),
      iabBrowserClientSha256: expect.any(String),
    });
    expect(diagnostic.chromeBridge).toMatchObject({
      browserClientPath: __filename,
      browserClientSha256: expect.any(String),
      localAppServerUrl: 'ws://127.0.0.1:12345/app-server',
      threadId: 'chrome-thread-1',
    });
  });

  test('reports Chrome/Brave bridge bootstrap failures', async () => {
    const { session } = makeSessionWithClient([]);
    const client = (session as any).client;
    client.getProcessInfo = () => ({ pid: 12345, killed: false, lastStderr: [] });
    client.listMcpServers = async () => ({ data: [] });
    (session as any).lastChromeBridgeBootstrapFailure = {
      at: '2026-06-24T12:00:00.000Z',
      chromeAppServerOrigin: 'chrome-extension://extension-id',
      debugBaseUrl: 'http://127.0.0.1:9224',
      error: 'bootstrap exploded',
      extensionId: 'extension-id',
    };

    const status = await session.getDiagnosticStatus({ cwd: '/tmp/example', hasUI: true } as any);

    expect(status).toContain('Chrome/Brave AppServer bridge:');
    expect(status).toContain('Status: last bootstrap failed');
    expect(status).toContain('Error: bootstrap exploded');
    expect(status).toContain('Chrome/Brave debug URL: http://127.0.0.1:9224');
    expect(status).toContain('Chrome extension ID: extension-id');
    expect(status).toContain('Chrome AppServer origin: chrome-extension://extension-id');
  });

  test('writes verbose MCP JSON to a temp file instead of stdout', async () => {
    const { session } = makeSessionWithClient([]);
    const client = (session as any).client;
    const rawMcpStatus = {
      data: [
        {
          name: 'computer-use',
          tools: {
            list_apps: {
              name: 'list_apps',
              inputSchema: { properties: { app: { type: 'string' } } },
            },
          },
        },
      ],
    };
    client.getProcessInfo = () => ({ pid: 12345, killed: false, lastStderr: [] });
    client.listMcpServers = async () => rawMcpStatus;

    const status = await session.getDiagnosticStatus({ cwd: '/tmp/example', hasUI: true } as any, {
      verbose: true,
    });

    const match = status.match(/Verbose diagnostic JSON: (.+\.json)/);
    expect(match).not.toBeNull();
    const filePath = match![1];
    expect(status).not.toContain('"inputSchema"');
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).mcpServers).toEqual(rawMcpStatus);
  });
});
