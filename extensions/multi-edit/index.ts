import { resolve as resolvePath, isAbsolute } from 'node:path';
import { readFileSync } from 'node:fs';

import type {
  EditToolDetails,
  ExtensionAPI,
  ToolRenderResultOptions,
} from '@earendil-works/pi-coding-agent';
import { Container, Spacer, Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import {
  applyClassicEditsToText,
  detectLineEnding,
  generateDiffString,
  normalizeClassicParams,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  type ClassicEditItem,
  type ClassicEditResult,
} from './classic';
import { DEFAULT_TOOL_DISPLAY_CONFIG } from './display-types';
import { renderEditDiffResult } from './diff-renderer';
import { withFilesMutationQueue } from './locking';
import { extractTextOutput, pluralize, shortenDisplayPath } from './render-utils';
import {
  applyPatchTextAutofixes,
  buildPatchPlan,
  createRealWorkspace,
  createVirtualWorkspace,
  parsePatchStreaming,
  parsePatchWithDiagnostics,
  PatchContextMatchError,
  PatchPlanFailedError,
  renderContextMatchFailure,
  renderPlanFailure,
  type PatchOperation,
  type PatchPreviewRow,
} from './patch';
import { createPatchSession } from './patch-session';
import {
  buildFileVersionTokenFromTextSnapshot,
  commitMutationPlan,
  type MutationPlan,
} from './mutation-plan';
import { renderApplyPatchRows } from './display/apply-patch-summary';
import { TOOL_REWRITE_ARROW } from '../shared/rewrite-label';
import type { Workspace } from './workspace';

type ToolProfile = 'extended' | 'codex-compatible';
type ApplyPatchProfile = ToolProfile;

interface MatchConfig {
  includes?: string[];
}

interface ToolProfileModelMatch {
  match?: MatchConfig;
  profile?: ToolProfile;
}

interface ExtensionConfig {
  profiles?: {
    default?: ToolProfile;
    modelProfiles?: ToolProfileModelMatch[];
  };
  display?: Record<string, unknown>;
}

type LazyDiffDetails = EditToolDetails & {
  diffInputs?: Array<{
    displayPath: string;
    beforeText: string;
    afterText: string;
  }>;
};

function loadExtensionConfig(): ExtensionConfig {
  try {
    const raw = readFileSync(new URL('./config.json', import.meta.url), 'utf-8');
    const parsed = JSON.parse(raw) as ExtensionConfig;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function materializeLazyDiffDetails(
  details: LazyDiffDetails | undefined,
  expanded: boolean,
): EditToolDetails | undefined {
  if (!details) {
    return undefined;
  }

  if (!expanded || details.diff || !details.diffInputs || details.diffInputs.length === 0) {
    return details;
  }

  const diffSegments: string[] = [];
  let firstChangedLine = details.firstChangedLine;
  for (const input of details.diffInputs) {
    const diff = generateDiffString(input.beforeText, input.afterText);
    if (diff.diff) {
      diffSegments.push(`File: ${input.displayPath}\n${diff.diff}`);
    }
    if (firstChangedLine === undefined && diff.firstChangedLine !== undefined) {
      firstChangedLine = diff.firstChangedLine;
    }
  }

  return {
    ...details,
    diff: diffSegments.join('\n\n'),
    firstChangedLine,
  };
}

const EXTENSION_CONFIG = loadExtensionConfig();

function buildApplyPatchPromptAppend(
  disabledTools: string[] = [],
  profile: ApplyPatchProfile = 'extended',
): string {
  if (profile === 'codex-compatible') {
    return buildCodexCompatibleApplyPatchPromptAppend(disabledTools);
  }
  return buildExtendedApplyPatchPromptAppend(disabledTools);
}

function buildCodexCompatibleApplyPatchPromptAppend(disabledTools: string[] = []): string {
  const disabled = new Set(disabledTools);
  const editEnabled = !disabled.has('edit');
  const editGuidance = editEnabled
    ? '- Use edit for exact text replacements with { path, edits[] } when a classic edit is more appropriate.\n'
    : '';
  const mutationAlternatives = editEnabled ? 'apply_patch or edit' : 'apply_patch';

  return `Always use apply_patch for manual code edits.
- Prefer apply_patch for file creation, deletion, renames, and other patch-shaped edits when a patch would suffice.
${editGuidance}- Do not use bash or shell file-mutation commands like cat, tee, cp, or here-docs when ${mutationAlternatives} would suffice.

Codex-compatible apply_patch grammar:
- Use the exact patch envelope: *** Begin Patch ... *** End Patch.
- Each operation must start with exactly one header: *** Add File:, *** Delete File:, or *** Update File:.
- For renames, put *** Move to: immediately after *** Update File:.
- Update file chunks use @@ context markers followed by lines prefixed with one space for context, - for removals, and + for additions.
- A bare @@ marker starts an unanchored chunk. @@ <label> is a WHOLE-LINE anchor, not a substring; the anchor line is preserved and the first changed line applies after it.
- Line-numbered unified-diff headers are not the target syntax. Use a bare @@ marker instead of headers like @@ -10,7 +10,7 @@.
- For *** Add File: blocks, every file-content line must start with a literal + with NO space after it. +hello is correct; + hello inserts a leading space.
- Use *** End of File only when a chunk must match the end of the file.
- Do not use alternate search/replace block syntaxes in this profile.

Other invariants:
- All chunks within one *** Update File: block match against the ORIGINAL file state — not against earlier chunks' results. If two chunks must depend on each other, split into separate *** Update File: sections or separate apply_patch calls.
- apply_patch applies valid independent operations and reports failed or skipped operations. After a partial failure, read failed/skipped files before retrying. Do not reread applied files unless a specific dependency requires it.
- Formatting commands, tests, and read/search commands do not need apply_patch.

Canonical example:
${'```'}
*** Begin Patch
*** Update File: src/service.ts
@@
 const DEBUG = true;
-const VERBOSE = true;
+const VERBOSE = false;
*** Add File: src/new-service.ts
+export const enabled = true;
*** End Patch
${'```'}`;
}

function buildExtendedApplyPatchPromptAppend(disabledTools: string[] = []): string {
  const disabled = new Set(disabledTools);
  const editEnabled = !disabled.has('edit');
  const editGuidance = editEnabled
    ? '- Use edit for exact text replacements with { path, edits[] }.\n'
    : '';
  const mutationAlternatives = editEnabled ? 'apply_patch or edit' : 'apply_patch';

  return `Always use apply_patch for manual code edits.
- Prefer apply_patch for file creation, deletion, renames, and other patch-shaped edits when a patch would suffice.
${editGuidance}- Do not use bash or shell file-mutation commands like cat, tee, cp, or here-docs when ${mutationAlternatives} would suffice.

Choosing a chunk shape inside *** Update File: blocks:
- DEFAULT: use *** FindReplaceOnce: for nearly every edit. Paste the exact text you want to change into SEARCH; paste what it should become into REPLACE. SEARCH must match exactly once in the file (0 or 2+ matches fail with a clear error). This single shape covers single-line rewrites, multi-line block rewrites, function-body replacement, and renames of a unique symbol.
- Use *** FindReplaceAll: ONLY when you deliberately want to replace every whole-line occurrence of the same SEARCH block (e.g., removing a deprecated import line across a file, or updating a repeated header). The result includes the match count; verify it matches your expectation. Very short or common SEARCH patterns can match more places than you intended.
- Use @@ hunks ONLY when you need several coordinated -/+ changes in close proximity that would be awkward to split into separate FindReplaceOnce blocks. Most tasks do not need @@. If you find yourself reaching for @@ for a simple rewrite, use FindReplaceOnce instead — it is more robust to whitespace drift.

FindReplaceOnce / FindReplaceAll delimiters (each on its own line):
  "<<<<<<< SEARCH"
  (old text)
  "======= REPLACE"
  (new text)
  ">>>>>>> REPLACE"

@@ hunk rules (only if you actually need a hunk):
- "@@" is a bare marker on its own line. Line numbers are ignored — do NOT write "@@ -10,7 +10,7 @@". There is no hunk separator; do not insert bare "***" lines between chunks.
- "@@ <label>" is optional and is a WHOLE-LINE anchor, not a substring. "@@ class Foo" matches a line whose content is exactly "class Foo"; it will NOT match "class Foo extends Bar {" or "class Foo {". The anchor line itself is preserved as context — the first -/+ line applies to the line AFTER the anchor. Prefer a bare "@@" with no label unless you genuinely need to disambiguate; then pick a line that appears verbatim in the file (a blank line, a closing brace, a one-line header).

For *** Add File: blocks, every content line must start with a literal "+" with NO space between the "+" and the content. "+hello" is correct; "+ hello" inserts a leading space on every line. Leading whitespace is part of the content.

Other invariants:
- All chunks within one *** Update File: block match against the ORIGINAL file state — not against earlier chunks' results. If two chunks must depend on each other, split into separate *** Update File: sections or separate apply_patch calls.
- apply_patch applies valid independent operations and reports failed or skipped operations. After a partial failure, read failed/skipped files before retrying. Do not reread applied files unless a specific dependency requires it. Batch tightly-coupled edits when they share invariants, but remember a partial result can leave related cross-file work incomplete.
- Formatting commands, tests, and read/search commands do not need apply_patch.

Canonical example. Most real patches look like the FindReplaceOnce / FindReplaceAll portions; @@ is shown last for completeness.
${'```'}
*** Begin Patch
*** Update File: src/service.ts
*** FindReplaceOnce:
${'<<<<<<<'} SEARCH
// TODO: rename later
${'======='} REPLACE
// DONE: renamed
${'>>>>>>>'} REPLACE
*** FindReplaceOnce:
${'<<<<<<<'} SEARCH
export function getUserId(raw: string): string {
  return raw.trim();
}
${'======='} REPLACE
export function resolveUserId(raw: string): string {
  return raw.trim().toLowerCase();
}
${'>>>>>>>'} REPLACE
*** FindReplaceAll:
${'<<<<<<<'} SEARCH
import { legacy } from "old";
${'======='} REPLACE
import { modern } from "new";
${'>>>>>>>'} REPLACE
@@
 // Two adjacent lines with shared context — the sort of edit
 // where @@ is genuinely more compact than two FindReplaceOnce
 // blocks.
-const DEBUG = true;
-const VERBOSE = true;
+const DEBUG = false;
+const VERBOSE = false;
*** End Patch
${'```'}`;
}

const replaceEditSchema = Type.Object({
  oldText: Type.String({
    description:
      'Exact text for one targeted replacement. Keep it as small as possible while still being unique enough for the intended edit.',
  }),
  newText: Type.String({
    description: 'Replacement text for this targeted edit.',
  }),
});

const legacyEditItemSchema = Type.Object({
  path: Type.Optional(
    Type.String({
      description:
        'Path to the file to edit (relative or absolute). Inherits from top-level path if omitted.',
    }),
  ),
  oldText: Type.String({
    description: 'Exact text to find and replace (must match exactly).',
  }),
  newText: Type.String({
    description: 'Replacement text for the matched block.',
  }),
});

const multiEditSchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        description: 'Path to the file to edit (relative or absolute).',
      }),
    ),
    edits: Type.Optional(
      Type.Array(replaceEditSchema, {
        description:
          'Canonical classic edit API: one or more replacements applied sequentially within the target file.',
      }),
    ),
    oldText: Type.Optional(Type.String({ description: 'Legacy single-edit compatibility field.' })),
    newText: Type.Optional(Type.String({ description: 'Legacy single-edit compatibility field.' })),
    multi: Type.Optional(
      Type.Array(legacyEditItemSchema, {
        description:
          'Legacy multi-edit compatibility field. Each item may target the same or a different file.',
      }),
    ),
    patch: Type.Optional(
      Type.String({
        description:
          'Legacy patch compatibility field. Prefer the standalone apply_patch tool for Codex-style patches.',
      }),
    ),
  },
  { additionalProperties: false },
);

const applyPatchSchema = Type.Object(
  {
    patch: Type.String({
      description:
        'Patch payload. Use the syntax advertised by the active multi-edit profile. The patch value must be raw patch text only, with no Markdown fences, surrounding prose, or commentary.',
    }),
  },
  { additionalProperties: false },
);

function resolveToCwd(path: string, cwd: string): string {
  return isAbsolute(path) ? resolvePath(path) : resolvePath(cwd, path);
}

function prepareApplyPatchArguments(args: unknown): { patch: string } {
  if (typeof args === 'string') {
    return { patch: args };
  }
  if (args && typeof args === 'object' && typeof (args as { patch?: unknown }).patch === 'string') {
    return { patch: (args as { patch: string }).patch };
  }
  throw new Error('apply_patch requires a patch string.');
}

function getModelIdentity(model: { provider?: string; id?: string } | undefined): string {
  if (!model) return '';
  const provider = typeof model.provider === 'string' ? model.provider : '';
  const id = typeof model.id === 'string' ? model.id : '';
  return [provider, id].filter(Boolean).join('/').toLowerCase();
}

function matchesModel(identity: string, match: MatchConfig | undefined): boolean {
  const includes = Array.isArray(match?.includes) ? match.includes : [];
  return includes.some((pattern) => {
    const normalized = pattern.trim().toLowerCase();
    return normalized.length > 0 && identity.includes(normalized);
  });
}

function normalizeToolProfile(value: unknown): ToolProfile | undefined {
  return value === 'extended' || value === 'codex-compatible' ? value : undefined;
}

function getToolProfileForModel(
  model: { provider?: string; id?: string } | undefined,
): ToolProfile {
  const configuredDefault = normalizeToolProfile(EXTENSION_CONFIG.profiles?.default);
  const defaultProfile = configuredDefault ?? 'extended';
  const identity = getModelIdentity(model);
  if (!identity) return defaultProfile;

  for (const policy of EXTENSION_CONFIG.profiles?.modelProfiles ?? []) {
    if (!matchesModel(identity, policy.match)) continue;
    return normalizeToolProfile(policy.profile) ?? defaultProfile;
  }

  return defaultProfile;
}

const CODEX_COMPATIBLE_DISABLED_TOOLS = new Set(['edit', 'write']);

function isToolAllowedForProfile(toolName: string, profile: ToolProfile): boolean {
  return profile === 'extended' || !CODEX_COMPATIBLE_DISABLED_TOOLS.has(toolName);
}

function getDisabledToolsForProfile(profile: ToolProfile, allTools: string[]): string[] {
  return profile === 'extended'
    ? []
    : allTools.filter((name) => CODEX_COMPATIBLE_DISABLED_TOOLS.has(name));
}

function areToolNameListsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function applyModelToolPolicy(
  pi: Pick<ExtensionAPI, 'getActiveTools' | 'getAllTools' | 'setActiveTools'>,
  model:
    | {
        provider?: string;
        id?: string;
      }
    | undefined,
): string[] {
  const profile = getToolProfileForModel(model);
  if (typeof pi.getAllTools !== 'function') {
    return profile === 'extended' ? [] : ['edit', 'write'];
  }

  const allTools = pi.getAllTools().map((tool) => tool.name);
  const activeTools = typeof pi.getActiveTools === 'function' ? pi.getActiveTools() : [...allTools];
  const disabledByProfile = new Set(getDisabledToolsForProfile(profile, allTools));
  const nextActive = activeTools.filter((name) => !disabledByProfile.has(name));

  if (
    profile !== 'extended' &&
    typeof pi.setActiveTools === 'function' &&
    !areToolNameListsEqual(activeTools, nextActive)
  ) {
    pi.setActiveTools(nextActive);
  }

  const activeAfterPolicy = new Set(nextActive);
  return allTools.filter(
    (name) => CODEX_COMPATIBLE_DISABLED_TOOLS.has(name) && !activeAfterPolicy.has(name),
  );
}

function getToolPathArg(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record.file_path === 'string'
    ? record.file_path
    : typeof record.path === 'string'
      ? record.path
      : undefined;
}

function getEditLineCount(value: unknown): number {
  if (!value || typeof value !== 'object') {
    return 0;
  }
  const record = value as Record<string, unknown>;
  const countLines = (text: unknown) =>
    typeof text === 'string' && text.length > 0 ? text.replace(/\r/g, '').split('\n').length : 0;
  const edits = Array.isArray(record.edits) ? record.edits : [];
  if (edits.length > 0) {
    return edits.reduce((total, edit) => {
      if (!edit || typeof edit !== 'object') return total;
      return total + countLines((edit as Record<string, unknown>).newText);
    }, 0);
  }
  return countLines(record.newText);
}

function formatLineCountSuffix(
  lineCount: number,
  theme: { fg(color: string, text: string): string },
): string {
  return theme.fg('muted', ` (${lineCount} ${pluralize(lineCount, 'line')})`);
}

function formatInProgressLineCount(
  action: string,
  lineCount: number,
  theme: { fg(color: string, text: string): string },
): string {
  return theme.fg('warning', `${action}...`) + formatLineCountSuffix(lineCount, theme);
}

function isToolError(result: unknown, context?: { isError?: boolean }): boolean {
  return (
    context?.isError === true ||
    (!!result && typeof result === 'object' && (result as { isError?: boolean }).isError === true)
  );
}

function formatClassicResults(results: ClassicEditResult[]): string {
  const applied = results.filter((result) => !result.skipped).length;
  const skipped = results.filter((result) => result.skipped).length;
  const lines = [`Applied ${results.length} edit(s).`, `${applied} applied.`];
  if (skipped > 0) {
    lines.push(`${skipped} redundant duplicate skipped.`);
  }
  for (const result of results) {
    lines.push(`- ${result.message}`);
  }
  return lines.join('\n');
}

function patchRowKey(row: PatchPreviewRow): string {
  if (row.id) return row.id;
  if (row.kind === 'move') return `${row.kind}:${row.path}->${row.targetPath}`;
  return `${row.kind}:${row.path}`;
}

function markRows(rows: PatchPreviewRow[], state: PatchPreviewRow['state']): PatchPreviewRow[] {
  return rows.map((row) => ({ ...row, state }));
}

function markRowsInProgress(rows: PatchPreviewRow[]): PatchPreviewRow[] {
  return rows.map((row) => ({ ...row, state: 'committing' }));
}

type PartialPatchMetadata = NonNullable<Awaited<ReturnType<typeof buildPatchPlan>>['patch']>;
type PartialPatchStatus = PartialPatchMetadata['statuses'][number];

type PartialPatchDiagnostic = {
  opId: string;
  status: 'failed' | 'skipped';
  kind: PartialPatchStatus['kind'];
  path: string;
  diagnostic: string;
};

function applyPartialPlanRows(
  rows: PatchPreviewRow[],
  partial: PartialPatchMetadata | undefined,
): PatchPreviewRow[] {
  if (!partial) {
    return rows.map((row) => ({ ...row, state: 'applied' as const }));
  }

  const failed = new Set(partial.failedRows.map((row) => patchRowKey(row)));
  const skipped = new Set(partial.skippedRows.map((row) => patchRowKey(row)));
  return rows.map((row) => {
    const key = patchRowKey(row);
    if (failed.has(key)) return { ...row, state: 'failed' as const };
    if (skipped.has(key)) return { ...row, state: 'skipped' as const };
    return { ...row, state: 'applied' as const };
  });
}

function truncateDiagnosticSnippet(text: string): string {
  const compact = text.replace(/\n/g, '\\n');
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact;
}

function quoteDiagnosticSnippet(lines: readonly string[] | undefined): string {
  const text = (lines ?? []).join('\n').trimEnd();
  return JSON.stringify(truncateDiagnosticSnippet(text || '<empty>'));
}

function diagnosticForStatus(status: PartialPatchStatus): string {
  if (status.status === 'skipped') {
    return `skipped because an earlier failed operation touched ${status.path}.`;
  }

  const failure = status.failure;
  if (failure?.kind === 'context-not-found') {
    const expected = `No match for expected lines ${quoteDiagnosticSnippet(failure.expectedLines)}`;
    const near = failure.nearestMatch;
    if (near && near.actualLines.length > 0) {
      const pct = Math.round(near.score * 100);
      return `${expected}; nearest line ${near.startLine} is ${quoteDiagnosticSnippet(near.actualLines)} (${pct}% similar).`;
    }
    return `${expected}.`;
  }
  if (failure?.kind === 'anchor-not-found') {
    const anchor = `Anchor not found ${quoteDiagnosticSnippet(failure.anchor ? [failure.anchor] : [])}`;
    const nearby = failure.nearbyIdentifiers?.[0];
    if (nearby) {
      return `${anchor}; nearest identifier line ${nearby.line} is ${quoteDiagnosticSnippet([nearby.text])}.`;
    }
    return `${anchor}.`;
  }

  return status.error ?? 'failed';
}

function buildPartialPatchDiagnostics(
  partial: PartialPatchMetadata | undefined,
  statusKind: 'failed' | 'skipped',
): PartialPatchDiagnostic[] {
  if (!partial) return [];

  return partial.statuses
    .filter((status) => status.status === statusKind)
    .map((status) => ({
      opId: status.opId,
      status: statusKind,
      kind: status.kind,
      path: status.path,
      diagnostic: diagnosticForStatus(status),
    }));
}

function formatPartialPatchDiagnostics(
  heading: string,
  diagnostics: PartialPatchDiagnostic[],
): string[] {
  if (diagnostics.length === 0) return [];
  return [
    heading,
    ...diagnostics.map(
      (diagnostic) =>
        `- ${diagnostic.opId} ${diagnostic.kind} ${diagnostic.path}: ${diagnostic.diagnostic}`,
    ),
  ];
}

function formatPartialPatchSummary(total: number, partial: PartialPatchMetadata): string {
  const { appliedRows, failedRows, skippedRows, recoveryInstructions: recovery } = partial;
  const failedDiagnostics = buildPartialPatchDiagnostics(partial, 'failed');
  const skippedDiagnostics = buildPartialPatchDiagnostics(partial, 'skipped');
  const lines = [`apply_patch partially applied ${appliedRows.length} of ${total} operations.`];
  if (failedRows.length > 0) {
    lines.push(`Failed: ${failedRows.map((row) => row.path).join(', ')}`);
  }
  if (skippedRows.length > 0) {
    lines.push(
      `Skipped due to failed dependencies: ${skippedRows.map((row) => row.path).join(', ')}`,
    );
  }
  if (appliedRows.length > 0) {
    lines.push(`Applied: ${appliedRows.map((row) => row.path).join(', ')}`);
  }
  lines.push(...formatPartialPatchDiagnostics('Failed details:', failedDiagnostics));
  lines.push(...formatPartialPatchDiagnostics('Skipped details:', skippedDiagnostics));
  if (recovery.mustReadFiles.length > 0) {
    lines.push(
      `Recovery: read failed/skipped files before retrying: ${recovery.mustReadFiles.join(', ')}.`,
    );
  }
  if (recovery.mustNotReadFiles.length > 0) {
    lines.push(
      `Do not reread applied files unless a specific dependency requires it: ${recovery.mustNotReadFiles.join(', ')}.`,
    );
  }
  return lines.join('\n');
}

function buildPatchCommitRows(
  rows: PatchPreviewRow[],
  failure:
    | {
        row: PatchPreviewRow | undefined;
        appliedRows: PatchPreviewRow[];
        notRunRows: PatchPreviewRow[];
      }
    | undefined,
): PatchPreviewRow[] {
  if (!failure) {
    return markRows(rows, 'applied');
  }

  const applied = new Set(failure.appliedRows.map((row) => patchRowKey(row)));
  const notRun = failure.notRunRows.map((row) => patchRowKey(row));
  const failingRowKey = failure.row ? patchRowKey(failure.row) : notRun[0];

  return rows.map((row) => {
    const key = patchRowKey(row);
    if (applied.has(key)) {
      return { ...row, state: 'applied' as const };
    }
    if (failingRowKey && key === failingRowKey) {
      return { ...row, state: 'failed' as const };
    }
    return { ...row, state: 'streamed' as const };
  });
}

function validateApplyPatchProfile(ops: PatchOperation[], profile: ApplyPatchProfile): void {
  if (profile !== 'codex-compatible') return;

  for (const op of ops) {
    if (op.kind !== 'update') continue;
    for (const chunk of op.chunks) {
      if (chunk.source === 'find-replace-once') {
        throw new Error(
          'FindReplaceOnce chunks are not allowed by the codex-compatible apply_patch profile. Use @@ hunk chunks instead.',
        );
      }
      if (chunk.source === 'find-replace-all') {
        throw new Error(
          'FindReplaceAll chunks are not allowed by the codex-compatible apply_patch profile. Use @@ hunk chunks instead.',
        );
      }
    }
  }
}

function validatePatchTextForProfile(patch: string, profile: ApplyPatchProfile): void {
  if (profile !== 'codex-compatible') return;

  for (const line of patch.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\*\*\*\s+FindReplaceOnce\b/.test(trimmed)) {
      throw new Error(
        'FindReplaceOnce chunks are not allowed by the codex-compatible apply_patch profile. Use @@ hunk chunks instead.',
      );
    }
    if (/^\*\*\*\s+FindReplaceAll\b/.test(trimmed)) {
      throw new Error(
        'FindReplaceAll chunks are not allowed by the codex-compatible apply_patch profile. Use @@ hunk chunks instead.',
      );
    }
  }
}

function sanitizePatchParseErrorForProfile(error: unknown, profile: ApplyPatchProfile): never {
  if (profile !== 'codex-compatible' || !(error instanceof Error)) {
    throw error;
  }

  const findReplaceExample = [
    'For a content edit, use a valid hunk such as:',
    '*** FindReplaceOnce:',
    '<<<<<<< SEARCH',
    '<old text>',
    '======= REPLACE',
    '<new text>',
    '>>>>>>> REPLACE',
  ].join('\n');
  const codexExample = [
    'For a content edit in the codex-compatible profile, use a valid @@ hunk such as:',
    '@@',
    '-<old text>',
    '+<new text>',
  ].join('\n');
  const message = error.message.replace(findReplaceExample, codexExample);
  const sanitized = new Error(message);
  sanitized.stack = error.stack;
  throw sanitized;
}

async function executePatch(
  patch: string,
  cwd: string,
  signal?: AbortSignal,
  onUpdate?: (result: {
    content: Array<{ type: 'text'; text: string }>;
    details?: unknown;
  }) => void,
  context?: { state?: unknown },
  profile: ApplyPatchProfile = 'extended',
) {
  validatePatchTextForProfile(patch, profile);
  const patchAutofixes = applyPatchTextAutofixes(patch);
  const effectivePatch = patchAutofixes.patchText;
  let diagnostics: ReturnType<typeof parsePatchWithDiagnostics>;
  try {
    diagnostics = parsePatchWithDiagnostics(effectivePatch);
  } catch (error) {
    sanitizePatchParseErrorForProfile(error, profile);
  }
  const { ops, mergedEnvelopes } = diagnostics;
  validateApplyPatchProfile(ops, profile);
  const files = ops.flatMap((op) => {
    if (op.kind === 'update' && op.moveTo) {
      return [resolveToCwd(op.path, cwd), resolveToCwd(op.moveTo, cwd)];
    }
    return [resolveToCwd(op.path, cwd)];
  });
  return withFilesMutationQueue(files, async () => {
    const existingSession = getExistingApplyPatchSession(context, cwd);
    const buildFreshPartialPlan = () =>
      buildPatchPlan(ops, createVirtualWorkspace(cwd), cwd, createRealWorkspace(), {
        mergedEnvelopes,
        mode: 'partial',
      });
    const renderPlanningError = (error: unknown) => {
      const failureRenderOptions = { allowFindReplaceSuggestions: profile !== 'codex-compatible' };
      if (error instanceof PatchContextMatchError) {
        const text = renderContextMatchFailure(error.failure, failureRenderOptions);
        return {
          isError: true,
          content: [{ type: 'text' as const, text }],
          details: {
            contextMatch: error.failure,
            execution: {
              mode: 'partialPerOperation' as const,
              ok: false,
              phase: 'plan' as const,
            },
          },
        };
      }
      if (error instanceof PatchPlanFailedError) {
        const text = renderPlanFailure(
          error.statuses,
          (p) => shortenDisplayPath(p, cwd),
          failureRenderOptions,
        );
        return {
          isError: true,
          content: [{ type: 'text' as const, text }],
          details: {
            planFailures: error.failures,
            planStatuses: error.statuses,
            execution: {
              mode: 'partialPerOperation' as const,
              ok: false,
              phase: 'plan' as const,
            },
          },
        };
      }
      throw error;
    };

    let finalized:
      | {
          plan: Awaited<ReturnType<typeof buildPatchPlan>>;
          reusedStage: boolean;
          rows: PatchPreviewRow[] | undefined;
        }
      | undefined;
    try {
      finalized = existingSession
        ? await existingSession.finalize(effectivePatch)
        : {
            plan: await buildFreshPartialPlan(),
            reusedStage: false,
            rows: undefined,
          };
    } catch (error) {
      if (
        existingSession &&
        (error instanceof PatchContextMatchError || error instanceof PatchPlanFailedError)
      ) {
        try {
          finalized = {
            plan: await buildFreshPartialPlan(),
            reusedStage: false,
            rows: undefined,
          };
        } catch (partialError) {
          return renderPlanningError(partialError);
        }
      } else {
        return renderPlanningError(error);
      }
    }
    if (!finalized) {
      throw new Error('Failed to finalize patch plan.');
    }
    const plan = finalized.plan;
    const commitRows = finalized.rows ?? plan.rows;

    onUpdate?.({
      content: [{ type: 'text', text: '' }],
      details: {
        operations: markRowsInProgress(commitRows),
      },
    });

    const commit = await commitMutationPlan(plan, createRealWorkspace(), {
      rollbackOnFailure: true,
      includeDiff: true,
      signal,
    });
    const operationRows = plan.patch?.partial
      ? applyPartialPlanRows(commitRows, plan.patch)
      : buildPatchCommitRows(commitRows, commit.failure);

    onUpdate?.({
      content: [{ type: 'text', text: '' }],
      details: {
        operations: operationRows,
      },
    });

    if (!commit.ok) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: commit.failure?.error ?? 'Patch failed.',
          },
        ],
        details: {
          operations: operationRows,
          execution: {
            ...commit,
            reusedStage: finalized.reusedStage,
            mode: plan.patch?.partial
              ? ('partialPerOperation' as const)
              : ('logicalAtomicPerFile' as const),
            partial: plan.patch?.partial ?? false,
            plannerFailedRows: plan.patch?.failedRows ?? [],
            plannerSkippedRows: plan.patch?.skippedRows ?? [],
          },
        },
      };
    }

    const baseText = plan.patch?.partial
      ? formatPartialPatchSummary(commitRows.length, plan.patch)
      : (commit.summaryText ?? `Applied patch with ${commit.rows.length} operation(s).`);
    const text =
      patchAutofixes.unifiedDiffHunkHeaders > 0
        ? [
            baseText,
            `Note: auto-fixed ${patchAutofixes.unifiedDiffHunkHeaders} numbered unified-diff hunk header${patchAutofixes.unifiedDiffHunkHeaders === 1 ? '' : 's'} by replacing it with apply_patch '@@' marker syntax.`,
          ].join('\n')
        : baseText;

    return {
      content: [
        {
          type: 'text' as const,
          text,
        },
      ],
      details: {
        diff: commit.diff,
        firstChangedLine: commit.firstChangedLine,
        operations: operationRows,
        execution: {
          ...commit,
          reusedStage: finalized.reusedStage,
          mode: plan.patch?.partial
            ? ('partialPerOperation' as const)
            : ('logicalAtomicPerFile' as const),
          partial: plan.patch?.partial ?? false,
          appliedRows: plan.patch?.appliedRows ?? operationRows,
          failedRows: plan.patch?.failedRows ?? [],
          skippedRows: plan.patch?.skippedRows ?? [],
          failedDiagnostics: buildPartialPatchDiagnostics(plan.patch, 'failed'),
          skippedDiagnostics: buildPartialPatchDiagnostics(plan.patch, 'skipped'),
          recoveryInstructions: plan.patch?.recoveryInstructions,
        },
      },
    };
  });
}

function getPatchTextFromArgs(args: unknown): string | undefined {
  if (typeof args === 'string') {
    return args;
  }
  if (!args || typeof args !== 'object') {
    return undefined;
  }
  const patch = (args as { patch?: unknown }).patch;
  return typeof patch === 'string' ? patch : undefined;
}

function getStreamingRowsFromPatch(patchText: string | undefined): PatchPreviewRow[] | undefined {
  if (!patchText) {
    return undefined;
  }
  try {
    return parsePatchStreaming(patchText).operations;
  } catch {
    return undefined;
  }
}

function getApplyPatchPreviewRows(args: unknown): PatchPreviewRow[] | undefined {
  return getStreamingRowsFromPatch(getPatchTextFromArgs(args));
}

function getApplyPatchSession(context: { state?: unknown } | undefined, cwd: string) {
  if (!context?.state || typeof context.state !== 'object') {
    return createPatchSession(cwd, createVirtualWorkspace(cwd));
  }

  const state = context.state as {
    applyPatchSession?: ReturnType<typeof createPatchSession>;
    applyPatchSessionCwd?: string;
  };
  if (!state.applyPatchSession || state.applyPatchSessionCwd !== cwd) {
    state.applyPatchSession = createPatchSession(cwd, createVirtualWorkspace(cwd));
    state.applyPatchSessionCwd = cwd;
  }
  return state.applyPatchSession;
}

function getExistingApplyPatchSession(context: { state?: unknown } | undefined, cwd: string) {
  if (!context?.state || typeof context.state !== 'object') {
    return undefined;
  }

  const state = context.state as {
    applyPatchSession?: ReturnType<typeof createPatchSession>;
    applyPatchSessionCwd?: string;
  };
  return state.applyPatchSessionCwd === cwd ? state.applyPatchSession : undefined;
}

interface ApplyPatchPreviewState {
  applyPatchPreviewText?: string;
  applyPatchVisibleRows?: PatchPreviewRow[];
}

function getApplyPatchPreviewState(
  context: { state?: unknown } | undefined,
): ApplyPatchPreviewState | undefined {
  if (!context?.state || typeof context.state !== 'object') {
    return undefined;
  }

  return context.state as ApplyPatchPreviewState;
}

function isApplyPatchPrefixRegression(
  nextRows: PatchPreviewRow[] | undefined,
  previousRows: PatchPreviewRow[] | undefined,
): boolean {
  if (!previousRows || previousRows.length === 0) {
    return false;
  }
  if (!nextRows || nextRows.length === 0) {
    return true;
  }
  if (nextRows.length >= previousRows.length) {
    return false;
  }

  return nextRows.every((row, index) => patchRowKey(row) === patchRowKey(previousRows[index]!));
}

function stabilizeApplyPatchPreviewRows(
  patchText: string,
  nextRows: PatchPreviewRow[] | undefined,
  context: { state?: unknown; argsComplete?: boolean } | undefined,
): PatchPreviewRow[] | undefined {
  const state = getApplyPatchPreviewState(context);
  if (!state) {
    return nextRows;
  }

  const appendOnly =
    context?.argsComplete !== true &&
    typeof state.applyPatchPreviewText === 'string' &&
    patchText.startsWith(state.applyPatchPreviewText);
  const visibleRows =
    appendOnly && isApplyPatchPrefixRegression(nextRows, state.applyPatchVisibleRows)
      ? state.applyPatchVisibleRows
      : nextRows;

  state.applyPatchPreviewText = patchText;
  state.applyPatchVisibleRows = visibleRows;
  return visibleRows;
}

function getApplyPatchSessionRows(
  args: unknown,
  context: { state?: unknown; cwd?: string; argsComplete?: boolean } | undefined,
): PatchPreviewRow[] | undefined {
  logDeltaArrival(context, getPatchTextFromArgs(args));
  const patchText = getPatchTextFromArgs(args);
  if (!patchText) {
    return undefined;
  }

  const cwd = context?.cwd ?? '/';
  let rows: PatchPreviewRow[] | undefined;
  try {
    rows = getApplyPatchSession(context, cwd).update(patchText).rows;
  } catch {
    rows = undefined;
  }

  const visibleRows = stabilizeApplyPatchPreviewRows(patchText, rows, context);
  cacheApplyPatchRows(context, visibleRows);
  return visibleRows;
}

/**
 * Diagnostic: when PI_APPLY_PATCH_DELTA_LOG is set, append a JSONL record
 * each time renderCall is invoked. The first invocation (even with no
 * patch content yet) is tagged kind="header_visible" so we can measure
 * the silent period between the apply_patch label appearing and the
 * first content byte arriving. Subsequent invocations where the patch
 * has grown are tagged kind="content". Unchanged-patch invocations
 * are dropped so the file doesn't bloat from redraws.
 *
 * Enable: PI_APPLY_PATCH_DELTA_LOG=/tmp/apply-patch-deltas.jsonl pi
 */
function logDeltaArrival(
  context: { state?: unknown } | undefined,
  patchText: string | undefined,
): void {
  const logPath = process.env['PI_APPLY_PATCH_DELTA_LOG'];
  if (!logPath) return;
  if (!context?.state || typeof context.state !== 'object') return;

  const diag = context.state as {
    applyPatchDeltaLog?: {
      lastLen: number;
      firstAt: number;
      lastAt: number;
      eventIdx: number;
      headerLogged: boolean;
    };
  };
  const now = Date.now();
  const len = patchText?.length ?? 0;
  if (!diag.applyPatchDeltaLog) {
    diag.applyPatchDeltaLog = {
      lastLen: 0,
      firstAt: now,
      lastAt: now,
      eventIdx: 0,
      headerLogged: false,
    };
  }
  const entry = diag.applyPatchDeltaLog;

  // Classify this invocation:
  // - First-ever invocation → "header_visible" (stamps t=0).
  // - len > lastLen → "content" (new bytes landed).
  // - len === lastLen → skip (would be a no-op redraw).
  let kind: 'header_visible' | 'content';
  if (!entry.headerLogged) {
    kind = 'header_visible';
    entry.headerLogged = true;
    // Reset firstAt so the header-visible moment is t=0.
    entry.firstAt = now;
  } else if (len > entry.lastLen) {
    kind = 'content';
  } else {
    return; // unchanged, skip
  }

  const sincePrev = now - entry.lastAt;
  const sinceFirst = now - entry.firstAt;
  const newBytes = Math.max(0, len - entry.lastLen);
  const record = {
    event: entry.eventIdx,
    kind,
    total_bytes: len,
    delta_bytes: newBytes,
    ms_since_prev: sincePrev,
    ms_since_first: sinceFirst,
    last_chunk_tail: (patchText ?? '').slice(-40).replace(/\n/g, '⏎'),
  };
  entry.lastLen = len;
  entry.lastAt = now;
  entry.eventIdx += 1;
  try {
    // Lazy import to keep the hot path clean in the zero-envvar case.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, unicorn/prefer-module
    const fs = require('node:fs') as typeof import('node:fs');
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  } catch {
    // ignore logging failures
  }
}

function getResultOperationRows(result: unknown): PatchPreviewRow[] | undefined {
  if (!result || typeof result !== 'object') {
    return undefined;
  }
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== 'object') {
    return undefined;
  }
  const operations = (details as { operations?: unknown }).operations;
  return Array.isArray(operations) ? (operations as PatchPreviewRow[]) : undefined;
}

function toApplyingRows(rows: PatchPreviewRow[] | undefined): PatchPreviewRow[] | undefined {
  if (!rows) {
    return undefined;
  }
  return rows.map((row) =>
    row.state === 'streaming' || row.state === 'streamed' || row.state === 'staged'
      ? { ...row, state: 'committing' as const }
      : row,
  );
}

function toFailedRows(rows: PatchPreviewRow[] | undefined): PatchPreviewRow[] | undefined {
  if (!rows) {
    return undefined;
  }
  return rows.map((row) => (row.state === 'applied' ? row : { ...row, state: 'failed' as const }));
}

function getCachedApplyPatchRows(
  context: { state?: unknown } | undefined,
): PatchPreviewRow[] | undefined {
  const cached = (context?.state as { applyPatchRows?: unknown } | undefined)?.applyPatchRows;
  return Array.isArray(cached) ? (cached as PatchPreviewRow[]) : undefined;
}

function cacheApplyPatchRows(
  context: { state?: unknown } | undefined,
  rows: PatchPreviewRow[] | undefined,
) {
  if (!rows || !context?.state || typeof context.state !== 'object') {
    return rows;
  }
  (context.state as { applyPatchRows?: PatchPreviewRow[] }).applyPatchRows = rows;
  return rows;
}

function getApplyPatchOperationCount(args: unknown): number | undefined {
  const rows = getApplyPatchPreviewRows(args);
  return rows && rows.length > 0 ? rows.length : undefined;
}

function renderApplyPatchHeader(
  count: number | undefined,
  theme: {
    fg(color: string, text: string): string;
    bold(text: string): string;
  },
  spinnerFrame?: string,
): Text {
  const prefix = spinnerFrame ? `${theme.fg('muted', spinnerFrame)} ` : '';
  const title = `${prefix}${theme.fg('toolTitle', theme.bold('apply_patch'))}`;
  if (!count) {
    return new Text(title, 0, 0);
  }

  return new Text(
    `${title}  ${theme.fg('muted', `${count} operation${count === 1 ? '' : 's'}`)}`,
    0,
    0,
  );
}

// Same braille spinner frames and cadence as the pi-tui Loader
// component (@earendil-works/pi-tui/components/loader). Using the
// canonical pi indicator keeps apply_patch visually consistent with
// other tool loaders (bash-execution, thinking loader, retry loader).
const PLACEHOLDER_PULSE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const PLACEHOLDER_FRAME_MS = 80;

interface PlaceholderPulseState {
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

function tickPlaceholderSpinnerFrame(context?: {
  state?: unknown;
  invalidate?: () => void;
}): string {
  // Called once per render while the apply_patch header is visible but
  // the streaming parser has no rows yet. On Anthropic this window can
  // be 10-30s long because the provider generates the full tool_use
  // content before emitting any SSE deltas. Returning the next braille
  // frame (and scheduling a self-redraw) keeps the header visibly
  // alive without adding a second status line.
  const state = getPlaceholderPulseState(context);
  if (!state) return '⠋';

  const now = Date.now();
  const elapsed = now - state.startedAt;
  const period = PLACEHOLDER_FRAME_MS;
  const frameIdx = Math.floor(elapsed / period) % PLACEHOLDER_PULSE_FRAMES.length;
  const frame = PLACEHOLDER_PULSE_FRAMES[frameIdx] ?? '⠋';

  // Schedule a self-redraw at the next frame boundary.
  if (state.timer) clearTimeout(state.timer);
  const msToNext = period - (elapsed % period);
  state.timer = setTimeout(() => {
    state.timer = undefined;
    context?.invalidate?.();
  }, msToNext);

  return frame;
}

function getPlaceholderPulseState(
  context: { state?: unknown } | undefined,
): PlaceholderPulseState | undefined {
  if (!context?.state || typeof context.state !== 'object') return undefined;
  const slot = context.state as { applyPatchPulse?: PlaceholderPulseState };
  if (!slot.applyPatchPulse) {
    slot.applyPatchPulse = { startedAt: Date.now() };
  }
  return slot.applyPatchPulse;
}

function clearPlaceholderPulse(context: { state?: unknown } | undefined): void {
  if (!context?.state || typeof context.state !== 'object') return;
  const slot = context.state as { applyPatchPulse?: PlaceholderPulseState };
  if (slot.applyPatchPulse?.timer) {
    clearTimeout(slot.applyPatchPulse.timer);
    slot.applyPatchPulse.timer = undefined;
  }
  // Drop the whole slot so a fresh apply_patch call starts a new pulse.
  slot.applyPatchPulse = undefined;
}

function renderApplyPatchPreview(
  args: unknown,
  theme: {
    fg(color: string, text: string): string;
    bold(text: string): string;
  },
  context?: {
    argsComplete?: boolean;
    isPartial?: boolean;
    state?: unknown;
    cwd?: string;
  },
) {
  const isStreaming = context?.isPartial === true && context?.argsComplete !== true;
  const rows = isStreaming ? getApplyPatchSessionRows(args, context) : undefined;
  const count = rows?.length ?? getApplyPatchOperationCount(args);

  if (!rows || rows.length === 0) {
    if (!isStreaming) {
      clearPlaceholderPulse(context);
      return renderApplyPatchHeader(count, theme);
    }
    // Streaming window before the parser recognizes anything. Prefix
    // the header with a muted braille spinner so the label visibly
    // ticks instead of appearing frozen, and drop it the moment any
    // row materializes (handled by the branch below).
    const spinner = tickPlaceholderSpinnerFrame(context);
    return renderApplyPatchHeader(count, theme, spinner);
  }

  // Rows are visible — no more pulse needed.
  clearPlaceholderPulse(context);
  const container = new Container();
  container.addChild(renderApplyPatchHeader(rows.length, theme));
  container.addChild(renderApplyPatchRows(rows, theme, context?.cwd));
  return container;
}

function getApplyPatchPartialRows(
  result: unknown,
  args: unknown,
  executionStarted: boolean,
  context?: { state?: unknown; cwd?: string },
): PatchPreviewRow[] | undefined {
  const previewRows = getApplyPatchSessionRows(args, context);
  const resultRows = getResultOperationRows(result);
  return resultRows ?? (executionStarted ? toApplyingRows(previewRows) : previewRows);
}

function getApplyPatchFailedRows(
  result: unknown,
  context?: { args?: unknown; state?: unknown },
): PatchPreviewRow[] | undefined {
  const rows = getResultOperationRows(result);
  const cachedRows = getCachedApplyPatchRows(context as any);
  return (
    (rows?.some((row) => row.state === 'failed') ? rows : undefined) ??
    (cachedRows?.some((row) => row.state === 'failed') ? cachedRows : undefined) ??
    toFailedRows(rows) ??
    toFailedRows(cachedRows) ??
    toFailedRows(getApplyPatchPreviewRows(context?.args))
  );
}

function renderApplyPatchCall(
  args: unknown,
  theme: {
    fg(color: string, text: string): string;
    bold(text: string): string;
  },
  context?: {
    executionStarted?: boolean;
    argsComplete?: boolean;
    isPartial?: boolean;
    state?: unknown;
    cwd?: string;
  },
) {
  return renderApplyPatchPreview(args, theme, context);
}

function getBashRewriteToParams(result: unknown): unknown {
  const details = (result as { details?: unknown } | undefined)?.details;
  return details && typeof details === 'object'
    ? (details as { rewriteToParams?: unknown }).rewriteToParams
    : undefined;
}

function withApplyPatchRenderArgs(result: unknown, context: unknown) {
  const rewriteArgs = getBashRewriteToParams(result);
  if (!rewriteArgs || typeof rewriteArgs !== 'object' || Array.isArray(rewriteArgs)) {
    return context;
  }
  return { ...(context as Record<string, unknown> | undefined), args: rewriteArgs };
}

function renderApplyPatchResult(
  result: unknown,
  options: ToolRenderResultOptions,
  theme: {
    fg(color: string, text: string): string;
    bold(text: string): string;
  },
  context: any,
) {
  const renderContext = withApplyPatchRenderArgs(result, context) as any;

  if (options.isPartial) {
    const displayRows = cacheApplyPatchRows(
      renderContext,
      getApplyPatchPartialRows(
        result,
        renderContext?.args,
        renderContext?.executionStarted === true,
        renderContext,
      ),
    );
    if (displayRows && displayRows.length > 0) {
      return renderApplyPatchRows(displayRows, theme, renderContext?.cwd);
    }
    return new Text(theme.fg('warning', 'patching...'), 0, 0);
  }

  const fallbackText = extractTextOutput(result as { content?: unknown });
  const rows = getResultOperationRows(result);
  if (isToolError(result, renderContext)) {
    const failedRows = getApplyPatchFailedRows(result, renderContext);
    if (failedRows && failedRows.length > 0) {
      return renderApplyPatchRows(failedRows, theme, renderContext?.cwd);
    }
    const error = fallbackText || 'Patch failed.';
    return new Text(theme.fg('error', error), 0, 0);
  }

  cacheApplyPatchRows(renderContext, rows);

  if (!options.expanded && rows && rows.length > 0) {
    return renderApplyPatchRows(rows, theme, renderContext?.cwd);
  }

  if (options.expanded && rows && rows.length > 0 && rows.every((row) => row.kind === 'delete')) {
    return renderApplyPatchRows(rows, theme, renderContext?.cwd);
  }

  if (options.expanded && rows && rows.some((row) => row.kind === 'delete')) {
    const deleteRows = rows.filter((row) => row.kind === 'delete');
    if (deleteRows.length === rows.length) {
      return renderApplyPatchRows(deleteRows, theme, renderContext?.cwd);
    }

    const details = materializeLazyDiffDetails(
      (result as { details?: unknown }).details as LazyDiffDetails | undefined,
      options.expanded,
    );
    const container = new Container();
    container.addChild(
      renderEditDiffResult(
        details,
        { expanded: options.expanded, filePath: undefined },
        DEFAULT_TOOL_DISPLAY_CONFIG,
        theme,
        fallbackText,
      ),
    );
    container.addChild(new Spacer(1));
    container.addChild(renderApplyPatchRows(deleteRows, theme, renderContext?.cwd));
    return container;
  }

  const details = materializeLazyDiffDetails(
    (result as { details?: unknown }).details as LazyDiffDetails | undefined,
    options.expanded,
  );
  return renderEditDiffResult(
    details,
    { expanded: options.expanded, filePath: undefined },
    DEFAULT_TOOL_DISPLAY_CONFIG,
    theme,
    fallbackText,
  );
}

function renderBashApplyPatchHeader(
  count: number | undefined,
  theme: {
    fg(color: string, text: string): string;
    bold(text: string): string;
  },
  spinnerFrame?: string,
): Text {
  const prefix = spinnerFrame ? `${theme.fg('muted', spinnerFrame)} ` : '';
  const label = `${prefix}${theme.fg('dim', `bash${TOOL_REWRITE_ARROW}`)}${theme.fg('toolTitle', theme.bold('apply_patch'))}`;
  if (!count) return new Text(label, 0, 0);
  return new Text(
    `${label} ${theme.fg('muted', `${count} operation${count === 1 ? '' : 's'}`)}`,
    0,
    0,
  );
}

function renderBashApplyPatchSummary(
  rows: PatchPreviewRow[] | undefined,
  count: number | undefined,
  theme: {
    fg(color: string, text: string): string;
    bold(text: string): string;
  },
  cwd?: string,
) {
  const container = new Container();
  container.addChild(renderBashApplyPatchHeader(rows?.length ?? count, theme));
  if (rows && rows.length > 0) {
    container.addChild(renderApplyPatchRows(rows, theme, cwd));
  }
  return container;
}

function renderBashApplyPatchPreview(
  args: unknown,
  theme: {
    fg(color: string, text: string): string;
    bold(text: string): string;
  },
  context?: {
    argsComplete?: boolean;
    isPartial?: boolean;
    state?: unknown;
    cwd?: string;
    invalidate?: () => void;
  },
) {
  const isStreaming = context?.isPartial === true && context?.argsComplete !== true;
  const rows = isStreaming ? getApplyPatchSessionRows(args, context) : undefined;
  const count = rows?.length ?? getApplyPatchOperationCount(args);

  if (!rows || rows.length === 0) {
    if (!isStreaming) {
      clearPlaceholderPulse(context);
      return renderBashApplyPatchHeader(count, theme);
    }
    const spinner = tickPlaceholderSpinnerFrame(context);
    return renderBashApplyPatchHeader(count, theme, spinner);
  }

  clearPlaceholderPulse(context);
  return renderBashApplyPatchSummary(rows, rows.length, theme, context?.cwd);
}

function renderBashApplyPatchResult(
  result: unknown,
  options: ToolRenderResultOptions,
  theme: {
    fg(color: string, text: string): string;
    bold(text: string): string;
  },
  context: any,
) {
  const renderContext = withApplyPatchRenderArgs(result, context) as any;
  return renderApplyPatchResult(result, options, theme, renderContext);
}

async function executeClassic(edits: ClassicEditItem[], cwd: string, signal?: AbortSignal) {
  const orderedFiles = [...new Set(edits.map((edit) => resolveToCwd(edit.path, cwd)))];

  return withFilesMutationQueue(orderedFiles, async () => {
    const workspace = createRealWorkspace();
    const plan = await buildClassicEditPlan(edits, workspace, cwd, signal);
    const commit = await commitMutationPlan(plan, workspace, {
      rollbackOnFailure: true,
      includeDiff: true,
      signal,
    });

    if (commit.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            text: plan.summaryText ?? `Applied ${commit.rows.length} edit(s).`,
          },
        ],
        details: {
          diff: commit.diff,
          firstChangedLine: commit.firstChangedLine,
          execution: {
            ...commit,
            mode: 'logicalAtomicPerFile' as const,
          },
        },
      };
    }

    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: commit.failure?.error ?? 'Edit failed.',
        },
      ],
      details: {
        execution: {
          ...commit,
          mode: 'logicalAtomicPerFile' as const,
        },
      },
    };
  });
}

async function buildClassicEditPlan(
  edits: ClassicEditItem[],
  workspace: Workspace,
  cwd: string,
  signal?: AbortSignal,
): Promise<MutationPlan<ClassicEditResult>> {
  const orderedFiles: string[] = [];
  const fileGroups = new Map<string, { displayPath: string; edits: ClassicEditItem[] }>();
  for (const edit of edits) {
    const absolutePath = resolveToCwd(edit.path, cwd);
    if (!fileGroups.has(absolutePath)) {
      fileGroups.set(absolutePath, { displayPath: edit.path, edits: [] });
      orderedFiles.push(absolutePath);
    }
    fileGroups.get(absolutePath)!.edits.push(edit);
  }

  const rows: ClassicEditResult[] = [];
  const sourceVersions = [];
  const mutations: MutationPlan<ClassicEditResult>['mutations'] = [];

  for (const absolutePath of orderedFiles) {
    if (signal?.aborted) {
      throw new Error('Operation aborted');
    }

    const group = fileGroups.get(absolutePath)!;
    if (!(await workspace.exists(absolutePath))) {
      throw new Error(`File not found: ${group.displayPath}`);
    }

    await workspace.checkWriteAccess(absolutePath);
    const rawContent = await workspace.readText(absolutePath);
    const snapshotStat = await workspace.stat(absolutePath);
    const { bom, text } = stripBom(rawContent);
    const ending = detectLineEnding(text);
    const normalized = normalizeToLF(text);
    const applied = applyClassicEditsToText(normalized, group.edits);
    const finalContent = bom + restoreLineEndings(applied.content, ending);
    const version = buildFileVersionTokenFromTextSnapshot(
      absolutePath,
      rawContent,
      snapshotStat.mtimeMs,
    );
    sourceVersions.push(version);

    const rowStart = rows.length;
    rows.push(...applied.results);
    mutations.push({
      kind: 'write',
      absolutePath,
      displayPath: group.displayPath,
      before: {
        absolutePath,
        displayPath: group.displayPath,
        version,
        text: rawContent,
      },
      afterText: finalContent,
      contributingRows: applied.results.map((_, index) => ({
        id: `classic-${String(rowStart + index + 1).padStart(4, '0')}`,
        rowIndex: rowStart + index,
      })),
    });
  }

  return {
    rows,
    mutations,
    sourceVersions,
    summaryText: formatClassicResults(rows),
  };
}

export default function multiEditExtension(pi: ExtensionAPI) {
  const unregisterBashRewriteProvider =
    pi.events?.on?.('bash-rewrite:collect-providers', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const register = (payload as { register?: unknown }).register;
      if (typeof register !== 'function') return;

      register({
        id: 'multi-edit.apply-patch',
        priority: 200,
        tools: ['apply_patch'],
        fallbackOnExecuteError: false,
        async execute(
          decision: { params: { patch?: unknown } },
          runtime: {
            signal?: AbortSignal;
            onUpdate?: unknown;
            ctx: { cwd: string; model?: { provider?: string; id?: string } };
          },
        ) {
          if (typeof decision.params.patch !== 'string') {
            throw new Error('apply_patch bash rewrite requires a string patch payload.');
          }
          return executePatch(
            decision.params.patch,
            runtime.ctx.cwd,
            runtime.signal,
            runtime.onUpdate as any,
            runtime.ctx as any,
            getToolProfileForModel(runtime.ctx.model),
          );
        },
        renderPreview(decision: { params: { patch?: unknown } }, theme: any, runtime: any) {
          return renderBashApplyPatchPreview(decision.params, theme, runtime);
        },
        renderResult(result: unknown, options: ToolRenderResultOptions, theme: any, context: any) {
          return renderBashApplyPatchResult(result, options, theme, context);
        },
      });
    }) ?? (() => {});

  pi.on?.('session_shutdown', async () => {
    unregisterBashRewriteProvider();
  });

  pi.on?.('session_start', async (_event, ctx) => {
    applyModelToolPolicy(pi, ctx.model);
  });

  pi.on?.('before_agent_start', async (event, ctx) => {
    const disabledTools = applyModelToolPolicy(pi, ctx.model);
    const profile = getToolProfileForModel(ctx.model);
    return {
      systemPrompt: `${event.systemPrompt}\n\n${buildApplyPatchPromptAppend(disabledTools, profile)}`,
    };
  });

  pi.on?.('tool_call', async (event, ctx) => {
    const profile = getToolProfileForModel(ctx.model);
    if (isToolAllowedForProfile(event.toolName, profile)) {
      return undefined;
    }

    const identity = getModelIdentity(ctx.model) || 'unknown-model';
    return {
      block: true,
      reason: `Tool '${event.toolName}' is disabled for profile '${profile}' on model '${identity}'; use apply_patch instead.`,
    };
  });

  pi.registerTool({
    name: 'edit',
    label: 'edit',
    description:
      'Edit files using cursor-based exact text replacement. Use { path, edits[] } as the primary API. Legacy single-edit, multi-edit, and patch compatibility inputs are still accepted.',
    promptSnippet: 'Make classic text edits with { path, edits[] }.',
    promptGuidelines: [
      'Use edit with { path, edits[] } as the primary classic edit API.',
      'edit applies classic edits sequentially with cursor semantics in file order.',
      'Use apply_patch for Codex-style patch payloads, file creation/deletion, or renames.',
      'edit rejects empty oldText values.',
    ],
    parameters: multiEditSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const normalized = normalizeClassicParams(params);
      if (normalized.mode === 'patch') {
        return executePatch(
          normalized.patch,
          ctx.cwd,
          signal,
          _onUpdate as any,
          ctx as any,
          getToolProfileForModel(ctx.model),
        );
      }

      return executeClassic(normalized.edits, ctx.cwd, signal);
    },
    renderCall(args, theme, context) {
      const path = shortenDisplayPath(getToolPathArg(args), context?.cwd);
      const lineCount = getEditLineCount(args);
      return new Text(
        `${theme.fg('toolTitle', theme.bold('edit'))} ${theme.fg('accent', path || '...')}${formatLineCountSuffix(lineCount, theme)}`,
        0,
        0,
      );
    },
    renderResult(result, options: ToolRenderResultOptions, theme, context) {
      const lineCount = getEditLineCount(context?.args);
      if (options.isPartial) {
        return new Text(formatInProgressLineCount('editing', lineCount, theme), 0, 0);
      }

      const fallbackText = extractTextOutput(result as { content?: unknown });
      if (isToolError(result, context)) {
        const error = fallbackText || 'Edit failed.';
        return new Text(theme.fg('error', error), 0, 0);
      }

      const details = materializeLazyDiffDetails(
        result.details as LazyDiffDetails | undefined,
        options.expanded,
      );
      return renderEditDiffResult(
        details,
        { expanded: options.expanded, filePath: getToolPathArg(context?.args) },
        DEFAULT_TOOL_DISPLAY_CONFIG,
        theme,
        fallbackText,
      );
    },
  });

  pi.registerTool({
    name: 'apply_patch',
    label: 'apply_patch',
    description:
      'Apply a patch payload using the syntax advertised by the active multi-edit profile.',
    promptSnippet: 'Apply patch payloads with { patch }.',
    promptGuidelines: [
      'Follow the active multi-edit profile syntax from the session prompt.',
      'The patch value must be raw patch text only: no Markdown fences, no prose, no commentary.',
    ],
    parameters: applyPatchSchema,
    prepareArguments: prepareApplyPatchArguments,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return executePatch(
        params.patch,
        ctx.cwd,
        signal,
        onUpdate as any,
        ctx as any,
        getToolProfileForModel(ctx.model),
      );
    },
    renderCall(args, theme, context) {
      return renderApplyPatchCall(args, theme, context as any);
    },
    renderResult(result, options: ToolRenderResultOptions, theme, context) {
      return renderApplyPatchResult(result, options, theme, context);
    },
  });
}
