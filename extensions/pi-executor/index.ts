import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { resolveExecutorEndpoint } from './src/config';
import {
  createElicitationHandler,
  openUrlWithSystemBrowser,
  type OpenUrl,
} from './src/interaction';
import {
  buildSearchCode,
  executeRemoteCode,
  inspectRemoteExecutor,
  type ExecutorMcpCallOptions,
} from './src/mcp-client';
import type { ExecutorEndpoint, ExecutorMcpInspection, ExecutorMcpResult } from './src/types';

interface RemoteExecutorDependencies {
  resolveEndpoint: (cwd: string, projectTrusted: boolean) => Promise<ExecutorEndpoint>;
  executeCode: (
    endpoint: ExecutorEndpoint,
    code: string,
    options?: ExecutorMcpCallOptions,
  ) => Promise<ExecutorMcpResult>;
  inspect: (endpoint: ExecutorEndpoint, signal?: AbortSignal) => Promise<ExecutorMcpInspection>;
  openUrl: OpenUrl;
}

interface ExecutorToolDetails {
  endpoint: string;
  source: ExecutorEndpoint['source'];
  structuredContent: ExecutorMcpResult['structuredContent'];
}

export interface CreateRemoteExecutorExtensionOptions {
  dependencies?: Partial<RemoteExecutorDependencies>;
}

const defaults: RemoteExecutorDependencies = {
  resolveEndpoint: (cwd, projectTrusted) =>
    resolveExecutorEndpoint(cwd, { allowProjectConfig: projectTrusted }),
  executeCode: executeRemoteCode,
  inspect: inspectRemoteExecutor,
  openUrl: openUrlWithSystemBrowser,
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'Executor request cancelled';
  return error instanceof Error ? error.message : String(error);
}

function isProjectTrusted(ctx: ExtensionContext): boolean {
  return typeof ctx.isProjectTrusted === 'function' ? ctx.isProjectTrusted() : true;
}

function publicEndpoint(endpoint: ExecutorEndpoint): string {
  const url = new URL(endpoint.baseUrl);
  url.username = '';
  url.password = '';
  return url.toString().replace(/\/$/, '');
}

async function runTool(
  deps: RemoteExecutorDependencies,
  code: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) {
  const endpoint = await deps.resolveEndpoint(ctx.cwd, isProjectTrusted(ctx));
  try {
    const result = await deps.executeCode(endpoint, code, {
      signal,
      onElicitation: createElicitationHandler(ctx, deps.openUrl),
    });
    if (result.isError) throw new Error(result.text);
    return {
      content: [{ type: 'text' as const, text: result.text }],
      details: {
        endpoint: publicEndpoint(endpoint),
        source: endpoint.source,
        structuredContent: result.structuredContent,
      } satisfies ExecutorToolDetails,
    };
  } catch (error) {
    throw new Error(errorMessage(error), { cause: error });
  }
}

export function createRemoteExecutorTools(
  options: CreateRemoteExecutorExtensionOptions = {},
): ToolDefinition[] {
  const deps = { ...defaults, ...options.dependencies };

  const search = defineTool({
    name: 'search',
    label: 'Executor Search',
    description:
      "Search the remote Executor server's configured tool catalog. Use this before execute when the tool path or input shape is unknown.",
    promptSnippet: "Search the remote Executor server's configured tool catalog.",
    promptGuidelines: [
      'Use search before execute when an Executor tool path or input shape is unknown.',
      'Use short intent phrases such as github issues, repo details, or create calendar event.',
      'Set includeDetails to receive compact input/output TypeScript for each returned tool.',
    ],
    // Keep this non-strict: OpenAI strict tools require every property, while these filters are optional.
    parameters: Type.Object(
      {
        query: Type.String({
          description: 'Short natural-language capability query.',
          minLength: 1,
        }),
        namespace: Type.Optional(
          Type.String({ description: 'Optional Executor namespace to restrict the search.' }),
        ),
        limit: Type.Optional(
          Type.Integer({
            description: 'Maximum results to return. Defaults to 12.',
            minimum: 1,
            maximum: 50,
          }),
        ),
        offset: Type.Optional(
          Type.Integer({ description: 'Pagination offset. Defaults to 0.', minimum: 0 }),
        ),
        includeDetails: Type.Optional(
          Type.Boolean({ description: 'Include compact TypeScript input/output shapes.' }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return runTool(deps, buildSearchCode(params), signal, ctx);
    },
  });

  const execute = defineTool({
    name: 'execute',
    label: 'Executor',
    description:
      "Execute TypeScript in the remote Executor server's sandbox with access to configured tools, sources, secrets, policies, and interactive elicitation.",
    promptSnippet: 'Run TypeScript against remote Executor integrations.',
    promptGuidelines: [
      'Use search first when the Executor tool path or input shape is unknown.',
      'Inside Executor code, tools.search and tools.describe.tool provide sandbox-local discovery.',
      'Call tools by full namespace path, such as tools.github.getRepositoryDetails(input).',
      'Use a top-level return statement; a bare final expression returns null.',
      'Keep snippets focused and return structured JSON for later inspection.',
      'Do not use fetch; use configured Executor tools.',
    ],
    parameters: Type.Object(
      {
        code: Type.String({ description: 'TypeScript code to run in Executor.', minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return runTool(deps, params.code, signal, ctx);
    },
  });

  return [search, execute];
}

export function createRemoteExecutorExtension(
  options: CreateRemoteExecutorExtensionOptions = {},
): (pi: ExtensionAPI) => void {
  const deps = { ...defaults, ...options.dependencies };
  return (pi) => {
    for (const tool of createRemoteExecutorTools({ dependencies: deps })) pi.registerTool(tool);

    pi.registerCommand('executor', {
      description: 'Check the configured remote Executor connection',
      handler: async (_args, ctx) => {
        try {
          ctx.ui.setStatus('executor', 'executor: connecting');
          const endpoint = await deps.resolveEndpoint(ctx.cwd, isProjectTrusted(ctx));
          const inspection = await deps.inspect(endpoint);
          const toolNames = inspection.tools.map((tool) => tool.name);
          if (!toolNames.includes('execute')) {
            throw new Error('Remote MCP server does not expose the Executor execute tool');
          }
          ctx.ui.setStatus('executor', 'executor: connected');
          ctx.ui.notify(
            [
              `Executor connected: ${publicEndpoint(endpoint)}`,
              `Configuration: ${endpoint.source}${endpoint.sourcePath ? ` (${endpoint.sourcePath})` : ''}`,
              `MCP tools: ${toolNames.join(', ') || '(none)'}`,
            ].join('\n'),
            'info',
          );
        } catch (error) {
          ctx.ui.setStatus('executor', 'executor: error');
          ctx.ui.notify(errorMessage(error), 'error');
        }
      },
    });
  };
}

export default createRemoteExecutorExtension();
