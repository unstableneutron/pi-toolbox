import os from 'node:os';
import path from 'node:path';
import { parse as shellParse, type ControlOperator, type ParseEntry } from 'shell-quote';
import { tryRewriteApplyPatchCliBash } from './apply-patch';

/**
 * Decide whether a bash command string collapses to a safe, structured tool call.
 *
 * Scope (v1):
 *   - Simple single commands: `cat`, `ls`, `grep`, `find`, `head`, `rg`, `fd`, `egrep`, `fgrep`.
 *   - Two-stage pipelines of the form `<search> | head -N` where `<search>` is one
 *     of the recognized tools; the `head -N` folds into `limit: N`.
 *   - A defensive-read idiom `find <path> [-type f] | head -1 | xargs cat [| head -N]`
 *     collapses to `read <path> [limit=N]`.
 *   - Narrow safety/navigation prefixes: optional shebang, standalone `set -e` /
 *     `set -euo pipefail`-style preambles, and simple leading `cd <path>`
 *     commands before the recognized work command.
 *
 * Every other shape — chained `&&`/`||`/`;` (beyond a leading `cd <path> &&` prefix),
 * non-trivial redirects, command substitution, subshells, background jobs — passes
 * through untouched. See bash-rewrite.test.ts for the behavior corpus.
 */

export type RewriteTool = 'fff_grep' | 'fff_find_files' | 'read' | 'ls' | 'apply_patch';

export interface RewriteDecision {
  tool: RewriteTool;
  params: Record<string, unknown>;
  /** Which recognizer fired. Useful for tests and debug telemetry. */
  recognizer: string;
}

export interface RewriteResult {
  /**
   * Structured tool call to dispatch. Omit for notice-only results:
   * the original bash command still runs, but the notice is prepended
   * to its output so the agent sees actionable advice without a hard
   * rewrite. Used for shapes like BSD-incompatible `cat -A`, where we
   * cannot cleanly map to a structured tool but still want to nudge.
   */
  decision?: RewriteDecision;
  notice: string;
  /** Effective cwd after a safe leading `cd <path> &&`/`;`/newline prefix. */
  cwd?: string;
}

export interface BashReadOperation {
  path: string;
  offset?: number | undefined;
  limit?: number | undefined;
  recognizer: string;
}

export interface BashReadOperationsResult {
  operations: BashReadOperation[];
  /** Effective cwd after a safe leading `cd <path> &&`/`;`/newline prefix. */
  cwd?: string | undefined;
}

interface RewriteOptions {
  enabledTools?: Iterable<string> | ((toolName: RewriteTool) => boolean);
}

interface NormalizedRewriteCommand {
  command: string;
  cwd: string;
  explicitCwd: boolean;
}

function normalizeRewriteCommand(cmd: string, cwd: string): NormalizedRewriteCommand {
  let rest = cmd.trimStart();
  let effectiveCwd = cwd;
  let explicitCwd = false;

  if (rest.startsWith('#!')) {
    const newlineIndex = rest.indexOf('\n');
    if (newlineIndex === -1) return { command: cmd, cwd, explicitCwd: false };
    rest = rest.slice(newlineIndex + 1).trimStart();
  }

  for (;;) {
    const stripped = stripSupportedSetPreamble(rest);
    if (stripped === null) break;
    rest = stripped.trimStart();
  }

  for (;;) {
    const cd = parseLeadingCdNavigation(rest);
    if (!cd) break;
    effectiveCwd = resolveCdTarget(effectiveCwd, cd.target);
    explicitCwd = true;
    rest = rest.slice(cd.endIndex).trimStart();
  }

  return { command: rest, cwd: effectiveCwd, explicitCwd };
}

function stripSupportedSetPreamble(input: string): string | null {
  const newlineIndex = input.search(/\r?\n/);
  const semicolonIndex = input.indexOf(';');
  const endIndex = [newlineIndex, semicolonIndex]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (endIndex === undefined) return null;

  const line = input.slice(0, endIndex).trim();
  if (!isSupportedSetPreamble(line)) return null;

  const separatorLength = input[endIndex] === '\r' && input[endIndex + 1] === '\n' ? 2 : 1;
  return input.slice(endIndex + separatorLength);
}

function isSupportedSetPreamble(line: string): boolean {
  let tokens: ParseEntry[];
  try {
    tokens = shellParse(line);
  } catch {
    return false;
  }

  if (tokens.length < 2 || tokens[0] !== 'set') return false;
  if (!tokens.every((token) => typeof token === 'string')) return false;

  const args = (tokens as string[]).slice(1);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (/^-[eu]+$/.test(arg)) continue;
    if (/^-[euo]+$/.test(arg) && arg.includes('o')) {
      if (args[i + 1] !== 'pipefail') return false;
      i += 1;
      continue;
    }
    if (arg === '-o') {
      if (args[i + 1] !== 'pipefail') return false;
      i += 1;
      continue;
    }
    return false;
  }
  return true;
}

function parseLeadingCdNavigation(input: string): { target: string; endIndex: number } | null {
  let i = 0;
  while (input[i] === ' ' || input[i] === '\t') i += 1;
  if (input.slice(i, i + 2) !== 'cd') return null;
  i += 2;
  if (input[i] !== ' ' && input[i] !== '\t') return null;
  while (input[i] === ' ' || input[i] === '\t') i += 1;

  const word = readShellWord(input, i);
  if (!word) return null;
  let j = word.endIndex;
  while (input[j] === ' ' || input[j] === '\t') j += 1;

  let endIndex: number | null = null;
  if (input.startsWith('&&', j)) {
    endIndex = j + 2;
  } else if (input[j] === ';') {
    endIndex = j + 1;
  } else if (input[j] === '\n') {
    endIndex = j + 1;
  } else if (input[j] === '\r' && input[j + 1] === '\n') {
    endIndex = j + 2;
  }
  if (endIndex === null) return null;

  let tokens: ParseEntry[];
  try {
    tokens = shellParse(`cd ${word.raw}`);
  } catch {
    return null;
  }
  if (tokens.length !== 2 || tokens[0] !== 'cd' || typeof tokens[1] !== 'string') return null;

  const target = tokens[1];
  if (!target || target === '-' || target.startsWith('-')) return null;
  return { target, endIndex };
}

function readShellWord(
  input: string,
  startIndex: number,
): { raw: string; endIndex: number } | null {
  let i = startIndex;
  let quote: 'single' | 'double' | null = null;
  let escaped = false;

  while (i < input.length) {
    const ch = input[i]!;
    if (quote === 'single') {
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (quote === 'double') {
      if (escaped) {
        escaped = false;
        i += 1;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        i += 1;
        continue;
      }
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }

    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === "'") {
      quote = 'single';
      i += 1;
      continue;
    }
    if (ch === '"') {
      quote = 'double';
      i += 1;
      continue;
    }
    if (/\s/.test(ch) || ch === ';' || ch === '&' || ch === '|') break;
    i += 1;
  }

  if (quote !== null || i === startIndex) return null;
  return { raw: input.slice(startIndex, i), endIndex: i };
}

function resolveCdTarget(cwd: string, target: string): string {
  if (target === '~') return os.homedir();
  if (target.startsWith('~/')) return path.resolve(os.homedir(), target.slice(2));
  if (path.isAbsolute(target)) return path.resolve(target);
  return path.resolve(cwd, target);
}

function withEffectiveCwd(
  result: RewriteResult,
  normalized: NormalizedRewriteCommand,
): RewriteResult {
  return normalized.explicitCwd ? { ...result, cwd: normalized.cwd } : result;
}

