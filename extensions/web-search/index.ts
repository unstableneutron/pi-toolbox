/**
 * Native web_search and web_fetch tools for pi.
 *
 * Uses Parallel Search Turbo through the Parallel SDK, with anonymous
 * Parallel Search MCP fallback when no key is configured or the keyed
 * account cannot be used.
 */

import { randomUUID } from 'node:crypto';
import {
  defineTool,
  type ExtensionAPI,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import Parallel from 'parallel-web';

const PARALLEL_SEARCH_MCP_URL = 'https://search.parallel.ai/mcp';
const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_TOOL_SESSION_ID = `pi_toolbox_${randomUUID()}`;
const MAX_SEARCH_QUERIES = 3;
const MAX_FETCH_URLS = 10;

// ── Types ──────────────────────────────────────────────────────────

interface UsageItem {
  name: string;
  count: number;
}

type ProviderName = 'sdk' | 'mcp';

interface ProviderDetails {
  provider: ProviderName;
  fallbackReason?: string;
}

interface SearchDetails extends ProviderDetails {
  searchId: string;
  objective: string;
  queries: string[];
  resultCount: number;
  usage: UsageItem[];
}

interface FetchDetails extends ProviderDetails {
  extractId: string;
  objective: string | null;
  urls: string[];
  resultCount: number;
  errorCount: number;
  usage: UsageItem[];
}

interface WebResult {
  url: string;
  title?: string | null;
  publish_date?: string | null;
  excerpts?: string[] | null;
}

interface SearchResponse extends ProviderDetails {
  search_id: string;
  results?: WebResult[] | null;
  warnings?: unknown[] | null;
  usage?: UsageItem[] | null;
}

interface ExtractError {
  url: string;
  error_type: string;
  http_status_code: number | null;
  content: string | null;
}

interface ExtractResponse extends ProviderDetails {
  extract_id: string;
  results?: Array<WebResult & { full_content?: string | null }> | null;
  errors?: ExtractError[] | null;
  warnings?: unknown[] | null;
  usage?: UsageItem[] | null;
}

interface ExecuteWithFallbackOptions<TResult> {
  sdk?: () => Promise<TResult>;
  mcp: () => Promise<TResult>;
  onFallback?: (err: unknown) => void;
}

interface CreateWebSearchToolsOptions {
  apiKey?: string;
  modelName?: string;
  client?: Parallel;
  mcpCall?: (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal | null,
  ) => Promise<unknown>;
}

// ── Provider helpers ───────────────────────────────────────────────

function getErrorStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

function enforceMaximumItems(
  toolName: string,
  fieldName: string,
  itemCount: number,
  maximum: number,
): void {
  if (itemCount <= maximum) return;
  throw new Error(
    `${toolName}.${fieldName} accepts at most ${maximum} items; received ${itemCount}`,
  );
}

export function shouldFallbackToMcp(err: unknown): boolean {
  const status = getErrorStatus(err);
  if (status === 401 || status === 402 || status === 403) return true;

  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    message.includes('insufficient credit') ||
    message.includes('billing') ||
    message.includes('.search is not a function') ||
    message.includes('.extract is not a function')
  );
}

export async function executeWithFallback<TResult>({
  sdk,
  mcp,
  onFallback,
}: ExecuteWithFallbackOptions<TResult>): Promise<TResult> {
  if (!sdk) return mcp();

  try {
    return await sdk();
  } catch (err) {
    if (shouldFallbackToMcp(err)) {
      onFallback?.(err);
      return mcp();
    }
    throw err;
  }
}

