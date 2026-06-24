import { parseFastModeAction } from './commands/fast';
import { parseThinkingLevel } from './commands/thinking';
import type { DirectiveToken, EditorShortcutDirective, ParsedEditorShortcut } from './types';

function parseDirective(command: string, value: string): EditorShortcutDirective | null {
  const normalizedCommand = command.toLowerCase();

  if (normalizedCommand === 'model') {
    return { command: 'model', value };
  }

  if (normalizedCommand === 'thinking') {
    return parseThinkingLevel(value) ? { command: 'thinking', value } : null;
  }

  if (normalizedCommand === 'fast') {
    return parseFastModeAction(value === 'toggle' ? undefined : value)
      ? { command: 'fast', value }
      : null;
  }

  return null;
}

function parseDirectiveLine(line: string): EditorShortcutDirective | null {
  const fastMatch = line.match(/^\$fast(?::(\S+))?$/i);
  if (fastMatch) return parseDirective('fast', fastMatch[1]?.trim() || 'toggle');

  const match = line.match(/^\$(model|thinking):(\S+)$/i);
  if (!match) return null;

  const command = match[1]!.toLowerCase();
  const value = match[2]!.trim();
  return parseDirective(command, value);
}

function normalizePromptText(text: string): string {
  return text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractDirectiveTokens(text: string): DirectiveToken[] {
  const tokens: DirectiveToken[] = [];
  const pattern = /(^|\s)\$(model|thinking):(\S+)/gi;

  for (const match of text.matchAll(pattern)) {
    const value = match[3];
    if (!value) continue;

    const directive = parseDirective(match[2]!, value);
    if (!directive) continue;

    const leadingWhitespace = match[1] ?? '';
    const start = match.index! + leadingWhitespace.length;
    const end = match.index! + match[0].length;

    tokens.push({ directive, start, end });
  }

  const fastPattern = /(^|\s)\$fast(?::(\S+))?(?=$|\s)/gi;
  for (const match of text.matchAll(fastPattern)) {
    const directive = parseDirective('fast', match[2]?.trim() || 'toggle');
    if (!directive) continue;

    const leadingWhitespace = match[1] ?? '';
    const start = match.index! + leadingWhitespace.length;
    const end = match.index! + match[0].length;

    tokens.push({ directive, start, end });
  }

  tokens.sort((a, b) => a.start - b.start);

  return tokens;
}

function removeDirectiveTokens(text: string, tokens: DirectiveToken[]): string {
  let result = '';
  let cursor = 0;

  for (const token of tokens) {
    result += text.slice(cursor, token.start);
    cursor = token.end;
  }

  result += text.slice(cursor);
  return normalizePromptText(result);
}

export function parseEditorShortcutText(text: string): ParsedEditorShortcut | null {
  const normalizedText = text.replace(/\r\n/g, '\n');
  const tokens = extractDirectiveTokens(normalizedText);

  if (tokens.length === 0) {
    const leadingLines = normalizedText.split('\n');
    const directives: EditorShortcutDirective[] = [];
    let index = 0;

    while (index < leadingLines.length && leadingLines[index]!.trim() === '') index++;

    for (; index < leadingLines.length; index++) {
      const line = leadingLines[index]!;
      const directive = parseDirectiveLine(line.trim());
      if (!directive) break;
      directives.push(directive);
    }

    if (directives.length === 0) return null;

    return {
      directives,
      promptText: normalizePromptText(leadingLines.slice(index).join('\n')),
    };
  }

  return {
    directives: tokens.map((token) => token.directive),
    promptText: removeDirectiveTokens(normalizedText, tokens),
  };
}
