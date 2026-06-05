import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { completeSimpleMock, createConnectionMock, getAgentDirMock, herdrRequests } = vi.hoisted(
  () => {
    const herdrRequests: Array<Record<string, any>> = [];
    const createConnectionMock = vi.fn((_socketPath: string) => {
      const socket = new EventEmitter() as EventEmitter & {
        destroy: () => void;
        write: (line: string) => void;
      };
      socket.destroy = vi.fn();
      socket.write = (line: string) => {
        const request = JSON.parse(line.trim()) as Record<string, any>;
        herdrRequests.push(request);
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

    return {
      completeSimpleMock: vi.fn(),
      createConnectionMock,
      getAgentDirMock: vi.fn(),
      herdrRequests,
    };
  },
);

vi.mock('@earendil-works/pi-ai', () => ({
  completeSimple: completeSimpleMock,
}));

vi.mock('node:net', () => ({
  createConnection: createConnectionMock,
}));

vi.mock('@earendil-works/pi-coding-agent', async () => {
  const actual = await vi.importActual<typeof import('@earendil-works/pi-coding-agent')>(
    '@earendil-works/pi-coding-agent',
  );

  class MockBorderedLoader {
    readonly signal = new AbortController().signal;
    onAbort?: () => void;

    constructor(
      _tui: unknown,
      _theme: unknown,
      _message: string,
      _options?: { cancellable?: boolean },
    ) {}
  }

  return {
    ...actual,
    BorderedLoader: MockBorderedLoader,
    getAgentDir: getAgentDirMock,
  };
});

import { readRollingSummarySidecar, writeRollingSummaryCurrent } from './sidecar';
import smartSessionsExtension from './index';

let tempAgentDir = '';
let entryCounter = 0;

function nextEntryBase() {
  entryCounter += 1;
  return {
    id: `entry-${entryCounter}`,
    parentId: entryCounter === 1 ? null : `entry-${entryCounter - 1}`,
    timestamp: new Date(entryCounter * 1_000).toISOString(),
  };
}

function messageEntry(role: 'user' | 'assistant', text: string) {
  return {
    ...nextEntryBase(),
    type: 'message',
    message: {
      role,
      content: [{ type: 'text', text }],
    },
  };
}

function customEntry(customType: string, data: Record<string, unknown>) {
  return {
    ...nextEntryBase(),
    type: 'custom',
    customType,
    data,
  };
}

function assistantResponse(text: string, stopReason = 'stop') {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    stopReason,
    timestamp: Date.now(),
  };
}

function constrainWidgetLines(
  lines: string[] | undefined,
  width: number,
  maxLines?: number,
): string[] | undefined {
  if (!lines) return undefined;

  const wrapped = lines.flatMap((line) => (line === '' ? [''] : wrapTextWithAnsi(line, width)));
  return maxLines == null ? wrapped : wrapped.slice(0, maxLines);
}

function createHarness(options?: {
  unavailableModels?: string[];
  initialEntries?: Array<Record<string, unknown>>;
  hasUI?: boolean;
  mode?: string;
  sessionName?: string | undefined;
  sessionId?: string;
}) {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown>>();
  const commands = new Map<string, (args: any, ctx: any) => Promise<unknown>>();
  const appendedEntries: Array<{ customType: string; data: Record<string, unknown> }> = [];
  const widgets = new Map<string, string[] | undefined>();
  const rawWidgets = new Map<
    string,
    string[] | ((tui: any, theme: any) => { render(width: number): string[] }) | undefined
  >();
  const overlayRenders: string[][] = [];
  const branch = [
    ...(options?.initialEntries ?? [
      messageEntry('user', 'Inspect smart sessions and notify constraints'),
      messageEntry('assistant', 'Reviewing prompts and notification limits now'),
    ]),
  ];
  let sessionName = options?.sessionName;

  const pi = {
    on(event: string, handler: (event: any, ctx: any) => Promise<unknown>) {
      handlers.set(event, handler);
    },
    appendEntry(customType: string, data: Record<string, unknown>) {
      appendedEntries.push({ customType, data });
      branch.push(customEntry(customType, data));
    },
    getSessionName() {
      return sessionName;
    },
    setSessionName(name: string) {
      sessionName = name;
    },
    exec: vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: '' }),
    registerCommand: vi.fn(
      (name: string, command: { handler: (args: any, ctx: any) => Promise<unknown> }) => {
        commands.set(name, command.handler);
      },
    ),
  };

  const unavailable = new Set(options?.unavailableModels ?? []);

  const uiCustom = vi.fn(async (factory: any, customOptions?: { overlay?: boolean }) => {
    const tui = {
      requestRender() {},
      terminal: { rows: 24 },
    };
    const theme = {
      fg(_slot: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };

    if (customOptions?.overlay) {
      const component = await factory(tui, theme, {}, (_value: unknown) => {});
      overlayRenders.push(component.render(100));
      return undefined;
    }

    let doneCalled = false;
    let result: unknown;
    factory(tui, theme, {}, (value: unknown) => {
      doneCalled = true;
      result = value;
    });

    for (let i = 0; i < 10 && !doneCalled; i += 1) {
      await Promise.resolve();
    }

    if (!doneCalled) {
      throw new Error('Expected ui.custom loader to resolve');
    }

    return result;
  });

  const renderWidgetContent = (
    content: string[] | ((tui: any, theme: any) => { render(width: number): string[] }) | undefined,
    width = 80,
    maxLines?: number,
  ) => {
    if (!content) return undefined;
    const lines =
      typeof content === 'function'
        ? content(
            { requestRender() {} },
            {
              fg(_slot: string, text: string) {
                return text;
              },
            },
          ).render(width)
        : content;

    return constrainWidgetLines(lines, width, maxLines);
  };

  const ctx = {
    hasUI: options?.hasUI ?? false,
    mode: options?.mode ?? (options?.hasUI ? 'tui' : 'print'),
    model: { provider: 'gust', id: 'gpt-5.4' },
    modelRegistry: {
      find: vi.fn().mockImplementation((provider: string, id: string) => {
        const key = `${provider}:${id}`;
        if (unavailable.has(key)) return null;

        if (provider === 'openai' && id === 'gpt-5.4-mini') {
          return { provider, id };
        }
        if (provider === 'anthropic' && id === 'claude-sonnet-4-6') {
          return { provider, id };
        }
        return null;
      }),
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: 'test-key', headers: {} }),
    },
    sessionManager: {
      getBranch: vi.fn().mockImplementation(() => branch),
      getSessionId: vi.fn().mockReturnValue(options?.sessionId ?? 'session-test-id'),
    },
    ui: {
      notify: vi.fn(),
      custom: uiCustom,
      setWidget: vi.fn(
        (
          key: string,
          content:
            | string[]
            | ((tui: any, theme: any) => { render(width: number): string[] })
            | undefined,
        ) => {
          rawWidgets.set(key, content);
          widgets.set(key, renderWidgetContent(content));
        },
      ),
    },
    waitForIdle: vi.fn(),
  };

  smartSessionsExtension(pi as any);

  return {
    branch,
    ctx,
    appendedEntries,
    overlayRenders,
    widgets,
    getSessionName() {
      return sessionName;
    },
    getWidgetLines(key: string, width = 80, maxLines?: number) {
      return renderWidgetContent(rawWidgets.get(key), width, maxLines);
    },
    getCommand(name: string) {
      const handler = commands.get(name);
      if (!handler) throw new Error(`Missing command: ${name}`);
      return handler;
    },
    getHandler(name: string) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Missing handler: ${name}`);
      return handler;
    },
  };
}

async function runEligibleBackgroundSummaryCycle(harness: ReturnType<typeof createHarness>) {
  await harness.getHandler('agent_start')({ type: 'agent_start' }, harness.ctx);
  await harness.getHandler('turn_end')(
    { type: 'turn_end', turnIndex: 0, message: {}, toolResults: [] },
    harness.ctx,
  );
  await harness.getHandler('turn_end')(
    { type: 'turn_end', turnIndex: 1, message: {}, toolResults: [] },
    harness.ctx,
  );
  vi.setSystemTime(new Date('2026-04-15T00:11:00.000Z'));
  await harness.getHandler('agent_end')({ type: 'agent_end', messages: [] }, harness.ctx);
}

async function runBackgroundSummaryToCompletion(harness: ReturnType<typeof createHarness>) {
  await runEligibleBackgroundSummaryCycle(harness);
  await vi.advanceTimersByTimeAsync(60_000);
}

describe('smart-sessions rolling summary', () => {
  beforeEach(() => {
    entryCounter = 0;
    tempAgentDir = mkdtempSync(join(tmpdir(), 'smart-sessions-index-'));
    getAgentDirMock.mockReturnValue(tempAgentDir);
    vi.useRealTimers();
    completeSimpleMock.mockReset();
    createConnectionMock.mockClear();
    herdrRequests.length = 0;
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
  });

  afterEach(() => {
    rmSync(tempAgentDir, { recursive: true, force: true });
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_PANE_ID;
    vi.restoreAllMocks();
  });

  test('session UI hooks are disabled in RPC mode', async () => {
    const harness = createHarness({ hasUI: true, mode: 'rpc' });

    await harness.getHandler('session_start')(
      { type: 'session_start', reason: 'startup' },
      harness.ctx,
    );

    expect(harness.ctx.ui.setWidget).not.toHaveBeenCalled();
  });

  test('does not report a Herdr pane title outside Herdr', async () => {
    completeSimpleMock.mockResolvedValue(
      assistantResponse(
        JSON.stringify({
          shortTitle: 'Smart summary',
          longTitle: 'Persist rolling smart sessions sidecar state',
          shortSummary: 'Need user approval on overwrite only summary history',
          summaryBullets: ['Blocked: waiting on overwrite confirmation.'],
          timelineItems: ['Asked whether to keep only current and previous summaries.'],
        }),
      ) as any,
    );

    const harness = createHarness({ hasUI: true });
    await harness.getCommand('summarize')({}, harness.ctx);
    await vi.waitFor(() => expect(completeSimpleMock).toHaveBeenCalledTimes(1));

    expect(createConnectionMock).not.toHaveBeenCalled();
    expect(herdrRequests).toEqual([]);
  });

  test('reports the short summary title to Herdr pane metadata when running inside Herdr', async () => {
    process.env.HERDR_ENV = '1';
    process.env.HERDR_SOCKET_PATH = '/tmp/smart-sessions-herdr.sock';
    process.env.HERDR_PANE_ID = 'pane-123';

    completeSimpleMock.mockResolvedValue(
      assistantResponse(
        JSON.stringify({
          shortTitle: 'Smart summary',
          longTitle: 'Persist rolling smart sessions sidecar state',
          shortSummary: 'Need user approval on overwrite only summary history',
          summaryBullets: ['Blocked: waiting on overwrite confirmation.'],
          timelineItems: ['Asked whether to keep only current and previous summaries.'],
        }),
      ) as any,
    );

    const harness = createHarness({ hasUI: true });
    await harness.getCommand('summarize')({}, harness.ctx);

    await vi.waitFor(() => expect(herdrRequests).toHaveLength(1));
    expect(createConnectionMock).toHaveBeenCalledWith('/tmp/smart-sessions-herdr.sock');
    expect(herdrRequests[0]).toMatchObject({
      method: 'pane.report_metadata',
      params: {
        pane_id: 'pane-123',
        source: 'pi-toolbox:smart-sessions:title',
        applies_to_source: 'herdr:pi',
        title: 'Smart summary',
      },
    });
    expect(herdrRequests[0]?.params?.seq).toEqual(expect.any(Number));
    expect(harness.appendedEntries).toContainEqual({
      customType: 'smart-sessions/window-name',
      data: { windowName: herdrRequests[0]?.params?.title },
    });
  });

  test('writes rolling summary state on summarize and uses long title for session naming', async () => {
    completeSimpleMock.mockResolvedValue(
      assistantResponse(
        JSON.stringify({
          shortTitle: 'Smart summary',
          longTitle: 'Persist rolling smart sessions sidecar state',
          shortSummary: 'Need user approval on overwrite only summary history',
          summaryBullets: ['Blocked: waiting on overwrite confirmation.'],
          timelineItems: ['Asked whether to keep only current and previous summaries.'],
        }),
      ) as any,
    );

    const harness = createHarness({ hasUI: true });
    await harness.getCommand('summarize')({}, harness.ctx);

    expect(harness.getSessionName()).toBe('Persist rolling smart sessions sidecar state');
    expect(harness.appendedEntries).toContainEqual({
      customType: 'smart-sessions/window-name',
      data: { windowName: 'Smart summary' },
    });

    expect(readRollingSummarySidecar('session-test-id').current).toMatchObject({
      shortTitle: 'Smart summary',
      longTitle: 'Persist rolling smart sessions sidecar state',
      shortSummary: 'Need user approval on overwrite only summary history',
    });
  });

  test('reuses the current sidecar summary on summarize when the conversation has not changed', async () => {
    completeSimpleMock.mockResolvedValue(
      assistantResponse(
        JSON.stringify({
          shortTitle: 'Smart summary',
          longTitle: 'Reuse rolling sidecar when the snapshot is unchanged',
          shortSummary: 'No new work since the last summary',
          summaryBullets: ['Completed: reused the current rolling summary.'],
          timelineItems: ['Generated the first rolling summary.'],
        }),
      ) as any,
    );

    const harness = createHarness({ hasUI: true });
    await harness.getCommand('summarize')({}, harness.ctx);
    completeSimpleMock.mockReset();

    await harness.getCommand('summarize')({}, harness.ctx);

    expect(completeSimpleMock).not.toHaveBeenCalled();
    expect(harness.overlayRenders.at(-1)?.join('\n')).toContain('Timeline');
  });

  test('shows the short summary in the inline widget after a background refresh', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-15T00:00:00.000Z'));

    completeSimpleMock.mockResolvedValue(
      assistantResponse(
        JSON.stringify({
          shortTitle: 'Ship sidecar',
          longTitle: 'Refresh smart sessions state from summary and delta transcript',
          shortSummary: 'Need user choice approve overwrite only sidecar history',
          summaryBullets: ['In Progress: replacing append only summary cache with sidecar state.'],
          timelineItems: ['Ran the rolling summary refresh after idle time.'],
        }),
      ) as any,
    );

    const harness = createHarness({ hasUI: true });
    await runBackgroundSummaryToCompletion(harness);

    expect(harness.getWidgetLines('smart-sessions/summary-ready', 120)?.join('\n')).toContain(
      'Need user choice approve overwrite only sidecar history',
    );
  });

  test('shows the inline summary widget on resume when the sidecar snapshot still matches', async () => {
    completeSimpleMock.mockResolvedValue(
      assistantResponse(
        JSON.stringify({
          shortTitle: 'Resume summary',
          longTitle: 'Resume smart sessions from the current rolling sidecar',
          shortSummary: 'Latest summary ready for review',
          summaryBullets: ['Completed: wrote rolling summary sidecar state.'],
          timelineItems: ['Generated a rolling summary for the current branch.'],
        }),
      ) as any,
    );

    const firstHarness = createHarness({ hasUI: true });
    await firstHarness.getCommand('summarize')({}, firstHarness.ctx);

    const resumedHarness = createHarness({
      hasUI: true,
      initialEntries: [...firstHarness.branch],
      sessionName: 'Resume smart sessions from the current rolling sidecar',
    });
    await resumedHarness.getHandler('session_start')(
      { type: 'session_start', reason: 'resume' },
      resumedHarness.ctx,
    );

    expect(
      resumedHarness.getWidgetLines('smart-sessions/summary-ready', 120)?.join('\n'),
    ).toContain('Latest summary ready for review');
  });

  test('does not restore stale sidecar titles on session start before a refresh happens', async () => {
    const staleWindowEntry = customEntry('smart-sessions/window-name', {
      windowName: 'Stale summary',
    });
    writeRollingSummaryCurrent('session-test-id', {
      shortTitle: 'Stale summary',
      longTitle: 'Old rolling summary before refresh',
      shortSummary: 'Old summary state',
      summaryBullets: ['Completed: wrote an old rolling summary.'],
      timelineItems: ['Generated an older summary snapshot.'],
      rewriteCount: 1,
      checkpointEntryId: 'entry-2',
      conversationHash: 'stale-hash',
      generatedAt: '2026-04-15T00:05:00.000Z',
    });

    const harness = createHarness({
      hasUI: true,
      initialEntries: [
        messageEntry('user', 'Inspect smart sessions and notify constraints'),
        messageEntry('assistant', 'Reviewing prompts and notification limits now'),
        staleWindowEntry,
        messageEntry('user', 'The conversation changed after the old summary'),
      ],
    });
    await harness.getHandler('session_start')(
      { type: 'session_start', reason: 'resume' },
      harness.ctx,
    );

    expect(harness.getSessionName()).toBeUndefined();
  });

  test('fork refreshes the unified rolling summary before agent start', async () => {
    completeSimpleMock.mockResolvedValue(
      assistantResponse(
        JSON.stringify({
          shortTitle: 'Fork summary',
          longTitle: 'Rename forked smart sessions from the unified rolling summary',
          shortSummary: 'Fork summary refreshed from the latest conversation',
          summaryBullets: ['Completed: refreshed fork naming with unified summary output.'],
          timelineItems: ['Forked the session and regenerated titles.'],
        }),
      ) as any,
    );

    const harness = createHarness({ hasUI: true });
    await harness.getHandler('session_start')(
      { type: 'session_start', reason: 'fork', previousSessionFile: '/tmp/parent.jsonl' },
      harness.ctx,
    );
    await harness.getHandler('before_agent_start')({}, harness.ctx);
    await vi.waitFor(() =>
      expect(harness.getSessionName()).toBe(
        'Rename forked smart sessions from the unified rolling summary',
      ),
    );
  });

  test('skips the rolling summary refresh entirely in non-UI sessions', async () => {
    const harness = createHarness({ hasUI: false });

    await harness.getHandler('session_start')(
      { type: 'session_start', reason: 'fork', previousSessionFile: '/tmp/parent.jsonl' },
      harness.ctx,
    );
    await harness.getHandler('before_agent_start')({}, harness.ctx);

    expect(completeSimpleMock).not.toHaveBeenCalled();
    expect(harness.getSessionName()).toBeUndefined();
  });

  test('forces a full rebuild after too many rolling rewrites', async () => {
    completeSimpleMock.mockResolvedValue(
      assistantResponse(
        JSON.stringify({
          shortTitle: 'Rebuild summary',
          longTitle: 'Force a full rebuild after many rolling summary rewrites',
          shortSummary: 'Rebuilt summary from the full transcript after drift threshold',
          summaryBullets: ['Completed: forced a hard rebuild of the rolling summary.'],
          timelineItems: ['Detected too many rolling rewrites and rebuilt from scratch.'],
        }),
      ) as any,
    );

    const harness = createHarness({
      hasUI: true,
      initialEntries: [
        messageEntry('user', 'Inspect smart sessions and notify constraints'),
        messageEntry('assistant', 'Reviewing prompts and notification limits now'),
        messageEntry('user', 'Add a drift safeguard for repeated rewrites'),
      ],
    });

    writeRollingSummaryCurrent('session-test-id', {
      shortTitle: 'Old summary',
      longTitle: 'Old rolling summary before rebuild',
      shortSummary: 'Older rolling summary state',
      summaryBullets: ['In Progress: keeping old rolling summary state.'],
      timelineItems: ['Generated an earlier rolling summary.'],
      rewriteCount: 12,
      checkpointEntryId: 'entry-2',
      conversationHash: 'old-hash',
      generatedAt: '2026-04-15T00:05:00.000Z',
    });

    await harness.getCommand('summarize')({}, harness.ctx);

    const payloadText =
      completeSimpleMock.mock.calls[0]?.[1]?.messages?.[0]?.content?.[0]?.text ?? '';
    expect(payloadText).toContain('"mode": "rebuild"');
    expect(payloadText).toContain('"previousSummary": ""');
    expect(readRollingSummarySidecar('session-test-id').current?.rewriteCount).toBe(0);
  });

  test('clears previousSummary when the checkpoint entry is missing and a rebuild is required', async () => {
    completeSimpleMock.mockResolvedValue(
      assistantResponse(
        JSON.stringify({
          shortTitle: 'Checkpoint rebuild',
          longTitle: 'Rebuild the rolling summary when the checkpoint entry is missing',
          shortSummary: 'Rebuilt summary after the checkpoint disappeared',
          summaryBullets: ['Completed: rebuilt after the checkpoint entry disappeared.'],
          timelineItems: [
            'Detected a missing checkpoint entry and rebuilt from the full transcript.',
          ],
        }),
      ) as any,
    );

    const harness = createHarness({
      hasUI: true,
      initialEntries: [
        messageEntry('user', 'Inspect smart sessions and notify constraints'),
        messageEntry('assistant', 'Reviewing prompts and notification limits now'),
        messageEntry('user', 'The checkpoint entry has been compacted away'),
      ],
    });

    writeRollingSummaryCurrent('session-test-id', {
      shortTitle: 'Old summary',
      longTitle: 'Old rolling summary before checkpoint rebuild',
      shortSummary: 'Older rolling summary state',
      summaryBullets: ['In Progress: keeping old rolling summary state.'],
      timelineItems: ['Generated an earlier rolling summary.'],
      rewriteCount: 2,
      checkpointEntryId: 'missing-entry',
      conversationHash: 'old-hash',
      generatedAt: '2026-04-15T00:05:00.000Z',
    });

    await harness.getCommand('summarize')({}, harness.ctx);

    const payloadText =
      completeSimpleMock.mock.calls[0]?.[1]?.messages?.[0]?.content?.[0]?.text ?? '';
    expect(payloadText).toContain('"mode": "rebuild"');
    expect(payloadText).toContain('"previousSummary": ""');
  });

  test('sends metadata and only the fresh transcript on a normal incremental refresh', async () => {
    completeSimpleMock.mockResolvedValue(
      assistantResponse(
        JSON.stringify({
          shortTitle: 'Incremental summary',
          longTitle: 'Refresh rolling summary from the previous checkpoint delta',
          shortSummary: 'Captured only the latest transcript delta',
          summaryBullets: ['Completed: refreshed from the delta transcript.'],
          timelineItems: ['Summarized only the conversation since the previous checkpoint.'],
        }),
      ) as any,
    );

    const branch = [
      messageEntry('user', 'Inspect smart sessions and notify constraints'),
      messageEntry('assistant', 'Reviewing prompts and notification limits now'),
      messageEntry('user', 'Add metadata to the unified summary payload'),
    ];
    const harness = createHarness({ hasUI: true, initialEntries: branch });

    writeRollingSummaryCurrent('session-test-id', {
      shortTitle: 'Old summary',
      longTitle: 'Old rolling summary before incremental refresh',
      shortSummary: 'Older rolling summary state',
      summaryBullets: ['In Progress: keeping old rolling summary state.'],
      timelineItems: ['Generated an earlier rolling summary.'],
      rewriteCount: 2,
      checkpointEntryId: 'entry-2',
      conversationHash: 'old-hash',
      generatedAt: '2026-04-15T00:05:00.000Z',
    });

    await harness.getCommand('summarize')({}, harness.ctx);

    const payloadText =
      completeSimpleMock.mock.calls[0]?.[1]?.messages?.[0]?.content?.[0]?.text ?? '';
    expect(payloadText).toContain('"metadata"');
    expect(payloadText).toContain('"freshMessageCount": 1');
    expect(payloadText).toContain('Add metadata to the unified summary payload');
    expect(payloadText).not.toContain('Inspect smart sessions and notify constraints');
  });
});
