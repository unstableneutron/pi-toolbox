import { describe, expect, test } from 'vitest';

import { createWebSearchTools, executeWithFallback, shouldFallbackToMcp } from './index';

describe('web-search provider fallback', () => {
  test('falls back to MCP when the SDK reports insufficient credit', async () => {
    const calls: string[] = [];
    const result = await executeWithFallback({
      sdk: async () => {
        calls.push('sdk');
        const error = new Error('Insufficient credit in account');
        Object.assign(error, { status: 402 });
        throw error;
      },
      mcp: async () => {
        calls.push('mcp');
        return { provider: 'mcp' as const, fallbackReason: 'sdk_unavailable' };
      },
    });

    expect(calls).toEqual(['sdk', 'mcp']);
    expect(result).toEqual({ provider: 'mcp', fallbackReason: 'sdk_unavailable' });
  });

  test('disables the SDK after the first fallback error', async () => {
    const calls: string[] = [];
    const tools = createWebSearchTools({
      apiKey: 'key',
      modelName: 'test-model',
      client: {
        beta: {
          search: async () => {
            calls.push('sdk');
            const error = new Error('Insufficient credit in account');
            Object.assign(error, { status: 402 });
            throw error;
          },
        },
      } as never,
      mcpCall: async (name) => {
        calls.push(`mcp:${name}`);
        return {
          search_id: 'search_123',
          results: [{ url: 'https://example.com', excerpts: ['ok'] }],
          usage: [],
        };
      },
    });

    const search = tools.find((tool) => tool.name === 'web_search');
    await search?.execute(
      'one',
      { objective: 'first', search_queries: ['first query'] },
      undefined,
      undefined,
      undefined as never,
    );
    await search?.execute(
      'two',
      { objective: 'second', search_queries: ['second query'] },
      undefined,
      undefined,
      undefined as never,
    );

    expect(calls).toEqual(['sdk', 'mcp:web_search', 'mcp:web_search']);
  });

  test('does not fall back for ordinary SDK errors', async () => {
    await expect(
      executeWithFallback({
        sdk: async () => {
          throw new Error('Bad request');
        },
        mcp: async () => {
          throw new Error('must not call mcp');
        },
      }),
    ).rejects.toThrow('Bad request');
  });

  test.each([401, 402, 403])('classifies HTTP %i as an MCP fallback error', (status) => {
    expect(shouldFallbackToMcp(Object.assign(new Error('account issue'), { status }))).toBe(true);
  });
});

describe('web-search tool registration', () => {
  test('registers web_search instead of web_search_preview', () => {
    const tools = createWebSearchTools({ apiKey: undefined, modelName: 'test-model' });

    expect(tools.map((tool) => tool.name)).toEqual(['web_search', 'web_fetch']);
  });
});
