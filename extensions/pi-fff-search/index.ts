import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Text, type Component } from '@earendil-works/pi-tui';
import { type TSchema } from 'typebox';
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  defineTool,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { clampMatchText } from './match-heuristics';
import { DEFAULT_EXPAND_HINT_SUFFIXES, chooseOptionalSuffix } from '../shared/tui-width';
import { TOOL_REWRITE_ARROW } from '../shared/rewrite-label';
import {
  type FallbackSpillInfo,
  type LocalFallbackEngine,
  type RunLocalFallbackResult,
  runLocalFallback,
} from './fallback';
import {
  collapseMiddlePath,
  formatCollapsedResultText,
  formatExpandedResultText,
  formatToolCallText,
  shortenDisplayPath,
} from './rendering';

type PublicToolName = 'fff_find_files' | 'fff_search_terms' | 'fff_grep';

type PublicToolDefinition<Schema extends TSchema> = {
  name: PublicToolName;
  description: string;
  snippet: string;
  inputSchema: Schema;
};

type PublicFindFilesRequest = {
  tool: 'fff_find_files';
  query: string;
  within?: string[];
  glob?: string;
  extensions: string[];
  excludePaths: string[];
  limit: number;
  cursor: null;
  outputMode: 'compact' | 'json';
};

type PublicSearchTermsRequest = {
  tool: 'fff_search_terms';
  terms: string[];
  within?: string[];
  glob?: string;
  extensions: string[];
  excludePaths: string[];
  contextLines: number;
  limit: number;
  cursor: null;
  outputMode: 'compact' | 'json';
};

type PublicGrepRequest = {
  tool: 'fff_grep';
  patterns: string[];
  literal: boolean;
  within?: string[];
  glob?: string;
  caseSensitive: boolean;
  extensions: string[];
  excludePaths: string[];
  contextLines: number;
  limit: number;
  cursor: null;
  outputMode: 'compact' | 'json';
};

type PublicToolRequest = PublicFindFilesRequest | PublicSearchTermsRequest | PublicGrepRequest;

type PublicCompactFindFilesResult = {
  mode: 'compact';
  base_path: string;
  items: Array<{ path: string }>;
};

type PublicCompactSearchTermsResult = {
  mode: 'compact';
  base_path: string;
  items: Array<{ path: string; line: number; text: string }>;
};

type PublicRenderedTextResult = {
  mode: 'compact';
  base_path: string;
  text: string;
};

type PublicJsonResult = {
  mode: 'json';
  [key: string]: unknown;
};

type PublicToolResult =
  | PublicCompactFindFilesResult
  | PublicCompactSearchTermsResult
  | PublicRenderedTextResult
  | PublicJsonResult;

type PublicError = { code: string; message: string };

type Result<Value> = { ok: true; value: Value } | { ok: false; error: PublicError };

type SearchCoordinatorResult = Result<PublicToolResult>;

type FffRouterRuntime = {
  ensureDaemonRunning: () => Promise<void>;
  callPublicToolOverHttp: (request: PublicToolRequest) => Promise<SearchCoordinatorResult>;
  normalizePublicToolInput: (
    toolName: PublicToolName,
    input: Record<string, unknown>,
  ) => Result<PublicToolRequest>;
  resolveWithinFromCaller: (args: {
    callerCwd: string;
    within?: string | null;
  }) => Promise<Result<{ resolvedWithin: string }>>;
};

const SEARCH_TOOL_PROMPT = `For repository search, prefer \`fff_*\` tools first:

- \`fff_find_files\` — fuzzy file/path search; keep queries short and let \`glob\`, \`extensions\`, and \`exclude_paths\` do the narrowing
- \`fff_grep\` — default content search; pass one or more entries in \`patterns\` (OR-matched) plus a required \`literal\` boolean. Use \`literal: true\` for code search (quotes, braces, punctuation, whitespace all safe); use \`literal: false\` only when you genuinely need regex alternation or metacharacters. \`glob\` / \`extensions\` / \`exclude_paths\` prefilter files.

Examples:

- \`fff_find_files\`: {"query":"openssl header","within":"/opt/homebrew/lib","glob":"**/*.h","exclude_paths":["pkgconfig"]}
- \`fff_grep\`: {"patterns":["ActorAuth","actor_auth","PopulatedActorAuth"],"literal":true,"within":"src","extensions":["rs"],"exclude_paths":["tests"]}
- \`fff_grep\`: {"patterns":["plan(Request)?","build(Request)?"],"literal":false,"within":"~/src","glob":"src/**/*.ts","exclude_paths":["dist"]}

These tools return compact text with a \`base_path:\` header. \`fff_find_files\` returns one relative path per line. \`fff_grep\` returns \`path:line: text\` lines.

Fall back to builtin or shell tools only when \`fff_*\` is unavailable, failing, awkward for the query, or outside the active workspace or scope. Briefly say why when falling back.`;

const ENABLE_SEARCH_TERMS = false;
const HIDE_SEARCH_TERMS = !ENABLE_SEARCH_TERMS;
const GLOB_META_PATTERN = /[*?[\]{}!]/;
const GLOB_META_SEQUENCE_PATTERN = /[*?[\]{}!]+/g;
const FIND_QUERY_GENERIC_TOKENS = new Set([
  'd',
  'test',
  'tests',
  'spec',
  'specs',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'json',
  'md',
  'mdx',
  'txt',
  'yaml',
  'yml',
  'lock',
]);
const OVERRIDE_BUILTIN_READ = true;
const OVERRIDE_BUILTIN_GREP = true;
const OVERRIDE_BUILTIN_FIND = true;
const BUILTIN_TOOL_TIMEOUT_MS = 10_000;

const ALLOWLIST_HINTS = ['~/.pi', '~/.pi/agent', '~/.codex', '~/.claude', '~/.amp'];
const DAEMON_RESTART_NOTICE =
  'Notice: FFF daemon config changed; restarted the daemon and retried the search once.';
const COMPACT_READ_RESOURCE_FILE_NAMES = new Set([
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
]);

const nonEmptyStringSchema = { type: 'string', minLength: 1 } as TSchema;
const nonNegativeIntegerSchema = { type: 'integer', minimum: 0 } as TSchema;
const stringListSchema = {
  type: 'array',
  items: nonEmptyStringSchema,
} as TSchema;
const withinSchema = {
  anyOf: [nonEmptyStringSchema, { type: 'array', items: nonEmptyStringSchema, minItems: 1 }],
} as TSchema;
const outputModeSchema = {
  anyOf: [
    { type: 'string', const: 'compact' },
    { type: 'string', const: 'json' },
  ],
} as TSchema;
const cursorSchema = { type: 'null' } as TSchema;

const findFilesInputSchema = {
  type: 'object',
  required: ['query'],
  properties: {
    query: nonEmptyStringSchema,
    within: withinSchema,
    glob: nonEmptyStringSchema,
    extensions: stringListSchema,
    exclude_paths: stringListSchema,
    limit: nonNegativeIntegerSchema,
    cursor: cursorSchema,
    output_mode: outputModeSchema,
  },
  additionalProperties: false,
} as TSchema;

const grepInputSchema = {
  type: 'object',
  required: ['patterns', 'literal'],
  properties: {
    patterns: { type: 'array', items: nonEmptyStringSchema, minItems: 1 },
    literal: {
      type: 'boolean',
      description:
        'Required. If true, patterns are matched as literal text (safe for code, quotes, whitespace, and regex metacharacters). If false, patterns are regex. This tool does not guess; set it explicitly.',
    },
    within: withinSchema,
    glob: nonEmptyStringSchema,
    case_sensitive: { type: 'boolean' },
    extensions: stringListSchema,
    exclude_paths: stringListSchema,
    context_lines: nonNegativeIntegerSchema,
    limit: nonNegativeIntegerSchema,
    cursor: cursorSchema,
    output_mode: outputModeSchema,
  },
  additionalProperties: false,
} as TSchema;

const PUBLIC_TOOL_DEFINITIONS: Array<PublicToolDefinition<TSchema>> = [
  {
    name: 'fff_find_files',
    description:
      'Fuzzy file search by name/path under an already-resolved within scope. Use it when you are exploring a topic or looking for files, not when you already have a specific code identifier. `within` accepts a single absolute path or an array of absolute paths (multi-path unions the results — same semantics as passing multiple roots to `fd`). Keep queries short and let glob, extensions, and exclude_paths do the path narrowing.',
    snippet:
      '{"query":"openssl header","within":"/opt/homebrew/lib","glob":"**/*.h","exclude_paths":["pkgconfig"]}',
    inputSchema: findFilesInputSchema,
  },
  {
    name: 'fff_grep',
    description:
      'Search file contents under an already-resolved within scope. `literal` is REQUIRED: set literal=true for identifier searches, code fragments, or any string containing whitespace, quotes, or punctuation where regex interpretation is unwanted; set literal=false only when you need regex features (anchors, character classes, quantifiers, alternation). This tool does not guess. Use `patterns` for one or more terms; multiple entries use OR semantics. `within` accepts a single absolute path or an array of absolute paths — use the array form to replace shell patterns like `grep PAT file1 file2 dirA dirB` in one call (all entries must share a routing target). Use `glob` / `extensions` / `exclude_paths` to prefilter files aggressively.',
    snippet:
      '{"patterns":["ActorAuth","actor_auth","PopulatedActorAuth"],"literal":true,"within":["crates/portl-cli/Cargo.toml","Cargo.toml"]}',
    inputSchema: grepInputSchema,
  },
];

let fffRouterRuntimePromise: Promise<FffRouterRuntime> | null = null;
const FFF_ROUTER_MODULE_NAME: string = 'fff-router';

function getFffRouterRuntime(): Promise<FffRouterRuntime> {
  fffRouterRuntimePromise ??= import(FFF_ROUTER_MODULE_NAME) as Promise<FffRouterRuntime>;
  return fffRouterRuntimePromise;
}

async function defaultEnsureDaemonRunning(): Promise<void> {
  const { ensureDaemonRunning } = await getFffRouterRuntime();
  await ensureDaemonRunning();
}

async function defaultCallPublicToolOverHttp(
  request: PublicToolRequest,
): Promise<SearchCoordinatorResult> {
  const { callPublicToolOverHttp } = await getFffRouterRuntime();
  return callPublicToolOverHttp(request);
}

function stripSchemaFields(schema: TSchema, hiddenFields: string[]): TSchema {
  const hidden = new Set(hiddenFields);
  const schemaWithObjectFields = schema as TSchema & {
    properties?: Record<string, TSchema>;
    required?: string[];
  };
  const properties = schemaWithObjectFields.properties ?? {};
  const strippedSchema = {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).filter(([field]) => !hidden.has(field)),
    ),
  } as TSchema & { required?: string[] };

  if (Array.isArray(schemaWithObjectFields.required)) {
    strippedSchema.required = schemaWithObjectFields.required.filter((field) => !hidden.has(field));
  } else {
    delete strippedSchema.required;
  }

  return strippedSchema;
}

export const PI_TOOL_DEFINITIONS: Array<PublicToolDefinition<TSchema>> =
  PUBLIC_TOOL_DEFINITIONS.filter(
    (tool) => !(HIDE_SEARCH_TERMS && tool.name === 'fff_search_terms'),
  ).map((tool) => ({
    ...tool,
    inputSchema:
      tool.name === 'fff_find_files'
        ? stripSchemaFields(findFilesInputSchema, ['cursor', 'output_mode'])
        : stripSchemaFields(grepInputSchema, ['context_lines', 'cursor', 'output_mode']),
  }));

