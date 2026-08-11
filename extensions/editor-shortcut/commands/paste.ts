import { execFile } from 'node:child_process';
import { platform } from 'node:os';

import { type Api, type Model, type UserMessage } from '@earendil-works/pi-ai/compat';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { completeSimpleWithResolvedAuth } from '../../shared/model-completion';

const CLIPBOARD_TIMEOUT_MS = 2_000;
const CLIPBOARD_MAX_BYTES = 5 * 1024 * 1024;
const TAG_GENERATION_TIMEOUT_MS = 15_000;
const TAG_GENERATION_MAX_TOKENS = 24;
const TAG_GENERATION_HEAD_CHARS = 600;
const TAG_GENERATION_TAIL_CHARS = 200;
const PASTE_EXPANSION_ENTRY = 'editor-shortcut.paste-expansion';

const GENERATED_PASTE_VALUES = new Set(['auto', 'generate']);

const TAG_GENERATION_PROMPT = `Generate a concise XML tag name for a pasted text block.

Rules:
- Return only 2-3 lowercase words joined with hyphens.
- Use letters and numbers only, with hyphens between words.
- Do not include quotes, markdown, explanation, or angle brackets.
- Prefer a tag that summarizes the content's purpose or topic.`;

type PasteReplacement =
  | { ok: true; displayText: string; contextText: string; placeholder: string; tag: string }
  | { ok: false; reason: string };

type PasteExpansionData = {
  placeholder: string;
  text: string;
};

type PasteDirectiveToken = {
  start: number;
  end: number;
  value: string;
};

type ClipboardTextReader = () => Promise<string>;
type PasteTagGenerator = (content: string, ctx: ExtensionContext) => Promise<string | null>;

type PreferredModelSpec = {
  provider: string;
  id: string;
};

export type PasteShortcutState = {
  pending: Map<string, Promise<PasteReplacement>>;
  expansions: Map<string, string>;
  persistedPlaceholders: Set<string>;
  pendingCounter: number;
  expansionCounter: number;
  attachmentCounter: number;
  attachmentSeed: number;
  readClipboardText: ClipboardTextReader;
  generateTag: PasteTagGenerator;
};

export type PasteShortcutStateOptions = {
  attachmentSeed?: number;
  readClipboardText?: ClipboardTextReader;
  generateTag?: PasteTagGenerator;
};

export type PasteReplacementResult =
  | { found: false; text: string }
  | { found: true; ok: true; text: string }
  | { found: true; ok: false; reason: string };

const TAG_MODEL_PREFERENCES: PreferredModelSpec[] = [
  { provider: 'openai', id: 'gpt-4.1-mini' },
  { provider: 'anthropic', id: 'claude-haiku-4-5' },
  { provider: 'google', id: 'gemini-3.5-flash' },
  { provider: 'google', id: 'gemini-3.1-flash-lite' },
  { provider: 'google', id: 'gemini-2.5-flash' },
];

export function createPasteShortcutState(
  options: PasteShortcutStateOptions = {},
): PasteShortcutState {
  return {
    pending: new Map(),
    expansions: new Map(),
    persistedPlaceholders: new Set(),
    pendingCounter: 0,
    expansionCounter: 0,
    attachmentCounter: 0,
    attachmentSeed: options.attachmentSeed ?? Math.floor(Math.random() * 9_000) + 1_000,
    readClipboardText: options.readClipboardText ?? readClipboardText,
    generateTag: options.generateTag ?? generatePasteTag,
  };
}

export function isGeneratedPasteValue(value: string | undefined): boolean {
  return GENERATED_PASTE_VALUES.has((value ?? '').trim().toLowerCase());
}

export function createPendingGeneratedPaste(
  value: string,
  ctx: ExtensionContext,
  state: PasteShortcutState,
): string {
  const mode = isGeneratedPasteValue(value) ? value.trim().toLowerCase() : 'auto';
  const id = `${mode}-${++state.pendingCounter}`;
  state.pending.set(
    id,
    createPasteReplacement(mode, ctx, state).catch((error: unknown) => ({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    })),
  );
  return id;
}

export async function replacePasteDirectivesInText(
  text: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PasteShortcutState,
): Promise<PasteReplacementResult> {
  const normalizedText = text.replace(/\r\n/g, '\n');
  const tokens = findPasteDirectiveTokens(normalizedText);

  if (tokens.length === 0) return { found: false, text };

  let result = '';
  let cursor = 0;

  for (const token of tokens) {
    const replacement = await resolvePasteReplacement(token.value, ctx, state);

    if (!replacement.ok) {
      ctx.ui.notify(replacement.reason, 'warning');
      return { found: true, ok: false, reason: replacement.reason };
    }

    persistPasteReplacement(replacement, pi, state);
    const formatted = formatDisplayReplacement(
      normalizedText,
      cursor,
      token.start,
      token.end,
      replacement.displayText,
    );
    result += formatted.text;
    cursor = formatted.cursor;
  }

  result += normalizedText.slice(cursor);
  return { found: true, ok: true, text: result.trim() };
}

