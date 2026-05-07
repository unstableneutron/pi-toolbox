import { writeSync } from 'node:fs';

import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  type Component,
  Key,
  Markdown,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';

import { compactName, WINDOW_TITLE_MAX_WORDS, type RollingSessionSummary } from './contracts';
import { buildConversationSnapshot, buildRollingSummaryInput } from './conversation';
import { formatInlineRollingSummary, formatRollingSummaryMarkdown } from './rendering';
import { readRollingSummarySidecar, writeRollingSummaryCurrent } from './sidecar';
import { generateRollingSummary } from './unified-summary';

const DISABLE_ENV_VAR = 'PI_SMART_SESSIONS_DISABLED';
const ENTRY_TYPE_WINDOW = 'smart-sessions/window-name';
const INLINE_SUMMARY_WIDGET_KEY = 'smart-sessions/summary-ready';
const AUTO_SUMMARY_MIN_WORK_MS = 5 * 60_000;
const AUTO_SUMMARY_IDLE_MS = 60_000;
const AUTO_SUMMARY_FALLBACK_IDLE_MS = 5 * 60_000;
const AUTO_SUMMARY_MIN_TURNS = 1;
const MAX_ROLLING_REWRITE_COUNT = 12;
const EXIT_SUMMARY_STATE_KEY = '__PI_SMART_SESSIONS_EXIT_SUMMARY_STATE__';

const SUMMARY_MARKDOWN_THEME = {
  heading: (text: string) => `\x1b[1;36m${text}\x1b[0m`,
  link: (text: string) => `\x1b[4;36m${text}\x1b[0m`,
  linkUrl: (text: string) => `\x1b[2;36m${text}\x1b[0m`,
  code: (text: string) => `\x1b[33m${text}\x1b[0m`,
  codeBlock: (text: string) => text,
  codeBlockBorder: (text: string) => `\x1b[2m${text}\x1b[0m`,
  quote: (text: string) => `\x1b[2m${text}\x1b[0m`,
  quoteBorder: (text: string) => `\x1b[2m${text}\x1b[0m`,
  hr: (text: string) => `\x1b[2m${text}\x1b[0m`,
  listBullet: (text: string) => `\x1b[1;36m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[0m`,
  strikethrough: (text: string) => `\x1b[9m${text}\x1b[0m`,
  underline: (text: string) => `\x1b[4m${text}\x1b[0m`,
};

interface ExitSummaryState {
  installed: boolean;
  pendingText: string | null;
}

interface BackgroundSummaryState {
  currentRunStartedAt: number | null;
  currentRunTurns: number;
  accumulatedWorkMs: number;
  accumulatedTurns: number;
  timer: ReturnType<typeof setTimeout> | null;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  abort: AbortController | null;
}

type RefreshReason = 'auto' | 'manual' | 'rename' | 'background';
type RefreshSummaryResult =
  | { ok: true; result: RollingSessionSummary }
  | { ok: false; reason: string };

