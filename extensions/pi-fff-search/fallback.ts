import { randomUUID } from 'node:crypto';
import { stat as statCallback, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { createFindToolDefinition, createGrepToolDefinition } from '@mariozechner/pi-coding-agent';
import picomatch from 'picomatch';
import type {
  PublicFindFilesRequest,
  PublicGrepRequest,
  PublicSearchTermsRequest,
  PublicToolName,
  PublicToolRequest,
} from 'fff-router';
import {
  clampMatchText,
  extensionForPath,
  isRiskyMatchPath,
  matchesAllowedExtensions,
} from './match-heuristics';

const MAX_FORMATTED_FALLBACK_TEXT_CHARS = 12_000;
const RAW_FALLBACK_SPILL_THRESHOLD_BYTES = 24_000;
// Hard ceiling on any single builtin grep/find invocation fired by the
// local fallback. The builtin itself respects `AbortSignal` but imposes
// no intrinsic timeout, and a runaway walk (symlink loop, very large
// tree, NFS hang) could otherwise pin the search indefinitely. 10s
// matches the prior `execFile({ timeout })` behaviour and is already
// generous for the scoped out-of-tree paths that hit the fallback.
const FALLBACK_COMMAND_TIMEOUT_MS = 10_000;
// Pull more candidates from the builtin than the caller's limit so our
// extension / exclude-path / scoring post-filter has enough raw hits to
// work with. 500 is far above typical LLM-driven limits (10-50) and well
// under rg's streaming throughput, so the cap is effectively "whatever
// the builtin finds."
const BUILTIN_FALLBACK_LIMIT = 500;
const PREFERRED_TEXT_MATCH_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.zig',
  '.md',
  '.sh',
  '.yaml',
  '.yml',
  '.toml',
]);

type StatLike = typeof statCallback;

// Builtin tool execution surface, narrowed to what pi-fff-search needs.
// We model it as plain `(params) => { content }` so tests can stub it
// without reproducing `ToolDefinition.execute`'s 5-arg signature.
type BuiltinTextBlock = { type: string; text?: string };
type BuiltinToolResult = { content: BuiltinTextBlock[]; details?: unknown };

type BuiltinGrepParams = {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  limit?: number;
};

type BuiltinFindParams = {
  pattern: string;
  path?: string;
  limit?: number;
};

type BuiltinGrepExecutor = (params: BuiltinGrepParams) => Promise<BuiltinToolResult>;
type BuiltinFindExecutor = (params: BuiltinFindParams) => Promise<BuiltinToolResult>;

type FallbackTextMatch = {
  path: string;
  line: number;
  text: string;
  raw: string;
};

// The fallback now always delegates to the builtin grep/find tools, which
// bootstrap `rg` / `fd` via `ensureTool`. The legacy `grep` / `find`
// engines were only reachable when the system lacked rg / fd AND had no
// network to bootstrap them; in practice pi-coding-agent handles that
// bootstrap, so the engine set narrows to the two modern tools.
export type LocalFallbackEngine = 'fd' | 'ripgrep';

export type FallbackSpillInfo = {
  path: string;
  bytes: number;
  lines: number;
};

export type RunLocalFallbackResult = {
  text: string;
  engine: LocalFallbackEngine;
  hasHits: boolean;
  spill?: FallbackSpillInfo;
  totalMatches?: number;
  omittedMatches?: number;
};

type RunLocalFallbackDeps = {
  runBuiltinGrep?: BuiltinGrepExecutor;
  runBuiltinFind?: BuiltinFindExecutor;
  spillText?: (rawText: string) => Promise<string>;
  rawSpillThresholdBytes?: number;
  stat?: StatLike;
};

