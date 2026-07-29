import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type Handler = (event?: any, ctx?: any) => Promise<void> | void;
type Recording = {
  acceptedReports: Array<Record<string, any>>;
  requests: Array<Record<string, any>>;
  dropWorkingAttempts: number;
};

const { createConnectionMock, recording } = vi.hoisted(() => {
  const recording: Recording = {
    acceptedReports: [],
    requests: [],
    dropWorkingAttempts: 0,
  };

  const createConnectionMock = vi.fn((_socketPath: string) => {
    const socket = new EventEmitter() as EventEmitter & {
      destroy: () => void;
      write: (line: string) => void;
    };
    socket.destroy = vi.fn();
    socket.write = (line: string) => {
      const request = JSON.parse(line.trim()) as Record<string, any>;
      recording.requests.push(request);

      if (request.method === 'pane.report_agent') {
        const params = request.params as Record<string, any>;
        if (params.state === 'working' && recording.dropWorkingAttempts > 0) {
          recording.dropWorkingAttempts -= 1;
          return;
        }
        recording.acceptedReports.push(params);
      }

      queueMicrotask(() => {
        socket.emit(
          'data',
          Buffer.from(JSON.stringify({ id: request.id, result: { type: 'ok' } }) + '\n'),
        );
      });
    };

    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });

  return { createConnectionMock, recording };
});

vi.mock('node:net', () => ({
  default: { createConnection: createConnectionMock },
  createConnection: createConnectionMock,
}));

class FakePi {
  handlers = new Map<string, Handler[]>();
  busHandlers = new Map<string, Handler[]>();

  events = {
    on: (event: string, handler: Handler) => {
      this.addHandler(this.busHandlers, event, handler);
    },
  };

  on(event: string, handler: Handler): void {
    this.addHandler(this.handlers, event, handler);
  }

  async emit(event: string, payload: any = {}, ctx = fakeContext()): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(payload, ctx);
    }
  }

  async emitBus(event: string, payload: any): Promise<void> {
    for (const handler of this.busHandlers.get(event) ?? []) {
      await handler(payload);
    }
  }

  private addHandler(map: Map<string, Handler[]>, event: string, handler: Handler): void {
    const handlers = map.get(event) ?? [];
    handlers.push(handler);
    map.set(event, handlers);
  }
}

function fakeContext(overrides: Record<string, any> = {}): any {
  return {
    hasUI: true,
    isIdle: () => true,
    mode: 'tui',
    sessionManager: {
      getSessionFile: () => '/tmp/herdr-agent-state-test.jsonl',
      getSessionId: () => 'test-session-id',
    },
    ...overrides,
  };
}

function resetRecording(): void {
  recording.acceptedReports = [];
  recording.requests = [];
  recording.dropWorkingAttempts = 0;
  createConnectionMock.mockClear();
}

async function loadHarness(env: Record<string, string> = {}): Promise<FakePi> {
  vi.resetModules();
  Object.assign(process.env, {
    HERDR: '1',
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: '/tmp/herdr-agent-state.sock',
    HERDR_PANE_ID: 'p_1',
    HERDR_PI_ACTIVE_HEARTBEAT_MS: '0',
    ...env,
  });

  const extension = (await import('./index')).default;
  const pi = new FakePi();
  extension(pi as any);
  return pi;
}

async function flushSocketWork(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function acceptedStates(): string[] {
  return recording.acceptedReports.map((report) => report.state as string);
}

function lastReport(): Record<string, any> | undefined {
  return recording.acceptedReports.at(-1);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRecording();
});

