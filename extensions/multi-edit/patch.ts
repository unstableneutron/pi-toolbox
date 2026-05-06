import { isAbsolute, resolve as resolvePath } from 'node:path';

import {
  buildFileVersionToken,
  type MutationPlan,
  type PlannedFileMutation,
  type PatchRowRef,
  type FileSnapshot,
} from './mutation-plan';
import {
  createFilesystemBackedOverlayWorkspace,
  createRealWorkspace as createWorkspaceFromFs,
  type FileVersionToken,
  type OverlayWorkspace,
  type Workspace,
} from './workspace';
import {
  detectLineEnding,
  generateDiffString,
  normalizeForFuzzyMatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from './classic';
import {
  isQuoteTierEligibleForFile,
  normalizeForQuoteTier,
  QUOTE_TIER_NAME,
  validateAndTranslateQuoteTier,
} from './quote-tier';

export type AutoFixKind = 'prefix-leak';

export interface UpdateChunk {
  source?: 'hunk' | 'find-replace-once' | 'find-replace-all';
  changeContext?: string[];
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
  addedLines: number;
  removedLines: number;
  modifiedBytes: number;
  // Phase 2: FindReplace flags. `mustBeUnique` means the SEARCH must
  // match exactly once; 0 or 2+ matches fail. Only set for chunks
  // parsed from a `*** FindReplaceOnce:` section.
  mustBeUnique?: boolean;
  // `replaceAll` means the SEARCH must match at least once; every
  // match in the winning tier is replaced. Only set for chunks
  // parsed from a `*** FindReplaceAll:` section.
  replaceAll?: boolean;
  // Parser forgiveness flag. True when the chunk's SEARCH/REPLACE
  // divider was accepted as a non-canonical variant instead of the
  // canonical `======= REPLACE`. Surfaced in the apply_patch summary
  // so the agent learns to prefer the explicit form next time,
  // without failing the call outright.
  lenientDivider?: boolean;
  // Which non-canonical divider form was accepted. `bare` is aider /
  // git-conflict style `=======`; `compact` is frontier-model drift
  // like `=======REPLACE` (missing whitespace before REPLACE).
  dividerStyle?: 'bare' | 'compact';
  // Names of any auto-fixes applied to this chunk's newLines post-parse.
  // The chunk's oldLines are never mutated by autofix. Surfaced in the
  // summary so the agent learns what was changed and why.
  //   'prefix-leak' — stripped leading "+" from every non-blank REPLACE
  //                    line (likely unified-diff syntax leak).
  autoFixed?: AutoFixKind[];
}

export type PatchOperation =
  | { kind: 'add'; path: string; contents: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; chunks: UpdateChunk[] };

export type PatchOperationState =
  | 'streaming'
  | 'streamed'
  | 'staging'
  | 'staged'
  | 'invalidated'
  | 'committing'
  | 'applying'
  | 'applied'
  | 'failed';

export type PatchPreviewRow =
  | {
      id?: string;
      kind: 'edit' | 'create';
      path: string;
      addedLines: number;
      removedLines: number;
      modifiedBytes: number;
      renameOnly: false;
      state: PatchOperationState;
    }
  | {
      id?: string;
      kind: 'move';
      path: string;
      targetPath: string;
      addedLines: number;
      removedLines: number;
      modifiedBytes: number;
      renameOnly: boolean;
      state: PatchOperationState;
    }
  | {
      id?: string;
      kind: 'delete';
      path: string;
      state: PatchOperationState;
      contentKind?: 'text' | 'binary';
      byteLength?: number;
      lineCount?: number;
    };

type StreamingPatchOperation = PatchOperation & {
  state: 'streaming' | 'streamed';
};

interface PatchOpResult {
  path: string;
  message: string;
  diff?: string;
  firstChangedLine?: number;
  operation: PatchPreviewRow;
  usedFuzzy?: boolean;
  // True when any chunk matched via the `quoteStyle` tier and its
  // REPLACE was re-quoted on apply. Orthogonal to `usedFuzzy` — the
  // summary text surfaces a distinct advisory so the agent knows to
  // mirror file quote style on future patches.
  usedQuoteStyle?: boolean;
  // Phase 2: total occurrences replaced by FindReplaceAll chunks in
  // this op. Undefined when the op had no FindReplaceAll chunks.
  replaceAllCount?: number;
}

// Phase 1 (P0) near-miss diagnostics.
//
// When context matching fails, `PatchContextMatchError` carries a
// structured payload describing what almost matched, so callers can
// render an actionable failure message without a round-trip to re-read
// the file. The payload fields:
//
// - `nearestMatch` — the best candidate region, pattern-width, plus
//   a small margin on either side. `score` is overall similarity,
//   `perLineSignals` marks which pattern lines drifted.
// - `nearbyIdentifiers` — for anchor misses, the top-N lines that
//   share tokens with the anchor, so the agent can see "did you
//   mean…" candidates.
// - `scanTruncated` — true when sampling was used on a very large
//   file. The nearest match is still returned but the scan was
//   incomplete.
//
// The error's `.message` is a short one-liner; the rich rendering
// happens at the result-formatting layer (Phase 1 commit 2).

type MatchTier = 'exact' | 'rstrip' | 'trim' | 'fuzzy' | 'quoteStyle';

interface PerLineMatchSignal {
  patternIndex: number;
  matched: boolean;
  tier?: MatchTier;
  expected: string;
  actual?: string;
}

interface NearestMatch {
  startLine: number; // 1-indexed line in file; first line of actualLines
  score: number; // 0.0-1.0 fraction of pattern lines that matched at any tier
  tierTried: MatchTier | 'none';
  actualLines: string[]; // pattern-width, aligned with expectedLines
  marginBefore: string[]; // up to 3 lines immediately before actualLines
  marginAfter: string[]; // up to 3 lines immediately after actualLines
  perLineSignals: PerLineMatchSignal[];
}

interface ContextMatchFailure {
  kind: 'context-not-found' | 'anchor-not-found';
  filePath: string;
  searchedFrom: number;
  expectedLines: string[];
  anchor?: string;
  nearestMatch?: NearestMatch;
  nearbyIdentifiers?: Array<{ line: number; text: string }>;
  scanTruncated?: boolean;
  // When the failing chunk carries replacement text, these preserve
  // its source and newLines so renderers can emit targeted retry
  // guidance: hunk failures get a FindReplaceOnce-shaped rewrite,
  // while FindReplace near-misses can show a corrected SEARCH block
  // from the current file. Hunks fail 3× more often than FindReplace
  // in practice (session-log analysis, 7-day window), so keeping the
  // replacement payload turns failures into copy-pasteable retries.
  chunkSource?: 'hunk' | 'find-replace-once' | 'find-replace-all';
  chunkNewLines?: string[];
}

export class PatchContextMatchError extends Error {
  readonly failure: ContextMatchFailure;

  constructor(failure: ContextMatchFailure) {
    super(summarizeContextMatchFailure(failure));
    this.failure = failure;
    this.name = 'PatchContextMatchError';
  }
}

// Aggregated plan-phase failure. When `buildPatchPlan` evaluates all
// ops via lookahead, each individual PatchContextMatchError is
// collected; if any occurred, the plan phase rejects with this error
// carrying every failure so the agent can fix all of them in one
// round-trip instead of discovering them one at a time.
interface PlanOpStatus {
  opIndex: number;
  opId: string;
  path: string;
  kind: 'update' | 'add' | 'delete' | 'move';
  wouldApply: boolean;
  failure?: ContextMatchFailure;
}

export class PatchPlanFailedError extends Error {
  readonly failures: ContextMatchFailure[];
  readonly statuses: PlanOpStatus[];

  constructor(statuses: PlanOpStatus[]) {
    const failures = statuses.filter((s) => s.failure !== undefined).map((s) => s.failure!);
    super(renderPlanFailure(statuses));
    this.statuses = statuses;
    this.failures = failures;
    this.name = 'PatchPlanFailedError';
  }
}

function summarizeContextMatchFailure(failure: ContextMatchFailure): string {
  if (failure.kind === 'anchor-not-found') {
    return `Failed to find anchor '${failure.anchor ?? ''}' in ${failure.filePath}`;
  }
  if (failure.nearestMatch && failure.nearestMatch.tierTried !== 'none') {
    const pct = Math.round(failure.nearestMatch.score * 100);
    return `Failed to find expected lines in ${failure.filePath} near line ${failure.nearestMatch.startLine} (${pct}% similar, ${failure.nearestMatch.tierTried}-normalized)`;
  }
  return `Failed to find expected lines in ${failure.filePath} (no close match)`;
}

// Rich unified-diff renderer for agent-facing error text. Produces
// the format documented in the Phase 1 design:
//
//   Near-miss in src/foo.ts at line 42 (83% similar, trim-normalized):
//
//     41     await initConfigLoader();
//     42 -   const config = loadConfig();
//     42 +   const config = await loadConfig();
//     43 -   return config.port;
//     43 +   return config.port ?? 3000;
//     44   }
//
// Each margin line gets a space marker; drift lines pair `-` for
// expected and `+` for actual at the same file line. Line numbers
// repeat on drift pairs so the agent can see both refer to the
// same file position.
export function renderContextMatchFailure(failure: ContextMatchFailure): string {
  if (failure.kind === 'anchor-not-found') {
    return renderAnchorFailure(failure);
  }
  return renderContextNotFound(failure);
}

function padLineNumber(n: number, width: number): string {
  return String(n).padStart(width, ' ');
}

function renderContextNotFound(failure: ContextMatchFailure): string {
  const parts: string[] = [];
  const near = failure.nearestMatch;

  // Threshold: if soft similarity can't even surface a ~30% similar
  // region, fall back to the bare "no close match" form. Otherwise
  // render the diff-style layout so the agent can see both expected
  // and actual text without a re-read.
  const SOFT_MATCH_FLOOR = 0.3;
  if (!near || (near.tierTried === 'none' && near.score < SOFT_MATCH_FLOOR)) {
    parts.push(`No close match for pattern in ${failure.filePath}.`);
    parts.push('');
    parts.push(
      `Expected (${failure.expectedLines.length} line${failure.expectedLines.length === 1 ? '' : 's'}):`,
    );
    for (const line of failure.expectedLines.slice(0, 8)) {
      parts.push(`  ${line}`);
    }
    if (failure.expectedLines.length > 8) {
      parts.push(`  ... (${failure.expectedLines.length - 8} more)`);
    }
    if (failure.scanTruncated) {
      parts.push('');
      parts.push('(scan truncated on large file)');
    }
    parts.push('');
    parts.push('Tip: pattern may have moved or been removed — consider grep or re-read.');

    const suggestion = maybeRenderHunkRewriteSuggestion(failure);
    if (suggestion) {
      parts.push('');
      parts.push(suggestion);
    }
    return parts.join('\n');
  }

  const pct = Math.round(near.score * 100);
  const tierLabel = near.tierTried === 'none' ? 'soft-similar' : `${near.tierTried}-normalized`;
  parts.push(
    `Near-miss in ${failure.filePath} at line ${near.startLine} (${pct}% similar, ${tierLabel}):`,
  );
  parts.push('');

  const lastLineNumber = near.startLine + near.actualLines.length + near.marginAfter.length;
  const lineNumWidth = String(lastLineNumber).length;

  // Margin before
  let lineNo = near.startLine - near.marginBefore.length;
  for (const line of near.marginBefore) {
    parts.push(`  ${padLineNumber(lineNo, lineNumWidth)}   ${line}`);
    lineNo++;
  }
  // Drift region — expected/actual pairs at the same file line
  for (let i = 0; i < near.actualLines.length; i++) {
    const signal = near.perLineSignals[i];
    if (signal && signal.matched) {
      parts.push(`  ${padLineNumber(lineNo, lineNumWidth)}   ${near.actualLines[i]}`);
    } else {
      parts.push(`  ${padLineNumber(lineNo, lineNumWidth)} - ${failure.expectedLines[i] ?? ''}`);
      parts.push(`  ${padLineNumber(lineNo, lineNumWidth)} + ${near.actualLines[i] ?? ''}`);
    }
    lineNo++;
  }
  // Margin after
  for (const line of near.marginAfter) {
    parts.push(`  ${padLineNumber(lineNo, lineNumWidth)}   ${line}`);
    lineNo++;
  }

  if (failure.scanTruncated) {
    parts.push('');
    parts.push('(scan truncated on large file)');
  }
  parts.push('');
  parts.push(
    'Probable cause: the file changed since you read it, or the SEARCH block includes text already edited by an earlier operation.',
  );
  parts.push(
    'Tip: rebuild using the actual text above; no re-read needed unless you suspect broader drift.',
  );

  const correctedSearch = maybeRenderCorrectedSearchBlock(failure);
  if (correctedSearch) {
    parts.push('');
    parts.push(correctedSearch);
  }

  const suggestion = maybeRenderHunkRewriteSuggestion(failure);
  if (suggestion) {
    parts.push('');
    parts.push(suggestion);
  }
  return parts.join('\n');
}

// When the failing chunk is a hunk with both SEARCH and REPLACE
// content, emit a FindReplaceOnce-shaped rewrite suggestion that the
// agent can copy-paste. Hunks fail 3× more often than FindReplace in
// practice (session-log analysis, 7-day window); this suggestion
// converts the error from "no match" into "here's a rewrite that
// does the same edit in a more reliable shape."
function maybeRenderCorrectedSearchBlock(failure: ContextMatchFailure): string | undefined {
  if (failure.chunkSource !== 'find-replace-once' && failure.chunkSource !== 'find-replace-all') {
    return undefined;
  }
  const near = failure.nearestMatch;
  if (!near || near.score < 0.5 || near.actualLines.length === 0) return undefined;
  if (near.actualLines.every((line) => line.trim().length === 0)) return undefined;

  return [
    'Corrected SEARCH block from the current file:',
    '<<<<<<< SEARCH',
    ...near.actualLines,
    '======= REPLACE',
    ...(failure.chunkNewLines ?? []),
    '>>>>>>> REPLACE',
  ].join('\n');
}

function maybeRenderHunkRewriteSuggestion(failure: ContextMatchFailure): string | undefined {
  if (failure.chunkSource !== 'hunk') return undefined;
  const search = failure.expectedLines;
  const replace = failure.chunkNewLines;
  // Need both SEARCH and REPLACE content to emit a non-degenerate
  // FindReplaceOnce rewrite.
  if (!search || search.length === 0) return undefined;
  if (!replace || replace.length === 0) return undefined;
  if (search.every((l) => l.trim().length === 0)) return undefined;
  if (replace.every((l) => l.trim().length === 0)) return undefined;
  const lines = [
    'This was an @@ hunk. Hunks fail ~3× more often than FindReplaceOnce in practice.',
    'Consider rewriting as:',
    '',
    '*** FindReplaceOnce:',
    '<<<<<<< SEARCH',
    ...search,
    '======= REPLACE',
    ...replace,
    '>>>>>>> REPLACE',
  ];
  return lines.join('\n');
}

function renderAnchorFailure(failure: ContextMatchFailure): string {
  const parts: string[] = [];
  parts.push(`Failed to find anchor '${failure.anchor ?? ''}' in ${failure.filePath}.`);
  const ids = failure.nearbyIdentifiers ?? [];
  if (ids.length > 0) {
    parts.push('');
    parts.push('Nearby identifiers:');
    for (const id of ids) {
      parts.push(`  line ${id.line}: ${id.text}`);
    }
  }
  parts.push('');
  parts.push('Tip: the anchor may be stale — check those nearby identifiers or re-read.');
  return parts.join('\n');
}

const MAX_RENDERED_FAILURES = 10;

// Rich renderer for lookahead-aggregated plan failures. Shows up to
// MAX_RENDERED_FAILURES per-op diagnostics followed by a validity
// summary row per op so the agent sees everything it needs to retry
// in one response.
export function renderPlanFailure(
  statuses: PlanOpStatus[],
  filePath: (path: string) => string = (p) => p,
): string {
  const parts: string[] = [];
  const failed = statuses.filter((s) => !s.wouldApply);
  const ok = statuses.filter((s) => s.wouldApply);

  parts.push(
    `Failed to apply patch. ${failed.length} operation${failed.length === 1 ? '' : 's'} would fail; ${ok.length} would succeed (all rolled back per atomic policy).`,
  );

  const shown = failed.slice(0, MAX_RENDERED_FAILURES);
  const hidden = failed.length - shown.length;
  for (const status of shown) {
    parts.push('');
    parts.push(`— ${status.opId} (${status.kind} ${filePath(status.path)}):`);
    parts.push(renderContextMatchFailure(status.failure!));
  }
  if (hidden > 0) {
    parts.push('');
    parts.push(
      `... and ${hidden} more operation${hidden === 1 ? '' : 's'} would fail; see details for full list.`,
    );
  }

  parts.push('');
  parts.push('Validity:');
  for (const status of statuses) {
    const marker = status.wouldApply ? '✓' : '✗';
    const note = status.wouldApply ? 'would apply cleanly' : (status.failure?.kind ?? 'failed');
    parts.push(`  ${status.opId} ${filePath(status.path)}: ${marker} ${note}`);
  }

  parts.push('');
  parts.push(
    'Tip: fix the failing ops and resubmit the whole patch, OR split passing ops into a separate apply_patch call to commit them independently.',
  );
  return parts.join('\n');
}

interface PreparedPatchLines {
  lines: string[];
  patchComplete: boolean;
  /**
   * How many stray `*** End Patch` markers were merged away because
   * they sat between operations rather than terminating the payload.
   * Surfaced in the final `summaryText` as an advisory so the agent
   * learns to emit exactly one `*** Begin Patch` / `*** End Patch`
   * pair per `apply_patch` call.
   */
  mergedEnvelopes: number;
  /**
   * True when the payload was missing `*** Begin Patch` and
   * `*** End Patch` but started with a valid operation header
   * (`*** Add File:`, `*** Update File:`, `*** Delete File:`).
   * The preparer synthesized a wrapping envelope so the rest of
   * the parser works unchanged. Surfaced as an advisory so the
   * agent learns to always emit the full envelope.
   */
  autoWrappedEnvelope: boolean;
}

const BEGIN_PATCH_LINE = '*** Begin Patch';
const END_PATCH_LINE = '*** End Patch';
// Op-header prefixes. We match on the colon (no required trailing
// space) so the streaming parser can surface an in-progress op row
// the moment the model commits to a kind, not when it later emits the
// first path character. Parsers that need the path extract it with
// `line.slice(PREFIX.length).trim()`, which tolerates either `': '`
// or `':'` styles.
const ADD_FILE_PREFIX = '*** Add File:';
const DELETE_FILE_PREFIX = '*** Delete File:';
const UPDATE_FILE_PREFIX = '*** Update File:';
const MOVE_TO_PREFIX = '*** Move to:';
// Phase 2 FindReplace markers. FindReplace blocks are continuations
// inside a `*** Update File:` section, not top-level operations.
const FIND_REPLACE_ONCE_PREFIX = '*** FindReplaceOnce:';
const FIND_REPLACE_ALL_PREFIX = '*** FindReplaceAll:';
const FIND_REPLACE_SEARCH_MARKER = '<<<<<<< SEARCH';
// Divider is deliberately `======= REPLACE` (not bare `=======`) to
// avoid collision with 7-char git merge-conflict markers in edited
// files. SEARCH or REPLACE blocks may contain literal `=======`
// lines; only the full `======= REPLACE` form terminates the block.
const FIND_REPLACE_DIVIDER = '======= REPLACE';
// Whitespace-tolerant form of the canonical divider. Accepts the
// exact `======= REPLACE` plus any variant where `=======` and
// `REPLACE` are separated by one or more whitespace characters
// (tabs, multiple spaces). Observed in session-log analysis where
// agents occasionally emit `=======  REPLACE` (two spaces) or
// `=======\tREPLACE` (tab). These are semantically identical to
// the canonical form — the whitespace is normalized silently,
// without setting `lenientDivider` (which is reserved for the
// genuinely non-canonical bare `=======` aider form).
const FIND_REPLACE_DIVIDER_RE = /^=======[ \t]+REPLACE[ \t]*$/;
const FIND_REPLACE_COMPACT_DIVIDER_RE = /^=======REPLACE[ \t]*$/;
// Aider / git-conflict style bare divider. Accepted as a fallback
// only when the canonical `======= REPLACE` form is absent from the
// chunk and exactly one bare `=======` line appears before the end
// marker. Frontier models often emit the bare form because their
// training data is saturated with aider SEARCH/REPLACE examples; the
// fallback forgives that drift without losing the explicit form as
// an escape hatch for files that genuinely contain `=======` content
// (markdown HRs, RST underlines, committed conflict fixtures).
const FIND_REPLACE_BARE_DIVIDER = '=======';
const FIND_REPLACE_END_MARKER = '>>>>>>> REPLACE';

function resolvePatchPath(cwd: string, filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) throw new Error('Patch path cannot be empty');
  return isAbsolute(trimmed) ? resolvePath(trimmed) : resolvePath(cwd, trimmed);
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function normaliseLineForFuzzyMatch(s: string): string {
  return normalizeForFuzzyMatch(s).trim();
}

// Phase 1.5: return tier information alongside the match index so
// callers can surface `usedFuzzy` when a match required normalization.
interface SequenceMatch {
  startIndex: number;
  tier: MatchTier;
}

function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
  options?: { allowQuoteStyleTier?: boolean },
): SequenceMatch | undefined {
  if (pattern.length === 0) return { startIndex: start, tier: 'exact' };
  if (pattern.length > lines.length) return undefined;

  const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
  const searchEnd = lines.length - pattern.length;
  const exactEqual = (a: string, b: string) => a === b;
  const rstripEqual = (a: string, b: string) => a.trimEnd() === b.trimEnd();
  const trimEqual = (a: string, b: string) => a.trim() === b.trim();
  const fuzzyEqual = (a: string, b: string) =>
    normaliseLineForFuzzyMatch(a) === normaliseLineForFuzzyMatch(b);
  const quoteStyleEqual = (a: string, b: string) =>
    normalizeForQuoteTier(a) === normalizeForQuoteTier(b);
  const tiers: Array<{ eq: (a: string, b: string) => boolean; tier: MatchTier }> = [
    { eq: exactEqual, tier: 'exact' },
    { eq: rstripEqual, tier: 'rstrip' },
    { eq: trimEqual, tier: 'trim' },
    { eq: fuzzyEqual, tier: 'fuzzy' },
  ];
  if (options?.allowQuoteStyleTier === true) {
    tiers.push({ eq: quoteStyleEqual, tier: 'quoteStyle' });
  }

  for (const { eq, tier } of tiers) {
    for (let i = searchStart; i <= searchEnd; i++) {
      let ok = true;
      for (let j = 0; j < pattern.length; j++) {
        if (!eq(lines[i + j], pattern[j])) {
          ok = false;
          break;
        }
      }
      if (ok) return { startIndex: i, tier };
    }
  }
  return undefined;
}

