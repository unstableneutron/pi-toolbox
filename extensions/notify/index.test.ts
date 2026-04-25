import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const HOME = homedir();
const AGENT_CWD = join(HOME, '.pi/agent');
const WORKSPACE_BASE = join(HOME, 'workspace/repos/example-monorepo-repo');

const { readRollingSummarySidecarMock } = vi.hoisted(() => ({
  readRollingSummarySidecarMock: vi.fn(),
}));

vi.mock('../smart-sessions/sidecar', () => ({
  readRollingSummarySidecar: readRollingSummarySidecarMock,
}));

import notifyExtension from './index';
import { buildConversationSnapshot } from '../smart-sessions/conversation';

type Handler = (event: any, ctx?: any) => Promise<void> | void;

function createHarness(options?: {
  sessionId?: string;
  branch?: any[];
  cwd?: string;
  hasUI?: boolean;
}) {
  const handlers = new Map<string, Handler>();
  const controller = new AbortController();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
  } as any;

  notifyExtension(pi);
  return {
    handlers,
    ctx: {
      signal: controller.signal,
      hasUI: options?.hasUI ?? true,
      sessionManager: {
        getSessionId: () => options?.sessionId ?? 'session-test-id',
        getBranch: () => options?.branch ?? [],
        getCwd: () => options?.cwd ?? AGENT_CWD,
      },
    },
    abort: () => controller.abort(),
    pi,
  };
}

function installWriteSpy() {
  return vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as any);
}

function lastNotification(writeSpy: any): string {
  return String(writeSpy.mock.calls.at(-1)?.[0] ?? '');
}

afterEach(() => {
  delete process.env.KITTY_WINDOW_ID;
  readRollingSummarySidecarMock.mockReset();
  vi.restoreAllMocks();
});