const GLOB_META_PATTERN = /[*?[\]{}!]/;
const FIND_QUERY_GENERIC_TOKENS = new Set([
  'd',
  'test',
  'tests',
  'spec',
  'specs',
  // JavaScript / TypeScript family.
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  // Data / config formats.
  'json',
  'md',
  'mdx',
  'txt',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'xml',
  'csv',
  'tsv',
  'lock',
  // Other widely used language extensions. Adding these ensures a glob
  // like `*router*.go` reduces to the useful token (`router`) instead of
  // `"router go"`, which pollutes fuzzy matching. The structural
  // `isExtensionOnlyGlob` check handles the pure `*.EXT` case separately;
  // this list handles composite patterns.
  'go',
  'py',
  'rs',
  'rb',
  'java',
  'kt',
  'scala',
  'swift',
  'c',
  'h',
  'cc',
  'hh',
  'cpp',
  'hpp',
  'cxx',
  'hxx',
  'm',
  'mm',
  'sh',
  'bash',
  'zsh',
  'fish',
  'css',
  'scss',
  'sass',
  'less',
  'html',
  'htm',
  'vue',
  'svelte',
  'astro',
  'sql',
  'proto',
  'graphql',
  'gql',
  'php',
  'pl',
  'pm',
  'lua',
  'ex',
  'exs',
  'erl',
  'hs',
  'clj',
  'cljs',
  'zig',
  'dart',
]);

/**
 * First tokens that could possibly lead to a rewrite. Everything else (pnpm, git,
 * node, bash, python3, sh, for, if, while, env, echo, printf, etc.) is rejected
 * before we even spin up the shell-quote parser.
 *
 * `cd` is included because we legitimately rewrite `cd <path> && <tool> …` chain
 * prefixes — the full token walk downstream re-validates that shape.
 */
const FIRST_TOKEN_ALLOWLIST: ReadonlySet<string> = new Set([
  'cat',
  'ls',
  'head',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'find',
  'fd',
  'sed',
  'cd',
]);

/** Commands longer than this are assumed to be heredocs / inline scripts and skipped. */
const MAX_REWRITE_CANDIDATE_LENGTH = 4096;

/**
 * Absolute-path prefixes for the standard binary locations Claude Code,
 * zsh, and a handful of other setups prepend when invoking builtin tools
 * (e.g. `/usr/bin/grep`, `/opt/homebrew/bin/rg`). Stripped during
 * classification so the downstream recognizers only see bare names.
 *
 * Keep this list tight: expanding it to every directory on `$PATH` would
 * start matching user-installed tools that happen to share a name with a
 * builtin but behave differently.
 */
const BINARY_PATH_PREFIX_PATTERN =
  /^(?:\/usr\/local\/bin\/|\/opt\/homebrew\/bin\/|\/usr\/bin\/|\/bin\/)/;

function stripBinaryPathPrefix(token: string): string {
  return token.replace(BINARY_PATH_PREFIX_PATTERN, '');
}

/**
 * Match the first program-like token, ignoring leading whitespace. Tolerates
 * two common prefixes that otherwise cause false-negative gate rejections:
 *   - `command <tool>` — shell builtin that bypasses aliases/functions.
 *     We only strip when followed by a bare identifier; `command` as a
 *     verb in other contexts (e.g. `command &&`) is rejected by the
 *     identifier capture below.
 *   - `/usr/bin/<tool>` (and friends) — see BINARY_PATH_PREFIX_PATTERN.
 *
 * Only captures the bare tool name; the downstream token walk re-validates
 * the full command shape.
 */
const FIRST_TOKEN_PATTERN =
  /^\s*(?:command\s+)?(?:\/usr\/local\/bin\/|\/opt\/homebrew\/bin\/|\/usr\/bin\/|\/bin\/)?([A-Za-z][A-Za-z0-9_-]*)/;

/**
 * Cheap gate that runs before the shell-quote parser. Rejects:
 *   - empty / whitespace-only commands
 *   - commands longer than MAX_REWRITE_CANDIDATE_LENGTH
 *   - multi-line commands after safe-prefix normalization (heredocs, inline scripts,
 *     for/while bodies)
 *   - first token outside FIRST_TOKEN_ALLOWLIST
 *   - commands that start with an unsupported absolute path, `sudo`,
 *     `env`, variable assignment, quoted command, etc. — the regex
 *     simply doesn't match a bare identifier in those shapes, so they
 *     fall through naturally.
 *
 * Corpus data (2434 real bash invocations): ~34% of commands are rejected
 * here, skipping shell-quote entirely. For the rest, the downstream walk
 * remains the source of truth.
 */
function looksLikeRewriteCandidate(cmd: string): boolean {
  if (cmd.length === 0 || cmd.length > MAX_REWRITE_CANDIDATE_LENGTH) return false;
  if (cmd.indexOf('\n') !== -1) return false;
  const match = FIRST_TOKEN_PATTERN.exec(cmd);
  if (!match) return false;
  return FIRST_TOKEN_ALLOWLIST.has(match[1]!);
}

function isRewriteToolEnabled(toolName: RewriteTool, options: RewriteOptions): boolean {
  const enabledTools = options.enabledTools;
  if (!enabledTools) return true;
  if (typeof enabledTools === 'function') return enabledTools(toolName);
  for (const enabledTool of enabledTools) {
    if (enabledTool === toolName) return true;
  }
  return false;
}

function filterRewriteResult(
  result: RewriteResult | null,
  options: RewriteOptions,
): RewriteResult | null {
  if (!result?.decision) return result;
  return isRewriteToolEnabled(result.decision.tool, options) ? result : null;
}

type Token = ParseEntry;

function isStringToken(t: Token): t is string {
  return typeof t === 'string';
}

type OpToken = { op: ControlOperator } | { op: 'glob'; pattern: string };

function isOp(t: Token, op?: ControlOperator | 'glob'): t is OpToken {
  if (typeof t !== 'object' || !t) return false;
  if (!('op' in t)) return false;
  if (op === undefined) return true;
  return (t as OpToken).op === op;
}

/**
 * Return true if the token stream contains anything we don't feel safe rewriting:
 * command substitutions (`$(`/`` ` ``), subshells, here-docs, globs that shell-quote
 * tagged as dynamic, background jobs, or comments.
 */
function hasUnsafeTokens(tokens: Token[]): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (typeof t === 'object') {
      if ('comment' in t) return true;
      if ('op' in t) {
        const op = (t as { op: string }).op;
        // `;;` = case terminator, `|&` = pipe stderr+stdout, `&` = background,
        // `<(`, `(`, `)` = subshell / process substitution.
        if (op === ';;' || op === '|&' || op === '&' || op === '<(' || op === '(' || op === ')') {
          return true;
        }
      }
      // {op: "glob", pattern: ...} is a brace-expansion glob that would need shell
      // expansion to interpret. We can't safely translate it.
      if ('op' in t && (t as { op: string }).op === 'glob') return true;
    }
    // Shell-quote parses `$(cmd)` as the literal string "$" followed by {op:"("}
    // ... {op:")"}. The `(` / `)` ops are already rejected above; the bare "$"
    // token is the telltale that command substitution was present.
    if (t === '$') return true;
  }
  return false;
}

/** Split a token stream on top-level `&&` / `||` / `;`. Returns ≥1 chain segments. */
function splitChainSegments(tokens: Token[]): Token[][] {
  const segments: Token[][] = [];
  let current: Token[] = [];
  for (const t of tokens) {
    if (isOp(t, '&&') || isOp(t, '||') || isOp(t, ';')) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** Split a token stream on top-level `&&` only. Reject `||` / `;` chains. */
function splitAndChainSegments(tokens: Token[]): Token[][] | null {
  const segments: Token[][] = [];
  let current: Token[] = [];
  for (const t of tokens) {
    if (isOp(t, '&&')) {
      if (current.length === 0) return null;
      segments.push(current);
      current = [];
      continue;
    }
    if (isOp(t, '||') || isOp(t, ';')) return null;
    current.push(t);
  }
  if (current.length === 0) return null;
  segments.push(current);
  return segments;
}

/**
 * Accept chain segments that look like `cd <path>` (navigation-only) and return
 * the single remaining work segment. Returns null if we see anything non-trivial
 * before the work segment (multi-step setup, env assignments, etc.).
 */
function extractWorkSegment(segments: Token[][]): Token[] | null {
  if (segments.length === 0) return null;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i]!;
    if (!isCdNavigation(seg)) return null;
  }
  return segments[segments.length - 1]!;
}

