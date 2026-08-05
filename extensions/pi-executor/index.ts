import { StringEnum } from '@earendil-works/pi-ai';
import {
  defineTool,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';

import { resolveExecutorEndpoint } from './src/config';
import {
  createElicitationHandler,
  openUrlWithSystemBrowser,
  type OpenUrl,
} from './src/interaction';
import { ExecutorJobManager, type ExecutorRunningJob } from './src/job-manager';
import {
  buildDescribeToolCode,
  buildFindToolsCode,
  callRemoteTool,
  executeRemoteCode,
  inspectRemoteExecutor,
  type ExecutorMcpCallOptions,
  type ExecutorMcpProgress,
} from './src/mcp-client';
import { ExecutorOutputStore } from './src/output-store';
import type {
  ExecutorEndpoint,
  ExecutorMcpInspection,
  ExecutorMcpResult,
  ExecutorMcpTool,
  JsonObject,
  JsonValue,
} from './src/types';

interface RemoteExecutorDependencies {
  resolveEndpoint: (cwd: string, projectTrusted: boolean) => Promise<ExecutorEndpoint>;
  executeCode: (
    endpoint: ExecutorEndpoint,
    code: string,
    options?: ExecutorMcpCallOptions,
  ) => Promise<ExecutorMcpResult>;
  callTool: (
    endpoint: ExecutorEndpoint,
    name: string,
    args: JsonObject,
    options?: ExecutorMcpCallOptions,
  ) => Promise<ExecutorMcpResult>;
  inspect: (endpoint: ExecutorEndpoint, signal?: AbortSignal) => Promise<ExecutorMcpInspection>;
  openUrl: OpenUrl;
}

interface ExecutorToolDetails {
  endpoint?: string;
  source?: ExecutorEndpoint['source'];
  structuredContent: JsonValue;
  outputId?: string;
  fullOutputPath?: string;
  outputPage?: JsonValue;
}

interface NativeToolSummary {
  name: string;
  remoteName: string;
  description: string;
  active: boolean;
}

interface NativeToolCatalog {
  list(): NativeToolSummary[];
  activate(names: string[]): string[];
}

export interface CreateRemoteExecutorExtensionOptions {
  dependencies?: Partial<RemoteExecutorDependencies>;
  nativeTools?: NativeToolCatalog;
  jobs?: ExecutorJobManager;
  outputs?: ExecutorOutputStore;
}

interface NativeToolAdapter {
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  executionMode?: 'parallel' | 'sequential';
}

const defaults: RemoteExecutorDependencies = {
  resolveEndpoint: (cwd, projectTrusted) =>
    resolveExecutorEndpoint(cwd, { allowProjectConfig: projectTrusted }),
  executeCode: executeRemoteCode,
  callTool: callRemoteTool,
  inspect: inspectRemoteExecutor,
  openUrl: openUrlWithSystemBrowser,
};

const connectionBindings = Type.Record(Type.String(), Type.String(), {
  description: 'Map each integration role to an Executor connection address.',
});

const nativeToolAdapters: Record<string, NativeToolAdapter> = {
  'create-artifact': {
    name: 'executor_create_artifact',
    label: 'Executor: Create Artifact',
    description:
      'Create a saved Executor React MCP app, or fully rewrite one by artifact ID. Fetch the create-artifact and artifact-style guides before use. Prefer executor_edit_artifact for small changes.',
    parameters: Type.Object(
      {
        code: Type.String({ description: 'React source that exports App.', minLength: 1 }),
        artifactId: Type.Optional(
          Type.String({ description: 'Existing artifact ID for a full rewrite.', minLength: 1 }),
        ),
        connections: Type.Optional(connectionBindings),
        title: Type.Optional(
          Type.String({ description: 'Display title. Required for a new artifact.', minLength: 1 }),
        ),
        description: Type.Optional(Type.String({ description: 'One-sentence summary.' })),
      },
      { additionalProperties: false },
    ),
    executionMode: 'sequential',
  },
  'edit-artifact': {
    name: 'executor_edit_artifact',
    label: 'Executor: Edit Artifact',
    description:
      'Patch a saved Executor artifact with atomic exact-text replacements. Use this for focused changes and executor_create_artifact only for a full rewrite.',
    parameters: Type.Object(
      {
        artifactId: Type.String({ description: 'Artifact ID to edit.', minLength: 1 }),
        edits: Type.Array(
          Type.Object(
            {
              oldText: Type.String({ description: 'Exact source text to replace.', minLength: 1 }),
              newText: Type.String({ description: 'Replacement text.' }),
              replaceAll: Type.Optional(Type.Boolean({ description: 'Replace every match.' })),
            },
            { additionalProperties: false },
          ),
          { description: 'Ordered atomic replacements.', minItems: 1 },
        ),
        connections: Type.Optional(connectionBindings),
        title: Type.Optional(Type.String({ description: 'New title.', minLength: 1 })),
        description: Type.Optional(Type.String({ description: 'New summary.' })),
      },
      { additionalProperties: false },
    ),
    executionMode: 'sequential',
  },
  'list-artifacts': {
    name: 'executor_list_artifacts',
    label: 'Executor: List Artifacts',
    description: 'List saved Executor UI artifacts, newest first. Source code is not returned.',
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: 'parallel',
  },
  'show-artifact': {
    name: 'executor_show_artifact',
    label: 'Executor: Show Artifact',
    description:
      'Render or open one saved Executor UI artifact by ID. Use executor_list_artifacts when the ID is unknown.',
    parameters: Type.Object(
      { id: Type.String({ description: 'Artifact ID.', minLength: 1 }) },
      { additionalProperties: false },
    ),
    executionMode: 'parallel',
  },
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'Executor request cancelled';
  return error instanceof Error ? error.message : String(error);
}

function isProjectTrusted(ctx: ExtensionContext): boolean {
  return typeof ctx.isProjectTrusted === 'function' ? ctx.isProjectTrusted() : true;
}

function publicEndpoint(endpoint: ExecutorEndpoint): string {
  const url = new URL(endpoint.mcpUrl);
  url.username = '';
  url.password = '';
  for (const key of url.searchParams.keys()) {
    if (/token|secret|password|api[_-]?key/i.test(key)) url.searchParams.set(key, '[REDACTED]');
  }
  return url.toString().replace(/\/$/, '');
}

function endpointStatus(endpoint: ExecutorEndpoint): string {
  const target = endpoint.profileName ?? endpoint.source;
  return `executor[${target}]: ${publicEndpoint(endpoint)}`;
}

function executorCallOptions(
  deps: RemoteExecutorDependencies,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
  timeoutMs?: number,
  onProgress?: (progress: ExecutorMcpProgress) => void,
): ExecutorMcpCallOptions {
  return {
    signal,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(onProgress ? { onProgress } : {}),
    onElicitation: createElicitationHandler(ctx, deps.openUrl),
  };
}

function executorFailureMessage(result: ExecutorMcpResult): string {
  const details = asObject(result.structuredContent);
  const code = details?.code;
  const message =
    typeof code === 'string' && !result.text.includes(code)
      ? `${result.text}\n\nCurrent artifact source:\n${code}`
      : result.text;
  const truncation = truncateHead(message, {
    maxLines: 300,
    maxBytes: 12 * 1024,
  });
  return truncation.truncated
    ? `${truncation.content}\n\n[Executor error details truncated.]`
    : truncation.content;
}

async function requestExecutorCode(
  deps: RemoteExecutorDependencies,
  code: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<{ endpoint: ExecutorEndpoint; result: ExecutorMcpResult }> {
  try {
    const endpoint = await deps.resolveEndpoint(ctx.cwd, isProjectTrusted(ctx));
    const result = await deps.executeCode(
      endpoint,
      code,
      executorCallOptions(deps, signal, ctx, Math.min(endpoint.requestTimeoutMs, 30_000)),
    );
    if (result.isError) throw new Error(executorFailureMessage(result));
    return { endpoint, result };
  } catch (error) {
    throw new Error(errorMessage(error), { cause: error });
  }
}

async function requestExecutorTool(
  deps: RemoteExecutorDependencies,
  name: string,
  args: JsonObject,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<{ endpoint: ExecutorEndpoint; result: ExecutorMcpResult }> {
  try {
    const endpoint = await deps.resolveEndpoint(ctx.cwd, isProjectTrusted(ctx));
    const result = await deps.callTool(
      endpoint,
      name,
      args,
      executorCallOptions(deps, signal, ctx, Math.min(endpoint.requestTimeoutMs, 30_000)),
    );
    if (result.isError) throw new Error(executorFailureMessage(result));
    return { endpoint, result };
  } catch (error) {
    throw new Error(errorMessage(error), { cause: error });
  }
}

async function formatToolResult(
  outputs: ExecutorOutputStore,
  text: string,
  structuredContent: JsonValue,
  endpoint?: ExecutorEndpoint,
  detailsStructuredContent: JsonValue = structuredContent,
) {
  const prepared = await outputs.prepare(text, {
    maxBytes: endpoint?.maxOutputBytes ?? 12 * 1024,
    maxLines: endpoint?.maxOutputLines ?? 300,
  });
  const details: ExecutorToolDetails = {
    ...(endpoint ? { endpoint: publicEndpoint(endpoint), source: endpoint.source } : {}),
    structuredContent: sanitizeJsonForModel(detailsStructuredContent),
    ...(prepared.outputId ? { outputId: prepared.outputId } : {}),
    ...(prepared.fullOutputPath ? { fullOutputPath: prepared.fullOutputPath } : {}),
    ...(prepared.page ? { outputPage: prepared.page as unknown as JsonValue } : {}),
  };
  return {
    content: [{ type: 'text' as const, text: prepared.text }],
    details,
  };
}

function asObject(value: JsonValue): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function executorReturnedValue(result: ExecutorMcpResult): JsonValue {
  const envelope = asObject(result.structuredContent);
  if (envelope && 'result' in envelope) return envelope.result ?? null;
  try {
    return JSON.parse(result.text) as JsonValue;
  } catch {
    return result.text;
  }
}

const SENSITIVE_OUTPUT_KEY =
  /^(?:authorization|proxy-authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|x-api-key|client[_-]?secret|private[_-]?key|password|passwd|secret|cookie|set-cookie)$/i;

function sanitizeJsonForModel(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonForModel(item));
  const object = asObject(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object).map(([key, child]) => [
      key,
      SENSITIVE_OUTPUT_KEY.test(key) ? '[REDACTED]' : sanitizeJsonForModel(child),
    ]),
  );
}

function jsonText(value: JsonValue): string {
  return JSON.stringify(sanitizeJsonForModel(value));
}

type ExecutorPiToolResult = Awaited<ReturnType<typeof formatToolResult>>;

async function yieldingToolResult(
  jobs: ExecutorJobManager,
  outputs: ExecutorOutputStore,
  endpoint: ExecutorEndpoint,
  label: string,
  yieldMs: number | undefined,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<ExecutorPiToolResult>,
): Promise<ExecutorPiToolResult> {
  const outcome = await jobs.run(label, yieldMs ?? endpoint.yieldAfterMs, signal, operation);
  if (outcome.status === 'completed') return outcome.value;
  if (outcome.status === 'failed') {
    throw new Error(errorMessage(outcome.error), { cause: outcome.error });
  }
  const running = runningJobValue(outcome);
  return formatToolResult(outputs, jsonText(running), running, endpoint);
}

function progressText(label: string, progress: ExecutorMcpProgress): string {
  const amount = progress.total
    ? `${progress.progress}/${progress.total}`
    : String(progress.progress);
  return `${label}: ${progress.message ?? amount}`;
}

function runningJobValue(job: ExecutorRunningJob): JsonObject {
  return {
    status: job.status,
    jobId: job.jobId,
    label: job.label,
    elapsedMs: job.elapsedMs,
    pollAfterMs: job.pollAfterMs,
  };
}

function normalizeProxyName(remoteName: string): string {
  const normalized = remoteName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return `executor_${normalized || 'tool'}`;
}

function compactDescription(description: string | undefined): string {
  if (!description) return 'Call this native Executor MCP capability.';
  const firstParagraph =
    description
      .split(/\n\s*\n/)[0]
      ?.replace(/\s+/g, ' ')
      .trim() ?? '';
  return firstParagraph.length <= 320
    ? firstParagraph
    : `${firstParagraph.slice(0, 317).trimEnd()}...`;
}

function compactJsonSchema(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => compactJsonSchema(item));
  const object = asObject(value);
  if (!object) return value;
  const compacted: JsonObject = {};
  for (const [childKey, childValue] of Object.entries(object)) {
    if (childKey === '$schema') continue;
    if (childKey === 'description' && typeof childValue === 'string') {
      compacted[childKey] = compactDescription(childValue);
      continue;
    }
    compacted[childKey] = compactJsonSchema(childValue);
  }
  return compacted;
}