function applyReplacements(
  lines: string[],
  replacements: Array<[number, number, string[]]>,
): string[] {
  const next = [...lines];
  for (const [start, oldLen, newSegment] of [...replacements].sort((a, b) => b[0] - a[0])) {
    next.splice(start, oldLen, ...newSegment);
  }
  return next;
}

// `quoteStyle` is intentionally excluded from this list: it drives
// whether a match succeeds at apply time, but near-miss rendering
// (via `bestTierForPair` / `findNearestSequence`) should still treat
// quote drift as a visible `-/+` in the diagnostic — otherwise the
// agent sees "100% similar" with no rendered diff when a guardrail
// rejects a quote-tier match, which is confusing. Keeping the order
// at the four strict tiers makes quote drift show up line-by-line.
const MATCH_TIER_ORDER: MatchTier[] = ['exact', 'rstrip', 'trim', 'fuzzy'];
const LARGE_FILE_SAMPLING_THRESHOLD = 5000;
const DEFAULT_MARGIN_SIZE = 3;
const MAX_NEARBY_IDENTIFIERS = 5;

function compareLines(a: string, b: string, tier: MatchTier): boolean {
  if (tier === 'exact') return a === b;
  if (tier === 'rstrip') return a.trimEnd() === b.trimEnd();
  if (tier === 'trim') return a.trim() === b.trim();
  if (tier === 'fuzzy') {
    return normaliseLineForFuzzyMatch(a) === normaliseLineForFuzzyMatch(b);
  }
  // quoteStyle: collapses `'` and `"` on top of trim+fuzzy
  // normalization. Intentionally never matches lines containing a
  // backtick against a non-backtick-equivalent form — the separate
  // post-match validator enforces that no backtick survives the
  // region, which is the stronger guarantee callers rely on.
  return normalizeForQuoteTier(a) === normalizeForQuoteTier(b);
}

function bestTierForPair(actual: string, expected: string): MatchTier | undefined {
  for (const tier of MATCH_TIER_ORDER) {
    if (compareLines(actual, expected, tier)) return tier;
  }
  return undefined;
}

function buildPerLineSignals(
  actualSlice: string[],
  expected: string[],
): { signals: PerLineMatchSignal[]; matchCount: number; winningTier: MatchTier | 'none' } {
  const signals: PerLineMatchSignal[] = [];
  let matchCount = 0;
  const tiersUsed = new Set<MatchTier>();
  for (let i = 0; i < expected.length; i++) {
    const actual = actualSlice[i] ?? '';
    const tier = bestTierForPair(actual, expected[i]!);
    if (tier) {
      signals.push({ patternIndex: i, matched: true, tier, expected: expected[i]!, actual });
      matchCount++;
      tiersUsed.add(tier);
    } else {
      signals.push({ patternIndex: i, matched: false, expected: expected[i]!, actual });
    }
  }
  // Pick the coarsest tier actually used — if any line needed fuzzy to
  // match, report 'fuzzy' since the overall region relied on that level
  // of normalization.
  let winningTier: MatchTier | 'none' = 'none';
  for (const tier of MATCH_TIER_ORDER) {
    if (tiersUsed.has(tier)) winningTier = tier;
  }
  return { signals, matchCount, winningTier };
}

function extractMargin(
  lines: string[],
  startIndex0: number,
  patternLength: number,
  size = DEFAULT_MARGIN_SIZE,
): { before: string[]; after: string[] } {
  const beforeStart = Math.max(0, startIndex0 - size);
  const afterEnd = Math.min(lines.length, startIndex0 + patternLength + size);
  return {
    before: lines.slice(beforeStart, startIndex0),
    after: lines.slice(startIndex0 + patternLength, afterEnd),
  };
}

// Soft per-line similarity for breaking ties when no tier matches
// exactly. Uses character bigram Jaccard — cheap, reasonable signal,
// language-agnostic.
function softLineSimilarity(a: string, b: string): number {
  const normA = a.trim().toLowerCase();
  const normB = b.trim().toLowerCase();
  if (normA === normB) return 1;
  if (normA.length === 0 || normB.length === 0) return 0;
  if (normA.length < 2 || normB.length < 2) {
    return normA === normB ? 1 : 0;
  }
  const bigramsA = new Set<string>();
  for (let i = 0; i < normA.length - 1; i++) bigramsA.add(normA.substring(i, i + 2));
  const bigramsB = new Set<string>();
  for (let i = 0; i < normB.length - 1; i++) bigramsB.add(normB.substring(i, i + 2));
  let shared = 0;
  for (const bg of bigramsA) if (bigramsB.has(bg)) shared++;
  const total = bigramsA.size + bigramsB.size - shared;
  return total > 0 ? shared / total : 0;
}