function isCdNavigation(tokens: Token[]): boolean {
  // `cd <path>` — exactly two tokens, both strings, first is "cd".
  if (tokens.length !== 2) return false;
  if (tokens[0] !== 'cd') return false;
  if (!isStringToken(tokens[1]!)) return false;
  return true;
}

/**
 * Strip trailing trivial redirects like `2>/dev/null`, `2>&1`, `>/dev/null 2>&1`,
 * `1>/dev/null`, `>/dev/null`. These are noise-silencing; dropping them is always
 * safe for our rewrite targets because the structured tools handle errors directly.
 *
 * Shell-quote parses `2>/dev/null` as ['2', {op:'>'}, '/dev/null'] and `2>&1` as
 * ['2', {op:'>&'}, '1'], so we look for those suffixes.
 */
function stripTrivialTrailingRedirects(tokens: Token[]): Token[] {
  let work = tokens.slice();
  // Repeatedly peel off trivial redirect suffixes until none match.
  // This handles `2>/dev/null 2>&1`-style double trailers too.
  for (;;) {
    const n = work.length;
    if (n >= 3) {
      const a = work[n - 3]!;
      const b = work[n - 2]!;
      const c = work[n - 1]!;
      // `2>&1` or `1>&2`: fd, `>&`, fd
      if (
        isStringToken(a) &&
        /^[0-9]$/.test(a) &&
        isOp(b, '>&') &&
        isStringToken(c) &&
        /^[0-9]$/.test(c)
      ) {
        work = work.slice(0, n - 3);
        continue;
      }
      // `2>/dev/null`: fd, `>`, path
      if (
        isStringToken(a) &&
        /^[0-9]$/.test(a) &&
        isOp(b, '>') &&
        isStringToken(c) &&
        c === '/dev/null'
      ) {
        work = work.slice(0, n - 3);
        continue;
      }
    }
    if (n >= 2) {
      const b = work[n - 2]!;
      const c = work[n - 1]!;
      // `>/dev/null` with no leading fd
      if (isOp(b, '>') && isStringToken(c) && c === '/dev/null') {
        work = work.slice(0, n - 2);
        continue;
      }
    }
    break;
  }
  return work;
}

/**
 * Normalize the leading program-name token of a pipe stage / chain segment:
 *   - strip a leading `command` shell-builtin token (used to bypass aliases,
 *     e.g. `command grep -n PAT FILE` → `grep -n PAT FILE`).
 *   - strip absolute-path prefixes for builtin binaries (`/usr/bin/grep`,
 *     `/opt/homebrew/bin/rg`, …) so the downstream classifiers match their
 *     bare `strs[0] === 'grep'` checks.
 *
 * Returns the same array reference when nothing changed so the caller can
 * cheaply detect and skip the no-op case.
 */
function normalizeStageFirstToken(stage: Token[]): Token[] {
  if (stage.length === 0) return stage;
  let start = 0;
  if (stage.length >= 2 && stage[0] === 'command' && isStringToken(stage[1]!)) {
    start = 1;
  }
  const first = stage[start];
  if (typeof first !== 'string') {
    return start === 0 ? stage : stage.slice(start);
  }
  const normalized = stripBinaryPathPrefix(first);
  if (normalized === first && start === 0) return stage;
  const copy = stage.slice(start);
  copy[0] = normalized;
  return copy;
}

/** Split a single chain segment on `|` into pipe stages. */
function splitPipeStages(tokens: Token[]): Token[][] | null {
  const stages: Token[][] = [];
  let current: Token[] = [];
  for (const t of tokens) {
    if (isOp(t, '|')) {
      if (current.length === 0) return null;
      stages.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  if (current.length === 0) return null;
  stages.push(current);
  return stages;
}

function hasUnsupportedRedirectOperator(tokens: Token[]): boolean {
  for (const t of tokens) {
    if (!isOp(t)) continue;
    const op = (t as { op: string }).op;
    if (op === '>' || op === '>>' || op === '<' || op === '>&' || op === '<<' || op === '<<<') {
      return true;
    }
  }
  return false;
}

// --- Single-stage classifiers -----------------------------------------------

function asStrings(tokens: Token[]): string[] | null {
  const out: string[] = [];
  for (const t of tokens) {
    if (!isStringToken(t)) return null;
    out.push(t);
  }
  return out;
}

function classifyCat(tokens: Token[]): RewriteDecision | null {
  const strs = asStrings(tokens);
  if (!strs || strs[0] !== 'cat' || strs.length !== 2) return null;
  const p = strs[1]!;
  if (p.startsWith('-')) return null; // cat with flags → pass through
  return {
    tool: 'read',
    params: { path: p },
    recognizer: 'cat-file',
  };
}

function classifyLs(tokens: Token[]): RewriteDecision | null {
  const strs = asStrings(tokens);
  if (!strs || strs[0] !== 'ls') return null;
  const rest = strs.slice(1);
  let target: string = '.';
  let sawTarget = false;
  for (const t of rest) {
    if (t.startsWith('--color')) continue; // drop --color=*, --color
    if (t.startsWith('--')) return null; // any other long flag → pass through
    if (t.startsWith('-') && t.length > 1) {
      // Accept any permutation of purely presentational short flags.
      // Our builtin ls shows dotfiles and `/` suffixes regardless, so these
      // can be dropped safely.
      const chars = t.slice(1);
      // "-" alone would be stdin — not valid for ls.
      if (chars.length === 0) return null;
      for (const ch of chars) {
        if (!'laAhtr1FSG'.includes(ch)) return null;
      }
      continue;
    }
    if (sawTarget) return null; // ls supports N paths, but our structured ls does not.
    target = t;
    sawTarget = true;
  }
  return {
    tool: 'ls',
    params: sawTarget && target !== '.' ? { path: target } : {},
    recognizer: 'ls-dir',
  };
}

function classifyHead(tokens: Token[]): RewriteDecision | null {
  const strs = asStrings(tokens);
  if (!strs || strs[0] !== 'head') return null;
  const rest = strs.slice(1);
  let n: number | null = null;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i]!;
    if (t === '-n') {
      const v = rest[i + 1];
      if (!v || !/^\d+$/.test(v)) return null;
      n = Number(v);
      i += 1;
      continue;
    }
    const dashN = /^-(\d+)$/.exec(t);
    if (dashN) {
      n = Number(dashN[1]);
      continue;
    }
    const longN = /^--lines=(\d+)$/.exec(t);
    if (longN) {
      n = Number(longN[1]);
      continue;
    }
    if (t.startsWith('-')) return null; // -c (bytes), --bytes, -q, etc. → pass through
    positional.push(t);
  }
  if (positional.length !== 1) return null;
  return {
    tool: 'read',
    params: n !== null ? { path: positional[0]!, limit: n } : { path: positional[0]! },
    recognizer: 'head-n-file',
  };
}

interface GrepFlags {
  caseSensitive?: boolean;
  literal?: boolean;
  contextLines?: number;
  glob?: string;
  excludePaths?: string[];
  /** -r / -R seen — user intent is recursive over a directory. */
  recursive?: boolean;
}

/**
 * Extensionless filenames that are reliably files (not directories) in every
 * common project. Used to classify a grep target as file-like when the path
 * has no `.ext` component. Keep this conservative: false positives here
 * convert a directory-scoped search into a bad glob filter.
 */
const KNOWN_FILE_BASENAMES: ReadonlySet<string> = new Set([
  'BUILD',
  'BUILD.bazel',
  'WORKSPACE',
  'WORKSPACE.bazel',
  'MODULE',
  'MODULE.bazel',
  'Makefile',
  'GNUmakefile',
  'Dockerfile',
  'Containerfile',
  'Gemfile',
  'Rakefile',
  'Procfile',
  'Justfile',
  'Vagrantfile',
  'README',
  'LICENSE',
  'CHANGELOG',
  'NOTICE',
  'AUTHORS',
  'CODEOWNERS',
]);