function proxyToolParameters(tool: ExecutorMcpTool): TSchema {
  const adapter = nativeToolAdapters[tool.name];
  if (adapter) return adapter.parameters;
  return compactJsonSchema(structuredClone(tool.inputSchema)) as TSchema;
}

function nativeMatchScore(tool: NativeToolSummary, query: string): number {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const name = `${tool.name} ${tool.remoteName}`.toLowerCase();
  const description = tool.description.toLowerCase();
  return terms.reduce((score, term) => {
    if (name.includes(term)) return score + 4;
    if (description.includes(term)) return score + 1;
    return score;
  }, 0);
}

const nativeToolNameReplacements: Record<string, string> = {
  'create-artifact': 'executor_create_artifact',
  'edit-artifact': 'executor_edit_artifact',
  'list-artifacts': 'executor_list_artifacts',
  'show-artifact': 'executor_show_artifact',
};

function adaptNativeToolReferences(text: string): string {
  return Object.entries(nativeToolNameReplacements).reduce(
    (adapted, [remoteName, localName]) => adapted.replaceAll(remoteName, localName),
    text,
  );
}

function artifactTitleFromText(text: string): string | undefined {
  return text.match(/(?:Rendered|Saved) "([^"]+)"/)?.[1];
}

function artifactDisplay(structured: JsonObject): JsonValue {
  if (structured.status === 'fallback_url') return 'link';
  if (structured.status === 'fallback_unavailable') return 'unavailable';
  return 'app';
}

