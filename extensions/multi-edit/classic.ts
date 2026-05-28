import { structuredPatch, type StructuredPatchHunk } from 'diff';

export interface ClassicEditItem {
  path: string;
  oldText: string;
  newText: string;
}

export interface ClassicEditResult {
  path: string;
  success: boolean;
  skipped?: boolean;
  message: string;
  diff?: string;
  firstChangedLine?: number;
}

type NormalizedParams =
  | { mode: 'patch'; patch: string }
  | { mode: 'classic'; edits: ClassicEditItem[] };

export function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlfIdx = content.indexOf('\r\n');
  const lfIdx = content.indexOf('\n');
  if (lfIdx === -1) return '\n';
  if (crlfIdx === -1) return '\n';
  return crlfIdx < lfIdx ? '\r\n' : '\n';
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function restoreLineEndings(text: string, ending: '\r\n' | '\n'): string {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith('\uFEFF')
    ? { bom: '\uFEFF', text: content.slice(1) }
    : { bom: '', text: content };
}

export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize('NFKC')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
      // Strip zero-width characters and mid-file BOMs — invisible
      // glyphs that agents routinely paste from web sources but
      // which render identically to no character at all.
      // Using a Unicode-flagged regex with `\u{...}` escapes removes
      // the character-class joined-glyph warning; each code point is
      // still stripped individually.
      .replace(/\u{200B}|\u{200C}|\u{200D}|\u{FEFF}/gu, '')
  );
}

function formatHunkRange(start: number, lines: number): string {
  return lines === 1 ? `${start}` : `${start},${lines}`;
}

function formatStructuredHunk(hunk: StructuredPatchHunk): string[] {
  return [
    `@@ -${formatHunkRange(hunk.oldStart, hunk.oldLines)} +${formatHunkRange(
      hunk.newStart,
      hunk.newLines,
    )} @@`,
    ...hunk.lines,
  ];
}

function findFirstChangedLineFromHunks(hunks: StructuredPatchHunk[]): number | undefined {
  for (const hunk of hunks) {
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        return newLine;
      }
      if (line.startsWith('-')) {
        return newLine;
      }
      if (line.startsWith(' ')) {
        newLine += 1;
      }
    }
  }
  return undefined;
}