/** Extract the final path segment (handles trailing slash → empty). */
function pathBasename(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/** Extract everything up to the final `/`. Returns '.' for bare basenames. */
function pathDirname(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return trimmed.slice(0, idx);
}

/**
 * Decide whether a grep target path is file-like purely from its syntax.
 * Used to translate `grep PAT FILE` → `fff_grep(within=dirname, glob=basename)`
 * instead of `within=FILE`, which some FFF router backends silently degrade
 * to the parent directory with default ignore rules applied — producing
 * spurious zero-match results (e.g. for `BUILD.bazel`).
 *
 * Strict rules, in order:
 *   1. Trailing slash → definitely a directory. Not file-like.
 *   2. Basename contains a glob metacharacter → not safe to use as a glob
 *      filter without escaping; leave the path as-is.
 *   3. Basename matches KNOWN_FILE_BASENAMES → file-like.
 *   4. Basename has a dot with non-empty extension (e.g. `foo.ts`, `BUILD.bazel`,
 *      but NOT `.`, `..`, `.env`) → file-like. Hidden dotfiles like `.env` are
 *      intentionally excluded: ripgrep's default ignore rules skip them, so
 *      translating to a glob filter would be a regression vs file-scope.
 *   5. Anything else → ambiguous, not file-like.
 */
function looksLikeFileTarget(p: string): boolean {
  if (p.endsWith('/')) return false;
  const base = pathBasename(p);
  if (base.length === 0) return false;
  if (GLOB_META_PATTERN.test(base)) return false;
  if (KNOWN_FILE_BASENAMES.has(base)) return true;
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0) return false; // bare name, or leading-dot (e.g. `.env`)
  const ext = base.slice(dotIdx + 1);
  return ext.length > 0;
}

const GREP_SHORT_WHITELIST = new Set(['n', 'i', 'r', 'R', 'H', 'h', 'I', 'a', 'E', 'F', 'w']);
const GREP_DISALLOWED_SHORT = new Set(['v', 'o', 'l', 'L', 'c', 'q', 'x', 'Z', 'z']);

/**
 * Regex metacharacters that are meaningful in fff_grep's regex engine. If a
 * split alternative contains none of these, it is safe to emit as a literal
 * pattern — which is both the documented fff_grep preference for code search
 * and more robust to engine-flavor differences.
 */