function adaptNativeToolOutput(
  remoteName: string,
  args: JsonObject,
  result: ExecutorMcpResult,
): { text: string; structuredContent: JsonValue } {
  const structured = asObject(result.structuredContent);
  if (remoteName === 'list-artifacts' && Array.isArray(structured?.artifacts)) {
    const value: JsonValue = { artifacts: structured.artifacts };
    return { text: jsonText(value), structuredContent: value };
  }

  const artifactId = structured?.artifactId;
  if (
    structured &&
    typeof artifactId === 'string' &&
    (remoteName === 'create-artifact' ||
      remoteName === 'edit-artifact' ||
      remoteName === 'show-artifact')
  ) {
    const title = typeof args.title === 'string' ? args.title : artifactTitleFromText(result.text);
    const url = typeof structured.url === 'string' ? structured.url : undefined;
    const base: JsonObject = {
      id: artifactId,
      ...(title ? { title } : {}),
      ...(url ? { url } : {}),
      display: artifactDisplay(structured),
    };
    if (remoteName === 'create-artifact') {
      base.operation = typeof args.artifactId === 'string' ? 'rewritten' : 'created';
    } else if (remoteName === 'edit-artifact') {
      base.operation = 'edited';
      base.editsApplied = Array.isArray(args.edits) ? args.edits.length : 0;
    }
    return { text: jsonText(base), structuredContent: base };
  }

  return {
    text: adaptNativeToolReferences(result.text),
    structuredContent: result.structuredContent,
  };
}

