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

export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  if (oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines[newLines.length - 1] === '') newLines.pop();

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }

  let oldSuffix = oldLines.length - 1;
  let newSuffix = newLines.length - 1;
  while (
    oldSuffix >= prefix &&
    newSuffix >= prefix &&
    oldLines[oldSuffix] === newLines[newSuffix]
  ) {
    oldSuffix--;
    newSuffix--;
  }

  const firstChangedLine =
    prefix + 1 <= Math.max(oldLines.length, newLines.length) ? prefix + 1 : undefined;
  const output: string[] = [];
  const maxLineNum = Math.max(oldLines.length, newLines.length, 1);
  const lineNumWidth = String(maxLineNum).length;

  const contextStart = Math.max(0, prefix - contextLines);
  const contextEndOld = Math.min(oldLines.length, oldSuffix + 1 + contextLines);
  const contextEndNew = Math.min(newLines.length, newSuffix + 1 + contextLines);

  for (let i = contextStart; i < prefix; i++) {
    output.push(` ${String(i + 1).padStart(lineNumWidth, ' ')} ${oldLines[i]}`);
  }

  if (contextStart > 0) {
    output.unshift(` ${''.padStart(lineNumWidth, ' ')} ...`);
  }

  for (let i = prefix; i <= oldSuffix; i++) {
    output.push(`-${String(i + 1).padStart(lineNumWidth, ' ')} ${oldLines[i]}`);
  }
  for (let i = prefix; i <= newSuffix; i++) {
    output.push(`+${String(i + 1).padStart(lineNumWidth, ' ')} ${newLines[i]}`);
  }

  const suffixCount = Math.min(
    contextLines,
    oldLines.length - (oldSuffix + 1),
    newLines.length - (newSuffix + 1),
  );
  for (let i = 0; i < suffixCount; i++) {
    const oldIndex = oldSuffix + 1 + i;
    output.push(` ${String(oldIndex + 1).padStart(lineNumWidth, ' ')} ${oldLines[oldIndex]}`);
  }

  if (contextEndOld < oldLines.length || contextEndNew < newLines.length) {
    output.push(` ${''.padStart(lineNumWidth, ' ')} ...`);
  }

  return { diff: output.join('\n'), firstChangedLine };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function normalizeClassicParams(input: unknown): NormalizedParams {
  if (!isObject(input)) {
    throw new Error('Invalid edit input.');
  }

  if (typeof input.patch === 'string') {
    const hasOtherClassicFields =
      input.path !== undefined ||
      input.oldText !== undefined ||
      input.newText !== undefined ||
      input.multi !== undefined ||
      input.edits !== undefined;
    if (hasOtherClassicFields) {
      throw new Error(
        'The `patch` parameter is mutually exclusive with path/edits/oldText/newText/multi.',
      );
    }
    return { mode: 'patch', patch: input.patch };
  }

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