const REGEX_META_PATTERN = /[.*+?^$[\](){}|\\]/;
// Shell metacharacters that should never appear inside a legitimate file/dir
// token — their presence signals that shell-quote couldn't fully parse the
// construct (e.g. backticks from `grep PAT `which foo``) and the remaining
// literal escaped into our path list.
const SHELL_META_IN_PATH_PATTERN = /[`$()<>&|;]/;

/**
 * BRE-specific escape sequences whose meaning differs between GNU BRE grep
 * and fff_grep's regex engine:
 *   \( \)    — BRE grouping (vs literal parens in most ERE/PCRE)
 *   \{ \}    — BRE counted repetition (vs literal braces)
 *   \+ \?    — GNU BRE quantifiers (vs literal + / ? in POSIX BRE, quantifiers in ERE/PCRE)
 *   \< \>    — word boundaries (vs literal < / > in PCRE)
 *   \b       — word boundary in some engines, literal backspace elsewhere
 *
 * When default `grep` (BRE) input contains any of these, we can't safely
 * translate the regex — bail out to pass-through rather than emit a
 * broken fff_grep call. Alternation (`\|`) is handled separately above.
 */
const BRE_ONLY_ESCAPE_PATTERN = /\\[(){}+?<>b]/;

/**
 * Split a grep pattern on its alternation operator. Returns an array of
 * alternatives, or null if the input doesn't use alternation (no split
 * needed) or if the split would produce an empty alternative.
 *
 *   - mode='bre': split on the literal 2-char sequence `\|` (default grep)
 *   - mode='ere': split on unescaped `|` (egrep / grep -E)
 *   - mode='literal': no-op (fgrep / grep -F — pipe is literal)
 */
function splitGrepAlternation(pattern: string, mode: 'bre' | 'ere' | 'literal'): string[] | null {
  if (mode === 'literal') return null;
  if (mode === 'bre') {
    if (pattern.indexOf('\\|') === -1) return null;
    const parts = pattern.split('\\|');
    if (parts.some((p) => p.length === 0)) return null;
    return parts;
  }
  // ERE: split on unescaped `|`. Track backslash escapes so `\|` stays literal.
  const parts: string[] = [];
  let buf = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '\\' && i + 1 < pattern.length) {
      buf += ch + pattern[i + 1]!;
      i += 1;
      continue;
    }
    if (ch === '|') {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  if (parts.length < 2) return null;
  if (parts.some((p) => p.length === 0)) return null;
  return parts;
}

function parseGrepContext(flag: string, arg?: string): number | null {
  // -A5 / -B5 / -C5 bundled
  const bundled = /^-(A|B|C)(\d+)$/.exec(flag);
  if (bundled) return Number(bundled[2]);
  // -A 5 / -B 5 / -C 5 separate
  if (flag === '-A' || flag === '-B' || flag === '-C') {
    if (!arg || !/^\d+$/.test(arg)) return null;
    return Number(arg);
  }
  return null;
}

function classifyGrep(tokens: Token[]): RewriteDecision | null {
  const strs = asStrings(tokens);
  if (!strs) return null;
  const tool = strs[0];
  if (tool !== 'grep' && tool !== 'egrep' && tool !== 'fgrep' && tool !== 'rg') return null;

  const rest = strs.slice(1);
  const flags: GrepFlags = {};
  if (tool === 'fgrep') flags.literal = true;
  if (tool === 'egrep') flags.literal = false;

  let pattern: string | null = null;
  const paths: string[] = [];
  let seenEndOfOpts = false;

  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i]!;
    if (seenEndOfOpts) {
      if (pattern === null) pattern = t;
      else paths.push(t);
      continue;
    }
    if (t === '--') {
      seenEndOfOpts = true;
      continue;
    }
    // Long options
    if (t.startsWith('--')) {
      if (t === '--color' || t.startsWith('--color=')) continue;
      if (t.startsWith('--include=')) {
        flags.glob = t.slice('--include='.length);
        continue;
      }
      if (t.startsWith('--exclude=')) {
        flags.excludePaths = [...(flags.excludePaths ?? []), t.slice('--exclude='.length)];
        continue;
      }
      if (t.startsWith('--exclude-dir=')) {
        flags.excludePaths = [...(flags.excludePaths ?? []), t.slice('--exclude-dir='.length)];
        continue;
      }
      // Unknown long option → pass through.
      return null;
    }
    // Short options. Includes -rn, -iE, -A5, etc.
    if (t.startsWith('-') && t.length > 1 && !/^-\d+$/.test(t)) {
      const ctx = parseGrepContext(t, rest[i + 1]);
      if (ctx !== null) {
        flags.contextLines = ctx;
        if (/^-[ABC]$/.test(t)) i += 1;
        continue;
      }
      // Bundled short flags like -rn, -in, -iE, -rniE.
      const chars = t.slice(1);
      for (const ch of chars) {
        if (GREP_DISALLOWED_SHORT.has(ch)) return null;
        if (!GREP_SHORT_WHITELIST.has(ch)) return null;
        switch (ch) {
          case 'i':
            flags.caseSensitive = false;
            break;
          case 'E':
            flags.literal = false;
            break;
          case 'F':
            flags.literal = true;
            break;
          case 'r':
          case 'R':
            flags.recursive = true;
            break;
          default:
            // -n, -H, -h, -I, -a, -w: no structured effect (defaults match fff_grep).
            break;
        }
      }
      continue;
    }
    // Positional
    if (pattern === null) pattern = t;
    else paths.push(t);
  }

  if (pattern === null) return null;

  // Determine the grep regex flavor so we can (a) split alternation into
  // fff_grep's OR-matched `patterns` array and (b) bail on BRE-only
  // escapes that fff_grep's engine would mistranslate.
  const mode: 'bre' | 'ere' | 'literal' =
    flags.literal === true ? 'literal' : flags.literal === false ? 'ere' : 'bre';

  // Default-`grep` (BRE) with BRE-only escapes (other than `\|`) can't be
  // safely mapped to fff_grep's regex engine — pass through.
  if (mode === 'bre' && BRE_ONLY_ESCAPE_PATTERN.test(pattern)) return null;

  const alternatives = splitGrepAlternation(pattern, mode) ?? [pattern];

  // If every alternative is free of regex metacharacters, prefer `literal: true`:
  // it's fff_grep's documented code-search default and is robust to any
  // remaining engine-flavor differences.
  const allLiteralSafe = alternatives.every((p) => !REGEX_META_PATTERN.test(p));
  const effectiveLiteral = mode === 'literal' ? true : allLiteralSafe ? true : false;

  const params: Record<string, unknown> = {
    patterns: alternatives,
    // Default to regex mode, matching gnu-grep's default semantics. `-F` / `fgrep`
    // flip to literal; `-E` / `egrep` are explicit regex but the default already
    // matches them. fff_grep's public API requires an explicit literal value.
    literal: effectiveLiteral,
  };
  if (paths.length === 1) {
    const target = paths[0]!;
    // Split a file-like target into within=<dir> + glob=<basename> so we don't
    // depend on how any particular FFF backend normalizes a file-as-`within`.
    // Skip if the caller already passed an explicit --include= glob (honour it).
    // `-r` / `-R` implies directory intent — keep path as-is.
    if (!flags.recursive && flags.glob === undefined && looksLikeFileTarget(target)) {
      params.within = pathDirname(target);
      params.glob = pathBasename(target);
    } else {
      params.within = target;
    }
  } else if (paths.length > 1) {
    // Multi-path grep (`grep PAT file1 file2 dir/`) maps to fff_grep's array
    // form of `within`. fff-router unions the entries via brace-expansion on
    // fff-mcp or spread positional args on rg, preserving grep's per-file
    // output semantics. Bail if the caller passed a glob/include — mixing
    // multi-path with a glob would require per-entry globs, which the API
    // doesn't express. An `--exclude=` / `--exclude-dir=` is still fine; it
    // applies uniformly across all entries.
    if (flags.glob !== undefined) return null;
    // Reject paths that contain shell metacharacters — shell-quote keeps
    // backticks as literal string content (e.g. `grep foo `which ls``
    // tokenizes to `["`which", "ls`"]`), so a naive multi-path emit would
    // pass those through to the tool as fake paths. Filenames legitimately
    // contain `.`, `/`, `-`, `_`, but not ` $ ( ) < > & | ; ` — bail on
    // any of those.
    for (const p of paths) {
      if (SHELL_META_IN_PATH_PATTERN.test(p)) return null;
    }
    params.within = paths;
  }
  if (flags.caseSensitive === false) params.case_sensitive = false;
  if (flags.contextLines !== undefined) params.context_lines = flags.contextLines;
  if (flags.glob !== undefined && params.glob === undefined) params.glob = flags.glob;
  if (flags.excludePaths && flags.excludePaths.length > 0) {
    params.exclude_paths = flags.excludePaths;
  }

  return {
    tool: 'fff_grep',
    params,
    recognizer: tool === 'rg' ? 'rg-search' : `${tool}-search`,
  };
}

interface FindAnalysis {
  paths: string[];
  glob: string | null;
  hasNameClause: boolean;
  typeFilter: 'f' | 'd' | 'l' | null;
}

function analyzeFind(tokens: Token[]): FindAnalysis | null {
  const strs = asStrings(tokens);
  if (!strs || strs[0] !== 'find') return null;
  const rest = strs.slice(1);

  const paths: string[] = [];
  let glob: string | null = null;
  let hasNameClause = false;
  let typeFilter: 'f' | 'd' | 'l' | null = null;

  let i = 0;
  // Leading paths (anything that doesn't start with `-`).
  while (i < rest.length && !rest[i]!.startsWith('-')) {
    paths.push(rest[i]!);
    i += 1;
  }

  const disallow = new Set([
    '-exec',
    '-execdir',
    '-delete',
    '-ok',
    '-okdir',
    '-print0',
    '-mtime',
    '-atime',
    '-ctime',
    '-newer',
    '-size',
    '-perm',
    '-user',
    '-group',
    '-path',
    '-prune',
    '-depth',
    '-o',
    '-a',
    '-or',
    '-and',
    '-not',
    '!',
    '-maxdepth',
    '-mindepth',
    '-regex',
    '-iregex',
  ]);

  while (i < rest.length) {
    const t = rest[i]!;
    if (disallow.has(t)) return null;
    if (t === '-name' || t === '-iname') {
      const v = rest[i + 1];
      if (!v) return null;
      glob = v;
      hasNameClause = true;
      i += 2;
      continue;
    }
    if (t === '-type') {
      const v = rest[i + 1];
      if (!v || !(v === 'f' || v === 'd' || v === 'l')) return null;
      typeFilter = v;
      i += 2;
      continue;
    }
    if (t === '-print') {
      i += 1;
      continue;
    }
    return null;
  }

  return { paths, glob, hasNameClause, typeFilter };
}

function tokenizeFindQuery(value: string): string[] {
  return value
    .replace(/[*?[\]{}!]+/g, ' ')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function deriveFindQueryFromGlob(glob: string): string | null {
  const normalized = glob.replace(/\\/g, '/').trim();
  const basename = normalized.split('/').filter(Boolean).pop();
  if (!basename) return null;
  if (!GLOB_META_PATTERN.test(normalized)) return basename;
  const tokens = tokenizeFindQuery(basename);
  if (tokens.length === 0) return null;
  const specific = tokens.filter((t) => !FIND_QUERY_GENERIC_TOKENS.has(t.toLowerCase()));
  if (specific.length === 0) return null;
  return specific.join(' ');
}

/**
 * True when the glob is structurally `*.EXT` / `**\/*.EXT` / `**.EXT` and
 * encodes nothing but an extension filter. `find PATH -name "*.EXT"` is a
 * pure filename-filter query; fff_find_files' `query` is a fuzzy filename
 * match that can't meaningfully use just an extension (`"go"` matches every
 * `.go` file identically — all signal, no selectivity). Worse, the FFF
 * router's default ignore rules may filter hidden/gitignored subtrees on
 * its own, producing zero-result false negatives where `find` would
 * happily enumerate. In this shape, passing through to bash is strictly
 * better than any fff_find_files call we could build.
 *
 * Note: FIND_QUERY_GENERIC_TOKENS already catches some extensions
 * (`ts`, `tsx`, `json`, …) but is incomplete — `go`, `py`, `rs`, `rb`,
 * `java`, etc. were missing and produced broken rewrites. This structural
 * check supersedes that allowlist for the "just an extension" shape and
 * is robust to any future language extension.
 */
function isExtensionOnlyGlob(glob: string): boolean {
  const normalized = glob.replace(/\\/g, '/').trim();
  if (normalized.length === 0) return false;
  // Strip leading directory wildcards so `**/*.go` and `*.go` both reduce
  // to the bare `*.ext` core.
  const core = normalized.replace(/^(\*\*\/)+/, '').replace(/^\*\*\./, '*.');
  return /^\*\.[A-Za-z0-9]+$/.test(core);
}

function classifyFind(tokens: Token[]): RewriteDecision | null {
  const a = analyzeFind(tokens);
  if (!a || !a.hasNameClause || !a.glob) return null;
  if (a.typeFilter === 'd') return null; // fff_find_files is file-oriented.
  if (a.paths.length > 1) return null;

  // Pure extension filters (`*.go`, `**/*.rs`, …) carry no fuzzy-search
  // signal and interact badly with FFF's default ignore rules — bail
  // out to bash, which handles them correctly.
  if (isExtensionOnlyGlob(a.glob)) return null;

  const query = deriveFindQueryFromGlob(a.glob);
  if (!query) return null;

  const params: Record<string, unknown> = {
    query,
    glob: a.glob,
  };
  if (a.paths.length === 1) params.within = a.paths[0]!;

  return {
    tool: 'fff_find_files',
    params,
    recognizer: 'find-name-glob',
  };
}

function classifyFd(tokens: Token[]): RewriteDecision | null {
  const strs = asStrings(tokens);
  if (!strs) return null;
  const tool = strs[0];
  if (tool !== 'fd' && tool !== 'fdfind') return null;

  const rest = strs.slice(1);
  let pattern: string | null = null;
  const paths: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i]!;
    if (t === '-e' || t === '--extension' || t === '-t' || t === '--type') {
      // Accepted but not mapped; skip value.
      i += 1;
      continue;
    }
    if (
      t === '-H' ||
      t === '-I' ||
      t === '--hidden' ||
      t === '--no-ignore' ||
      t === '-a' ||
      t === '--absolute-path' ||
      t === '-p' ||
      t === '--full-path' ||
      t === '-u'
    ) {
      continue;
    }
    if (t.startsWith('-')) return null;
    if (pattern === null) pattern = t;
    else paths.push(t);
  }
  if (pattern === null) return null;
  if (paths.length > 1) return null;

  const params: Record<string, unknown> = {
    query: pattern,
  };
  if (paths.length === 1) params.within = paths[0]!;
  return {
    tool: 'fff_find_files',
    params,
    recognizer: 'fd-search',
  };
}