export interface CreatePiFffSearchExtensionOptions {
  ensureDaemonRunning?: () => Promise<void>;
  callPublicToolOverHttp?: (request: PublicToolRequest) => Promise<SearchCoordinatorResult>;
  runRipgrepFallback?: (args: {
    toolName: PublicToolName;
    resolvedWithin: string;
    publicRequest: PublicToolRequest;
  }) => Promise<RunLocalFallbackResult>;
  overrideBuiltinRead?: boolean;
  overrideBuiltinGrep?: boolean;
  overrideBuiltinFind?: boolean;
  createBuiltInReadTool?: typeof createReadToolDefinition;
  createBuiltInGrepTool?: typeof createGrepToolDefinition;
  createBuiltInFindTool?: typeof createFindToolDefinition;
  createBuiltInLsTool?: typeof createLsToolDefinition;
  findGitRootForReadFallback?: (cwd: string) => string | null | Promise<string | null>;
}

export default createPiFffSearchExtension();

type RenderedTextMatch = {
  path: string;
  line: number;
  text: string;
};

function formatFindFilesResult(result: PublicCompactFindFilesResult): string {
  const body =
    result.items.length > 0 ? result.items.map((item) => item.path).join('\n') : '(no files found)';
  return `base_path: ${result.base_path}\n\n${body}`;
}

function stripRenderedFindFilesSuffix(line: string): string {
  return line
    .replace(/\s+-\s+(hot|warm|frequent)(\s+git:[^\s]+)?$/, '')
    .replace(/\s+git:[^\s]+$/, '')
    .trim();
}

function parseRenderedFindFilePaths(text: string): string[] {
  const paths: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (
      !line ||
      line.startsWith('→') ||
      line.startsWith('cursor:') ||
      /^\d+\/\d+\s+matches(?:\s+shown)?$/i.test(line) ||
      /^0\s+results/i.test(line)
    ) {
      continue;
    }

    const pathValue = stripRenderedFindFilesSuffix(line);
    if (pathValue) {
      paths.push(pathValue);
    }
  }

  return paths;
}

function formatRenderedFindFilesResult(result: { base_path: string; text: string }): string {
  const paths = parseRenderedFindFilePaths(result.text);
  const body = paths.length > 0 ? paths.join('\n') : '(no files found)';
  return `base_path: ${result.base_path}\n\n${body}`;
}

function isRenderedTextResult(
  result: PublicToolResult,
): result is PublicToolResult & { mode: 'compact'; text: string; base_path: string } {
  return 'text' in result && typeof result.text === 'string';
}

function parseRenderedTextMatches(text: string): RenderedTextMatch[] {
  const matches: RenderedTextMatch[] = [];
  let currentPath: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      continue;
    }

    if (
      line.startsWith('→') ||
      line === '--' ||
      line.startsWith('cursor:') ||
      /^\d+\/\d+\s+matches\s+shown$/i.test(line) ||
      /^0\s+(matches|exact\s+matches|results)/i.test(line)
    ) {
      continue;
    }

    const numbered = line.match(/^\s+(\d+)([:\-|])\s?(.*)$/);
    if (numbered) {
      const [, lineNumberRaw, kind, contentRaw] = numbered;
      if (kind === ':' && currentPath) {
        matches.push({
          path: currentPath,
          line: Number(lineNumberRaw),
          text: (contentRaw ?? '').trim(),
        });
      }
      continue;
    }

    currentPath = line.replace(/\s+\[[^\]]+\]$/, '');
  }

  return matches;
}

function formatTextMatchResult(result: PublicCompactSearchTermsResult): string {
  const body =
    result.items.length > 0
      ? result.items
          .map((item) => `${item.path}:${item.line}: ${clampMatchText(item.text, item.path)}`)
          .join('\n')
      : '(no matches)';
  return `base_path: ${result.base_path}\n\n${body}`;
}

function formatRenderedTextMatchResult(result: { base_path: string; text: string }): string {
  const items = parseRenderedTextMatches(result.text);
  const body =
    items.length > 0
      ? items
          .map((item) => `${item.path}:${item.line}: ${clampMatchText(item.text, item.path)}`)
          .join('\n')
      : '(no matches)';
  return `base_path: ${result.base_path}\n\n${body}`;
}

function formatToolText(toolName: PublicToolName, result: PublicToolResult): string {
  if (result.mode === 'json') {
    return JSON.stringify(result);
  }

  switch (toolName) {
    case 'fff_find_files':
      return isRenderedTextResult(result)
        ? formatRenderedFindFilesResult(result)
        : formatFindFilesResult(result as PublicCompactFindFilesResult);
    case 'fff_search_terms':
    case 'fff_grep':
      return isRenderedTextResult(result)
        ? formatRenderedTextMatchResult(result)
        : formatTextMatchResult(result as PublicCompactSearchTermsResult);
  }
}

function formatPartialResultText(
  toolName: PublicToolName,
  details?: Record<string, unknown>,
): string {
  const request = (details?.publicRequest as Record<string, unknown> | undefined) ?? {};
  const scope = typeof details?.resolvedWithin === 'string' ? details.resolvedWithin : null;

  if (toolName === 'fff_find_files') {
    return 'Finding files…';
  }

  if (toolName === 'fff_search_terms') {
    const termCount = Array.isArray(request.terms) ? request.terms.length : 0;
    return termCount > 0 ? `Searching… ${termCount} terms` : 'Searching… terms';
  }

  const pattern =
    Array.isArray(request.patterns) && typeof request.patterns[0] === 'string'
      ? request.patterns.join(' | ')
      : typeof request.pattern === 'string'
        ? request.pattern
        : 'pattern';
  return scope ? `Searching… ${pattern} in ${shortenDisplayPath(scope)}` : `Searching… ${pattern}`;
}

const COMPACT_SCOPE_WARNING_TEXT =
  '⚠ FFF unavailable for this path; local fallback used. Expand for allowlist fix.';

function formatCompactScopeWarningText(theme: { fg: (...args: any[]) => string }): string {
  return `${theme.fg('warning', '⚠')} ${theme.fg(
    'dim',
    COMPACT_SCOPE_WARNING_TEXT.slice('⚠ '.length),
  )}`;
}

function formatScopeWarningText(args: { resolvedWithin: string; fallbackFailed?: string }): string {
  const lines = [
    'Warning: FFF unavailable for this within path only; auto-retried with a local search fallback.',
    `within: ${shortenDisplayPath(args.resolvedWithin)}`,
    'FFF still works for other within paths that are inside git repos or allowlisted prefixes.',
    `To enable FFF here too, add a parent prefix such as ${ALLOWLIST_HINTS.join(', ')} to the allowlist in ~/.config/fff-routerd/config.json or config.jsonc.`,
    'The daemon reloads this file automatically; no Pi restart is required.',
  ];

  if (args.fallbackFailed) {
    lines.push(`fallback failed: ${args.fallbackFailed}`);
    lines.push('Use builtin search tools for this path until FFF is enabled here.');
  }

  return lines.join('\n');
}

// Paths that are effectively "your entire machine" or "every user" and
// would make the fallback walk an unbounded tree even with the 10s
// timeout and 500-match cap. Rejecting them up front gives the caller a
// clear "narrow your scope" error instead of a silently truncated walk.
//
// Notes on specific entries:
//   - `/` and `homedir()`: the original checks.
//   - `/Users`: macOS multi-user root. Rejecting it prevents accidental
//     cross-user searches; individual `~` is already covered by
//     `homedir()`.
//   - `/home`: the Linux analogue of `/Users`. No-op on macOS so it's
//     cheap to include for cross-platform safety.
//   - `/opt`: parent of Homebrew / zerobrew / nanobrew. Individual
//     allowlisted roots like `/opt/homebrew/Cellar` still resolve and
//     route to fff-mcp normally; only the bare parent is rejected.
//
// `homedir()` is resolved per call so `HOME` env stubs in tests take
// effect. The cost is negligible (a single env read).
const BROAD_WITHIN_STATIC_SCOPES: ReadonlySet<string> = new Set(['/', '/Users', '/home', '/opt']);

function isBroadWithinScope(resolvedWithin: string): boolean {
  // Canonicalize trailing slashes so `/opt` and `/opt/` both match.
  const normalized =
    resolvedWithin.length > 1 ? resolvedWithin.replace(/\/+$/, '') : resolvedWithin;
  return BROAD_WITHIN_STATIC_SCOPES.has(normalized) || normalized === homedir();
}

function rewriteBroadWithinFromGlob(args: {
  resolvedWithin: string;
  params: Record<string, unknown>;
}): { resolvedWithin: string; params: Record<string, unknown> } | null {
  const rawGlob = typeof args.params.glob === 'string' ? args.params.glob.trim() : '';
  if (!rawGlob) {
    return null;
  }

  const normalizedGlob = rawGlob.replace(/\\/g, '/');
  if (normalizedGlob.startsWith('!') || normalizedGlob.startsWith('/')) {
    return null;
  }

  const segments = normalizedGlob.split('/');
  if (
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return null;
  }

  let liftedCount = 0;
  while (liftedCount < segments.length && !GLOB_META_PATTERN.test(segments[liftedCount]!)) {
    liftedCount += 1;
  }

  if (liftedCount === 0) {
    return null;
  }

  const liftedSegments = segments.slice(0, liftedCount);
  const remainingSegments = segments.slice(liftedCount);
  const rewrittenParams = { ...args.params };

  if (remainingSegments.length > 0) {
    rewrittenParams.glob = remainingSegments.join('/');
  } else {
    delete rewrittenParams.glob;
  }

  return {
    resolvedWithin: path.join(args.resolvedWithin, ...liftedSegments),
    params: rewrittenParams,
  };
}

function formatBroadWithinFailureText(resolvedWithin: string): string {
  return [
    'Error: WITHIN_SCOPE_TOO_BROAD: the requested `within` is too broad for automatic fallback.',
    `within: ${shortenDisplayPath(resolvedWithin)}`,
    'Use a more specific `within` path before retrying.',
    'Example: use `~/.config` instead of `~`.',
  ].join('\n');
}

function parseErrorCodeAndMessage(error: unknown): { code: string; message: string } | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const match = error.message.match(/^([A-Z_]+):\s*(.*)$/s);
  if (!match) {
    return null;
  }

  return { code: match[1] ?? 'INTERNAL_ERROR', message: match[2] ?? error.message };
}

function isDaemonMismatchError(error: unknown): boolean {
  return error instanceof Error && /daemon (config|protocol) mismatch/i.test(error.message);
}

function hasZeroStructuredResults(result: PublicToolResult): boolean {
  if ('items' in result && Array.isArray(result.items)) {
    return result.items.length === 0;
  }

  if (isRenderedTextResult(result)) {
    return parseRenderedTextMatches(result.text).length === 0;
  }

  return false;
}

function fallbackHasHits(fallback: Partial<RunLocalFallbackResult>): boolean {
  if (typeof fallback.hasHits === 'boolean') {
    return fallback.hasHits;
  }

  return !/\n\n\(no (files found|matches)\)\s*$/i.test(fallback.text ?? '');
}

function formatZeroResultFallbackNotice(
  engine: LocalFallbackEngine,
  toolName: PublicToolName,
): string {
  // The fallback delegates to the builtin grep / find tools. Those tools
  // invoke `rg` / `fd` with `--hidden` (so dotfiles and dot-directories
  // ARE searched) but leave `.gitignore` handling at the default (so
  // gitignored paths are NOT surfaced). The notice needs to match both
  // halves of that behaviour — calling out the hidden-file coverage is
  // what distinguishes the fallback from what FFF returned.
  if (toolName === 'fff_find_files' && engine === 'fd') {
    return 'Note: FFF returned 0 results; local filename fallback found matches. Paths may include hidden files or be outside the tracked project / daemon-allowed scope.';
  }
  return 'Note: FFF returned 0 results; local text fallback found matches. Paths may include hidden files outside the tracked project / daemon-allowed scope.';
}

function formatFallbackSpillNotice(spill: FallbackSpillInfo): string {
  return `Note: Full raw fallback output was spilled to ${spill.path} (${spill.bytes} bytes across ${spill.lines} lines).`;
}

