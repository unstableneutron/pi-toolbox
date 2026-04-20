import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { getCapabilities } from '@mariozechner/pi-tui';

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
  patchedPrototype?: Record<PropertyKey, any>;
}

function getRuntimeState(): RuntimeState {
  const target = globalThis as Record<PropertyKey, unknown>;
  const existing = target[STATE_KEY] as RuntimeState | undefined;
  if (existing) {
    return existing;
  }

  const state: RuntimeState = {};
  target[STATE_KEY] = state;
  return state;
}

export async function defaultLoadMarkdownModule(): Promise<MarkdownModuleLike> {
  const packageEntryUrl = import.meta.resolve('@mariozechner/pi-tui');
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
    delete state.patchedPrototype[PATCHED];
  }

  state.cwd = undefined;
  state.patchInstallPromise = undefined;
  state.patchFailureReason = undefined;
  state.patchFailureNotified = false;
  state.originalRenderInlineTokens = undefined;
  state.patchedPrototype = undefined;
}

export function createPiMdHooksExtension(
  loadMarkdownModule: LoadMarkdownModule = defaultLoadMarkdownModule,
) {
  return async function piMdHooks(pi: ExtensionAPI): Promise<void> {
    await installMarkdownPatch(loadMarkdownModule);

    pi.on('session_start', async (_event, ctx) => {
      setActiveCwd(ctx.sessionManager.getCwd());
      maybeWarnAboutPatchFailure(ctx);
    });

    pi.on('session_shutdown', async () => {
      setActiveCwd(undefined);
    });
  };
}

export default createPiMdHooksExtension();