/**
 * Classify `sed -n 'N,Mp' FILE` (and the single-line `sed -n 'Np' FILE`)
 * as a line-range read. Intentionally strict: any other sed invocation
 * (substitutions, regex ranges, multiple expressions via `;` or `-e`,
 * `-i` in-place, etc.) passes through. The agent sees `sed` working
 * as usual for everything we do not understand.
 *
 * The range maps to `read(path, offset=N, limit=M-N+1)`. Our `read`
 * tool treats `offset` as 1-indexed line number, matching sed's
 * semantics, so no off-by-one shuffle is needed.
 *
 * Composes with the existing `<stage> | head -K` pipeline handler,
 * which overrides `limit` with K — so `sed -n '10,50p' FILE | head -5`
 * correctly becomes `read(path=FILE, offset=10, limit=5)`.
 */
function classifySedRange(tokens: Token[]): RewriteDecision | null {
  const strs = asStrings(tokens);
  if (!strs || strs[0] !== 'sed') return null;
  if (strs.length !== 4) return null; // sed -n EXPR FILE — exactly 4 tokens
  if (strs[1] !== '-n') return null;
  const expr = strs[2]!;
  const m = /^(\d+)(?:,(\d+))?p$/.exec(expr);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] !== undefined ? Number(m[2]) : start;
  if (start < 1 || end < start) return null;
  const path = strs[3]!;
  if (path.startsWith('-')) return null;
  return {
    tool: 'read',
    params: { path, offset: start, limit: end - start + 1 },
    recognizer: 'sed-range-print',
  };
}

/**
 * Match the "filter" form of grep — `grep PAT` (and its egrep/fgrep/rg
 * aliases) with no positional FILE argument, meaning it acts as a stdin
 * consumer in a pipeline (the second stage of `cat FILE | grep PAT`).
 * Returns the grep decision's params (patterns, literal, context_lines,
 * case_sensitive, …) — everything except the missing `within`. Returns
 * null for any grep shape we don't understand, and for stdin-grep that
 * already carries a positional FILE (which would race with the cat
 * stage's file claim).
 *
 * Intentionally paired with — not merged into — `classifyGrep`: the
 * single-stage recognizer accepts one FILE arg (and maps it to `within`);
 * this one requires its absence so the source file can come from the
 * upstream `cat`.
 */
function extractGrepFilter(tokens: Token[]): RewriteDecision | null {
  const decision = classifyGrep(tokens);
  if (!decision) return null;
  if ('within' in decision.params) return null;
  return decision;
}

/**
 * Match the "filter" form of a sed range — `sed -n 'N,Mp'` (or `sed -n 'Np'`)
 * with no FILE argument. This shape only makes sense as a stdin consumer in
 * a pipeline (the second stage of `cat FILE | sed -n 'N,Mp'`); the source
 * file arrives via the upstream stage. Returns the resolved offset/limit,
 * or null for anything else.
 *
 * Intentionally paired with — not merged into — `classifySedRange`: the
 * single-stage recognizer wants a FILE arg, this one requires its absence.
 */
function extractSedRangeFilter(tokens: Token[]): { offset: number; limit: number } | null {
  const strs = asStrings(tokens);
  if (!strs || strs[0] !== 'sed') return null;
  if (strs.length !== 3) return null;
  if (strs[1] !== '-n') return null;
  const m = /^(\d+)(?:,(\d+))?p$/.exec(strs[2]!);
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] !== undefined ? Number(m[2]) : start;
  if (start < 1 || end < start) return null;
  return { offset: start, limit: end - start + 1 };
}

const SINGLE_STAGE_CLASSIFIERS = [
  classifyCat,
  classifyLs,
  classifyHead,
  classifyGrep,
  classifyFind,
  classifyFd,
  classifySedRange,
] as const;

function classifySingleStage(tokens: Token[]): RewriteDecision | null {
  for (const fn of SINGLE_STAGE_CLASSIFIERS) {
    const r = fn(tokens);
    if (r) return r;
  }
  return null;
}

/**
 * Notice-only classifier for `cat -A` (and the equivalent `-AET` / `-vET`
 * bundled variants). macOS / BSD `cat` rejects `-A`, so the command
 * fails with a cryptic "illegal option" error. We cannot cleanly route
 * to `read` because our read tool does not visualize whitespace. Instead
 * we emit an actionable notice so the agent sees the fix on the very
 * next turn. The original command still runs (and still fails on BSD),
 * but the notice turns a silent head-scratch into a one-shot correction.
 *
 * We accept only standalone `cat -A FILE` / `cat -vET FILE` forms.
 * Bundled presentations like `-Aen` / `-nvA` are matched via the
 * character-bundle check. Long-form `--show-all` is also caught.
 */
function classifyCatDashANotice(tokens: Token[]): { notice: string } | null {
  const strs = asStrings(tokens);
  if (!strs || strs[0] !== 'cat') return null;
  // BSD `cat` rejects three short flags that GNU `cat` accepts:
  //   -A (show-all), -E (show-ends), -T (show-tabs)
  // plus their long-form equivalents. Plain `-v`, `-e`, `-t`, `-n`,
  // `-s`, `-u` all work on BSD and should pass through silently.
  const hasDashA = strs.slice(1).some((s) => {
    if (/^--show-(all|ends|tabs|nonprinting)$/.test(s)) return true;
    if (!s.startsWith('-') || s.startsWith('--') || s.length < 2) return false;
    // Bundled short form: any of A/E/T (uppercase) triggers the notice.
    return /[AET]/.test(s.slice(1));
  });
  if (!hasDashA) return null;
  return {
    notice:
      'Note: BSD `cat` (macOS default) does not support `-A` / `-vET` / `--show-all`. ' +
      'Workarounds that produce similar output on BSD: `cat -vet FILE` (close approximation, accepts `-v`, `-e`, `-t` individually), ' +
      'or `awk \'{ gsub(/\\t/,"→"); gsub(/$/,"¶"); print }\' FILE` for a structured pass. ' +
      'If you only need the content without whitespace markers, use `read(path=FILE)` directly.',
  };
}

const NOTICE_ONLY_CLASSIFIERS = [classifyCatDashANotice] as const;

function classifyNoticeOnly(tokens: Token[]): { notice: string } | null {
  for (const fn of NOTICE_ONLY_CLASSIFIERS) {
    const r = fn(tokens);
    if (r) return r;
  }
  return null;
}

// --- Multi-stage recognizers ------------------------------------------------