function formatFallbackSummaryNotice(args: { total: number; omitted: number }): string | null {
  if (args.omitted <= 0) {
    return null;
  }

  const included = Math.max(0, args.total - args.omitted);
  return `Note: Showing the top ${included} fallback matches after ranking and truncation; omitted ${args.omitted} lower-priority matches.`;
}

function renderInfoBlock(notice: string, theme: { fg: (...args: any[]) => string }): string {
  return notice
    .split('\n')
    .map((line, index) => (index === 0 ? theme.fg('muted', line) : theme.fg('dim', line)))
    .join('\n');
}

function renderNoticeBlock(notice: string, theme: { fg: (...args: any[]) => string }): string {
  return notice
    .split('\n')
    .map((line, index) => (index === 0 ? theme.fg('warning', line) : theme.fg('dim', line)))
    .join('\n');
}

function styleResultText(text: string, theme: { fg: (...args: any[]) => string }): string {
  const lines = text.split('\n');
  return lines
    .map((line, index) => {
      if (index === 0) {
        if (line.startsWith('0 files') || line.startsWith('No matches')) {
          return theme.fg('dim', line);
        }
        return theme.fg('success', line);
      }

      if (line === '  Files' || line === '  Top file') {
        return theme.fg('muted', line);
      }

      if (line.startsWith('  · ')) {
        return theme.fg('muted', '  · ') + theme.fg('accent', line.slice(4));
      }

      if (line.startsWith('  within:') || line.startsWith('    ')) {
        return theme.fg('dim', line);
      }

      return theme.fg('text', line);
    })
    .join('\n');
}

export function createWidthAwareText(renderForWidth: (width: number) => string): Component {
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;

  return {
    render(width: number): string[] {
      if (cachedWidth === width && cachedLines) return cachedLines;

      const lines = new Text(renderForWidth(width), 0, 0).render(width);
      cachedWidth = width;
      cachedLines = lines;
      return lines;
    },
    invalidate() {
      cachedWidth = undefined;
      cachedLines = undefined;
    },
  };
}

function parseBasePathPayload(text: string): { basePath: string; bodyLines: string[] } | null {
  const lines = text.split(/\r?\n/);
  if (!lines[0]?.startsWith('base_path: ') || lines[1] !== '') {
    return null;
  }

  return {
    basePath: lines[0].slice('base_path: '.length),
    bodyLines: lines.slice(2).filter((line) => line.length > 0),
  };
}

function convertFffTextToBuiltinSearchText(
  toolName: 'fff_find_files' | 'fff_grep',
  text: string,
): string | null {
  const parsed = parseBasePathPayload(text);
  if (!parsed) {
    return null;
  }

  const noMatchLine = toolName === 'fff_find_files' ? '(no files found)' : '(no matches)';
  const emptyMessage =
    toolName === 'fff_find_files' ? 'No files found matching pattern' : 'No matches found';
  const bodyLines = parsed.bodyLines.filter((line) => line !== noMatchLine);

  return bodyLines.length > 0 ? bodyLines.join('\n') : emptyMessage;
}

function isEmptyBuiltinSearchText(toolName: 'fff_find_files' | 'fff_grep', text: string): boolean {
  return (
    text ===
    (toolName === 'fff_find_files' ? 'No files found matching pattern' : 'No matches found')
  );
}

function shouldUseBuiltinSearchFallback(details?: Record<string, unknown>): boolean {
  return details?.resultKind === 'broad_scope_rejected' || details?.resultKind === 'scope_warning';
}

function hasUnbalancedRegexSyntax(pattern: string): boolean {
  let escaped = false;
  const stack: string[] = [];
  const matchingOpeners: Record<string, string> = {
    ')': '(',
    ']': '[',
    '}': '{',
  };

  for (const char of pattern) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      stack.push(char);
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      const expected = matchingOpeners[char];
      if (stack.at(-1) === expected) {
        stack.pop();
        continue;
      }
      return true;
    }
  }

  return escaped || stack.length > 0;
}

function repairSuspiciousGrepPatterns(request: PublicToolRequest): {
  request: PublicToolRequest;
  repairs: Array<{ original: string }>;
} | null {
  if (request.tool !== 'fff_grep') {
    return null;
  }

  // Only repair when the caller asked for regex-mode (`literal: false`). If
  // they explicitly asked for literal matching, unbalanced brackets are by
  // definition fine (they're treated as bytes) and a zero-result means the
  // text just isn't there.
  if (request.literal === true) {
    return null;
  }

  const repairs = request.patterns.flatMap((pattern) => {
    if (!hasUnbalancedRegexSyntax(pattern)) {
      return [];
    }
    return [{ original: pattern }];
  });

  if (repairs.length === 0) {
    return null;
  }

  // Retry the same patterns as literals rather than regex-escaping each one
  // locally. fff-router's literal path handles the metacharacters correctly.
  return {
    request: {
      ...request,
      literal: true,
    },
    repairs,
  };
}

function formatRegexRepairNotice(repairs: Array<{ original: string }>): string {
  const rendered = repairs.map((repair) => repair.original).join(', ');
  return `Note: FFF returned 0 results; retried as a literal search after detecting suspicious regex syntax in: ${rendered}`;
}

function splitLeadingLiteralGlobSegments(rawPattern: string): {
  normalizedPattern: string;
  literalSegments: string[];
  remainingSegments: string[];
} | null {
  const normalizedPattern = rawPattern.replace(/\\/g, '/').trim();
  if (
    !normalizedPattern ||
    normalizedPattern.startsWith('!') ||
    normalizedPattern.startsWith('/')
  ) {
    return null;
  }

  const segments = normalizedPattern.split('/');
  if (
    segments.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return null;
  }

  let literalCount = 0;
  while (literalCount < segments.length && !GLOB_META_PATTERN.test(segments[literalCount]!)) {
    literalCount += 1;
  }

  let literalSegments = segments.slice(0, literalCount);
  let remainingSegments = segments.slice(literalCount);

  if (remainingSegments.length === 0 && literalSegments.length > 0) {
    remainingSegments = [literalSegments[literalSegments.length - 1]!];
    literalSegments = literalSegments.slice(0, -1);
  }

  return {
    normalizedPattern,
    literalSegments,
    remainingSegments,
  };
}

function tokenizeFindQuery(value: string): string[] {
  return value
    .replace(GLOB_META_SEQUENCE_PATTERN, ' ')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function buildFffGrepParamsFromBuiltin(
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const pattern = typeof args.pattern === 'string' && args.pattern.trim() ? args.pattern : null;
  if (!pattern) {
    return null;
  }

  const params: Record<string, unknown> = {
    patterns: [pattern],
    // Forward the caller's literal-vs-regex intent verbatim. fff-router routes
    // `literal: true` to fff-mcp's multi_grep tool (regex metacharacters are
    // matched as literal bytes) and `literal: false` to its grep tool (regex
    // with whitespace auto-encoded to `\s`). No local escaping required.
    literal: args.literal === true,
    case_sensitive: args.ignoreCase === true ? false : true,
  };

  if (typeof args.path === 'string' && args.path.trim()) {
    params.within = args.path;
  }
  if (typeof args.glob === 'string' && args.glob.trim()) {
    params.glob = args.glob;
  }
  if (typeof args.context === 'number') {
    params.context_lines = args.context;
  }
  if (typeof args.limit === 'number') {
    params.limit = args.limit;
  }

  return params;
}

function deriveFindQueryFromPattern(pattern: string): string | null {
  const normalizedPattern = pattern.replace(/\\/g, '/').trim();
  const basename = normalizedPattern.split('/').filter(Boolean).pop();
  if (!basename) {
    return null;
  }

  if (!GLOB_META_PATTERN.test(normalizedPattern)) {
    return basename;
  }

  const tokens = tokenizeFindQuery(basename);
  if (tokens.length === 0) {
    return null;
  }

  const specificTokens = tokens.filter(
    (token) => !FIND_QUERY_GENERIC_TOKENS.has(token.toLowerCase()),
  );
  if (specificTokens.length === 0) {
    return null;
  }

  return specificTokens.join(' ');
}

function buildFffFindParamsFromBuiltin(
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const pattern = typeof args.pattern === 'string' && args.pattern.trim() ? args.pattern : null;
  if (!pattern) {
    return null;
  }

  const splitPattern = splitLeadingLiteralGlobSegments(pattern);
  const effectivePattern = splitPattern?.remainingSegments.join('/') || pattern;
  const query = deriveFindQueryFromPattern(effectivePattern);
  if (!query) {
    return null;
  }

  const params: Record<string, unknown> = {
    query,
    glob: effectivePattern,
  };

  const explicitPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : null;
  const liftedWithin = splitPattern?.literalSegments.length
    ? splitPattern.literalSegments.join('/')
    : null;

  if (explicitPath && liftedWithin) {
    params.within = path.join(explicitPath, liftedWithin);
  } else if (explicitPath) {
    params.within = explicitPath;
  } else if (liftedWithin) {
    params.within = liftedWithin;
  }
  if (typeof args.limit === 'number') {
    params.limit = args.limit;
  }

  return params;
}

function parseJsonStringifiedArray(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return value;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function coerceStringArray(value: unknown): unknown {
  const parsed = parseJsonStringifiedArray(value);
  return typeof parsed === 'string' ? [parsed] : parsed;
}

function firstAliasValue(params: Record<string, unknown>, aliases: readonly string[]): unknown {
  for (const alias of aliases) {
    const value = params[alias];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
}

function copyAlias(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  canonical: string,
  aliases: readonly string[],
): void {
  if (target[canonical] !== undefined && target[canonical] !== null && target[canonical] !== '') {
    return;
  }

  const value = firstAliasValue(source, aliases);
  if (value !== undefined) {
    target[canonical] = value;
  }
}

function deleteAliasKeys(target: Record<string, unknown>, aliases: readonly string[]): void {
  for (const alias of aliases) {
    delete target[alias];
  }
}

function normalizeFffToolParams(
  toolName: PublicToolName,
  rawParams: unknown,
): Record<string, unknown> {
  if (typeof rawParams === 'string') {
    if (toolName === 'fff_grep') {
      return { patterns: [rawParams], literal: true };
    }

    if (toolName === 'fff_find_files') {
      const glob = GLOB_META_PATTERN.test(rawParams) ? rawParams : undefined;
      return {
        query: deriveFindQueryFromPattern(rawParams) ?? rawParams,
        ...(glob ? { glob } : {}),
      };
    }
  }

  if (rawParams === null || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    return rawParams as Record<string, unknown>;
  }

  const source = rawParams as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...source };

  if (toolName === 'fff_grep') {
    const patternAliases = ['pattern', 'query', 'search', 'q', 'text'];
    const regexAliases = ['regex', 'expression'];
    copyAlias(normalized, source, 'patterns', patternAliases);
    const regexAlias = firstAliasValue(source, regexAliases);
    if (normalized.patterns === undefined && regexAlias !== undefined) {
      normalized.patterns = regexAlias;
      normalized.literal = false;
    }
    if (normalized.literal === undefined) {
      normalized.literal = regexAlias !== undefined ? false : true;
    }
    normalized.patterns = coerceStringArray(normalized.patterns);
    deleteAliasKeys(normalized, [...patternAliases, ...regexAliases]);
  } else if (toolName === 'fff_find_files') {
    const queryAliases = ['pattern', 'search', 'q', 'text'];
    copyAlias(normalized, source, 'query', queryAliases);
    if (typeof normalized.query === 'string' && normalized.glob === undefined) {
      const query = normalized.query;
      if (GLOB_META_PATTERN.test(query)) {
        normalized.glob = query;
        normalized.query = deriveFindQueryFromPattern(query) ?? query;
      }
    }
    deleteAliasKeys(normalized, queryAliases);
  }

  const withinAliases = ['path', 'directory', 'dir', 'folder', 'cwd'];
  const globAliases = ['file_pattern', 'filePattern'];
  const excludeAliases = ['excludePaths', 'exclude', 'excludePath'];
  const caseAliases = ['caseSensitive'];
  const contextAliases = ['contextLines', 'context'];
  const outputAliases = ['outputMode'];
  copyAlias(normalized, source, 'within', withinAliases);
  copyAlias(normalized, source, 'glob', globAliases);
  copyAlias(normalized, source, 'exclude_paths', excludeAliases);
  copyAlias(normalized, source, 'case_sensitive', caseAliases);
  copyAlias(normalized, source, 'context_lines', contextAliases);
  copyAlias(normalized, source, 'output_mode', outputAliases);
  deleteAliasKeys(normalized, [
    ...withinAliases,
    ...globAliases,
    ...excludeAliases,
    ...caseAliases,
    ...contextAliases,
    ...outputAliases,
  ]);

  normalized.extensions = coerceStringArray(normalized.extensions);
  normalized.exclude_paths = coerceStringArray(normalized.exclude_paths);

  return normalized;
}

function normalizeRequestedPath(value: string): string {
  return value.replace(/^@/, '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function isReadResolutionError(error: unknown): boolean {
  return error instanceof Error && /(ENOENT|no such file|not found)/i.test(error.message);
}

function isReadIsDirectoryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/^EISDIR\b/.test(error.message) ||
      /illegal operation on a directory/i.test(error.message) ||
      (error as NodeJS.ErrnoException).code === 'EISDIR')
  );
}