function isDisabled(): boolean {
  const value = process.env[DISABLE_ENV_VAR]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function getExitSummaryState(): ExitSummaryState {
  const globalState = globalThis as typeof globalThis & {
    [EXIT_SUMMARY_STATE_KEY]?: ExitSummaryState;
  };

  if (!globalState[EXIT_SUMMARY_STATE_KEY]) {
    globalState[EXIT_SUMMARY_STATE_KEY] = {
      installed: false,
      pendingText: null,
    };
  }

  return globalState[EXIT_SUMMARY_STATE_KEY]!;
}

function ensureExitSummaryWriterInstalled(): void {
  const state = getExitSummaryState();
  if (state.installed) return;

  state.installed = true;
  process.once('exit', () => {
    const text = state.pendingText;
    state.pendingText = null;
    state.installed = false;

    if (!text) return;

    try {
      writeSync(1, text);
    } catch {
      // Ignore exit-time write failures.
    }
  });
}

function clearPendingExitSummary(): void {
  getExitSummaryState().pendingText = null;
}

function setPendingExitSummary(text: string): void {
  ensureExitSummaryWriterInstalled();
  getExitSummaryState().pendingText = text;
}

function formatExitSummary(title: string, sessionId: string): string {
  return [
    '',
    '',
    `\x1b[1;36mπ -\x1b[0m \x1b[1m${title}\x1b[0m`,
    '',
    `  \x1b[2mpi --session ${sessionId}\x1b[0m`,
    '',
  ].join('\n');
}

function getBestKnownSessionTitle(ctx: ExtensionContext, currentSessionName?: string): string {
  const existing = currentSessionName?.trim();
  if (existing) return existing;

  const sidecar = readRollingSummarySidecar(ctx.sessionManager.getSessionId());
  if (sidecar.current?.longTitle) return sidecar.current.longTitle;
  return 'Untitled session';
}

async function renameTmuxWindow(pi: ExtensionAPI, name: string): Promise<boolean> {
  if (!process.env.TMUX) return false;

  try {
    const pane = process.env.TMUX_PANE?.trim();
    let target: string | undefined;

    if (pane) {
      const result = await pi.exec('tmux', ['display-message', '-p', '-t', pane, '#{window_id}']);
      if (result.code === 0) {
        target = result.stdout?.trim() || undefined;
      }
    }

    const args = target ? ['rename-window', '-t', target, name] : ['rename-window', name];
    const result = await pi.exec('tmux', args);
    return result.code === 0;
  } catch {
    return false;
  }
}

async function renameZellijTab(pi: ExtensionAPI, name: string): Promise<boolean> {
  if (!process.env.ZELLIJ) return false;

  try {
    const result = await pi.exec('zellij', ['action', 'rename-tab', name]);
    return result.code === 0;
  } catch {
    return false;
  }
}

function renameTerminalTitle(name: string): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(`\x1b]0;${name}\x07`);
}

async function applyWindowName(pi: ExtensionAPI, name: string): Promise<void> {
  if (await renameTmuxWindow(pi, name)) return;
  if (await renameZellijTab(pi, name)) return;
  renameTerminalTitle(name);
}

function getStoredWindowName(entries: unknown[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as {
      type?: string;
      customType?: string;
      data?: { windowName?: unknown };
    };

    if (entry.type === 'custom' && entry.customType === ENTRY_TYPE_WINDOW) {
      const candidate = typeof entry.data?.windowName === 'string' ? entry.data.windowName : '';
      return compactName(candidate, WINDOW_TITLE_MAX_WORDS);
    }
  }

  return undefined;
}

function clearInlineSummaryWidget(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(INLINE_SUMMARY_WIDGET_KEY, undefined);
}

function showInlineSummaryWidget(ctx: ExtensionContext, summary: RollingSessionSummary) {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(INLINE_SUMMARY_WIDGET_KEY, () => ({
    render(width: number) {
      return formatInlineRollingSummary(summary, width);
    },
    invalidate() {},
  }));
}

class SummaryComponent implements Component {
  private scrollOffset = 0;
  private viewportHeight = 0;
  private totalLines = 0;
  private cachedWidth?: number;
  private cachedRender?: string[];
  private markdown: Markdown;

  constructor(
    private readonly summary: RollingSessionSummary,
    private readonly tui: TUI,
    private readonly onDone: () => void,
  ) {
    this.markdown = new Markdown(
      formatRollingSummaryMarkdown(summary),
      0,
      0,
      SUMMARY_MARKDOWN_THEME,
    );
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRender = undefined;
    this.markdown = new Markdown(
      formatRollingSummaryMarkdown(this.summary),
      0,
      0,
      SUMMARY_MARKDOWN_THEME,
    );
  }

  private dim(value: string): string {
    return `\x1b[2m${value}\x1b[0m`;
  }

  private bold(value: string): string {
    return `\x1b[1m${value}\x1b[0m`;
  }

  private cyan(value: string): string {
    return `\x1b[36m${value}\x1b[0m`;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')) || data === 'q') {
      this.onDone();
      return;
    }

    const maxScroll = Math.max(0, this.totalLines - this.viewportHeight);

