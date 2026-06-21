import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createHerdrClient,
  createPiRenderGateExtension,
  createRenderGate,
  type HerdrClient,
  isHerdrEnv,
  shouldRenderForWorkspace,
  subscribeToHerdrVisibility,
} from './index';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

class MemoryHerdrClient implements HerdrClient {
  readonly requests: unknown[] = [];
  readonly subscriptions: Array<{ request: unknown; onMessage: (message: unknown) => void }> = [];
  readonly responses: unknown[];
  unsubscribes = 0;

  constructor(responses: unknown[] = []) {
    this.responses = [...responses];
  }

  async request(message: unknown): Promise<unknown> {
    this.requests.push(message);
    const response = this.responses.shift();
    if (!response) {
      throw new Error('Missing memory Herdr response');
    }
    return response;
  }

  subscribe(message: unknown, onMessage: (message: unknown) => void): () => void {
    this.subscriptions.push({ request: message, onMessage });
    return () => {
      this.unsubscribes += 1;
    };
  }

  emitEvent(message: unknown): void {
    const subscription = this.subscriptions.at(-1);
    if (!subscription) {
      throw new Error('No active subscription');
    }
    subscription.onMessage(message);
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(condition()).toBe(true);
}

async function withSocketServer(
  handler: (socket: net.Socket) => void,
  run: (socketPath: string) => Promise<void>,
): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-render-gate-socket-'));
  const socketPath = path.join(directory, 'herdr.sock');
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    handler(socket);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await run(socketPath);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function response(id: string, result: unknown) {
  return { id, result };
}

function event(eventName: string, data: unknown) {
  return { event: eventName, data };
}

function getSessionStartHandler(on: ReturnType<typeof vi.fn>) {
  const call = on.mock.calls.find(([eventName]) => eventName === 'session_start');
  if (!call) throw new Error('Missing session_start handler');
  return call[1] as (event: unknown, ctx: any) => void;
}

function getHandler(on: ReturnType<typeof vi.fn>, eventName: string) {
  const call = on.mock.calls.find(([candidate]) => candidate === eventName);
  if (!call) throw new Error(`Missing ${eventName} handler`);
  return call[1] as (event: unknown, ctx: any) => void;
}

describe('createRenderGate', () => {
  test('skips renders while inactive and flushes one dirty render when reactivated', () => {
    const requestRender = vi.fn();
    const tui = { requestRender } as any;
    const gate = createRenderGate(tui);

    gate.setActive(false);
    tui.requestRender();
    tui.requestRender(true);

    expect(requestRender).not.toHaveBeenCalled();

    gate.setActive(true);

    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(requestRender).toHaveBeenCalledWith(true);
  });

  test('restores the original requestRender implementation', () => {
    const requestRender = vi.fn();
    const tui = { requestRender } as any;
    const gate = createRenderGate(tui);

    gate.restore();
    tui.requestRender(true);

    expect(requestRender).toHaveBeenCalledWith(true);
  });

  test('flushes one forced render while inactive without reopening the gate', () => {
    const requestRender = vi.fn();
    const tui = { requestRender } as any;
    const gate = createRenderGate(tui);

    gate.setActive(false);
    tui.requestRender();

    gate.flushOnce();

    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(requestRender).toHaveBeenCalledWith(true);
    expect(gate.isActive()).toBe(false);

    gate.setActive(true);

    expect(requestRender).toHaveBeenCalledTimes(1);
  });
});

describe('Herdr visibility', () => {
  test('detects when the current workspace active tab matches the pane tab', () => {
    expect(
      shouldRenderForWorkspace(
        { focused: true, active_tab_id: 'w2:t1' },
        { workspaceId: 'w2', tabId: 'w2:t1', paneId: 'w2:p1' },
      ),
    ).toBe(true);

    expect(
      shouldRenderForWorkspace(
        { focused: true, active_tab_id: 'w2:t2' },
        { workspaceId: 'w2', tabId: 'w2:t1', paneId: 'w2:p1' },
      ),
    ).toBe(false);

    expect(
      shouldRenderForWorkspace(
        { focused: false, active_tab_id: 'w2:t1' },
        { workspaceId: 'w2', tabId: 'w2:t1', paneId: 'w2:p1' },
      ),
    ).toBe(false);
  });

  test('subscribes to tab and workspace focus events and updates render state', () => {
    const client = new MemoryHerdrClient([
      response('pi-render-gate:workspace', {
        type: 'workspace_info',
        workspace: { focused: true, active_tab_id: 'w2:t1' },
      }),
      response('pi-render-gate:workspace', {
        type: 'workspace_info',
        workspace: { focused: true, active_tab_id: 'w2:t2' },
      }),
      response('pi-render-gate:workspace', {
        type: 'workspace_info',
        workspace: { focused: false, active_tab_id: 'w2:t2' },
      }),
      response('pi-render-gate:workspace', {
        type: 'workspace_info',
        workspace: { focused: true, active_tab_id: 'w2:t1' },
      }),
    ]);
    const setActive = vi.fn();

    subscribeToHerdrVisibility({
      client,
      ids: { workspaceId: 'w2', tabId: 'w2:t1', paneId: 'w2:p1' },
      setActive,
    });

    expect(client.requests).toEqual([
      { id: 'pi-render-gate:workspace', method: 'workspace.get', params: { workspace_id: 'w2' } },
    ]);
    expect(client.subscriptions[0]?.request).toEqual({
      id: 'pi-render-gate:subscribe',
      method: 'events.subscribe',
      params: {
        subscriptions: [{ type: 'workspace.focused' }, { type: 'tab.focused' }],
      },
    });

    return flushPromises().then(async () => {
      expect(setActive).toHaveBeenLastCalledWith(true);

      client.emitEvent(
        event('tab_focused', { type: 'tab_focused', workspace_id: 'w2', tab_id: 'w2:t2' }),
      );
      await flushPromises();
      expect(setActive).toHaveBeenLastCalledWith(false);

      client.emitEvent(
        event('workspace_focused', { type: 'workspace_focused', workspace_id: 'w3' }),
      );
      await flushPromises();
      expect(setActive).toHaveBeenLastCalledWith(false);

      client.emitEvent(
        event('workspace_focused', { type: 'workspace_focused', workspace_id: 'w2' }),
      );
      expect(client.requests.at(-1)).toEqual({
        id: 'pi-render-gate:workspace',
        method: 'workspace.get',
        params: { workspace_id: 'w2' },
      });
      await flushPromises();
      expect(setActive).toHaveBeenLastCalledWith(true);
    });
  });

  test('fails open when workspace.get returns an unexpected schema', async () => {
    const client = new MemoryHerdrClient([
      response('pi-render-gate:workspace', {
        type: 'workspace_info',
        workspace: { focused: false, active_tab_id: 'w2:t2' },
      }),
      response('pi-render-gate:workspace', { type: 'unexpected' }),
    ]);
    const setActive = vi.fn();
    const onError = vi.fn();

    subscribeToHerdrVisibility({
      client,
      ids: { workspaceId: 'w2', tabId: 'w2:t1', paneId: 'w2:p1' },
      onError,
      setActive,
    });

    await flushPromises();
    expect(setActive).toHaveBeenLastCalledWith(false);

    client.emitEvent(event('workspace_focused', { type: 'workspace_focused', workspace_id: 'w2' }));
    await flushPromises();

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(setActive).toHaveBeenLastCalledWith(true);
  });

  test('socket request skips blank lines before a JSON response', async () => {
    await withSocketServer(
      (socket) => {
        socket.once('data', () => {
          socket.write(`\n${JSON.stringify(response('pi-render-gate:workspace', { ok: true }))}\n`);
        });
      },
      async (socketPath) => {
        const client = createHerdrClient(socketPath);

        await expect(client.request({ id: 'pi-render-gate:workspace' })).resolves.toEqual(
          response('pi-render-gate:workspace', { ok: true }),
        );
      },
    );
  });

  test('socket subscription forwards data.type events and reports protocol errors', async () => {
    await withSocketServer(
      (socket) => {
        socket.once('data', () => {
          socket.write(
            `${JSON.stringify({ data: { type: 'tab.focused', workspace_id: 'w2' } })}\n`,
          );
          socket.write(`${JSON.stringify({ error: { message: 'subscription denied' } })}\n`);
        });
      },
      async (socketPath) => {
        const client = createHerdrClient(socketPath);
        const messages: unknown[] = [];
        const errors: Error[] = [];

        const unsubscribe = client.subscribe(
          { id: 'pi-render-gate:subscribe' },
          (message) => messages.push(message),
          (error) => errors.push(error),
        );

        await waitFor(() => messages.length === 1 && errors.length === 1);
        unsubscribe();

        expect(messages).toEqual([{ data: { type: 'tab.focused', workspace_id: 'w2' } }]);
        expect(errors[0]?.message).toContain('subscription denied');
      },
    );
  });
});

describe('extension registration', () => {
  test('recognizes a complete Herdr environment', () => {
    expect(
      isHerdrEnv({
        HERDR_ENV: '1',
        HERDR_SOCKET_PATH: '/tmp/herdr.sock',
        HERDR_WORKSPACE_ID: 'w2',
        HERDR_TAB_ID: 'w2:t1',
        HERDR_PANE_ID: 'w2:p1',
      }),
    ).toBe(true);

    expect(isHerdrEnv({ HERDR_ENV: '1' })).toBe(false);
  });

  test('installs only for TUI sessions inside Herdr', () => {
    const on = vi.fn();
    const pi = { on } as any;
    createPiRenderGateExtension(pi, { HERDR_ENV: '0' } as any);
    expect(on).not.toHaveBeenCalled();

    createPiRenderGateExtension(pi, {
      HERDR_ENV: '1',
      HERDR_SOCKET_PATH: '/tmp/herdr.sock',
      HERDR_WORKSPACE_ID: 'w2',
      HERDR_TAB_ID: 'w2:t1',
      HERDR_PANE_ID: 'w2:p1',
    } as any);
    expect(on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
  });

  test('session_start uses shared TUI mode guard before touching UI', () => {
    const on = vi.fn();
    const createHerdrClient = vi.fn();
    const pi = { on } as any;

    createPiRenderGateExtension(
      pi,
      {
        HERDR_ENV: '1',
        HERDR_SOCKET_PATH: '/tmp/herdr.sock',
        HERDR_WORKSPACE_ID: 'w2',
        HERDR_TAB_ID: 'w2:t1',
        HERDR_PANE_ID: 'w2:p1',
      } as any,
      { createHerdrClient },
    );

    const handler = getSessionStartHandler(on);
    handler({}, { mode: 'tui', hasUI: false, ui: { setWidget: vi.fn() } });
    handler({}, { mode: 'rpc', hasUI: true, ui: { setWidget: vi.fn() } });

    expect(createHerdrClient).not.toHaveBeenCalled();
  });

  test('session_start cleans up an existing gate before ignoring non-TUI contexts', async () => {
    const on = vi.fn();
    const client = new MemoryHerdrClient([
      response('pi-render-gate:workspace', {
        type: 'workspace_info',
        workspace: { focused: true, active_tab_id: 'w2:t1' },
      }),
    ]);
    const createHerdrClient = vi.fn(() => client);
    const pi = { on } as any;

    createPiRenderGateExtension(
      pi,
      {
        HERDR_ENV: '1',
        HERDR_SOCKET_PATH: '/tmp/herdr.sock',
        HERDR_WORKSPACE_ID: 'w2',
        HERDR_TAB_ID: 'w2:t1',
        HERDR_PANE_ID: 'w2:p1',
      } as any,
      { createHerdrClient },
    );

    const handler = getSessionStartHandler(on);
    const setWidget = vi.fn((_key, content) => {
      if (typeof content === 'function') {
        content({ requestRender: vi.fn() }, {});
      }
    });

    handler({}, { mode: 'tui', hasUI: true, ui: { setStatus: vi.fn(), setWidget } });
    await flushPromises();
    handler({}, { mode: 'rpc', hasUI: true, ui: { setWidget: vi.fn() } });

    expect(client.unsubscribes).toBe(1);
    expect(setWidget).toHaveBeenLastCalledWith('pi-render-gate:capture', undefined, {
      placement: 'belowEditor',
    });
    expect(createHerdrClient).toHaveBeenCalledTimes(1);
  });

  test('coarse lifecycle events schedule one forced render while hidden', async () => {
    vi.useFakeTimers();
    const on = vi.fn();
    const requestRender = vi.fn();
    const client = new MemoryHerdrClient([
      response('pi-render-gate:workspace', {
        type: 'workspace_info',
        workspace: { focused: true, active_tab_id: 'w2:t2' },
      }),
    ]);
    const createHerdrClient = vi.fn(() => client);
    const pi = { on } as any;

    createPiRenderGateExtension(
      pi,
      {
        HERDR_ENV: '1',
        HERDR_SOCKET_PATH: '/tmp/herdr.sock',
        HERDR_WORKSPACE_ID: 'w2',
        HERDR_TAB_ID: 'w2:t1',
        HERDR_PANE_ID: 'w2:p1',
      } as any,
      { createHerdrClient },
    );

    const ctx = {
      mode: 'tui',
      hasUI: true,
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn((_key, content) => {
          if (typeof content === 'function') {
            content({ requestRender }, {});
          }
        }),
      },
    };

    getSessionStartHandler(on)({}, ctx);
    await flushPromises();
    expect(requestRender).not.toHaveBeenCalled();

    getHandler(on, 'agent_start')({}, ctx);
    await vi.advanceTimersByTimeAsync(150);

    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(requestRender).toHaveBeenLastCalledWith(true);

    for (const eventName of [
      'agent_end',
      'message_end',
      'tool_execution_end',
      'turn_end',
      'user_bash',
    ]) {
      getHandler(on, eventName)({}, ctx);
    }
    await vi.advanceTimersByTimeAsync(150);

    expect(requestRender).toHaveBeenCalledTimes(2);
    expect(requestRender).toHaveBeenLastCalledWith(true);
  });

  test('coarse lifecycle events do not force renders while visible', async () => {
    vi.useFakeTimers();
    const on = vi.fn();
    const requestRender = vi.fn();
    const client = new MemoryHerdrClient([
      response('pi-render-gate:workspace', {
        type: 'workspace_info',
        workspace: { focused: true, active_tab_id: 'w2:t1' },
      }),
    ]);
    const createHerdrClient = vi.fn(() => client);
    const pi = { on } as any;

    createPiRenderGateExtension(
      pi,
      {
        HERDR_ENV: '1',
        HERDR_SOCKET_PATH: '/tmp/herdr.sock',
        HERDR_WORKSPACE_ID: 'w2',
        HERDR_TAB_ID: 'w2:t1',
        HERDR_PANE_ID: 'w2:p1',
      } as any,
      { createHerdrClient },
    );

    const ctx = {
      mode: 'tui',
      hasUI: true,
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn((_key, content) => {
          if (typeof content === 'function') {
            content({ requestRender }, {});
          }
        }),
      },
    };

    getSessionStartHandler(on)({}, ctx);
    await flushPromises();

    for (const eventName of [
      'agent_start',
      'agent_end',
      'message_end',
      'tool_execution_end',
      'turn_end',
      'user_bash',
    ]) {
      getHandler(on, eventName)({}, ctx);
    }
    await vi.advanceTimersByTimeAsync(150);

    expect(requestRender).not.toHaveBeenCalled();
  });
});
