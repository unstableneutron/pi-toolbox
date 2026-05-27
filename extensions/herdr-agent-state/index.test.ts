import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type Handler = (event?: any, ctx?: any) => Promise<void> | void;
type Recording = {
  acceptedReports: Array<Record<string, any>>;
  requests: Array<Record<string, any>>;
  dropNextWorking: boolean;
};

const { createConnectionMock, recording } = vi.hoisted(() => {
  const recording: Recording = {
    acceptedReports: [],
    requests: [],
    dropNextWorking: false,
  };

  const createConnectionMock = vi.fn((socketPath: string) => {
    expect(socketPath).toBe('/tmp/herdr-agent-state.sock');

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
        if (params.state === 'working' && recording.dropNextWorking) {
          recording.dropNextWorking = false;
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

function fakeContext(): any {
  return {
    sessionManager: {
      getSessionFile: () => '/tmp/herdr-agent-state-test.jsonl',
      getSessionId: () => 'test-session-id',
    },
  };
}

function resetRecording(): void {
  recording.acceptedReports = [];
  recording.requests = [];
  recording.dropNextWorking = false;
  createConnectionMock.mockClear();
}

async function loadHarness(env: Record<string, string> = {}): Promise<FakePi> {
  vi.resetModules();
  Object.assign(process.env, {
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: '/tmp/herdr-agent-state.sock',
    HERDR_PANE_ID: 'p_1',
    HERDR_PI_IDLE_DEBOUNCE_MS: '20',
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
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
  delete process.env.HERDR_PI_IDLE_DEBOUNCE_MS;
  delete process.env.HERDR_PI_ACTIVE_HEARTBEAT_MS;
  delete process.env.HERDR_PI_RETRY_GRACE_MS;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('herdr agent state extension', () => {
  test('reasserts working after a dropped active report', async () => {
    const pi = await loadHarness({ HERDR_PI_ACTIVE_HEARTBEAT_MS: '30' });
    recording.dropNextWorking = true;

    await pi.emit('session_start');
    await flushSocketWork();
    await pi.emit('agent_start');
    await vi.advanceTimersByTimeAsync(30);
    await vi.advanceTimersByTimeAsync(500);
    await flushSocketWork();

    expect(acceptedStates()).toContain('working');
  });

  test('does not publish idle while a tool call is still active', async () => {
    const pi = await loadHarness();

    await pi.emit('session_start');
    await flushSocketWork();
    await pi.emit('agent_start');
    await flushSocketWork();
    await pi.emit('tool_execution_start', { toolCallId: 'tool-1', toolName: 'bash', args: {} });
    await flushSocketWork();
    await pi.emit('agent_end', { messages: [] });
    await vi.advanceTimersByTimeAsync(30);
    await flushSocketWork();

    expect(acceptedStates().at(-1)).toBe('working');
  });

  test('publishes idle after the final active tool completes and debounce elapses', async () => {
    const pi = await loadHarness();

    await pi.emit('session_start');
    await flushSocketWork();
    await pi.emit('agent_start');
    await flushSocketWork();
    await pi.emit('tool_execution_start', { toolCallId: 'tool-1', toolName: 'bash', args: {} });
    await flushSocketWork();
    await pi.emit('agent_end', { messages: [] });
    await flushSocketWork();
    await pi.emit('tool_execution_end', {
      toolCallId: 'tool-1',
      toolName: 'bash',
      result: {},
      isError: false,
    });
    await vi.advanceTimersByTimeAsync(20);
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
    await pi.emit('agent_end', { messages: [] });
    await vi.advanceTimersByTimeAsync(20);
    await flushSocketWork();

    expect(lastReport()).toMatchObject({ state: 'idle', custom_status: 'took 5m11s' });
  });
});