export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const patch = structuredPatch('', '', oldContent, newContent, undefined, undefined, {
    context: contextLines,
  });
  if (patch.hunks.length === 0) {
    return { diff: '', firstChangedLine: undefined };
  }

  return {
    diff: patch.hunks.flatMap(formatStructuredHunk).join('\n'),
    firstChangedLine: findFirstChangedLineFromHunks(patch.hunks),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPatchPayloadString(value: string): boolean {
  return value.trimStart().startsWith('*** Begin Patch');
}

function tryParseJsonArray(value: unknown): unknown {
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

function firstAliasValue(input: Record<string, unknown>, aliases: readonly string[]): unknown {
  for (const alias of aliases) {
    const value = input[alias];
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

function repairClassicEditObject(input: Record<string, unknown>): Record<string, unknown> {
  const repaired = { ...input };
  for (const [key, value] of Object.entries(repaired)) {
    if (value === null || value === undefined) {
      delete repaired[key];
    }
  }

  copyAlias(repaired, input, 'path', [
    'filePath',
    'absolutePath',
    'file_path',
    'filepath',
    'pathname',
    'target_file',
    'targetFile',
  ]);
  copyAlias(repaired, input, 'oldText', [
    'oldValue',
    'old_string',
    'oldString',
    'old',
    'old_str',
    'oldStr',
    'from',
    'search',
  ]);
  copyAlias(repaired, input, 'newText', [
    'newValue',
    'new_string',
    'newString',
    'new',
    'new_str',
    'newStr',
    'to',
    'replace',
  ]);

  return repaired;
}

function repairClassicParamsInput(input: unknown): unknown {
  if (typeof input === 'string' && isPatchPayloadString(input)) {
    return { patch: input };
  }

  if (!isObject(input) || Array.isArray(input)) {
    return input;
  }

  const repaired = repairClassicEditObject(input);
  repaired.edits = tryParseJsonArray(repaired.edits);
  repaired.multi = tryParseJsonArray(repaired.multi);

  if (Array.isArray(repaired.edits)) {
    repaired.edits = repaired.edits.map((item) =>
      isObject(item) && !Array.isArray(item) ? repairClassicEditObject(item) : item,
    );
  }

  if (Array.isArray(repaired.multi)) {
    repaired.multi = repaired.multi.map((item) =>
      isObject(item) && !Array.isArray(item) ? repairClassicEditObject(item) : item,
    );
  }

  return repaired;
}

export function normalizeClassicParams(rawInput: unknown): NormalizedParams {
  const repairedInput = repairClassicParamsInput(rawInput);
  if (!isObject(repairedInput)) {
    throw new Error('Invalid edit input.');
  }

  const params = repairedInput;

  if (typeof params.patch === 'string') {
    const hasOtherClassicFields =
      params.path !== undefined ||
      params.oldText !== undefined ||
      params.newText !== undefined ||
      params.multi !== undefined ||
      params.edits !== undefined;
    if (hasOtherClassicFields) {
      throw new Error(
        'The `patch` parameter is mutually exclusive with path/edits/oldText/newText/multi.',
      );
    }
    return { mode: 'patch', patch: params.patch };
  }

  const input = params;
  const topLevelPath = typeof input.path === 'string' ? input.path : undefined;
  const edits: ClassicEditItem[] = [];

  if (Array.isArray(input.edits)) {
    if (!topLevelPath) {
      throw new Error('Canonical edit input requires a top-level path when using edits[].');
    }
    for (const [index, item] of input.edits.entries()) {
      if (!isObject(item) || typeof item.oldText !== 'string' || typeof item.newText !== 'string') {
        throw new Error(`edits[${index}] must include string oldText and newText values.`);
      }
      edits.push({ path: topLevelPath, oldText: item.oldText, newText: item.newText });
    }
  }

  const hasTopLevelLegacy =
    typeof input.path === 'string' &&
    typeof input.oldText === 'string' &&
    typeof input.newText === 'string';
  if (hasTopLevelLegacy) {
    edits.push({
      path: input.path as string,
      oldText: input.oldText as string,
      newText: input.newText as string,
    });
  } else if (
    input.edits === undefined &&
    (input.path !== undefined || input.oldText !== undefined || input.newText !== undefined)
  ) {
    const hasOnlyPath =
      typeof input.path === 'string' && input.oldText === undefined && input.newText === undefined;
    if (!hasOnlyPath || !Array.isArray(input.multi)) {
      throw new Error(
        'Incomplete top-level edit: provide path, oldText, and newText together or use only path with multi.',
      );
    }
  }

  if (Array.isArray(input.multi)) {
    for (const [index, item] of input.multi.entries()) {
      if (!isObject(item) || typeof item.oldText !== 'string' || typeof item.newText !== 'string') {
        throw new Error(`multi[${index}] must include string oldText and newText values.`);
      }
      const itemPath = typeof item.path === 'string' ? item.path : topLevelPath;
      if (!itemPath) {
        throw new Error(
          `Edit ${index + 1} is missing a path. Provide a path on each multi item or set a top-level path to inherit.`,
        );
      }
      edits.push({ path: itemPath, oldText: item.oldText, newText: item.newText });
    }
  }

  if (edits.length === 0) {
    throw new Error('No edits provided. Supply path/edits, path/oldText/newText, multi, or patch.');
  }

  return { mode: 'classic', edits };
}

function fuzzyFindFrom(
  content: string,
  oldText: string,
  start: number,
): {
  index: number;
  matchLength: number;
  contentForReplacement: string;
  usedFuzzy: boolean;
} | null {
  const exactIndex = content.indexOf(oldText, start);
  if (exactIndex !== -1) {
    return {
      index: exactIndex,
      matchLength: oldText.length,
      contentForReplacement: content,
      usedFuzzy: false,
    };
  }

  const normalizedContent = normalizeForFuzzyMatch(content);
  const normalizedOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = normalizedContent.indexOf(normalizedOldText, start);
  if (fuzzyIndex === -1) {
    return null;
  }
  const duplicateIndex = normalizedContent.indexOf(normalizedOldText, fuzzyIndex + 1);
  if (duplicateIndex !== -1) {
    throw new Error('Fuzzy match is ambiguous. Please provide more context in oldText.');
  }
  return {
    index: fuzzyIndex,
    matchLength: normalizedOldText.length,
    contentForReplacement: normalizedContent,
    usedFuzzy: true,
  };
}

function findOriginalPosition(content: string, oldText: string): number {
  const exact = content.indexOf(oldText);
  if (exact !== -1) return exact;
  const normalizedContent = normalizeForFuzzyMatch(content);
  const normalizedOldText = normalizeForFuzzyMatch(oldText);
  const fuzzy = normalizedContent.indexOf(normalizedOldText);
  return fuzzy === -1 ? Number.MAX_SAFE_INTEGER : fuzzy;
}

export function applyClassicEditsToText(
  content: string,
  edits: ClassicEditItem[],
): { content: string; results: ClassicEditResult[] } {
  for (const edit of edits) {
    if (edit.oldText.length === 0) {
      throw new Error(`oldText must not be empty in ${edit.path}.`);
    }
  }

  const group = edits.map((edit, index) => ({ edit, index }));
  if (group.length > 1) {
    group.sort(
      (a, b) =>
        findOriginalPosition(content, a.edit.oldText) -
        findOriginalPosition(content, b.edit.oldText),
    );
  }

  let currentContent = content;
  let searchOffset = 0;
  const results: ClassicEditResult[] = Array.from({ length: edits.length }, () => ({
    path: '',
    success: false,
    message: '',
  }));
  const appliedPairs = new Set<string>();

  for (const { edit, index } of group) {
    let match = fuzzyFindFrom(currentContent, normalizeToLF(edit.oldText), searchOffset);
    if (!match) {
      const pairKey = `${edit.oldText}\0${edit.newText}`;
      if (appliedPairs.has(pairKey)) {
        results[index] = {
          path: edit.path,
          success: true,
          skipped: true,
          message: `Skipped redundant edit in ${edit.path} (already replaced all occurrences).`,
        };
        continue;
      }
      throw new Error(
        `Could not find the exact text in ${edit.path}. The old text must match exactly including all whitespace and newlines.`,
      );
    }

    if (match.usedFuzzy) {
      currentContent = match.contentForReplacement;
      match = fuzzyFindFrom(currentContent, normalizeToLF(edit.oldText), searchOffset);
      if (!match) {
        throw new Error(
          `Could not find the exact text in ${edit.path}. The old text must match exactly including all whitespace and newlines.`,
        );
      }
    }

    currentContent =
      currentContent.slice(0, match.index) +
      normalizeToLF(edit.newText) +
      currentContent.slice(match.index + match.matchLength);
    searchOffset = match.index + normalizeToLF(edit.newText).length;
    appliedPairs.add(`${edit.oldText}\0${edit.newText}`);
    results[index] = {
      path: edit.path,
      success: true,
      message: `Edited ${edit.path}.`,
    };
  }

  return { content: currentContent, results };
}
