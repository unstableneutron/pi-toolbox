import {
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import { registerExtensionEditorBehavior, type EditorBehavior } from '../shared/editor-behaviors';

/**
 * Verified pi APIs used by this single-file implementation:
 * - ctx.abort() for interrupting the current busy run.
 * - ctx.ui.setWidget(...) for the inline warning above the editor.
 * - ctx.ui.setStatus(...) for a compact degraded fallback if widget rendering fails.
 * - ctx.isIdle() / ctx.hasPendingMessages() for busy-state precedence decisions.
 * - shared editor behaviors to intercept raw keyboard input without owning the editor.
 */

export type GuardConfig = {
  warningTimeoutMs: number;
  escBypassCount: number;
  escBypassWindowMs: number;
  escDebounceMs: number;
  busyStaleResetMs: number;
};

export type BusyDecisionArgs = {
  activeToolCount: number;
  assistantStreaming: boolean;
  agentActive?: boolean;
  submitPending?: boolean;
  hasPendingMessages: boolean | null;
  isIdle: boolean | null;
  lastActivityAt: number;
  now: number;
  config: GuardConfig;
};

export type GuardState = {
  warningVisible: boolean;
  timestamps: number[];
};

export type GuardEvent =
  | { type: 'open-warning' }
  | { type: 'dismiss' }
  | { type: 'timeout' }
  | { type: 'confirm' }
  | { type: 'hard-reset' };

export const SAFE_ESCAPE_CONTRACT = '1st ESC = show warning, 2nd ESC = arm only, 3rd ESC = cancel';

const MAX_DEBUG_EVENTS = 40;
const DEFAULT_CONFIG: GuardConfig = {
  warningTimeoutMs: 2000,
  escBypassCount: 3,
  escBypassWindowMs: 1200,
  escDebounceMs: 75,
  busyStaleResetMs: 5000,
};

export function clearExpiredEscPresses(
  timestamps: number[],
  now: number,
  config: GuardConfig,
): number[] {
  return timestamps.filter((ts) => now - ts <= config.escBypassWindowMs);
}

export function recordEscPress(timestamps: number[], now: number, config: GuardConfig) {
  const active = clearExpiredEscPresses(timestamps, now, config);
  const last = active.at(-1);
  if (last !== undefined && now - last < config.escDebounceMs) {
    return { timestamps: active, triggerInterrupt: false, acceptedPress: false };
  }

  const next = [...active, now];
  return {
    timestamps: next,
    triggerInterrupt: next.length >= config.escBypassCount,
    acceptedPress: true,
  };
}

export function classifyStreamingMessage(role: 'user' | 'assistant' | 'toolResult') {
  return role === 'assistant';
}

export function decideBusyState(args: BusyDecisionArgs): 'busy' | 'idle' {
  if (
    args.activeToolCount > 0 ||
    args.assistantStreaming ||
    args.agentActive === true ||
    args.submitPending === true
  ) {
    return 'busy';
  }
  if (args.hasPendingMessages === true) return 'busy';
  if (args.isIdle === true) return 'idle';
  if (args.now - args.lastActivityAt >= args.config.busyStaleResetMs) return 'idle';
  return 'busy';
}

export function reduceGuardEvent(state: GuardState, event: GuardEvent): GuardState {
  switch (event.type) {
    case 'open-warning':
      return { ...state, warningVisible: true };
    case 'dismiss':
      return { ...state, warningVisible: false };
    case 'timeout':
    case 'confirm':
    case 'hard-reset':
      return { warningVisible: false, timestamps: [] };
  }
}

type EscapeInputKind = 'none' | 'press' | 'repeat' | 'release';

function parseKittyEscapeKeyEvent(data: string) {
  if (!data.startsWith('\x1b[') || !data.endsWith('u')) return null;

  const body = data.slice(2, -1);
  const [keyPart, modifierPart] = body.split(';', 2);
  if (keyPart !== '27') return null;

  const [modifierValue, eventTypeValue] = (modifierPart ?? '1').split(':', 2);
  const modifier = Number(modifierValue || '1');
  const eventType = Number(eventTypeValue || '1');
  if (!Number.isFinite(modifier) || !Number.isFinite(eventType)) return null;

  return { modifier, eventType };
}

function getEscapeInputKind(data: string): EscapeInputKind {
  if (data === '\x1b') return 'press';

  const kittyEvent = parseKittyEscapeKeyEvent(data);
  if (kittyEvent) {
    if (kittyEvent.modifier !== 1) return 'none';
    if (kittyEvent.eventType === 1) return 'press';
    if (kittyEvent.eventType === 2) return 'repeat';
    if (kittyEvent.eventType === 3) return 'release';
    return 'none';
  }

  return matchesKey(data, Key.escape) ? 'press' : 'none';
}

function isIgnoredEscapeTransitionInput(data: string): boolean {
  const kind = getEscapeInputKind(data);
  return kind === 'repeat' || kind === 'release';
}

export function isPlainEscapeInput(data: string): boolean {
  return getEscapeInputKind(data) === 'press';
}

function compactCountdownLabel(countdown: string): string {
  return countdown.replace(/^auto-dismisses in\s+/i, '');
}

export function formatWarningTextLine(countdown: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const full = `⚠ Busy — press ESC ESC quickly to interrupt (${countdown})`;
  if (visibleWidth(full) <= safeWidth) return full;

  return `⚠ Busy — ESC ESC to interrupt (${compactCountdownLabel(countdown)})`;
}

export function formatWarningBar(width: number, fraction: number): string {
  const safeWidth = Math.max(1, width);
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.max(0, Math.min(safeWidth, Math.ceil(safeWidth * clamped)));
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, safeWidth - filled))}`;
}

function formatCountdownLabel(deadlineAt: number, now: number): string {
  const remaining = Math.max(0, deadlineAt - now);
  return `auto-dismisses in ${(remaining / 1000).toFixed(1)}s`;
}

function buildStatusLine(deadlineAt: number, now: number): string {
  return `Busy — press ESC ESC to interrupt • ${formatCountdownLabel(deadlineAt, now)}`;
}

function buildWarningWidgetLines(
  theme: Theme,
  width: number,
  deadlineAt: number,
  now: number,
  config: GuardConfig,
): string[] {
  const safeWidth = Math.max(1, width);
  const countdown = formatCountdownLabel(deadlineAt, now);
  const rawText = formatWarningTextLine(countdown, safeWidth);
  const label = '⚠ Busy';
  const rest = rawText.startsWith(label) ? rawText.slice(label.length) : rawText;
  const textLine = truncateToWidth(theme.fg('warning', label) + theme.fg('text', rest), safeWidth);

  const fraction = Math.max(0, deadlineAt - now) / config.warningTimeoutMs;
  const filledWidth = Math.max(0, Math.min(safeWidth, Math.ceil(safeWidth * fraction)));
  const emptyWidth = Math.max(0, safeWidth - filledWidth);
  const barLine =
    theme.fg('muted', '█'.repeat(filledWidth)) + theme.fg('dim', '░'.repeat(emptyWidth));

  return [textLine, barLine];
}

function buildWidgetRenderFallback(width: number, deadlineAt: number, now: number): string[] {
  return [truncateToWidth(buildStatusLine(deadlineAt, now), Math.max(1, width))];
}

type RuntimeState = {
  activeToolCalls: Set<string>;
  assistantStreaming: boolean;
  agentActive: boolean;
  submitPendingUntil: number;
  lastActivityAt: number;
  guardState: GuardState;
  busy: boolean;
  warningDeadlineAt: number;
  warningTimer?: ReturnType<typeof setTimeout>;
  warningEscCount: number;
  degradedWarningVisible: boolean;
  debugEvents: Array<Record<string, unknown>>;
};

function createRuntimeState(): RuntimeState {
  return {
    activeToolCalls: new Set<string>(),
    assistantStreaming: false,
    agentActive: false,
    submitPendingUntil: 0,
    lastActivityAt: Date.now(),
    guardState: { warningVisible: false, timestamps: [] },
    busy: false,
    warningDeadlineAt: 0,
    warningEscCount: 0,
    degradedWarningVisible: false,
    debugEvents: [],
  };
}

export default function safeEscape(pi: ExtensionAPI) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const config = DEFAULT_CONFIG;
  const state = createRuntimeState();
  let currentCtx: ExtensionContext | undefined;

  function isWarningVisible() {
    return state.guardState.warningVisible || state.degradedWarningVisible;
  }

  function readBusyInputs(ctx: ExtensionContext | undefined, now: number) {
    return {
      activeToolCount: state.activeToolCalls.size,
      assistantStreaming: state.assistantStreaming,
      agentActive: state.agentActive,
      submitPendingUntil: state.submitPendingUntil,
      submitPending: now < state.submitPendingUntil,
      hasPendingMessages: ctx ? ctx.hasPendingMessages() : null,
      isIdle: ctx ? ctx.isIdle() : null,
      lastActivityAt: state.lastActivityAt,
      now,
    };
  }

  function computeBusyFromInputs(inputs: ReturnType<typeof readBusyInputs>) {
    return (
      decideBusyState({
        activeToolCount: inputs.activeToolCount,
        assistantStreaming: inputs.assistantStreaming,
        agentActive: inputs.agentActive,
        submitPending: inputs.submitPending,
        hasPendingMessages: inputs.hasPendingMessages,
        isIdle: inputs.isIdle,
        lastActivityAt: inputs.lastActivityAt,
        now: inputs.now,
        config,
      }) === 'busy'
    );
  }

  function buildDebugBase(ctx: ExtensionContext | undefined, now: number) {
    const busyState = readBusyInputs(ctx, now);
    return {
      interactive,
      hasUI: ctx?.hasUI ?? currentCtx?.hasUI ?? false,
      busy: computeBusyFromInputs(busyState),
      warningVisible: state.guardState.warningVisible,
      degradedWarningVisible: state.degradedWarningVisible,
      warningEscCount: state.warningEscCount,
      warningDeadlineAt: state.warningDeadlineAt,
      timestamps: [...state.guardState.timestamps],
      busyState,
    };
  }

  function rememberDebugEvent(entry: Record<string, unknown>) {
    state.debugEvents = [...state.debugEvents.slice(-(MAX_DEBUG_EVENTS - 1)), entry];
  }

  function appendDebugEvent(
    event: string,
    details: Record<string, unknown> = {},
    source: 'runtime' | 'terminal-input' | 'lifecycle' | 'command' = 'runtime',
    ctx: ExtensionContext | undefined = currentCtx,
  ) {
    const now = Date.now();
    const entry = {
      kind: 'event',
      event,
      source,
      at: now,
      isoAt: new Date(now).toISOString(),
      ...buildDebugBase(ctx, now),
      ...details,
    };

    rememberDebugEvent(entry);
    return entry;
  }

  const behavior = createSafeEscapeBehavior({
    isBusy: () => (currentCtx ? readBusy(currentCtx, Date.now()) : false),
    isWarningVisible: () => isWarningVisible(),
    getTimestamps: () => state.guardState.timestamps,
    setTimestamps: (timestamps) => {
      state.guardState = { ...state.guardState, timestamps };
    },
    onBusyEscape: () => {
      if (currentCtx) {
        openWarning(currentCtx);
      }
    },
    onWarningEscape: () => handleWarningVisibleEscape(),
    onWarningDismiss: () => dismissWarning(),
    config,
  });

  registerExtensionEditorBehavior(pi, behavior);

  function touch(now = Date.now()) {
    state.lastActivityAt = now;
  }

  function clearTimer() {
    if (state.warningTimer) {
      clearTimeout(state.warningTimer);
      state.warningTimer = undefined;
    }
  }

  function clearWidget() {
    try {
      currentCtx?.ui.setWidget('safe-escape', undefined);
    } catch {
      // Ignore cleanup failures in degraded paths.
    }
  }

  function clearStatus() {
    try {
      currentCtx?.ui.setStatus('safe-escape', undefined);
    } catch {
      // Ignore cleanup failures in degraded paths.
    }
  }

  function updateDegradedStatus(now = Date.now()) {
    if (!currentCtx || !state.degradedWarningVisible) return;
    try {
      currentCtx.ui.setStatus('safe-escape', buildStatusLine(state.warningDeadlineAt, now));
    } catch {
      // Ignore double-failure fallback updates.
    }
  }

  function renderWarningWidget(now = Date.now()) {
    if (!currentCtx?.hasUI || !state.guardState.warningVisible) return;

    try {
      currentCtx.ui.setWidget('safe-escape', (_tui, theme) => ({
        render(width: number) {
          try {
            return buildWarningWidgetLines(theme, width, state.warningDeadlineAt, now, config);
          } catch {
            return buildWidgetRenderFallback(width, state.warningDeadlineAt, now);
          }
        },
        invalidate() {},
        dispose() {},
      }));
      state.degradedWarningVisible = false;
      clearStatus();
    } catch {
      clearWidget();
      state.degradedWarningVisible = true;
      updateDegradedStatus(now);
    }
  }

  function stopWarning() {
    clearTimer();
    clearWidget();
    state.degradedWarningVisible = false;
    clearStatus();
    state.warningEscCount = 0;
  }

  function hardReset(reason = 'hard-reset') {
    appendDebugEvent('hardReset', { reason });
    state.guardState = reduceGuardEvent(state.guardState, { type: 'hard-reset' });
    stopWarning();
  }

  function readBusy(ctx: ExtensionContext | undefined, now: number): boolean {
    const inputs = readBusyInputs(ctx, now);
    const previousBusy = state.busy;
    const next = computeBusyFromInputs(inputs);

    if (previousBusy !== next) {
      appendDebugEvent(
        'busy-transition',
        {
          previousBusy,
          nextBusy: next,
        },
        'runtime',
        ctx,
      );
    }

    if (state.busy && !next) {
      hardReset('busy-ended');
    }
    state.busy = next;
    return next;
  }

  function maybeAbort() {
    const ctx = currentCtx;
    if (!ctx) {
      appendDebugEvent('abortPath:no-context');
      return false;
    }

    const now = Date.now();
    appendDebugEvent('abortPath:reached', {}, 'runtime', ctx);
    if (!readBusy(ctx, now)) {
      appendDebugEvent('abortPath:not-busy', {}, 'runtime', ctx);
      return false;
    }

    hardReset('abort');
    ctx.abort();
    appendDebugEvent('abortPath:abort-called', {}, 'runtime', ctx);
    return true;
  }

  function handleTimeout() {
    appendDebugEvent('warningTimeout');
    state.guardState = reduceGuardEvent(state.guardState, { type: 'timeout' });
    stopWarning();
  }

  function scheduleWarningTick() {
    clearTimer();
    state.warningTimer = setTimeout(() => {
      const now = Date.now();
      if (!readBusy(currentCtx, now)) {
        return;
      }
      if (now >= state.warningDeadlineAt) {
        handleTimeout();
        return;
      }

      if (state.guardState.warningVisible) {
        renderWarningWidget(now);
      }
      if (state.degradedWarningVisible) {
        updateDegradedStatus(now);
      }
      scheduleWarningTick();
    }, 100);
  }

  function openWarning(ctx: ExtensionContext) {
    currentCtx = ctx;
    const now = Date.now();
    const busy = readBusy(ctx, now);
    if (!busy) {
      appendDebugEvent('openWarning:not-busy', {}, 'runtime', ctx);
      return false;
    }
    if (isWarningVisible()) {
      appendDebugEvent('openWarning:already-visible', {}, 'runtime', ctx);
      return true;
    }

    state.guardState = reduceGuardEvent(state.guardState, { type: 'open-warning' });
    state.warningDeadlineAt = now + config.warningTimeoutMs;
    state.warningEscCount = 1;
    renderWarningWidget(now);
    scheduleWarningTick();
    appendDebugEvent(
      'openWarning:opened',
      {
        warningDeadlineAt: state.warningDeadlineAt,
        note: SAFE_ESCAPE_CONTRACT,
      },
      'runtime',
      ctx,
    );
    return true;
  }

  function handleWarningVisibleEscape() {
    const now = Date.now();
    appendDebugEvent('warningEscape:reached');
    if (!readBusy(currentCtx, now)) {
      appendDebugEvent('warningEscape:not-busy');
      return false;
    }
    if (now >= state.warningDeadlineAt) {
      appendDebugEvent('warningEscape:expired');
      handleTimeout();
      return false;
    }

    const warningEscCountBefore = state.warningEscCount;
    const timestampsBefore = [...state.guardState.timestamps];
    const next = recordEscPress(state.guardState.timestamps, now, config);
    state.guardState = { ...state.guardState, timestamps: next.timestamps };
    if (!next.acceptedPress) {
      appendDebugEvent('warningEscape:debounced', {
        warningEscCountBefore,
        warningEscCountAfter: state.warningEscCount,
        timestampsBefore,
        nextTimestamps: next.timestamps,
      });
      return true;
    }

    state.warningEscCount += 1;
    if (state.warningEscCount >= config.escBypassCount) {
      state.guardState = reduceGuardEvent(state.guardState, { type: 'confirm' });
      appendDebugEvent('warningEscape:confirm-abort', {
        warningEscCountBefore,
        warningEscCountAfter: state.warningEscCount,
        timestampsBefore,
        nextTimestamps: next.timestamps,
      });
      return maybeAbort();
    }

    appendDebugEvent('warningEscape:armed', {
      warningEscCountBefore,
      warningEscCountAfter: state.warningEscCount,
      timestampsBefore,
      nextTimestamps: next.timestamps,
      note: SAFE_ESCAPE_CONTRACT,
    });
    return true;
  }

  function dismissWarning() {
    appendDebugEvent('warningDismissed');
    state.guardState = reduceGuardEvent(state.guardState, { type: 'dismiss' });
    hardReset('dismiss');
  }

  function resetSession(ctx: ExtensionContext, event: string) {
    currentCtx = ctx;
    state.activeToolCalls.clear();
    state.assistantStreaming = false;
    state.agentActive = false;
    state.submitPendingUntil = 0;
    state.busy = false;
    state.debugEvents = [];
    hardReset(`${event}:reset`);
    touch();
    appendDebugEvent(event, { reset: true }, 'lifecycle', ctx);
  }

  if (!interactive) return;

  pi.on('session_start', async (event, ctx) => {
    resetSession(ctx, `session_start:${event.reason}`);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    resetSession(ctx, 'session_shutdown');
  });

  pi.on('input', async (event, ctx) => {
    currentCtx = ctx;
    if (event.source === 'interactive') {
      state.submitPendingUntil = Date.now() + 1000;
      touch();
      state.busy = readBusy(ctx, Date.now());
    }
    appendDebugEvent(
      'input',
      {
        sourceEvent: event.source,
        textLength: typeof event.text === 'string' ? event.text.length : 0,
      },
      'lifecycle',
      ctx,
    );
    return { action: 'continue' as const };
  });

  pi.on('before_agent_start', async (_event, ctx) => {
    currentCtx = ctx;
    state.submitPendingUntil = 0;
    state.agentActive = true;
    touch();
    state.busy = readBusy(ctx, Date.now());
    appendDebugEvent('before_agent_start', {}, 'lifecycle', ctx);
  });

  pi.on('agent_start', async (_event, ctx) => {
    currentCtx = ctx;
    state.submitPendingUntil = 0;
    state.agentActive = true;
    touch();
    state.busy = readBusy(ctx, Date.now());
    appendDebugEvent('agent_start', {}, 'lifecycle', ctx);
  });

  pi.on('agent_end', async (_event, ctx) => {
    currentCtx = ctx;
    state.submitPendingUntil = 0;
    state.agentActive = false;
    touch();
    state.busy = readBusy(ctx, Date.now());
    appendDebugEvent('agent_end', {}, 'lifecycle', ctx);
  });

  pi.on('message_start', async (event, ctx) => {
    currentCtx = ctx;
    touch();
    if (classifyStreamingMessage(event.message.role as 'user' | 'assistant' | 'toolResult')) {
      state.assistantStreaming = true;
    }
    state.busy = readBusy(ctx, Date.now());
    appendDebugEvent('message_start', { role: event.message.role }, 'lifecycle', ctx);
  });

  pi.on('message_update', async (event, ctx) => {
    currentCtx = ctx;
    touch();
    if (classifyStreamingMessage(event.message.role as 'user' | 'assistant' | 'toolResult')) {
      state.assistantStreaming = true;
    }
    state.busy = readBusy(ctx, Date.now());
    appendDebugEvent('message_update', { role: event.message.role }, 'lifecycle', ctx);
  });

  pi.on('message_end', async (event, ctx) => {
    currentCtx = ctx;
    touch();
    if (classifyStreamingMessage(event.message.role as 'user' | 'assistant' | 'toolResult')) {
      state.assistantStreaming = false;
    }
    state.busy = readBusy(ctx, Date.now());
    appendDebugEvent('message_end', { role: event.message.role }, 'lifecycle', ctx);
  });

  pi.on('tool_execution_start', async (event, ctx) => {
    currentCtx = ctx;
    touch();
    state.activeToolCalls.add(event.toolCallId);
    state.busy = readBusy(ctx, Date.now());
    appendDebugEvent('tool_execution_start', { toolCallId: event.toolCallId }, 'lifecycle', ctx);
  });

  pi.on('tool_execution_end', async (event, ctx) => {
    currentCtx = ctx;
    touch();
    state.activeToolCalls.delete(event.toolCallId);
    state.busy = readBusy(ctx, Date.now());
    appendDebugEvent('tool_execution_end', { toolCallId: event.toolCallId }, 'lifecycle', ctx);
  });
}

export type SafeEscapeBehaviorHooks = {
  isBusy: () => boolean;
  isWarningVisible: () => boolean;
  getTimestamps: () => number[];
  setTimestamps: (timestamps: number[]) => void;
  onBusyEscape: () => void;
  onWarningEscape: () => boolean;
  onWarningDismiss: () => void;
  config: GuardConfig;
};

export function createSafeEscapeBehavior(hooks: SafeEscapeBehaviorHooks): EditorBehavior {
  return {
    id: 'safe-escape',
    priority: 10,
    beforeHandleInput(data) {
      if (hooks.isWarningVisible()) {
        if (isIgnoredEscapeTransitionInput(data)) {
          return true;
        }

        if (!isPlainEscapeInput(data)) {
          hooks.onWarningDismiss();
          return false;
        }

        return hooks.onWarningEscape();
      }

      if (!isPlainEscapeInput(data)) {
        return false;
      }

      if (!hooks.isBusy()) {
        return false;
      }

      const result = recordEscPress(hooks.getTimestamps(), Date.now(), hooks.config);
      hooks.setTimestamps(result.timestamps);
      if (result.acceptedPress) {
        hooks.onBusyEscape();
      }
      return true;
    },
  };
}
