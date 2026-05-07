import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Text, type Component } from '@earendil-works/pi-tui';
import { type TSchema } from 'typebox';
import {
  createBashToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  defineTool,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import {
  PUBLIC_TOOL_DEFINITIONS,
  callPublicToolOverHttp as defaultCallPublicToolOverHttp,
  ensureDaemonRunning as defaultEnsureDaemonRunning,
  ENABLE_SEARCH_TERMS,
  findFilesInputSchema,
  grepInputSchema,
  normalizePublicToolInput,
  resolveWithinFromCaller,
  type PublicCompactFindFilesResult,
  type PublicCompactGrepResult,
  type PublicCompactSearchTermsResult,
  type PublicToolDefinition,
  type PublicToolName,
  type PublicToolRequest,
  type PublicToolResult,
  type SearchCoordinatorResult,
} from 'fff-router';
import { clampMatchText } from './match-heuristics';
import { tryRewriteBash, type RewriteDecision, type RewriteTool } from './bash-rewrite';
import {
  type FallbackSpillInfo,
  type LocalFallbackEngine,
  type RunLocalFallbackResult,
  runLocalFallback,
} from './fallback';
import {
  formatCollapsedResultText,
  formatExpandedResultText,
  formatToolCallText,
  shortenDisplayPath,
} from './rendering';

const SEARCH_TOOL_PROMPT = `For repository search, prefer \`fff_*\` tools first:

- \`fff_find_files\` — fuzzy file/path search; keep queries short and let \`glob\`, \`extensions\`, and \`exclude_paths\` do the narrowing
- \`fff_grep\` — default content search; pass one or more entries in \`patterns\` (OR-matched) plus a required \`literal\` boolean. Use \`literal: true\` for code search (quotes, braces, punctuation, whitespace all safe); use \`literal: false\` only when you genuinely need regex alternation or metacharacters. \`glob\` / \`extensions\` / \`exclude_paths\` prefilter files.

Examples:

- \`fff_find_files\`: {"query":"openssl header","within":"/opt/homebrew/lib","glob":"**/*.h","exclude_paths":["pkgconfig"]}
- \`fff_grep\`: {"patterns":["ActorAuth","actor_auth","PopulatedActorAuth"],"literal":true,"within":"src","extensions":["rs"],"exclude_paths":["tests"]}
- \`fff_grep\`: {"patterns":["plan(Request)?","build(Request)?"],"literal":false,"within":"~/src","glob":"src/**/*.ts","exclude_paths":["dist"]}

These tools return compact text with a \`base_path:\` header. \`fff_find_files\` returns one relative path per line. \`fff_grep\` returns \`path:line: text\` lines.

Fall back to builtin or shell tools only when \`fff_*\` is unavailable, failing, awkward for the query, or outside the active workspace or scope. Briefly say why when falling back.`;

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
// Re-writes grep / find / cat / ls / head-like commands inside a bash tool
// call to a direct call to the structured read / ls / fff_grep / fff_find_files
// tool. Unrecognized shapes pass through to the real bash tool unchanged.
const REWRITE_BUILTIN_BASH = true;
const BUILTIN_TOOL_TIMEOUT_MS = 10_000;

// Bash commands that we did NOT rewrite and that contain one of these
// tokens as a standalone word get capped at this timeout. Rationale: an
// unrestricted `grep -r . .` or `find / -name …` on a large tree can hang
// the agent session for minutes. If we failed to rewrite (unsupported
// flag shape, chained `&& foo`, etc.), capping forward progress is
// cheap insurance. The value is deliberately generous — short `--help`
// / `--version` runs complete in milliseconds; capping at 60s only
// matters for genuinely expensive invocations.
const EXPENSIVE_BASH_TOKENS: ReadonlySet<string> = new Set([
  'grep',
  'rg',
  'egrep',
  'fgrep',
  'find',
  'fd',
  'fdfind',
  'ag',
  'ack',
  // `tree` has no structured rewrite yet and tends to dump thousands
  // of lines at a monorepo root. Capping at 60s keeps an incidental
  // `tree .` from flooding the agent's context window.
  'tree',
]);
const PASS_THROUGH_EXPENSIVE_TIMEOUT_MS = 60_000;
// Word-boundary regex built once at module load. Matches e.g. `grep`,
// `git grep`, `| rg`, but NOT `grepper` or `findfile`.
const EXPENSIVE_BASH_TOKEN_PATTERN = new RegExp(
  `\\b(?:${[...EXPENSIVE_BASH_TOKENS].join('|')})\\b`,
);

const ALLOWLIST_HINTS = ['~/.pi', '~/.pi/agent', '~/.codex', '~/.claude', '~/.amp'];
const DAEMON_RESTART_NOTICE =
  'Notice: FFF daemon config changed; restarted the daemon and retried the search once.';

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
  rewriteBuiltinBash?: boolean;
  createBuiltInReadTool?: typeof createReadToolDefinition;
  createBuiltInGrepTool?: typeof createGrepToolDefinition;
  createBuiltInFindTool?: typeof createFindToolDefinition;
  createBuiltInLsTool?: typeof createLsToolDefinition;
  createBuiltInBashTool?: typeof createBashToolDefinition;
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

function formatTextMatchResult(
  result: PublicCompactSearchTermsResult | PublicCompactGrepResult,
): string {
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
      return formatFindFilesResult(result as PublicCompactFindFilesResult);
    case 'fff_search_terms':
    case 'fff_grep':
      return isRenderedTextResult(result)
        ? formatRenderedTextMatchResult(result)
        : formatTextMatchResult(result as PublicCompactSearchTermsResult | PublicCompactGrepResult);
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

function createWidthAwareText(renderForWidth: (width: number) => string): Component {
  return {
    render(width: number): string[] {
      return new Text(renderForWidth(width), 0, 0).render(width);
    },
    invalidate() {},
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

type BashExecuteParams = Parameters<ReturnType<typeof createBashToolDefinition>['execute']>;
type BashExecuteResult = Awaited<
  ReturnType<ReturnType<typeof createBashToolDefinition>['execute']>
>;

type ToolContentEntry = { type: 'text'; text: string } | { type: string; [key: string]: unknown };

async function dispatchBashRewrite(args: {
  decision: RewriteDecision;
  notice: string;
  originalCommand: string;
  toolCallId: string;
  signal: AbortSignal | undefined;
  onUpdate: BashExecuteParams[3];
  ctx: BashExecuteParams[4];
  ensureDaemon: () => Promise<void>;
  callTool: (request: PublicToolRequest) => Promise<SearchCoordinatorResult>;
  runFallback: (args: {
    toolName: PublicToolName;
    resolvedWithin: string;
    publicRequest: PublicToolRequest;
  }) => Promise<RunLocalFallbackResult>;
  createBuiltInRead: typeof createReadToolDefinition;
  createBuiltInLs: typeof createLsToolDefinition;
}): Promise<BashExecuteResult> {
  // The `rewriteCall` field carries the structured "grep → fff_grep(…)"
  // summary in `details` so telemetry / debug / session replay can recover
  // the exact call shape. We deliberately do NOT prepend it to the
  // visible text content: the TUI preview chip (renderBashRewritePreview)
  // already conveys source→target + params to the human, and
  // renderBashRewriteResult delegates body rendering to the target
  // tool's normal formatter on routedVia=bash-to-*. Duplicating the
  // notice into content caused a visible yellow line that shadowed
  // the clean fff-rendered body.
  const sharedDetails = {
    routedVia: `bash-to-${args.decision.tool}` as const,
    rewriteRecognizer: args.decision.recognizer,
    rewriteFromCommand: args.originalCommand,
    rewriteToParams: args.decision.params,
    rewriteCall: args.notice,
  };

  if (args.decision.tool === 'fff_grep' || args.decision.tool === 'fff_find_files') {
    const forwarded = await forwardToolCall({
      toolName: args.decision.tool,
      params: args.decision.params,
      cwd: args.ctx.cwd,
      ensureDaemonRunning: args.ensureDaemon,
      callPublicToolOverHttp: args.callTool,
      runRipgrepFallback: args.runFallback,
    });
    return {
      content: [{ type: 'text' as const, text: forwarded.text }],
      details: {
        ...forwarded.details,
        ...sharedDetails,
      } as BashExecuteResult['details'],
    };
  }

  if (args.decision.tool === 'read') {
    const builtInRead = args.createBuiltInRead(args.ctx.cwd);
    const result = await builtInRead.execute(
      args.toolCallId,
      args.decision.params as { path: string; offset?: number; limit?: number },
      withBuiltinToolTimeout(args.signal),
      args.onUpdate,
      args.ctx,
    );
    return mergeRewriteDetails(result, sharedDetails);
  }

  // ls
  const builtInLs = args.createBuiltInLs(args.ctx.cwd);
  const result = await builtInLs.execute(
    args.toolCallId,
    args.decision.params as { path?: string; limit?: number },
    withBuiltinToolTimeout(args.signal),
    args.onUpdate,
    args.ctx,
  );
  return mergeRewriteDetails(result, sharedDetails);
}

/**
 * Pass a builtin read / ls result through unchanged except for attaching
 * bash-rewrite metadata to `details`. Use this in the rewrite branches —
 * content stays clean (body renders via renderBashRewriteResult or the
 * target tool's own formatter); the rewrite story lives in `details`,
 * visible to the TUI via routing but not to the model as content text.
 */
function mergeRewriteDetails(
  result: BashExecuteResult,
  extraDetails: Record<string, unknown>,
): BashExecuteResult {
  return {
    ...result,
    details: {
      ...(result.details as Record<string, unknown> | undefined),
      ...extraDetails,
    } as BashExecuteResult['details'],
  };
}

/**
 * Prepend a bash-rewrite notice to a builtin-bash result without
 * routing to a structured tool. Used for notice-only classifier hits
 * (e.g. `cat -A` on BSD) and for timeout-capped pass-through commands
 * where we still want the raw bash output to reach the agent.
 */
function prependBashNotice(result: BashExecuteResult, notice: string): BashExecuteResult {
  return prependNoticeToContent(result, notice, { rewriteNoticeOnly: true });
}

/**
 * True when `command` contains any of grep / rg / find / fd / ag / ack
 * as a standalone word. Matches `git grep`, `| rg foo`, etc.; does NOT
 * match identifiers like `grepper` or filenames like `findfile.ts`.
 *
 * Exported for tests.
 */
export function bashCommandContainsExpensiveTool(command: string): boolean {
  return EXPENSIVE_BASH_TOKEN_PATTERN.test(command);
}

// ---- Bash-rewrite rendering (Feature 3) ----
//
// When a bash call gets rewritten to a structured tool, the agent (and
// the human watching the TUI) benefits from seeing the actual tool
// call shape rather than a raw shell command. These helpers:
//
//   - renderBashRewritePreview: at call time, peek at the command via
//     `tryRewriteBash`. If it would rewrite, show a compact one-line
//     header like `bash → fff_grep(pattern, within=src/, limit=10)` —
//     same visual convention for all four rewrite targets (fff_grep,
//     fff_find_files, read, ls). Returns null to fall through to the
//     builtin bash render when no rewrite matches.
//
//   - renderBashRewriteResult: at result time, look at
//     `details.routedVia`. For fff_grep / fff_find_files we delegate
//     to the fff formatter used for direct calls (rendering.ts).
//     For bash-to-read / bash-to-ls we invoke the target tool's own
//     `renderResult` via createReadToolDefinition / createLsToolDefinition,
//     so the body is indistinguishable from a direct native call
//     (syntax-highlighted file view, structured listing, etc.). The
//     rewrite chip header stays "bash → tool(…)" so provenance
//     remains visible to the human.
//
// The preview helper is pure-ish (no daemon / fs I/O beyond what
// `tryRewriteBash` does), safe to call on every re-render.

type BashRewriteRouting =
  | 'bash-to-fff_grep'
  | 'bash-to-fff_find_files'
  | 'bash-to-read'
  | 'bash-to-ls';

function extractBashCommand(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const cmd = (args as { command?: unknown }).command;
  return typeof cmd === 'string' ? cmd : null;
}

/** @internal exported for tests; not part of the stable API. */
export function renderBashRewritePreview(
  args: unknown,
  theme: { fg(color: string, text: string): string },
  cwd: string | undefined,
): Component | null {
  const command = extractBashCommand(args);
  if (!command) return null;
  const rewrite = tryRewriteBash(command, cwd ?? process.cwd());
  if (!rewrite || !rewrite.decision) return null;
  const d = rewrite.decision;
  const chip = theme.fg('dim', 'bash →');
  // All four rewrite targets share the same compact one-line chip format:
  //   `bash → tool(primary, key=value, flag, …)`
  // For fff_grep / fff_find_files we deliberately do NOT use rendering.ts's
  // `formatToolCallText` (the multi-line title + wrapped-metadata layout
  // used for direct calls) — a rewrite chip is scaffolding around the
  // underlying body render, so denser matches the read / ls convention
  // and saves vertical space.
  const summary = formatStructuredToolSignature(d.tool, d.params, cwd);
  return new Text(`${chip} ${summary}`, 0, 0);
}

/**
 * Compact one-line signature for any of the four rewrite target tools.
 * Mirrors rendering.ts's rules for "metadata worth surfacing"
 * (e.g. `literal` / `case-sensitive` only when non-default, `limit` only
 * when it differs from the fff default of 20) but lays them out
 * horizontally in keyword=value style.
 */
function formatStructuredToolSignature(
  tool: RewriteTool,
  params: Record<string, unknown>,
  cwd: string | undefined,
): string {
  const parts: string[] = [];
  const path = typeof params.path === 'string' ? params.path : undefined;
  if (tool === 'read') {
    if (path) parts.push(shortenDisplayPath(path, cwd));
    if (typeof params.offset === 'number') parts.push(`offset=${String(params.offset)}`);
    if (typeof params.limit === 'number') parts.push(`limit=${String(params.limit)}`);
    return `read(${parts.join(', ')})`;
  }
  if (tool === 'ls') {
    if (path) parts.push(shortenDisplayPath(path, cwd));
    if (typeof params.limit === 'number') parts.push(`limit=${String(params.limit)}`);
    return `ls(${parts.join(', ') || '.'})`;
  }
  if (tool === 'fff_grep' || tool === 'fff_find_files') {
    const primary =
      tool === 'fff_grep'
        ? (() => {
            const patterns = Array.isArray(params.patterns)
              ? (params.patterns as unknown[]).filter((p): p is string => typeof p === 'string')
              : [];
            if (patterns.length > 0) return patterns.join(' | ');
            return typeof params.pattern === 'string' ? params.pattern : '';
          })()
        : typeof params.query === 'string'
          ? params.query
          : '';
    if (primary) parts.push(primary);

    const within = typeof params.within === 'string' ? params.within : undefined;
    if (within) parts.push(`within=${shortenDisplayPath(within, cwd)}`);

    const glob = typeof params.glob === 'string' ? params.glob : undefined;
    if (glob) parts.push(`glob=${glob}`);

    // Non-default mode flags surface as bare words. Regex is the default;
    // `literal` only appears when opted in. Same convention as rendering.ts.
    if (tool === 'fff_grep') {
      if (params.literal === true) parts.push('literal');
      if (params.case_sensitive === true) parts.push('case-sensitive');
    }

    const extensions = Array.isArray(params.extensions)
      ? (params.extensions as unknown[]).filter((e): e is string => typeof e === 'string')
      : [];
    if (extensions.length > 0) parts.push(`ext=${extensions.join(',')}`);

    const exclude = Array.isArray(params.exclude_paths)
      ? (params.exclude_paths as unknown[]).filter((e): e is string => typeof e === 'string')
      : [];
    if (exclude.length > 0) parts.push(`exclude=${exclude.join(',')}`);

    // Only show limit when it's non-default (20 is fff's baseline).
    if (typeof params.limit === 'number' && params.limit !== 20) {
      parts.push(`limit=${String(params.limit)}`);
    }

    return `${tool}(${parts.join(', ')})`;
  }
  // Exhaustive: RewriteTool only has four variants, all handled above.
  // Throwing (rather than falling through silently) means any future
  // addition to RewriteTool shows up as a runtime error in tests instead
  // of a silent empty-chip regression.
  const exhaustive: never = tool;
  throw new Error(`formatStructuredToolSignature: unhandled tool ${String(exhaustive)}`);
}

/** @internal exported for tests; not part of the stable API. */
export function renderBashRewriteResult(
  result: { content?: unknown; details?: unknown },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: { fg(color: string, text: string): string },
  context:
    | {
        cwd?: string;
        lastComponent?: Component;
        showImages?: boolean;
      }
    | undefined,
): Component | null {
  const details = result.details as
    | { routedVia?: string; rewriteToParams?: Record<string, unknown> }
    | undefined;
  const routedVia = details?.routedVia as BashRewriteRouting | undefined;
  if (!routedVia) return null;

  // Structured search results: delegate to our own fff formatter.
  if (routedVia === 'bash-to-fff_grep' || routedVia === 'bash-to-fff_find_files') {
    const contentText = extractPrimaryText(result.content);
    if (!contentText) return null;
    const toolName = routedVia === 'bash-to-fff_grep' ? 'fff_grep' : 'fff_find_files';
    const expanded = options.expanded === true;
    return createWidthAwareText((width) => {
      const summary = expanded
        ? formatExpandedResultText(toolName, {
            contentText,
            cwd: context?.cwd,
            width,
          })
        : formatCollapsedResultText(toolName, {
            contentText,
            cwd: context?.cwd,
            width,
          });
      return styleResultText(summary, theme);
    });
  }

  // Built-in read/ls rewrites: delegate to the target tool's own
  // renderResult so the TUI shows syntax-highlighted file views,
  // icon-prefixed listings, etc. — exactly what the agent would see
  // if they had called read/ls directly. The target tool's renderer
  // needs `context.args` (the structured call params) which we stashed
  // in details.rewriteToParams when the rewrite dispatched.
  if (routedVia === 'bash-to-read' || routedVia === 'bash-to-ls') {
    const args = details?.rewriteToParams;
    if (!args) return null;
    const cwd = context?.cwd ?? process.cwd();
    const delegated =
      routedVia === 'bash-to-read' ? createReadToolDefinition(cwd) : createLsToolDefinition(cwd);
    // Narrow context to the shape the target tool's renderResult expects.
    // `lastComponent` is passed through (pi reuses components across renders);
    // `showImages` defaults to false since rewrite-rendered read outputs
    // are plain-text slices (images would have been in the raw content).
    const delegatedContext = {
      args: args as never,
      cwd,
      lastComponent: context?.lastComponent,
      showImages: context?.showImages ?? false,
    };
    const render = (delegated as { renderResult?: (...a: unknown[]) => Component | null })
      .renderResult;
    if (!render) return null;
    try {
      return render(result as never, options as never, theme as never, delegatedContext as never);
    } catch {
      // Any delegation failure (type mismatch from SDK updates, bad args,
      // etc.) falls through to the builtin bash render — never worse than
      // the pre-delegation state.
      return null;
    }
  }

  return null;
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

/**
 * If a pass-through (non-rewritten) bash command contains a search
 * tool known to run unbounded (grep/rg/find/…), wrap its AbortSignal
 * with a timeout so the agent session cannot wedge on a runaway
 * traversal. Returns null when no cap is needed, or a signal + warning
 * text otherwise. The warning is prepended to the command's output so
 * the agent sees why a long command may have been truncated.
 */
function capPassThroughBashSignal(
  command: string,
  signal: AbortSignal | undefined,
  timeoutMs: number = PASS_THROUGH_EXPENSIVE_TIMEOUT_MS,
): { signal: AbortSignal; warning: string } | null {
  if (!bashCommandContainsExpensiveTool(command)) return null;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const seconds = Math.round(timeoutMs / 1000);
  // Match how pi's own bash tool surfaces timeout intent: a compact
  // parenthetical rather than a paragraph. The agent already knows which
  // command ran; the only new information here is the bound.
  const warning = `(${seconds}s timeout)`;
  return { signal: combined, warning };
}

function prependNoticeToContent(
  result: { content: ReadonlyArray<unknown>; details?: unknown },
  notice: string,
  extraDetails: Record<string, unknown>,
): BashExecuteResult {
  const entries = result.content as ReadonlyArray<ToolContentEntry>;
  const first = entries[0];
  const updatedContent: ToolContentEntry[] =
    first && first.type === 'text'
      ? [
          { type: 'text' as const, text: `${notice}\n\n${(first as { text: string }).text}` },
          ...entries.slice(1),
        ]
      : [{ type: 'text' as const, text: notice }, ...entries];

  const mergedDetails = {
    ...(result.details && typeof result.details === 'object' ? result.details : {}),
    ...extraDetails,
  } as BashExecuteResult['details'];

  return {
    content: updatedContent as BashExecuteResult['content'],
    details: mergedDetails,
  };
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

function wrapBuiltinCallRenderer(args: {
  toolName: 'grep' | 'find';
  builtinRenderCall?: ((args: any, theme: any, context?: any) => Component) | undefined;
  renderArgs: Record<string, unknown>;
  theme: { fg: (...args: any[]) => string };
  context?: { cwd?: string };
  rewriteSummary: string | null;
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
    if (!args.rewriteSummary) {
      return baseText;
    }

    return [baseText, args.theme.fg('dim', `  via FFF: ${args.rewriteSummary}`)].join('\n');
  });
}

export function createPiFffSearchExtension(options: CreatePiFffSearchExtensionOptions = {}) {
  const ensureDaemon = options.ensureDaemonRunning ?? defaultEnsureDaemonRunning;
  const callTool = options.callPublicToolOverHttp ?? defaultCallPublicToolOverHttp;
  const runFallback = options.runRipgrepFallback ?? runLocalFallback;
  const overrideBuiltinRead = options.overrideBuiltinRead ?? OVERRIDE_BUILTIN_READ;
  const overrideBuiltinGrep = options.overrideBuiltinGrep ?? OVERRIDE_BUILTIN_GREP;
  const overrideBuiltinFind = options.overrideBuiltinFind ?? OVERRIDE_BUILTIN_FIND;
  const rewriteBuiltinBash = options.rewriteBuiltinBash ?? REWRITE_BUILTIN_BASH;
  const createBuiltInRead = options.createBuiltInReadTool ?? createReadToolDefinition;
  const createBuiltInGrep = options.createBuiltInGrepTool ?? createGrepToolDefinition;
  const createBuiltInFind = options.createBuiltInFindTool ?? createFindToolDefinition;
  const createBuiltInLs = options.createBuiltInLsTool ?? createLsToolDefinition;
  const createBuiltInBash = options.createBuiltInBashTool ?? createBashToolDefinition;
  const findGitRootForReadFallback =
    options.findGitRootForReadFallback ?? defaultFindGitRootForReadFallback;
  const builtInTemplates =
    overrideBuiltinRead || overrideBuiltinGrep || overrideBuiltinFind || rewriteBuiltinBash
      ? {
          read: createBuiltInRead(process.cwd()),
          grep: createBuiltInGrep(process.cwd()),
          find: createBuiltInFind(process.cwd()),
          ls: createBuiltInLs(process.cwd()),
          bash: createBuiltInBash(process.cwd()),
        }
      : null;

  return function piFffSearchExtension(pi: ExtensionAPI) {
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
              const warningBlock = renderNoticeBlock(warningText, theme);
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

    if (rewriteBuiltinBash && builtInTemplates) {
      const templates = builtInTemplates;
      pi.registerTool({
        ...templates.bash,
        renderCall(args, theme, context) {
          const preview = renderBashRewritePreview(args, theme, context?.cwd);
          if (preview) return preview;
          return templates.bash.renderCall!(args, theme, context);
        },
        renderResult(result, options, theme, context) {
          const pretty = renderBashRewriteResult(result, options, theme, context);
          if (pretty) return pretty;
          // templates.bash.renderResult has a narrower `result` type
          // (BashToolDetails-bound). At runtime the shape is compatible;
          // the cast just placates TS's variance check.
          return templates.bash.renderResult!(result as never, options, theme, context);
        },
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const builtInBash = createBuiltInBash(ctx.cwd);
          const command =
            typeof (params as Record<string, unknown>).command === 'string'
              ? ((params as Record<string, unknown>).command as string)
              : null;
          const rewrite = command ? tryRewriteBash(command, ctx.cwd) : null;
          if (!rewrite) {
            // No rewrite matched. Still cap pass-through commands that
            // contain grep/rg/find/etc. to protect against runaway
            // traversals in shapes we couldn't structurally map.
            const cap = command ? capPassThroughBashSignal(command, signal) : null;
            if (cap) {
              const result = await builtInBash.execute(
                toolCallId,
                params,
                cap.signal,
                onUpdate,
                ctx,
              );
              return prependBashNotice(result, cap.warning);
            }
            return builtInBash.execute(toolCallId, params, signal, onUpdate, ctx);
          }

          // Notice-only result: the classifier had no structured tool to
          // offer but wants to nudge the agent (e.g. BSD `cat -A` on
          // macOS). Run bash unchanged and prepend the notice to output.
          if (!rewrite.decision) {
            // Still cap expensive shapes even when a notice fires — a
            // cat -A FILE | grep foo pipeline should be capped too.
            const cap = command ? capPassThroughBashSignal(command, signal) : null;
            const effectiveSignal = cap?.signal ?? signal;
            const result = await builtInBash.execute(
              toolCallId,
              params,
              effectiveSignal,
              onUpdate,
              ctx,
            );
            const noticed = prependBashNotice(result, rewrite.notice);
            return cap ? prependBashNotice(noticed, cap.warning) : noticed;
          }

          try {
            return await dispatchBashRewrite({
              decision: rewrite.decision,
              notice: rewrite.notice,
              originalCommand: command!,
              toolCallId,
              signal,
              onUpdate,
              ctx,
              ensureDaemon,
              callTool,
              runFallback,
              createBuiltInRead,
              createBuiltInLs,
            });
          } catch {
            // Any failure in the structured path falls back to running the
            // original bash command unchanged, so the agent still makes
            // forward progress. Silent — the shell output itself is the
            // feedback the agent needs.
            return builtInBash.execute(toolCallId, params, signal, onUpdate, ctx);
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
  const resolvedWithin = await resolveWithinFromCaller({
    callerCwd: args.cwd,
    within: typeof args.params.within === 'string' ? args.params.within : null,
  });
  if (!resolvedWithin.ok) {
    throw new Error(resolvedWithin.error.message);
  }

  const rewrittenBroadWithin = isBroadWithinScope(resolvedWithin.value.resolvedWithin)
    ? rewriteBroadWithinFromGlob({
        resolvedWithin: resolvedWithin.value.resolvedWithin,
        params: args.params,
      })
    : null;
  const effectiveResolvedWithin =
    rewrittenBroadWithin?.resolvedWithin ?? resolvedWithin.value.resolvedWithin;
  const effectiveParams = rewrittenBroadWithin?.params ?? args.params;

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
