import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema, type ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';

import { asJsonValue, cloneJsonObject, endpointAuthorizationHeader } from './config';
import type {
  ExecutorElicitationRequest,
  ExecutorElicitationResponse,
  ExecutorEndpoint,
  ExecutorMcpInspection,
  ExecutorMcpResult,
} from './types';

const CLIENT_NAME = 'pi-executor-remote';
const CLIENT_VERSION = '0.1.1';
const DEFAULT_TEXT_RESULT = '(no result)';

export interface ExecutorMcpCallOptions {
  signal?: AbortSignal;
  onElicitation?: (request: ExecutorElicitationRequest) => Promise<ExecutorElicitationResponse>;
}

function buildCapabilities(): ClientCapabilities {
  return { elicitation: { form: {}, url: {} } };
}

function mcpUrl(baseUrl: string): URL {
  const url = new URL('mcp', `${baseUrl}/`);
  url.searchParams.set('elicitation_mode', 'native');
  return url;
}

function collectText(content: Array<{ type: string } & Record<string, unknown>>): string {
  return content
    .filter((item): item is { type: 'text'; text: string } => {
      return item.type === 'text' && typeof item.text === 'string';
    })
    .map((item) => item.text)
    .join('\n')
    .trim();
}

function normalizeToolResult(result: Awaited<ReturnType<Client['callTool']>>): ExecutorMcpResult {
  if (!('content' in result)) {
    return {
      text: JSON.stringify(result.toolResult, null, 2),
      structuredContent: asJsonValue(result.toolResult),
      isError: false,
    };
  }

  const structuredContent = asJsonValue(result.structuredContent);
  const text = collectText(result.content as Array<{ type: string } & Record<string, unknown>>);
  return {
    text:
      text ||
      (structuredContent !== null
        ? JSON.stringify(structuredContent, null, 2)
        : DEFAULT_TEXT_RESULT),
    structuredContent,
    isError: result.isError === true,
  };
}

async function withExecutorClient<T>(
  endpoint: ExecutorEndpoint,
  options: ExecutorMcpCallOptions,
  callback: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(
    { name: CLIENT_NAME, version: CLIENT_VERSION },
    { capabilities: buildCapabilities() },
  );
  const authorization = endpointAuthorizationHeader(endpoint.auth);
  const transport = new StreamableHTTPClientTransport(mcpUrl(endpoint.baseUrl), {
    requestInit: authorization ? { headers: { authorization } } : undefined,
  });

  client.setRequestHandler(ElicitRequestSchema, async (request) => {
    const handler = options.onElicitation;
    if (!handler) return { action: 'cancel' as const };
    const params = request.params;
    const response = await handler(
      params.mode === 'url'
        ? {
            mode: 'url',
            message: params.message,
            url: params.url,
            elicitationId: params.elicitationId,
          }
        : {
            mode: 'form',
            message: params.message,
            requestedSchema: cloneJsonObject(params.requestedSchema),
          },
    );
    return response.content
      ? { action: response.action, content: response.content }
      : { action: response.action };
  });

  await client.connect(transport);
  try {
    return await callback(client);
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

export async function executeRemoteCode(
  endpoint: ExecutorEndpoint,
  code: string,
  options: ExecutorMcpCallOptions = {},
): Promise<ExecutorMcpResult> {
  return withExecutorClient(endpoint, options, async (client) =>
    normalizeToolResult(
      await client.callTool({ name: 'execute', arguments: { code } }, undefined, {
        signal: options.signal,
        timeout: endpoint.requestTimeoutMs,
        maxTotalTimeout: endpoint.requestTimeoutMs,
      }),
    ),
  );
}

export async function inspectRemoteExecutor(
  endpoint: ExecutorEndpoint,
  signal?: AbortSignal,
): Promise<ExecutorMcpInspection> {
  return withExecutorClient(endpoint, { signal }, async (client) => {
    const tools: ExecutorMcpInspection['tools'] = [];
    let cursor: string | undefined;
    do {
      const response = await client.listTools(cursor ? { cursor } : undefined, {
        signal,
        timeout: endpoint.requestTimeoutMs,
        maxTotalTimeout: endpoint.requestTimeoutMs,
      });
      tools.push(
        ...response.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
      );
      cursor = response.nextCursor;
    } while (cursor);

    return { instructions: client.getInstructions(), tools };
  });
}

export function buildSearchCode(input: {
  query: string;
  namespace?: string;
  limit?: number;
  offset?: number;
  includeDetails?: boolean;
}): string {
  const searchInput = {
    query: input.query,
    ...(input.namespace ? { namespace: input.namespace } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
  };
  const serializedInput = JSON.stringify(searchInput);
  if (!input.includeDetails) {
    return `return await tools.search(${serializedInput});`;
  }

  return [
    `const page = await tools.search(${serializedInput});`,
    'const sourceItems = page.items ?? [];',
    'const items = [];',
    'for (let offset = 0; offset < sourceItems.length; offset += 4) {',
    '  const batch = sourceItems.slice(offset, offset + 4);',
    '  items.push(...await Promise.all(batch.map(async (item) => ({',
    '    ...item,',
    '    details: await tools.describe.tool({ path: item.path }),',
    '  }))));',
    '}',
    'return { ...page, items };',
  ].join('\n');
}
