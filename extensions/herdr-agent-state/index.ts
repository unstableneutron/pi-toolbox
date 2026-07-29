// Forked from Herdr's managed Pi integration:
// https://github.com/ogulcancelik/herdr/blob/master/src/integration/assets/pi/herdr-agent-state.ts
// Upstream baseline: HERDR_INTEGRATION_VERSION=7.
// Keep changes surgical and close to upstream so future Herdr updates are easy to diff.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import net from 'node:net';

import { hasTui } from '../shared/ui-mode';

const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
const socketEndpoint =
  process.platform === 'win32' && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
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

type SessionContextLike = {
  isIdle?: () => unknown;
  sessionManager?: {
    getSessionFile?: () => unknown;
    getSessionId?: () => unknown;
  };
};

type SessionStartEventLike = {
  reason?: string;
};

type BlockedEventLike = {
  active?: boolean;
  label?: string;
};

// Heartbeats refresh the local elapsed-time customization while upstream's
// socket retry protects each individual report from transient delivery loss.
const activeHeartbeatMs = parseDurationEnv('HERDR_PI_ACTIVE_HEARTBEAT_MS', 2000);

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

function sendRequestAttempt(request: unknown, timeoutMs: number): Promise<boolean> {
  if (!enabled()) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let done = false;
    let timeout: Timer | undefined;
    const socket = net.createConnection(socketEndpoint!);
    const finish = (delivered: boolean) => {
      if (done) {
        return;
      }
      done = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      socket.destroy();
      resolve(delivered);
    };

    socket.on('error', () => finish(false));
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', () => finish(true));
    socket.on('end', () => finish(false));
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
  });
}

async function sendRequest(request: unknown): Promise<void> {
  if (await sendRequestAttempt(request, 500)) {
    return;
  }
  await sendRequestAttempt(request, 1500);
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

function currentSessionRef(): Record<string, unknown> | undefined {
  if (currentAgentSessionPath) {
    return { agent_session_path: currentAgentSessionPath };
  }
  if (currentAgentSessionId) {
    return { agent_session_id: currentAgentSessionId };
  }
  return undefined;
}

function withSessionRef(params: Record<string, unknown>): Record<string, unknown> {
  const sessionRef = currentSessionRef();
  return sessionRef ? { ...params, ...sessionRef } : params;
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

function reportSession(sessionStartSource?: string): Promise<void> {
  const sessionRef = currentSessionRef();
  if (!sessionRef) {
    return Promise.resolve();
  }

  return sendRequest({
    id: `${source}:session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: 'pane.report_agent_session',
    params: {
      pane_id: paneId,
      source,
      agent: 'pi',
      seq: nextReportSeq(),
      session_start_source: sessionStartSource,
      ...sessionRef,
    },
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
  let blockedCount = 0;
  let blockedMessage: string | undefined;
  let currentState: AgentState | undefined;
  let stateEnteredAt = Date.now();
  let activeRunStartedAt: number | undefined;
  let lastRunDurationMs: number | undefined;
  let lastState: AgentState | undefined;
  let lastMessage: string | undefined;
  let lastCustomStatus: string | undefined;
  let activeHeartbeatTimer: Timer | undefined;
  let rootSession = false;

  function clearActiveHeartbeat(): void {
    if (activeHeartbeatTimer) {
      clearTimeout(activeHeartbeatTimer);
      activeHeartbeatTimer = undefined;
    }
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
    if (agentActive) {
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
    clearActiveHeartbeat();

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

  pi.events.on('herdr:blocked', (data: unknown) => {
    if (!rootSession) {
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

    startActiveRun();
    blockedCount += 1;
    blockedMessage = blocked.label;
    publishState(true);
  });

  pi.on('session_start', async (event, ctx) => {
    if (!hasTui(ctx)) {
      rootSession = false;
      clearActiveHeartbeat();
      return;
    }

    rootSession = true;
    updateSessionRef(ctx as SessionContextLike | undefined);
    await reportSession((event as SessionStartEventLike | undefined)?.reason);

    // A reload can replace this extension mid-run without another agent_start.
    agentActive = (ctx as SessionContextLike | undefined)?.isIdle?.() === false;
    if (agentActive) {
      startActiveRun();
    }
    publishState(true);
  });

  pi.on('agent_start', (_event, ctx) => {
    if (!rootSession || !hasTui(ctx)) {
      return;
    }

    updateSessionRef(ctx as SessionContextLike | undefined);
    void reportSession();
    startActiveRun();
    agentActive = true;
    publishState(true);
  });

  pi.on('agent_settled', (_event, ctx) => {
    if (
      !rootSession ||
      !hasTui(ctx) ||
      (ctx as SessionContextLike | undefined)?.isIdle?.() !== true
    ) {
      return;
    }

    agentActive = false;
    publishState(true);
  });
}
