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
  JsonObject,
} from './types';

const CLIENT_NAME = 'pi-executor-remote';
const CLIENT_VERSION = '0.5.0';
const DEFAULT_TEXT_RESULT = '(no result)';

export interface ExecutorMcpProgress {
  progress: number;
  total?: number;
  message?: string;
}

export interface ExecutorMcpCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: ExecutorMcpProgress) => void;
  onElicitation?: (request: ExecutorElicitationRequest) => Promise<ExecutorElicitationResponse>;
}

function buildCapabilities(): ClientCapabilities {
  return { elicitation: { form: {}, url: {} } };
}

function requestMcpUrl(mcpEndpoint: string): URL {
  const url = new URL(mcpEndpoint);
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
  const transport = new StreamableHTTPClientTransport(requestMcpUrl(endpoint.mcpUrl), {
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

export async function callRemoteTool(
  endpoint: ExecutorEndpoint,
  name: string,
  args: JsonObject,
  options: ExecutorMcpCallOptions = {},
): Promise<ExecutorMcpResult> {
  return withExecutorClient(endpoint, options, async (client) => {
    const timeoutMs = options.timeoutMs ?? endpoint.requestTimeoutMs;
    return normalizeToolResult(
      await client.callTool({ name, arguments: args }, undefined, {
        signal: options.signal,
        timeout: timeoutMs,
        maxTotalTimeout: timeoutMs,
        resetTimeoutOnProgress: true,
        ...(options.onProgress ? { onprogress: options.onProgress } : {}),
      }),
    );
  });
}

export async function executeRemoteCode(
  endpoint: ExecutorEndpoint,
  code: string,
  options: ExecutorMcpCallOptions = {},
): Promise<ExecutorMcpResult> {
  return callRemoteTool(endpoint, 'execute', { code }, options);
}

export async function inspectRemoteExecutor(
  endpoint: ExecutorEndpoint,
  signal?: AbortSignal,
): Promise<ExecutorMcpInspection> {
  return withExecutorClient(endpoint, { signal }, async (client) => {
    const timeoutMs = Math.min(endpoint.requestTimeoutMs, 30_000);
    const requestOptions = {
      signal,
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
    };
    const tools: ExecutorMcpInspection['tools'] = [];
    let cursor: string | undefined;
    do {
      const response = await client.listTools(cursor ? { cursor } : undefined, requestOptions);
      tools.push(
        ...response.tools.map((tool) => ({
          name: tool.name,
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: cloneJsonObject(tool.inputSchema),
          ...(tool.outputSchema ? { outputSchema: cloneJsonObject(tool.outputSchema) } : {}),
        })),
      );
      cursor = response.nextCursor;
    } while (cursor);

    const resources: ExecutorMcpInspection['resources'] = [];
    if (client.getServerCapabilities()?.resources) {
      cursor = undefined;
      do {
        const response = await client.listResources(
          cursor ? { cursor } : undefined,
          requestOptions,
        );
        resources.push(
          ...response.resources.map((resource) => ({
            name: resource.name,
            uri: resource.uri,
            ...(resource.description ? { description: resource.description } : {}),
            ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          })),
        );
        cursor = response.nextCursor;
      } while (cursor);
    }

    return { instructions: client.getInstructions(), tools, resources };
  });
}

export function buildFindToolsCode(input: {
  query: string;
  namespace?: string;
  limit: number;
  offset: number;
}): string {
  const searchInput = {
    query: input.query,
    ...(input.namespace ? { namespace: input.namespace } : {}),
    limit: input.limit,
    offset: input.offset,
  };
  return [
    `const page = await tools.search(${JSON.stringify(searchInput)});`,
    'return {',
    '  matches: (page.items ?? []).map((item) => ({',
    '    kind: "integration",',
    '    path: item.path,',
    '    description: item.description,',
    '  })),',
    '  total: page.total ?? 0,',
    '  hasMore: page.hasMore === true,',
    '  ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),',
    '};',
  ].join('\n');
}

export function buildDescribeToolCode(path: string): string {
  const serializedPath = JSON.stringify(path);
  return [
    `const details = await tools.describe.tool({ path: ${serializedPath} });`,
    'if (details.error) return { path: details.path, error: details.error };',
    'return {',
    '  path: details.path,',
    '  description: details.description,',
    '  input: details.inputTypeScript,',
    '  output: details.outputTypeScript,',
    '  ...(details.typeScriptDefinitions',
    '    ? { definitions: details.typeScriptDefinitions }',
    '    : {}),',
    '};',
  ].join('\n');
}
