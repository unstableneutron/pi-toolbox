import { describe, expect, test } from 'vitest';

import { createWebSearchTools } from './index';

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
