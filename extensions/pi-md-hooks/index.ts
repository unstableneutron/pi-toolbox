import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem, AutocompleteProvider } from '@earendil-works/pi-tui';
import { getCapabilities } from '@earendil-works/pi-tui';

const PATCHED = Symbol.for('pi-md-hooks.markdown.patched');
const STATE_KEY = Symbol.for('pi-md-hooks.runtime-state');

export interface PatchInstallResult {
  ok: boolean;
  reason?: string;
}

export interface MarkdownModuleLike {
  Markdown?: any;
}

export type LoadMarkdownModule = () => Promise<MarkdownModuleLike>;

type InlineStyleContext = {
  applyText: (text: string) => string;
  stylePrefix: string;
};

interface RuntimeState {
  cwd?: string;
  patchInstallPromise?: Promise<PatchInstallResult>;
  patchFailureReason?: string;
  patchFailureNotified?: boolean;
  originalRenderInlineTokens?: (this: unknown, tokens: unknown[], styleContext?: unknown) => string;
  originalRenderToken?: (
    this: unknown,
    token: unknown,
    width: number,
    nextTokenType?: string,
    styleContext?: unknown,
  ) => string[];
  originalRender?: (this: unknown, width: number) => string[];
  patchedPrototype?: Record<PropertyKey, any>;
  codeBlockRefs: CodeBlockRef[];
  refsByMarkdownText: Map<string, CodeBlockRef[]>;
}

function getRuntimeState(): RuntimeState {
  const target = globalThis as Record<PropertyKey, unknown>;
  const existing = target[STATE_KEY] as RuntimeState | undefined;
  if (existing) {
    return existing;
  }

  const state: RuntimeState = {
    codeBlockRefs: [],
    refsByMarkdownText: new Map(),
  };
  target[STATE_KEY] = state;
  return state;
}

export interface CodeBlockRef {
  label: string;
  messageNumber: number;
  blockIndex: number;
  language: string;
  content: string;
  preview: string;
  sourceText: string;
}

interface ParsedCopyCodeBlockLabel {
  messageNumber: number;
  blockIndex: number;
}

const CODE_BLOCK_RENDER_INDEX = Symbol.for('pi-md-hooks.code-block-render-index');

function getTextContent(message: any): string {
  if (!message || !Array.isArray(message.content)) {
    return '';
  }

  return message.content
    .filter((content: any) => 'text' === content?.type && 'string' === typeof content.text)
    .map((content: any) => content.text)
    .join('\n')
    .trim();
}

function blockLetter(index: number): string {
  let value = index;
  let result = '';
  do {
    result = String.fromCharCode(97 + (value % 26)) + result;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return result;
}

function blockIndexFromLetters(letters: string): number | undefined {
  if (!/^[a-z]+$/i.test(letters)) {
    return undefined;
  }

  let value = 0;
  for (const char of letters.toLowerCase()) {
    value = value * 26 + (char.charCodeAt(0) - 96);
  }
  return value - 1;
}

export function parseCopyCodeBlockLabel(label: string): ParsedCopyCodeBlockLabel | undefined {
  const match = /^(\d+)([a-z]+)$/i.exec(label.trim());
  if (!match) {
    return undefined;
  }

  const messageNumber = Number.parseInt(match[1], 10);
  const blockIndex = blockIndexFromLetters(match[2]);
  if (
    !Number.isSafeInteger(messageNumber) ||
    messageNumber < 1 ||
    blockIndex === undefined ||
    blockIndex < 0
  ) {
    return undefined;
  }

  return { messageNumber, blockIndex };
}

export function trimSharedLeadingWhitespace(text: string): string {
  const lines = text.replace(/\s+$/u, '').split('\n');
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => /^\s*/u.exec(line)?.[0].length ?? 0);

  if (0 === indents.length) {
    return text.trimEnd();
  }

  const sharedIndent = Math.min(...indents);
  if (0 === sharedIndent) {
    return lines.join('\n');
  }

  return lines.map((line) => (line.trim() ? line.slice(sharedIndent) : line)).join('\n');
}

