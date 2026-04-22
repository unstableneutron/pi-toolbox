import { parse as shellParse, type ControlOperator, type ParseEntry } from 'shell-quote';

/**
 * Decide whether a bash command string collapses to a safe, structured tool call.
 *
 * Scope (v1):
 *   - Simple single commands: `cat`, `ls`, `grep`, `find`, `head`, `rg`, `fd`, `egrep`, `fgrep`.
 *   - Two-stage pipelines of the form `<search> | head -N` where `<search>` is one
 *     of the recognized tools; the `head -N` folds into `limit: N`.
 *   - A defensive-read idiom `find <path> [-type f] | head -1 | xargs cat [| head -N]`
 *     collapses to `read <path> [limit=N]`.
 *
 * Every other shape — chained `&&`/`||`/`;` (beyond a leading `cd <path> &&` prefix),
 * non-trivial redirects, command substitution, subshells, background jobs — passes
 * through untouched. See bash-rewrite.test.ts for the behavior corpus.
 */

export type RewriteTool = 'fff_grep' | 'fff_find_files' | 'read' | 'ls';

export interface RewriteDecision {
  tool: RewriteTool;
  params: Record<string, unknown>;
  /** Which recognizer fired. Useful for tests and debug telemetry. */
  recognizer: string;
}

interface RewriteResult {
  /**
   * Structured tool call to dispatch. Omit for notice-only results:
   * the original bash command still runs, but the notice is prepended
   * to its output so the agent sees actionable advice without a hard
   * rewrite. Used for shapes like BSD-incompatible `cat -A`, where we
   * cannot cleanly map to a structured tool but still want to nudge.
   */
  decision?: RewriteDecision;
  notice: string;
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

/** Match the first word-like token, ignoring leading whitespace. */
const FIRST_TOKEN_PATTERN = /^\s*([A-Za-z][A-Za-z0-9_-]*)/;

/**
 * Cheap gate that runs before the shell-quote parser. Rejects:
 *   - empty / whitespace-only commands
 *   - commands longer than MAX_REWRITE_CANDIDATE_LENGTH
 *   - multi-line commands (heredocs, inline scripts, for/while bodies)
 *   - first token outside FIRST_TOKEN_ALLOWLIST
 *   - commands that start with an absolute path, `sudo`, `env`, variable
 *     assignment, quoted command, etc. — the regex simply doesn't match a bare
 *     identifier in those shapes, so they fall through naturally.
 *
 * Corpus data (522 real bash invocations): ~34% of commands are rejected here,
 * skipping shell-quote entirely. For the 66% that pass, the downstream walk
 * remains the source of truth.
 */
function looksLikeRewriteCandidate(cmd: string): boolean {
  if (cmd.length === 0 || cmd.length > MAX_REWRITE_CANDIDATE_LENGTH) return false;
  if (cmd.indexOf('\n') !== -1) return false;
  const match = FIRST_TOKEN_PATTERN.exec(cmd);
  if (!match) return false;
  return FIRST_TOKEN_ALLOWLIST.has(match[1]!);
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
    // fff_grep's `within` is a single path. Multiple paths cannot be mapped cleanly.
    return null;
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

/** Return N if the stage is exactly `head -N` / `head -n N` / `head --lines=N`. */
function extractHeadLimit(tokens: Token[]): number | null {
  const strs = asStrings(tokens);
  if (!strs || strs[0] !== 'head') return null;
  const rest = strs.slice(1);
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
  if (!looksLikeRewriteCandidate(cmd)) return null;
  let tokens: Token[];
  try {
    tokens = shellParse(cmd);
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

  const strippedStages = pipeStages.map(stripTrivialTrailingRedirects);

  // Reject any stage that still contains a redirect operator after stripping —
  // those are real redirects we don't understand, not noise.
  for (const stage of strippedStages) {
    for (const t of stage) {
      if (isOp(t)) {
        const op = (t as { op: string }).op;
        if (op === '>' || op === '>>' || op === '<' || op === '>&' || op === '<<' || op === '<<<') {
          return null;
        }
      }
    }
  }

  // Special multi-stage idiom first.
  const idiom = tryFindXargsCatIdiom(strippedStages);
  if (idiom) return { decision: idiom, notice: formatNotice(cmd.trim(), idiom) };

  if (strippedStages.length === 1) {
    const d = classifySingleStage(strippedStages[0]!);
    if (d) return { decision: d, notice: formatNotice(cmd.trim(), d) };
    // No rewrite available — fall through to notice-only classifiers.
    const notice = classifyNoticeOnly(strippedStages[0]!);
    return notice ? { notice: notice.notice } : null;
  }

  // Two-stage: `<search> | head -N`
  if (strippedStages.length === 2) {
    const limit = extractHeadLimit(strippedStages[1]!);
    if (limit === null) {
      // Even without a rewriteable pipeline shape, a notice on the
      // first stage is still useful — e.g. `cat -A FILE | od -c`.
      const notice = classifyNoticeOnly(strippedStages[0]!);
      return notice ? { notice: notice.notice } : null;
    }
    const d = classifySingleStage(strippedStages[0]!);
    if (!d) {
      // `cat -A FILE | head -N` — no rewrite, but still surface the notice.
      const notice = classifyNoticeOnly(strippedStages[0]!);
      return notice ? { notice: notice.notice } : null;
    }
    const withLimit: RewriteDecision = {
      tool: d.tool,
      params: { ...d.params, limit },
      recognizer: `${d.recognizer}+head`,
    };
    return { decision: withLimit, notice: formatNotice(cmd.trim(), withLimit) };
  }

  return null;
}
