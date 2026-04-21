// "Quote-style" matching tier for apply_patch.
//
// Allows a SEARCH block to match a file region that differs ONLY by
// straight-quote style (' vs ") and re-quotes REPLACE to the file's
// style on apply. Addresses the common pain where a formatter (oxfmt,
// prettier, biome) has rewritten quotes since the agent last read
// the file. Without this tier, the ladder already handles whitespace
// drift (`trim`) and Unicode smart-quote / zero-width drift (`fuzzy`)
// but refuses to bridge `'` ↔ `"` — the cause of the most common
// post-format patch failure in JS/TS codebases.
//
// The tier is opt-in per (filePath, cwd) and carries its own set of
// guardrails. See the design notes inline below.

import { existsSync } from 'node:fs';
import { dirname, extname, join, parse as parsePath } from 'node:path';

// File extensions in which straight-quote style is cosmetic in the
// vast majority of real positions. We deliberately exclude file
// types where quote style can be semantic (.md, .json, .yml, etc.).
const QUOTE_TIER_EXTENSIONS: ReadonlySet<string> = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
]);

// Presence of any of these filenames (in cwd or any ancestor up to
// the filesystem root or the first repo sentinel) gates the tier.
// We do not parse the files — presence is a strong enough signal
// that the repo has a formatter running and cosmetic quote drift is
// expected.
const FORMATTER_CONFIG_FILES: readonly string[] = [
  '.oxfmtrc.json',
  '.oxfmtrc',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.toml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'biome.json',
  'biome.jsonc',
  'dprint.json',
  'dprint.jsonc',
];

// Repo sentinels that stop the upward walk. Without these, a
// workspace nested under a user home with an unrelated config file
// would opt in.
const REPO_ROOT_SENTINELS: readonly string[] = ['.git', '.hg', '.jj'];

// Per-directory memo of eligibility. The map is process-local; it is
// safe because config files appearing mid-session is vanishingly rare
// in practice, and a false cached `false` just means the tier stays
// off (equivalent to the old behavior — never a correctness hazard).
const configPresenceCache = new Map<string, boolean>();

export function __resetQuoteTierCacheForTests(): void {
  configPresenceCache.clear();
}

export function hasQuoteTierExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return QUOTE_TIER_EXTENSIONS.has(ext);
}

// Walk upward from `cwd` until a formatter config is found or a repo
// sentinel (or the filesystem root) terminates the walk. Result is
// memoized per directory traversed so later lookups from sibling
// paths short-circuit.
export function hasFormatterConfig(cwd: string): boolean {
  const cached = configPresenceCache.get(cwd);
  if (cached !== undefined) return cached;

  const rootInfo = parsePath(cwd);
  let dir = cwd;
  const visited: string[] = [];
  // Safety cap in case something pathological happens with `dirname`.
  for (let i = 0; i < 64; i++) {
    visited.push(dir);
    for (const name of FORMATTER_CONFIG_FILES) {
      if (existsSync(join(dir, name))) {
        for (const v of visited) configPresenceCache.set(v, true);
        return true;
      }
    }
    let hitSentinel = false;
    for (const sentinel of REPO_ROOT_SENTINELS) {
      if (existsSync(join(dir, sentinel))) {
        hitSentinel = true;
        break;
      }
    }
    if (hitSentinel) break;
    const parent = dirname(dir);
    if (parent === dir || parent === rootInfo.root) {
      // Hit the filesystem root without finding anything.
      break;
    }
    dir = parent;
  }
  for (const v of visited) configPresenceCache.set(v, false);
  return false;
}

// Top-level eligibility predicate. Pure except for the cached fs walk.
export function isQuoteTierEligibleForFile(filePath: string, cwd: string): boolean {
  if (!hasQuoteTierExtension(filePath)) return false;
  return hasFormatterConfig(cwd);
}

// Sentinel used to collapse `'` and `"` to a single equivalence class
// during comparison. Must not appear in source text; \x01 (SOH) is
// a control character never present in valid UTF-8 source files.
const QUOTE_SENTINEL = '\x01';

// NFKC + smart-quote → ASCII + zero-width strip + NBSP → space.
// Mirrors `normalizeForFuzzyMatch` in classic.ts but locally inlined
// to avoid a circular import and to keep this module self-contained.
function normaliseBase(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/\u{200B}|\u{200C}|\u{200D}|\u{FEFF}/gu, '');
}