function findNearestSequence(
  lines: string[],
  pattern: string[],
  searchStart: number,
): NearestMatch | undefined {
  if (pattern.length === 0) return undefined;
  const latest = lines.length - pattern.length;
  if (latest < searchStart) return undefined;

  const sampling = lines.length > LARGE_FILE_SAMPLING_THRESHOLD;
  const step = sampling ? 2 : 1;

  let bestIndex = -1;
  let bestMatchCount = -1;
  let bestSoftScore = -1;

  for (let i = searchStart; i <= latest; i += step) {
    const slice = lines.slice(i, i + pattern.length);
    const { matchCount } = buildPerLineSignals(slice, pattern);
    let softScore = 0;
    for (let j = 0; j < pattern.length; j++) {
      softScore += softLineSimilarity(slice[j] ?? '', pattern[j]!);
    }
    if (
      matchCount > bestMatchCount ||
      (matchCount === bestMatchCount && softScore > bestSoftScore)
    ) {
      bestMatchCount = matchCount;
      bestSoftScore = softScore;
      bestIndex = i;
      if (matchCount === pattern.length) break; // perfect hit
    }
  }

  if (bestIndex < 0) return undefined;

  const slice = lines.slice(bestIndex, bestIndex + pattern.length);
  const { signals, matchCount: finalMatchCount, winningTier } = buildPerLineSignals(slice, pattern);
  const margin = extractMargin(lines, bestIndex, pattern.length);

  // When no tier matched anywhere but soft similarity surfaced a
  // candidate, report the soft score so the agent has a sense of how
  // close the nearest region is. `tierTried` stays 'none' to signal
  // that no tier-level match exists.
  const score =
    winningTier === 'none' ? bestSoftScore / pattern.length : finalMatchCount / pattern.length;

  return {
    startLine: bestIndex + 1,
    score,
    tierTried: winningTier,
    actualLines: slice,
    marginBefore: margin.before,
    marginAfter: margin.after,
    perLineSignals: signals,
  };
}

function tokenize(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9_]+/)
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase());
}

function findNearestAnchor(lines: string[], anchor: string): Array<{ line: number; text: string }> {
  const anchorTokens = new Set(tokenize(anchor));
  if (anchorTokens.size === 0) return [];
  const scored: Array<{ line: number; text: string; overlap: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const tokens = tokenize(lines[i]!);
    let overlap = 0;
    for (const t of tokens) if (anchorTokens.has(t)) overlap++;
    if (overlap > 0) {
      scored.push({ line: i + 1, text: lines[i]!, overlap });
    }
  }
  scored.sort((a, b) => b.overlap - a.overlap || a.line - b.line);
  return scored.slice(0, MAX_NEARBY_IDENTIFIERS).map(({ line, text }) => ({ line, text }));
}

interface DeriveUpdatedResult {
  content: string;
  usedFuzzy: boolean;
  // True when any chunk matched via the `quoteStyle` tier and its
  // REPLACE was re-quoted on apply. Orthogonal to `usedFuzzy` so
  // callers can surface a distinct advisory.
  usedQuoteStyle?: boolean;
  // Per-chunk match counts for FindReplaceAll reporting. Other chunk
  // kinds (hunks, FindReplaceOnce) never produce a count > 1; the
  // map is keyed by chunk index in `chunks[]` so the caller can
  // surface per-op totals without re-running the match scan.
  replaceAllCounts?: Map<number, number>;
}