    if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (matchesKey(data, Key.down)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(1, this.viewportHeight - 1));
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = Math.min(
        maxScroll,
        this.scrollOffset + Math.max(1, this.viewportHeight - 1),
      );
    } else {
      return;
    }

    this.cachedWidth = undefined;
    this.cachedRender = undefined;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedRender && this.cachedWidth === width) return this.cachedRender;

    const boxWidth = Math.max(20, Math.min(width, 120));
    const innerWidth = Math.max(20, boxWidth - 4);
    const hz = (count: number) => '─'.repeat(Math.max(0, count));
    const bodyLines = this.markdown.render(innerWidth);
    const terminalRows = this.tui.terminal?.rows ?? 24;

    this.totalLines = bodyLines.length;
    this.viewportHeight = Math.max(
      8,
      Math.min(Math.max(1, bodyLines.length), Math.max(8, terminalRows - 8)),
    );
    const maxScroll = Math.max(0, this.totalLines - this.viewportHeight);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

    const visibleLines = bodyLines.slice(
      this.scrollOffset,
      this.scrollOffset + this.viewportHeight,
    );
    while (visibleLines.length < this.viewportHeight) {
      visibleLines.push('');
    }

    const frameLine = (line: string): string => {
      const truncated = truncateToWidth(line, innerWidth);
      const padding = Math.max(0, innerWidth - visibleWidth(truncated));
      return this.dim('│') + ' ' + truncated + ' '.repeat(padding) + ' ' + this.dim('│');
    };

    const scrollInfo =
      this.totalLines > this.viewportHeight
        ? this.dim(
            ` (${this.scrollOffset + 1}-${Math.min(this.totalLines, this.scrollOffset + this.viewportHeight)}/${this.totalLines})`,
          )
        : '';

    const output = [
      this.dim(`╭${hz(boxWidth - 2)}╮`),
      frameLine(this.bold(this.cyan('Session Summary')) + scrollInfo),
      this.dim(`├${hz(boxWidth - 2)}┤`),
      ...visibleLines.map((line) => frameLine(line)),
      this.dim(`├${hz(boxWidth - 2)}┤`),
      frameLine(
        `${this.dim('↑/↓')} scroll · ${this.dim('PgUp/PgDn')} page · ${this.dim('Esc/q')} close`,
      ),
      this.dim(`╰${hz(boxWidth - 2)}╯`),
    ];

    this.cachedWidth = width;
    this.cachedRender = output;
    return output;
  }
}