function formatRewrittenLsPath(requestedPath: string, cwd: string): string {
  const resolvedBase = requestedPath.startsWith('~')
    ? path.join(homedir(), requestedPath.slice(1).replace(/^\/+/, ''))
    : path.isAbsolute(requestedPath)
      ? requestedPath
      : path.resolve(cwd, requestedPath);
  const relative = path.relative(cwd, resolvedBase).replace(/\\/g, '/');
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }
  return shortenDisplayPath(resolvedBase, cwd);
}

const BROAD_READ_METADATA_BASENAMES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'vitest.config.ts',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'uv.lock',
]);
const BROAD_READ_GENERIC_BASENAMES = new Set([
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'config.ts',
  'config.js',
  'types.ts',
  'types.js',
  'utils.ts',
  'utils.js',
  'helpers.ts',
  'helpers.js',
  'constants.ts',
  'constants.js',
  'README.md',
]);

function buildReadResolutionParams(readPath: string): Record<string, unknown> | null {
  const normalized = normalizeRequestedPath(readPath);
  if (!normalized || path.isAbsolute(normalized) || normalized.startsWith('~')) {
    return null;
  }

  const basename = path.posix.basename(normalized);
  if (!basename || GLOB_META_PATTERN.test(basename)) {
    return null;
  }

  const dirname = path.posix.dirname(normalized);
  const params: Record<string, unknown> = {
    query: basename,
    limit: 10,
  };

  if (dirname !== '.' && dirname !== '') {
    params.within = dirname;
    params.glob = basename;
  } else {
    params.glob = `**/${basename}`;
  }

  return params;
}

function buildBroadReadResolutionParams(
  readPath: string,
  within: string | null,
): Record<string, unknown> | null {
  const normalized = normalizeRequestedPath(readPath);
  if (!normalized || path.isAbsolute(normalized) || normalized.startsWith('~')) {
    return null;
  }

  const basename = path.posix.basename(normalized);
  if (!basename || GLOB_META_PATTERN.test(basename)) {
    return null;
  }

  const dirname = path.posix.dirname(normalized);
  if ((dirname === '.' || dirname === '') && !BROAD_READ_METADATA_BASENAMES.has(basename)) {
    return null;
  }

  return {
    query: basename,
    glob: `**/${basename}`,
    ...(within ? { within } : {}),
    limit: 10,
  };
}

function defaultFindGitRootForReadFallback(cwd: string): string | null {
  let current = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(current, '.git'))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function pickResolvedReadPath(requestedPath: string, text: string): string | null {
  const parsed = parseBasePathPayload(text);
  if (!parsed) {
    return null;
  }

  const candidates = parsed.bodyLines.filter((line) => line !== '(no files found)');
  if (candidates.length === 0) {
    return null;
  }

  const normalizedRequested = normalizeRequestedPath(requestedPath);
  const requestedBasename = path.posix.basename(normalizedRequested);
  const suffixMatches = candidates.filter(
    (candidate) =>
      candidate === normalizedRequested || candidate.endsWith(`/${normalizedRequested}`),
  );
  if (suffixMatches.length === 1) {
    return path.join(parsed.basePath, suffixMatches[0]!);
  }

  const basenameMatches = candidates.filter(
    (candidate) => path.posix.basename(candidate) === requestedBasename,
  );
  if (basenameMatches.length === 1) {
    return path.join(parsed.basePath, basenameMatches[0]!);
  }

  if (candidates.length === 1) {
    return path.join(parsed.basePath, candidates[0]!);
  }

  return null;
}

function pickBroadenedReadPath(requestedPath: string, text: string): string | null {
  const parsed = parseBasePathPayload(text);
  if (!parsed) {
    return null;
  }

  const candidates = parsed.bodyLines.filter((line) => line !== '(no files found)');
  if (candidates.length === 0) {
    return null;
  }

  const normalizedRequested = normalizeRequestedPath(requestedPath);
  const requestedBasename = path.posix.basename(normalizedRequested);
  const suffixMatches = candidates.filter(
    (candidate) =>
      candidate === normalizedRequested || candidate.endsWith(`/${normalizedRequested}`),
  );
  if (suffixMatches.length === 1) {
    return path.join(parsed.basePath, suffixMatches[0]!);
  }

  const basenameMatches = candidates.filter(
    (candidate) => path.posix.basename(candidate) === requestedBasename,
  );
  if (basenameMatches.length === 1) {
    const candidate = basenameMatches[0]!;
    if (BROAD_READ_METADATA_BASENAMES.has(requestedBasename)) {
      return path.join(parsed.basePath, candidate);
    }
    if (isHighConfidenceBroadReadMatch(normalizedRequested, candidate)) {
      return path.join(parsed.basePath, candidate);
    }
  }

  return null;
}

function isHighConfidenceBroadReadMatch(requestedPath: string, candidatePath: string): boolean {
  const requestedBasename = path.posix.basename(requestedPath);
  if (path.posix.basename(candidatePath) !== requestedBasename) {
    return false;
  }

  const requestedParts = splitPathTokens(requestedPath);
  const candidateParts = splitPathTokens(candidatePath);
  if (requestedParts.length < 2 || candidateParts.length < 2) {
    return false;
  }

  const requestedDirTokens = requestedParts.slice(0, -1);
  const candidateDirTokens = candidateParts.slice(0, -1);
  const sharedDirTokens = requestedDirTokens.filter((token) => candidateDirTokens.includes(token));
  const basenameGeneric = BROAD_READ_GENERIC_BASENAMES.has(requestedBasename);

  if (sharedDirTokens.length >= 2) {
    return true;
  }

  return !basenameGeneric && sharedDirTokens.length >= 1 && candidateParts.length > 2;
}

function splitPathTokens(pathValue: string): string[] {
  return normalizeRequestedPath(pathValue)
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== '.');
}

function formatFixedReadPath(resolvedPath: string, cwd: string): string {
  const relativePath = path.relative(cwd, resolvedPath).replace(/\\/g, '/');
  if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
    return relativePath;
  }

  return resolvedPath;
}

async function rewriteReadToLs(args: {
  requestedPath: string;
  toolCallId: string;
  signal: AbortSignal | undefined;
  onUpdate: Parameters<ReturnType<typeof createReadToolDefinition>['execute']>[3];
  ctx: Parameters<ReturnType<typeof createReadToolDefinition>['execute']>[4];
  createBuiltInLs: typeof createLsToolDefinition;
}): Promise<{
  content: Awaited<ReturnType<ReturnType<typeof createLsToolDefinition>['execute']>>['content'];
  details: Record<string, unknown>;
} | null> {
  const builtInLs = args.createBuiltInLs(args.ctx.cwd);
  let lsResult: Awaited<ReturnType<typeof builtInLs.execute>>;
  try {
    lsResult = await builtInLs.execute(
      args.toolCallId,
      { path: args.requestedPath },
      withBuiltinToolTimeout(args.signal),
      args.onUpdate,
      args.ctx,
    );
  } catch {
    return null;
  }

  const displayPath = formatRewrittenLsPath(args.requestedPath, args.ctx.cwd);
  const header = `Path (directory): ${displayPath}\nAuto-rewrote read → ls because the path is a directory.`;

  const updatedContent = lsResult.content.map((entry, index) =>
    index === 0 && entry.type === 'text' ? { ...entry, text: `${header}\n\n${entry.text}` } : entry,
  );
  const firstText = updatedContent.find(
    (entry): entry is { type: 'text'; text: string } => entry.type === 'text',
  );
  const content = firstText
    ? updatedContent
    : [{ type: 'text' as const, text: header }, ...updatedContent];

  return {
    content,
    details: {
      ...(lsResult.details && typeof lsResult.details === 'object' ? lsResult.details : {}),
      routedVia: 'read-to-ls',
      rewrittenFromPath: args.requestedPath,
      rewrittenToTool: 'ls',
    },
  };
}