describe('notify extension', () => {
  test('is a no-op when hasUI is false (print/RPC mode)', async () => {
    vi.useFakeTimers();
    delete process.env.KITTY_WINDOW_ID;

    const harness = createHarness({ hasUI: false });
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);

    await harness.handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }],
      },
      harness.ctx,
    );

    await vi.advanceTimersByTimeAsync(60_000);

    expect(writeSpy).not.toHaveBeenCalled();
  });

  test('delays the final assistant text until 5 seconds of inactivity have passed', async () => {
    vi.useFakeTimers();
    delete process.env.KITTY_WINDOW_ID;

    const harness = createHarness();
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);

    await harness.handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: '# Ready\n\nfor `input`' }],
          },
        ],
      },
      harness.ctx,
    );

    await vi.advanceTimersByTimeAsync(9_999);
    expect(writeSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(lastNotification(writeSpy)).toBe('\x1b]777;notify;π ~/.pi/agent;Ready for input\x07');
  });

  test('resets the grace period when a later event arrives', async () => {
    vi.useFakeTimers();
    delete process.env.KITTY_WINDOW_ID;

    const harness = createHarness();
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);

    await harness.handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'First draft' }],
          },
        ],
      },
      harness.ctx,
    );

    await vi.advanceTimersByTimeAsync(9_000);

    await harness.handlers.get('tool_execution_start')?.(
      {
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'ask_user',
        args: {
          question: 'Which option should we use for the release?',
        },
      },
      harness.ctx,
    );

    await vi.advanceTimersByTimeAsync(9_999);
    expect(writeSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(lastNotification(writeSpy)).toBe(
      '\x1b]777;notify;π ~/.pi/agent;Which option should we use for the release?\x07',
    );
  });

  test('skips scheduling when the final assistant message ended with an error', async () => {
    vi.useFakeTimers();
    delete process.env.KITTY_WINDOW_ID;

    const harness = createHarness();
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);

    await harness.handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: '{"error":{"message":"Internal server error"}}',
          },
        ],
      },
      harness.ctx,
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test('skips scheduling when the agent loop was aborted', async () => {
    vi.useFakeTimers();
    delete process.env.KITTY_WINDOW_ID;

    const harness = createHarness();
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);

    await harness.handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'partial' }],
            stopReason: 'aborted',
          },
        ],
      },
      harness.ctx,
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  test('schedules the real notification when a retry succeeds after an error', async () => {
    vi.useFakeTimers();
    delete process.env.KITTY_WINDOW_ID;

    const harness = createHarness();
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);

    // First agent_end terminates on an error: no notification should fire.
    await harness.handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: 'Internal server error',
          },
        ],
      },
      harness.ctx,
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(writeSpy).not.toHaveBeenCalled();

    // Core auto-retry runs `agent.continue()`, which fires a fresh
    // agent_end whose final assistant message is the successful response.
    await harness.handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Recovered answer' }],
            stopReason: 'stop',
          },
        ],
      },
      harness.ctx,
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(lastNotification(writeSpy)).toBe('\x1b]777;notify;π ~/.pi/agent;Recovered answer\x07');
  });

  test('ignores non ask_user tool starts', async () => {
    delete process.env.KITTY_WINDOW_ID;
    const harness = createHarness();
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);

    await harness.handlers.get('tool_execution_start')?.(
      {
        type: 'tool_execution_start',
        toolCallId: 'tool-2',
        toolName: 'bash',
        args: { command: 'pwd' },
      },
      harness.ctx,
    );

    expect(writeSpy).not.toHaveBeenCalled();
  });

  test('cancels a pending notification when the ctx signal aborts', async () => {
    vi.useFakeTimers();
    delete process.env.KITTY_WINDOW_ID;

    const harness = createHarness();
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);

    await harness.handlers.get('tool_execution_start')?.(
      {
        type: 'tool_execution_start',
        toolCallId: 'tool-3',
        toolName: 'ask_user',
        args: { context: 'Need approval before proceeding' },
      },
      harness.ctx,
    );

    harness.abort();
    await vi.runAllTimersAsync();

    expect(writeSpy).not.toHaveBeenCalled();
  });

  test('strips markdown punctuation and OSC hyperlink escapes before notifying', async () => {
    vi.useFakeTimers();
    delete process.env.KITTY_WINDOW_ID;

    const harness = createHarness();
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);

    await harness.handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: '# Summary\n- See [docs](https://example.com)\n- Path: \x1b]8;;https://example.com\x07docs\x1b]8;;\x07\n- Use `retry_now`',
              },
            ],
          },
        ],
      },
      harness.ctx,
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(lastNotification(writeSpy)).toBe(
      '\x1b]777;notify;π ~/.pi/agent;Summary See docs Path: docs Use retry now\x07',
    );
  });

  test('uses OSC 99 with the session id inside Kitty', async () => {
    vi.useFakeTimers();
    process.env.KITTY_WINDOW_ID = 'kitty-window-1';

    const harness = createHarness({ sessionId: 'session-kitty-123' });
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);

    await harness.handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Ready for your approval' }],
          },
        ],
      },
      harness.ctx,
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(writeSpy.mock.calls.slice(-2).map((call) => String(call[0]))).toEqual([
      '\x1b]99;i=session-kitty-123:o=unfocused:d=0;π ~/.pi/agent\x07',
      '\x1b]99;i=session-kitty-123:o=unfocused:p=body;Ready for your approval\x07',
    ]);
  });

  test('uses smart-sessions window title in OSC 99 notifications when available', async () => {
    vi.useFakeTimers();
    process.env.KITTY_WINDOW_ID = 'kitty-window-2';

    const harness = createHarness({
      sessionId: 'session-kitty-456',
      branch: [
        {
          type: 'custom',
          customType: 'smart-sessions/window-name',
          data: { windowName: 'Review notify fallback' },
        },
      ],
    });
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);

    await harness.handlers.get('tool_execution_start')?.(
      {
        type: 'tool_execution_start',
        toolCallId: 'tool-9',
        toolName: 'ask_user',
        args: { question: 'Ship this update today?' },
      },
      harness.ctx,
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(writeSpy.mock.calls.slice(-2).map((call) => String(call[0]))).toEqual([
      '\x1b]99;i=session-kitty-456:o=unfocused:d=0;π Review notify fallback\x07',
      '\x1b]99;i=session-kitty-456:o=unfocused:p=body;Ship this update today?\x07',
    ]);
  });

  test('falls back to OSC 777 when not running inside Kitty', async () => {
    vi.useFakeTimers();

    const harness = createHarness();
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);

    await harness.handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Fallback path still works' }],
          },
        ],
      },
      harness.ctx,
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(lastNotification(writeSpy)).toBe(
      '\x1b]777;notify;π ~/.pi/agent;Fallback path still works\x07',
    );
  });

  test('uses compressed cwd for generic title when no smart-session title exists', async () => {
    vi.useFakeTimers();
    delete process.env.KITTY_WINDOW_ID;

    const harness = createHarness({
      cwd: WORKSPACE_BASE,
    });
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);

    await harness.handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done' }] }],
      },
      harness.ctx,
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(lastNotification(writeSpy)).toBe(
      '\x1b]777;notify;π ~/w/r/example-monorepo-repo;Done\x07',
    );
  });

  test('keeps compressing cwd segments until the title fits the max width', async () => {
    vi.useFakeTimers();
    delete process.env.KITTY_WINDOW_ID;

    const harness = createHarness({
      cwd: join(WORKSPACE_BASE, 'foo/bar/baz/qux'),
    });
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);

    await harness.handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done' }] }],
      },
      harness.ctx,
    );

    await vi.advanceTimersByTimeAsync(10_000);

    const sent = lastNotification(writeSpy);
    expect(sent).toContain('baz/qux;Done\x07');
    expect(sent.length).toBeLessThanOrEqual(
      '\x1b]777;notify;π ~/w/r/example-monorepo-repo/foo/bar;Done\x07'.length,
    );
  });

  test('clears kitty notification via OSC 99 on session return hooks', async () => {
    process.env.KITTY_WINDOW_ID = 'kitty-window-6';
    const writeSpy = installWriteSpy();

    const harness = createHarness({ sessionId: 'session-clear-1' });

    await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);
    await harness.handlers.get('before_agent_start')?.({ type: 'before_agent_start' }, harness.ctx);
    await harness.handlers.get('input')?.(
      { type: 'input', text: 'hello', source: 'interactive' },
      harness.ctx,
    );
    await harness.handlers.get('input')?.(
      { type: 'input', text: 'rpc hello', source: 'rpc' },
      harness.ctx,
    );
    await harness.handlers.get('input')?.(
      { type: 'input', text: 'ext hello', source: 'extension' },
      harness.ctx,
    );

    expect(writeSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      '\x1b]99;i=session-clear-1:p=close;\x07',
      '\x1b]99;i=session-clear-1:p=close;\x07',
      '\x1b]99;i=session-clear-1:p=close;\x07',
    ]);
  });

  test('does not notify for restored ask_user state before a fresh agent_start', async () => {
    vi.useFakeTimers();
    process.env.KITTY_WINDOW_ID = 'kitty-window-7';

    const harness = createHarness({
      sessionId: 'session-restored-1',
      branch: [
        {
          type: 'custom',
          customType: 'smart-sessions/window-name',
          data: { windowName: 'Reload restore test' },
        },
      ],
    });
    const writeSpy = installWriteSpy();

    await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);
    await harness.handlers.get('tool_execution_start')?.(
      {
        type: 'tool_execution_start',
        toolCallId: 'tool-restored',
        toolName: 'ask_user',
        args: { question: 'Ship this update today?' },
      },
      harness.ctx,
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(lastNotification(writeSpy)).toBe('\x1b]99;i=session-restored-1:p=close;\x07');
  });

  test('ignores session lifecycle and ask_user completion without writing to stdout', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-14T20:28:46.510Z'));

    const harness = createHarness();
    const writeSpy = installWriteSpy();

    await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);
    await vi.advanceTimersByTimeAsync(5_000);

    await harness.handlers.get('input')?.(
      { type: 'input', text: 'hello', source: 'interactive' },
      harness.ctx,
    );

    vi.setSystemTime(new Date('2026-04-14T20:29:05.000Z'));
    await harness.handlers.get('tool_execution_end')?.(
      {
        type: 'tool_execution_end',
        toolCallId: 'tool-ask-user-end',
        toolName: 'ask_user',
        result: { answer: 'Yes' },
        isError: false,
      },
      harness.ctx,
    );

    await harness.handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, harness.ctx);

    expect(writeSpy).not.toHaveBeenCalled();
  });

  test('skips a scheduled notification if interactive input happens before the timer fires', async () => {
    vi.useFakeTimers();
    process.env.KITTY_WINDOW_ID = 'kitty-window-8';

    const harness = createHarness({ sessionId: 'session-epoch-1' });
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);
    await harness.handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Fresh result' }] }],
      },
      harness.ctx,
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await harness.handlers.get('input')?.(
      { type: 'input', text: 'interrupt', source: 'interactive' },
      harness.ctx,
    );
    await vi.advanceTimersByTimeAsync(5_000);

    expect(writeSpy.mock.calls.map((call) => String(call[0]))).toEqual([
      '\x1b]99;i=session-epoch-1:p=close;\x07',
    ]);
  });

  test('prefers rolling short title and short summary from smart-sessions sidecar state', async () => {
    vi.useFakeTimers();
    delete process.env.KITTY_WINDOW_ID;

    const branch = [
      {
        id: 'entry-1',
        timestamp: '2026-04-15T00:58:00.000Z',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'Ship the sidecar design' }] },
      },
      {
        id: 'entry-2',
        timestamp: '2026-04-15T00:59:00.000Z',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Need user signoff overwrite only current previous history' },
          ],
        },
      },
    ];
    const snapshot = buildConversationSnapshot(branch as any);

    readRollingSummarySidecarMock.mockReturnValue({
      version: 1,
      sessionId: 'session-notify-1',
      current: {
        shortTitle: 'Ship sidecar',
        longTitle: 'Refactor smart-sessions rolling summary state',
        shortSummary: 'Need user signoff overwrite only current previous history',
        summaryBullets: ['Blocked: awaiting signoff.'],
        timelineItems: ['Prepared the rolling summary design.'],
        rewriteCount: 0,
        checkpointEntryId: 'entry-8',
        conversationHash: snapshot!.conversationHash,
        generatedAt: '2026-04-15T01:00:00.000Z',
      },
      previous: undefined,
    });

    const harness = createHarness({ sessionId: 'session-notify-1', branch });
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);
    await harness.handlers.get('agent_end')?.({ type: 'agent_end', messages: [] }, harness.ctx);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(lastNotification(writeSpy)).toBe(
      '\x1b]777;notify;π Ship sidecar;Need user signoff overwrite only current previous history\x07',
    );
  });

  test('falls back to cwd title and assistant text when no rolling summary exists', async () => {
    vi.useFakeTimers();
    delete process.env.KITTY_WINDOW_ID;

    readRollingSummarySidecarMock.mockReturnValue({
      version: 1,
      sessionId: 'session-notify-2',
      current: undefined,
      previous: undefined,
    });

    const harness = createHarness({ sessionId: 'session-notify-2' });
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);
    await harness.handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Ready for input' }] }],
      },
      harness.ctx,
    );
    await vi.advanceTimersByTimeAsync(10_000);

    expect(lastNotification(writeSpy)).toBe('\x1b]777;notify;π ~/.pi/agent;Ready for input\x07');
  });

  test('falls back to the latest assistant text when the rolling summary is stale for the current branch', async () => {
    vi.useFakeTimers();
    delete process.env.KITTY_WINDOW_ID;

    readRollingSummarySidecarMock.mockReturnValue({
      version: 1,
      sessionId: 'session-notify-3',
      current: {
        shortTitle: 'Stale summary',
        longTitle: 'Old rolling summary',
        shortSummary: 'Old summary should not override fresh assistant output',
        summaryBullets: ['Completed: generated an old rolling summary.'],
        timelineItems: ['Finished an earlier session summary refresh.'],
        rewriteCount: 3,
        checkpointEntryId: 'entry-2',
        conversationHash: 'stale-hash',
        generatedAt: '2026-04-15T01:05:00.000Z',
      },
      previous: undefined,
    });

    const harness = createHarness({
      sessionId: 'session-notify-3',
      branch: [
        {
          type: 'custom',
          customType: 'smart-sessions/window-name',
          data: { windowName: 'Stale summary' },
        },
        {
          id: 'entry-1',
          timestamp: '2026-04-15T01:00:00.000Z',
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: 'Keep going' }] },
        },
        {
          id: 'entry-2',
          timestamp: '2026-04-15T01:01:00.000Z',
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Latest assistant result' }],
          },
        },
      ],
    });
    const writeSpy = installWriteSpy();

    await harness.handlers.get('turn_start')?.({ type: 'turn_start', timestamp: 1 }, harness.ctx);
    await harness.handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'Latest assistant result' }] },
        ],
      },
      harness.ctx,
    );
    await vi.advanceTimersByTimeAsync(10_000);

    expect(lastNotification(writeSpy)).toBe(
      '\x1b]777;notify;π ~/.pi/agent;Latest assistant result\x07',
    );
  });
});