// Phase 2 helper: find ALL match positions in the winning tier.
// Uses the same tier cascade as `seekSequence` (exact → rstrip →
// trim → fuzzy). First tier with any matches "wins"; the full list
// of positions within that tier is returned. Tiers are never mixed.
function seekAllInWinningTier(
  lines: string[],
  pattern: string[],
  searchStart: number,
  options?: { allowQuoteStyleTier?: boolean },
): { tier: MatchTier; positions: number[] } | undefined {
  if (pattern.length === 0) return { tier: 'exact', positions: [searchStart] };
  const searchEnd = lines.length - pattern.length;
  if (searchEnd < searchStart) return undefined;
  const comparators: Array<{ eq: (a: string, b: string) => boolean; tier: MatchTier }> = [
    { eq: (a, b) => a === b, tier: 'exact' },
    { eq: (a, b) => a.trimEnd() === b.trimEnd(), tier: 'rstrip' },
    { eq: (a, b) => a.trim() === b.trim(), tier: 'trim' },
    {
      eq: (a, b) => normaliseLineForFuzzyMatch(a) === normaliseLineForFuzzyMatch(b),
      tier: 'fuzzy',
    },
  ];
  if (options?.allowQuoteStyleTier === true) {
    comparators.push({
      eq: (a, b) => normalizeForQuoteTier(a) === normalizeForQuoteTier(b),
      tier: 'quoteStyle',
    });
  }

  for (const { eq, tier } of comparators) {
    const positions: number[] = [];
    let i = searchStart;
    while (i <= searchEnd) {
      let ok = true;
      for (let j = 0; j < pattern.length; j++) {
        if (!eq(lines[i + j]!, pattern[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        positions.push(i);
        // Non-overlapping matches — advance past the full pattern so
        // a SEARCH of "aa" in "aaaa" yields positions 0 and 2, not
        // 0/1/2/3.
        i += pattern.length;
      } else {
        i++;
      }
    }
    if (positions.length > 0) return { tier, positions };
  }
  return undefined;
}

export class AmbiguousFindReplaceOnceError extends Error {
  readonly filePath: string;
  readonly matchLines: number[];
  readonly matchPreviews: string[];

  constructor(filePath: string, matchLines: number[], matchPreviews: string[] = []) {
    const previewText = matchPreviews.length > 0 ? `\n${matchPreviews.join('\n\n')}` : '';
    super(
      [
        `FindReplaceOnce in ${filePath} found ${matchLines.length} matches; expected exactly 1: ${matchLines.map((l) => `line ${l}`).join(', ')}.`,
        previewText,
        '',
        'Tip: expand SEARCH with surrounding context to make it unique, or use FindReplaceAll if every occurrence should change.',
      ]
        .filter((part) => part.length > 0)
        .join('\n'),
    );
    this.filePath = filePath;
    this.matchLines = matchLines;
    this.matchPreviews = matchPreviews;
    this.name = 'AmbiguousFindReplaceOnceError';
  }
}

function buildAmbiguousMatchPreviews(
  lines: string[],
  positions: number[],
  patternLength: number,
): string[] {
  const margin = 1;
  return positions.map((position, index) => {
    const start = Math.max(0, position - margin);
    const end = Math.min(lines.length, position + Math.max(1, patternLength) + margin);
    const rendered = [`Match ${index + 1} at line ${position + 1}:`];
    for (let i = start; i < end; i++) {
      const marker = i >= position && i < position + patternLength ? '>' : ' ';
      rendered.push(`  ${String(i + 1).padStart(4, ' ')} ${marker} ${lines[i] ?? ''}`);
    }
    return rendered.join('\n');
  });
}

// Indent-aware replacement. When a hunk matched at a
// whitespace-tolerant tier (rstrip/trim/fuzzy), the PATCH's SEARCH
// lines had different leading whitespace than the FILE region they
// matched against. Inserting REPLACE verbatim would produce
// structurally wrong indentation. Detect the indent delta between
// the first non-blank line of pattern and the first non-blank line
// of the file region, then strip the patch indent prefix from each
// REPLACE line and replace with the file indent. Blank lines in
// REPLACE stay blank.
function reindentReplaceLines(
  patchPattern: string[],
  fileRegion: string[],
  replaceLines: string[],
): string[] {
  const { patchIndent, fileIndent } = detectIndentDelta(patchPattern, fileRegion);
  // No delta → no rewrite. Preserves byte-identical behavior for
  // cases where the tier mismatch was caused by something other than
  // indent (e.g., trailing whitespace, unicode quotes).
  if (patchIndent === fileIndent) return replaceLines;
  return replaceLines.map((line) => reindentLine(line, patchIndent, fileIndent));
}

function detectIndentDelta(
  patchPattern: string[],
  fileRegion: string[],
): { patchIndent: string; fileIndent: string } {
  // Walk the paired lines and keep the first pair where both have
  // non-blank content AND the leading whitespace differs. That's
  // the load-bearing delta the REPLACE lines should be rewritten
  // against. Ignoring lines that are zero-indent on both sides
  // (e.g., function-signature context lines) avoids emitting a
  // zero-delta result when the true indent drift was on the body.
  for (let i = 0; i < Math.min(patchPattern.length, fileRegion.length); i++) {
    const p = patchPattern[i] ?? '';
    const f = fileRegion[i] ?? '';
    if (p.trim().length === 0 || f.trim().length === 0) continue;
    const patchIndent = leadingWhitespace(p);
    const fileIndent = leadingWhitespace(f);
    if (patchIndent === fileIndent) continue;
    return { patchIndent, fileIndent };
  }
  return { patchIndent: '', fileIndent: '' };
}

function leadingWhitespace(line: string): string {
  const match = /^[\t ]*/.exec(line);
  return match ? match[0] : '';
}

function reindentLine(line: string, patchIndent: string, fileIndent: string): string {
  // Blank / whitespace-only lines stay unchanged.
  if (line.trim().length === 0) return line;
  // If the line's leading whitespace starts with `patchIndent`, swap
  // that prefix for `fileIndent` and leave any extra indentation
  // beyond the prefix alone. That way a line indented deeper than
  // `patchIndent` (e.g. nested body) still shifts by the same delta.
  if (patchIndent.length > 0 && line.startsWith(patchIndent)) {
    return fileIndent + line.slice(patchIndent.length);
  }
  // Line's leading whitespace doesn't start with `patchIndent`
  // (e.g., the line has less indent than the anchor). Leave it
  // alone — we can't infer a safe rewrite.
  return line;
}

// Soft-anchor fallback. Used only by `@@ <label>` context-anchor
// resolution, never by SEARCH-block matching (where whole-line
// semantics are load-bearing). Tries two successively-looser match
// tiers:
//
//   'prefix'    — file line starts with the anchor (after trimStart)
//   'substring' — anchor appears anywhere in the file line (after trim)
//
// Each tier accepts only when exactly one remaining file line
// matches. Zero matches or 2+ matches cause the tier to reject;
// `undefined` propagates up so the caller emits the standard
// anchor-not-found error.
function resolveSoftAnchor(
  lines: string[],
  anchor: string,
  start: number,
): SequenceMatch | undefined {
  const trimmedAnchor = anchor.trim();
  if (trimmedAnchor.length === 0) return undefined;

  type Predicate = (line: string) => boolean;
  const tiers: Predicate[] = [
    (line) => line.trimStart().startsWith(trimmedAnchor),
    (line) => line.trim().includes(trimmedAnchor),
  ];
  for (const pred of tiers) {
    const matches: number[] = [];
    for (let i = start; i < lines.length; i++) {
      if (pred(lines[i] ?? '')) matches.push(i);
    }
    if (matches.length === 1) {
      // Report as 'fuzzy' tier so existing usedFuzzy plumbing kicks
      // in and the summary can surface the softening without a new
      // tier enum value.
      return { startIndex: matches[0]!, tier: 'fuzzy' };
    }
  }
  return undefined;
}

// Post-match validation helper. When a chunk matched at the
// `quoteStyle` tier, run the REPLACE guardrails (backticks, escaped
// quotes, monomorphic quote style) and, on success, return the
// re-quoted REPLACE lines. On failure, returns undefined; the caller
// must treat the tier-match as if no match occurred, producing the
// standard near-miss diagnostic.
function validateQuoteStyleMatch(
  searchLines: string[],
  fileRegion: string[],
  replaceLines: string[],
): { newLines: string[] } | undefined {
  const result = validateAndTranslateQuoteTier({
    searchLines,
    fileRegion,
    replaceLines,
  });
  if (!result) return undefined;
  return { newLines: result.replaceLines };
}

function deriveUpdatedNormalizedContent(
  filePath: string,
  normalizedContent: string,
  chunks: UpdateChunk[],
  options?: { allowQuoteStyleTier?: boolean },
): DeriveUpdatedResult {
  const hadTrailingNewline = normalizedContent.endsWith('\n');
  const originalLines = normalizedContent.split('\n');
  if (originalLines[originalLines.length - 1] === '') originalLines.pop();

  const allowQuoteStyleTier = options?.allowQuoteStyleTier === true;
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;
  let usedFuzzy = false;
  let usedQuoteStyle = false;
  let replaceAllCounts: Map<number, number> | undefined;

  for (const [chunkIndex, chunk] of chunks.entries()) {
    if (chunk.changeContext && chunk.changeContext.length > 0) {
      for (const anchor of chunk.changeContext) {
        // Anchors do not carry a REPLACE of their own; quote-tier
        // anchor matching would only advance lineIndex. For the MVP
        // we keep anchor matching conservative and do NOT enable the
        // quote tier here — re-evaluate if real patches surface a
        // pain point.
        let ctxMatch: SequenceMatch | undefined = seekSequence(
          originalLines,
          [anchor],
          lineIndex,
          false,
        );
        if (ctxMatch === undefined) {
          // Soft-anchor fallback. `seekSequence` matches anchors as
          // whole lines with tiered whitespace/quote tolerance. When
          // none of those tiers produced a hit, try:
          //   (a) prefix match — file line starts with anchor text
          //   (b) substring match — anchor appears anywhere in line
          // Each tier accepts only when exactly one line in the
          // remaining file matches; 2+ matches are ambiguous and
          // fall through so the caller sees the standard error.
          ctxMatch = resolveSoftAnchor(originalLines, anchor, lineIndex);
          if (ctxMatch !== undefined) usedFuzzy = true;
        }
        if (ctxMatch === undefined) {
          throw new PatchContextMatchError({
            kind: 'anchor-not-found',
            filePath,
            searchedFrom: lineIndex,
            expectedLines: [anchor],
            anchor,
            nearbyIdentifiers: findNearestAnchor(originalLines, anchor),
          });
        }
        if (ctxMatch.tier === 'trim' || ctxMatch.tier === 'fuzzy') usedFuzzy = true;
        lineIndex = ctxMatch.startIndex + 1;
      }
    }

    // Phase 2 FindReplace path: mustBeUnique chunks scan the full
    // file region starting at 0 (not cursor-advancing) in the first
    // tier that produces any matches, and require exactly one match.
    if (chunk.mustBeUnique) {
      const result = seekAllInWinningTier(originalLines, chunk.oldLines, 0, {
        allowQuoteStyleTier,
      });

      // Quote-tier ambiguity (2+ matches) is deliberately rejected
      // via the same AmbiguousFindReplaceOnceError as lower tiers —
      // a lenient tier with multiple candidates is exactly when we
      // should refuse, not pick.
      if (!result || result.positions.length === 0) {
        const sampling = originalLines.length > LARGE_FILE_SAMPLING_THRESHOLD;
        throw new PatchContextMatchError({
          kind: 'context-not-found',
          filePath,
          searchedFrom: 0,
          expectedLines: chunk.oldLines,
          nearestMatch: findNearestSequence(originalLines, chunk.oldLines, 0),
          scanTruncated: sampling,
          chunkSource: chunk.source,
          chunkNewLines: chunk.newLines,
        });
      }
      if (result.positions.length > 1) {
        throw new AmbiguousFindReplaceOnceError(
          filePath,
          result.positions.map((p) => p + 1),
          buildAmbiguousMatchPreviews(originalLines, result.positions, chunk.oldLines.length),
        );
      }
      const pos = result.positions[0]!;
      let newLines = chunk.newLines;
      if (result.tier === 'quoteStyle') {
        const fileRegion = originalLines.slice(pos, pos + chunk.oldLines.length);
        const translated = validateQuoteStyleMatch(chunk.oldLines, fileRegion, chunk.newLines);
        if (!translated) {
          // Guardrails refused this match; surface the standard
          // near-miss so the agent sees the actual bytes and can
          // retry with a literal SEARCH.
          const sampling = originalLines.length > LARGE_FILE_SAMPLING_THRESHOLD;
          throw new PatchContextMatchError({
            kind: 'context-not-found',
            filePath,
            searchedFrom: 0,
            expectedLines: chunk.oldLines,
            nearestMatch: findNearestSequence(originalLines, chunk.oldLines, 0),
            scanTruncated: sampling,
            chunkSource: chunk.source,
            chunkNewLines: chunk.newLines,
          });
        }
        newLines = translated.newLines;
        usedQuoteStyle = true;
      } else if (result.tier === 'trim' || result.tier === 'fuzzy') {
        usedFuzzy = true;
      }
      replacements.push([pos, chunk.oldLines.length, [...newLines]]);
      // Do not advance lineIndex — FindReplace chunks match against
      // original state and do not cursor-advance between chunks.
      continue;
    }

    // FindReplaceAll: scan in the first tier with any matches; apply
    // replacements at every position. Zero matches raises the same
    // P0 near-miss as FindReplaceOnce / hunk mismatches.
    //
    // The quote tier is deliberately NOT offered to FindReplaceAll:
    // a lenient tier combined with whole-line mass substitution is
    // the one combination we do not want. Mass-rewrites stay strict.
    if (chunk.replaceAll) {
      const result = seekAllInWinningTier(originalLines, chunk.oldLines, 0);
      if (!result || result.positions.length === 0) {
        const sampling = originalLines.length > LARGE_FILE_SAMPLING_THRESHOLD;
        throw new PatchContextMatchError({
          kind: 'context-not-found',
          filePath,
          searchedFrom: 0,
          expectedLines: chunk.oldLines,
          nearestMatch: findNearestSequence(originalLines, chunk.oldLines, 0),
          scanTruncated: sampling,
          chunkSource: chunk.source,
          chunkNewLines: chunk.newLines,
        });
      }
      if (result.tier === 'trim' || result.tier === 'fuzzy') usedFuzzy = true;
      for (const pos of result.positions) {
        replacements.push([pos, chunk.oldLines.length, [...chunk.newLines]]);
      }
      if (!replaceAllCounts) replaceAllCounts = new Map();
      replaceAllCounts.set(chunkIndex, result.positions.length);
      continue;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIndex = chunk.isEndOfFile ? originalLines.length : lineIndex;
      replacements.push([insertionIndex, 0, [...chunk.newLines]]);
      lineIndex = insertionIndex;
      continue;
    }

    let pattern = chunk.oldLines;
    let newSlice = chunk.newLines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile, {
      allowQuoteStyleTier,
    });
    if (found === undefined && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      if (newSlice[newSlice.length - 1] === '') {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile, {
        allowQuoteStyleTier,
      });
    }
    if (found === undefined) {
      const sampling = originalLines.length > LARGE_FILE_SAMPLING_THRESHOLD;
      throw new PatchContextMatchError({
        kind: 'context-not-found',
        filePath,
        searchedFrom: lineIndex,
        expectedLines: pattern,
        nearestMatch: findNearestSequence(originalLines, pattern, 0),
        scanTruncated: sampling,
        chunkSource: chunk.source,
        chunkNewLines: newSlice,
      });
    }
    if (found.tier === 'quoteStyle') {
      const fileRegion = originalLines.slice(found.startIndex, found.startIndex + pattern.length);
      const translated = validateQuoteStyleMatch(pattern, fileRegion, newSlice);
      if (!translated) {
        const sampling = originalLines.length > LARGE_FILE_SAMPLING_THRESHOLD;
        throw new PatchContextMatchError({
          kind: 'context-not-found',
          filePath,
          searchedFrom: lineIndex,
          expectedLines: pattern,
          nearestMatch: findNearestSequence(originalLines, pattern, 0),
          scanTruncated: sampling,
          chunkSource: chunk.source,
          chunkNewLines: newSlice,
        });
      }
      newSlice = translated.newLines;
      usedQuoteStyle = true;
    } else if (found.tier === 'trim' || found.tier === 'fuzzy' || found.tier === 'rstrip') {
      usedFuzzy = true;
      // Indent-aware replacement. A trim/fuzzy match means the
      // SEARCH lines differed from the file region by leading
      // whitespace only (indent unit, tabs vs spaces). If we insert
      // the REPLACE lines verbatim they keep the PATCH's indent,
      // which is wrong — they should adopt the file's indent so the
      // edit is structurally correct.
      const fileRegion = originalLines.slice(found.startIndex, found.startIndex + pattern.length);
      newSlice = reindentReplaceLines(pattern, fileRegion, newSlice);
    }
    replacements.push([found.startIndex, pattern.length, [...newSlice]]);
    lineIndex = found.startIndex + pattern.length;
  }

  const newLines = applyReplacements(originalLines, replacements);
  if (hadTrailingNewline) {
    if (newLines[newLines.length - 1] !== '') newLines.push('');
  } else if (newLines[newLines.length - 1] === '') {
    newLines.pop();
  }
  return {
    content: newLines.join('\n'),
    usedFuzzy,
    usedQuoteStyle: usedQuoteStyle || undefined,
    replaceAllCounts,
  };
}

function deriveUpdatedContent(
  filePath: string,
  currentContent: string,
  chunks: UpdateChunk[],
  options?: { allowQuoteStyleTier?: boolean },
): DeriveUpdatedResult {
  const { bom, text } = stripBom(currentContent);
  const ending = detectLineEnding(text);
  const normalized = normalizeToLF(text);
  const result = deriveUpdatedNormalizedContent(filePath, normalized, chunks, options);
  return {
    content: bom + restoreLineEndings(result.content, ending),
    usedFuzzy: result.usedFuzzy,
    usedQuoteStyle: result.usedQuoteStyle,
    replaceAllCounts: result.replaceAllCounts,
  };
}

function parseUpdateChunk(
  lines: string[],
  startIndex: number,
  lastContentLine: number,
  allowMissingContext: boolean,
): { chunk: UpdateChunk; nextIndex: number } {
  let i = startIndex;
  const changeContext: string[] = [];
  const first = lines[i].trimEnd();

  // Numbered-hunk header like `@@ -10,7 +10,7 @@` is valid unified-
  // diff syntax but our format uses line content as anchors, not line
  // numbers. Detect it up front so the error points at the actual
  // cause rather than producing a cryptic "Failed to find anchor
  // '-10,7 +10,7 @@'" later when the slice(3) path treats the line
  // numbers as an anchor string.
  if (/^@@\s+-\d+(,\d+)?\s+\+\d+(,\d+)?\s*@@/.test(first)) {
    throw new Error(
      `Unified-diff style hunk header not supported: '${first}'. ` +
        `Use a bare '@@' (optionally followed by a context label like ` +
        `'@@ class Foo') on its own line. Line numbers are ignored; ` +
        `context is matched from the '-'/'+'/' ' lines that follow.`,
    );
  }
  // Bare '***' line inside an Update File block (legacy Codex hunk
  // separator). Our grammar uses the explicit allow-list
  // '*** Update File:', '*** Add File:', '*** Delete File:',
  // '*** FindReplaceOnce:', '*** FindReplaceAll:', '*** End Patch',
  // '*** Move to:', '*** End of File'. Bare '***' is not a valid
  // in-block separator — diagnose it clearly instead of falling
  // through to the generic @@ error.
  if (first === '***') {
    throw new Error(
      `Stray '***' line inside an Update File block. Chunk separators ` +
        `are implicit; place the next '@@', '*** FindReplaceOnce:', or ` +
        `'*** FindReplaceAll:' directly after the previous chunk, or ` +
        `start a new block with '*** Update File:', '*** Add File:', ` +
        `etc. Remove the bare '***' line.`,
    );
  }

  if (first === '@@' || first.startsWith('@@ ')) {
    while (i <= lastContentLine) {
      const header = lines[i].trimEnd();
      if (header === '@@') {
        i++;
        continue;
      }
      if (header.startsWith('@@ ')) {
        changeContext.push(header.slice(3));
        i++;
        continue;
      }
      break;
    }
  } else if (!allowMissingContext) {
    throw new Error(`Expected update hunk to start with @@ context marker, got: '${lines[i]}'`);
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];
  let addedLines = 0;
  let removedLines = 0;
  let modifiedBytes = 0;
  let parsed = 0;
  let isEndOfFile = false;

  while (i <= lastContentLine) {
    const raw = lines[i];
    const trimmed = raw.trimEnd();
    if (trimmed === '*** End of File') {
      if (parsed === 0) throw new Error('Update hunk does not contain any lines');
      isEndOfFile = true;
      i++;
      break;
    }
    if (parsed > 0 && (trimmed.startsWith('@@') || trimmed.startsWith('*** '))) break;
    if (raw.length === 0) {
      oldLines.push('');
      newLines.push('');
      parsed++;
      i++;
      continue;
    }
    const marker = raw[0];
    const body = raw.slice(1);
    if (marker === ' ') {
      oldLines.push(body);
      newLines.push(body);
    } else if (marker === '-') {
      oldLines.push(body);
      removedLines++;
      modifiedBytes += Buffer.byteLength(body, 'utf8');
    } else if (marker === '+') {
      newLines.push(body);
      addedLines++;
      modifiedBytes += Buffer.byteLength(body, 'utf8');
    } else if (parsed === 0) {
      throw new Error(
        `Unexpected line found in update hunk: '${raw}'. Every line should start with ' ', '+', or '-'.`,
      );
    } else {
      break;
    }
    parsed++;
    i++;
  }

  if (parsed === 0) throw new Error('Update hunk does not contain any lines');
  return {
    chunk: {
      source: 'hunk',
      changeContext: changeContext.length > 0 ? changeContext : undefined,
      oldLines,
      newLines,
      isEndOfFile,
      addedLines,
      removedLines,
      modifiedBytes,
    },
    nextIndex: i,
  };
}

function parsePathFromHeader(
  line: string,
  prefix: string,
  mode: 'strict' | 'streaming' = 'strict',
): string {
  const path = line.slice(prefix.length).trim();
  if (!path) {
    if (mode === 'strict') {
      throw new Error(`Patch header '${prefix.trim()}' must include a path`);
    }
    // Streaming: the path hasn't arrived yet. Return empty so the
    // caller can emit a placeholder row; the `formatPath` renderer
    // substitutes a muted ellipsis on the way to the TUI.
    return '';
  }
  return path;
}

// Phase 2: parse a FindReplace block (Once or All variant). Shape:
//
//   *** FindReplaceOnce:    (or *** FindReplaceAll:)
//   <<<<<<< SEARCH
//   ...search content (any text, including bare `=======`)...
//   ======= REPLACE
//   ...replacement content...
//   >>>>>>> REPLACE
//
// `======= REPLACE` (the full 15-char sentinel) terminates SEARCH.
// `>>>>>>> REPLACE` terminates REPLACE. Empty SEARCH is an error;
// empty REPLACE (meaning "delete the matched region(s)") is allowed.
function isFindReplaceChunkTerminated(lines: string[], headerIndex: number): boolean {
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === FIND_REPLACE_END_MARKER) {
      return true;
    }
  }
  return false;
}