function extractPrimaryText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const entry of content) {
    if (
      entry &&
      typeof entry === 'object' &&
      (entry as { type?: unknown }).type === 'text' &&
      typeof (entry as { text?: unknown }).text === 'string'
    ) {
      parts.push((entry as { text: string }).text);
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

function withBuiltinToolTimeout(
  signal: AbortSignal | undefined,
  timeoutMs = BUILTIN_TOOL_TIMEOUT_MS,
) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function quoteRewriteValue(value: string): string {
  return /[\s"]/.test(value) ? JSON.stringify(value) : value;
}

function formatRewriteWithin(value: unknown, cwd?: string): string | null {
  if (typeof value !== 'string' || !value) {
    return null;
  }

  if (value === '.') {
    return '.';
  }

  return shortenDisplayPath(value, cwd);
}

function formatOriginalSearchPath(value: string, cwd?: string): string {
  if (value === '.') {
    return '.';
  }

  if (path.isAbsolute(value)) {
    return shortenDisplayPath(value, cwd);
  }

  return value;
}

type CompactCallTheme = {
  bold: (text: string) => string;
  fg: (...args: any[]) => string;
};

type CompactRewriteMetadata = {
  key?: string;
  value: string;
  collapsiblePath?: boolean;
};

type CompactRewriteSummary = {
  sourceTool?: 'grep' | 'find' | 'bash';
  targetTool: 'fff_grep' | 'fff_find_files';
  primary: string;
  metadata: CompactRewriteMetadata[];
};

function compactMetadata(key: string | undefined, value: string | null): CompactRewriteMetadata[] {
  return value ? [{ key, value }] : [];
}

function compactPathMetadata(key: string, value: unknown, cwd?: string): CompactRewriteMetadata[] {
  if (typeof value === 'string' && ['undefined', 'null'].includes(value.trim().toLowerCase())) {
    return [];
  }
  const formatted = formatRewriteWithin(value, cwd);
  return formatted ? [{ key, value: formatted, collapsiblePath: true }] : [];
}

function renderCompactMetadataEntry(entry: CompactRewriteMetadata): string {
  return entry.key ? `${entry.key}=${entry.value}` : entry.value;
}

function compactStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function compactListMetadata(key: string, value: unknown): CompactRewriteMetadata[] {
  const values = compactStringList(value);
  return values.length > 0 ? [{ key, value: values.join(',') }] : [];
}

function formatCompactPrimary(value: string): string {
  return value.replace(/(?<!\\)\|/g, ' | ').replace(/\s+\|\s+/g, ' | ');
}

function normalizeCompactCollapsedPath(pathValue: string): string {
  return pathValue.replace(/\/ \.\.\.$/, '/...');
}

function renderCompactMetadataLine(
  metadata: CompactRewriteMetadata[],
  width: number | undefined,
): string {
  if (metadata.length === 0) {
    return '';
  }

  const mutable = metadata.map((entry) => ({ ...entry }));
  const renderLine = () => `  ${mutable.map(renderCompactMetadataEntry).join(' · ')}`;
  let line = renderLine();
  if (!width || width <= 0 || line.length <= width) {
    return line;
  }

  for (const entry of mutable) {
    if (!entry.collapsiblePath) {
      continue;
    }

    const staticWidth = line.length - entry.value.length;
    const pathBudget = Math.max(1, Math.min(31, width - staticWidth));
    entry.value = normalizeCompactCollapsedPath(collapseMiddlePath(entry.value, pathBudget));
    line = renderLine();
    if (line.length <= width) {
      return line;
    }
  }

  return line;
}

function collapseCompactPrimary(primary: string, budget: number): string {
  if (budget <= 0 || primary.length <= budget) {
    return primary;
  }
  if (budget <= 4) {
    return primary.slice(0, Math.max(1, budget));
  }

  const left = Math.ceil((budget - 1) / 2);
  const right = Math.floor((budget - 1) / 2);
  return `${primary.slice(0, left)}…${primary.slice(primary.length - right)}`;
}

function buildCompactFffSearchSummary(
  targetTool: 'fff_grep' | 'fff_find_files',
  params: Record<string, unknown>,
  cwd?: string,
  sourceTool?: 'grep' | 'find' | 'bash',
): CompactRewriteSummary | null {
  if (targetTool === 'fff_grep') {
    const patterns = compactStringList(params.patterns);
    if (patterns.length === 0 && typeof params.pattern === 'string' && params.pattern.length > 0) {
      patterns.push(params.pattern);
    }

    const primary = patterns.map(formatCompactPrimary).join(' | ');
    if (!primary) {
      return null;
    }

    return {
      sourceTool,
      targetTool,
      primary,
      metadata: [
        ...compactPathMetadata('within', params.within, cwd),
        ...compactMetadata(
          'glob',
          typeof params.glob === 'string' && params.glob.trim() ? params.glob.trim() : null,
        ),
        ...(params.literal === true ? [{ value: 'literal' }] : []),
        ...(params.case_sensitive === true && !sourceTool ? [{ value: 'case-sensitive' }] : []),
        ...(params.case_sensitive === false ? [{ value: 'ignoreCase' }] : []),
        ...compactListMetadata('ext', params.extensions),
        ...compactListMetadata('exclude', params.exclude_paths),
        ...(typeof params.context_lines === 'number'
          ? [{ key: 'ctx', value: String(params.context_lines) }]
          : []),
        ...(typeof params.limit === 'number'
          ? [{ key: 'limit', value: String(params.limit) }]
          : []),
      ],
    };
  }

  const query = typeof params.query === 'string' && params.query.trim() ? params.query.trim() : '';
  if (!query) {
    return null;
  }

  return {
    sourceTool,
    targetTool,
    primary: formatCompactPrimary(query),
    metadata: [
      ...compactPathMetadata('within', params.within, cwd),
      ...compactMetadata(
        'glob',
        typeof params.glob === 'string' && params.glob.trim() ? params.glob.trim() : null,
      ),
      ...compactListMetadata('ext', params.extensions),
      ...compactListMetadata('exclude', params.exclude_paths),
      ...(typeof params.limit === 'number' ? [{ key: 'limit', value: String(params.limit) }] : []),
    ],
  };
}

function buildCompactRewriteSummary(
  sourceTool: 'grep' | 'find',
  params: Record<string, unknown>,
  cwd?: string,
): CompactRewriteSummary | null {
  return buildCompactFffSearchSummary(
    sourceTool === 'grep' ? 'fff_grep' : 'fff_find_files',
    params,
    cwd,
    sourceTool,
  );
}

function renderCompactSearchCall(
  summary: CompactRewriteSummary,
  width: number | undefined,
  theme: CompactCallTheme,
): string {
  const metadataText = summary.metadata.map(renderCompactMetadataEntry).join(' · ');
  const sourcePrefix = summary.sourceTool ? `${summary.sourceTool}${TOOL_REWRITE_ARROW}` : '';
  const firstLinePrefix = `${sourcePrefix}${summary.targetTool} `;
  const inline = `${firstLinePrefix}${summary.primary}${metadataText ? ` ${metadataText}` : ''}`;
  const fitsInline = !width || width <= 0 || inline.length <= width;
  const primaryBudget = width
    ? Math.max(8, width - firstLinePrefix.length)
    : summary.primary.length;
  const primary = fitsInline
    ? summary.primary
    : collapseCompactPrimary(summary.primary, primaryBudget);
  const metadataLine = fitsInline ? '' : renderCompactMetadataLine(summary.metadata, width);
  const inlineMetadata = fitsInline && metadataText ? metadataText : '';

  const firstLine = [
    sourcePrefix ? theme.fg('dim', sourcePrefix) : '',
    theme.fg('toolTitle', theme.bold(summary.targetTool)),
    ' ',
    theme.fg('accent', primary),
    inlineMetadata ? ` ${theme.fg('dim', inlineMetadata)}` : '',
  ].join('');

  return metadataLine ? `${firstLine}\n${theme.fg('dim', metadataLine)}` : firstLine;
}

function formatFffRewriteSummary(
  toolName: 'grep' | 'find',
  params: Record<string, unknown>,
  cwd?: string,
): string | null {
  const parts: string[] = [];

  if (toolName === 'grep') {
    const patterns = Array.isArray(params.patterns)
      ? params.patterns.filter(
          (item): item is string => typeof item === 'string' && item.length > 0,
        )
      : [];
    if (patterns.length === 1) {
      parts.push(`pattern=${patterns[0]}`);
    } else if (patterns.length > 1) {
      parts.push(`patterns[${patterns.length}]=${patterns.join('; ')}`);
    }
    // Only annotate literal mode; regex is the common case and gets left
    // implicit, matching the "show non-default modes" convention used for
    // case-sensitive and limit.
    if (params.literal === true) {
      parts.push('literal');
    }
  } else {
    const query =
      typeof params.query === 'string' && params.query.trim() ? params.query.trim() : null;
    if (query) {
      parts.push(`query=${quoteRewriteValue(query)}`);
    }
  }

  const within = formatRewriteWithin(params.within, cwd);
  if (within) {
    parts.push(`within=${quoteRewriteValue(within)}`);
  }

  const glob = typeof params.glob === 'string' && params.glob.trim() ? params.glob.trim() : null;
  if (glob) {
    parts.push(`glob=${quoteRewriteValue(glob)}`);
  }

  if (typeof params.context_lines === 'number') {
    parts.push(`context=${params.context_lines}`);
  }

  if (typeof params.limit === 'number') {
    parts.push(`limit=${params.limit}`);
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}

function formatBuiltinSearchCallSummary(
  toolName: 'grep' | 'find',
  args: Record<string, unknown>,
  cwd?: string,
): string {
  if (toolName === 'grep') {
    const pattern = typeof args.pattern === 'string' ? args.pattern : '';
    const renderedPattern = args.literal === true ? pattern : `/${pattern}/`;
    const parts = [`grep ${renderedPattern}`];

    const searchPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : null;
    if (searchPath) {
      parts.push(`in ${formatOriginalSearchPath(searchPath, cwd)}`);
    }

    const glob = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : null;
    if (glob) {
      parts.push(`(${glob})`);
    }

    if (args.ignoreCase === true) {
      parts.push('ignoreCase');
    }
    if (args.literal === true) {
      parts.push('literal');
    }
    if (typeof args.context === 'number') {
      parts.push(`context ${args.context}`);
    }
    if (typeof args.limit === 'number') {
      parts.push(`limit ${args.limit}`);
    }

    return parts.join(' ');
  }

  const pattern = typeof args.pattern === 'string' ? args.pattern : '';
  const parts = [`find ${pattern}`];
  const searchPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : null;
  if (searchPath) {
    parts.push(`in ${formatOriginalSearchPath(searchPath, cwd)}`);
  }
  if (typeof args.limit === 'number') {
    parts.push(`limit ${args.limit}`);
  }

  return parts.join(' ');
}

function formatCollapsedBuiltinFindText(output: string): string | null {
  const paths = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith('['));

  if (paths.length === 0) {
    return output.trim() === 'No files found matching pattern' ? '0 files' : null;
  }

  const lines = [`${paths.length} files`];
  for (const pathValue of paths.slice(0, 2)) {
    lines.push(`  · ${pathValue}`);
  }
  if (paths.length > 2) {
    lines.push(`    … ${paths.length - 2} more`);
  }
  return lines.join('\n');
}

function formatCollapsedBuiltinGrepText(output: string): string | null {
  const trimmed = output.trim();
  if (trimmed === 'No matches found') {
    return 'No matches';
  }

  const grouped = new Map<string, number>();
  let totalMatches = 0;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith('[')) {
      continue;
    }

    const match = line.match(/^(.+?):(\d+):/);
    if (!match) {
      continue;
    }

    const pathValue = match[1]!;
    grouped.set(pathValue, (grouped.get(pathValue) ?? 0) + 1);
    totalMatches += 1;
  }

  if (totalMatches === 0) {
    return null;
  }

  const files = [...grouped.entries()].sort(
    ([pathA, countA], [pathB, countB]) => countB - countA || pathA.localeCompare(pathB),
  );
  const lines = [`${files.length} files · ${totalMatches} matches`];
  for (const [pathValue, count] of files.slice(0, 2)) {
    lines.push(`  · ${pathValue} — ${count}`);
  }
  if (files.length > 2) {
    lines.push(`    … ${files.length - 2} more files`);
  }
  return lines.join('\n');
}

function wrapBuiltinCollapsedResultRenderer(args: {
  builtinRenderResult?:
    | ((result: any, options: any, theme: any, context?: any) => Component)
    | undefined;
  formatter: (output: string) => string | null;
}): (result: any, options: any, theme: any, context?: any) => Component {
  return (result, options, theme, context) => {
    if (options?.expanded || options?.isPartial) {
      return args.builtinRenderResult!(result, options, theme, context);
    }

    const output = extractPrimaryText(result?.content) ?? '';
    const collapsed = args.formatter(output);
    if (!collapsed) {
      return args.builtinRenderResult!(result, options, theme, context);
    }

    return new Text(styleResultText(collapsed, theme), 0, 0);
  };
}

function renderCollapsedReadResult(
  result: any,
  options: any,
  theme: any,
  context: any,
  builtinRenderResult?: (result: any, options: any, theme: any, context?: any) => Component,
): Component {
  if (!options?.expanded && !options?.isPartial && !context?.isError) {
    return new Text('', 0, 0);
  }
  return builtinRenderResult!(result, options, theme, context);
}

type ReadCallTheme = {
  bold: (text: string) => string;
  fg: (...args: any[]) => string;
};

type CompactReadClassification =
  | { kind: 'skill'; label: string }
  | { kind: 'package'; label: string }
  | { kind: 'gitchamber'; label: string }
  | { kind: 'resource'; label: string };

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function getReadPath(args: Record<string, unknown>): string {
  const rawPath = args.file_path ?? args.path;
  return typeof rawPath === 'string' ? rawPath : '';
}

function getNodePackageReadClassification(absolutePath: string): CompactReadClassification | null {
  const marker = '/node_modules/';
  const normalized = absolutePath.split(path.sep).join('/');
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) return null;

  const packagePath = normalized.slice(markerIndex + marker.length);
  const parts = packagePath.split('/').filter((part) => part.length > 0);
  const first = parts[0];
  if (!first) return null;

  if (first === '.gitchamber') {
    const sourcePath = parts.slice(1).join('/');
    return sourcePath ? { kind: 'gitchamber', label: sourcePath } : null;
  }

  if (first.startsWith('@')) {
    const second = parts[1];
    if (!second) return null;
    return { kind: 'package', label: [first, second, ...parts.slice(2)].join('/') };
  }

  return { kind: 'package', label: parts.join('/') };
}