// Line-level comparator for the quote tier. Two lines are considered
// equal under this tier iff they match after:
//   1. base normalization (NFKC, smart quotes, zero-width, NBSP),
//   2. trim of leading/trailing whitespace (same as `trim` tier),
//   3. replacing every `'` and `"` with a single sentinel.
//
// Intentionally does NOT touch backticks. Intentionally does NOT
// normalize escape sequences — so `\'` vs `'` still differ, which
// propagates to the later guardrail that refuses escape-bearing
// regions.
export function normalizeForQuoteTier(line: string): string {
  return normaliseBase(line).trim().replace(/['"]/g, QUOTE_SENTINEL);
}

// --- Post-match validation ---------------------------------------
//
// Called once the tier cascade has picked a region as a quote-tier
// match. Applies the remaining guardrails (backticks, escaped quotes,
// monomorphic quote style in each side) and, on success, produces a
// translated REPLACE whose straight-quote characters have been
// swapped to match the file's style.
//
// Returns undefined on guardrail failure. Callers treat that as a
// no-match (i.e., fall through to the standard near-miss error); we
// deliberately do NOT fabricate a different error, because the
// near-miss view already shows the model the exact bytes to mirror.

interface QuoteTierValidationInput {
  searchLines: string[];
  fileRegion: string[];
  replaceLines: string[];
}

interface QuoteTierValidationOutput {
  replaceLines: string[];
  direction: '\'->"' | '"->\'';
}

function containsAny(region: string[], needles: readonly string[]): boolean {
  for (const line of region) {
    for (const n of needles) {
      if (line.includes(n)) return true;
    }
  }
  return false;
}

// Which straight-quote characters appear in this region, after base
// normalization. Returns a set of size 0, 1, or 2.
function quoteCharsIn(region: string[]): Set<'"' | "'"> {
  const chars = new Set<'"' | "'">();
  for (const raw of region) {
    const line = normaliseBase(raw);
    for (const ch of line) {
      if (ch === '"' || ch === "'") chars.add(ch);
    }
  }
  return chars;
}

function translateQuotes(lines: string[], from: '"' | "'", to: '"' | "'"): string[] {
  // `'` ↔ `"` is a 1:1 character swap. We do the full symmetric swap
  // so any `"` in REPLACE becomes `'` and vice versa — this preserves
  // relative quote relationships inside a REPLACE that happens to
  // mix both kinds (e.g. switching an outer string whose content is
  // an apostrophe, where prettier's escape-minimizing rule forces the
  // outer quotes to flip).
  return lines.map((line) =>
    line
      .split('')
      .map((ch) => (ch === from ? to : ch === to ? from : ch))
      .join(''),
  );
}

export function validateAndTranslateQuoteTier(
  input: QuoteTierValidationInput,
): QuoteTierValidationOutput | undefined {
  const { searchLines, fileRegion, replaceLines } = input;

  // Guard 1: no backticks anywhere — eliminates every template-literal
  // hazard (content-bearing whitespace, tagged-template semantics,
  // embedded `${}` with quote-laden expressions, etc.).
  if (
    containsAny(searchLines, ['`']) ||
    containsAny(fileRegion, ['`']) ||
    containsAny(replaceLines, ['`'])
  ) {
    return undefined;
  }

  // Guard 2: no escaped-quote sequences — rules out cases where a
  // quote-style swap would alter escape semantics. If SEARCH or file
  // region contains `\'` or `\"`, or if REPLACE contains them, we
  // refuse. This is stricter than strictly necessary but very safe.
  if (
    containsAny(searchLines, ["\\'", '\\"']) ||
    containsAny(fileRegion, ["\\'", '\\"']) ||
    containsAny(replaceLines, ["\\'", '\\"'])
  ) {
    return undefined;
  }

  // Guard 3: SEARCH side must be monomorphic (only one of `'` / `"`),
  // file region must be monomorphic, and they must be opposites.
  // If either side contains both quote kinds, the "direction" of the
  // style shift is ambiguous and we refuse.
  const searchQuotes = quoteCharsIn(searchLines);
  const fileQuotes = quoteCharsIn(fileRegion);
  if (searchQuotes.size !== 1 || fileQuotes.size !== 1) return undefined;
  const [searchQuote] = searchQuotes;
  const [fileQuote] = fileQuotes;
  if (searchQuote === fileQuote) return undefined;
  // At this point searchQuote and fileQuote are opposite; safe to swap.

  // Translate REPLACE so that what the agent wrote as `searchQuote`
  // becomes `fileQuote` in the final file (and any `fileQuote` in
  // REPLACE becomes `searchQuote` — symmetric). We already refused
  // backticks in REPLACE, so this is a pure character-level swap.
  const translated = translateQuotes(replaceLines, searchQuote!, fileQuote!);
  const direction: QuoteTierValidationOutput['direction'] =
    searchQuote === "'" && fileQuote === '"' ? '\'->"' : '"->\'';
  return { replaceLines: translated, direction };
}

// Exposed for the apply-summary line in patch.ts.
export const QUOTE_TIER_NAME = 'quoteStyle' as const;
