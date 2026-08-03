import { describe, expect, test, vi } from 'vitest';

import { createRemoteExecutorTools } from './index';
import type { ExecutorEndpoint } from './src/types';

const endpoint: ExecutorEndpoint = {
  baseUrl: 'https://executor.example.com',
  auth: { kind: 'bearer', token: 'must-not-leak' },
  requestTimeoutMs: 5000,
  source: 'environment',
};

function context(hasUI = false) {
  return {
    cwd: '/repo',
    hasUI,
    ui: {
      notify: vi.fn(),
      select: vi.fn(),
      editor: vi.fn(),
      setStatus: vi.fn(),
    },
    isProjectTrusted: vi.fn(() => true),
  } as never;
}

describe('remote Executor Pi tools', () => {
  test('registers only fixed search and execute tools', () => {
    const tools = createRemoteExecutorTools();
    expect(tools.map((tool) => tool.name)).toEqual(['search', 'execute']);
  });

  test('routes native search through remote Executor execute', async () => {
    const executeCode = vi.fn(async () => ({
      text: '{"items":[]}',
      structuredContent: { items: [] },
      isError: false,
    }));
    const tools = createRemoteExecutorTools({
      dependencies: {
        resolveEndpoint: async () => endpoint,
        executeCode,
      },
    });
    const search = tools.find((tool) => tool.name === 'search')!;
    const result = await search.execute(
      'call-1',
      { query: 'github issues', includeDetails: true },
      undefined,
      undefined,
      context(),
    );

    expect(executeCode).toHaveBeenCalledWith(
      endpoint,
      expect.stringContaining('tools.describe.tool'),
      expect.objectContaining({ onElicitation: expect.any(Function) }),
    );
    expect(result.content).toEqual([{ type: 'text', text: '{"items":[]}' }]);
    expect(result.details).toMatchObject({
      endpoint: 'https://executor.example.com',
      source: 'environment',
    });
    expect(JSON.stringify(result.details)).not.toContain('must-not-leak');
  });

  test('propagates Pi cancellation signals to Executor MCP', async () => {
    const executeCode = vi.fn(async () => ({
      text: 'done',
      structuredContent: null,
      isError: false,
    }));
    const tools = createRemoteExecutorTools({
      dependencies: { resolveEndpoint: async () => endpoint, executeCode },
    });
    const execute = tools.find((tool) => tool.name === 'execute')!;
    const controller = new AbortController();
    await execute.execute('call-2', { code: 'return 1' }, controller.signal, undefined, context());

    expect(executeCode).toHaveBeenCalledWith(
      endpoint,
      'return 1',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  test('throws connection failures so Pi marks the tool result as an error', async () => {
    const tools = createRemoteExecutorTools({
      dependencies: {
        resolveEndpoint: async () => {
          throw new Error('daemon unavailable');
        },
      },
    });
    const execute = tools.find((tool) => tool.name === 'execute')!;

    await expect(
      execute.execute('call-3', { code: 'return 1' }, undefined, undefined, context()),
    ).rejects.toThrow('daemon unavailable');
  });

  test('throws MCP tool failures so Pi marks the result as an error', async () => {
    const tools = createRemoteExecutorTools({
      dependencies: {
        resolveEndpoint: async () => endpoint,
        executeCode: async () => ({
          text: 'remote tool failed',
          structuredContent: { status: 'error' },
          isError: true,
        }),
      },
    });
    const execute = tools.find((tool) => tool.name === 'execute')!;

    await expect(
      execute.execute('call-4', { code: 'return 1' }, undefined, undefined, context()),
    ).rejects.toThrow('remote tool failed');
  });
});