function extractFencedCodeBlocks(text: string): Array<{ language: string; content: string }> {
  const blocks: Array<{ language: string; content: string }> = [];
  const codeBlockPattern = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^[ \t]{0,3}\1[ \t]*$/gm;

  for (const match of text.matchAll(codeBlockPattern)) {
    const info = (match[2] ?? '').trim();
    const language = info.split(/\s+/u)[0] ?? '';
    blocks.push({
      language,
      content: trimSharedLeadingWhitespace(match[3] ?? ''),
    });
  }

  return blocks;
}

function previewCodeBlock(content: string): string {
  return (
    content
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

export function buildCodeBlockIndex(messages: any[]): CodeBlockRef[] {
  const assistantTexts = messages
    .filter((message) => 'assistant' === message?.role)
    .map((message) => getTextContent(message))
    .filter(Boolean)
    .reverse();

  const refs: CodeBlockRef[] = [];
  assistantTexts.forEach((sourceText, messageOffset) => {
    const messageNumber = messageOffset + 1;
    extractFencedCodeBlocks(sourceText).forEach((block, blockIndex) => {
      refs.push({
        label: `${messageNumber}${blockLetter(blockIndex)}`,
        messageNumber,
        blockIndex,
        language: block.language,
        content: block.content,
        preview: previewCodeBlock(block.content),
        sourceText,
      });
    });
  });

  return refs;
}

function rebuildCodeBlockMaps(refs: CodeBlockRef[]): void {
  const state = getRuntimeState();
  state.codeBlockRefs = refs;
  state.refsByMarkdownText = new Map();

  for (const ref of refs) {
    const existing = state.refsByMarkdownText.get(ref.sourceText) ?? [];
    existing[ref.blockIndex] = ref;
    state.refsByMarkdownText.set(ref.sourceText, existing);
  }
}

function getMessagesFromSession(ctx: ExtensionContext | ExtensionCommandContext): any[] {
  const manager = ctx.sessionManager as any;
  const entries =
    'function' === typeof manager.getBranch ? manager.getBranch() : (manager.getEntries?.() ?? []);
  return entries
    .map((entry: any) => ('message' === entry?.type ? entry.message : entry))
    .filter((message: any) => message?.role);
}

function refreshCodeBlockIndex(ctx: ExtensionContext | ExtensionCommandContext): CodeBlockRef[] {
  const refs = buildCodeBlockIndex(getMessagesFromSession(ctx));
  rebuildCodeBlockMaps(refs);
  return refs;
}

function findCodeBlockRef(label: string): CodeBlockRef | undefined {
  const parsed = parseCopyCodeBlockLabel(label);
  if (!parsed) {
    return undefined;
  }

  return getRuntimeState().codeBlockRefs.find(
    (ref) => ref.messageNumber === parsed.messageNumber && ref.blockIndex === parsed.blockIndex,
  );
}

function copyCodeBlockCompletions(prefix: string): AutocompleteItem[] | null {
  const normalizedPrefix = prefix.trim().toLowerCase();
  const items = getRuntimeState()
    .codeBlockRefs.filter((ref) => ref.label.startsWith(normalizedPrefix))
    .map((ref) => ({
      value: ref.label,
      label: ref.label,
      description: [ref.language || 'text', ref.preview].filter(Boolean).join('  '),
    }));

  return items.length ? items : null;
}

function createCopyAutocompleteProvider(
  current: AutocompleteProvider,
  ctx: ExtensionContext,
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const currentLine = lines[cursorLine] ?? '';
      const textBeforeCursor = currentLine.slice(0, cursorCol);
      const match = /^\/copy\s+([^\s]*)$/u.exec(textBeforeCursor);
      if (!match) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      refreshCodeBlockIndex(ctx);
      const items = copyCodeBlockCompletions(match[1] ?? '');
      return items ? { prefix: match[1] ?? '', items } : null;
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

export async function defaultLoadMarkdownModule(): Promise<MarkdownModuleLike> {
  const packageEntryUrl = import.meta.resolve('@earendil-works/pi-tui');
  const packageEntryPath = fileURLToPath(packageEntryUrl);
  const markdownUrl = pathToFileURL(
    path.join(path.dirname(packageEntryPath), 'components', 'markdown.js'),
  ).href;

  return import(/* @vite-ignore */ markdownUrl);
}

function setActiveCwd(cwd: string | undefined): void {
  getRuntimeState().cwd = cwd;
}

function maybeWarnAboutPatchFailure(ctx: ExtensionContext): void {
  const state = getRuntimeState();
  if (!ctx.hasUI || !state.patchFailureReason || state.patchFailureNotified) {
    return;
  }

  state.patchFailureNotified = true;
  ctx.ui.notify(`pi-md-hooks disabled: ${state.patchFailureReason}`, 'warning');
}

function wrapHyperlink(target: string, label: string): string {
  return `\x1b]8;;${target}\x07${label}\x1b]8;;\x07`;
}

function splitFileReference(text: string): { pathText: string; suffix: string } | undefined {
  if (!text || text.includes('\n') || text.includes('://')) {
    return undefined;
  }

  if (/^[A-Za-z]:[\\/]/.test(text)) {
    return { pathText: text, suffix: '' };
  }

  const match = /^(.*?)(:(\d+)(:(\d+))?)$/.exec(text);
  if (match?.[1] && !match[1].endsWith('/')) {
    return {
      pathText: match[1],
      suffix: match[2] || '',
    };
  }

  return { pathText: text, suffix: '' };
}

function expandHomePrefix(candidate: string): string {
  if ('~' === candidate) {
    return process.env.HOME || candidate;
  }
  if (candidate.startsWith('~/')) {
    const home = process.env.HOME;
    return home ? path.join(home, candidate.slice(2)) : candidate;
  }
  return candidate;
}

function looksLikeFilePath(candidate: string): boolean {
  if (!candidate) {
    return false;
  }

  return (
    candidate.startsWith('~/') ||
    candidate.startsWith('./') ||
    candidate.startsWith('../') ||
    candidate.startsWith('/') ||
    candidate.includes('/') ||
    /^[^\s]+\.[A-Za-z0-9_-]+$/.test(candidate)
  );
}

function resolveFileTarget(text: string): string | undefined {
  const state = getRuntimeState();

  const parts = splitFileReference(text);
  if (!parts || !looksLikeFilePath(parts.pathText)) {
    return undefined;
  }

  const expandedPath = expandHomePrefix(parts.pathText);
  if (!path.isAbsolute(expandedPath) && !state.cwd) {
    return undefined;
  }

  const resolvedPath = path.isAbsolute(expandedPath)
    ? path.normalize(expandedPath)
    : path.resolve(state.cwd!, expandedPath);

  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile() && !stat.isDirectory()) {
      return undefined;
    }
    return pathToFileURL(resolvedPath).href;
  } catch {
    return undefined;
  }
}

function linkifyPathLikeText(
  self: any,
  text: string,
  applyText: (text: string) => string,
  stylePrefix: string,
): string {
  const pathLikePattern =
    /(^|[\s(])((?:~\/|\.\/|\.\.\/|\/)?[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?)(?=$|[\s),])/g;

  let result = '';
  let lastIndex = 0;

  for (const match of text.matchAll(pathLikePattern)) {
    const leading = match[1] || '';
    const candidate = match[2] || '';
    const matchIndex = match.index ?? 0;
    const candidateStart = matchIndex + leading.length;

    if (!candidate) {
      continue;
    }

    const target = resolveFileTarget(candidate);
    if (!target) {
      continue;
    }

    result += applyText(text.slice(lastIndex, candidateStart));
    result +=
      wrapHyperlink(target, self.theme.link(self.theme.underline(applyText(candidate)))) +
      stylePrefix;
    lastIndex = candidateStart + candidate.length;
  }

  if (0 === lastIndex) {
    return applyText(text);
  }

  result += applyText(text.slice(lastIndex));
  return result;
}

function renderPatchedInlineTokens(
  self: any,
  tokens: any[],
  styleContext?: InlineStyleContext,
): string {
  const state = getRuntimeState();
  const original = state.originalRenderInlineTokens;
  if (!original || !Array.isArray(tokens) || !getCapabilities().hyperlinks) {
    return original ? original.call(self, tokens, styleContext) : '';
  }

  let result = '';
  const resolvedStyleContext = styleContext ?? self.getDefaultInlineStyleContext();
  const { applyText, stylePrefix } = resolvedStyleContext;
  const applyTextWithNewlines = (text: string): string => {
    const segments: string[] = text.split('\n');
    return segments.map((segment) => applyText(segment)).join('\n');
  };

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        if (token.tokens && token.tokens.length > 0) {
          result += self.renderInlineTokens(token.tokens, resolvedStyleContext);
        } else {
          result += linkifyPathLikeText(self, token.text, applyTextWithNewlines, stylePrefix);
        }
        break;

      case 'paragraph':
        result += self.renderInlineTokens(token.tokens || [], resolvedStyleContext);
        break;

      case 'codespan': {
        const fileTarget = resolveFileTarget(token.text);
        const codeText = self.theme.code(token.text);
        result += (fileTarget ? wrapHyperlink(fileTarget, codeText) : codeText) + stylePrefix;
        break;
      }

      default:
        result += original.call(self, [token], resolvedStyleContext);
    }
  }

  while (stylePrefix && result.endsWith(stylePrefix)) {
    result = result.slice(0, -stylePrefix.length);
  }

  return result;
}

