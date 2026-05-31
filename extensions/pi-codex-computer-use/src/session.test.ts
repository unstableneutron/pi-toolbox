import fs from 'node:fs';

import { describe, expect, test } from 'vitest';

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
      },
    ]);
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

    expect(status).toContain('pi-codex-computer-use diagnostics');
    expect(status).toContain('Expected bridge servers:');
    expect(status).toContain('✓ computer-use auth: unsupported tools: 2');
    expect(status).toContain('- list_apps — List apps visible to Codex Computer Use.');
    expect(status).toContain('✓ node_repl auth: unsupported tools: 1');
    expect(status).toContain('Other app-server MCP servers:');
    expect(status).toContain('- codex_apps auth: unsupported tools: 1');
    expect(status).not.toContain('"inputSchema"');
    expect(status).not.toContain('"data"');
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