function stripDotSlash(path: string): string {
  return path.replace(/^\.\//, '');
}

function escapeGlobLiteral(value: string): string {
  return value.replace(/([*?[\]{}])/g, '[$1]');
}

function matchesRequestedGlob(glob: string | undefined, relativePath: string): boolean {
  if (!glob) {
    return true;
  }

  return picomatch(glob, {
    dot: true,
    basename: !glob.includes('/'),
  })(stripDotSlash(relativePath).replace(/\\/g, '/'));
}

// Escape each regex metacharacter so a literal string can be safely
// embedded inside an alternation `|` group. Used to preserve literal-OR
// semantics when collapsing `patterns[]` for the builtin.
function escapeRegexLiteral(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
}

// The builtin grep accepts a single `pattern`. To preserve multi-pattern
// OR semantics we alternate-join the caller's patterns into one regex.
//   literal=true  + ['foo', 'bar(baz)']  -> regex='foo|bar\(baz\)'  (literal=false)
//   literal=false + ['a\s+b', 'c']       -> regex='(?:a\s+b)|(?:c)' (literal=false)
// A single pattern is passed through unchanged in both modes.
function combineGrepPatterns(
  patterns: string[],
  literal: boolean,
): { pattern: string; literal: boolean } {
  if (patterns.length <= 1) {
    return { pattern: patterns[0] ?? '', literal };
  }
  if (literal) {
    return { pattern: patterns.map(escapeRegexLiteral).join('|'), literal: false };
  }
  return { pattern: patterns.map((entry) => `(?:${entry})`).join('|'), literal: false };
}

// fff_find_files queries are whitespace-tokenized ("vim mode" => two
// tokens). fd matches them as a fuzzy-interleaved glob; reproduce that by
// composing `*token1*token2*` with each token glob-escaped. An empty
// query becomes `*` (match everything).
function buildFindGlobForQuery(query: string): string {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return '*';
  }
  return `*${tokens.map((token) => escapeGlobLiteral(token)).join('*')}*`;
}

function readBuiltinText(result: BuiltinToolResult): string {
  const firstText = result.content.find((entry) => entry.type === 'text')?.text;
  return typeof firstText === 'string' ? firstText : '';
}

function isBuiltinEmptyMarker(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === 'No matches found' || trimmed === 'No files found matching pattern';
}

// Strip the builtin grep / find tools' trailing truncation notice from
// their execute-path text. Both tools append a single-line `\n\n[<notice>]`
// block when they hit match / byte / line limits (see pi-coding-agent's
// `core/tools/grep.js` and `core/tools/find.js`). We surface our own
// truncation notices via the fallback summary pipeline, and we do not want
// the builtin's bracketed text reaching:
//
//   - `parseFallbackTextMatch`, where it parses as garbage but still
//     inflates `rawLines.length` used by the spill threshold check, or
//   - `runFindFilesFallback`'s candidate list, where a query containing
//     one of the notice's words (e.g. `limit`, `results`, `matches`,
//     `pattern`) could surface the bracketed notice as if it were a
//     real filename.
//
// The `\n\n` separator is load-bearing: it distinguishes the trailer from
// a legitimate bracketed filename such as `[draft].md` (files with square
// brackets are rare but legal on POSIX). We only strip when both the
// blank-line separator AND the bracket delimiters are present.
const BUILTIN_TRAILER_PATTERN = /\n\n\[[^\n]*\]\s*$/;

function stripBuiltinTrailer(text: string): string {
  const match = text.match(BUILTIN_TRAILER_PATTERN);
  return match ? text.slice(0, match.index) : text;
}