afterEach(() => {
  delete process.env.HERDR;
  delete process.env.HERDR_ENV;
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_PI_ACTIVE_HEARTBEAT_MS;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('herdr agent state extension', () => {
  test('does not register handlers without HERDR_ENV', async () => {
    const pi = await loadHarness({ HERDR_ENV: '' });

    expect(pi.handlers.size).toBe(0);
    expect(pi.busHandlers.size).toBe(0);
    expect(pi.handlers.get('before_agent_start')).toBeUndefined();
  });

  test('registers handlers when pi-herdr environment is present without legacy HERDR', async () => {
    const pi = await loadHarness({ HERDR: '' });

    expect(pi.handlers.get('session_start')).toHaveLength(1);
    expect(pi.handlers.get('agent_start')).toHaveLength(1);
    expect(pi.handlers.get('agent_end')).toBeUndefined();
    expect(pi.handlers.get('agent_settled')).toHaveLength(1);
    expect(pi.handlers.get('session_shutdown')).toBeUndefined();
    expect(pi.busHandlers.get('herdr:blocked')).toHaveLength(1);
  });

  test('does not register handlers without a pane id', async () => {
    const pi = await loadHarness({ HERDR: '1', HERDR_PANE_ID: '' });

    expect(pi.handlers.size).toBe(0);
    expect(pi.busHandlers.size).toBe(0);
    expect(pi.handlers.get('before_agent_start')).toBeUndefined();
  });

  test('disables Herdr extension handlers in subagent child processes', async () => {
    const pi = await loadHarness({ HERDR: '1', PI_SUBAGENT_CHILD: '1' });

    expect(pi.handlers.size).toBe(0);
    expect(pi.busHandlers.size).toBe(0);
  });

  test('does not register prompt guidance handlers', async () => {
    const pi = await loadHarness({ HERDR: '1' });

    expect(pi.handlers.get('before_agent_start')).toBeUndefined();
  });

  test('does not report agent state in non-TUI sessions', async () => {
    const pi = await loadHarness();
    const nonTuiContext = fakeContext({ hasUI: false, mode: 'json' });

    await pi.emit('session_start', {}, nonTuiContext);
    await flushSocketWork();
    await pi.emit('agent_start', {}, nonTuiContext);
    await flushSocketWork();
    await pi.emit('agent_settled', {}, nonTuiContext);
    await vi.advanceTimersByTimeAsync(20);
    await flushSocketWork();

    expect(recording.acceptedReports).toEqual([]);
    expect(recording.requests).toEqual([]);
  });

  test('uses the upstream Windows named-pipe socket endpoint', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const pi = await loadHarness({ HERDR_SOCKET_PATH: 'herdr-test' });

    await pi.emit('session_start');
    await flushSocketWork();

    expect(createConnectionMock).toHaveBeenCalledWith('\\\\.\\pipe\\herdr-test');
  });

  test('reports the active session to Herdr on session and agent start', async () => {
    const pi = await loadHarness();

    await pi.emit('session_start', { reason: 'startup' });
    await flushSocketWork();

    expect(recording.requests).toContainEqual(
      expect.objectContaining({
        method: 'pane.report_agent_session',
        params: expect.objectContaining({
          pane_id: 'p_1',
          source: 'herdr:pi',
          agent: 'pi',
          agent_session_path: '/tmp/herdr-agent-state-test.jsonl',
          session_start_source: 'startup',
        }),
      }),
    );

    recording.requests = [];

    await pi.emit('agent_start');
    await flushSocketWork();

    expect(recording.requests).toContainEqual(
      expect.objectContaining({
        method: 'pane.report_agent_session',
        params: expect.objectContaining({
          pane_id: 'p_1',
          source: 'herdr:pi',
          agent: 'pi',
          agent_session_path: '/tmp/herdr-agent-state-test.jsonl',
        }),
      }),
    );
  });

  test('retries a dropped state report with the upstream socket behavior', async () => {
    const pi = await loadHarness();
    recording.dropWorkingAttempts = 1;

    await pi.emit('session_start');
    await flushSocketWork();
    await pi.emit('agent_start');
    await vi.advanceTimersByTimeAsync(500);
    await flushSocketWork();

    expect(acceptedStates()).toContain('working');
  });

  test('restores working state when a reload begins during an active run', async () => {
    const pi = await loadHarness();

    await pi.emit('session_start', { reason: 'reload' }, fakeContext({ isIdle: () => false }));
    await flushSocketWork();

    expect(lastReport()).toMatchObject({ state: 'working', custom_status: '0s' });
    expect(recording.requests).toContainEqual(
      expect.objectContaining({
        method: 'pane.report_agent_session',
        params: expect.objectContaining({ session_start_source: 'reload' }),
      }),
    );
  });

  test('reports idle only after the agent settles', async () => {
    const pi = await loadHarness();

    await pi.emit('session_start');
    await flushSocketWork();
    await pi.emit('agent_start');
    await flushSocketWork();

    await pi.emit('agent_settled', {}, fakeContext({ isIdle: () => false }));
    await flushSocketWork();
    expect(acceptedStates().at(-1)).toBe('working');

    await pi.emit('agent_settled');
    await flushSocketWork();
    expect(acceptedStates().at(-1)).toBe('idle');
  });

  test('settlement preserves explicit blocked-state precedence', async () => {
    const pi = await loadHarness();

    await pi.emit('session_start');
    await pi.emit('agent_start');
    await pi.emitBus('herdr:blocked', { active: true, label: 'Needs input' });
    await pi.emit('agent_settled');
    await flushSocketWork();

    expect(lastReport()).toMatchObject({ state: 'blocked', message: 'Needs input' });

    await pi.emitBus('herdr:blocked', { active: false });
    await flushSocketWork();
    expect(acceptedStates().at(-1)).toBe('idle');
  });

  test('reports working elapsed time as custom status', async () => {
    const pi = await loadHarness({ HERDR_PI_ACTIVE_HEARTBEAT_MS: '1000' });

    await pi.emit('session_start');
    await flushSocketWork();
    await pi.emit('agent_start');
    await flushSocketWork();

    expect(lastReport()).toMatchObject({ state: 'working', custom_status: '0s' });

    await vi.advanceTimersByTimeAsync(65_000);
    await flushSocketWork();

    expect(lastReport()).toMatchObject({ state: 'working', custom_status: '1m05s' });
  });

  test('reports blocked elapsed time from the blocked state transition', async () => {
    const pi = await loadHarness({ HERDR_PI_ACTIVE_HEARTBEAT_MS: '1000' });

    await pi.emit('session_start');
    await flushSocketWork();
    await pi.emit('agent_start');
    await flushSocketWork();
    await vi.advanceTimersByTimeAsync(10_000);
    await pi.emitBus('herdr:blocked', { active: true, label: 'Needs input' });
    await flushSocketWork();

    expect(lastReport()).toMatchObject({
      state: 'blocked',
      message: 'Needs input',
      custom_status: '0s',
    });

    await vi.advanceTimersByTimeAsync(42_000);
    await flushSocketWork();

    expect(lastReport()).toMatchObject({ state: 'blocked', custom_status: '42s' });
  });

  test('reports final run duration when returning to idle', async () => {
    const pi = await loadHarness();

    await pi.emit('session_start');
    await flushSocketWork();
    await pi.emit('agent_start');
    await flushSocketWork();
    await vi.advanceTimersByTimeAsync(311_000);
    await pi.emit('agent_settled');
    await vi.advanceTimersByTimeAsync(20);
    await flushSocketWork();

    expect(lastReport()).toMatchObject({ state: 'idle', custom_status: 'took 5m11s' });
  });
});