/** Return N if the stage is exactly `head` / `head -N` / `head -n N` / `head --lines=N`. */
function extractHeadLimit(tokens: Token[]): number | null {
  const strs = asStrings(tokens);
  if (!strs || strs[0] !== 'head') return null;
  const rest = strs.slice(1);
  if (rest.length === 0) return 10;
  if (rest.length === 1) {
    const m = /^-(\d+)$/.exec(rest[0]!);
    if (m) return Number(m[1]);
    const long = /^--lines=(\d+)$/.exec(rest[0]!);
    if (long) return Number(long[1]);
    return null;
  }
  if (rest.length === 2 && rest[0] === '-n' && /^\d+$/.test(rest[1]!)) {
    return Number(rest[1]);
  }
  return null;
}

/** True if the stage is `xargs cat` (optionally with `-I {}` / `-n1` / `-r`). */
function isXargsCatStage(tokens: Token[]): boolean {
  const strs = asStrings(tokens);
  if (!strs || strs[0] !== 'xargs') return false;
  const rest = strs.slice(1);
  let i = 0;
  while (i < rest.length) {
    const t = rest[i]!;
    if (t === '-r' || t === '--no-run-if-empty' || t === '-0' || t === '--null') {
      i += 1;
      continue;
    }
    if (t === '-I' || t === '--replace') {
      i += 2;
      continue;
    }
    if (t === '-n' || t === '-L') {
      i += 2;
      continue;
    }
    break;
  }
  return rest[i] === 'cat' && rest.length === i + 1;
}

/**
 * Detect `find <path> [-type f] | head -1 | xargs cat [| head -N]` and collapse
 * to `read <path> [limit=N]`. This is the defensive-read idiom the model sometimes
 * reaches for when it wants to cat a file only if it exists.
 */
function tryFindXargsCatIdiom(stages: Token[][]): RewriteDecision | null {
  if (stages.length !== 3 && stages.length !== 4) return null;

  const findAnalysis = analyzeFind(stages[0]!);
  if (!findAnalysis) return null;
  if (findAnalysis.hasNameClause) return null;
  if (findAnalysis.paths.length !== 1) return null;
  if (findAnalysis.typeFilter !== null && findAnalysis.typeFilter !== 'f') return null;

  if (extractHeadLimit(stages[1]!) !== 1) return null;
  if (!isXargsCatStage(stages[2]!)) return null;

  let limit: number | null = null;
  if (stages.length === 4) {
    limit = extractHeadLimit(stages[3]!);
    if (limit === null) return null;
  }

  const p = findAnalysis.paths[0]!;
  const params: Record<string, unknown> = { path: p };
  if (limit !== null) params.limit = limit;

  return {
    tool: 'read',
    params,
    recognizer: 'find-xargs-cat',
  };
}

function looksLikeReadOperationsCandidate(cmd: string): boolean {
  if (cmd.length === 0 || cmd.length > MAX_REWRITE_CANDIDATE_LENGTH) return false;
  return cmd.includes('sed') && cmd.includes('-n');
}

function isPrintfSectionHeader(tokens: Token[]): boolean {
  const strs = asStrings(normalizeStageFirstToken(stripTrivialTrailingRedirects(tokens)));
  if (!strs || strs[0] !== 'printf') return false;
  const args = strs.slice(1);
  if (args[0] === '--') args.shift();
  if (args.length !== 1) return false;
  const format = args[0]!;
  if (format.length === 0 || format.length > 200) return false;
  return !/(^|[^%])%(?!%)/.test(format);
}

function readOperationFromDecision(decision: RewriteDecision): BashReadOperation | null {
  if (decision.tool !== 'read') return null;
  if (!decision.recognizer.startsWith('sed-range-print')) return null;
  if (typeof decision.params.path !== 'string') return null;

  const operation: BashReadOperation = {
    path: decision.params.path,
    recognizer: decision.recognizer,
  };
  if (typeof decision.params.offset === 'number') operation.offset = decision.params.offset;
  if (typeof decision.params.limit === 'number') operation.limit = decision.params.limit;
  return operation;
}

function classifyReadOperationSegment(tokens: Token[]): BashReadOperation | null {
  const stripped = stripTrivialTrailingRedirects(tokens);
  if (stripped.length === 0) return null;

  const pipeStages = splitPipeStages(stripped);
  if (!pipeStages) return null;

  const strippedStages = pipeStages
    .map(stripTrivialTrailingRedirects)
    .map(normalizeStageFirstToken);

  if (strippedStages.some(hasUnsupportedRedirectOperator)) return null;

  if (strippedStages.length === 1) {
    const decision = classifySingleStage(strippedStages[0]!);
    return decision ? readOperationFromDecision(decision) : null;
  }

  if (strippedStages.length !== 2) return null;

  const sedRange = extractSedRangeFilter(strippedStages[1]!);
  if (sedRange) {
    const catDecision = classifyCat(strippedStages[0]!);
    if (catDecision && catDecision.recognizer === 'cat-file') {
      return {
        path: catDecision.params.path as string,
        offset: sedRange.offset,
        limit: sedRange.limit,
        recognizer: 'cat-sed-range',
      };
    }
  }

  const limit = extractHeadLimit(strippedStages[1]!);
  if (limit === null) return null;
  const decision = classifySingleStage(strippedStages[0]!);
  if (!decision) return null;
  return readOperationFromDecision({
    ...decision,
    params: { ...decision.params, limit },
    recognizer: `${decision.recognizer}+head`,
  });
}

function appendReadOperationSegments(target: Token[][], tokens: Token[]): boolean {
  if (tokens.length === 0) return true;
  if (hasUnsafeTokens(tokens)) return false;
  const chainSegments = splitAndChainSegments(tokens);
  if (!chainSegments) return false;
  target.push(...chainSegments);
  return true;
}

function splitShellCommandLines(input: string): string[] | null {
  const lines: string[] = [];
  let start = 0;
  let quote: 'single' | 'double' | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote === 'single') {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === 'double') {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === "'") {
      quote = 'single';
      continue;
    }
    if (ch === '"') {
      quote = 'double';
      continue;
    }
    if (ch === '\n') {
      lines.push(input.slice(start, i));
      start = i + 1;
    }
  }

  if (quote !== null) return null;
  lines.push(input.slice(start));
  return lines;
}

function splitReadOperationSegments(command: string): Token[][] | null {
  const segments: Token[][] = [];
  if (command.includes('\n')) {
    const commandLines = splitShellCommandLines(command.replace(/\r\n/g, '\n'));
    if (!commandLines) return null;
    for (const line of commandLines) {
      if (!line.trim()) continue;
      let tokens: Token[];
      try {
        tokens = shellParse(line);
      } catch {
        return null;
      }
      if (!appendReadOperationSegments(segments, tokens)) return null;
    }
    return segments.length > 0 ? segments : null;
  }

  let tokens: Token[];
  try {
    tokens = shellParse(command);
  } catch {
    return null;
  }
  if (!appendReadOperationSegments(segments, tokens)) return null;
  return segments.length > 0 ? segments : null;
}

export function tryRewriteBashReadOperations(
  cmd: string,
  cwd: string,
): BashReadOperationsResult | null {
  const normalized = normalizeRewriteCommand(cmd, cwd);
  const rewriteCommand = normalized.command;
  if (!looksLikeReadOperationsCandidate(rewriteCommand)) return null;

  const chainSegments = splitReadOperationSegments(rewriteCommand);
  if (!chainSegments) return null;

  const operations: BashReadOperation[] = [];
  for (const segment of chainSegments) {
    if (isPrintfSectionHeader(segment)) continue;
    const operation = classifyReadOperationSegment(segment);
    if (!operation) return null;
    operations.push(operation);
  }
  if (operations.length === 0) return null;

  return normalized.explicitCwd ? { operations, cwd: normalized.cwd } : { operations };
}

// --- Public entry point -----------------------------------------------------