function splitBuiltinLines(text: string): string[] {
  if (!text || isBuiltinEmptyMarker(text)) {
    return [];
  }
  return stripBuiltinTrailer(text)
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

// rg auto-excludes `.git/` via gitignore handling, but neither rg nor fd
// know about jj; strip those here as a post-filter for both find and
// text fallbacks.
function hasJjPrefix(relativePath: string): boolean {
  return relativePath === '.jj' || relativePath.startsWith('.jj/');
}

// Default builtin executors wrap pi-coding-agent's ToolDefinition.execute.
// The builtin only uses `ctx` for custom SSH operations (unused here), so
// we feed undefined through that slot at runtime. The abort signal is
// how we enforce `FALLBACK_COMMAND_TIMEOUT_MS` — the builtin listens for
// abort and kills the underlying rg / fd child on timeout.
function createDefaultBuiltinGrep(): BuiltinGrepExecutor {
  const tool = createGrepToolDefinition(process.cwd());
  return async (params) =>
    (await tool.execute(
      `pi-fff-fallback-grep-${randomUUID()}`,
      params as never,
      AbortSignal.timeout(FALLBACK_COMMAND_TIMEOUT_MS),
      undefined,
      undefined as never,
    )) as BuiltinToolResult;
}

function createDefaultBuiltinFind(): BuiltinFindExecutor {
  const tool = createFindToolDefinition(process.cwd());
  return async (params) =>
    (await tool.execute(
      `pi-fff-fallback-find-${randomUUID()}`,
      params as never,
      AbortSignal.timeout(FALLBACK_COMMAND_TIMEOUT_MS),
      undefined,
      undefined as never,
    )) as BuiltinToolResult;
}

function fuzzyMatchPath(relativePath: string, query: string): boolean {
  const parts = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = relativePath.toLowerCase();
  return parts.every((part) => haystack.includes(part));
}

function scoreFindFileMatch(relativePath: string, query: string): number {
  const normalizedPath = relativePath.toLowerCase();
  const normalizedQuery = query.toLowerCase().trim();
  const basename = normalizedPath.split('/').pop() ?? normalizedPath;
  const parts = normalizedQuery.split(/\s+/).filter(Boolean);
  let score = 0;

  if (normalizedPath === normalizedQuery || basename === normalizedQuery) {
    score += 120;
  }
  if (basename.includes(normalizedQuery)) {
    score += 60;
  }
  if (normalizedPath.includes(normalizedQuery)) {
    score += 35;
  }
  score += parts.filter((part) => normalizedPath.includes(part)).length * 12;
  score -= normalizedPath.split('/').length * 3;
  score -= normalizedPath.length;
  return score;
}

function parseFallbackTextMatch(line: string): FallbackTextMatch | null {
  const match = line.match(/^(.+?):(\d+):(.*)$/);
  if (!match) {
    return null;
  }

  return {
    path: stripDotSlash(match[1] ?? ''),
    line: Number(match[2]),
    text: (match[3] ?? '').trimStart(),
    raw: line,
  };
}

function scoreFallbackTextMatch(match: FallbackTextMatch, request: PublicToolRequest): number {
  const normalizedPath = match.path.toLowerCase();
  const basename = normalizedPath.split('/').pop() ?? normalizedPath;
  const extension = extensionForPath(normalizedPath);
  const tokens =
    request.tool === 'fff_search_terms'
      ? request.terms.map((term) => term.toLowerCase()).filter(Boolean)
      : [];

  let score = 0;
  if (tokens.some((token) => basename.includes(token))) {
    score += 90;
  }
  if (tokens.some((token) => normalizedPath.includes(token))) {
    score += 45;
  }
  if (PREFERRED_TEXT_MATCH_EXTENSIONS.has(extension)) {
    score += 18;
  }
  if (isRiskyMatchPath(normalizedPath)) {
    score -= 90;
  }
  if (match.text.length > 4096) {
    score -= 70;
  } else if (match.text.length > 1024) {
    score -= 30;
  } else if (match.text.length > 400) {
    score -= 10;
  }
  score -= normalizedPath.split('/').length * 2;
  score -= Math.floor(normalizedPath.length / 40);
  return score;
}

function formatFallbackTextMatch(match: FallbackTextMatch): string {
  return `${match.path}:${match.line}: ${clampMatchText(match.text, match.path)}`;
}

function budgetTextLines(lines: string[], maxChars: number): { lines: string[]; omitted: number } {
  const kept: string[] = [];
  let used = 0;

  for (const line of lines) {
    const nextCost = line.length + (kept.length > 0 ? 1 : 0);
    if (kept.length > 0 && used + nextCost > maxChars) {
      break;
    }
    kept.push(line);
    used += nextCost;
  }

  return { lines: kept, omitted: Math.max(0, lines.length - kept.length) };
}

async function writeOversizeFallbackText(rawText: string): Promise<string> {
  const path = join(tmpdir(), `pi-fff-fallback-${Date.now()}-${randomUUID()}.txt`);
  await writeFile(path, rawText, { mode: 0o600 });
  return path;
}

function resolveHomePath(pathValue: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (pathValue === '~') {
    return home ?? pathValue;
  }
  if (pathValue.startsWith('~/') || pathValue.startsWith('~\\')) {
    return home ? join(home, pathValue.slice(2)) : pathValue;
  }
  return pathValue;
}

function resolveFallbackExcludePaths(resolvedWithin: string, excluded: string[]): string[] {
  return excluded
    .map((value) => resolveHomePath(value))
    .map((value) => {
      if (value.startsWith('./')) {
        return stripDotSlash(value);
      }
      if (value.startsWith('../')) {
        return null;
      }
      if (value.startsWith('/')) {
        const relativePath = relative(resolvedWithin, value);
        if (relativePath && !relativePath.startsWith('..') && relativePath !== '') {
          return stripDotSlash(relativePath);
        }
        return null;
      }
      return stripDotSlash(value);
    })
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function shouldExcludeRelativePath(relativePath: string, excluded: string[]): boolean {
  const normalized = stripDotSlash(relativePath).replace(/\\/g, '/');
  return excluded.some((value) => {
    const candidate = stripDotSlash(value).replace(/\\/g, '/').replace(/\/$/, '');
    return normalized === candidate || normalized.startsWith(`${candidate}/`);
  });
}

type FallbackScope = {
  cwd: string;
  searchTarget: string;
  basePath: string;
  isFile: boolean;
  displayPath: string;
};

async function resolveFallbackScope(
  resolvedWithin: string,
  statImpl: StatLike,
): Promise<FallbackScope> {
  try {
    const stats = await statImpl(resolvedWithin);
    if (stats.isFile()) {
      return {
        cwd: dirname(resolvedWithin),
        searchTarget: basename(resolvedWithin),
        basePath: resolvedWithin,
        isFile: true,
        displayPath: basename(resolvedWithin),
      };
    }
  } catch {
    // Fall back to treating the path as a directory-like scope in tests or
    // when the path disappears between validation and execution.
  }

  return {
    cwd: resolvedWithin,
    searchTarget: '.',
    basePath: resolvedWithin,
    isFile: false,
    displayPath: '.',
  };
}

async function finalizeTextFallback(args: {
  rawText: string;
  request: PublicSearchTermsRequest | PublicGrepRequest;
  basePath: string;
  excluded: string[];
  spillText: (rawText: string) => Promise<string>;
  rawSpillThresholdBytes: number;
}): Promise<RunLocalFallbackResult> {
  // Strip the builtin's trailer once so the spill file, byte count, and
  // line count all reflect the actual match payload. `splitBuiltinLines`
  // also strips it defensively, but doing it here means the trailer never
  // reaches `spillText` either.
  const cleanText = stripBuiltinTrailer(args.rawText);
  const rawLines = splitBuiltinLines(cleanText);
  const rawBytes = Buffer.byteLength(cleanText, 'utf8');
  const spill =
    rawBytes > args.rawSpillThresholdBytes
      ? {
          path: await args.spillText(cleanText),
          bytes: rawBytes,
          lines: rawLines.length,
        }
      : undefined;

  const parsed = rawLines
    .map((line) => parseFallbackTextMatch(line))
    .filter((match): match is FallbackTextMatch => match !== null)
    .filter((match) => !hasJjPrefix(match.path))
    .filter((match) => matchesRequestedGlob(args.request.glob, match.path))
    .filter((match) => !shouldExcludeRelativePath(match.path, args.excluded))
    .filter((match) => matchesAllowedExtensions(match.path, args.request.extensions))
    .sort((left, right) => {
      const scoreDiff =
        scoreFallbackTextMatch(right, args.request) - scoreFallbackTextMatch(left, args.request);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      return left.path.localeCompare(right.path) || left.line - right.line;
    });

  const formatted = parsed.map((match) => formatFallbackTextMatch(match));
  const budgeted = budgetTextLines(
    formatted.slice(0, args.request.limit),
    MAX_FORMATTED_FALLBACK_TEXT_CHARS,
  );
  const hasHits = budgeted.lines.length > 0;

  return {
    engine: 'ripgrep',
    hasHits,
    spill,
    totalMatches: parsed.length,
    omittedMatches: Math.max(0, parsed.length - budgeted.lines.length),
    text: `base_path: ${args.basePath}\n\n${hasHits ? budgeted.lines.join('\n') : '(no matches)'}`,
  };
}

async function runFindFilesFallback(args: {
  request: PublicFindFilesRequest;
  scope: FallbackScope;
  excluded: string[];
  runBuiltinFind: BuiltinFindExecutor;
  spillText: (rawText: string) => Promise<string>;
  rawSpillThresholdBytes: number;
}): Promise<RunLocalFallbackResult> {
  // File-scoped `within`: the builtin find expects a directory, so we
  // evaluate the single-candidate match directly without delegating.
  if (args.scope.isFile) {
    const candidate = args.scope.displayPath;
    const matches =
      matchesRequestedGlob(args.request.glob, candidate) &&
      !shouldExcludeRelativePath(candidate, args.excluded) &&
      matchesAllowedExtensions(candidate, args.request.extensions) &&
      fuzzyMatchPath(candidate, args.request.query);
    return {
      engine: 'fd',
      hasHits: matches,
      totalMatches: matches ? 1 : 0,
      omittedMatches: 0,
      text: `base_path: ${args.scope.basePath}\n\n${matches ? candidate : '(no files found)'}`,
    };
  }

  const builtinResult = await args.runBuiltinFind({
    pattern: buildFindGlobForQuery(args.request.query),
    path: args.scope.cwd,
    limit: BUILTIN_FALLBACK_LIMIT,
  });
  const candidates = splitBuiltinLines(readBuiltinText(builtinResult)).map((item) =>
    stripDotSlash(item),
  );

  const filtered = candidates
    .filter((item) => item.length > 0)
    .filter((item) => !hasJjPrefix(item))
    .filter((item) => matchesRequestedGlob(args.request.glob, item))
    .filter((item) => !shouldExcludeRelativePath(item, args.excluded))
    .filter((item) => matchesAllowedExtensions(item, args.request.extensions))
    .filter((item) => fuzzyMatchPath(item, args.request.query))
    .sort((left, right) => {
      const leftScore = scoreFindFileMatch(left, args.request.query);
      const rightScore = scoreFindFileMatch(right, args.request.query);
      return rightScore !== leftScore ? rightScore - leftScore : left.localeCompare(right);
    })
    .slice(0, args.request.limit);

  const text = `base_path: ${args.scope.basePath}\n\n${
    filtered.length > 0 ? filtered.join('\n') : '(no files found)'
  }`;
  const textBytes = Buffer.byteLength(text, 'utf8');
  const spill =
    textBytes > args.rawSpillThresholdBytes
      ? {
          path: await args.spillText(text),
          bytes: textBytes,
          lines: Math.max(filtered.length, 1),
        }
      : undefined;

  return {
    engine: 'fd',
    hasHits: filtered.length > 0,
    spill,
    totalMatches: filtered.length,
    omittedMatches: 0,
    text,
  };
}

async function runTextFallback(args: {
  toolName: 'fff_search_terms' | 'fff_grep';
  request: PublicSearchTermsRequest | PublicGrepRequest;
  scope: FallbackScope;
  excluded: string[];
  runBuiltinGrep: BuiltinGrepExecutor;
  spillText: (rawText: string) => Promise<string>;
  rawSpillThresholdBytes: number;
}): Promise<RunLocalFallbackResult> {
  // Normalize the two request shapes into the same triple (patterns,
  // literal, caseSensitive) so downstream logic doesn't have to branch.
  const isSearchTerms = args.toolName === 'fff_search_terms';
  const sourcePatterns = isSearchTerms
    ? (args.request as PublicSearchTermsRequest).terms
    : (args.request as PublicGrepRequest).patterns;
  const literalMode = isSearchTerms ? true : ((args.request as PublicGrepRequest).literal ?? false);
  const caseSensitive = isSearchTerms
    ? true
    : ((args.request as PublicGrepRequest).caseSensitive ?? true);

  const { pattern, literal } = combineGrepPatterns(sourcePatterns, literalMode);
  if (!pattern) {
    return {
      engine: 'ripgrep',
      hasHits: false,
      totalMatches: 0,
      omittedMatches: 0,
      text: `base_path: ${args.scope.basePath}\n\n(no matches)`,
    };
  }

  // When the caller scopes `within` to a single file, pass the file path
  // directly so rg searches just that file; otherwise scope to the cwd
  // and let the builtin walk it.
  const searchPath = args.scope.isFile ? args.scope.basePath : args.scope.cwd;
  const builtinResult = await args.runBuiltinGrep({
    pattern,
    path: searchPath,
    literal,
    ignoreCase: !caseSensitive,
    glob: args.request.glob,
    limit: BUILTIN_FALLBACK_LIMIT,
  });
  const builtinText = readBuiltinText(builtinResult);

  return finalizeTextFallback({
    rawText: isBuiltinEmptyMarker(builtinText) ? '' : builtinText,
    request: args.request,
    basePath: args.scope.basePath,
    excluded: args.excluded,
    spillText: args.spillText,
    rawSpillThresholdBytes: args.rawSpillThresholdBytes,
  });
}

export async function runLocalFallback(
  args: {
    toolName: PublicToolName;
    resolvedWithin: string;
    publicRequest: PublicToolRequest;
  },
  deps: RunLocalFallbackDeps = {},
): Promise<RunLocalFallbackResult> {
  const statImpl = deps.stat ?? statCallback;
  const scope = await resolveFallbackScope(args.resolvedWithin, statImpl);
  const excluded = resolveFallbackExcludePaths(scope.cwd, args.publicRequest.excludePaths);
  const runBuiltinGrep = deps.runBuiltinGrep ?? createDefaultBuiltinGrep();
  const runBuiltinFind = deps.runBuiltinFind ?? createDefaultBuiltinFind();
  const spillText = deps.spillText ?? writeOversizeFallbackText;
  const rawSpillThresholdBytes = deps.rawSpillThresholdBytes ?? RAW_FALLBACK_SPILL_THRESHOLD_BYTES;

  if (args.toolName === 'fff_find_files') {
    return runFindFilesFallback({
      request: args.publicRequest as PublicFindFilesRequest,
      scope,
      excluded,
      runBuiltinFind,
      spillText,
      rawSpillThresholdBytes,
    });
  }

  return runTextFallback({
    toolName: args.toolName as 'fff_search_terms' | 'fff_grep',
    request: args.publicRequest as PublicSearchTermsRequest | PublicGrepRequest,
    scope,
    excluded,
    runBuiltinGrep,
    spillText,
    rawSpillThresholdBytes,
  });
}