function formatPathRelativeToCwdOrAbsolute(absolutePath: string, cwd?: string): string {
  if (!cwd) return absolutePath;
  const relativePath = path.relative(cwd, absolutePath);
  return relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
    ? toPosixPath(relativePath)
    : absolutePath;
}

function getCompactReadClassification(
  args: Record<string, unknown>,
  cwd?: string,
): CompactReadClassification | null {
  const rawPath = getReadPath(args);
  if (!rawPath) return null;

  const absolutePath = path.resolve(cwd ?? process.cwd(), rawPath);
  const fileName = path.basename(absolutePath);

  if (fileName === 'SKILL.md') {
    return { kind: 'skill', label: path.basename(path.dirname(absolutePath)) || fileName };
  }

  if (COMPACT_READ_RESOURCE_FILE_NAMES.has(fileName)) {
    return { kind: 'resource', label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
  }

  const packageClassification = getNodePackageReadClassification(absolutePath);
  if (packageClassification) return packageClassification;

  return null;
}

function formatBuiltinReadLineRange(args: Record<string, unknown>, theme: ReadCallTheme): string {
  if (args.offset === undefined && args.limit === undefined) {
    return '';
  }

  const startLine = typeof args.offset === 'number' ? args.offset : 1;
  const endLine = typeof args.limit === 'number' ? startLine + args.limit - 1 : '';
  return theme.fg('warning', `:${startLine}${endLine ? `-${endLine}` : ''}`);
}

function formatCompactReadCall(
  classification: CompactReadClassification,
  args: Record<string, unknown>,
  theme: ReadCallTheme,
  width?: number,
): string {
  const rawRange = (() => {
    if (args.offset === undefined && args.limit === undefined) return '';
    const startLine = typeof args.offset === 'number' ? args.offset : 1;
    const endLine = typeof args.limit === 'number' ? startLine + args.limit - 1 : '';
    return `:${startLine}${endLine ? `-${endLine}` : ''}`;
  })();
  const plainPrefix =
    classification.kind === 'skill'
      ? '[skill] '
      : `${formatCompactReadTitle(classification.kind)} `;
  const fixedWidth = plainPrefix.length + rawRange.length;
  const suffixChoice = chooseOptionalSuffix({
    width,
    fixedWidth,
    suffixes: DEFAULT_EXPAND_HINT_SUFFIXES,
    minPrimaryWidth: getCompactReadMinimumPrimaryWidth(classification),
    preferredPrimaryWidth: getCompactReadPreferredPrimaryWidth(classification, width, fixedWidth),
  });
  const displayLabel =
    Number.isFinite(suffixChoice.primaryBudget) && suffixChoice.primaryBudget > 0
      ? formatCompactReadLabel(classification, suffixChoice.primaryBudget)
      : classification.label;
  const expandHint = suffixChoice.suffix ? theme.fg('dim', suffixChoice.suffix) : '';

  if (classification.kind === 'skill') {
    return (
      theme.fg('customMessageLabel', `${theme.bold('[skill]')} `) +
      theme.fg('customMessageText', displayLabel) +
      formatBuiltinReadLineRange(args, theme) +
      expandHint
    );
  }

  return (
    theme.fg('toolTitle', theme.bold(formatCompactReadTitle(classification.kind))) +
    ' ' +
    theme.fg('accent', displayLabel) +
    formatBuiltinReadLineRange(args, theme) +
    expandHint
  );
}

function formatCompactReadLabel(
  classification: CompactReadClassification,
  primaryBudget: number,
): string {
  if (classification.kind === 'gitchamber') {
    return formatGitchamberReadLabel(classification.label, primaryBudget);
  }

  return normalizeCompactCollapsedPath(collapseMiddlePath(classification.label, primaryBudget));
}

function formatGitchamberReadLabel(label: string, primaryBudget: number): string {
  if (label.length <= primaryBudget) {
    return label;
  }

  const hostlessLabel = getHostlessGitchamberLabel(label);
  if (hostlessLabel.length <= primaryBudget) {
    return hostlessLabel;
  }

  return normalizeCompactCollapsedPath(collapseMiddlePath(hostlessLabel, primaryBudget));
}

function getHostlessGitchamberLabel(label: string): string {
  return label.startsWith('github.com/') ? label.slice('github.com/'.length) : label;
}

function formatCompactReadTitle(kind: CompactReadClassification['kind']): string {
  return kind === 'gitchamber' ? 'gitchamber' : `read ${kind}`;
}

function getCompactReadPreferredPrimaryWidth(
  classification: CompactReadClassification,
  width: number | undefined,
  fixedWidth: number,
): number {
  if (classification.kind !== 'gitchamber') {
    return classification.label.length;
  }

  const fullExpandHint = DEFAULT_EXPAND_HINT_SUFFIXES[0] ?? '';
  if (
    typeof width === 'number' &&
    Number.isFinite(width) &&
    fixedWidth + classification.label.length + fullExpandHint.length <= width
  ) {
    return classification.label.length;
  }

  return getHostlessGitchamberLabel(classification.label).length;
}

function getCompactReadMinimumPrimaryWidth(classification: CompactReadClassification): number {
  if (classification.kind !== 'gitchamber') {
    return 24;
  }

  const hostlessLabel = getHostlessGitchamberLabel(classification.label);
  const owner = hostlessLabel.split('/')[0] ?? '';
  const filename = hostlessLabel.split('/').pop() ?? '';
  return Math.max(24, Math.min(hostlessLabel.length, `${owner}/.../${filename}`.length));
}

function formatBuiltinReadCallSummary(
  args: Record<string, unknown>,
  theme: ReadCallTheme,
  cwd?: string,
  width?: number,
  showExpandHint = false,
): string {
  const compactClassification = showExpandHint ? getCompactReadClassification(args, cwd) : null;
  if (compactClassification) {
    return formatCompactReadCall(compactClassification, args, theme, width);
  }

  const title = theme.fg('toolTitle', theme.bold('read'));
  const pathValue = getReadPath(args);
  if (!pathValue) {
    return title;
  }

  const rawRange = (() => {
    if (args.offset === undefined && args.limit === undefined) {
      return '';
    }
    const startLine = typeof args.offset === 'number' ? args.offset : 1;
    const endLine = typeof args.limit === 'number' ? startLine + args.limit - 1 : '';
    return `:${startLine}${endLine ? `-${endLine}` : ''}`;
  })();
  const displayBasePath = showExpandHint ? shortenDisplayPath(pathValue, cwd) : pathValue;
  const suffixChoice = chooseOptionalSuffix({
    width,
    fixedWidth: 'read '.length + rawRange.length,
    suffixes: showExpandHint ? DEFAULT_EXPAND_HINT_SUFFIXES : [''],
    minPrimaryWidth: 24,
    preferredPrimaryWidth: displayBasePath.length,
  });
  const pathBudget = width ? suffixChoice.primaryBudget : 0;
  const displayPath =
    pathBudget > 0 ? collapseMiddlePath(displayBasePath, pathBudget) : displayBasePath;
  const expandHint = suffixChoice.suffix ? theme.fg('dim', suffixChoice.suffix) : '';

  return `${title} ${theme.fg('accent', displayPath)}${formatBuiltinReadLineRange(args, theme)}${expandHint}`;
}

function wrapBuiltinReadCallRenderer(args: {
  renderArgs: Record<string, unknown>;
  theme: ReadCallTheme;
  context?: { cwd?: string; expanded?: boolean };
}): Component {
  const cwd = args.context?.cwd;
  const showExpandHint = args.context?.expanded !== true;
  return createWidthAwareText((width) =>
    formatBuiltinReadCallSummary(args.renderArgs, args.theme, cwd, width, showExpandHint),
  );
}

function wrapBuiltinCallRenderer(args: {
  toolName: 'grep' | 'find';
  builtinRenderCall?: ((args: any, theme: any, context?: any) => Component) | undefined;
  renderArgs: Record<string, unknown>;
  theme: CompactCallTheme;
  context?: { cwd?: string; expanded?: boolean };
  rewriteSummary: string | null;
  compactRewriteSummary: CompactRewriteSummary | null;
}): Component {
  // Builtin renderCall implementations treat `context.lastComponent` as
  // their own cached inner primitive (a `Text`) and call `.setText(...)` on
  // it directly. We cannot forward the outer tool-render context through
  // because its `lastComponent` is the wrapper `Box` / width-aware text we
  // return from this function — calling `.setText(...)` on that would throw
  // `TypeError: text.setText is not a function`. Instead we keep a private
  // cache of whatever component the builtin returned last time and hand it
  // that so pi-tui's component-reuse optimization still works.
  let cachedBuiltinLastComponent: Component | undefined;
  const cwd = args.context?.cwd;
  return createWidthAwareText((width) => {
    const builtinContext = { cwd, lastComponent: cachedBuiltinLastComponent };
    const baseComponent = args.builtinRenderCall?.(args.renderArgs, args.theme, builtinContext);
    cachedBuiltinLastComponent = baseComponent;
    const baseText =
      baseComponent?.render(width).join('\n') ??
      formatBuiltinSearchCallSummary(args.toolName, args.renderArgs, cwd);
    if (!args.rewriteSummary || !args.compactRewriteSummary) {
      return baseText;
    }

    if (args.context?.expanded) {
      return [baseText, args.theme.fg('dim', `  via FFF: ${args.rewriteSummary}`)].join('\n');
    }

    return renderCompactSearchCall(args.compactRewriteSummary, width, args.theme);
  });
}

export function createPiFffSearchExtension(options: CreatePiFffSearchExtensionOptions = {}) {
  const ensureDaemon = options.ensureDaemonRunning ?? defaultEnsureDaemonRunning;
  const callTool = options.callPublicToolOverHttp ?? defaultCallPublicToolOverHttp;
  const runFallback = options.runRipgrepFallback ?? runLocalFallback;
  const overrideBuiltinRead = options.overrideBuiltinRead ?? OVERRIDE_BUILTIN_READ;
  const overrideBuiltinGrep = options.overrideBuiltinGrep ?? OVERRIDE_BUILTIN_GREP;
  const overrideBuiltinFind = options.overrideBuiltinFind ?? OVERRIDE_BUILTIN_FIND;
  const createBuiltInRead = options.createBuiltInReadTool ?? createReadToolDefinition;
  const createBuiltInGrep = options.createBuiltInGrepTool ?? createGrepToolDefinition;
  const createBuiltInFind = options.createBuiltInFindTool ?? createFindToolDefinition;
  const createBuiltInLs = options.createBuiltInLsTool ?? createLsToolDefinition;
  const findGitRootForReadFallback =
    options.findGitRootForReadFallback ?? defaultFindGitRootForReadFallback;

  return function piFffSearchExtension(pi: ExtensionAPI) {
    const builtInTemplates =
      overrideBuiltinRead || overrideBuiltinGrep || overrideBuiltinFind
        ? {
            read: createBuiltInRead(process.cwd()),
            grep: createBuiltInGrep(process.cwd()),
            find: createBuiltInFind(process.cwd()),
            ls: createBuiltInLs(process.cwd()),
          }
        : null;

    const unregisterBashRewriteProvider =
      pi.events?.on?.('bash-rewrite:collect-providers', (payload: unknown) => {
        if (!payload || typeof payload !== 'object') return;
        const register = (payload as { register?: unknown }).register;
        if (typeof register !== 'function') return;

        register({
          id: 'pi-fff-search',
          priority: 100,
          tools: ['fff_grep', 'fff_find_files'],
          fallbackOnExecuteError: true,
          async execute(
            decision: { tool: PublicToolName; params: Record<string, unknown> },
            runtime: { ctx: { cwd: string } },
          ) {
            if (decision.tool !== 'fff_grep' && decision.tool !== 'fff_find_files') {
              throw new Error(
                `Unsupported pi-fff-search bash rewrite target: ${String(decision.tool)}`,
              );
            }
            const forwarded = await forwardToolCall({
              toolName: decision.tool,
              params: decision.params,
              cwd: runtime.ctx.cwd,
              ensureDaemonRunning: ensureDaemon,
              callPublicToolOverHttp: callTool,
              runRipgrepFallback: runFallback,
            });
            return {
              content: [{ type: 'text' as const, text: forwarded.text }],
              details: forwarded.details,
            };
          },
          renderPreview(
            decision: { tool: 'fff_grep' | 'fff_find_files'; params: Record<string, unknown> },
            theme: CompactCallTheme,
            runtime: { cwd?: string },
          ) {
            const compact = buildCompactFffSearchSummary(
              decision.tool,
              decision.params,
              runtime.cwd,
              'bash',
            );
            return compact
              ? createWidthAwareText((width) => renderCompactSearchCall(compact, width, theme))
              : null;
          },
          renderResult(
            result: { content?: unknown },
            options: { expanded?: boolean },
            theme: { fg(color: string, text: string): string },
            context: { cwd?: string } | undefined,
          ) {
            const contentText = extractPrimaryText(result.content);
            if (!contentText) return null;
            const details = (result as { details?: { routedVia?: string } }).details;
            const toolName =
              details?.routedVia === 'bash-to-fff_find_files' ? 'fff_find_files' : 'fff_grep';
            return createWidthAwareText((width) => {
              const summary = options.expanded
                ? formatExpandedResultText(toolName, { contentText, cwd: context?.cwd, width })
                : formatCollapsedResultText(toolName, { contentText, cwd: context?.cwd, width });
              return styleResultText(summary, theme);
            });
          },
        });
      }) ?? (() => {});

    pi.on('session_shutdown', async () => {
      unregisterBashRewriteProvider();
    });

    pi.on('before_agent_start', async (event) => ({
      systemPrompt: `${event.systemPrompt}\n\n${SEARCH_TOOL_PROMPT}`,
    }));

    for (const tool of PI_TOOL_DEFINITIONS) {
      pi.registerTool(
        defineTool({
          name: tool.name,
          label: tool.name,
          description: tool.description,
          promptSnippet: tool.snippet,
          parameters: tool.inputSchema,
          async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const result = await forwardToolCall({
              toolName: tool.name,
              params: params as Record<string, unknown>,
              cwd: ctx.cwd,
              ensureDaemonRunning: ensureDaemon,
              callPublicToolOverHttp: callTool,
              runRipgrepFallback: runFallback,
            });

            const details = result.details as Record<string, unknown> | undefined;
            const scopeWarningText =
              details?.resultKind === 'scope_warning' &&
              typeof details.scopeWarningText === 'string'
                ? details.scopeWarningText
                : null;
            const content = [
              typeof details?.daemonRestartMessage === 'string'
                ? { type: 'text' as const, text: details.daemonRestartMessage }
                : null,
              scopeWarningText ? { type: 'text' as const, text: scopeWarningText } : null,
              typeof details?.searchNoticeMessage === 'string'
                ? { type: 'text' as const, text: details.searchNoticeMessage }
                : null,
              !scopeWarningText || result.text !== scopeWarningText
                ? { type: 'text' as const, text: result.text }
                : null,
            ].filter((entry): entry is { type: 'text'; text: string } => entry !== null);

            return {
              content,
              details: result.details,
            };
          },
          renderCall(args, theme, context) {
            if (tool.name === 'fff_grep' || tool.name === 'fff_find_files') {
              const compact = buildCompactFffSearchSummary(
                tool.name,
                args as Record<string, unknown>,
                context?.cwd,
              );
              if (compact) {
                return createWidthAwareText((width) =>
                  renderCompactSearchCall(compact, width, theme),
                );
              }
            }

            return createWidthAwareText((width) => {
              const lines = formatToolCallText(
                tool.name,
                args as Record<string, unknown>,
                {
                  cwd: context?.cwd,
                },
                width,
              ).split('\n');
              const [first = '', ...rest] = lines;
              return [
                theme.fg('toolTitle', theme.bold(first)),
                ...rest.map((line) => theme.fg('dim', line)),
              ].join('\n');
            });
          },
          renderResult(result, { expanded, isPartial }, theme, context) {
            const textBlocks = result.content
              .filter((entry): entry is { type: 'text'; text: string } => entry.type === 'text')
              .map((entry) => entry.text);
            const contentText = textBlocks[textBlocks.length - 1] ?? '';
            const details = result.details as Record<string, unknown> | undefined;
            const daemonRestartBlock =
              typeof details?.daemonRestartMessage === 'string'
                ? renderNoticeBlock(details.daemonRestartMessage, theme)
                : null;
            const searchNoticeBlock =
              typeof details?.searchNoticeMessage === 'string'
                ? renderInfoBlock(details.searchNoticeMessage, theme)
                : null;

            if (isPartial) {
              return new Text(
                theme.fg('warning', formatPartialResultText(tool.name, details)),
                0,
                0,
              );
            }

            if (details?.resultKind === 'scope_warning') {
              const warningText =
                typeof details.scopeWarningText === 'string'
                  ? details.scopeWarningText
                  : 'Warning: FFF unavailable for this within path only.';
              const warningBlock = expanded
                ? renderNoticeBlock(warningText, theme)
                : formatCompactScopeWarningText(theme);
              const structuredText =
                typeof details.fallbackText === 'string' ? details.fallbackText : null;
              if (!structuredText) {
                return new Text(
                  [daemonRestartBlock, warningBlock, searchNoticeBlock]
                    .filter(Boolean)
                    .join('\n\n'),
                  0,
                  0,
                );
              }
              return createWidthAwareText((width) => {
                const summary = expanded
                  ? formatExpandedResultText(tool.name, {
                      contentText: structuredText,
                      details: details as any,
                      cwd: context?.cwd,
                      width,
                    })
                  : formatCollapsedResultText(tool.name, {
                      contentText: structuredText,
                      details: details as any,
                      cwd: context?.cwd,
                      width,
                    });

                return [
                  daemonRestartBlock,
                  warningBlock,
                  searchNoticeBlock,
                  styleResultText(summary, theme),
                ]
                  .filter(Boolean)
                  .join('\n\n');
              });
            }

            if (contentText.startsWith('Error:')) {
              const firstLine = contentText.split('\n')[0] ?? 'Error:';
              return new Text(
                `${theme.fg('error', 'Search failed')}\n${theme.fg('dim', firstLine)}`,
                0,
                0,
              );
            }

            return createWidthAwareText((width) => {
              const text = expanded
                ? formatExpandedResultText(tool.name, {
                    contentText,
                    details: details as any,
                    cwd: context?.cwd,
                    width,
                  })
                : formatCollapsedResultText(tool.name, {
                    contentText,
                    details: details as any,
                    cwd: context?.cwd,
                    width,
                  });

              return [daemonRestartBlock, searchNoticeBlock, styleResultText(text, theme)]
                .filter(Boolean)
                .join('\n\n');
            });
          },
        }),
      );
    }

    if (overrideBuiltinRead && builtInTemplates) {
      pi.registerTool({
        ...builtInTemplates.read,
        renderCall(args, theme, context) {
          return wrapBuiltinReadCallRenderer({
            renderArgs: args as Record<string, unknown>,
            theme,
            context,
          });
        },
        renderResult(result, options, theme, context) {
          return renderCollapsedReadResult(
            result,
            options,
            theme,
            context,
            builtInTemplates.read.renderResult,
          );
        },
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const builtInRead = createBuiltInRead(ctx.cwd);

          try {
            return await builtInRead.execute(
              toolCallId,
              params,
              withBuiltinToolTimeout(signal),
              onUpdate,
              ctx,
            );
          } catch (error) {
            const requestedPath =
              typeof (params as Record<string, unknown>).path === 'string'
                ? ((params as Record<string, unknown>).path as string)
                : null;
            if (requestedPath && isReadIsDirectoryError(error)) {
              const rewritten = await rewriteReadToLs({
                requestedPath,
                toolCallId,
                signal,
                onUpdate,
                ctx,
                createBuiltInLs,
              });
              if (rewritten) {
                return rewritten;
              }
              throw error;
            }
            if (!requestedPath || !isReadResolutionError(error)) {
              throw error;
            }

            const resolutionParams = buildReadResolutionParams(requestedPath);
            if (!resolutionParams) {
              throw error;
            }

            try {
              const resolution = await forwardToolCall({
                toolName: 'fff_find_files',
                params: resolutionParams,
                cwd: ctx.cwd,
                ensureDaemonRunning: ensureDaemon,
                callPublicToolOverHttp: callTool,
                runRipgrepFallback: runFallback,
              });
              let resolvedPath = pickResolvedReadPath(requestedPath, resolution.text);
              let broadenedResolution = false;

              if (!resolvedPath) {
                const broadWithin = (await findGitRootForReadFallback(ctx.cwd)) ?? ctx.cwd;
                const broadResolutionParams = buildBroadReadResolutionParams(
                  requestedPath,
                  broadWithin,
                );
                if (broadResolutionParams) {
                  const broadResolution = await forwardToolCall({
                    toolName: 'fff_find_files',
                    params: broadResolutionParams,
                    cwd: ctx.cwd,
                    ensureDaemonRunning: ensureDaemon,
                    callPublicToolOverHttp: callTool,
                    runRipgrepFallback: runFallback,
                  });
                  resolvedPath = pickBroadenedReadPath(requestedPath, broadResolution.text);
                  broadenedResolution = resolvedPath !== null;
                }
              }

              if (!resolvedPath) {
                throw error;
              }

              return await builtInRead
                .execute(
                  toolCallId,
                  { ...(params as Record<string, unknown>), path: resolvedPath },
                  withBuiltinToolTimeout(signal),
                  onUpdate,
                  ctx,
                )
                .then((resolvedResult) => {
                  const firstTextBlock = resolvedResult.content.find(
                    (entry): entry is { type: 'text'; text: string } =>
                      entry.type === 'text' && typeof entry.text === 'string',
                  );
                  if (!firstTextBlock) {
                    return resolvedResult;
                  }

                  const fixedPath = formatFixedReadPath(resolvedPath, ctx.cwd);
                  const resolutionNotice = broadenedResolution
                    ? `\nAuto-resolved missing read path ${requestedPath} → ${fixedPath}.`
                    : '';
                  const updatedContent = resolvedResult.content.map((entry, index) =>
                    index === resolvedResult.content.indexOf(firstTextBlock)
                      ? entry.type === 'text'
                        ? {
                            ...entry,
                            text: `Path (fixed): ${fixedPath}${resolutionNotice}\n\n${entry.text}`,
                          }
                        : entry
                      : entry,
                  );

                  return {
                    ...resolvedResult,
                    content: updatedContent,
                    details:
                      resolvedResult.details && typeof resolvedResult.details === 'object'
                        ? {
                            ...resolvedResult.details,
                            routedVia: 'fff-then-builtin',
                            resolvedFromPath: requestedPath,
                            resolvedToPath: fixedPath,
                            broadenedResolution,
                          }
                        : {
                            routedVia: 'fff-then-builtin',
                            resolvedFromPath: requestedPath,
                            resolvedToPath: fixedPath,
                            broadenedResolution,
                          },
                  };
                });
            } catch (resolutionError) {
              if (resolutionError === error) {
                throw resolutionError;
              }
              throw error;
            }
          }
        },
      });
    }

    if (overrideBuiltinGrep && builtInTemplates) {
      pi.registerTool({
        ...builtInTemplates.grep,
        renderResult: wrapBuiltinCollapsedResultRenderer({
          builtinRenderResult: builtInTemplates.grep.renderResult,
          formatter: formatCollapsedBuiltinGrepText,
        }),
        renderCall(args, theme, context) {
          const fffParams = buildFffGrepParamsFromBuiltin(args as Record<string, unknown>);
          return wrapBuiltinCallRenderer({
            toolName: 'grep',
            builtinRenderCall: builtInTemplates.grep.renderCall,
            renderArgs: args as Record<string, unknown>,
            theme,
            context,
            rewriteSummary: fffParams
              ? formatFffRewriteSummary('grep', fffParams, context?.cwd)
              : null,
            compactRewriteSummary: fffParams
              ? buildCompactRewriteSummary('grep', fffParams, context?.cwd)
              : null,
          });
        },
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const builtInGrep = createBuiltInGrep(ctx.cwd);
          const fffParams = buildFffGrepParamsFromBuiltin(params as Record<string, unknown>);
          if (!fffParams) {
            return builtInGrep.execute(
              toolCallId,
              params,
              withBuiltinToolTimeout(signal),
              onUpdate,
              ctx,
            );
          }

          try {
            const result = await forwardToolCall({
              toolName: 'fff_grep',
              params: fffParams,
              cwd: ctx.cwd,
              ensureDaemonRunning: ensureDaemon,
              callPublicToolOverHttp: callTool,
              runRipgrepFallback: runFallback,
            });
            if (shouldUseBuiltinSearchFallback(result.details)) {
              return builtInGrep.execute(
                toolCallId,
                params,
                withBuiltinToolTimeout(signal),
                onUpdate,
                ctx,
              );
            }

            const contentText = convertFffTextToBuiltinSearchText('fff_grep', result.text);
            if (contentText === null) {
              return builtInGrep.execute(
                toolCallId,
                params,
                withBuiltinToolTimeout(signal),
                onUpdate,
                ctx,
              );
            }
            if (isEmptyBuiltinSearchText('fff_grep', contentText)) {
              return builtInGrep.execute(
                toolCallId,
                params,
                withBuiltinToolTimeout(signal),
                onUpdate,
                ctx,
              );
            }

            return {
              content: [{ type: 'text' as const, text: contentText }],
              details: undefined,
            };
          } catch {
            return builtInGrep.execute(
              toolCallId,
              params,
              withBuiltinToolTimeout(signal),
              onUpdate,
              ctx,
            );
          }
        },
      });
    }

    if (overrideBuiltinFind && builtInTemplates) {
      pi.registerTool({
        ...builtInTemplates.find,
        renderResult: wrapBuiltinCollapsedResultRenderer({
          builtinRenderResult: builtInTemplates.find.renderResult,
          formatter: formatCollapsedBuiltinFindText,
        }),
        renderCall(args, theme, context) {
          const fffParams = buildFffFindParamsFromBuiltin(args as Record<string, unknown>);
          return wrapBuiltinCallRenderer({
            toolName: 'find',
            builtinRenderCall: builtInTemplates.find.renderCall,
            renderArgs: args as Record<string, unknown>,
            theme,
            context,
            rewriteSummary: fffParams
              ? formatFffRewriteSummary('find', fffParams, context?.cwd)
              : null,
            compactRewriteSummary: fffParams
              ? buildCompactRewriteSummary('find', fffParams, context?.cwd)
              : null,
          });
        },
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const builtInFind = createBuiltInFind(ctx.cwd);
          const fffParams = buildFffFindParamsFromBuiltin(params as Record<string, unknown>);
          if (!fffParams) {
            return builtInFind.execute(
              toolCallId,
              params,
              withBuiltinToolTimeout(signal),
              onUpdate,
              ctx,
            );
          }

          try {
            const result = await forwardToolCall({
              toolName: 'fff_find_files',
              params: fffParams,
              cwd: ctx.cwd,
              ensureDaemonRunning: ensureDaemon,
              callPublicToolOverHttp: callTool,
              runRipgrepFallback: runFallback,
            });
            if (shouldUseBuiltinSearchFallback(result.details)) {
              return builtInFind.execute(
                toolCallId,
                params,
                withBuiltinToolTimeout(signal),
                onUpdate,
                ctx,
              );
            }

            const contentText = convertFffTextToBuiltinSearchText('fff_find_files', result.text);
            if (contentText === null) {
              return builtInFind.execute(
                toolCallId,
                params,
                withBuiltinToolTimeout(signal),
                onUpdate,
                ctx,
              );
            }
            if (isEmptyBuiltinSearchText('fff_find_files', contentText)) {
              return builtInFind.execute(
                toolCallId,
                params,
                withBuiltinToolTimeout(signal),
                onUpdate,
                ctx,
              );
            }

            return {
              content: [{ type: 'text' as const, text: contentText }],
              details: undefined,
            };
          } catch {
            return builtInFind.execute(
              toolCallId,
              params,
              withBuiltinToolTimeout(signal),
              onUpdate,
              ctx,
            );
          }
        },
      });
    }
  };
}