export function restorePasteExpansions(ctx: ExtensionContext, state: PasteShortcutState): void {
  state.expansions.clear();
  state.persistedPlaceholders.clear();

  for (const entry of ctx.sessionManager.getBranch()) {
    const candidate = entry as { type?: string; customType?: string; data?: unknown };
    if (candidate.type !== 'custom' || candidate.customType !== PASTE_EXPANSION_ENTRY) continue;
    if (!isPasteExpansionData(candidate.data)) continue;

    state.expansions.set(candidate.data.placeholder, candidate.data.text);
    state.persistedPlaceholders.add(candidate.data.placeholder);
  }
}

function expandPastePlaceholdersInText(text: string, state: PasteShortcutState): string {
  let result = text;
  for (const [placeholder, contextText] of state.expansions) {
    result = result.split(placeholder).join(contextText);
  }
  return result;
}

export function expandPastePlaceholdersInMessages(
  messages: AgentMessage[],
  state: PasteShortcutState,
): AgentMessage[] | undefined {
  let changed = false;

  const expandedMessages = messages.map((message) => {
    const candidate = message as AgentMessage & { content?: unknown };
    if (!Array.isArray(candidate.content)) return message;

    let messageChanged = false;
    const content = candidate.content.map((part) => {
      const textPart = part as { type?: unknown; text?: unknown };
      if (textPart.type !== 'text' || typeof textPart.text !== 'string') return part;

      const expandedText = expandPastePlaceholdersInText(textPart.text, state);
      if (expandedText === textPart.text) return part;

      messageChanged = true;
      return { ...textPart, text: expandedText };
    });

    if (!messageChanged) return message;

    changed = true;
    return { ...candidate, content } as AgentMessage;
  });

  return changed ? expandedMessages : undefined;
}