function nextCodeBlockLabelForMarkdown(self: any): string | undefined {
  const text = 'string' === typeof self.text ? self.text.trim() : '';
  if (!text) {
    return undefined;
  }

  const refs = getRuntimeState().refsByMarkdownText.get(text);
  if (!refs?.length) {
    return undefined;
  }

  const currentIndex = (self[CODE_BLOCK_RENDER_INDEX] as number | undefined) ?? 0;
  self[CODE_BLOCK_RENDER_INDEX] = currentIndex + 1;
  return refs[currentIndex]?.label;
}

function renderPatchedToken(
  self: any,
  token: any,
  width: number,
  nextTokenType?: string,
  styleContext?: unknown,
): string[] {
  const original = getRuntimeState().originalRenderToken;
  if (!original) {
    return [];
  }

  const lines = original.call(self, token, width, nextTokenType, styleContext);
  if ('code' !== token?.type) {
    return lines;
  }

  const label = nextCodeBlockLabelForMarkdown(self);
  return label ? [self.theme.codeBlockBorder(`// ${label}`), ...lines] : lines;
}

export async function installMarkdownPatch(
  loadMarkdownModule: LoadMarkdownModule = defaultLoadMarkdownModule,
): Promise<PatchInstallResult> {
  const state = getRuntimeState();
  if (state.patchInstallPromise) {
    return state.patchInstallPromise;
  }

  state.patchInstallPromise = (async () => {
    const module = await loadMarkdownModule();
    const Markdown = module.Markdown as any;

    if (!Markdown?.prototype) {
      state.patchFailureReason = 'Markdown export not found';
      return { ok: false, reason: state.patchFailureReason };
    }

    const proto = Markdown.prototype as Record<PropertyKey, any>;
    if (proto[PATCHED]) {
      state.patchFailureReason = undefined;
      state.patchedPrototype = proto;
      return { ok: true };
    }

    const originalRenderInlineTokens = proto.renderInlineTokens;
    if ('function' !== typeof originalRenderInlineTokens) {
      state.patchFailureReason = 'Markdown.renderInlineTokens is not available';
      return { ok: false, reason: state.patchFailureReason };
    }

    state.originalRenderInlineTokens = originalRenderInlineTokens;
    state.patchedPrototype = proto;
    proto.renderInlineTokens = function patchedRenderInlineTokens(
      this: unknown,
      tokens: unknown[],
      styleContext?: unknown,
    ): string {
      return renderPatchedInlineTokens(this, tokens as any[], styleContext as InlineStyleContext);
    };

    const originalRenderToken = proto.renderToken;
    if ('function' === typeof originalRenderToken) {
      state.originalRenderToken = originalRenderToken;
      proto.renderToken = function patchedRenderToken(
        this: unknown,
        token: unknown,
        width: number,
        nextTokenType?: string,
        styleContext?: unknown,
      ): string[] {
        return renderPatchedToken(this, token, width, nextTokenType, styleContext);
      };
    }

    const originalRender = proto.render;
    if ('function' === typeof originalRender) {
      state.originalRender = originalRender;
      proto.render = function patchedRender(
        this: Record<PropertyKey, unknown>,
        width: number,
      ): string[] {
        this[CODE_BLOCK_RENDER_INDEX] = 0;
        return originalRender.call(this, width);
      };
    }

    Object.defineProperty(proto, PATCHED, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: false,
    });

    state.patchFailureReason = undefined;
    return { ok: true };
  })().catch((error) => {
    state.patchFailureReason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: state.patchFailureReason };
  });

  return state.patchInstallPromise;
}

