import { StringEnum } from '@earendil-works/pi-ai';
import {
  defineTool,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';

import {
  DEFERRED_TOOL_SEARCH_PROVIDER_EVENT,
  DEFERRED_TOOLS_PROTOCOL_VERSION,
  type DeferredToolSearchProviderRequest,
} from '../shared/deferred-tools-protocol';
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
import { createExecutorRenderer } from './src/rendering';
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
  activateTools?: (names: string[]) => string[];
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

const SEARCH_KINDS = ['bridge', 'sandbox', 'native', 'integration'] as const;
type SearchKind = (typeof SEARCH_KINDS)[number];
type SearchState = 'loadable' | 'loaded';

interface SearchCatalogItem {
  path: string;
  kind: SearchKind;
  summary: string;
  state?: SearchState;
}

const BRIDGE_SEARCH_ITEMS: readonly SearchCatalogItem[] = [
  {
    path: 'executor_search_tools',
    kind: 'bridge',
    summary: 'Search bridge, sandbox, native, and integration capabilities.',
  },
  {
    path: 'executor_describe_tool',
    kind: 'bridge',
    summary: "Get one integration tool's compact input and success-data contract.",
  },
  {
    path: 'executor_execute',
    kind: 'bridge',
    summary: 'Run focused TypeScript against connected integrations.',
  },
  {
    path: 'executor_list_guides',
    kind: 'bridge',
    summary: 'List available Executor procedural guides.',
  },
  {
    path: 'executor_get_guide',
    kind: 'bridge',
    summary: 'Fetch one Executor guide by exact ID.',
  },
  {
    path: 'executor_get_job',
    kind: 'bridge',
    summary: 'Wait for a yielded Executor operation.',
  },
  {
    path: 'executor_cancel_job',
    kind: 'bridge',
    summary: 'Cancel a yielded Executor operation.',
  },
  {
    path: 'executor_read_output',
    kind: 'bridge',
    summary: 'Read a bounded page from a truncated Executor result.',
  },
];

const SANDBOX_SEARCH_ITEMS: readonly SearchCatalogItem[] = [
  {
    path: 'tools.search',
    kind: 'sandbox',
    summary: 'Search integration tools from inside executor_execute.',
  },
  {
    path: 'tools.describe.tool',
    kind: 'sandbox',
    summary: 'Describe an integration tool from inside executor_execute.',
  },
  {
    path: 'tools.executor.integrations.list',
    kind: 'sandbox',
    summary: 'List configured Executor integrations from inside executor_execute.',
  },
  {
    path: 'emit',
    kind: 'sandbox',
    summary: 'Append user-visible output from inside executor_execute.',
  },
];

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

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function asUnknownObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
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

function activateExecutorResultTools(
  result: ExecutorPiToolResult,
  activateTools?: (names: string[]) => string[],
): ExecutorPiToolResult {
  const details = result.details as ExecutorToolDetails | undefined;
  const structured = asObject(details?.structuredContent);
  const names: string[] = [];
  if (structured?.state === 'running' && typeof structured.jobId === 'string') {
    names.push('executor_get_job', 'executor_cancel_job');
  }
  if (details?.outputId) names.push('executor_read_output');
  if (names.length > 0) activateTools?.(names);
  return result;
}

async function yieldingToolResult(
  jobs: ExecutorJobManager,
  outputs: ExecutorOutputStore,
  endpoint: ExecutorEndpoint,
  yieldMs: number | undefined,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<ExecutorPiToolResult>,
  activateTools?: (names: string[]) => string[],
): Promise<ExecutorPiToolResult> {
  const outcome = await jobs.run(yieldMs ?? endpoint.yieldAfterMs, signal, operation);
  if (outcome.status === 'failed') {
    throw new Error(errorMessage(outcome.error), { cause: outcome.error });
  }
  if (outcome.status === 'completed') {
    return activateExecutorResultTools(outcome.value, activateTools);
  }
  const running = runningJobValue(outcome);
  const result = await formatToolResult(outputs, jsonText(running), running, endpoint);
  return activateExecutorResultTools(result, activateTools);
}

function progressText(label: string, progress: ExecutorMcpProgress): string {
  const amount = progress.total
    ? `${progress.progress}/${progress.total}`
    : String(progress.progress);
  return `${label}: ${progress.message ?? amount}`;
}

function runningJobValue(job: ExecutorRunningJob): JsonObject {
  return {
    state: job.status,
    jobId: job.jobId,
    retryAfterMs: job.pollAfterMs,
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

function compactSearchSummary(summary: unknown): string | undefined {
  if (typeof summary !== 'string') return undefined;
  const compact = summary.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return undefined;
  return compact.length <= 160 ? compact : `${compact.slice(0, 157).trimEnd()}...`;
}

function searchMatchScore(
  item: Pick<SearchCatalogItem, 'path' | 'summary'>,
  query: string,
): number {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const path = item.path.toLowerCase();
  const summary = item.summary.toLowerCase();
  return terms.reduce((score, term) => {
    if (path.includes(term)) return score + 4;
    if (summary.includes(term)) return score + 1;
    return score;
  }, 0);
}

interface SearchCursor {
  localOffset: number;
  remoteOffset: number;
  remoteExhausted: boolean;
}

function decodeSearchCursor(cursor: string | undefined): SearchCursor {
  if (cursor === undefined) {
    return { localOffset: 0, remoteOffset: 0, remoteExhausted: false };
  }
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.([01])$/.exec(cursor);
  const localOffset = Number(match?.[1]);
  const remoteOffset = Number(match?.[2]);
  if (!Number.isSafeInteger(localOffset) || !Number.isSafeInteger(remoteOffset)) {
    throw new Error('Invalid Executor search cursor; restart the search without a cursor');
  }
  return { localOffset, remoteOffset, remoteExhausted: match?.[3] === '1' };
}

function encodeSearchCursor(cursor: SearchCursor): string {
  return `${cursor.localOffset}.${cursor.remoteOffset}.${cursor.remoteExhausted ? 1 : 0}`;
}

function normalizeTypeScript(typeScript: string): string {
  // Executor 1.5.x can generate adjacent duplicate null members for optional nullable fields.
  return typeScript.replace(/(\|\s*null)(?:\s*\|\s*null)+/g, '$1');
}

function splitTopLevelTypeUnion(typeScript: string): string[] {
  const arms: string[] = [];
  let start = 0;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;
  for (let index = 0; index < typeScript.length; index += 1) {
    const character = typeScript[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') braces += 1;
    else if (character === '}') braces -= 1;
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    else if (character === '(') parentheses += 1;
    else if (character === ')') parentheses -= 1;
    else if (character === '|' && braces === 0 && brackets === 0 && parentheses === 0) {
      arms.push(typeScript.slice(start, index).trim());
      start = index + 1;
    }
  }
  arms.push(typeScript.slice(start).trim());
  return arms;
}

function successDataTypeScript(outputTypeScript: string): string {
  const normalized = normalizeTypeScript(outputTypeScript);
  const successArm = splitTopLevelTypeUnion(normalized).find((arm) =>
    /\bok\s*:\s*true\b/.test(arm),
  );
  if (!successArm) return normalized;
  const dataMatch = /\bdata\s*:/.exec(successArm);
  if (!dataMatch) return normalized;

  const start = dataMatch.index + dataMatch[0].length;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let quote: '"' | "'" | '`' | undefined;
  let escaped = false;
  for (let index = start; index < successArm.length; index += 1) {
    const character = successArm[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') braces += 1;
    else if (character === '}') {
      braces -= 1;
      if (braces < 0 && brackets === 0 && parentheses === 0) {
        return normalizeTypeScript(successArm.slice(start, index).trim());
      }
    } else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    else if (character === '(') parentheses += 1;
    else if (character === ')') parentheses -= 1;
    else if (character === ';' && braces === 0 && brackets === 0 && parentheses === 0) {
      return normalizeTypeScript(successArm.slice(start, index).trim());
    }
  }
  return normalized;
}

function referencesType(typeScript: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(typeScript);
}

function referencedDefinitionNames(
  contractTypes: string,
  definitions: ReadonlyArray<readonly [string, string]>,
): ReadonlySet<string> {
  const referenced = new Set<string>();
  let searchable = contractTypes;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, definition] of definitions) {
      if (referenced.has(name) || !referencesType(searchable, name)) continue;
      referenced.add(name);
      searchable += ` ${definition}`;
      changed = true;
    }
  }
  return referenced;
}

function compactDescribeResult(value: JsonValue, requestedPath: string): JsonObject {
  const details = asObject(value);
  if (!details) throw new Error(`Invalid describe response for ${requestedPath}`);
  const path = typeof details.path === 'string' ? details.path : requestedPath;
  if (details.error !== undefined) {
    return { path, kind: 'integration', error: details.error };
  }

  const summary = compactSearchSummary(details.summary ?? details.description);
  const rawInput = details.inputTypeScript ?? details.input;
  const rawData = details.dataTypeScript ?? details.data;
  const rawOutput = details.outputTypeScript ?? details.output;
  const input = typeof rawInput === 'string' ? normalizeTypeScript(rawInput) : undefined;
  const data =
    typeof rawData === 'string'
      ? normalizeTypeScript(rawData)
      : typeof rawOutput === 'string'
        ? successDataTypeScript(rawOutput)
        : 'unknown';
  const rawDefinitions = asObject(details.typeScriptDefinitions ?? details.definitions);
  const definitionEntries = rawDefinitions
    ? Object.entries(rawDefinitions)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([name, definition]) => [name, normalizeTypeScript(definition)] as const)
    : [];
  const referenced = referencedDefinitionNames(`${input ?? ''} ${data}`, definitionEntries);
  const sharedDefinitions = new Set(['ToolError', 'ToolHttpMeta', 'ToolFile']);
  const definitions = Object.fromEntries(
    definitionEntries.filter(([name]) => !sharedDefinitions.has(name) || referenced.has(name)),
  );

  return {
    path,
    kind: 'integration',
    ...(summary ? { summary } : {}),
    ...(input ? { input } : {}),
    data,
    ...(Object.keys(definitions).length > 0 ? { definitions } : {}),
  };
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

const PI_EXECUTE_GUIDANCE = [
  '## Pi bridge workflow',
  '',
  'The Pi bridge and the Executor sandbox are separate call surfaces:',
  '',
  '- Call `executor_search_tools`, `executor_describe_tool`, and `executor_execute` as Pi tools.',
  '- Inside `executor_execute`, call integration paths under `tools.*`.',
  '- Call bridge or loaded native matches directly as Pi tools. Do not place them under `tools.*`.',
  '- `emit(value)` is a sandbox global, not an integration path.',
  '',
  '1. Search with `executor_search_tools({ query, kinds: ["integration"] })`.',
  '2. Use the exact returned `path` with `executor_describe_tool({ path })`.',
  '3. Read `input`, `data`, and optional `definitions`. `data` is the success payload in `result.data`.',
  '4. Run focused code with `executor_execute({ code })` and call the integration as `tools[path](input)`.',
  '',
  'Return only fields required by the task. Remove empty fields, filter large collections in the sandbox, and do not return raw provider envelopes unless debugging.',
].join('\n');

function adaptGuideContent(text: string, id: string): string {
  let adapted = text
    .replace(/skills\(\{\s*name:/g, 'executor_get_guide({ id:')
    .replaceAll('`skills`', '`executor_get_guide`')
    .replaceAll('`execute`', '`executor_execute`');
  for (const [remoteName, localName] of Object.entries(nativeToolNameReplacements)) {
    adapted = adapted
      .replaceAll(`\`${remoteName}\``, `\`${localName}\``)
      .replaceAll(`${remoteName} tool`, `${localName} tool`);
  }
  if (id === 'execute' && !adapted.includes('## Pi bridge workflow')) {
    const workflowHeading = /^## Workflow\s*$/m;
    adapted = workflowHeading.test(adapted)
      ? adapted.replace(workflowHeading, `${PI_EXECUTE_GUIDANCE}\n\n## Sandbox workflow`)
      : `${adapted.trimEnd()}\n\n${PI_EXECUTE_GUIDANCE}\n`;
  }
  return adapted;
}

function parseGuideList(text: string): JsonValue {
  const items: JsonValue[] = [];
  for (const match of text.matchAll(/^- `([^`]+)`\s+[—-]\s+(.+)$/gm)) {
    const summary = adaptNativeToolReferences(match[2] ?? '').replace(
      /\bexecute\b/g,
      'executor_execute',
    );
    items.push({
      id: match[1] ?? '',
      summary: compactSearchSummary(summary) ?? '',
    });
  }
  return { items };
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
  const label = adapter?.label ?? `Executor: ${remoteTool.title ?? remoteTool.name}`;
  return defineTool({
    name: localName,
    label,
    description,
    parameters: proxyToolParameters(remoteTool),
    ...(adapter?.executionMode ? { executionMode: adapter.executionMode } : {}),
    ...createExecutorRenderer({
      kind: 'proxy',
      label: label.replace(/^Executor:\s*/, 'Executor '),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const endpoint = await deps.resolveEndpoint(ctx.cwd, isProjectTrusted(ctx));
      let acceptingProgress = true;
      try {
        return await yieldingToolResult(
          jobs,
          outputs,
          endpoint,
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
          options.activateTools,
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

  const searchTools = defineTool({
    name: 'executor_search_tools',
    label: 'Executor: Search Tools',
    description:
      'Search Pi bridge tools, Executor sandbox primitives, loadable native capabilities, and connected integration tools. Use a short capability query. With load=true, matching bridge and native Pi tools are activated additively; integration matches activate executor_describe_tool and executor_execute but remain paths under tools inside executor_execute. Reuse the same query, kinds, namespace, and limit with nextCursor.',
    ...createExecutorRenderer({ kind: 'search', label: 'Executor Search' }),
    parameters: Type.Object(
      {
        query: Type.String({ description: 'Short capability query.', minLength: 1 }),
        kinds: Type.Optional(
          Type.Array(StringEnum(SEARCH_KINDS), {
            description: 'Kinds to search. Defaults to all kinds.',
            minItems: 1,
            maxItems: SEARCH_KINDS.length,
            uniqueItems: true,
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
        cursor: Type.Optional(Type.String({ description: 'Cursor returned by the prior page.' })),
        load: Type.Optional(
          Type.Boolean({ description: 'Activate matched native tools. Defaults to false.' }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const kinds = new Set<SearchKind>((params.kinds ?? SEARCH_KINDS) as SearchKind[]);
      const limit = params.limit ?? 20;
      const cursor = decodeSearchCursor(params.cursor);
      const nativeItems: SearchCatalogItem[] = (options.nativeTools?.list() ?? []).map((tool) => ({
        path: tool.name,
        kind: 'native',
        summary: compactSearchSummary(tool.description) ?? 'Call this native Executor capability.',
        state: tool.active ? 'loaded' : 'loadable',
      }));
      const localItems = [
        ...(kinds.has('bridge') ? BRIDGE_SEARCH_ITEMS : []),
        ...(kinds.has('sandbox') ? SANDBOX_SEARCH_ITEMS : []),
        ...(kinds.has('native') ? nativeItems : []),
      ];
      const localMatches = localItems
        .map((item) => ({ item, score: searchMatchScore(item, params.query) }))
        .filter((match) => match.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score || left.item.path.localeCompare(right.item.path),
        )
        .map((match) => match.item);
      const searchRemote = kinds.has('integration') && !cursor.remoteExhausted;
      const localOffset = Math.min(cursor.localOffset, localMatches.length);
      const localBudget = searchRemote ? Math.max(0, limit - 1) : limit;
      let selectedLocal = localMatches.slice(localOffset, localOffset + localBudget);
      const remaining = limit - selectedLocal.length;
      let endpoint: ExecutorEndpoint | undefined;
      let remoteItems: SearchCatalogItem[] = [];
      let remoteTotal = cursor.remoteExhausted ? cursor.remoteOffset : 0;
      let nextRemoteOffset = cursor.remoteOffset;
      let remoteExhausted = cursor.remoteExhausted || !kinds.has('integration');

      if (searchRemote && remaining > 0) {
        const response = await requestExecutorCode(
          deps,
          buildFindToolsCode({
            query: params.query,
            namespace: params.namespace,
            limit: remaining,
            offset: cursor.remoteOffset,
          }),
          signal,
          ctx,
        );
        endpoint = response.endpoint;
        const page = asObject(executorReturnedValue(response.result));
        const items = page?.items;
        remoteItems = Array.isArray(items)
          ? items
              .map(asObject)
              .filter(
                (item): item is JsonObject => item !== undefined && typeof item.path === 'string',
              )
              .slice(0, remaining)
              .map((item) => ({
                path: item.path as string,
                kind: 'integration',
                summary:
                  compactSearchSummary(item.summary) ?? 'Call this connected integration tool.',
              }))
          : [];
        if (typeof page?.total !== 'number') {
          throw new Error('Invalid Executor search response: total is missing');
        }
        const consumedRemoteOffset = cursor.remoteOffset + remoteItems.length;
        const pageNextOffset = typeof page.nextOffset === 'number' ? page.nextOffset : undefined;
        if (
          pageNextOffset !== undefined &&
          (pageNextOffset <= cursor.remoteOffset || pageNextOffset < consumedRemoteOffset)
        ) {
          throw new Error('Invalid Executor search response: nextOffset did not advance');
        }
        remoteTotal = page.total;
        nextRemoteOffset = pageNextOffset ?? consumedRemoteOffset;
        remoteExhausted = pageNextOffset === undefined && consumedRemoteOffset >= remoteTotal;

        const unfilled = limit - selectedLocal.length - remoteItems.length;
        if (unfilled > 0) {
          selectedLocal = localMatches.slice(
            localOffset,
            localOffset + selectedLocal.length + unfilled,
          );
        }
      }

      if (params.load === true) {
        const bridgePaths = selectedLocal
          .filter((item) => item.kind === 'bridge' && item.path !== 'executor_search_tools')
          .map((item) => item.path);
        const integrationHelpers =
          remoteItems.length > 0 ? ['executor_describe_tool', 'executor_execute'] : [];
        options.activateTools?.([...bridgePaths, ...integrationHelpers]);

        const nativePaths = selectedLocal
          .filter((item) => item.kind === 'native')
          .map((item) => item.path);
        options.nativeTools?.activate(nativePaths);
        const active = new Set(
          (options.nativeTools?.list() ?? [])
            .filter((tool) => tool.active)
            .map((tool) => tool.name),
        );
        const failed = nativePaths.filter((path) => !active.has(path));
        if (failed.length > 0) {
          throw new Error(`Failed to load Executor native tools: ${failed.join(', ')}`);
        }
        selectedLocal = selectedLocal.map((item) =>
          item.kind === 'native' && active.has(item.path) ? { ...item, state: 'loaded' } : item,
        );
      }

      const items: JsonValue[] = [...selectedLocal, ...remoteItems].map((item) => ({
        path: item.path,
        kind: item.kind,
        summary: item.summary,
        ...(item.state ? { state: item.state } : {}),
      }));
      const total = localMatches.length + remoteTotal;
      const nextCursor: SearchCursor = {
        localOffset: localOffset + selectedLocal.length,
        remoteOffset: nextRemoteOffset,
        remoteExhausted,
      };
      const hasMore = nextCursor.localOffset < localMatches.length || !nextCursor.remoteExhausted;
      const output: JsonValue = {
        items,
        total,
        ...(hasMore ? { nextCursor: encodeSearchCursor(nextCursor) } : {}),
      };
      return activateExecutorResultTools(
        await formatToolResult(outputs, jsonText(output), output, endpoint),
        options.activateTools,
      );
    },
  });

  const describeTool = defineTool({
    name: 'executor_describe_tool',
    label: 'Executor: Describe Tool',
    description:
      'Get the compact TypeScript input and success-data contract for one connected integration path returned by executor_search_tools.',
    ...createExecutorRenderer({ kind: 'describe', label: 'Executor Describe' }),
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
      const output = compactDescribeResult(executorReturnedValue(result), params.path);
      return activateExecutorResultTools(
        await formatToolResult(
          outputs,
          jsonText(output),
          output,
          endpoint,
          result.structuredContent,
        ),
        options.activateTools,
      );
    },
  });

  const execute = defineTool({
    name: 'executor_execute',
    label: 'Executor: Execute',
    description:
      'Run focused TypeScript in Executor to call connected integrations. Use exact paths returned by search_tools or executor_search_tools and inspect unfamiliar paths with executor_describe_tool. Before the first complex call, read the execute guide. Call integrations through tools.*, never fetch; filter large collections and return only required fields. If this returns a running job, use executor_get_job instead of restarting the code.',
    ...createExecutorRenderer({ kind: 'execute', label: 'Executor Execute' }),
    parameters: Type.Object(
      {
        code: Type.String({
          description: 'TypeScript code with a top-level return.',
          minLength: 1,
        }),
        waitMs: Type.Optional(
          Type.Integer({
            description:
              'Return a bridge job ID if execution still runs after this delay. Uses the configured default when omitted.',
            minimum: 0,
            maximum: 30_000,
          }),
        ),
        timeoutMs: Type.Optional(
          Type.Integer({
            description:
              'Hard execution timeout. The configured endpoint timeout remains the upper bound.',
            minimum: 1,
            maximum: 1_800_000,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const endpoint = await deps.resolveEndpoint(ctx.cwd, isProjectTrusted(ctx));
      let acceptingProgress = true;
      try {
        const result = await yieldingToolResult(
          jobs,
          outputs,
          endpoint,
          params.waitMs,
          signal,
          async (jobSignal) => {
            const result = await deps.executeCode(
              endpoint,
              params.code,
              executorCallOptions(
                deps,
                jobSignal,
                ctx,
                Math.min(params.timeoutMs ?? endpoint.requestTimeoutMs, endpoint.requestTimeoutMs),
                (progress) => {
                  if (!acceptingProgress) return;
                  onUpdate?.({
                    content: [{ type: 'text', text: progressText('executor_execute', progress) }],
                    details: { structuredContent: null },
                  });
                },
              ),
            );
            if (result.isError) throw new Error(executorFailureMessage(result));
            const output = executorReturnedValue(result);
            const text = typeof output === 'string' ? output : jsonText(output);
            return formatToolResult(outputs, text, output, endpoint, result.structuredContent);
          },
          options.activateTools,
        );
        return result;
      } finally {
        acceptingProgress = false;
      }
    },
  });

  const listGuides = defineTool({
    name: 'executor_list_guides',
    label: 'Executor: List Guides',
    description: 'List the exact IDs and summaries of available Executor procedural guides.',
    ...createExecutorRenderer({ kind: 'list-guides', label: 'Executor Guides' }),
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const { endpoint, result } = await requestExecutorTool(deps, 'skills', {}, signal, ctx);
      const output = parseGuideList(result.text);
      return activateExecutorResultTools(
        await formatToolResult(outputs, jsonText(output), output, endpoint),
        options.activateTools,
      );
    },
  });

  const getGuide = defineTool({
    name: 'executor_get_guide',
    label: 'Executor: Get Guide',
    description:
      'Fetch one Executor procedural guide by exact guide ID from executor_list_guides. Guide IDs are not Pi tool names or integration paths.',
    ...createExecutorRenderer({ kind: 'guide', label: 'Executor Guide' }),
    parameters: Type.Object(
      { id: Type.String({ description: 'Exact guide ID.', minLength: 1 }) },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { endpoint, result } = await requestExecutorTool(
        deps,
        'skills',
        { name: params.id },
        signal,
        ctx,
      );
      const markdown = adaptGuideContent(result.text, params.id);
      return activateExecutorResultTools(
        await formatToolResult(outputs, markdown, { id: params.id, markdown }, endpoint),
        options.activateTools,
      );
    },
  });

  const getJob = defineTool({
    name: 'executor_get_job',
    label: 'Executor: Get Job',
    description:
      'Wait briefly for a yielded Executor job and return its final result when ready. A running response can be checked again with the same job ID.',
    ...createExecutorRenderer({ kind: 'job', label: 'Executor Job' }),
    parameters: Type.Object(
      {
        jobId: Type.String({
          description: 'Session-local bridge job ID returned by executor_execute.',
          minLength: 1,
        }),
        waitMs: Type.Optional(
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
      const outcome = await jobs.poll<ExecutorPiToolResult>(params.jobId, params.waitMs ?? 5_000);
      if (!outcome) throw new Error(`Unknown or expired Executor job: ${params.jobId}`);
      if (outcome.status === 'failed') {
        throw new Error(errorMessage(outcome.error), { cause: outcome.error });
      }
      let result: ExecutorPiToolResult;
      if (outcome.status === 'completed') {
        result = outcome.value;
      } else {
        const running = runningJobValue(outcome);
        result = await formatToolResult(outputs, jsonText(running), running);
      }
      return activateExecutorResultTools(result, options.activateTools);
    },
  });

  const cancelJob = defineTool({
    name: 'executor_cancel_job',
    label: 'Executor: Cancel Job',
    description: 'Cancel one yielded session-local Executor bridge job by ID.',
    ...createExecutorRenderer({ kind: 'cancel-job', label: 'Executor Cancel Job' }),
    parameters: Type.Object(
      { jobId: Type.String({ description: 'Session-local bridge job ID.', minLength: 1 }) },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params) {
      const cancelled = jobs.cancel(params.jobId);
      const output: JsonValue = { jobId: params.jobId, cancelled };
      return activateExecutorResultTools(
        await formatToolResult(outputs, jsonText(output), output),
        options.activateTools,
      );
    },
  });

  const readOutput = defineTool({
    name: 'executor_read_output',
    label: 'Executor: Read Output',
    description:
      'Read a bounded page from a truncated Executor result. Use the output ID and next offset from the truncation notice.',
    ...createExecutorRenderer({ kind: 'read-output', label: 'Executor Read Output' }),
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

  return [searchTools, describeTool, execute, listGuides, getGuide, getJob, cancelJob, readOutput];
}

function isDeferredSearchProviderRequest(
  value: unknown,
): value is DeferredToolSearchProviderRequest {
  const record = asUnknownObject(value);
  return (
    record?.version === DEFERRED_TOOLS_PROTOCOL_VERSION &&
    typeof record.query === 'string' &&
    typeof record.limit === 'number' &&
    Number.isInteger(record.limit) &&
    (record.cursor === undefined || typeof record.cursor === 'string') &&
    Array.isArray(record.pending) &&
    typeof record.context === 'object' &&
    record.context !== null
  );
}

export function createRemoteExecutorExtension(
  options: CreateRemoteExecutorExtensionOptions = {},
): (pi: ExtensionAPI) => void {
  const deps = { ...defaults, ...options.dependencies };
  return (pi) => {
    const jobs = options.jobs ?? new ExecutorJobManager();
    const outputs = options.outputs ?? new ExecutorOutputStore();
    const nativeProxies = new Map<string, { remoteName: string; tool: ToolDefinition }>();
    const activateTools = (names: string[]): string[] => {
      const available = new Set(pi.getAllTools().map((tool) => tool.name));
      const active = pi.getActiveTools();
      const activeSet = new Set(active);
      const requested = names.filter((name) => available.has(name) && !activeSet.has(name));
      if (requested.length > 0) pi.setActiveTools([...active, ...requested]);
      const activeAfter = new Set(pi.getActiveTools());
      return requested.filter((name) => activeAfter.has(name));
    };
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
      activate: (names) => activateTools(names.filter((name) => nativeProxies.has(name))),
    };

    const executorTools = createRemoteExecutorTools({
      dependencies: deps,
      nativeTools: nativeCatalog,
      activateTools,
      jobs,
      outputs,
    });
    for (const tool of executorTools) pi.registerTool(tool);
    const executorSearchTool = executorTools.find((tool) => tool.name === 'executor_search_tools');
    if (!executorSearchTool) throw new Error('executor_search_tools was not created');

    pi.events.on(DEFERRED_TOOL_SEARCH_PROVIDER_EVENT, (value) => {
      if (!isDeferredSearchProviderRequest(value)) return;
      const request = value;
      request.pending.push(
        Promise.resolve(
          executorSearchTool.execute(
            'pi-deferred-tools:executor-search',
            {
              query: request.query,
              kinds: ['native', 'integration'],
              limit: request.limit,
              cursor: request.cursor,
              load: true,
            },
            request.signal,
            undefined,
            request.context,
          ),
        ).then((result) => {
          const details = result.details as ExecutorToolDetails | undefined;
          const structured = asObject(details?.structuredContent);
          const items = Array.isArray(structured?.items)
            ? structured.items.flatMap((value) => {
                const item = asObject(value);
                if (
                  typeof item?.path !== 'string' ||
                  typeof item.kind !== 'string' ||
                  typeof item.summary !== 'string'
                ) {
                  return [];
                }
                return [
                  {
                    path: item.path,
                    kind: item.kind,
                    summary: item.summary,
                    ...(typeof item.state === 'string' ? { state: item.state } : {}),
                  },
                ];
              })
            : [];
          return {
            provider: 'executor',
            items,
            ...(typeof structured?.nextCursor === 'string'
              ? { nextCursor: structured.nextCursor }
              : {}),
          };
        }),
      );
    });

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
          { dependencies: deps, activateTools, jobs, outputs },
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