export async function forwardToolCall(args: {
  toolName: PublicToolName;
  params: Record<string, unknown>;
  cwd: string;
  ensureDaemonRunning: () => Promise<void>;
  callPublicToolOverHttp: (request: PublicToolRequest) => Promise<SearchCoordinatorResult>;
  runRipgrepFallback?: (args: {
    toolName: PublicToolName;
    resolvedWithin: string;
    publicRequest: PublicToolRequest;
  }) => Promise<RunLocalFallbackResult>;
}): Promise<{ text: string; details: Record<string, unknown> }> {
  const { normalizePublicToolInput, resolveWithinFromCaller } = await getFffRouterRuntime();
  const repairedParams = normalizeFffToolParams(args.toolName, args.params);
  const resolvedWithin = await resolveWithinFromCaller({
    callerCwd: args.cwd,
    within: typeof repairedParams.within === 'string' ? repairedParams.within : null,
  });
  if (!resolvedWithin.ok) {
    throw new Error(resolvedWithin.error.message);
  }

  const rewrittenBroadWithin = isBroadWithinScope(resolvedWithin.value.resolvedWithin)
    ? rewriteBroadWithinFromGlob({
        resolvedWithin: resolvedWithin.value.resolvedWithin,
        params: repairedParams,
      })
    : null;
  const effectiveResolvedWithin =
    rewrittenBroadWithin?.resolvedWithin ?? resolvedWithin.value.resolvedWithin;
  const effectiveParams = rewrittenBroadWithin?.params ?? repairedParams;

  const normalized = normalizePublicToolInput(args.toolName, {
    ...effectiveParams,
    within: effectiveResolvedWithin,
  });
  if (!normalized.ok) {
    throw new Error(normalized.error.message);
  }

  const baseDetails = {
    toolName: args.toolName,
    publicRequest: normalized.value,
    resolvedWithin: effectiveResolvedWithin,
  };

  if (isBroadWithinScope(effectiveResolvedWithin)) {
    return {
      text: formatBroadWithinFailureText(effectiveResolvedWithin),
      details: {
        ...baseDetails,
        resultKind: 'broad_scope_rejected',
      },
    };
  }

  const runFallback = args.runRipgrepFallback ?? runLocalFallback;
  const executeSearch = async (request: PublicToolRequest): Promise<PublicToolResult> => {
    await args.ensureDaemonRunning();
    const result = await args.callPublicToolOverHttp(request);
    if (!result.ok) {
      throw new Error(`${result.error.code}: ${result.error.message}`);
    }
    return result.value;
  };

  const executeSearchWithDaemonRetry = async (
    request: PublicToolRequest,
  ): Promise<PublicToolResult> => {
    try {
      return await executeSearch(request);
    } catch (error) {
      if (!isDaemonMismatchError(error)) {
        throw error;
      }

      daemonRestartMessage = DAEMON_RESTART_NOTICE;
      return executeSearch(request);
    }
  };

  let daemonRestartMessage: string | null = null;

  try {
    let resultValue = await executeSearchWithDaemonRetry(normalized.value);
    let regexRepairNotice: string | null = null;

    if (hasZeroStructuredResults(resultValue)) {
      const repairedRequest = repairSuspiciousGrepPatterns(normalized.value);
      if (repairedRequest) {
        try {
          const repairedResult = await executeSearchWithDaemonRetry(repairedRequest.request);
          if (!hasZeroStructuredResults(repairedResult)) {
            resultValue = repairedResult;
            regexRepairNotice = formatRegexRepairNotice(repairedRequest.repairs);
          }
        } catch {
          // Preserve the original empty result so the normal local fallback can still run.
        }
      }
    }

    let finalText = formatToolText(args.toolName, resultValue);
    let searchNoticeMessage: string | null = null;
    let zeroResultFallbackEngine: LocalFallbackEngine | null = null;
    let fallbackSpill: FallbackSpillInfo | null = null;

    if (hasZeroStructuredResults(resultValue)) {
      try {
        const fallback = await runFallback({
          toolName: args.toolName,
          resolvedWithin: effectiveResolvedWithin,
          publicRequest: normalized.value,
        });
        if (fallbackHasHits(fallback)) {
          finalText = fallback.text;
          const notices = [formatZeroResultFallbackNotice(fallback.engine, args.toolName)];
          const summaryNotice = formatFallbackSummaryNotice({
            total: fallback.totalMatches ?? 0,
            omitted: fallback.omittedMatches ?? 0,
          });
          if (summaryNotice) {
            notices.push(summaryNotice);
          }
          if (fallback.spill) {
            notices.push(formatFallbackSpillNotice(fallback.spill));
            fallbackSpill = fallback.spill;
          }
          searchNoticeMessage = notices.join('\n');
          zeroResultFallbackEngine = fallback.engine;
        }
      } catch {
        // Keep the original successful-but-empty FFF result when the fallback fails.
      }
    }

    if (regexRepairNotice) {
      searchNoticeMessage = searchNoticeMessage
        ? `${regexRepairNotice}\n${searchNoticeMessage}`
        : regexRepairNotice;
    }

    return {
      text: finalText,
      details: {
        ...baseDetails,
        ...(daemonRestartMessage ? { daemonRestarted: true, daemonRestartMessage } : {}),
        ...(searchNoticeMessage ? { searchNoticeMessage } : {}),
        ...(zeroResultFallbackEngine ? { zeroResultFallbackEngine } : {}),
        ...(fallbackSpill ? { fallbackSpill } : {}),
      },
    };
  } catch (error) {
    const parsed = parseErrorCodeAndMessage(error);
    if (parsed?.code !== 'OUTSIDE_ALLOWED_SCOPE') {
      throw error;
    }

    const warningTextBase = formatScopeWarningText({
      resolvedWithin: effectiveResolvedWithin,
    });

    try {
      const fallback = await runFallback({
        toolName: args.toolName,
        resolvedWithin: effectiveResolvedWithin,
        publicRequest: normalized.value,
      });
      const notices = [
        formatFallbackSummaryNotice({
          total: fallback.totalMatches ?? 0,
          omitted: fallback.omittedMatches ?? 0,
        }),
        fallback.spill ? formatFallbackSpillNotice(fallback.spill) : null,
      ].filter((value): value is string => Boolean(value));
      return {
        text: fallback.text,
        details: {
          ...baseDetails,
          resultKind: 'scope_warning',
          scopeWarningText: warningTextBase,
          fallbackText: fallback.text,
          fallbackEngine: fallback.engine,
          ...(notices.length > 0 ? { searchNoticeMessage: notices.join('\n') } : {}),
          ...(fallback.spill ? { fallbackSpill: fallback.spill } : {}),
          ...(daemonRestartMessage ? { daemonRestarted: true, daemonRestartMessage } : {}),
        },
      };
    } catch (fallbackError) {
      const fallbackMessage =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      const warningText = formatScopeWarningText({
        resolvedWithin: effectiveResolvedWithin,
        fallbackFailed: fallbackMessage,
      });
      return {
        text: warningText,
        details: {
          ...baseDetails,
          resultKind: 'scope_warning',
          scopeWarningText: warningText,
          ...(daemonRestartMessage ? { daemonRestarted: true, daemonRestartMessage } : {}),
        },
      };
    }
  }
}
