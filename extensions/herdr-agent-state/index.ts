// Forked from Herdr's managed Pi integration:
// https://github.com/ogulcancelik/herdr/blob/master/src/integration/assets/pi/herdr-agent-state.ts
// Keep changes surgical and close to upstream so future Herdr updates are easy to diff.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createConnection } from 'node:net';

import { hasTui } from '../shared/ui-mode';

const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
const paneId = process.env.HERDR_PANE_ID;
const source = 'herdr:pi';

type AgentState = 'working' | 'blocked' | 'idle';
type Timer = ReturnType<typeof setTimeout>;

type QueuedState = {
  state: AgentState;
  message?: string;
  customStatus?: string;
  seq: number;
};

type StateSnapshot = {
  state: AgentState;
  message?: string;
  customStatus?: string;
};

type EventLike = {
  messages?: unknown[];
  toolCallId?: unknown;
};

type SessionContextLike = {
  sessionManager?: {
    getSessionFile?: () => unknown;
    getSessionId?: () => unknown;
  };
};

type BlockedEventLike = {
  active?: boolean;
  label?: string;
};

type SessionShutdownEventLike = {
  reason?: unknown;
};

const idleDebounceMs = parseDurationEnv('HERDR_PI_IDLE_DEBOUNCE_MS', 250);
const retryGraceMs = parseDurationEnv('HERDR_PI_RETRY_GRACE_MS', 2500);
// Herdr reports are best-effort over a short-lived socket; reassert active
// states so one dropped transition cannot leave a pane stuck on stale Idle.
const activeHeartbeatMs = parseDurationEnv('HERDR_PI_ACTIVE_HEARTBEAT_MS', 2000);
const retryableErrorPattern =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

let reportSeq = Date.now() * 1000;
let currentAgentSessionId: string | undefined;
let currentAgentSessionPath: string | undefined;
let sendInFlight = false;
let queuedState: QueuedState | undefined;

function enabled(): boolean {
  return HERDR_ENV === '1' && Boolean(socketPath) && Boolean(paneId);
}

function hasHerdrPaneEnv(): boolean {
  return HERDR_ENV === '1' && Boolean(paneId);
}

function isSubagentChildProcess(): boolean {
  return process.env.PI_SUBAGENT_CHILD === '1';
}

function nextReportSeq(): number {
  reportSeq += 1;
  return reportSeq;
}

function parseDurationEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function sendRequest(request: unknown): Promise<void> {
  if (!enabled()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let done = false;
    const socket = createConnection(socketPath!);
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      resolve();
    };

    socket.on('error', finish);
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', finish);
    socket.on('end', finish);
    const timeout = setTimeout(finish, 500);
    timeout.unref?.();
  });
}

function updateSessionRef(ctx: SessionContextLike | undefined): void {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    currentAgentSessionPath = typeof file === 'string' && file.startsWith('/') ? file : undefined;
  } catch {
    currentAgentSessionPath = undefined;
  }

  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    currentAgentSessionId = typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch {
    currentAgentSessionId = undefined;
  }
}

function withSessionRef(params: Record<string, unknown>): Record<string, unknown> {
  if (currentAgentSessionPath) {
    return { ...params, agent_session_path: currentAgentSessionPath };
  }
  if (currentAgentSessionId) {
    return { ...params, agent_session_id: currentAgentSessionId };
  }
  return params;
}

function sendState(
  state: AgentState,
  message?: string,
  customStatus?: string,
  seq = nextReportSeq(),
): Promise<void> {
  return sendRequest({
    id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: 'pane.report_agent',
    params: withSessionRef({
      pane_id: paneId,
      source,
      agent: 'pi',
      state,
      message,
      custom_status: customStatus,
      seq,
    }),
  });
}

function queueState(state: AgentState, message?: string, customStatus?: string): void {
  queuedState = { state, message, customStatus, seq: nextReportSeq() };
  if (!sendInFlight) {
    void drainStateQueue();
  }
}

async function drainStateQueue(): Promise<void> {
  if (sendInFlight) {
    return;
  }

  sendInFlight = true;
  try {
    while (queuedState) {
      const next = queuedState;
      queuedState = undefined;
      await sendState(next.state, next.message, next.customStatus, next.seq);
    }
  } finally {
    sendInFlight = false;
    if (queuedState) {
      void drainStateQueue();
    }
  }
}

