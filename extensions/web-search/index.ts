/**
 * Native web_search_preview and web_fetch tools for pi.
 *
 * Replaces the remote Parallel Search MCP with direct SDK calls,
 * giving us custom TUI rendering, native abort support, and no
 * MCP connection overhead.
 *
 * Requires PARALLEL_API_KEY environment variable.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import Parallel from 'parallel-web';

// ── Types ──────────────────────────────────────────────────────────

interface UsageItem {
  name: string;
  count: number;
}

interface SearchDetails {
  searchId: string;
  objective: string;
  queries: string[];
  resultCount: number;
  usage: UsageItem[];
}

interface FetchDetails {
  extractId: string;
  objective: string | null;
  urls: string[];
  resultCount: number;
  errorCount: number;
  usage: UsageItem[];
}

// ── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const apiKey = process.env.PARALLEL_API_KEY;

  if (!apiKey) {
    pi.on('session_start', async (_event, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify('web-search: PARALLEL_API_KEY not set — tools disabled', 'warning');
      }
    });
    return;
  }

  const client = new Parallel({ apiKey });

  // ── web_search_preview ─────────────────────────────────────────

  pi.registerTool({
    name: 'web_search_preview',
    label: 'Web Search',
    description:
      'Perform web searches and return results in an LLM-friendly format with parameters tuned for LLMs.',
    promptSnippet: 'Search the web with a natural-language objective and keyword queries',
    parameters: Type.Object({
      objective: Type.String({
        description:
          'Natural-language description of what the web search is trying to find. ' +
          'Try to make the search objective atomic, looking for a specific piece of information. ' +
          'May include guidance about preferred sources or freshness.',
      }),
      search_queries: Type.Array(Type.String({ maxLength: 100 }), {
        description:
          'List of keyword search queries of 3-6 words, which may include search operators. ' +
          'The search queries should be related to the objective. Limited to 3 entries of 100 characters each.',
        minItems: 1,
        maxItems: 3,
      }),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const { objective, search_queries } = params;

      onUpdate?.({
        content: [{ type: 'text', text: `Searching: ${search_queries.join(', ')}` }],
        details: {
          searchId: '',
          objective,
          queries: search_queries,
          resultCount: 0,
          usage: [],
        } satisfies SearchDetails,
      });

      let search;
      try {
        search = await client.beta.search(
          {
            objective,
            search_queries,
            mode: 'agentic',
            max_results: 10,
            excerpts: { max_chars_per_result: 5000 },
          },
          { signal: signal ?? undefined },
        );
      } catch (err) {
        if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
          throw new Error('Search cancelled');
        }
        throw err;
      }

      const results = search.results ?? [];
      const usage = search.usage ?? [];

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: 'No results found.' }],
          details: {
            searchId: search.search_id,
            objective,
            queries: search_queries,
            resultCount: 0,
            usage,
          } satisfies SearchDetails,
        };
      }

      const formatted = {
        search_id: search.search_id,
        results: results.map((r) => ({
          url: r.url,
          title: r.title ?? null,
          publish_date: r.publish_date ?? null,
          excerpts: r.excerpts ?? [],
        })),
        warnings: search.warnings ?? null,
        usage: search.usage ?? null,
        summary: null,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
        details: {
          searchId: search.search_id,
          objective,
          queries: search_queries,
          resultCount: results.length,
          usage,
        } satisfies SearchDetails,
      };
    },

    renderCall(args, theme) {
      // Line 1: tool name + objective
      let text = theme.fg('toolTitle', theme.bold('Web Search'));
      if (args.objective) {
        text += '  ' + theme.fg('dim', args.objective);
      }

      // Lines 2+: each query as a bullet
      const queries: string[] = args.search_queries ?? [];
      for (const q of queries) {
        text += `\n  ${theme.fg('muted', '·')} ${theme.fg('accent', q)}`;
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as SearchDetails | undefined;

      // Streaming state
      if (isPartial) {
        const queryCount = details?.queries.length ?? 0;
        const suffix = queryCount > 0 ? `  ${queryCount} queries` : '';
        return new Text(theme.fg('warning', `Searching…${suffix}`), 0, 0);
      }

      if (result.content[0]?.type === 'text' && result.content[0].text.startsWith('Error:')) {
        return new Text(theme.fg('error', result.content[0].text), 0, 0);
      }

      if (!details || details.resultCount === 0) {
        return new Text(theme.fg('dim', 'No results found'), 0, 0);
      }

      // Collapsed: "7 results from 1 search"
      const searchCount = details.usage.find((u) => u.name === 'sku_search')?.count;
      let text = theme.fg('success', `${details.resultCount} results`);
      if (searchCount) {
        text += theme.fg('dim', ` from ${searchCount} search${searchCount > 1 ? 'es' : ''}`);
      }

      // Expanded: show each result as "· Title — url"
      if (expanded) {
        const content = result.content[0];
        if (content?.type === 'text') {
          try {
            const parsed = JSON.parse(content.text);
            for (const r of parsed.results?.slice(0, 15) ?? []) {
              const title = r.title || '(untitled)';
              const url = r.url ?? '';
              text += `\n  ${theme.fg('muted', '·')} ${theme.fg('accent', title)} ${theme.fg('dim', '— ' + url)}`;
            }
            const total = parsed.results?.length ?? 0;
            if (total > 15) {
              text += `\n  ${theme.fg('dim', `  … ${total - 15} more`)}`;
            }
          } catch {
            const lines = content.text.split('\n').slice(0, 20);
            for (const line of lines) {
              text += `\n  ${theme.fg('dim', line)}`;
            }
          }
        }
      }

      return new Text(text, 0, 0);
    },
  });

  // ── web_fetch ──────────────────────────────────────────────────

  pi.registerTool({
    name: 'web_fetch',
    label: 'Web Fetch',
    description:
      'Fetch and extract relevant content from specific web URLs.\n\n' +
      'Ideal Use Cases:\n' +
      "- Extracting content from specific URLs you've already identified\n" +
      '- Exploring URLs returned by a web search in greater depth',
    promptSnippet: 'Fetch and extract content from specific URLs',
    parameters: Type.Object({
      urls: Type.Array(Type.String(), {
        description:
          'List of URLs to extract content from. Must be valid HTTP/HTTPS URLs. Maximum 10 URLs per request.',
        minItems: 1,
        maxItems: 10,
      }),
      objective: Type.Optional(
        Type.String({
          description:
            "Natural-language description of what information you're looking for from the URLs. " +
            'Limit to 200 characters.',
          maxLength: 200,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const { urls, objective } = params;

      onUpdate?.({
        content: [
          {
            type: 'text',
            text: `Fetching ${urls.length} URL${urls.length > 1 ? 's' : ''}…`,
          },
        ],
        details: {
          extractId: '',
          objective: objective ?? null,
          urls,
          resultCount: 0,
          errorCount: 0,
          usage: [],
        } satisfies FetchDetails,
      });

      let extract;
      try {
        extract = await client.beta.extract(
          {
            urls,
            objective,
            excerpts: true,
            full_content: false,
          },
          { signal: signal ?? undefined },
        );
      } catch (err) {
        if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
          throw new Error('Fetch cancelled');
        }
        throw err;
      }

      const results = extract.results ?? [];
      const errors = extract.errors ?? [];
      const usage = extract.usage ?? [];

      const formatted = {
        extract_id: extract.extract_id,
        results: results.map((r) => ({
          url: r.url,
          title: r.title ?? null,
          publish_date: r.publish_date ?? null,
          excerpts: r.excerpts ?? [],
          full_content: r.full_content ?? null,
        })),
        errors: errors.map((e) => ({
          url: e.url,
          error_type: e.error_type,
          http_status_code: e.http_status_code,
          content: e.content,
        })),
        warnings: extract.warnings ?? null,
        usage: extract.usage ?? null,
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
        details: {
          extractId: extract.extract_id,
          objective: objective ?? null,
          urls,
          resultCount: results.length,
          errorCount: errors.length,
          usage,
        } satisfies FetchDetails,
      };
    },

    renderCall(args, theme) {
      const urlList: string[] = args.urls ?? [];
      let text = theme.fg('toolTitle', theme.bold('Web Page'));

      if (urlList.length === 1) {
        // Single URL: compact one-liner
        text += '  ' + theme.fg('accent', urlList[0]);
        if (args.objective) {
          text += '\n  ' + theme.fg('dim', args.objective);
        }
      } else {
        // Multiple URLs: objective on first line, URLs as bullets
        if (args.objective) {
          text += '  ' + theme.fg('dim', args.objective);
        }
        for (const url of urlList) {
          text += `\n  ${theme.fg('muted', '·')} ${theme.fg('accent', url)}`;
        }
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as FetchDetails | undefined;

      // Streaming state
      if (isPartial) {
        const urlCount = details?.urls.length ?? 0;
        const suffix = urlCount > 1 ? `  ${urlCount} URLs` : '';
        return new Text(theme.fg('warning', `Fetching…${suffix}`), 0, 0);
      }

      if (result.content[0]?.type === 'text' && result.content[0].text.startsWith('Error:')) {
        return new Text(theme.fg('error', result.content[0].text), 0, 0);
      }

      if (!details) {
        return new Text(theme.fg('dim', 'No results'), 0, 0);
      }

      // Collapsed: "2 URLs fetched"
      const color = details.resultCount > 0 ? 'success' : details.errorCount > 0 ? 'error' : 'dim';
      let text = theme.fg(
        color,
        `${details.resultCount} URL${details.resultCount !== 1 ? 's' : ''} fetched`,
      );
      if (details.errorCount > 0) {
        text += theme.fg('error', ` (${details.errorCount} failed)`);
      }

      // Expanded: show each result as "· Title — url"
      if (expanded) {
        const content = result.content[0];
        if (content?.type === 'text') {
          try {
            const parsed = JSON.parse(content.text);
            for (const r of parsed.results?.slice(0, 15) ?? []) {
              const title = r.title || '(untitled)';
              const url = r.url ?? '';
              text += `\n  ${theme.fg('muted', '·')} ${theme.fg('accent', title)} ${theme.fg('dim', '— ' + url)}`;
            }
            for (const e of parsed.errors?.slice(0, 5) ?? []) {
              text += `\n  ${theme.fg('error', '✗')} ${theme.fg('dim', e.url + ': ' + e.error_type)}`;
            }
          } catch {
            const lines = content.text.split('\n').slice(0, 20);
            for (const line of lines) {
              text += `\n  ${theme.fg('dim', line)}`;
            }
          }
        }
      }

      return new Text(text, 0, 0);
    },
  });
}
