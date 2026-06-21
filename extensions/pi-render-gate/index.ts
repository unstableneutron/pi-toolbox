import net from 'node:net';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';

import { hasTui } from '../shared/ui-mode';

const STATUS_KEY = 'pi-render-gate';
const WIDGET_KEY = 'pi-render-gate:capture';
const WORKSPACE_REQUEST_ID = 'pi-render-gate:workspace';
const SUBSCRIBE_REQUEST_ID = 'pi-render-gate:subscribe';
const DEFAULT_SOCKET_TIMEOUT_MS = 5000;
const DEFAULT_HIDDEN_FLUSH_DELAY_MS = 100;

type RequestRender = (force?: boolean) => void;

export interface RenderGate {
  flushOnce(): void;
  isActive(): boolean;
  restore(): void;
  setActive(active: boolean): void;
}

interface PatchableTui {
  requestRender: RequestRender;
}

export interface HerdrIds {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface HerdrWorkspaceVisibility {
  focused?: boolean;
  active_tab_id?: string;
}

export interface HerdrClient {
  request(message: unknown): Promise<unknown>;
  subscribe(
    message: unknown,
    onMessage: (message: unknown) => void,
    onError?: (error: Error) => void,
  ): () => void;
}

interface SubscribeToHerdrVisibilityOptions {
  client: HerdrClient;
  ids: HerdrIds;
  onError?: (error: Error) => void;
  setActive(this: void, active: boolean): void;
}

interface PiRenderGateOptions {
  createHerdrClient?: (socketPath: string) => HerdrClient;
  onError?: (error: Error) => void;
}

const gates = new WeakMap<object, RenderGate>();

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function getString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function getBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  const candidate = value[key];
  return typeof candidate === 'boolean' ? candidate : undefined;
}

function getHerdrIds(env: NodeJS.ProcessEnv): HerdrIds | undefined {
  if (!isHerdrEnv(env)) return undefined;
  return {
    workspaceId: env.HERDR_WORKSPACE_ID,
    tabId: env.HERDR_TAB_ID,
    paneId: env.HERDR_PANE_ID,
  };
}

function createWorkspaceGetRequest(ids: HerdrIds): unknown {
  return {
    id: WORKSPACE_REQUEST_ID,
    method: 'workspace.get',
    params: { workspace_id: ids.workspaceId },
  };
}

function createEventsSubscribeRequest(): unknown {
  return {
    id: SUBSCRIBE_REQUEST_ID,
    method: 'events.subscribe',
    params: {
      subscriptions: [{ type: 'workspace.focused' }, { type: 'tab.focused' }],
    },
  };
}

function extractWorkspace(message: unknown): HerdrWorkspaceVisibility | undefined {
  if (!isObject(message) || !isObject(message.result) || !isObject(message.result.workspace)) {
    return undefined;
  }

  return {
    focused: getBoolean(message.result.workspace, 'focused'),
    active_tab_id: getString(message.result.workspace, 'active_tab_id'),
  };
}

function extractEvent(
  message: unknown,
): { event: string; data: Record<string, unknown> } | undefined {
  if (!isObject(message) || !isObject(message.data)) return undefined;
  const event = getString(message, 'event') ?? getString(message.data, 'type');
  if (!event) return undefined;
  return { event, data: message.data };
}

function isSocketPathAvailable(
  env: NodeJS.ProcessEnv,
): env is NodeJS.ProcessEnv & { HERDR_SOCKET_PATH: string } {
  return typeof env.HERDR_SOCKET_PATH === 'string' && env.HERDR_SOCKET_PATH.length > 0;
}

function writeJsonLine(socket: net.Socket, message: unknown): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

function parseJsonLine(line: string): unknown {
  return JSON.parse(line) as unknown;
}

function protocolError(message: unknown): Error {
  if (isObject(message)) {
    const error = message.error;
    if (isObject(error) && typeof error.message === 'string') {
      return new Error(error.message);
    }
    if (typeof error === 'string') {
      return new Error(error);
    }
  }

  return new Error('Herdr socket returned an error response');
}