function parseFindReplaceChunk(
  lines: string[],
  startIndex: number,
  lastContentLine: number,
  variant: 'once' | 'all',
): { chunk: UpdateChunk; nextIndex: number } {
  const expectedHeader = variant === 'once' ? FIND_REPLACE_ONCE_PREFIX : FIND_REPLACE_ALL_PREFIX;
  let i = startIndex;
  const header = (lines[i] ?? '').trim();
  if (header !== expectedHeader) {
    throw new Error(`Expected ${expectedHeader} header, got: '${lines[i]}'`);
  }
  i++;
  // Skip whitespace lines between header and SEARCH marker.
  while (i <= lastContentLine && (lines[i] ?? '').trim() === '') i++;
  if (i > lastContentLine || (lines[i] ?? '').trim() !== FIND_REPLACE_SEARCH_MARKER) {
    throw new Error(`Expected ${FIND_REPLACE_SEARCH_MARKER} after ${expectedHeader}`);
  }
  i++;

  // Two-pass scan between SEARCH marker and END marker. The strict
  // `======= REPLACE` divider always wins if present, so files that
  // contain literal `=======` lines as content parse the same as
  // before. If the strict divider is absent, fall back to a single
  // bare `=======` as the divider (aider / git-conflict style) and
  // flag the chunk with `lenientDivider` so the tool surface can
  // nudge the agent toward the explicit form. Two or more bare
  // `=======` lines with no strict divider is genuinely ambiguous
  // and fails with a message listing the candidate lines.
  const searchStart = i;
  let strictDividerIdx = -1;
  let compactDividerIdx = -1;
  const bareDividerIdxs: number[] = [];
  let endMarkerIdx = -1;
  for (let j = searchStart; j <= lastContentLine; j++) {
    const trimmed = (lines[j] ?? '').trim();
    if (trimmed === FIND_REPLACE_END_MARKER) {
      endMarkerIdx = j;
      break;
    }
    if (trimmed === FIND_REPLACE_DIVIDER || FIND_REPLACE_DIVIDER_RE.test(trimmed)) {
      if (strictDividerIdx === -1) strictDividerIdx = j;
    } else if (FIND_REPLACE_COMPACT_DIVIDER_RE.test(trimmed)) {
      if (compactDividerIdx === -1) compactDividerIdx = j;
    } else if (trimmed === FIND_REPLACE_BARE_DIVIDER) {
      bareDividerIdxs.push(j);
    }
  }

  if (endMarkerIdx === -1) {
    // Preserve the previous error ordering: if there is no terminator
    // at all, we never got far enough to know whether the divider was
    // present. Report the divider-missing error first only when we
    // actually reached EOF while still inside the SEARCH block with
    // no divider candidates at all; otherwise the terminator is the
    // immediate problem.
    if (strictDividerIdx === -1 && compactDividerIdx === -1 && bareDividerIdxs.length === 0) {
      throw new Error(`${expectedHeader} missing '${FIND_REPLACE_DIVIDER}' divider`);
    }
    throw new Error(`${expectedHeader} missing '${FIND_REPLACE_END_MARKER}' terminator`);
  }

  let dividerIdx: number;
  let dividerStyle: UpdateChunk['dividerStyle'] | undefined;
  if (strictDividerIdx !== -1) {
    dividerIdx = strictDividerIdx;
  } else if (compactDividerIdx !== -1) {
    dividerIdx = compactDividerIdx;
    dividerStyle = 'compact';
  } else if (bareDividerIdxs.length === 1) {
    dividerIdx = bareDividerIdxs[0]!;
    dividerStyle = 'bare';
  } else if (bareDividerIdxs.length > 1) {
    const humanLines = bareDividerIdxs.map((n) => n + 1).join(', ');
    throw new Error(
      `${expectedHeader} missing '${FIND_REPLACE_DIVIDER}' divider; found ${bareDividerIdxs.length} ambiguous bare '=======' lines at input lines ${humanLines}. Use '${FIND_REPLACE_DIVIDER}' to disambiguate, or shrink the SEARCH block so only one bare '=======' appears.`,
    );
  } else {
    throw new Error(`${expectedHeader} missing '${FIND_REPLACE_DIVIDER}' divider`);
  }

  const searchLines = lines.slice(searchStart, dividerIdx);
  const replaceLines = lines.slice(dividerIdx + 1, endMarkerIdx);
  i = endMarkerIdx + 1;

  if (searchLines.length === 0) {
    throw new Error(`${expectedHeader} SEARCH block must not be empty`);
  }

  const source: UpdateChunk['source'] =
    variant === 'once' ? 'find-replace-once' : 'find-replace-all';
  const mustBeUnique = variant === 'once';
  const replaceAll = variant === 'all';

  let modifiedBytes = 0;
  for (const line of searchLines) modifiedBytes += Buffer.byteLength(line, 'utf8');
  for (const line of replaceLines) modifiedBytes += Buffer.byteLength(line, 'utf8');

  return {
    chunk: {
      source,
      oldLines: searchLines,
      newLines: replaceLines,
      isEndOfFile: false,
      addedLines: replaceLines.length,
      removedLines: searchLines.length,
      modifiedBytes,
      mustBeUnique,
      replaceAll,
      ...(dividerStyle ? { lenientDivider: true, dividerStyle } : {}),
    },
    nextIndex: i,
  };
}

function countTextLines(text: string): number {
  const normalized = normalizeToLF(text);
  if (normalized.length === 0) {
    return 0;
  }
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return trimmed.split('\n').length;
}

function isLikelyBinaryBuffer(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return true;
  }

  // Valid UTF-8 text is not binary. The byte-level heuristic below would
  // otherwise flag continuation bytes (0x80-0xBF) in multi-byte characters
  // such as em-dashes, arrows, and box-drawing glyphs as "suspicious".
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return false;
  } catch {
    // Not valid UTF-8; fall through to byte-level heuristic for legacy
    // encodings or genuinely binary data.
  }

  let suspicious = 0;
  for (const byte of buffer) {
    if (byte === 9 || byte === 10 || byte === 13) {
      continue;
    }
    if (byte < 32 || (byte >= 127 && byte <= 159)) {
      suspicious++;
    }
  }

  return suspicious > 0 && suspicious / Math.max(1, buffer.length) > 0.1;
}

function isRecognizedStreamingTrailingLine(line: string): boolean {
  if (!line) return false;
  if (line === BEGIN_PATCH_LINE || line === END_PATCH_LINE || line === '@@') return true;
  if (line.startsWith('@@ ')) return true;
  // Accept op-header fragments the moment the colon arrives, even
  // without a path yet. The streaming parser surfaces an in-progress
  // row immediately so the TUI doesn't sit on a blank "apply_patch"
  // label while the model types the first path character.
  if (
    line.startsWith(ADD_FILE_PREFIX) ||
    line.startsWith(DELETE_FILE_PREFIX) ||
    line.startsWith(UPDATE_FILE_PREFIX) ||
    line.startsWith(MOVE_TO_PREFIX)
  ) {
    return true;
  }
  return false;
}

function preparePatchLines(patchText: string, mode: 'strict' | 'streaming'): PreparedPatchLines {
  const normalized = normalizeToLF(patchText);
  const rawLines = normalized.split('\n');
  if (normalized.endsWith('\n') && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }
  const trailingFragment = normalized.endsWith('\n') ? '' : (rawLines.pop() ?? '');
  const lines = [...rawLines];

  if (mode === 'strict') {
    if (trailingFragment.length > 0) {
      lines.push(trailingFragment);
    }
  } else if (isRecognizedStreamingTrailingLine(trailingFragment)) {
    lines.push(trailingFragment);
  }

  // Recover concatenated envelopes. Some models emit multiple
  // `*** Begin Patch` ... `*** End Patch` envelopes back-to-back (or
  // a single Begin plus several stray Ends between ops). Left alone,
  // the parser would stop at the first `*** End Patch` and silently
  // drop every operation after it. Strip the stray markers so the
  // parser sees one flat sequence of operations, and count how many
  // we merged so the summary can nudge the agent.
  const mergedEnvelopes = mergeConcatenatedEnvelopes(lines);

  // Envelope auto-wrap. Some models emit a bare operation header
  // (`*** Add File:`, `*** Update File:`, `*** Delete File:`) at the
  // top of the payload without wrapping it in
  // `*** Begin Patch` ... `*** End Patch`. When we're confident the
  // payload is patch-shaped (first non-blank line is an operation
  // header AND there's no `*** Begin Patch` anywhere), synthesize
  // the envelope so the rest of the parser works unchanged.
  const autoWrappedEnvelope = maybeAutoWrapEnvelope(lines);

  const patchComplete = lines[lines.length - 1]?.trim() === END_PATCH_LINE;
  return { lines, patchComplete, mergedEnvelopes, autoWrappedEnvelope };
}

/**
 * Mutates `lines` in place to add `*** Begin Patch` and `*** End Patch`
 * when the payload starts with a bare operation header and no envelope
 * is present. Returns true when a wrap was synthesized.
 */
function maybeAutoWrapEnvelope(lines: string[]): boolean {
  // Fast exit: payload already starts with `*** Begin Patch`, or is empty.
  const firstContentIdx = nextNonBlankIndex(lines, 0);
  if (firstContentIdx >= lines.length) return false;
  const firstContent = (lines[firstContentIdx] ?? '').trim();
  if (firstContent === BEGIN_PATCH_LINE) return false;
  // Only auto-wrap when the first content line is a recognized
  // top-level operation header. Anything else is genuinely malformed
  // (prose, markdown, random text) and should fail loudly.
  if (
    !firstContent.startsWith(ADD_FILE_PREFIX) &&
    !firstContent.startsWith(DELETE_FILE_PREFIX) &&
    !firstContent.startsWith(UPDATE_FILE_PREFIX)
  ) {
    return false;
  }
  // And only when the payload contains no `*** Begin Patch` anywhere —
  // otherwise we'd be hiding a structural problem (stray text before
  // a real envelope) behind an auto-wrap.
  if (lines.some((line) => line.trim() === BEGIN_PATCH_LINE)) return false;

  lines.unshift(BEGIN_PATCH_LINE);
  // Append end marker only when the tail isn't already `*** End Patch`.
  const lastContentIdx = lastNonBlankIndex(lines);
  if (lastContentIdx < 0 || lines[lastContentIdx]?.trim() !== END_PATCH_LINE) {
    lines.push(END_PATCH_LINE);
  }
  return true;
}

function lastNonBlankIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? '').trim() !== '') return i;
  }
  return -1;
}

function isOperationHeaderLine(line: string | undefined): boolean {
  if (!line) return false;
  const trimmed = line.trim();
  return (
    trimmed.startsWith(ADD_FILE_PREFIX) ||
    trimmed.startsWith(DELETE_FILE_PREFIX) ||
    trimmed.startsWith(UPDATE_FILE_PREFIX)
  );
}

function nextNonBlankIndex(lines: string[], fromIndex: number): number {
  let i = fromIndex;
  while (i < lines.length && (lines[i] ?? '').trim().length === 0) {
    i++;
  }
  return i;
}

/**
 * Mutates `lines` in place, removing stray `*** End Patch` (and any
 * immediately following `*** Begin Patch`) when they separate two
 * operations. The final `*** End Patch` at the tail of the payload is
 * always preserved. Returns the count of stray End Patch markers that
 * were removed.
 */
function mergeConcatenatedEnvelopes(lines: string[]): number {
  let mergedEnvelopes = 0;
  let i = 0;
  while (i < lines.length) {
    if ((lines[i] ?? '').trim() !== END_PATCH_LINE) {
      i++;
      continue;
    }

    // Peek past trailing blank lines. If there's another operation
    // (or another `*** Begin Patch` re-opener) ahead, the End Patch
    // is stray — strip it. Otherwise it's the genuine terminator.
    let peek = nextNonBlankIndex(lines, i + 1);
    const sawBeginPatch = peek < lines.length && (lines[peek] ?? '').trim() === BEGIN_PATCH_LINE;
    if (sawBeginPatch) {
      peek = nextNonBlankIndex(lines, peek + 1);
    }

    if (peek >= lines.length || !isOperationHeaderLine(lines[peek])) {
      // Genuine terminator (or trailing noise we shouldn't touch).
      i++;
      continue;
    }

    // Remove the stray End Patch (plus a trailing Begin Patch and
    // any blank lines in between) so the parser sees one flat stream.
    const removeUpTo = sawBeginPatch ? peek : peek; // `peek` already points at the next op header
    lines.splice(i, removeUpTo - i);
    mergedEnvelopes++;
    // Don't advance `i`; re-evaluate the current position in case
    // another stray End Patch follows immediately.
  }
  return mergedEnvelopes;
}

function parsePatchOperationsFromLines(
  lines: string[],
  mode: 'strict' | 'streaming',
  patchComplete: boolean,
  startIndex = 1,
): StreamingPatchOperation[] {
  if (lines.length < 1) {
    if (mode === 'strict') throw new Error('Patch is empty or invalid');
    return [];
  }
  if (startIndex === 1 && lines[0]?.trim() !== BEGIN_PATCH_LINE) {
    if (mode === 'strict') {
      throw new Error("The first line of the patch must be '*** Begin Patch'");
    }
    return [];
  }
  if (startIndex === 1 && mode === 'strict' && !patchComplete) {
    throw new Error(describeIncompleteStrictPatch(lines));
  }

  const operations: StreamingPatchOperation[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const trimmed = lines[i]?.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    if (trimmed === END_PATCH_LINE) {
      break;
    }

    if (trimmed.startsWith(ADD_FILE_PREFIX)) {
      const path = parsePathFromHeader(trimmed, ADD_FILE_PREFIX, mode);
      i++;
      const contentLines: string[] = [];
      let terminated = false;
      while (i < lines.length) {
        const next = lines[i] ?? '';
        const nextTrimmed = next.trim();
        if (nextTrimmed === END_PATCH_LINE || nextTrimmed.startsWith('*** ')) {
          terminated = true;
          break;
        }
        if (!next.startsWith('+')) {
          if (mode === 'strict') {
            throw new Error(`Invalid add-file line '${next}'. Add file lines must start with '+'`);
          }
          break;
        }
        contentLines.push(next.slice(1));
        i++;
      }
      operations.push({
        kind: 'add',
        path,
        contents: contentLines.length > 0 ? `${contentLines.join('\n')}\n` : '',
        state: terminated || patchComplete ? 'streamed' : 'streaming',
      });
      continue;
    }

    if (trimmed.startsWith(DELETE_FILE_PREFIX)) {
      const path = parsePathFromHeader(trimmed, DELETE_FILE_PREFIX, mode);
      // Delete has no body, so its "terminator" is simply whether
      // anything else (a blank line, the next op, an End Patch) has
      // landed after it. If this is the last line of a streaming
      // chunk and the patch isn't complete, the path could still be
      // growing — keep it in 'streaming' so the TUI icon matches.
      const isTrailingFragment = mode === 'streaming' && i === lines.length - 1 && !patchComplete;
      operations.push({
        kind: 'delete',
        path,
        state: isTrailingFragment ? 'streaming' : 'streamed',
      });
      i++;
      continue;
    }

    if (trimmed.startsWith(UPDATE_FILE_PREFIX)) {
      const path = parsePathFromHeader(trimmed, UPDATE_FILE_PREFIX, mode);
      i++;
      let moveTo: string | undefined;
      if (i < lines.length && lines[i]?.trim().startsWith(MOVE_TO_PREFIX)) {
        moveTo = parsePathFromHeader(lines[i]!.trim(), MOVE_TO_PREFIX, mode);
        i++;
      }
      const chunks: UpdateChunk[] = [];
      let terminated = false;
      while (i < lines.length) {
        const next = lines[i] ?? '';
        const nextTrimmed = next.trim();
        if (!nextTrimmed) {
          i++;
          continue;
        }
        if (
          nextTrimmed === END_PATCH_LINE ||
          nextTrimmed.startsWith(ADD_FILE_PREFIX) ||
          nextTrimmed.startsWith(DELETE_FILE_PREFIX) ||
          nextTrimmed.startsWith(UPDATE_FILE_PREFIX) ||
          nextTrimmed.startsWith(MOVE_TO_PREFIX)
        ) {
          terminated = true;
          break;
        }
        // FindReplace sub-blocks continue inside the current update
        // file; they do not start a new top-level operation.
        if (nextTrimmed === FIND_REPLACE_ONCE_PREFIX || nextTrimmed === FIND_REPLACE_ALL_PREFIX) {
          // While streaming, a FindReplace chunk whose terminator
          // (`>>>>>>> REPLACE`) hasn't arrived yet is still in flight.
          // Break out so the enclosing Update operation stays visible
          // in 'streaming' state — mirroring the @@-anchor fallthrough
          // below — instead of letting parseFindReplaceChunk throw on
          // the missing SEARCH/DIVIDER/END markers at the tail.
          if (mode === 'streaming' && !isFindReplaceChunkTerminated(lines, i)) {
            break;
          }
          const variant = nextTrimmed === FIND_REPLACE_ONCE_PREFIX ? 'once' : 'all';
          let parsed: { chunk: UpdateChunk; nextIndex: number };
          try {
            parsed = parseFindReplaceChunk(lines, i, lines.length - 1, variant);
          } catch (error) {
            if (mode === 'strict' && error instanceof Error) {
              throw rewriteFindReplaceParseError(path, variant, error);
            }
            throw error;
          }
          chunks.push(parsed.chunk);
          i = parsed.nextIndex;
          continue;
        }
        if (nextTrimmed.startsWith('*** ')) {
          // Unknown *** prefix inside an update block. Treat as
          // terminator for forward compatibility with future headers.
          terminated = true;
          break;
        }
        if (
          mode === 'streaming' &&
          chunks.length === 0 &&
          (nextTrimmed === '@@' || nextTrimmed.startsWith('@@ ')) &&
          lines.slice(i).every((line) => {
            const trimmed = line.trim();
            return !trimmed || trimmed === '@@' || trimmed.startsWith('@@ ');
          })
        ) {
          break;
        }
        const parsed = parseUpdateChunk(lines, i, lines.length - 1, chunks.length === 0);
        chunks.push(parsed.chunk);
        i = parsed.nextIndex;
      }
      if (mode === 'strict' && chunks.length === 0 && !moveTo) {
        throw new Error(`Update file hunk for path '${path}' is empty`);
      }
      operations.push({
        kind: 'update',
        path,
        moveTo,
        chunks,
        state: terminated || patchComplete ? 'streamed' : 'streaming',
      });
      continue;
    }

    if (mode === 'strict') {
      throw new Error(
        `'${trimmed}' is not a valid hunk header. Valid headers: '*** Add File:', '*** Delete File:', '*** Update File:'`,
      );
    }
    break;
  }

  return operations;
}