export function resetPiMdHooksTestState(): void {
  const state = getRuntimeState();
  if (state.patchedPrototype && state.originalRenderInlineTokens) {
    state.patchedPrototype.renderInlineTokens = state.originalRenderInlineTokens;
    if (state.originalRenderToken) {
      state.patchedPrototype.renderToken = state.originalRenderToken;
    }
    if (state.originalRender) {
      state.patchedPrototype.render = state.originalRender;
    }
    delete state.patchedPrototype[PATCHED];
  }

  state.cwd = undefined;
  state.patchInstallPromise = undefined;
  state.patchFailureReason = undefined;
  state.patchFailureNotified = false;
  state.originalRenderInlineTokens = undefined;
  state.originalRenderToken = undefined;
  state.originalRender = undefined;
  state.patchedPrototype = undefined;
  state.codeBlockRefs = [];
  state.refsByMarkdownText = new Map();
}

export function createPiMdHooksExtension(
  loadMarkdownModule: LoadMarkdownModule = defaultLoadMarkdownModule,
) {
  return async function piMdHooks(pi: ExtensionAPI): Promise<void> {
    pi.registerCommand('copy', {
      description: 'Copy a labeled code block, for example /copy 1a',
      handler: async (args, ctx) => {
        if ('tui' !== ctx.mode) {
          return;
        }

        const label = args.trim();
        if (!label) {
          return;
        }

        refreshCodeBlockIndex(ctx);
        const ref = findCodeBlockRef(label);
        if (!ref) {
          ctx.ui.notify(`No code block labeled ${label}`, 'warning');
          return;
        }

        await copyToClipboard(ref.content);
        ctx.ui.notify(`Copied code block ${ref.label}`, 'info');
      },
    });

    pi.on('session_start', async (_event, ctx) => {
      if ('tui' !== ctx.mode) {
        return;
      }

      await installMarkdownPatch(loadMarkdownModule);
      setActiveCwd(ctx.sessionManager.getCwd());
      refreshCodeBlockIndex(ctx);
      ctx.ui.addAutocompleteProvider((current) => createCopyAutocompleteProvider(current, ctx));
      maybeWarnAboutPatchFailure(ctx);
    });

    pi.on('message_end', async (event, ctx) => {
      if ('tui' === ctx.mode && 'assistant' === event.message.role) {
        refreshCodeBlockIndex(ctx);
      }
    });

    pi.on('session_shutdown', async () => {
      setActiveCwd(undefined);
      rebuildCodeBlockMaps([]);
    });
  };
}

export default createPiMdHooksExtension();
