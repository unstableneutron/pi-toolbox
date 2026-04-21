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

type MatchTier = 'exact' | 'rstrip' | 'trim' | 'fuzzy';

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
    const failedCount = failures.length;
    const okCount = statuses.length - failedCount;
    super(
      `Patch plan failed: ${failedCount} operation(s) would fail; ${okCount} would succeed (all rolled back per atomic policy).`,
    );
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
    'Tip: rebuild using the actual text above; no re-read needed unless you suspect broader drift.',
  );
  return parts.join('\n');
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
}

const BEGIN_PATCH_LINE = '*** Begin Patch';
const END_PATCH_LINE = '*** End Patch';
const ADD_FILE_PREFIX = '*** Add File: ';
const DELETE_FILE_PREFIX = '*** Delete File: ';
const UPDATE_FILE_PREFIX = '*** Update File: ';
const MOVE_TO_PREFIX = '*** Move to: ';
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
  const tiers: Array<{ eq: (a: string, b: string) => boolean; tier: MatchTier }> = [
    { eq: exactEqual, tier: 'exact' },
    { eq: rstripEqual, tier: 'rstrip' },
    { eq: trimEqual, tier: 'trim' },
    { eq: fuzzyEqual, tier: 'fuzzy' },
  ];

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

const MATCH_TIER_ORDER: MatchTier[] = ['exact', 'rstrip', 'trim', 'fuzzy'];
const LARGE_FILE_SAMPLING_THRESHOLD = 5000;
const DEFAULT_MARGIN_SIZE = 3;
const MAX_NEARBY_IDENTIFIERS = 5;

function compareLines(a: string, b: string, tier: MatchTier): boolean {
  if (tier === 'exact') return a === b;
  if (tier === 'rstrip') return a.trimEnd() === b.trimEnd();
  if (tier === 'trim') return a.trim() === b.trim();
  return normaliseLineForFuzzyMatch(a) === normaliseLineForFuzzyMatch(b);
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

  constructor(filePath: string, matchLines: number[]) {
    super(
      `FindReplaceOnce in ${filePath} found ${matchLines.length} matches; expected exactly 1: ${matchLines.map((l) => `line ${l}`).join(', ')}.`,
    );
    this.filePath = filePath;
    this.matchLines = matchLines;
    this.name = 'AmbiguousFindReplaceOnceError';
  }
}

function deriveUpdatedNormalizedContent(
  filePath: string,
  normalizedContent: string,
  chunks: UpdateChunk[],
): DeriveUpdatedResult {
  const hadTrailingNewline = normalizedContent.endsWith('\n');
  const originalLines = normalizedContent.split('\n');
  if (originalLines[originalLines.length - 1] === '') originalLines.pop();

  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;
  let usedFuzzy = false;
  let replaceAllCounts: Map<number, number> | undefined;

  for (const [chunkIndex, chunk] of chunks.entries()) {
    if (chunk.changeContext && chunk.changeContext.length > 0) {
      for (const anchor of chunk.changeContext) {
        const ctxMatch = seekSequence(originalLines, [anchor], lineIndex, false);
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
        });
      }
      if (result.positions.length > 1) {
        throw new AmbiguousFindReplaceOnceError(
          filePath,
          result.positions.map((p) => p + 1),
        );
      }
      const pos = result.positions[0]!;
      if (result.tier === 'trim' || result.tier === 'fuzzy') usedFuzzy = true;
      replacements.push([pos, chunk.oldLines.length, [...chunk.newLines]]);
      // Do not advance lineIndex — FindReplace chunks match against
      // original state and do not cursor-advance between chunks.
      continue;
    }

    // FindReplaceAll: scan in the first tier with any matches; apply
    // replacements at every position. Zero matches raises the same
    // P0 near-miss as FindReplaceOnce / hunk mismatches.
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
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    if (found === undefined && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      if (newSlice[newSlice.length - 1] === '') {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
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
      });
    }
    if (found.tier === 'trim' || found.tier === 'fuzzy') usedFuzzy = true;
    replacements.push([found.startIndex, pattern.length, [...newSlice]]);
    lineIndex = found.startIndex + pattern.length;
  }

  const newLines = applyReplacements(originalLines, replacements);
  if (hadTrailingNewline) {
    if (newLines[newLines.length - 1] !== '') newLines.push('');
  } else if (newLines[newLines.length - 1] === '') {
    newLines.pop();
  }
  return { content: newLines.join('\n'), usedFuzzy, replaceAllCounts };
}