function socketRequest(
  socketPath: string,
  message: unknown,
  timeoutMs = DEFAULT_SOCKET_TIMEOUT_MS,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(
      () => settle(new Error(`Timed out waiting for Herdr response after ${timeoutMs}ms`)),
      timeoutMs,
    );

    const settle = (result: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    socket.on('connect', () => writeJsonLine(socket, message));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          try {
            settle(parseJsonLine(line));
          } catch (error) {
            settle(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('error', settle);
    socket.on('close', () =>
      settle(new Error('Herdr socket closed before a response was received')),
    );
  });
}

export function createHerdrClient(socketPath: string): HerdrClient {
  return {
    request: (message) => socketRequest(socketPath, message),
    subscribe(message, onMessage, onError) {
      let buffer = '';
      let closed = false;
      const socket = net.createConnection(socketPath);

      const close = (): void => {
        if (closed) return;
        closed = true;
        socket.destroy();
      };

      socket.on('connect', () => writeJsonLine(socket, message));
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) {
            try {
              const parsed = parseJsonLine(line);
              if (isObject(parsed)) {
                if ('error' in parsed) {
                  onError?.(protocolError(parsed));
                  close();
                  return;
                }

                onMessage(parsed);
              }
            } catch (error) {
              onError?.(error instanceof Error ? error : new Error(String(error)));
            }
          }
          newline = buffer.indexOf('\n');
        }
      });
      socket.on('error', (error) => onError?.(error));
      socket.on('close', () => {
        if (!closed) {
          onError?.(new Error('Herdr event subscription closed'));
        }
      });

      return close;
    },
  };
}

export function createRenderGate(tui: PatchableTui): RenderGate {
  const existing = gates.get(tui);
  if (existing) return existing;

  const originalRequestRender = tui.requestRender.bind(tui);
  let active = true;
  let dirty = false;
  let forceDirty = false;
  let restored = false;

  const patchedRequestRender: RequestRender = (force = false) => {
    if (restored || active) {
      originalRequestRender(force);
      return;
    }

    dirty = true;
    forceDirty = forceDirty || force;
  };

  tui.requestRender = patchedRequestRender;

  const gate: RenderGate = {
    flushOnce() {
      if (restored) return;
      dirty = false;
      forceDirty = false;
      originalRequestRender(true);
    },
    isActive: () => active,
    restore() {
      if (restored) return;
      restored = true;
      tui.requestRender = originalRequestRender;
      gates.delete(tui);
    },
    setActive(nextActive: boolean) {
      if (restored || active === nextActive) return;
      active = nextActive;
      if (!active || !dirty) return;

      const shouldForce = forceDirty;
      dirty = false;
      forceDirty = false;
      originalRequestRender(shouldForce);
    },
  };

  gates.set(tui, gate);
  return gate;
}

export function shouldRenderForWorkspace(
  workspace: HerdrWorkspaceVisibility,
  ids: HerdrIds,
): boolean {
  return workspace.focused === true && workspace.active_tab_id === ids.tabId;
}

export function subscribeToHerdrVisibility({
  client,
  ids,
  onError,
  setActive,
}: SubscribeToHerdrVisibilityOptions): () => void {
  let disposed = false;
  let refreshInFlight = false;
  let refreshQueued = false;
  let lastActive: boolean | undefined;

  const applyActive = (active: boolean): void => {
    if (disposed || lastActive === active) return;
    lastActive = active;
    setActive(active);
  };

  const refreshWorkspace = (): void => {
    if (disposed) return;
    if (refreshInFlight) {
      refreshQueued = true;
      return;
    }

    refreshInFlight = true;
    void client
      .request(createWorkspaceGetRequest(ids))
      .then((message) => {
        const workspace = extractWorkspace(message);
        if (!workspace) {
          onError?.(new Error('Invalid Herdr workspace.get response'));
          applyActive(true);
          return;
        }
        applyActive(shouldRenderForWorkspace(workspace, ids));
      })
      .catch((error: unknown) => {
        onError?.(error instanceof Error ? error : new Error(String(error)));
        applyActive(true);
      })
      .finally(() => {
        refreshInFlight = false;
        if (refreshQueued) {
          refreshQueued = false;
          refreshWorkspace();
        }
      });
  };

  const handleEvent = (message: unknown): void => {
    const parsed = extractEvent(message);
    if (!parsed) return;

    if (parsed.event === 'workspace_focused' || parsed.event === 'workspace.focused') {
      refreshWorkspace();
      return;
    }

    if (parsed.event === 'tab_focused' || parsed.event === 'tab.focused') {
      const workspaceId = getString(parsed.data, 'workspace_id');
      if (workspaceId !== ids.workspaceId) return;
      refreshWorkspace();
    }
  };

  refreshWorkspace();
  const unsubscribe = client.subscribe(createEventsSubscribeRequest(), handleEvent, (error) => {
    onError?.(error);
    applyActive(true);
  });

  return () => {
    disposed = true;
    unsubscribe();
  };
}