export default function smartSessionsExtension(pi: ExtensionAPI) {
  if (isDisabled()) return;

  let forceRefresh = false;
  let refreshInFlight: Promise<RefreshSummaryResult> | null = null;
  const backgroundSummary: BackgroundSummaryState = {
    currentRunStartedAt: null,
    currentRunTurns: 0,
    accumulatedWorkMs: 0,
    accumulatedTurns: 0,
    timer: null,
    fallbackTimer: null,
    abort: null,
  };

  function resetSummaryWork(): void {
    backgroundSummary.accumulatedWorkMs = 0;
    backgroundSummary.accumulatedTurns = 0;
  }

  function cancelBackgroundSummary(): void {
    if (backgroundSummary.timer) {
      clearTimeout(backgroundSummary.timer);
      backgroundSummary.timer = null;
    }
    if (backgroundSummary.fallbackTimer) {
      clearTimeout(backgroundSummary.fallbackTimer);
      backgroundSummary.fallbackTimer = null;
    }
    if (backgroundSummary.abort) {
      backgroundSummary.abort.abort();
      backgroundSummary.abort = null;
    }
  }

  function startBackgroundSummaryRun(): void {
    backgroundSummary.currentRunStartedAt = Date.now();
    backgroundSummary.currentRunTurns = 0;
  }

  function noteBackgroundSummaryTurn(): void {
    if (backgroundSummary.currentRunStartedAt == null) return;
    backgroundSummary.currentRunTurns += 1;
  }

  function finishBackgroundSummaryRun(): { durationMs: number; turns: number } {
    const durationMs =
      backgroundSummary.currentRunStartedAt == null
        ? 0
        : Math.max(0, Date.now() - backgroundSummary.currentRunStartedAt);
    const turns = backgroundSummary.currentRunTurns;

    backgroundSummary.currentRunStartedAt = null;
    backgroundSummary.currentRunTurns = 0;
    backgroundSummary.accumulatedWorkMs += durationMs;
    backgroundSummary.accumulatedTurns += turns;

    return { durationMs, turns };
  }

  async function applySummaryNames(
    ctx: Pick<ExtensionContext, 'sessionManager'>,
    summary: RollingSessionSummary,
  ): Promise<void> {
    pi.setSessionName(summary.longTitle);
    if (getStoredWindowName(ctx.sessionManager.getBranch()) !== summary.shortTitle) {
      pi.appendEntry(ENTRY_TYPE_WINDOW, { windowName: summary.shortTitle });
    }
    await applyWindowName(pi, summary.shortTitle);
  }

  function getApplicableSummary(ctx: ExtensionContext): RollingSessionSummary | undefined {
    const snapshot = buildConversationSnapshot(ctx.sessionManager.getBranch());
    if (!snapshot) return undefined;

    const sidecar = readRollingSummarySidecar(ctx.sessionManager.getSessionId());
    if (!sidecar.current) return undefined;
    return sidecar.current.conversationHash === snapshot.conversationHash
      ? sidecar.current
      : undefined;
  }

  async function restoreNamesFromState(ctx: ExtensionContext): Promise<void> {
    const applicable = getApplicableSummary(ctx);
    const hasStaleSidecar =
      !!readRollingSummarySidecar(ctx.sessionManager.getSessionId()).current && !applicable;
    const shortTitle = hasStaleSidecar
      ? undefined
      : (applicable?.shortTitle ?? getStoredWindowName(ctx.sessionManager.getBranch()));
    const longTitle = applicable?.longTitle ?? pi.getSessionName();

    if (longTitle) {
      pi.setSessionName(longTitle);
    }
    if (shortTitle) {
      await applyWindowName(pi, shortTitle);
    }
  }

  async function refreshSummary(
    ctx: ExtensionContext,
    reason: RefreshReason,
    externalSignal?: AbortSignal,
  ): Promise<RefreshSummaryResult> {
    const sessionId = ctx.sessionManager.getSessionId();
    const sidecar = readRollingSummarySidecar(sessionId);
    const input = buildRollingSummaryInput(ctx.sessionManager.getBranch(), {
      previousCheckpointEntryId: sidecar.current?.checkpointEntryId,
    });
    const forceHardRebuild = (sidecar.current?.rewriteCount ?? 0) >= MAX_ROLLING_REWRITE_COUNT;
    const generatedAtMs = sidecar.current?.generatedAt
      ? Date.parse(sidecar.current.generatedAt)
      : NaN;
    const elapsedSincePreviousSummaryMs = Number.isFinite(generatedAtMs)
      ? Math.max(0, Date.now() - generatedAtMs)
      : null;

    if (!input.snapshot) {
      return { ok: false, reason: 'no conversation to summarize' };
    }

    if (
      !forceHardRebuild &&
      !input.freshConversation &&
      sidecar.current &&
      sidecar.current.conversationHash === input.snapshot.conversationHash
    ) {
      return { ok: true, result: sidecar.current };
    }

    const result = await generateRollingSummary(
      ctx,
      {
        previousSummary:
          forceHardRebuild || input.mode === 'rebuild'
            ? ''
            : sidecar.current
              ? JSON.stringify(sidecar.current, null, 2)
              : '',
        freshConversation:
          forceHardRebuild || input.mode === 'rebuild'
            ? input.snapshot.conversation
            : input.freshConversation || input.snapshot.conversation,
        mode: forceHardRebuild ? 'rebuild' : input.mode,
        metadata: {
          sessionId,
          currentShortTitle: sidecar.current?.shortTitle ?? null,
          currentLongTitle: sidecar.current?.longTitle ?? null,
          freshMessageCount:
            forceHardRebuild || input.mode === 'rebuild'
              ? input.snapshot.messageCount
              : input.freshMessageCount,
          totalMessageCount: input.snapshot.messageCount,
          elapsedSincePreviousSummaryMs,
          isFirstSummary: !sidecar.current,
        },
      },
      externalSignal,
    );

    if (!result.ok) {
      return result;
    }

    const summary: RollingSessionSummary = {
      ...result.result,
      rewriteCount:
        forceHardRebuild || input.mode === 'rebuild' ? 0 : (sidecar.current?.rewriteCount ?? 0) + 1,
      checkpointEntryId: input.checkpointEntryId ?? input.snapshot.lastMessageEntryId ?? 'entry-0',
      conversationHash: input.snapshot.conversationHash,
      generatedAt: new Date().toISOString(),
    };

    writeRollingSummaryCurrent(sessionId, summary);
    if (reason !== 'background') {
      resetSummaryWork();
    }
    return { ok: true, result: summary };
  }

  async function showSummaryOverlay(ctx: ExtensionContext, summary: RollingSessionSummary) {
    if (!ctx.hasUI) return;

    await ctx.ui.custom<void>(
      (tui, _theme, _kb, done) => new SummaryComponent(summary, tui, () => done(undefined)),
      { overlay: true },
    );
  }

  function showInlineSummaryWidgetFromApplicableState(ctx: ExtensionContext): void {
    const summary = getApplicableSummary(ctx);
    if (!summary) return;
    showInlineSummaryWidget(ctx, summary);
  }

  function queueExitSummary(ctx: ExtensionContext) {
    if (!ctx.hasUI || !process.stdout.isTTY) {
      clearPendingExitSummary();
      return;
    }

    const sessionId = ctx.sessionManager.getSessionId();
    const title = getBestKnownSessionTitle(ctx, pi.getSessionName());
    setPendingExitSummary(formatExitSummary(title, sessionId));
  }

  async function maybeRefreshBeforeAgentStart(ctx: ExtensionContext): Promise<void> {
    const applicable = getApplicableSummary(ctx);
    if (applicable && !forceRefresh) {
      await applySummaryNames(ctx, applicable);
      return;
    }

    refreshInFlight = refreshSummary(ctx, 'auto');
    const result = await refreshInFlight;
    refreshInFlight = null;

    if (result.ok) {
      forceRefresh = false;
      await applySummaryNames(ctx, result.result);
    }
  }

  async function prepareCommandContext(ctx: ExtensionCommandContext): Promise<boolean> {
    clearInlineSummaryWidget(ctx);
    cancelBackgroundSummary();
    await ctx.waitForIdle();
    if (refreshInFlight) {
      await refreshInFlight;
    }

    return !!buildConversationSnapshot(ctx.sessionManager.getBranch());
  }

  async function runBackgroundSummary(ctx: ExtensionContext): Promise<void> {
    if (backgroundSummary.abort) return;
    if (refreshInFlight) {
      await refreshInFlight;
    }

    const applicable = getApplicableSummary(ctx);
    if (applicable) {
      resetSummaryWork();
      showInlineSummaryWidget(ctx, applicable);
      return;
    }

    const controller = new AbortController();
    backgroundSummary.abort = controller;

    try {
      refreshInFlight = refreshSummary(ctx, 'background', controller.signal);
      const result = await refreshInFlight;
      if (result.ok) {
        resetSummaryWork();
        showInlineSummaryWidget(ctx, result.result);
      }
    } finally {
      refreshInFlight = null;
      backgroundSummary.abort = null;
    }
  }

  function scheduleBackgroundSummary(ctx: ExtensionContext) {
    if (
      backgroundSummary.accumulatedWorkMs < AUTO_SUMMARY_MIN_WORK_MS ||
      backgroundSummary.accumulatedTurns < AUTO_SUMMARY_MIN_TURNS
    ) {
      return;
    }

    cancelBackgroundSummary();

    backgroundSummary.timer = setTimeout(() => {
      backgroundSummary.timer = null;
      void runBackgroundSummary(ctx);
    }, AUTO_SUMMARY_IDLE_MS);

    backgroundSummary.fallbackTimer = setTimeout(() => {
      backgroundSummary.fallbackTimer = null;
      void runBackgroundSummary(ctx);
    }, AUTO_SUMMARY_FALLBACK_IDLE_MS);
  }

  // Smart-sessions exists to rename terminal/tmux/zellij windows, render the
  // inline summary widget, and drive a background LLM summarizer whose output
  // is only ever shown in a UI. In print/RPC mode (hasUI === false) every
  // handler becomes a no-op; /rename and /summarize commands stay registered
  // below for explicit invocation.
  pi.on('session_start', async (event, ctx) => {
    if (!ctx.hasUI) return;
    clearPendingExitSummary();
    cancelBackgroundSummary();
    clearInlineSummaryWidget(ctx);

    if (event.reason === 'fork') {
      forceRefresh = true;
      return;
    }

    forceRefresh = false;
    await restoreNamesFromState(ctx);
    showInlineSummaryWidgetFromApplicableState(ctx);
  });

  pi.on('before_agent_start', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    clearInlineSummaryWidget(ctx);
    cancelBackgroundSummary();
    void maybeRefreshBeforeAgentStart(ctx);
  });

  pi.on('agent_start', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    clearInlineSummaryWidget(ctx);
    cancelBackgroundSummary();
    startBackgroundSummaryRun();
  });

  pi.on('turn_end', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    noteBackgroundSummaryTurn();
  });

  pi.on('agent_end', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    finishBackgroundSummaryRun();
    scheduleBackgroundSummary(ctx);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    if (!ctx.hasUI) return;
    cancelBackgroundSummary();
    queueExitSummary(ctx);
  });

  pi.registerCommand('rename', {
    description: 'Rename session from the rolling summary context',
    handler: async (_args, ctx) => {
      if (!(await prepareCommandContext(ctx))) {
        if (ctx.hasUI) ctx.ui.notify('No conversation to summarize', 'error');
        return;
      }

      const result = await refreshSummary(ctx, 'rename');
      if (!result.ok) {
        if (ctx.hasUI) ctx.ui.notify(`Rename failed: ${result.reason}`, 'error');
        return;
      }

      await applySummaryNames(ctx, result.result);
      if (ctx.hasUI) ctx.ui.notify(`Renamed: ${result.result.longTitle}`, 'info');
    },
  });

  pi.registerCommand('summarize', {
    description: 'Show the rolling summary of the current session',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }

      if (!(await prepareCommandContext(ctx))) {
        ctx.ui.notify('No conversation to summarize', 'error');
        return;
      }

      const current = getApplicableSummary(ctx);
      if (current) {
        await applySummaryNames(ctx, current);
        await showSummaryOverlay(ctx, current);
        return;
      }

      type LoaderResult =
        | { kind: 'ok'; result: RollingSessionSummary }
        | { kind: 'cancelled' }
        | { kind: 'error'; reason: string };

      const loaderResult = await ctx.ui.custom<LoaderResult>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, 'Generating session summary...');
        let settled = false;

        const finish = (result: LoaderResult) => {
          if (settled) return;
          settled = true;
          done(result);
        };

        loader.onAbort = () => finish({ kind: 'cancelled' });

        void refreshSummary(ctx, 'manual', loader.signal)
          .then((result) => {
            if (result.ok) {
              finish({ kind: 'ok', result: result.result });
              return;
            }

            if (result.reason === 'cancelled') {
              finish({ kind: 'cancelled' });
            } else {
              finish({ kind: 'error', reason: result.reason });
            }
          })
          .catch(() => finish({ kind: 'error', reason: 'unexpected error' }));

        return loader;
      });

      if (loaderResult.kind === 'cancelled') {
        ctx.ui.notify('Summary cancelled', 'info');
        return;
      }

      if (loaderResult.kind === 'error') {
        ctx.ui.notify(`Summary failed: ${loaderResult.reason}`, 'error');
        return;
      }

      await applySummaryNames(ctx, loaderResult.result);
      await showSummaryOverlay(ctx, loaderResult.result);
    },
  });
}