function describeIncompleteStrictPatch(lines: string[]): string {
  let currentAddFile: string | undefined;
  let currentUpdateFile: string | undefined;
  let currentFindReplace: 'FindReplaceOnce' | 'FindReplaceAll' | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(ADD_FILE_PREFIX)) {
      currentAddFile = parsePathFromHeader(trimmed, ADD_FILE_PREFIX, 'streaming');
      currentUpdateFile = undefined;
      currentFindReplace = undefined;
      continue;
    }
    if (trimmed.startsWith(UPDATE_FILE_PREFIX)) {
      currentUpdateFile = parsePathFromHeader(trimmed, UPDATE_FILE_PREFIX, 'streaming');
      currentAddFile = undefined;
      currentFindReplace = undefined;
      continue;
    }
    if (trimmed.startsWith(DELETE_FILE_PREFIX)) {
      currentAddFile = undefined;
      currentUpdateFile = undefined;
      currentFindReplace = undefined;
      continue;
    }
    if (trimmed === FIND_REPLACE_ONCE_PREFIX) {
      currentFindReplace = 'FindReplaceOnce';
      continue;
    }
    if (trimmed === FIND_REPLACE_ALL_PREFIX) {
      currentFindReplace = 'FindReplaceAll';
      continue;
    }
    if (trimmed === FIND_REPLACE_END_MARKER) {
      currentFindReplace = undefined;
    }
  }

  if (currentFindReplace && currentUpdateFile) {
    return `${currentFindReplace} chunk in ${currentUpdateFile} appears truncated: missing '${FIND_REPLACE_END_MARKER}' terminator and final '${END_PATCH_LINE}'. Finish the block, or split large edits into smaller apply_patch calls.`;
  }
  if (currentAddFile) {
    return `Patch appears truncated while adding file '${currentAddFile}': missing '${END_PATCH_LINE}'. For large generated files, split large file creation into smaller chunks or create a shorter skeleton first.`;
  }
  return `The last line of the patch must be '${END_PATCH_LINE}'`;
}

function rewriteFindReplaceParseError(path: string, variant: 'once' | 'all', error: Error): Error {
  const label = variant === 'once' ? 'FindReplaceOnce' : 'FindReplaceAll';
  if (error.message.includes(`missing '${FIND_REPLACE_END_MARKER}' terminator`)) {
    return new Error(
      `${label} chunk in ${path} is missing '${FIND_REPLACE_END_MARKER}' terminator. Finish the REPLACE block before '${END_PATCH_LINE}', or split the edit into a smaller apply_patch call.`,
    );
  }
  if (error.message.includes('ambiguous bare')) {
    return error;
  }
  if (error.message.includes(`missing '${FIND_REPLACE_DIVIDER}' divider`)) {
    return new Error(
      `${label} chunk in ${path} is missing '${FIND_REPLACE_DIVIDER}' divider. Use the canonical SEARCH/REPLACE shape: '${FIND_REPLACE_SEARCH_MARKER}', '${FIND_REPLACE_DIVIDER}', '${FIND_REPLACE_END_MARKER}'.`,
    );
  }
  return error;
}

function summarizeUpdateChunks(chunks: UpdateChunk[]): {
  addedLines: number;
  removedLines: number;
  modifiedBytes: number;
} {
  return chunks.reduce(
    (summary, chunk) => {
      return {
        addedLines: summary.addedLines + chunk.addedLines,
        removedLines: summary.removedLines + chunk.removedLines,
        modifiedBytes: summary.modifiedBytes + chunk.modifiedBytes,
      };
    },
    { addedLines: 0, removedLines: 0, modifiedBytes: 0 },
  );
}

function toPatchPreviewRows(
  operations: PatchOperation[],
  state: PatchOperationState,
): PatchPreviewRow[] {
  return operations.map((operation) => {
    if (operation.kind === 'add') {
      const normalizedContents = normalizeToLF(operation.contents);
      const addedLines =
        normalizedContents.length === 0
          ? 0
          : normalizedContents.split('\n').filter((line, index, lines) => {
              return !(index === lines.length - 1 && line === '');
            }).length;
      return {
        kind: 'create',
        path: operation.path,
        addedLines,
        removedLines: 0,
        modifiedBytes: Buffer.byteLength(operation.contents, 'utf8'),
        renameOnly: false,
        state,
      } satisfies PatchPreviewRow;
    }

    if (operation.kind === 'delete') {
      return {
        kind: 'delete',
        path: operation.path,
        state,
      } satisfies PatchPreviewRow;
    }

    const summary = summarizeUpdateChunks(operation.chunks);
    if (operation.moveTo) {
      return {
        kind: 'move',
        path: operation.path,
        targetPath: operation.moveTo,
        ...summary,
        renameOnly: operation.chunks.length === 0 && state !== 'streaming',
        state,
      } satisfies PatchPreviewRow;
    }

    return {
      kind: 'edit',
      path: operation.path,
      ...summary,
      renameOnly: false,
      state,
    } satisfies PatchPreviewRow;
  });
}

export function parsePatch(patchText: string): PatchOperation[] {
  return parsePatchWithDiagnostics(patchText).ops;
}

interface PatchParseDiagnostics {
  ops: PatchOperation[];
  /**
   * Count of stray `*** End Patch` markers merged away by
   * `preparePatchLines`. Non-zero when the model emitted multiple
   * concatenated envelopes instead of one. Callers should surface
   * this as an advisory so the agent learns to emit a single
   * envelope per call.
   */
  mergedEnvelopes: number;
  /**
   * True when the payload was missing the `*** Begin Patch` /
   * `*** End Patch` envelope but started with a bare operation
   * header. Callers should surface this as an advisory so the
   * agent learns to always include the full envelope.
   */
  autoWrappedEnvelope: boolean;
}

export function parsePatchWithDiagnostics(patchText: string): PatchParseDiagnostics {
  const prepared = preparePatchLines(patchText, 'strict');
  const operations = parsePatchOperationsFromLines(
    prepared.lines,
    'strict',
    prepared.patchComplete,
  );
  const ops = operations.map(({ state: _state, ...operation }) => operation);
  applyChunkAutoFixes(ops);
  return {
    autoWrappedEnvelope: prepared.autoWrappedEnvelope,
    ops,
    mergedEnvelopes: prepared.mergedEnvelopes,
  };
}

// -------------------------------------------------------------------
// Chunk auto-fix layer
//
// Applies conservative, high-confidence post-parse transformations to
// FindReplace chunks. Today: one fix, "prefix-leak" — strip leaked
// unified-diff `+` prefixes from REPLACE regions when SEARCH has no
// corresponding plus-prefixed content. It handles full leaks, trailing
// partial leaks, indented source-code leaks, and short source-code
// declaration/statement leaks while keeping sentinel and threshold
// guards for docs/templates and ambiguous prose.
//
// Hunks are never touched: the parser already strips `+`/`-`/` `
// sigils from hunk context/change lines before populating oldLines
// and newLines, so a `+` at column 0 there is either impossible or
// legitimate content (extremely rare).
// -------------------------------------------------------------------

// Sentinel tokens whose presence in the (hypothetically stripped)
// REPLACE lines strongly suggests the target is a patch-doc/prompt/
// template file — in which case auto-stripping would corrupt the
// agent's intent. Match on whole-line content; a substring hit in a
// prose sentence shouldn't disqualify the fix.
const PATCH_SYNTAX_SENTINELS = [
  /^\*\*\* Update File:\s*\S/,
  /^\*\*\* Add File:\s*\S/,
  /^\*\*\* Delete File:\s*\S/,
  /^\*\*\* Begin Patch$/,
  /^\*\*\* End Patch$/,
  /^\*\*\* FindReplaceOnce:$/,
  /^\*\*\* FindReplaceAll:$/,
  /^<<<<<<< SEARCH$/,
  /^======= REPLACE$/,
  /^>>>>>>> REPLACE$/,
];

// Any line whose first non-indentation character is "+" and has at
// least one more character. Earlier revisions required column 0, which
// missed real leaks in indented Go/TS code like `\t+value, err := ...`.
// False positives are handled by the asymmetry, sentinel, source-code,
// and threshold guards downstream — not by an opinionated character
// class.
const PREFIX_LEAK_LINE_RE = /^(\s*)\+[^\n]/;
const PREFIX_LEAK_MIN_LINES = 3;

function applyChunkAutoFixes(ops: PatchOperation[]): void {
  for (const op of ops) {
    if (op.kind !== 'update') continue;
    for (const chunk of op.chunks) {
      maybeApplyPrefixLeakFix(op.path, chunk);
    }
  }
}

// Optional indentation + "+" followed by any printable char — i.e. a
// line that is "<indent>+<content>". These are meaningful leaked lines;
// the minimum-count threshold runs against these.
function isMeaningfulPlusLine(l: string): boolean {
  return PREFIX_LEAK_LINE_RE.test(l);
}

// Bare "+" alone on a line, with optional indentation. In a leaked
// unified-diff REPLACE block this represents a blank line in the new
// version; after stripping the "+" it becomes a genuine blank line
// preserving any indentation the model emitted.
function isBarePlusLine(l: string): boolean {
  return /^\s*\+$/.test(l);
}

function isAnyPlusLine(l: string): boolean {
  return isMeaningfulPlusLine(l) || isBarePlusLine(l);
}

function maybeApplyPrefixLeakFix(path: string, chunk: UpdateChunk): void {
  // Only FindReplace chunks: hunks use `+`/`-` sigils legitimately
  // and the parser has already stripped them before reaching us.
  if (chunk.source !== 'find-replace-once' && chunk.source !== 'find-replace-all') return;

  // Asymmetry requirement: if SEARCH already has "+"-prefixed lines
  // the agent is probably intentionally working with "+"-prefixed
  // content (config files, etc.), not leaking diff syntax.
  const oldPlusLines = chunk.oldLines.filter(isAnyPlusLine).length;
  if (oldPlusLines > 0) return;

  const lines = chunk.newLines;
  const sourceFile = isSourceCodePath(path);
  const stripped = [...lines];
  let changed = false;

  for (const region of findPrefixLeakRegions(lines)) {
    if (!shouldStripPrefixLeakRegion(region, sourceFile)) continue;
    for (let i = region.start; i < region.end; i++) {
      stripped[i] = stripLeadingPlus(stripped[i] ?? '');
    }
    changed = true;
  }
  if (!changed) return;

  // Don't autofix when the stripped REPLACE would contain a line
  // that matches one of the patch-syntax sentinels — strong signal
  // the target is a patch-doc/prompt/template file.
  if (stripped.some((line) => PATCH_SYNTAX_SENTINELS.some((re) => re.test(line)))) return;

  chunk.newLines = stripped;
  chunk.autoFixed = [...(chunk.autoFixed ?? []), 'prefix-leak'];
}

interface PrefixLeakRegion {
  start: number;
  end: number;
  lines: string[];
}

function findPrefixLeakRegions(lines: string[]): PrefixLeakRegion[] {
  const regions: PrefixLeakRegion[] = [];
  let start: number | undefined;
  for (let i = 0; i <= lines.length; i++) {
    const line = lines[i];
    const inRegion = line !== undefined && (isAnyPlusLine(line) || line.trim().length === 0);
    if (inRegion && start === undefined) {
      start = i;
    }
    if ((!inRegion || i === lines.length) && start !== undefined) {
      const end = i;
      const regionLines = lines.slice(start, end);
      if (regionLines.some(isAnyPlusLine)) {
        regions.push({ start, end, lines: regionLines });
      }
      start = undefined;
    }
  }
  return regions;
}

function shouldStripPrefixLeakRegion(region: PrefixLeakRegion, sourceFile: boolean): boolean {
  const meaningful = region.lines.filter(isMeaningfulPlusLine);
  if (meaningful.length >= PREFIX_LEAK_MIN_LINES) return true;
  return sourceFile && meaningful.some(isHighConfidenceSourceLeakLine);
}