function parseMcpResponse(text: string, contentType: string | null): unknown {
  if (contentType?.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n');
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

async function postMcp(
  body: Record<string, unknown>,
  signal?: AbortSignal | null,
  sessionId?: string,
): Promise<{ response: unknown; sessionId?: string }> {
  const response = await fetch(PARALLEL_SEARCH_MCP_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
    signal: signal ?? undefined,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Parallel Search MCP HTTP ${response.status}: ${text}`);
  }

  return {
    response: parseMcpResponse(text, response.headers.get('content-type')),
    sessionId: response.headers.get('mcp-session-id') ?? undefined,
  };
}

async function callParallelSearchMcp(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal | null,
): Promise<unknown> {
  const initialized = await postMcp(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'pi-toolbox-web-search', version: '0.0.0' },
      },
    },
    signal,
  );

  const called = await postMcp(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    signal,
    initialized.sessionId,
  );

  const envelope = called.response as {
    error?: { message?: string };
    result?: { content?: Array<{ type: string; text?: string }> };
  };

  if (envelope.error) {
    throw new Error(envelope.error.message ?? 'Parallel Search MCP error');
  }

  const text = envelope.result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) {
    throw new Error('Parallel Search MCP returned no text content');
  }

  return JSON.parse(text);
}

function addMcpArgs(args: Record<string, unknown>, modelName: string): Record<string, unknown> {
  return {
    ...args,
    session_id: MCP_TOOL_SESSION_ID,
    model_name: modelName,
  };
}

// ── Tools ──────────────────────────────────────────────────────────

export function createWebSearchTools({
  apiKey,
  modelName = 'pi',
  client = apiKey ? new Parallel({ apiKey }) : undefined,
  mcpCall = callParallelSearchMcp,
}: CreateWebSearchToolsOptions = {}) {
  const tools: ToolDefinition[] = [];
  let sdkDisabledReason: string | undefined;

  const disableSdk = (err: unknown) => {
    const status = getErrorStatus(err);
    sdkDisabledReason = status ? `sdk_http_${status}` : 'sdk_unavailable';
  };

  const activeClient = () => (sdkDisabledReason ? undefined : client);

  // ── web_search ─────────────────────────────────────────────────

  tools.push(
    defineTool({
      name: 'web_search',
      label: 'Web Search',
      description:
        'Perform web searches and return results in an LLM-friendly format with parameters tuned for LLMs.',
      promptSnippet: 'Search the web with a natural-language objective and keyword queries',
      parameters: Type.Object(
        {
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
          }),
        },
        { additionalProperties: false },
      ),
      constrainedSampling: { type: 'json_schema', strict: 'prefer' },

      async execute(_toolCallId, params, signal, onUpdate) {
        const { objective, search_queries } = params;
        enforceMaximumItems(
          'web_search',
          'search_queries',
          search_queries.length,
          MAX_SEARCH_QUERIES,
        );
        onUpdate?.({
          content: [{ type: 'text', text: `Searching: ${search_queries.join(', ')}` }],
          details: {
            searchId: '',
            objective,
            queries: search_queries,
            resultCount: 0,
            usage: [],
            provider: activeClient() ? 'sdk' : 'mcp',
          } satisfies SearchDetails,
        });

        const sdkClient = activeClient();
        const search = await executeWithFallback<SearchResponse>({
          sdk: sdkClient
            ? async () => {
                try {
                  const response = await sdkClient.search(
                    {
                      objective,
                      search_queries,
                      mode: 'turbo',
                      max_chars_total: 50_000,
                      advanced_settings: {
                        max_results: 10,
                        excerpt_settings: { max_chars_per_result: 5000 },
                      },
                    },
                    { signal: signal ?? undefined },
                  );
                  return {
                    ...(response as unknown as SearchResponse),
                    provider: 'sdk' as const,
                  };
                } catch (err) {
                  if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
                    throw new Error('Search cancelled');
                  }
                  throw err;
                }
              }
            : undefined,
          mcp: async () => {
            const response = (await mcpCall(
              'web_search',
              addMcpArgs({ objective, search_queries }, modelName),
              signal,
            )) as SearchResponse;
            return {
              ...response,
              provider: 'mcp' as const,
              fallbackReason: sdkDisabledReason ?? (sdkClient ? 'sdk_unavailable' : undefined),
            };
          },
          onFallback: disableSdk,
        });

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
              provider: search.provider,
              fallbackReason: search.fallbackReason,
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
            provider: search.provider,
            fallbackReason: search.fallbackReason,
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
    }),
  );

  // ── web_fetch ──────────────────────────────────────────────────

  tools.push(
    defineTool({
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
        enforceMaximumItems('web_fetch', 'urls', urls.length, MAX_FETCH_URLS);
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
            provider: activeClient() ? 'sdk' : 'mcp',
          } satisfies FetchDetails,
        });

        const sdkClient = activeClient();
        const extract = await executeWithFallback<ExtractResponse>({
          sdk: sdkClient
            ? async () => {
                try {
                  const response = await sdkClient.extract(
                    {
                      urls,
                      objective,
                      advanced_settings: {
                        excerpt_settings: { max_chars_per_result: 5000 },
                        full_content: false,
                      },
                    },
                    { signal: signal ?? undefined },
                  );
                  return {
                    ...(response as unknown as ExtractResponse),
                    provider: 'sdk' as const,
                  };
                } catch (err) {
                  if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
                    throw new Error('Fetch cancelled');
                  }
                  throw err;
                }
              }
            : undefined,
          mcp: async () => {
            const response = (await mcpCall(
              'web_fetch',
              addMcpArgs({ urls, objective }, modelName),
              signal,
            )) as ExtractResponse;
            return {
              ...response,
              provider: 'mcp' as const,
              fallbackReason: sdkDisabledReason ?? (sdkClient ? 'sdk_unavailable' : undefined),
            };
          },
          onFallback: disableSdk,
        });

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
            provider: extract.provider,
            fallbackReason: extract.fallbackReason,
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
        const color =
          details.resultCount > 0 ? 'success' : details.errorCount > 0 ? 'error' : 'dim';
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
    }),
  );

  return tools;
}

// ── Extension ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const apiKey = process.env.PARALLEL_API_KEY;

  if (!apiKey) {
    pi.on('session_start', async (_event, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify('web-search: PARALLEL_API_KEY not set — using free Search MCP', 'info');
      }
    });
  }

  for (const tool of createWebSearchTools({ apiKey })) {
    pi.registerTool(tool);
  }
}