export function isHerdrEnv(env: NodeJS.ProcessEnv): env is NodeJS.ProcessEnv & {
  HERDR_ENV: '1';
  HERDR_PANE_ID: string;
  HERDR_SOCKET_PATH: string;
  HERDR_TAB_ID: string;
  HERDR_WORKSPACE_ID: string;
} {
  return (
    env.HERDR_ENV === '1' &&
    isSocketPathAvailable(env) &&
    typeof env.HERDR_WORKSPACE_ID === 'string' &&
    env.HERDR_WORKSPACE_ID.length > 0 &&
    typeof env.HERDR_TAB_ID === 'string' &&
    env.HERDR_TAB_ID.length > 0 &&
    typeof env.HERDR_PANE_ID === 'string' &&
    env.HERDR_PANE_ID.length > 0
  );
}

class InvisibleComponent implements Component {
  invalidate(): void {}

  render(_width: number): string[] {
    return [];
  }
}

function installForSession(
  ctx: ExtensionContext,
  ids: HerdrIds,
  client: HerdrClient,
  onError?: (error: Error) => void,
  onGate?: (gate: RenderGate | undefined) => void,
): () => void {
  let gate: RenderGate | undefined;

  ctx.ui.setWidget(
    WIDGET_KEY,
    (tui: TUI) => {
      gate = createRenderGate(tui);
      return new InvisibleComponent();
    },
    { placement: 'belowEditor' },
  );

  if (!gate) {
    onGate?.(undefined);
    return () => {};
  }
  onGate?.(gate);

  const unsubscribe = subscribeToHerdrVisibility({
    client,
    ids,
    onError,
    setActive: (active) => {
      if (active) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        gate?.setActive(true);
      } else {
        ctx.ui.setStatus(STATUS_KEY, 'render paused');
        gate?.setActive(false);
      }
    },
  });

  return () => {
    unsubscribe();
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: 'belowEditor' });
    gate?.restore();
    onGate?.(undefined);
  };
}

export function createPiRenderGateExtension(
  pi: ExtensionAPI,
  env: NodeJS.ProcessEnv = process.env,
  options: PiRenderGateOptions = {},
): void {
  const ids = getHerdrIds(env);
  const socketPath = env.HERDR_SOCKET_PATH;
  if (
    !ids ||
    env.PI_RENDER_GATE_DISABLED === '1' ||
    typeof socketPath !== 'string' ||
    socketPath.length === 0
  )
    return;

  let cleanup: (() => void) | undefined;
  let currentGate: RenderGate | undefined;
  let hiddenFlushTimer: ReturnType<typeof setTimeout> | undefined;

  const clearHiddenFlushTimer = (): void => {
    if (!hiddenFlushTimer) return;
    clearTimeout(hiddenFlushTimer);
    hiddenFlushTimer = undefined;
  };

  const scheduleHiddenFlush = (ctx: ExtensionContext): void => {
    if (!hasTui(ctx) || !currentGate || currentGate.isActive()) return;
    clearHiddenFlushTimer();
    hiddenFlushTimer = setTimeout(() => {
      hiddenFlushTimer = undefined;
      if (!currentGate?.isActive()) currentGate?.flushOnce();
    }, DEFAULT_HIDDEN_FLUSH_DELAY_MS);
    hiddenFlushTimer.unref?.();
  };

  pi.on('session_start', (_event, ctx) => {
    clearHiddenFlushTimer();
    cleanup?.();
    cleanup = undefined;
    currentGate = undefined;
    if (!hasTui(ctx)) return;

    const createClient = options.createHerdrClient ?? createHerdrClient;
    cleanup = installForSession(ctx, ids, createClient(socketPath), options.onError, (gate) => {
      currentGate = gate;
    });
  });

  pi.on('agent_start', (_event, ctx) => {
    scheduleHiddenFlush(ctx);
  });

  pi.on('agent_end', (_event, ctx) => {
    scheduleHiddenFlush(ctx);
  });

  pi.on('message_end', (_event, ctx) => {
    scheduleHiddenFlush(ctx);
  });

  pi.on('tool_execution_end', (_event, ctx) => {
    scheduleHiddenFlush(ctx);
  });

  pi.on('turn_end', (_event, ctx) => {
    scheduleHiddenFlush(ctx);
  });

  pi.on('user_bash', (_event, ctx) => {
    scheduleHiddenFlush(ctx);
  });

  pi.on('session_shutdown', () => {
    clearHiddenFlushTimer();
    cleanup?.();
    cleanup = undefined;
    currentGate = undefined;
  });
}

export default function piRenderGateExtension(pi: ExtensionAPI): void {
  createPiRenderGateExtension(pi);
}
