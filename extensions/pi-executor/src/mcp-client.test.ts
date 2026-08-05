import { createServer } from 'node:http';

import { afterEach, describe, expect, test } from 'vitest';

import {
  buildDescribeToolCode,
  buildFindToolsCode,
  callRemoteTool,
  executeRemoteCode,
  inspectRemoteExecutor,
} from './mcp-client';
import type { ExecutorEndpoint } from './types';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
  requests: Array<{ authorization?: string; elicitationMode?: string; method?: string }>;
}

const servers: TestServer[] = [];

async function readJsonRpcRequest(incoming: AsyncIterable<Uint8Array>): Promise<JsonRpcRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRpcRequest;
}

function jsonRpcResponse(id: string | number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

async function startTestServer(expectedToken: string): Promise<TestServer> {
  const requests: TestServer['requests'] = [];
  const instance = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', 'http://127.0.0.1');
    const authorization = incoming.headers.authorization;
    if (incoming.method === 'GET') {
      outgoing.writeHead(405).end();
      return;
    }
    if (incoming.method === 'DELETE') {
      outgoing.writeHead(204).end();
      return;
    }
    if (authorization !== `Bearer ${expectedToken}`) {
      outgoing.writeHead(401).end('Unauthorized');
      return;
    }

    const request = await readJsonRpcRequest(incoming);
    requests.push({
      authorization,
      elicitationMode: url.searchParams.get('elicitation_mode') ?? undefined,
      method: request.method,
    });
    if (request.method === 'notifications/initialized') {
      outgoing.writeHead(202).end();
      return;
    }

    let result: unknown;
    if (request.method === 'initialize') {
      result = {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'executor', version: '1.0.0' },
        instructions: 'Use Executor tools through execute.',
      };
    } else if (request.method === 'tools/list') {
      result = {
        tools: [
          {
            name: 'execute',
            description: 'Execute code.',
            inputSchema: {
              type: 'object',
              properties: { code: { type: 'string' } },
              required: ['code'],
            },
          },
          {
            name: 'skills',
            description: 'Fetch Executor guidance.',
            inputSchema: {
              type: 'object',
              properties: { name: { type: 'string' } },
            },
          },
        ],
      };
    } else if (request.method === 'resources/list') {
      result = {
        resources: [
          {
            name: 'Executor Shell',
            uri: 'ui://executor/shell.html',
            mimeType: 'text/html;profile=mcp-app',
          },
        ],
      };
    } else if (request.method === 'tools/call') {
      const params = request.params as
        | { name?: string; arguments?: Record<string, unknown> }
        | undefined;
      const name = params?.name ?? '';
      const args = params?.arguments ?? {};
      const code = typeof args.code === 'string' ? args.code : '';
      if (code === 'slow') await new Promise((resolve) => setTimeout(resolve, 100));
      const text = name === 'execute' ? `ran:${code}` : `called:${name}:${JSON.stringify(args)}`;
      result = {
        content: [{ type: 'text', text }],
        structuredContent: { status: 'completed', name, args },
      };
    } else {
      outgoing.writeHead(404).end();
      return;
    }

    outgoing.writeHead(200, {
      'content-type': 'application/json',
      'mcp-session-id': 'test-session',
    });
    outgoing.end(jsonRpcResponse(request.id!, result));
  });
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind TCP');

  const testServer: TestServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      instance.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        instance.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
  servers.push(testServer);
  return testServer;
}

function endpoint(baseUrl: string): ExecutorEndpoint {
  return {
    mcpUrl: `${baseUrl}/mcp`,
    auth: { kind: 'bearer', token: 'test-token' },
    requestTimeoutMs: 5000,
    yieldAfterMs: 1000,
    maxOutputBytes: 12_288,
    maxOutputLines: 300,
    source: 'environment',
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('remote Executor MCP client', () => {
  test('authenticates, requests native elicitation mode, and executes code', async () => {
    const server = await startTestServer('test-token');
    const result = await executeRemoteCode(endpoint(server.baseUrl), 'return 1');

    expect(result).toEqual({
      text: 'ran:return 1',
      structuredContent: {
        status: 'completed',
        name: 'execute',
        args: { code: 'return 1' },
      },
      isError: false,
    });
    expect(server.requests.every((request) => request.authorization === 'Bearer test-token')).toBe(
      true,
    );
    expect(server.requests[0]?.elicitationMode).toBe('native');
  });

  test('enforces the configured hard request timeout', async () => {
    const server = await startTestServer('test-token');
    const shortEndpoint = { ...endpoint(server.baseUrl), requestTimeoutMs: 20 };

    await expect(executeRemoteCode(shortEndpoint, 'slow')).rejects.toThrow();
  });

  test('calls any native MCP tool', async () => {
    const server = await startTestServer('test-token');
    const result = await callRemoteTool(endpoint(server.baseUrl), 'skills', { name: 'execute' });

    expect(result.text).toBe('called:skills:{"name":"execute"}');
    expect(result.structuredContent).toMatchObject({
      name: 'skills',
      args: { name: 'execute' },
    });
  });

  test('inspects tools, schemas, and resources from the remote MCP server', async () => {
    const server = await startTestServer('test-token');
    const result = await inspectRemoteExecutor(endpoint(server.baseUrl));

    expect(result.instructions).toBe('Use Executor tools through execute.');
    expect(result.tools.map((tool) => tool.name)).toEqual(['execute', 'skills']);
    expect(result.tools[1]?.inputSchema).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string' } },
    });
    expect(result.resources).toEqual([
      {
        name: 'Executor Shell',
        uri: 'ui://executor/shell.html',
        mimeType: 'text/html;profile=mcp-app',
      },
    ]);
  });
});

describe('Executor discovery code', () => {
  test('serializes search inputs without allowing code injection', () => {
    const code = buildFindToolsCode({
      query: 'issues"; throw new Error("bad")',
      namespace: 'github',
      limit: 5,
      offset: 10,
    });

    expect(code).toContain(
      'tools.search({"query":"issues\\\"; throw new Error(\\\"bad\\\")","namespace":"github","limit":5,"offset":10})',
    );
    expect(code).toContain('summary: item.summary ?? item.description');
    expect(code).toContain('nextOffset: page.nextOffset');
    expect(code).not.toContain('kind: "integration"');
    expect(code).not.toContain('tools.describe.tool');
  });

  test('describes one exact tool path without allowing code injection', () => {
    const code = buildDescribeToolCode('github.x"; throw new Error("bad")');

    expect(code).toContain(
      'tools.describe.tool({ path: "github.x\\\"; throw new Error(\\\"bad\\\")" })',
    );
    expect(code).toContain('inputTypeScript: details.inputTypeScript');
    expect(code).toContain('dataTypeScript: details.dataTypeScript');
    expect(code).toContain('outputTypeScript: details.outputTypeScript');
  });
});