function adaptGuideContent(text: string): string {
  let adapted = text
    .replace(/skills\(\{\s*name:/g, 'executor_get_guide({ guide:')
    .replaceAll('`skills`', '`executor_get_guide`')
    .replaceAll('`execute`', '`executor_execute`');
  for (const [remoteName, localName] of Object.entries(nativeToolNameReplacements)) {
    adapted = adapted
      .replaceAll(`\`${remoteName}\``, `\`${localName}\``)
      .replaceAll(`${remoteName} tool`, `${localName} tool`);
  }
  return adapted;
}

function parseGuideList(text: string): JsonValue {
  const guides: JsonValue[] = [];
  for (const match of text.matchAll(/^- `([^`]+)`\s+[—-]\s+(.+)$/gm)) {
    guides.push({
      guide: match[1] ?? '',
      description: adaptNativeToolReferences(match[2] ?? '').replace(
        /\bexecute\b/g,
        'executor_execute',
      ),
    });
  }
  return { guides };
}

export function createRemoteMcpProxyTool(
  remoteTool: ExecutorMcpTool,
  options: CreateRemoteExecutorExtensionOptions = {},
  localName = nativeToolAdapters[remoteTool.name]?.name ?? normalizeProxyName(remoteTool.name),
): ToolDefinition {
  const deps = { ...defaults, ...options.dependencies };
  const jobs = options.jobs ?? new ExecutorJobManager();
  const outputs = options.outputs ?? new ExecutorOutputStore();
  const adapter = nativeToolAdapters[remoteTool.name];
  const description =
    adapter?.description ??
    `Call Executor's ${JSON.stringify(remoteTool.name)} MCP capability. ${compactDescription(remoteTool.description)}`;
  return defineTool({
    name: localName,
    label: adapter?.label ?? `Executor: ${remoteTool.title ?? remoteTool.name}`,
    description,
    parameters: proxyToolParameters(remoteTool),
    ...(adapter?.executionMode ? { executionMode: adapter.executionMode } : {}),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const endpoint = await deps.resolveEndpoint(ctx.cwd, isProjectTrusted(ctx));
      let acceptingProgress = true;
      try {
        return await yieldingToolResult(
          jobs,
          outputs,
          endpoint,
          localName,
          undefined,
          signal,
          async (jobSignal) => {
            const result = await deps.callTool(
              endpoint,
              remoteTool.name,
              params as JsonObject,
              executorCallOptions(deps, jobSignal, ctx, endpoint.requestTimeoutMs, (progress) => {
                if (!acceptingProgress) return;
                onUpdate?.({
                  content: [{ type: 'text', text: progressText(localName, progress) }],
                  details: { structuredContent: null },
                });
              }),
            );
            if (result.isError) throw new Error(executorFailureMessage(result));
            const adapted = adaptNativeToolOutput(remoteTool.name, params as JsonObject, result);
            return formatToolResult(
              outputs,
              adapted.text,
              adapted.structuredContent,
              endpoint,
              result.structuredContent,
            );
          },
        );
      } finally {
        acceptingProgress = false;
      }
    },
  });
}

export function createRemoteExecutorTools(
  options: CreateRemoteExecutorExtensionOptions = {},
): ToolDefinition[] {
  const deps = { ...defaults, ...options.dependencies };
  const jobs = options.jobs ?? new ExecutorJobManager();
  const outputs = options.outputs ?? new ExecutorOutputStore();

  const findTools = defineTool({
    name: 'executor_find_tools',
    label: 'Executor: Find Tools',
    description:
      'Find native Executor capabilities and connected integration tools. Native matches are activated for the next Pi model call. Results are concise; use executor_describe_tool for one integration schema.',
    promptSnippet: 'Find and activate Executor capabilities or connected integration tools.',
    promptGuidelines: [
      'Use executor_find_tools when the required native Executor capability or integration path is unknown.',
      'Use short capability phrases and keep the default result limit unless more results are required.',
    ],
    parameters: Type.Object(
      {
        query: Type.String({ description: 'Short capability query.', minLength: 1 }),
        scope: Type.Optional(
          StringEnum(['all', 'native', 'integration'] as const, {
            description: 'Search scope. Defaults to all.',
          }),
        ),
        namespace: Type.Optional(
          Type.String({ description: 'Optional integration namespace filter.' }),
        ),
        limit: Type.Optional(
          Type.Integer({
            description: 'Results per page. Defaults to 20.',
            minimum: 1,
            maximum: 50,
          }),
        ),
        offset: Type.Optional(Type.Integer({ description: 'Pagination offset.', minimum: 0 })),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const scope = params.scope ?? 'all';
      const limit = params.limit ?? 20;
      const offset = params.offset ?? 0;
      const nativeMatches =
        scope === 'integration'
          ? []
          : (options.nativeTools?.list() ?? [])
              .map((tool) => ({ tool, score: nativeMatchScore(tool, params.query) }))
              .filter((match) => match.score > 0)
              .sort(
                (left, right) =>
                  right.score - left.score || left.tool.name.localeCompare(right.tool.name),
              )
              .map((match) => match.tool);

      const nativeOffset =
        scope === 'native' || scope === 'all' ? Math.min(offset, nativeMatches.length) : 0;
      const selectedNative = nativeMatches.slice(nativeOffset, nativeOffset + limit);
      const remaining = limit - selectedNative.length;
      const remoteOffset = scope === 'all' ? Math.max(0, offset - nativeMatches.length) : offset;
      let endpoint: ExecutorEndpoint | undefined;
      let remoteMatches: JsonObject[] = [];
      let remoteTotal = 0;

      if (scope !== 'native') {
        const remoteLimit = Math.max(1, remaining);
        const response = await requestExecutorCode(
          deps,
          buildFindToolsCode({
            query: params.query,
            namespace: params.namespace,
            limit: remoteLimit,
            offset: remoteOffset,
          }),
          signal,
          ctx,
        );
        endpoint = response.endpoint;
        const page = asObject(executorReturnedValue(response.result));
        const matches = page?.matches;
        remoteMatches = Array.isArray(matches)
          ? matches
              .map(asObject)
              .filter((match): match is JsonObject => Boolean(match))
              .slice(0, remaining)
          : [];
        remoteTotal = typeof page?.total === 'number' ? page.total : remoteMatches.length;
      }

      const activated =
        options.nativeTools?.activate(selectedNative.map((tool) => tool.name)) ?? [];
      const activeTools = new Map(
        (options.nativeTools?.list() ?? []).map((tool) => [tool.name, tool.active]),
      );
      const matches: JsonValue[] = [
        ...selectedNative.map((tool) => ({
          kind: 'native',
          name: tool.name,
          description: tool.description,
          active: activeTools.get(tool.name) ?? tool.active,
        })),
        ...remoteMatches,
      ];
      const total = (scope === 'integration' ? 0 : nativeMatches.length) + remoteTotal;
      const nextOffset = offset + matches.length;
      const output: JsonValue = {
        matches,
        activated,
        total,
        hasMore: nextOffset < total,
        ...(nextOffset < total ? { nextOffset } : {}),
      };
      return formatToolResult(outputs, jsonText(output), output, endpoint);
    },
  });

  const describeTool = defineTool({
    name: 'executor_describe_tool',
    label: 'Executor: Describe Tool',
    description:
      'Get the compact TypeScript input and output contract for one connected integration tool path returned by executor_find_tools.',
    parameters: Type.Object(
      { path: Type.String({ description: 'Exact integration tool path.', minLength: 1 }) },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { endpoint, result } = await requestExecutorCode(
        deps,
        buildDescribeToolCode(params.path),
        signal,
        ctx,
      );
      const output = executorReturnedValue(result);
      return formatToolResult(
        outputs,
        jsonText(output),
        output,
        endpoint,
        result.structuredContent,
      );
    },
  });

  const execute = defineTool({
    name: 'executor_execute',
    label: 'Executor: Execute',
    description:
      'Run focused TypeScript in Executor to call connected integrations. Use exact paths from executor_find_tools, inspect one with executor_describe_tool, and return only fields needed by the task.',
    promptSnippet: 'Run focused TypeScript against connected Executor integrations.',
    promptGuidelines: [
      'Before the first complex executor_execute call, use executor_get_guide with guide execute.',
      'Inside executor_execute code, call tools by the exact full path returned by executor_find_tools.',
      'Keep executor_execute snippets focused, filter large collections in the sandbox, and return only required fields.',
      'Do not use fetch inside executor_execute; use configured tools.* calls.',
      'If executor_execute returns a running job, use executor_get_job instead of restarting the code.',
    ],
    parameters: Type.Object(
      {
        code: Type.String({
          description: 'TypeScript code with a top-level return.',
          minLength: 1,
        }),
        yieldMs: Type.Optional(
          Type.Integer({
            description:
              'Return a bridge job ID if execution still runs after this delay. Uses the configured default when omitted.',
            minimum: 0,
            maximum: 30_000,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const endpoint = await deps.resolveEndpoint(ctx.cwd, isProjectTrusted(ctx));
      let acceptingProgress = true;
      try {
        return await yieldingToolResult(
          jobs,
          outputs,
          endpoint,
          'executor_execute',
          params.yieldMs,
          signal,
          async (jobSignal) => {
            const result = await deps.executeCode(
              endpoint,
              params.code,
              executorCallOptions(deps, jobSignal, ctx, endpoint.requestTimeoutMs, (progress) => {
                if (!acceptingProgress) return;
                onUpdate?.({
                  content: [{ type: 'text', text: progressText('executor_execute', progress) }],
                  details: { structuredContent: null },
                });
              }),
            );
            if (result.isError) throw new Error(executorFailureMessage(result));
            const output = executorReturnedValue(result);
            const text = typeof output === 'string' ? output : jsonText(output);
            return formatToolResult(outputs, text, output, endpoint, result.structuredContent);
          },
        );
      } finally {
        acceptingProgress = false;
      }
    },
  });

  const listGuides = defineTool({
    name: 'executor_list_guides',
    label: 'Executor: List Guides',
    description: 'List the exact IDs and summaries of available Executor procedural guides.',
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const { endpoint, result } = await requestExecutorTool(deps, 'skills', {}, signal, ctx);
      const output = parseGuideList(result.text);
      return formatToolResult(outputs, jsonText(output), output, endpoint);
    },
  });

  const getGuide = defineTool({
    name: 'executor_get_guide',
    label: 'Executor: Get Guide',
    description:
      'Fetch one Executor procedural guide by exact guide ID from executor_list_guides. Guide IDs are not Pi tool names or integration paths.',
    parameters: Type.Object(
      { guide: Type.String({ description: 'Exact guide ID.', minLength: 1 }) },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { endpoint, result } = await requestExecutorTool(
        deps,
        'skills',
        { name: params.guide },
        signal,
        ctx,
      );
      const content = adaptGuideContent(result.text);
      return formatToolResult(outputs, content, { guide: params.guide, content }, endpoint);
    },
  });

  const getJob = defineTool({
    name: 'executor_get_job',
    label: 'Executor: Get Job',
    description:
      'Wait briefly for a yielded Executor job and return its final result when ready. A running response can be checked again with the same job ID.',
    parameters: Type.Object(
      {
        jobId: Type.String({
          description: 'Session-local bridge job ID returned by executor_execute.',
          minLength: 1,
        }),
        yieldMs: Type.Optional(
          Type.Integer({
            description: 'Wait this long for the same execution. Defaults to 5000 ms.',
            minimum: 0,
            maximum: 30_000,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params) {
      const outcome = await jobs.poll<ExecutorPiToolResult>(params.jobId, params.yieldMs ?? 5_000);
      if (!outcome) throw new Error(`Unknown or expired Executor job: ${params.jobId}`);
      if (outcome.status === 'completed') return outcome.value;
      if (outcome.status === 'failed') {
        throw new Error(errorMessage(outcome.error), { cause: outcome.error });
      }
      const running = runningJobValue(outcome);
      return formatToolResult(outputs, jsonText(running), running);
    },
  });

  const cancelJob = defineTool({
    name: 'executor_cancel_job',
    label: 'Executor: Cancel Job',
    description: 'Cancel one yielded session-local Executor bridge job by ID.',
    parameters: Type.Object(
      { jobId: Type.String({ description: 'Session-local bridge job ID.', minLength: 1 }) },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params) {
      const cancelled = jobs.cancel(params.jobId);
      const output: JsonValue = { jobId: params.jobId, cancelled };
      return formatToolResult(outputs, jsonText(output), output);
    },
  });

  const readOutput = defineTool({
    name: 'executor_read_output',
    label: 'Executor: Read Output',
    description:
      'Read a bounded page from a truncated Executor result. Use the output ID and next offset from the truncation notice.',
    parameters: Type.Object(
      {
        outputId: Type.String({ description: 'Truncated output ID.', minLength: 1 }),
        offset: Type.Optional(
          Type.Integer({ description: 'Byte offset. Use the returned nextOffset.', minimum: 0 }),
        ),
        limit: Type.Optional(
          Type.Integer({
            description: 'Maximum bytes. Defaults to 8000.',
            minimum: 1,
            maximum: 12_000,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params) {
      const page = await outputs.read(params.outputId, params.offset ?? 0, params.limit ?? 8_000);
      if (!page) throw new Error(`Unknown or expired Executor output: ${params.outputId}`);
      const metadata: JsonValue = {
        outputId: page.outputId,
        offset: page.offset,
        ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
        totalBytes: page.totalBytes,
        hasMore: page.hasMore,
      };
      const notice = page.hasMore
        ? `[Output page. nextOffset=${page.nextOffset}; totalBytes=${page.totalBytes}.]`
        : `[End of output. totalBytes=${page.totalBytes}.]`;
      return {
        content: [{ type: 'text', text: `${page.content}\n\n${notice}` }],
        details: { structuredContent: metadata },
      };
    },
  });

  return [findTools, describeTool, execute, listGuides, getGuide, getJob, cancelJob, readOutput];
}

export function createRemoteExecutorExtension(
  options: CreateRemoteExecutorExtensionOptions = {},
): (pi: ExtensionAPI) => void {
  const deps = { ...defaults, ...options.dependencies };
  return (pi) => {
    const jobs = options.jobs ?? new ExecutorJobManager();
    const outputs = options.outputs ?? new ExecutorOutputStore();
    const nativeProxies = new Map<string, { remoteName: string; tool: ToolDefinition }>();
    const nativeCatalog: NativeToolCatalog = {
      list: () => {
        const active = new Set(pi.getActiveTools());
        return [...nativeProxies.values()].map(({ remoteName, tool }) => ({
          name: tool.name,
          remoteName,
          description: tool.description,
          active: active.has(tool.name),
        }));
      },
      activate: (names) => {
        const current = new Set(pi.getActiveTools());
        const requested = names.filter((name) => nativeProxies.has(name) && !current.has(name));
        if (requested.length > 0) pi.setActiveTools([...current, ...requested]);
        const active = new Set(pi.getActiveTools());
        return requested.filter((name) => active.has(name));
      },
    };

    for (const tool of createRemoteExecutorTools({
      dependencies: deps,
      nativeTools: nativeCatalog,
      jobs,
      outputs,
    })) {
      pi.registerTool(tool);
    }

    const refreshRemoteTools = async (ctx: ExtensionContext, signal?: AbortSignal) => {
      const endpoint = await deps.resolveEndpoint(ctx.cwd, isProjectTrusted(ctx));
      const inspection = await deps.inspect(endpoint, signal);
      const remoteToolNames = new Set(inspection.tools.map((tool) => tool.name));
      if (!remoteToolNames.has('execute') || !remoteToolNames.has('skills')) {
        throw new Error('Remote MCP server must expose the execute and skills tools');
      }

      const existingNames = new Set(pi.getAllTools().map((tool) => tool.name));
      const newlyRegistered: string[] = [];
      for (const remoteTool of inspection.tools) {
        if (remoteTool.name === 'execute' || remoteTool.name === 'skills') continue;
        const localName =
          nativeToolAdapters[remoteTool.name]?.name ?? normalizeProxyName(remoteTool.name);
        const previous = nativeProxies.get(localName);
        if (!previous && existingNames.has(localName)) {
          throw new Error(`Executor Pi tool name collision: ${localName}`);
        }
        const tool = createRemoteMcpProxyTool(
          remoteTool,
          { dependencies: deps, jobs, outputs },
          localName,
        );
        pi.registerTool(tool);
        nativeProxies.set(localName, { remoteName: remoteTool.name, tool });
        existingNames.add(localName);
        if (!previous) newlyRegistered.push(localName);
      }

      if (newlyRegistered.length > 0) {
        const deferred = new Set(newlyRegistered);
        pi.setActiveTools(pi.getActiveTools().filter((name) => !deferred.has(name)));
      }
      return { endpoint, inspection };
    };

    pi.on('session_start', async (_event, ctx) => {
      try {
        const { endpoint } = await refreshRemoteTools(ctx, ctx.signal);
        ctx.ui.setStatus('executor', endpointStatus(endpoint));
      } catch {
        ctx.ui.setStatus('executor', 'executor: error');
      }
    });

    pi.on('session_shutdown', async () => {
      jobs.cancelAll();
      await outputs.clear();
    });
    pi.registerCommand('executor', {
      description: 'Refresh and inspect the configured remote Executor connection',
      handler: async (_args, ctx) => {
        try {
          ctx.ui.setStatus('executor', 'executor: connecting');
          const { endpoint, inspection } = await refreshRemoteTools(ctx, ctx.signal);
          const proxyMappings = [
            'execute -> executor_execute',
            'skills -> executor_list_guides, executor_get_guide',
            ...nativeCatalog.list().map((tool) => `${tool.remoteName} -> ${tool.name}`),
          ];
          ctx.ui.setStatus('executor', endpointStatus(endpoint));
          ctx.ui.notify(
            [
              `Executor connected: ${publicEndpoint(endpoint)}`,
              `Configuration: ${endpoint.source}${endpoint.profileName ? ` (${endpoint.profileName})` : ''}${endpoint.sourcePath ? ` from ${endpoint.sourcePath}` : ''}`,
              `Limits: yield ${endpoint.yieldAfterMs}ms; hard timeout ${endpoint.requestTimeoutMs}ms; output ${endpoint.maxOutputBytes} bytes/${endpoint.maxOutputLines} lines`,
              `MCP tools: ${inspection.tools.map((tool) => tool.name).join(', ') || '(none)'}`,
              `Pi tools: ${proxyMappings.join('; ')}`,
              `MCP resources: ${inspection.resources.map((resource) => resource.uri).join(', ') || '(none)'}`,
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