function deriveUpdatedContent(
  filePath: string,
  currentContent: string,
  chunks: UpdateChunk[],
): DeriveUpdatedResult {
  const { bom, text } = stripBom(currentContent);
  const ending = detectLineEnding(text);
  const normalized = normalizeToLF(text);
  const result = deriveUpdatedNormalizedContent(filePath, normalized, chunks);
  return {
    content: bom + restoreLineEndings(result.content, ending),
    usedFuzzy: result.usedFuzzy,
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

function parsePathFromHeader(line: string, prefix: string): string {
  const path = line.slice(prefix.length).trim();
  if (!path) {
    throw new Error(`Patch header '${prefix.trim()}' must include a path`);
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

  const searchLines: string[] = [];
  while (i <= lastContentLine) {
    const raw = lines[i] ?? '';
    if (raw.trim() === FIND_REPLACE_DIVIDER) break;
    searchLines.push(raw);
    i++;
  }
  if (i > lastContentLine) {
    throw new Error(`${expectedHeader} missing '${FIND_REPLACE_DIVIDER}' divider`);
  }
  i++; // skip the divider itself

  const replaceLines: string[] = [];
  while (i <= lastContentLine) {
    const raw = lines[i] ?? '';
    if (raw.trim() === FIND_REPLACE_END_MARKER) break;
    replaceLines.push(raw);
    i++;
  }
  if (i > lastContentLine) {
    throw new Error(`${expectedHeader} missing '${FIND_REPLACE_END_MARKER}' terminator`);
  }
  i++; // skip the end marker

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
  if (line.startsWith(ADD_FILE_PREFIX) && line.slice(ADD_FILE_PREFIX.length).trim().length > 0) {
    return true;
  }
  if (
    line.startsWith(DELETE_FILE_PREFIX) &&
    line.slice(DELETE_FILE_PREFIX.length).trim().length > 0
  ) {
    return true;
  }
  if (
    line.startsWith(UPDATE_FILE_PREFIX) &&
    line.slice(UPDATE_FILE_PREFIX.length).trim().length > 0
  ) {
    return true;
  }
  if (line.startsWith(MOVE_TO_PREFIX) && line.slice(MOVE_TO_PREFIX.length).trim().length > 0) {
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

  const patchComplete = lines[lines.length - 1]?.trim() === END_PATCH_LINE;
  return { lines, patchComplete };
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
    throw new Error("The last line of the patch must be '*** End Patch'");
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
      const path = parsePathFromHeader(trimmed, ADD_FILE_PREFIX);
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
      const path = parsePathFromHeader(trimmed, DELETE_FILE_PREFIX);
      operations.push({ kind: 'delete', path, state: 'streamed' });
      i++;
      continue;
    }

    if (trimmed.startsWith(UPDATE_FILE_PREFIX)) {
      const path = parsePathFromHeader(trimmed, UPDATE_FILE_PREFIX);
      i++;
      let moveTo: string | undefined;
      if (i < lines.length && lines[i]?.trim().startsWith(MOVE_TO_PREFIX)) {
        moveTo = parsePathFromHeader(lines[i]!.trim(), MOVE_TO_PREFIX);
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
          const parsed = parseFindReplaceChunk(lines, i, lines.length - 1, variant);
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
  const prepared = preparePatchLines(patchText, 'strict');
  const operations = parsePatchOperationsFromLines(
    prepared.lines,
    'strict',
    prepared.patchComplete,
  );
  return operations.map(({ state: _state, ...operation }) => operation);
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

export async function buildPatchPlan(
  ops: PatchOperation[],
  workspace: OverlayWorkspace,
  cwd: string,
  snapshotWorkspace: Workspace = workspace,
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

  for (const [index, op] of ops.entries()) {
    const row = rows[index]!;
    const beforeKey = resolvePatchPath(cwd, op.path);
    const targetKey =
      op.kind === 'update' && op.moveTo ? resolvePatchPath(cwd, op.moveTo) : beforeKey;

    await collectVersionToken(readSnapshot, sourceVersions, seenSourceVersionPaths, beforeKey);
    await collectVersionToken(readSnapshot, sourceVersions, seenSourceVersionPaths, targetKey);

    try {
      const results = await applyPatchOperations([op], virtual, cwd, undefined, {
        collectDiff: false,
      });
      const opResult = results[0];
      if (opResult?.replaceAllCount && opResult.replaceAllCount > 0) {
        replaceAllTotals.push({ path: op.path, count: opResult.replaceAllCount });
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
    summaryText: buildSummaryText(rows.length, replaceAllTotals),
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
): string {
  const base = `Applied patch with ${opCount} operation(s).`;
  if (replaceAllTotals.length === 0) return base;
  const lines: string[] = [base];
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
    let replaceAllCount: number | undefined;
    if (op.chunks.length > 0) {
      const result = deriveUpdatedContent(op.path, sourceText, op.chunks);
      updated = result.content;
      usedFuzzy = result.usedFuzzy;
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