function findPasteDirectiveTokens(text: string): PasteDirectiveToken[] {
  const tokens: PasteDirectiveToken[] = [];
  const linePattern = /(^|\n)([ \t]*)\$paste[ \t]+(\S+)(?=[ \t]*(?:\n|$))/gi;

  for (const match of text.matchAll(linePattern)) {
    const leadingNewline = match[1] ?? '';
    const indentation = match[2] ?? '';
    const start = match.index! + leadingNewline.length + indentation.length;
    const end = match.index! + match[0].length;

    tokens.push({ start, end, value: match[3]?.trim() ?? '' });
  }

  const colonPattern = /(^|\s)\$paste(?::(\S*))?(?=$|\s)/gi;
  for (const match of text.matchAll(colonPattern)) {
    const leadingWhitespace = match[1] ?? '';
    const start = match.index! + leadingWhitespace.length;
    const end = match.index! + match[0].length;

    if (tokens.some((token) => rangesOverlap(start, end, token.start, token.end))) continue;
    tokens.push({ start, end, value: match[2]?.trim() ?? '' });
  }

  return tokens.sort((left, right) => left.start - right.start);
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function persistPasteReplacement(
  replacement: Extract<PasteReplacement, { ok: true }>,
  pi: ExtensionAPI,
  state: PasteShortcutState,
): void {
  if (state.persistedPlaceholders.has(replacement.placeholder)) return;

  state.persistedPlaceholders.add(replacement.placeholder);
  pi.appendEntry(PASTE_EXPANSION_ENTRY, {
    placeholder: replacement.placeholder,
    text: replacement.contextText,
  } satisfies PasteExpansionData);
}

function nextAttachmentTag(state: PasteShortcutState): string {
  return `attachment-${state.attachmentSeed + state.attachmentCounter++}`;
}

async function resolvePasteReplacement(
  value: string,
  ctx: ExtensionContext,
  state: PasteShortcutState,
): Promise<PasteReplacement> {
  const pending = value ? state.pending.get(value) : undefined;
  if (pending) {
    try {
      return await pending;
    } finally {
      state.pending.delete(value);
    }
  }

  return createPasteReplacement(value, ctx, state);
}

async function createPasteReplacement(
  value: string,
  ctx: ExtensionContext,
  state: PasteShortcutState,
): Promise<PasteReplacement> {
  const content = await state.readClipboardText();
  if (!content) return { ok: false, reason: 'No text in clipboard for $paste' };

  const requestedTag = value.trim();
  const generated = isGeneratedPasteValue(requestedTag)
    ? await state.generateTag(content, ctx).catch(() => null)
    : null;
  const tag = isGeneratedPasteValue(requestedTag)
    ? (sanitizePasteTag(generated) ?? nextAttachmentTag(state))
    : (sanitizePasteTag(requestedTag) ?? nextAttachmentTag(state));
  const contextText = wrapPasteContent(content, tag);
  const placeholder = formatPastePlaceholder(content, tag, state);
  state.expansions.set(placeholder, contextText);

  return { ok: true, tag, displayText: placeholder, contextText, placeholder };
}

function wrapPasteContent(content: string, tag: string): string {
  const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const contentWithTrailingNewline = normalizedContent.endsWith('\n')
    ? normalizedContent
    : `${normalizedContent}\n`;
  return `<${tag}>\n${contentWithTrailingNewline}</${tag}>`;
}

function formatPastePlaceholder(content: string, tag: string, state: PasteShortcutState): string {
  state.expansionCounter++;
  const lineCount = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').length;
  const size = lineCount > 1 ? `${lineCount} lines` : `${content.length} chars`;
  const placeholder = `[${tag} · ${size}]`;

  if (!state.expansions.has(placeholder)) return placeholder;
  return `[${tag} #${state.expansionCounter} · ${size}]`;
}

function formatDisplayReplacement(
  text: string,
  cursor: number,
  start: number,
  end: number,
  replacement: string,
): { text: string; cursor: number } {
  const before = text.slice(cursor, start).replace(/[ \t]+$/g, '');
  const needsLeadingNewline = before.length > 0 && !before.endsWith('\n');

  const trailingHorizontalWhitespace = text.slice(end).match(/^[ \t]+/)?.[0] ?? '';
  const nextCursor = end + trailingHorizontalWhitespace.length;
  const nextChar = text[nextCursor];
  const needsTrailingNewline = nextChar !== undefined && nextChar !== '\n';

  return {
    text: `${before}${needsLeadingNewline ? '\n' : ''}${replacement}${
      needsTrailingNewline ? '\n' : ''
    }`,
    cursor: nextCursor,
  };
}

function sanitizePasteTag(value: string | null | undefined): string | null {
  const words = (value ?? '')
    .toLowerCase()
    .replace(/[`'"<>]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 3);

  if (words.length === 0) return null;

  let tag = words.join('-').slice(0, 64).replace(/-+$/g, '');
  if (!/^[a-z]/.test(tag)) tag = `attachment-${tag}`;
  return tag || null;
}

function samplePasteContentForTag(content: string): string {
  const maxChars = TAG_GENERATION_HEAD_CHARS + TAG_GENERATION_TAIL_CHARS;
  if (content.length <= maxChars) return content;

  return `${content.slice(0, TAG_GENERATION_HEAD_CHARS)}\n...\n${content.slice(
    -TAG_GENERATION_TAIL_CHARS,
  )}`;
}

async function generatePasteTag(content: string, ctx: ExtensionContext): Promise<string | null> {
  const model = await selectTagGenerationModel(ctx);
  if (!model) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TAG_GENERATION_TIMEOUT_MS);

  try {
    const userMessage: UserMessage = {
      role: 'user',
      timestamp: Date.now(),
      content: [
        {
          type: 'text',
          text: samplePasteContentForTag(content),
        },
      ],
    };

    const response = await completeSimpleWithResolvedAuth(
      ctx.modelRegistry,
      model,
      { systemPrompt: TAG_GENERATION_PROMPT, messages: [userMessage] },
      {
        maxTokens: TAG_GENERATION_MAX_TOKENS,
        reasoning: model.reasoning ? 'low' : undefined,
        signal: controller.signal,
        temperature: 0,
      },
    );

    if (response.stopReason === 'aborted' || response.stopReason === 'error') return null;

    return response.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join(' ');
  } finally {
    clearTimeout(timeout);
  }
}

async function selectTagGenerationModel(ctx: ExtensionContext): Promise<Model<Api> | null> {
  for (const preferred of TAG_MODEL_PREFERENCES) {
    const model = ctx.modelRegistry.find(preferred.provider, preferred.id) as
      | Model<Api>
      | undefined;
    if (model && (await ctx.modelRegistry.getApiKeyAndHeaders(model)).ok) return model;
  }

  return null;
}

async function readClipboardText(): Promise<string> {
  const p = platform();

  if (p === 'darwin') return (await runClipboardCommand('pbpaste', [])) ?? '';
  if (p === 'win32') return (await readWindowsClipboardText()) ?? '';
  if (process.env.TERMUX_VERSION) {
    return (await runClipboardCommand('termux-clipboard-get', [])) ?? '';
  }
  if (isWsl()) {
    const text = await readWindowsClipboardText();
    if (text !== null) return text;
  }

  if (process.env.WAYLAND_DISPLAY) {
    const wayland = await runClipboardCommand('wl-paste', ['--type', 'text/plain', '--no-newline']);
    if (wayland !== null) return wayland;
  }

  if (process.env.DISPLAY) {
    return (
      (await runClipboardCommand('xclip', ['-selection', 'clipboard', '-o'])) ??
      (await runClipboardCommand('xsel', ['--clipboard', '--output'])) ??
      ''
    );
  }

  return '';
}

function isWsl(): boolean {
  return (
    process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
  );
}

async function readWindowsClipboardText(): Promise<string | null> {
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write([string](Get-Clipboard -Raw))`;
  const text = await runClipboardCommand('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ]);
  return text?.replace(/\r\n/g, '\n') ?? null;
}

async function runClipboardCommand(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        maxBuffer: CLIPBOARD_MAX_BYTES,
        timeout: CLIPBOARD_TIMEOUT_MS,
      },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

function isPasteExpansionData(value: unknown): value is PasteExpansionData {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as PasteExpansionData;
  return typeof candidate.placeholder === 'string' && typeof candidate.text === 'string';
}