function lastAssistantMessage(messages: unknown[]): Record<string, unknown> | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (
      message &&
      typeof message === 'object' &&
      (message as { role?: unknown }).role === 'assistant'
    ) {
      return message as Record<string, unknown>;
    }
  }
  return undefined;
}

function retryableErrorMessage(event: EventLike): string | undefined {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const assistant = lastAssistantMessage(messages);
  if (assistant?.stopReason !== 'error') {
    return undefined;
  }

  const errorMessage = typeof assistant.errorMessage === 'string' ? assistant.errorMessage : '';
  if (!retryableErrorPattern.test(errorMessage)) {
    return undefined;
  }
  return errorMessage || 'retryable provider error';
}

function releaseAgent(): Promise<void> {
  return sendRequest({
    id: `${source}:release:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: 'pane.release_agent',
    params: {
      pane_id: paneId,
      source,
      agent: 'pi',
      seq: nextReportSeq(),
    },
  });
}

function toolCallId(event: EventLike): string | undefined {
  const id = event?.toolCallId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);

  if (totalMinutes === 0) {
    return `${seconds}s`;
  }

  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours === 0) {
    return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  }
  return `${hours}h${minutes.toString().padStart(2, '0')}m`;
}

export default function herdrAgentState(pi: ExtensionAPI): void {
  if (!hasHerdrPaneEnv() || isSubagentChildProcess()) {
    return;
  }

  const stateReportingEnabled = enabled();

  if (!stateReportingEnabled) {
    return;
  }

  let agentActive = false;
  let retryHoldActive = false;
  let failureBlocked = false;
  let failureMessage: string | undefined;
  let blockedCount = 0;
  let blockedMessage: string | undefined;
  // Track tool execution independently so a late/duplicate agent_end cannot
  // publish Idle while Pi is still running long-lived tool work.
  const activeToolCalls = new Set<string>();
  let currentState: AgentState | undefined;
  let stateEnteredAt = Date.now();
  let activeRunStartedAt: number | undefined;
  let lastRunDurationMs: number | undefined;
  let lastState: AgentState | undefined;
  let lastMessage: string | undefined;
  let lastCustomStatus: string | undefined;
  let idleTimer: Timer | undefined;
  let retryTimer: Timer | undefined;
  let activeHeartbeatTimer: Timer | undefined;
  let stateReportingActive = false;

  function clearTimer(timer: Timer | undefined): void {
    if (timer) {
      clearTimeout(timer);
    }
  }

  function clearPendingTimers(): void {
    clearTimer(idleTimer);
    clearTimer(retryTimer);
    clearTimer(activeHeartbeatTimer);
    idleTimer = undefined;
    retryTimer = undefined;
    activeHeartbeatTimer = undefined;
  }

  function clearFailureState(): void {
    retryHoldActive = false;
    failureBlocked = false;
    failureMessage = undefined;
  }

  function startActiveRun(): void {
    activeRunStartedAt ??= Date.now();
    lastRunDurationMs = undefined;
  }

  function finishActiveRun(now: number): void {
    if (activeRunStartedAt === undefined) {
      return;
    }
    lastRunDurationMs = Math.max(0, now - activeRunStartedAt);
    activeRunStartedAt = undefined;
  }

  function desiredState(): { state: AgentState; message?: string } {
    if (blockedCount > 0) {
      return { state: 'blocked', message: blockedMessage };
    }
    if (failureBlocked) {
      return { state: 'blocked', message: failureMessage };
    }
    if (agentActive || activeToolCalls.size > 0 || retryHoldActive) {
      return { state: 'working' };
    }
    return { state: 'idle' };
  }

  function customStatusForState(state: AgentState, now: number): string | undefined {
    if (state === 'working') {
      return formatDuration(now - (activeRunStartedAt ?? now));
    }
    if (state === 'blocked') {
      return formatDuration(now - stateEnteredAt);
    }
    if (lastRunDurationMs !== undefined) {
      return `took ${formatDuration(lastRunDurationMs)}`;
    }
    return undefined;
  }

  function snapshotState(): StateSnapshot {
    const next = desiredState();
    const now = Date.now();
    if (next.state !== currentState) {
      if (next.state === 'idle') {
        finishActiveRun(now);
      }
      currentState = next.state;
      stateEnteredAt = now;
    }
    return {
      ...next,
      customStatus: customStatusForState(next.state, now),
    };
  }

  function refreshActiveHeartbeat(state: AgentState): void {
    clearTimer(activeHeartbeatTimer);
    activeHeartbeatTimer = undefined;

    if (state === 'idle' || activeHeartbeatMs <= 0) {
      return;
    }

    activeHeartbeatTimer = setTimeout(() => {
      activeHeartbeatTimer = undefined;
      publishState(true);
    }, activeHeartbeatMs);
    activeHeartbeatTimer.unref?.();
  }

  function publishState(force = false): void {
    const next = snapshotState();
    const changed =
      next.state !== lastState ||
      next.message !== lastMessage ||
      next.customStatus !== lastCustomStatus;
    if (force || changed) {
      lastState = next.state;
      lastMessage = next.message;
      lastCustomStatus = next.customStatus;
      queueState(next.state, next.message, next.customStatus);
    }
    refreshActiveHeartbeat(next.state);
  }

  function scheduleIdle(): void {
    clearPendingTimers();
    clearFailureState();
    if (desiredState().state !== 'idle') {
      publishState(true);
      return;
    }
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      publishState();
    }, idleDebounceMs);
    idleTimer.unref?.();
  }

  function holdForRetry(message: string): void {
    clearPendingTimers();
    startActiveRun();
    retryHoldActive = true;
    failureBlocked = false;
    failureMessage = message;
    publishState(true);

    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      retryHoldActive = false;
      failureBlocked = true;
      publishState();
    }, retryGraceMs);
    retryTimer.unref?.();
  }

  function publishOrScheduleIdleAfterActivity(): void {
    if (desiredState().state === 'idle') {
      scheduleIdle();
      return;
    }
    publishState(true);
  }

  pi.on('session_start', (_event, ctx) => {
    if (!hasTui(ctx)) {
      stateReportingActive = false;
      activeToolCalls.clear();
      clearPendingTimers();
      return;
    }

    stateReportingActive = true;
    updateSessionRef(ctx as SessionContextLike | undefined);
    publishState(true);
  });

  pi.events.on('herdr:blocked', (data: unknown) => {
    if (!stateReportingActive) {
      return;
    }

    const blocked = data as BlockedEventLike | undefined;
    if (!blocked?.active) {
      blockedCount = Math.max(0, blockedCount - 1);
      if (blockedCount === 0) {
        blockedMessage = undefined;
      }
      publishState(true);
      return;
    }

    clearPendingTimers();
    startActiveRun();
    blockedCount += 1;
    blockedMessage = blocked.label;
    publishState(true);
  });

  pi.on('agent_start', (_event, ctx) => {
    if (!stateReportingActive || !hasTui(ctx)) {
      return;
    }

    clearPendingTimers();
    clearFailureState();
    startActiveRun();
    agentActive = true;
    publishState(true);
  });

  pi.on('tool_execution_start', (event, ctx) => {
    if (!stateReportingActive || !hasTui(ctx)) {
      return;
    }

    const id = toolCallId(event as EventLike);
    if (id) {
      activeToolCalls.add(id);
    }
    startActiveRun();
    clearTimer(idleTimer);
    idleTimer = undefined;
    clearFailureState();
    publishState(true);
  });

  pi.on('tool_execution_end', (event, ctx) => {
    if (!stateReportingActive || !hasTui(ctx)) {
      return;
    }

    const id = toolCallId(event as EventLike);
    if (id) {
      activeToolCalls.delete(id);
    }
    publishOrScheduleIdleAfterActivity();
  });

  pi.on('agent_end', (event, ctx) => {
    if (!stateReportingActive || !hasTui(ctx)) {
      return;
    }

    if (!agentActive) {
      // Pi can emit duplicate/late end events while auto-retry is already
      // holding the pane in Working. Do not let an unqualified duplicate end
      // cancel the retry hold and publish a false Idle.
      return;
    }

    agentActive = false;

    const retryableMessage = retryableErrorMessage(event as EventLike);
    if (retryableMessage) {
      holdForRetry(retryableMessage);
      return;
    }

    publishOrScheduleIdleAfterActivity();
  });

  pi.on('session_shutdown', async (event) => {
    if (!stateReportingActive) {
      return;
    }

    stateReportingActive = false;
    activeToolCalls.clear();
    clearPendingTimers();

    // Pi reloads tear down and recreate extension runtimes while keeping the
    // same process and session file. Releasing Herdr authority here causes
    // Herdr's graceful-exit suppression to ignore subsequent same-session
    // reports, leaving the pane stuck on screen-detection Idle/Done.
    if ((event as SessionShutdownEventLike | undefined)?.reason === 'reload') {
      return;
    }

    await releaseAgent();
  });
}
