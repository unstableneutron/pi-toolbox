import type { Model } from '@mariozechner/pi-ai';

import { afterEach, describe, expect, test, vi } from 'vitest';

import whimsical, {
  buildWorkingMessage,
  createWorkingMessageState,
  recordProviderRequest,
  recordToolExecutionStart,
  recordTurnStart,
} from './index';

function makeModel(overrides: Partial<Model<any>> = {}): Model<any> {
  return {
    id: 'gpt-5',
    name: 'GPT-5',
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: 'https://proxy.example/v1',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 100000,
    ...overrides,
  } as Model<any>;
}

function hyperlink(url: string, label: string): string {
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

function makeLongProxyModel(): Model<any> {
  return makeModel({
    provider: 'facade',
    id: 'gpt-5.4',
    baseUrl: 'https://proxy.example.com/api/v2/proxy/experimental/azure_openai/openai/v1',
  });
}

function makeAssistantErrorMessage(errorMessage: string): any {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-responses',
    provider: 'openai',
    model: 'gpt-5',
    usage: { input: 0, output: 0, total: 0 },
    stopReason: 'error',
    errorMessage,
    timestamp: Date.now(),
  };
}

function makeTheme() {
  return {
    fg: (_token: string, text: string) => text,
  };
}

function makeTokenTheme() {
  return {
    fg: (token: string, text: string) => `<${token}>${text}</${token}>`,
  };
}

