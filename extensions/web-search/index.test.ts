import { describe, expect, test } from 'vitest';

import { createWebSearchTools, executeWithFallback, shouldFallbackToMcp } from './index';

describe('web-search Parallel SDK integration', () => {
  test('uses the GA Search API in Turbo mode', async () => {
    const requests: unknown[] = [];
    const tools = createWebSearchTools({
      client: {
        search: async (request: unknown) => {
          requests.push(request);
          return {
            search_id: 'search_123',
            results: [{ url: 'https://example.com', excerpts: ['ok'] }],
            usage: [],
          };
        },
      } as never,
    });

    const search = tools.find((tool) => tool.name === 'web_search');
    await search?.execute(
      'one',
      { objective: 'first', search_queries: ['first query'] },
      undefined,
      undefined,
      undefined as never,
    );

    expect(requests).toEqual([
      {
        objective: 'first',
        search_queries: ['first query'],
        mode: 'turbo',
        max_chars_total: 50_000,
        advanced_settings: {
          max_results: 10,
          excerpt_settings: { max_chars_per_result: 5000 },
        },
      },
    ]);
  });
});

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
        return { provider: 'mcp' as const, fallbackReason: 'sdk_http_402' };
      },
    });

    expect(calls).toEqual(['sdk', 'mcp']);
    expect(result).toEqual({ provider: 'mcp', fallbackReason: 'sdk_http_402' });
  });

  test('uses MCP for every later tool call after the SDK falls back', async () => {
    const calls: string[] = [];
    const tools = createWebSearchTools({
      apiKey: 'key',
      modelName: 'test-model',
      client: {
        search: async () => {
          calls.push('sdk:web_search');
          const error = new Error('Insufficient credit in account');
          Object.assign(error, { status: 402 });
          throw error;
        },
        extract: async () => {
          calls.push('sdk:web_fetch');
          throw new Error('SDK must remain disabled');
        },
      } as never,
      mcpCall: async (name) => {
        calls.push(`mcp:${name}`);
        if (name === 'web_search') {
          return {
            search_id: 'search_123',
            results: [{ url: 'https://example.com', excerpts: ['ok'] }],
            usage: [],
          };
        }
        return {
          extract_id: 'extract_123',
          results: [{ url: 'https://example.com', excerpts: ['ok'] }],
          errors: [],
          usage: [],
        };
      },
    });

    const search = tools.find((tool) => tool.name === 'web_search');
    const fetch = tools.find((tool) => tool.name === 'web_fetch');
    const searchResult = await search?.execute(
      'search',
      { objective: 'first', search_queries: ['first query'] },
      undefined,
      undefined,
      undefined as never,
    );
    const fetchResult = await fetch?.execute(
      'fetch',
      { urls: ['https://example.com'] },
      undefined,
      undefined,
      undefined as never,
    );

    expect(calls).toEqual(['sdk:web_search', 'mcp:web_search', 'mcp:web_fetch']);
    expect(searchResult?.details).toMatchObject({
      provider: 'mcp',
      fallbackReason: 'sdk_http_402',
    });
    expect(fetchResult?.details).toMatchObject({
      provider: 'mcp',
      fallbackReason: 'sdk_http_402',
    });
  });

  test('uses MCP directly when no API key is configured', async () => {
    const calls: string[] = [];
    const tools = createWebSearchTools({
      mcpCall: async (name) => {
        calls.push(name);
        return { search_id: 'search_123', results: [], usage: [] };
      },
    });

    const search = tools.find((tool) => tool.name === 'web_search');
    await search?.execute(
      'search',
      { objective: 'first', search_queries: ['first query'] },
      undefined,
      undefined,
      undefined as never,
    );

    expect(calls).toEqual(['web_search']);
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

  test('falls back when a stale SDK lacks the GA methods', () => {
    expect(shouldFallbackToMcp(new TypeError('client.search is not a function'))).toBe(true);
    expect(shouldFallbackToMcp(new TypeError('client.extract is not a function'))).toBe(true);
  });
});

describe('web-search tool registration', () => {
  test('registers web_search instead of web_search_preview', () => {
    const tools = createWebSearchTools();

    expect(tools.map((tool) => tool.name)).toEqual(['web_search', 'web_fetch']);
    expect((tools[0]!.parameters as any).additionalProperties).toBe(false);
    expect(tools[0]?.constrainedSampling).toEqual({
      type: 'json_schema',
      strict: 'prefer',
    });
    expect(tools[1]?.constrainedSampling).toBeUndefined();
  });

  test('avoids unsupported array maxItems schema keywords', () => {
    const tools = createWebSearchTools();
    const searchParameters = tools[0]!.parameters as any;
    const fetchParameters = tools[1]!.parameters as any;

    expect(searchParameters.properties.search_queries.minItems).toBe(1);
    expect(searchParameters.properties.search_queries).not.toHaveProperty('maxItems');
    expect(fetchParameters.properties.urls.minItems).toBe(1);
    expect(fetchParameters.properties.urls).not.toHaveProperty('maxItems');
  });

  test('enforces array limits before calling a provider', async () => {
    const tools = createWebSearchTools();
    const search = tools.find((tool) => tool.name === 'web_search');
    const fetch = tools.find((tool) => tool.name === 'web_fetch');

    expect(search).toBeDefined();
    expect(fetch).toBeDefined();
    await expect(
      search!.execute(
        'search',
        { objective: 'too many', search_queries: ['one', 'two', 'three', 'four'] },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow('web_search.search_queries accepts at most 3 items; received 4');
    await expect(
      fetch!.execute(
        'fetch',
        { urls: Array.from({ length: 11 }, (_, index) => `https://example.com/${index}`) },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow('web_fetch.urls accepts at most 10 items; received 11');
  });
});