function isSourceCodePath(path: string): boolean {
  return /\.(?:c|cc|cpp|cs|go|java|js|jsx|kt|m|mm|php|py|rb|rs|swift|ts|tsx)$/i.test(path);
}

function isHighConfidenceSourceLeakLine(line: string): boolean {
  const stripped = stripLeadingPlus(line).trimStart();
  return /^(?:func\b|function\b|class\b|interface\b|type\b|struct\b|enum\b|var\b|let\b|const\b|return\b|if\b|for\b|switch\b|case\b|defer\b|go\b|require\.|assert\.|expect\(|[A-Za-z_]\w*(?:\s*,[^=]*)?\s*:=)/.test(
    stripped,
  );
}

function stripLeadingPlus(line: string): string {
  return line.replace(/^(\s*)\+/, '$1');
}

function operationIdentityKey(operation: PatchOperation): string {
  if (operation.kind === 'add') {
    return `add:${operation.path}`;
  }
  if (operation.kind === 'delete') {
    return `delete:${operation.path}`;
  }
  return `update:${operation.path}:${operation.moveTo ?? ''}`;
}

function assignStableOperationIds(operations: PatchOperation[]): string[] {
  const seen = new Map<string, number>();
  return operations.map((operation) => {
    const identity = operationIdentityKey(operation);
    const ordinal = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, ordinal);
    return `${identity}#${ordinal}`;
  });
}

interface StreamingPatchParseResult {
  operations: PatchPreviewRow[];
  sealedOperations: PatchOperation[];
  patchComplete: boolean;
  trailingOpenOperation?: PatchPreviewRow;
}

interface StreamingPatchParser {
  update(patchText: string): StreamingPatchParseResult;
}

function buildStreamingPatchParseResult(
  operations: StreamingPatchOperation[],
  patchComplete: boolean,
): StreamingPatchParseResult {
  const bareOps = operations.map(({ state: _state, ...operation }) => operation);
  const ids = assignStableOperationIds(bareOps);
  const previewRows = operations.map(({ state, ...operation }, index) => ({
    ...toPatchPreviewRows([operation], state)[0]!,
    id: ids[index],
  }));

  const trailingOpenOperation =
    operations.length > 0 && operations[operations.length - 1]?.state === 'streaming'
      ? previewRows[previewRows.length - 1]
      : undefined;

  const sealedOperations = operations
    .filter((operation) => operation.state === 'streamed')
    .map(({ state: _state, ...operation }) => operation);

  return {
    operations: previewRows,
    sealedOperations,
    patchComplete,
    trailingOpenOperation,
  };
}

function findLastOperationStartLine(lines: string[]): number | undefined {
  for (let index = lines.length - 1; index >= 1; index--) {
    const trimmed = lines[index]?.trim() ?? '';
    if (
      trimmed.startsWith(ADD_FILE_PREFIX) ||
      trimmed.startsWith(DELETE_FILE_PREFIX) ||
      trimmed.startsWith(UPDATE_FILE_PREFIX)
    ) {
      return index;
    }
  }
  return undefined;
}

export function parsePatchStreaming(patchText: string): StreamingPatchParseResult {
  const prepared = preparePatchLines(patchText, 'streaming');
  const operations = parsePatchOperationsFromLines(
    prepared.lines,
    'streaming',
    prepared.patchComplete,
  );
  return buildStreamingPatchParseResult(operations, prepared.patchComplete);
}

export function createStreamingPatchParser(): StreamingPatchParser {
  let previousText = '';
  let previousOperations: StreamingPatchOperation[] = [];
  let previousTrailingStartLine: number | undefined;

  return {
    update(patchText: string): StreamingPatchParseResult {
      const prepared = preparePatchLines(patchText, 'streaming');

      if (
        previousText.length > 0 &&
        patchText.startsWith(previousText) &&
        previousOperations.length > 0 &&
        previousOperations[previousOperations.length - 1]?.state === 'streaming' &&
        previousTrailingStartLine !== undefined
      ) {
        const trailingStartLine = previousTrailingStartLine;
        if (trailingStartLine !== undefined) {
          const prefix = previousOperations.slice(0, -1);
          const reparsedTail = parsePatchOperationsFromLines(
            prepared.lines,
            'streaming',
            prepared.patchComplete,
            trailingStartLine,
          );
          previousText = patchText;
          previousOperations = [...prefix, ...reparsedTail];
          previousTrailingStartLine =
            previousOperations[previousOperations.length - 1]?.state === 'streaming'
              ? findLastOperationStartLine(prepared.lines)
              : undefined;
          return buildStreamingPatchParseResult(previousOperations, prepared.patchComplete);
        }
      }

      previousText = patchText;
      previousOperations = parsePatchOperationsFromLines(
        prepared.lines,
        'streaming',
        prepared.patchComplete,
      );
      previousTrailingStartLine =
        previousOperations[previousOperations.length - 1]?.state === 'streaming'
          ? findLastOperationStartLine(prepared.lines)
          : undefined;
      return buildStreamingPatchParseResult(previousOperations, prepared.patchComplete);
    },
  };
}

export function createRealWorkspace(): Workspace {
  return createWorkspaceFromFs();
}

export function createVirtualWorkspace(
  cwd: string,
  initialState?: Record<string, string | null>,
): OverlayWorkspace {
  return createFilesystemBackedOverlayWorkspace(cwd, initialState);
}