describe('working-message helpers', () => {
  test('counts turns and tools while reusing cached metadata when model is missing', () => {
    const whimsy = 'Whimming...';

    let state = createWorkingMessageState();
    state = recordTurnStart(state);
    state = recordProviderRequest(state, makeModel());

    expect(buildWorkingMessage(whimsy, state)).toBe(
      `Whimming... · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
    );

    state = recordProviderRequest(state, undefined);

    expect(buildWorkingMessage(whimsy, state)).toBe(
      `Whimming... · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
    );

    state = recordToolExecutionStart(state);

    expect(buildWorkingMessage(whimsy, state)).toBe(
      `Whimming... · ⚒1 · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
    );

    state = recordTurnStart(state);
    state = recordToolExecutionStart(state);

    expect(buildWorkingMessage(whimsy, state)).toBe(
      `Whimming... · ↺2 ⚒2 · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
    );
  });

  test('omits provider-default base urls and clears stale custom urls on later turns', () => {
    const whimsy = 'Whimming...';

    let state = createWorkingMessageState();
    state = recordTurnStart(state);
    state = recordProviderRequest(state, makeModel());
    state = recordTurnStart(state);
    state = recordProviderRequest(state, makeModel({ baseUrl: 'https://api.openai.com/v1' }));

    expect(buildWorkingMessage(whimsy, state)).toBe('Whimming... · ↺2');
  });

  test('treats normalized default urls as default (e.g. trailing slash)', () => {
    const whimsy = 'Whimming...';

    let state = createWorkingMessageState();
    state = recordTurnStart(state);
    state = recordProviderRequest(state, makeModel({ baseUrl: 'https://api.openai.com/v1/' }));

    expect(buildWorkingMessage(whimsy, state)).toBe('Whimming...');
  });

  test('supports default base-url templates like google-vertex {location}', () => {
    const whimsy = 'Whimming...';

    let state = createWorkingMessageState();
    state = recordTurnStart(state);
    state = recordProviderRequest(
      state,
      makeModel({
        provider: 'google-vertex',
        id: 'gemini-2.5-pro',
        baseUrl: 'https://us-central1-aiplatform.googleapis.com',
      }),
    );

    expect(buildWorkingMessage(whimsy, state)).toBe('Whimming...');
  });

  test('formats the agent timer across seconds, minutes, and hours', () => {
    const whimsy = 'Whimming...';

    let state = createWorkingMessageState();
    state = recordTurnStart(state);
    state = recordProviderRequest(state, makeModel());

    expect(buildWorkingMessage(whimsy, state, 900)).toBe(
      `Whimming... · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
    );

    expect(buildWorkingMessage(whimsy, state, 15_500)).toBe(
      `Whimming... · 15.5s · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
    );

    expect(buildWorkingMessage(whimsy, state, 195_000)).toBe(
      `Whimming... · 3m15s · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
    );

    expect(buildWorkingMessage(whimsy, state, 4_325_000)).toBe(
      `Whimming... · 1h12m5s · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
    );
  });

  test('reduces valid custom base urls to the host in working messages', () => {
    const whimsy = 'Whimming...';

    let state = createWorkingMessageState();
    state = recordTurnStart(state);
    state = recordProviderRequest(state, makeLongProxyModel());

    expect(buildWorkingMessage(whimsy, state)).toBe(
      `Whimming... · via ${hyperlink(
        'https://proxy.example.com/api/v2/proxy/experimental/azure_openai/openai/v1',
        'proxy.example.com',
      )}`,
    );
  });

  test('reduces one- and two-segment custom base urls to the host in working messages', () => {
    const whimsy = 'Whimming...';

    let oneSegmentState = createWorkingMessageState();
    oneSegmentState = recordTurnStart(oneSegmentState);
    oneSegmentState = recordProviderRequest(
      oneSegmentState,
      makeModel({ baseUrl: 'https://proxy.example/v1' }),
    );

    expect(buildWorkingMessage(whimsy, oneSegmentState)).toBe(
      `Whimming... · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
    );

    let twoSegmentState = createWorkingMessageState();
    twoSegmentState = recordTurnStart(twoSegmentState);
    twoSegmentState = recordProviderRequest(
      twoSegmentState,
      makeModel({ baseUrl: 'https://proxy.example/openai/v1' }),
    );

    expect(buildWorkingMessage(whimsy, twoSegmentState)).toBe(
      `Whimming... · via ${hyperlink('https://proxy.example/openai/v1', 'proxy.example')}`,
    );
  });

  test('drops userinfo from valid custom base urls before hyperlinking', () => {
    const whimsy = 'Whimming...';

    let state = createWorkingMessageState();
    state = recordTurnStart(state);
    state = recordProviderRequest(
      state,
      makeModel({ baseUrl: 'https://user:pass@proxy.example/openai/v1' }),
    );

    const message = buildWorkingMessage(whimsy, state);

    expect(message).toBe(
      `Whimming... · via ${hyperlink('https://proxy.example/openai/v1', 'proxy.example')}`,
    );
    expect(message).not.toContain('user:pass');
    expect(message).not.toContain('user:pass@');
  });

  test('redacts userinfo from malformed custom base urls without hyperlinking', () => {
    const whimsy = 'Whimming...';

    let state = createWorkingMessageState();
    state = recordTurnStart(state);
    state = recordProviderRequest(
      state,
      makeModel({ baseUrl: 'https://user:pass@proxy.example:99999/openai/v1' }),
    );

    const message = buildWorkingMessage(whimsy, state);

    expect(message).toBe('Whimming... · via https://proxy.example:99999/openai/v1');
    expect(message).not.toContain('user:pass');
    expect(message).not.toContain('\u001B]8;;');
  });

  test.each([
    {
      baseUrl: 'https://user:pass@bad host/openai/v1',
      redactedVia: 'https://bad host/openai/v1',
      credentials: 'user:pass',
    },
    {
      baseUrl: 'https://user:p@ss@proxy.example:99999/openai/v1',
      redactedVia: 'https://proxy.example:99999/openai/v1',
      credentials: 'user:p@ss',
    },
  ])(
    'redacts malformed authority userinfo fallback for $baseUrl',
    ({ baseUrl, redactedVia, credentials }) => {
      const whimsy = 'Whimming...';

      let state = createWorkingMessageState();
      state = recordTurnStart(state);
      state = recordProviderRequest(state, makeModel({ baseUrl }));

      const message = buildWorkingMessage(whimsy, state);

      expect(message).toBe(`Whimming... · via ${redactedVia}`);
      expect(message).not.toContain(credentials);
      expect(message).not.toContain('\u001B]8;;');
    },
  );

  test('renders malformed base urls as plain sanitized text', () => {
    const whimsy = 'Whimming...';

    let state = createWorkingMessageState();
    state = recordTurnStart(state);
    state = recordProviderRequest(state, makeModel({ baseUrl: 'notaurl\u0007/openai/v1' }));

    const message = buildWorkingMessage(whimsy, state);

    expect(message).toBe('Whimming... · via notaurl/openai/v1');
    expect(message).not.toContain('\u001B]8;;');
  });

  test('strips C1 control characters from malformed base urls without hyperlinking', () => {
    const whimsy = 'Whimming...';

    let state = createWorkingMessageState();
    state = recordTurnStart(state);
    state = recordProviderRequest(state, makeModel({ baseUrl: 'notaurl\u009D/openai/v1' }));

    const message = buildWorkingMessage(whimsy, state);

    expect(message).toBe('Whimming... · via notaurl/openai/v1');
    expect(message).not.toContain('\u001B]8;;');
  });

  test('renders valid non-http(s) base urls as plain text', () => {
    const whimsy = 'Whimming...';

    let state = createWorkingMessageState();
    state = recordTurnStart(state);
    state = recordProviderRequest(state, makeModel({ baseUrl: 'ftp://proxy.example/openai/v1' }));

    const message = buildWorkingMessage(whimsy, state);

    expect(message).toBe('Whimming... · via proxy.example');
    expect(message).not.toContain('\u001B]8;;');
  });
});

describe('whimsical extension lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('keeps metadata across turns in the same agent and resets on agent end', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
        handlers.set(event, handler);
      },
    } as any;

    whimsical(pi);

    const workingMessages: Array<string | undefined> = [];
    const statuses: Array<string | undefined> = [];
    let currentModel: Model<any> | undefined = makeModel();
    const ctx = {
      hasUI: true,
      ui: {
        theme: makeTheme(),
        setWorkingMessage(message?: string) {
          workingMessages.push(message);
        },
        setStatus(_key: string, text?: string) {
          statuses.push(text);
        },
      },
      get model() {
        return currentModel;
      },
    } as any;

    await handlers.get('agent_start')?.({ type: 'agent_start' }, ctx);
    await handlers.get('turn_start')?.({ type: 'turn_start', turnIndex: 0 }, ctx);
    await handlers.get('before_provider_request')?.({ type: 'before_provider_request' }, ctx);
    await handlers.get('turn_end')?.({ type: 'turn_end', turnIndex: 0 }, ctx);

    vi.setSystemTime(new Date(13_400));
    currentModel = undefined;
    await handlers.get('turn_start')?.({ type: 'turn_start', turnIndex: 1 }, ctx);
    await handlers.get('before_provider_request')?.({ type: 'before_provider_request' }, ctx);
    await handlers.get('turn_end')?.({ type: 'turn_end', turnIndex: 1 }, ctx);
    await handlers.get('agent_end')?.({ type: 'agent_end', messages: [] }, ctx);

    expect(workingMessages).toEqual([
      'Schlepping...',
      `Schlepping... · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
      `Schlepping... · ↺2 · 12.4s · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
      undefined,
    ]);
    expect(statuses).toEqual([]);
  });

  test('refreshes the timer and live tool counts every 100ms while the agent is active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
        handlers.set(event, handler);
      },
    } as any;

    whimsical(pi);

    const workingMessages: Array<string | undefined> = [];
    const ctx = {
      hasUI: true,
      model: makeModel(),
      ui: {
        theme: makeTheme(),
        setWorkingMessage(message?: string) {
          workingMessages.push(message);
        },
        setStatus() {},
      },
    } as any;

    await handlers.get('agent_start')?.({ type: 'agent_start' }, ctx);
    await handlers.get('turn_start')?.({ type: 'turn_start', turnIndex: 0 }, ctx);
    await handlers.get('before_provider_request')?.({ type: 'before_provider_request' }, ctx);
    await handlers.get('tool_execution_start')?.(
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: {} },
      ctx,
    );

    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(900);
    expect(workingMessages).toEqual([
      'Schlepping...',
      `Schlepping... · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
      `Schlepping... · ⚒1 · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
    ]);

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await handlers.get('agent_end')?.({ type: 'agent_end', messages: [] }, ctx);

    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(workingMessages).toEqual([
      'Schlepping...',
      `Schlepping... · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
      `Schlepping... · ⚒1 · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
      `Schlepping... · ⚒1 · 1.0s · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
      `Schlepping... · ⚒1 · 1.1s · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
      undefined,
    ]);
  });

  test('clears working message state on session switch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
        handlers.set(event, handler);
      },
    } as any;

    whimsical(pi);

    const workingMessages: Array<string | undefined> = [];
    const ctx = {
      hasUI: true,
      model: makeModel(),
      ui: {
        theme: makeTheme(),
        setWorkingMessage(message?: string) {
          workingMessages.push(message);
        },
        setStatus() {},
      },
    } as any;

    await handlers.get('agent_start')?.({ type: 'agent_start' }, ctx);
    await handlers.get('turn_start')?.({ type: 'turn_start', turnIndex: 0 }, ctx);
    await handlers.get('before_provider_request')?.({ type: 'before_provider_request' }, ctx);

    expect(vi.getTimerCount()).toBe(1);

    await handlers.get('session_start')?.({ type: 'session_start', reason: 'resume' }, ctx);

    expect(vi.getTimerCount()).toBe(0);

    expect(workingMessages).toEqual([
      'Schlepping...',
      `Schlepping... · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
      undefined,
    ]);
  });

  test('clears the timer ticker on session shutdown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
        handlers.set(event, handler);
      },
    } as any;

    whimsical(pi);

    const workingMessages: Array<string | undefined> = [];
    const ctx = {
      hasUI: true,
      model: makeModel(),
      ui: {
        theme: makeTheme(),
        setWorkingMessage(message?: string) {
          workingMessages.push(message);
        },
        setStatus() {},
      },
    } as any;

    await handlers.get('agent_start')?.({ type: 'agent_start' }, ctx);
    await handlers.get('turn_start')?.({ type: 'turn_start', turnIndex: 0 }, ctx);
    await handlers.get('before_provider_request')?.({ type: 'before_provider_request' }, ctx);

    expect(vi.getTimerCount()).toBe(1);

    await handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, ctx);

    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(workingMessages).toEqual([
      'Schlepping...',
      `Schlepping... · via ${hyperlink('https://proxy.example/v1', 'proxy.example')}`,
      undefined,
    ]);
  });

  test('sets a long-run informational status after agent end and clears it before the next agent start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
        handlers.set(event, handler);
      },
    } as any;

    whimsical(pi);

    const statuses: Array<string | undefined> = [];
    const ctx = {
      hasUI: true,
      model: makeModel(),
      ui: {
        theme: makeTokenTheme(),
        setWorkingMessage() {},
        setStatus(_key: string, text?: string) {
          statuses.push(text);
        },
      },
    } as any;

    await handlers.get('agent_start')?.({ type: 'agent_start' }, ctx);
    await handlers.get('turn_start')?.({ type: 'turn_start', turnIndex: 0 }, ctx);
    await handlers.get('before_provider_request')?.({ type: 'before_provider_request' }, ctx);
    await handlers.get('tool_execution_start')?.(
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: {} },
      ctx,
    );

    vi.setSystemTime(new Date(31_500));
    await handlers.get('turn_start')?.({ type: 'turn_start', turnIndex: 1 }, ctx);
    await handlers.get('agent_end')?.({ type: 'agent_end', messages: [] }, ctx);

    expect(statuses.at(-1)).toBe(
      '<success>✓ Completed</success> ↺2 ⚒1 <dim>in</dim> <accent>30.5s</accent> <muted>via proxy.example</muted>',
    );

    await handlers.get('before_agent_start')?.(
      { type: 'before_agent_start', prompt: 'next', systemPrompt: '' },
      ctx,
    );

    expect(statuses.at(-1)).toBeUndefined();
  });

  test('sets an error status for final assistant errors regardless of turns or duration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
        handlers.set(event, handler);
      },
    } as any;

    whimsical(pi);

    const statuses: Array<string | undefined> = [];
    const ctx = {
      hasUI: true,
      model: makeModel(),
      ui: {
        theme: makeTokenTheme(),
        setWorkingMessage() {},
        setStatus(_key: string, text?: string) {
          statuses.push(text);
        },
      },
    } as any;

    await handlers.get('agent_start')?.({ type: 'agent_start' }, ctx);
    await handlers.get('turn_start')?.({ type: 'turn_start', turnIndex: 0 }, ctx);
    await handlers.get('before_provider_request')?.({ type: 'before_provider_request' }, ctx);

    vi.setSystemTime(new Date(2_500));
    await handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [
          makeAssistantErrorMessage(
            'Error: 400 The encrypted content for item rs_085d14f0dccbdec40169ced62664108193bf46f58a51aabcd1 could not be verified.',
          ),
        ],
      },
      ctx,
    );

    expect(statuses.at(-1)).toBe(
      '<error>× 400 Error</error> <dim>in</dim> <accent>1.5s</accent> <muted>via proxy.example</muted>',
    );
  });

  test('clears a stale error status immediately on agent_start without before_agent_start', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
        handlers.set(event, handler);
      },
    } as any;

    whimsical(pi);

    const statuses: Array<string | undefined> = [];
    const ctx = {
      hasUI: true,
      model: makeModel(),
      ui: {
        theme: makeTokenTheme(),
        setWorkingMessage() {},
        setStatus(_key: string, text?: string) {
          statuses.push(text);
        },
      },
    } as any;

    await handlers.get('agent_start')?.({ type: 'agent_start' }, ctx);
    await handlers.get('turn_start')?.({ type: 'turn_start', turnIndex: 0 }, ctx);
    await handlers.get('before_provider_request')?.({ type: 'before_provider_request' }, ctx);

    vi.setSystemTime(new Date(2_500));
    await handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [
          makeAssistantErrorMessage('Error: 400 The encrypted content could not be verified.'),
        ],
      },
      ctx,
    );

    expect(statuses.at(-1)).toBe(
      '<error>× 400 Error</error> <dim>in</dim> <accent>1.5s</accent> <muted>via proxy.example</muted>',
    );

    await handlers.get('agent_start')?.({ type: 'agent_start' }, ctx);

    expect(statuses.at(-1)).toBeUndefined();
  });

  test('clears a stale error status when the next agent end has no completion status', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
        handlers.set(event, handler);
      },
    } as any;

    whimsical(pi);

    const statuses: Array<string | undefined> = [];
    const ctx = {
      hasUI: true,
      model: makeModel(),
      ui: {
        theme: makeTokenTheme(),
        setWorkingMessage() {},
        setStatus(_key: string, text?: string) {
          statuses.push(text);
        },
      },
    } as any;

    await handlers.get('agent_start')?.({ type: 'agent_start' }, ctx);
    await handlers.get('turn_start')?.({ type: 'turn_start', turnIndex: 0 }, ctx);
    await handlers.get('before_provider_request')?.({ type: 'before_provider_request' }, ctx);

    vi.setSystemTime(new Date(2_500));
    await handlers.get('agent_end')?.(
      {
        type: 'agent_end',
        messages: [
          makeAssistantErrorMessage('Error: 400 The encrypted content could not be verified.'),
        ],
      },
      ctx,
    );

    expect(statuses.at(-1)).toBe(
      '<error>× 400 Error</error> <dim>in</dim> <accent>1.5s</accent> <muted>via proxy.example</muted>',
    );

    await handlers.get('agent_start')?.({ type: 'agent_start' }, ctx);
    await handlers.get('turn_start')?.({ type: 'turn_start', turnIndex: 0 }, ctx);
    await handlers.get('before_provider_request')?.({ type: 'before_provider_request' }, ctx);

    vi.setSystemTime(new Date(3_000));
    await handlers.get('agent_end')?.({ type: 'agent_end', messages: [] }, ctx);

    expect(statuses.at(-1)).toBeUndefined();
  });
});