/**
 * Format a single-line, token-frugal notice announcing a bash→structured-tool
 * rewrite. Shape:
 *
 *   grep → fff_grep(patterns=["foo"], literal=true, within="src", limit=10)
 *
 * The source-tool prefix (`grep`, `find`, `cat`, …) is two tokens but earns
 * its keep three ways: (1) it disambiguates the arrow direction so the line
 * reads unambiguously as a transformation, not a label; (2) it confirms
 * which bash tool the rewriter recognized (e.g. `egrep → …` vs `grep → …`
 * tells the agent ERE mode was detected); (3) it teaches the source→target
 * mapping implicitly over repeated exposure, without any prose.
 *
 * The source label is derived from the recognizer name, whose first `-`-
 * or `+`-separated segment is always the originating tool (`cat-file`,
 * `grep-search+head`, `find-name-glob`, `find-xargs-cat`, …). No extra
 * parsing of the original command is needed.
 *
 * Anything beyond this one line (original-command echo, "prefer fff_*
 * directly" nag, etc.) adds no per-call value after the agent's first
 * exposure and was burning ~60 tokens per rewrite — dropped.
 */
function formatNotice(_originalCmd: string, decision: RewriteDecision): string {
  const paramStr = renderParamsForNotice(decision.params);
  const sourceTool = decision.recognizer.split(/[-+]/)[0] ?? 'bash';
  return `${sourceTool} → ${decision.tool}(${paramStr})`;
}

function renderParamsForNotice(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      parts.push(`${k}=[${v.map((x) => JSON.stringify(x)).join(', ')}]`);
    } else if (typeof v === 'string') {
      parts.push(`${k}=${JSON.stringify(v)}`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`${k}=${v.toString()}`);
    } else {
      parts.push(`${k}=${JSON.stringify(v)}`);
    }
  }
  return parts.join(', ');
}

/**
 * Try to rewrite `cmd` to a structured tool call. Returns null if the command
 * is not recognized or contains anything unsafe; the caller should then fall
 * through to the original builtin bash execution.
 */
export function tryRewriteBash(cmd: string, _cwd: string): RewriteResult | null {
  return tryRewriteBashWithOptions(cmd, _cwd);
}

export function tryRewriteBashWithOptions(
  cmd: string,
  _cwd: string,
  options: RewriteOptions = {},
): RewriteResult | null {
  const normalized = normalizeRewriteCommand(cmd, _cwd);
  const rewriteCommand = normalized.command;

  const applyPatchRewrite = tryRewriteApplyPatchCliBash(rewriteCommand, {
    availableTools: (toolName) =>
      toolName === 'apply_patch' && isRewriteToolEnabled(toolName, options),
  });
  if (applyPatchRewrite) return withEffectiveCwd(applyPatchRewrite, normalized);

  if (!looksLikeRewriteCandidate(rewriteCommand)) return null;
  let tokens: Token[];
  try {
    tokens = shellParse(rewriteCommand);
  } catch {
    return null;
  }
  if (tokens.length === 0) return null;
  if (hasUnsafeTokens(tokens)) return null;

  const chainSegments = splitChainSegments(tokens);
  const workSegment = extractWorkSegment(chainSegments);
  if (!workSegment) return null;

  if (hasUnsafeTokens(workSegment)) return null;

  const stripped = stripTrivialTrailingRedirects(workSegment);
  if (stripped.length === 0) return null;

  const pipeStages = splitPipeStages(stripped);
  if (!pipeStages) return null;

  const strippedStages = pipeStages
    .map(stripTrivialTrailingRedirects)
    .map(normalizeStageFirstToken);

  // Reject any stage that still contains a redirect operator after stripping —
  // those are real redirects we don't understand, not noise.
  if (strippedStages.some(hasUnsupportedRedirectOperator)) return null;

  // Special multi-stage idiom first.
  const idiom = tryFindXargsCatIdiom(strippedStages);
  if (idiom) {
    const filtered = filterRewriteResult(
      { decision: idiom, notice: formatNotice(rewriteCommand.trim(), idiom) },
      options,
    );
    return filtered ? withEffectiveCwd(filtered, normalized) : null;
  }

  if (strippedStages.length === 1) {
    const d = classifySingleStage(strippedStages[0]!);
    if (d) {
      const filtered = filterRewriteResult(
        { decision: d, notice: formatNotice(rewriteCommand.trim(), d) },
        options,
      );
      return filtered ? withEffectiveCwd(filtered, normalized) : null;
    }
    // No rewrite available — fall through to notice-only classifiers.
    const notice = classifyNoticeOnly(strippedStages[0]!);
    return notice ? withEffectiveCwd({ notice: notice.notice }, normalized) : null;
  }

  // Two-stage: `<search> | head -N`, `cat FILE | sed -n 'N,Mp'`, or
  // `cat FILE | grep PAT`.
  if (strippedStages.length === 2) {
    // `cat FILE | grep PAT` → fff_grep over FILE with PAT. The pipeline
    // shape is common muscle memory for "search this file" that the
    // single-stage grep recognizer doesn't catch (it wants the file as
    // grep's own positional argument). Composing preserves grep's flag
    // handling (context lines, case-insensitive, alternation, etc.) via
    // the shared `classifyGrep` parser.
    const grepFilter = extractGrepFilter(strippedStages[1]!);
    if (grepFilter) {
      const catDecision = classifyCat(strippedStages[0]!);
      if (catDecision && catDecision.recognizer === 'cat-file') {
        const catPath = catDecision.params.path as string;
        const params: Record<string, unknown> = { ...grepFilter.params };
        // Apply the same file-like split policy as the single-stage grep
        // recognizer so behaviour stays consistent with `grep PAT FILE`.
        // An explicit `--include=` on the stdin-consuming grep would be a
        // no-op in real bash, so we ignore it in favour of the cat path.
        if (looksLikeFileTarget(catPath)) {
          params.within = pathDirname(catPath);
          params.glob = pathBasename(catPath);
        } else {
          params.within = catPath;
          delete params.glob;
        }
        const d: RewriteDecision = {
          tool: 'fff_grep',
          params,
          recognizer: 'cat-grep',
        };
        const filtered = filterRewriteResult(
          { decision: d, notice: formatNotice(rewriteCommand.trim(), d) },
          options,
        );
        return filtered ? withEffectiveCwd(filtered, normalized) : null;
      }
    }
    // `cat FILE | sed -n 'N,Mp'` → read(path=FILE, offset=N, limit=M-N+1).
    // Recognizing this shape matters because the model often reaches for the
    // pipeline form (muscle memory from `sed`'s stdin-filter usage) even when
    // the pure `sed -n 'N,Mp' FILE` is available. Both collapse to the same
    // read call; catching the pipeline form here saves a round-trip through
    // bash.
    const sedRange = extractSedRangeFilter(strippedStages[1]!);
    if (sedRange) {
      const catDecision = classifyCat(strippedStages[0]!);
      if (catDecision && catDecision.recognizer === 'cat-file') {
        const d: RewriteDecision = {
          tool: 'read',
          params: {
            path: catDecision.params.path,
            offset: sedRange.offset,
            limit: sedRange.limit,
          },
          recognizer: 'cat-sed-range',
        };
        const filtered = filterRewriteResult(
          { decision: d, notice: formatNotice(rewriteCommand.trim(), d) },
          options,
        );
        return filtered ? withEffectiveCwd(filtered, normalized) : null;
      }
    }
    const limit = extractHeadLimit(strippedStages[1]!);
    if (limit === null) {
      // Even without a rewriteable pipeline shape, a notice on the
      // first stage is still useful — e.g. `cat -A FILE | od -c`.
      const notice = classifyNoticeOnly(strippedStages[0]!);
      return notice ? withEffectiveCwd({ notice: notice.notice }, normalized) : null;
    }
    const d = classifySingleStage(strippedStages[0]!);
    if (!d) {
      // `cat -A FILE | head -N` — no rewrite, but still surface the notice.
      const notice = classifyNoticeOnly(strippedStages[0]!);
      return notice ? withEffectiveCwd({ notice: notice.notice }, normalized) : null;
    }
    const withLimit: RewriteDecision = {
      tool: d.tool,
      params: { ...d.params, limit },
      recognizer: `${d.recognizer}+head`,
    };
    const filtered = filterRewriteResult(
      { decision: withLimit, notice: formatNotice(rewriteCommand.trim(), withLimit) },
      options,
    );
    return filtered ? withEffectiveCwd(filtered, normalized) : null;
  }

  return null;
}