function appendContributingRows(existing: PatchRowRef[], additions: PatchRowRef[]) {
  const seen = new Set(existing.map((ref) => `${ref.rowIndex}:${ref.id}`));
  for (const ref of additions) {
    const key = `${ref.rowIndex}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    existing.push(ref);
  }
}

function mergePlannedMutation(
  mutationsByKey: Map<string, PlannedFileMutation>,
  incoming: PlannedFileMutation,
  rowRef: PatchRowRef,
) {
  if (incoming.kind === 'write') {
    const existingWrite = mutationsByKey.get(incoming.absolutePath);
    if (existingWrite?.kind === 'write') {
      existingWrite.afterText = incoming.afterText;
      appendContributingRows(existingWrite.contributingRows, [rowRef]);
      return;
    }

    const existingMove = [...mutationsByKey.values()].find(
      (mutation) => mutation.kind === 'move' && mutation.targetPath === incoming.absolutePath,
    );
    if (existingMove?.kind === 'move') {
      existingMove.afterText = incoming.afterText;
      appendContributingRows(existingMove.contributingRows, [rowRef]);
      return;
    }

    if (existingWrite?.kind === 'delete') {
      const rewritten: PlannedFileMutation = {
        kind: 'write',
        absolutePath: incoming.absolutePath,
        displayPath: incoming.displayPath,
        before: existingWrite.before,
        afterText: incoming.afterText,
        contributingRows: [...existingWrite.contributingRows],
      };
      appendContributingRows(rewritten.contributingRows, [rowRef]);
      mutationsByKey.set(incoming.absolutePath, rewritten);
      return;
    }

    mutationsByKey.set(incoming.absolutePath, {
      ...incoming,
      contributingRows: [rowRef],
    });
    return;
  }

  if (incoming.kind === 'delete') {
    const existing = mutationsByKey.get(incoming.absolutePath);
    if (existing?.kind === 'write') {
      if (!existing.before.version.exists) {
        mutationsByKey.delete(incoming.absolutePath);
        return;
      }

      mutationsByKey.set(incoming.absolutePath, {
        kind: 'delete',
        absolutePath: incoming.absolutePath,
        displayPath: incoming.displayPath,
        before: existing.before,
        contributingRows: [...existing.contributingRows, rowRef],
      });
      return;
    }
    if (existing?.kind === 'delete') {
      appendContributingRows(existing.contributingRows, [rowRef]);
      return;
    }

    const moveTarget = [...mutationsByKey.values()].find(
      (mutation) => mutation.kind === 'move' && mutation.targetPath === incoming.absolutePath,
    );
    if (moveTarget?.kind === 'move') {
      mutationsByKey.delete(moveTarget.targetPath);
      mutationsByKey.set(moveTarget.sourcePath, {
        kind: 'delete',
        absolutePath: moveTarget.sourcePath,
        displayPath: moveTarget.displayPath,
        before: moveTarget.source,
        contributingRows: [...moveTarget.contributingRows, rowRef],
      });
      return;
    }

    mutationsByKey.set(incoming.absolutePath, {
      ...incoming,
      contributingRows: [rowRef],
    });
    return;
  }

  const chainedMove = [...mutationsByKey.values()].find(
    (mutation) => mutation.kind === 'move' && mutation.targetPath === incoming.sourcePath,
  );
  if (chainedMove?.kind === 'move') {
    mutationsByKey.delete(chainedMove.targetPath);
    chainedMove.targetPath = incoming.targetPath;
    chainedMove.absolutePath = incoming.targetPath;
    chainedMove.displayPath = incoming.displayPath;
    chainedMove.target = incoming.target;
    chainedMove.afterText = incoming.afterText;
    appendContributingRows(chainedMove.contributingRows, [rowRef]);
    mutationsByKey.set(chainedMove.targetPath, chainedMove);
    return;
  }

  const existingSource = mutationsByKey.get(incoming.sourcePath);
  if (existingSource?.kind === 'write') {
    mutationsByKey.delete(existingSource.absolutePath);

    if (!existingSource.before.version.exists) {
      const rewritten: PlannedFileMutation = {
        kind: 'write',
        absolutePath: incoming.targetPath,
        displayPath: incoming.displayPath,
        before: incoming.target,
        afterText: incoming.afterText,
        contributingRows: [...existingSource.contributingRows],
      };
      appendContributingRows(rewritten.contributingRows, [rowRef]);
      mutationsByKey.set(rewritten.absolutePath, rewritten);
      return;
    }

    const promoted: PlannedFileMutation = {
      kind: 'move',
      absolutePath: incoming.targetPath,
      displayPath: incoming.displayPath,
      sourcePath: incoming.sourcePath,
      targetPath: incoming.targetPath,
      source: existingSource.before,
      target: incoming.target,
      afterText: incoming.afterText,
      contributingRows: [...existingSource.contributingRows],
    };
    appendContributingRows(promoted.contributingRows, [rowRef]);
    mutationsByKey.set(promoted.targetPath, promoted);
    return;
  }

  const existingTargetDelete = mutationsByKey.get(incoming.targetPath);
  if (existingTargetDelete?.kind === 'delete') {
    mutationsByKey.delete(existingTargetDelete.absolutePath);
    mutationsByKey.set(incoming.targetPath, {
      ...incoming,
      target: existingTargetDelete.before,
      replaceTargetBeforeMove: true,
      contributingRows: [...existingTargetDelete.contributingRows, rowRef],
    });
    return;
  }

  mutationsByKey.set(incoming.targetPath, {
    ...incoming,
    contributingRows: [rowRef],
  });
}

async function collectVersionToken(
  readSnapshot: (absolutePath: string) => Promise<{
    version: FileVersionToken;
  }>,
  tokens: FileVersionToken[],
  seenPaths: Set<string>,
  absolutePath: string,
) {
  if (seenPaths.has(absolutePath)) {
    return;
  }
  seenPaths.add(absolutePath);
  tokens.push((await readSnapshot(absolutePath)).version);
}

function createSnapshotReader(workspace: Workspace) {
  const cache = new Map<
    string,
    Promise<{
      version: FileVersionToken;
      text: string | null;
    }>
  >();

  return async (absolutePath: string) => {
    if (!cache.has(absolutePath)) {
      cache.set(
        absolutePath,
        (async () => {
          const fileStat = await workspace.stat(absolutePath);
          if (!fileStat.exists) {
            return {
              version: await buildFileVersionToken(workspace, absolutePath, {
                stat: fileStat,
                includeHash: false,
              }),
              text: null,
            };
          }

          const buffer = await workspace.readBuffer(absolutePath);
          if (isLikelyBinaryBuffer(buffer)) {
            throw new Error(
              `Binary file mutations are not supported in apply_patch plan/commit mode: ${absolutePath}`,
            );
          }

          return {
            version: await buildFileVersionToken(workspace, absolutePath, {
              stat: fileStat,
              buffer,
            }),
            text: buffer.toString('utf8'),
          };
        })(),
      );
    }

    return cache.get(absolutePath)!;
  };
}

async function createSnapshot(
  readSnapshot: (absolutePath: string) => Promise<{
    version: FileVersionToken;
    text: string | null;
  }>,
  absolutePath: string,
  displayPath: string,
): Promise<FileSnapshot> {
  const snapshot = await readSnapshot(absolutePath);
  return {
    absolutePath,
    displayPath,
    version: snapshot.version,
    text: snapshot.text,
  };
}

async function materializeMutationForOperation(
  op: PatchOperation,
  readSnapshot: (absolutePath: string) => Promise<{
    version: FileVersionToken;
    text: string | null;
  }>,
  virtual: OverlayWorkspace,
  cwd: string,
): Promise<PlannedFileMutation> {
  if (op.kind === 'delete') {
    const absolutePath = resolvePatchPath(cwd, op.path);
    return {
      kind: 'delete',
      absolutePath,
      displayPath: op.path,
      before: await createSnapshot(readSnapshot, absolutePath, op.path),
      contributingRows: [],
    };
  }

  if (op.kind === 'add') {
    const absolutePath = resolvePatchPath(cwd, op.path);
    return {
      kind: 'write',
      absolutePath,
      displayPath: op.path,
      before: await createSnapshot(readSnapshot, absolutePath, op.path),
      afterText: await virtual.readText(absolutePath),
      contributingRows: [],
    };
  }

  const sourcePath = resolvePatchPath(cwd, op.path);
  const targetPath = resolvePatchPath(cwd, op.moveTo ?? op.path);
  if (op.moveTo) {
    return {
      kind: 'move',
      absolutePath: targetPath,
      displayPath: op.moveTo,
      sourcePath,
      targetPath,
      source: await createSnapshot(readSnapshot, sourcePath, op.path),
      target: await createSnapshot(readSnapshot, targetPath, op.moveTo),
      afterText: await virtual.readText(targetPath),
      contributingRows: [],
    };
  }

  return {
    kind: 'write',
    absolutePath: targetPath,
    displayPath: op.path,
    before: await createSnapshot(readSnapshot, targetPath, op.path),
    afterText: await virtual.readText(targetPath),
    contributingRows: [],
  };
}

interface BuildPatchPlanDiagnostics {
  /**
   * Count of stray `*** End Patch` markers merged away during parse.
   * See `parsePatchWithDiagnostics`. Plumbs through into the final
   * `summaryText` advisory; unset/0 means no advisory is emitted.
   */
  mergedEnvelopes?: number;
  /**
   * True when `preparePatchLines` synthesized a missing
   * `*** Begin Patch` / `*** End Patch` envelope. See
   * `parsePatchWithDiagnostics`. Surfaced in `summaryText` as an
   * advisory so the agent learns to emit the full envelope.
   */
  autoWrappedEnvelope?: boolean;
}

export async function buildPatchPlan(
  ops: PatchOperation[],
  workspace: OverlayWorkspace,
  cwd: string,
  snapshotWorkspace: Workspace = workspace,
  diagnostics: BuildPatchPlanDiagnostics = {},
): Promise<MutationPlan<PatchPreviewRow>> {
  const virtual = workspace.fork();
  const readSnapshot = createSnapshotReader(snapshotWorkspace);
  const rows = toPatchPreviewRows(ops, 'streamed').map((row, index) => ({
    ...row,
    id: `op-${String(index + 1).padStart(4, '0')}`,
  }));
  const mutationsByKey = new Map<string, PlannedFileMutation>();
  const sourceVersions: FileVersionToken[] = [];
  const seenSourceVersionPaths = new Set<string>();
  const statuses: PlanOpStatus[] = [];
  // Phase 2: collect per-op FindReplaceAll match counts so the final
  // summaryText can include an advisory when totals are high.
  const replaceAllTotals: Array<{ path: string; count: number }> = [];
  // Per-op count of FindReplace chunks whose divider was accepted as
  // bare `=======` (aider / git-conflict style) instead of the
  // canonical `======= REPLACE`. Surfaced in the summary so the agent
  // learns to prefer the explicit form, without failing the call.
  const lenientDividerTotals: Array<{ path: string; count: number; style: 'bare' | 'compact' }> =
    [];
  // Per-op flag set when the `quoteStyle` tier fired and REPLACE was
  // re-quoted to match the file. Surfaced in the summary as a nudge
  // for the agent to mirror the file's quote style on future patches.
  const quoteStylePaths: string[] = [];
  // Per-op count of chunks that had any post-parse auto-fix applied,
  // keyed by fix kind (e.g. 'prefix-leak'). Surfaced in the summary
  // so the agent sees what the parser corrected and why.
  const autoFixTotals: Array<{ path: string; kind: AutoFixKind; count: number }> = [];

  for (const [index, op] of ops.entries()) {
    const row = rows[index]!;
    const beforeKey = resolvePatchPath(cwd, op.path);
    const targetKey =
      op.kind === 'update' && op.moveTo ? resolvePatchPath(cwd, op.moveTo) : beforeKey;

    await collectVersionToken(readSnapshot, sourceVersions, seenSourceVersionPaths, beforeKey);
    await collectVersionToken(readSnapshot, sourceVersions, seenSourceVersionPaths, targetKey);

    if (op.kind === 'update') {
      const lenientCounts = new Map<'bare' | 'compact', number>();
      for (const chunk of op.chunks) {
        if (chunk.lenientDivider) {
          const style = chunk.dividerStyle ?? 'bare';
          lenientCounts.set(style, (lenientCounts.get(style) ?? 0) + 1);
        }
      }
      for (const [style, count] of lenientCounts) {
        lenientDividerTotals.push({ path: op.path, count, style });
      }
      // Tally auto-fixes per kind for the summary advisory.
      const autoFixCounts = new Map<AutoFixKind, number>();
      for (const chunk of op.chunks) {
        for (const kind of chunk.autoFixed ?? []) {
          autoFixCounts.set(kind, (autoFixCounts.get(kind) ?? 0) + 1);
        }
      }
      for (const [kind, count] of autoFixCounts) {
        autoFixTotals.push({ path: op.path, kind, count });
      }
    }

    try {
      const results = await applyPatchOperations([op], virtual, cwd, undefined, {
        collectDiff: false,
      });
      const opResult = results[0];
      if (opResult?.replaceAllCount && opResult.replaceAllCount > 0) {
        replaceAllTotals.push({ path: op.path, count: opResult.replaceAllCount });
      }
      if (opResult?.usedQuoteStyle === true) {
        quoteStylePaths.push(op.path);
      }
      const mutation = await materializeMutationForOperation(op, readSnapshot, virtual, cwd);
      mergePlannedMutation(mutationsByKey, mutation, { id: row.id!, rowIndex: index });
      statuses.push({
        opIndex: index,
        opId: row.id!,
        path: op.path,
        kind: op.kind === 'update' && op.moveTo ? 'move' : op.kind,
        wouldApply: true,
      });
    } catch (error) {
      if (error instanceof PatchContextMatchError) {
        // Record failure and continue; virtual state is untouched
        // because applyPatchOperations throws before mutating.
        statuses.push({
          opIndex: index,
          opId: row.id!,
          path: op.path,
          kind: op.kind === 'update' && op.moveTo ? 'move' : op.kind,
          wouldApply: false,
          failure: error.failure,
        });
        continue;
      }
      throw error;
    }
  }

  if (statuses.some((s) => !s.wouldApply)) {
    throw new PatchPlanFailedError(statuses);
  }

  const mutations = [...mutationsByKey.values()].sort((a, b) => {
    const aIndex = Math.min(...a.contributingRows.map((ref) => ref.rowIndex));
    const bIndex = Math.min(...b.contributingRows.map((ref) => ref.rowIndex));
    return aIndex - bIndex;
  });

  return {
    rows,
    mutations,
    sourceVersions,
    summaryText: buildSummaryText(
      rows.length,
      replaceAllTotals,
      lenientDividerTotals,
      quoteStylePaths,
      diagnostics.mergedEnvelopes ?? 0,
      diagnostics.autoWrappedEnvelope ?? false,
      autoFixTotals,
    ),
  };
}

// Phase 2: compose the agent-facing summary, appending FindReplaceAll
// occurrence counts and a high-count advisory when any op replaced
// more than the advisory threshold. The advisory surfaces silently
// (no failure) so agents can verify their SEARCH was not accidentally
// broader than intended.
const FIND_REPLACE_ALL_ADVISORY_THRESHOLD = 20;

function buildSummaryText(
  opCount: number,
  replaceAllTotals: Array<{ path: string; count: number }>,
  lenientDividerTotals: Array<{ path: string; count: number; style: 'bare' | 'compact' }> = [],
  quoteStylePaths: string[] = [],
  mergedEnvelopes = 0,
  autoWrappedEnvelope = false,
  autoFixTotals: Array<{ path: string; kind: AutoFixKind; count: number }> = [],
): string {
  const base = `Applied patch with ${opCount} operation(s).`;
  if (
    replaceAllTotals.length === 0 &&
    lenientDividerTotals.length === 0 &&
    quoteStylePaths.length === 0 &&
    mergedEnvelopes === 0 &&
    !autoWrappedEnvelope &&
    autoFixTotals.length === 0
  ) {
    return base;
  }
  const lines: string[] = [base];
  if (autoWrappedEnvelope) {
    lines.push(
      `  Note: payload was missing '*** Begin Patch' / '*** End Patch' envelope; auto-wrapped it. Include the full envelope on future patches.`,
    );
  }
  for (const { path, kind, count } of autoFixTotals) {
    if (kind === 'prefix-leak') {
      lines.push(
        `  Note: auto-fixed prefix-leak in ${count} chunk${count === 1 ? '' : 's'} in ${path}: stripped leading '+' chars from REPLACE (likely unified-diff syntax leak; REPLACE is literal text, not diff format).`,
      );
    }
  }
  if (mergedEnvelopes > 0) {
    lines.push(
      `  Note: merged ${mergedEnvelopes} concatenated '*** Begin Patch'/'*** End Patch' envelope${mergedEnvelopes === 1 ? '' : 's'} into a single patch. Emit exactly one '*** Begin Patch' ... '*** End Patch' pair per apply_patch call.`,
    );
  }
  for (const { path, count } of replaceAllTotals) {
    if (count > FIND_REPLACE_ALL_ADVISORY_THRESHOLD) {
      lines.push(
        `  Warning: FindReplaceAll in ${path} replaced ${count} occurrences. Verify this was intended — very short or common patterns can match more places than expected.`,
      );
    } else {
      lines.push(
        `  Note: FindReplaceAll in ${path} replaced ${count} occurrence${count === 1 ? '' : 's'}.`,
      );
    }
  }
  for (const { path, count, style } of lenientDividerTotals) {
    const accepted = style === 'compact' ? "compact '=======REPLACE'" : "bare '======='";
    lines.push(
      `  Note: accepted ${accepted} as the SEARCH/REPLACE divider in ${count} chunk${count === 1 ? '' : 's'} in ${path}. Prefer '======= REPLACE' (explicit form) so SEARCH blocks containing divider-like lines stay unambiguous.`,
    );
  }
  for (const path of quoteStylePaths) {
    lines.push(
      `  Note: fuzzy-applied (${QUOTE_TIER_NAME}) in ${path}: SEARCH used a different straight-quote style than the file; REPLACE was re-quoted to match. Mirror the file's quote style on future patches to avoid needing this fallback.`,
    );
  }
  return lines.join('\n');
}

export async function applyPatchOperations(
  ops: PatchOperation[],
  workspace: Workspace,
  cwd: string,
  signal?: AbortSignal,
  options?: { collectDiff?: boolean },
): Promise<PatchOpResult[]> {
  const results: PatchOpResult[] = [];
  const collectDiff = options?.collectDiff ?? false;

  for (const op of ops) {
    if (signal?.aborted) throw new Error('Operation aborted');
    if (op.kind === 'add') {
      const abs = resolvePatchPath(cwd, op.path);
      if (await workspace.exists(abs)) {
        throw new Error(`Failed to add ${op.path}: file already exists`);
      }
      await workspace.checkWriteAccess(abs);
      const newText = ensureTrailingNewline(op.contents);
      await workspace.writeTextAtomic(abs, newText);
      const result: PatchOpResult = {
        path: op.path,
        message: `Added file ${op.path}.`,
        operation: toPatchPreviewRows([op], 'applied')[0]!,
      };
      if (collectDiff) {
        const diffResult = generateDiffString('', newText);
        result.diff = diffResult.diff;
        result.firstChangedLine = diffResult.firstChangedLine;
      }
      results.push(result);
      continue;
    }

    if (op.kind === 'delete') {
      const abs = resolvePatchPath(cwd, op.path);
      const exists = await workspace.exists(abs);
      if (!exists) throw new Error(`Failed to delete ${op.path}: file does not exist`);
      const oldBuffer = workspace.readBuffer
        ? await workspace.readBuffer(abs)
        : Buffer.from(await workspace.readText(abs), 'utf8');
      const isBinary = isLikelyBinaryBuffer(oldBuffer);
      const oldText = isBinary ? '' : oldBuffer.toString('utf8');
      await workspace.deleteFile(abs);
      const result: PatchOpResult = {
        path: op.path,
        message: `Deleted file ${op.path}.`,
        operation: {
          kind: 'delete',
          path: op.path,
          state: 'applied',
          contentKind: isBinary ? 'binary' : 'text',
          byteLength: oldBuffer.byteLength,
          lineCount: isBinary ? undefined : countTextLines(oldText),
        },
      };
      results.push(result);
      continue;
    }

    const sourceAbs = resolvePatchPath(cwd, op.path);
    const targetPath = op.moveTo ?? op.path;
    const targetAbs = resolvePatchPath(cwd, targetPath);
    await workspace.checkWriteAccess(sourceAbs);
    if (targetAbs !== sourceAbs) {
      await workspace.checkWriteAccess(targetAbs);
      if (await workspace.exists(targetAbs)) {
        throw new Error(`Failed to move ${op.path} to ${targetPath}: target already exists`);
      }
    }
    const sourceText = await workspace.readText(sourceAbs);
    let updated = sourceText;
    let usedFuzzy = false;
    let usedQuoteStyle = false;
    let replaceAllCount: number | undefined;
    if (op.chunks.length > 0) {
      const allowQuoteStyleTier = isQuoteTierEligibleForFile(sourceAbs, cwd);
      const result = deriveUpdatedContent(op.path, sourceText, op.chunks, {
        allowQuoteStyleTier,
      });
      updated = result.content;
      usedFuzzy = result.usedFuzzy;
      usedQuoteStyle = result.usedQuoteStyle === true;
      if (result.replaceAllCounts) {
        let total = 0;
        for (const c of result.replaceAllCounts.values()) total += c;
        if (total > 0) replaceAllCount = total;
      }
    }

    if (targetAbs !== sourceAbs) {
      if (updated === sourceText) {
        await workspace.renameAtomic(sourceAbs, targetAbs);
      } else {
        await workspace.writeTextAtomic(targetAbs, updated);
        await workspace.deleteFile(sourceAbs);
      }
    } else {
      await workspace.writeTextAtomic(sourceAbs, updated);
    }

    const moved = targetPath !== op.path;
    const changed = updated !== sourceText;
    const baseOperation = moved
      ? ({
          kind: 'update',
          path: op.path,
          moveTo: targetPath,
          chunks: op.chunks,
        } satisfies PatchOperation)
      : op;
    const result: PatchOpResult = {
      path: targetPath,
      message: moved
        ? changed
          ? `Moved ${op.path} to ${targetPath} and updated contents.`
          : `Moved ${op.path} to ${targetPath}.`
        : `Updated ${op.path}.`,
      operation: toPatchPreviewRows([baseOperation], 'applied')[0]!,
    };
    if (usedFuzzy) result.usedFuzzy = true;
    if (usedQuoteStyle) result.usedQuoteStyle = true;
    if (replaceAllCount !== undefined) result.replaceAllCount = replaceAllCount;
    if (collectDiff) {
      const diffResult = generateDiffString(sourceText, updated);
      result.diff = diffResult.diff;
      result.firstChangedLine = diffResult.firstChangedLine;
    }
    results.push(result);
  }

  return results;
}
