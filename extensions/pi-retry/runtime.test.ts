import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  STOCK_REFUSAL_CONTINUE_MESSAGES,
  buildRecoveryStatus,
  branchLatestAssistantErrorOutOfMainPath,
  clearRuntimeState,
  detectRetryableTerminalLeaf,
  dispatchPendingRecovery,
  formatRecoveryAttemptSuffix,
  handleRecoveryAbort,
  getPendingRecovery,
  getRefusalContinueAttempt,
  getRefusalAttempt,
  handleRefusalRecovery,
  pickStockContinueMessage,
  resolveRecoveryOnAssistantMessage,
  registerPatchedSession,
  sanitizeEncryptedReasoningOnCurrentBranch,
} from './runtime';

function createDispatchUi(statusCalls: (string | undefined)[]) {
  return {
    setStatus: (text: string) => statusCalls.push(text),
    clearStatus: () => statusCalls.push(undefined),
    notify: vi.fn(),
  };
}

function createFakeErrorSession() {
  const entries = [
    {
      id: 'user-1',
      parentId: undefined,
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'Build a plan' }] },
    },
    {
      id: 'assistant-error',
      parentId: 'user-1',
      type: 'message',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'The server had an error processing your request',
        content: [],
      },
    },
  ];

  const sessionManager = {
    leafId: 'assistant-error',
    customEntries: [] as { customType: string; data: unknown }[],
    getSessionId: () => 'session-1',
    getLeafId() {
      return this.leafId;
    },
    getEntries() {
      return entries;
    },
    appendCustomEntry(customType: string, data: unknown) {
      this.customEntries.push({ customType, data });
      return 'custom-1';
    },
    branch(entryId: string) {
      this.leafId = entryId;
    },
  };

  return { sessionManager, entries, session: { sessionManager } };
}

function createFakeAbortedSession(options?: {
  outputText?: string;
  includeToolCall?: boolean;
  usage?: { input?: number; output?: number; total?: number };
}) {
  const entries = [
    {
      id: 'user-1',
      parentId: undefined,
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'Build a plan' }] },
    },
    {
      id: 'assistant-aborted',
      parentId: 'user-1',
      type: 'message',
      message: {
        role: 'assistant',
        stopReason: 'aborted',
        errorMessage: 'Operation aborted',
        usage: options?.usage ?? { input: 0, output: 0, total: 0 },
        content: [
          ...(options?.outputText
            ? [{ type: 'text', text: options.outputText }]
            : [{ type: 'thinking', thinking: 'Need to inspect sample code more closely.' }]),
          ...(options?.includeToolCall
            ? [{ type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: '/tmp/x' } }]
            : []),
        ],
      },
    },
  ];

  const sessionManager = {
    leafId: 'assistant-aborted',
    customEntries: [] as { customType: string; data: unknown }[],
    getSessionId: () => 'session-1',
    getLeafId() {
      return this.leafId;
    },
    getEntries() {
      return entries;
    },
    appendCustomEntry(customType: string, data: unknown) {
      this.customEntries.push({ customType, data });
      return 'custom-1';
    },
    branch(entryId: string) {
      this.leafId = entryId;
    },
  };

  return { sessionManager, entries, session: { sessionManager } };
}

function createSessionWithTrailingCustomLeaf(assistantMessage: {
  stopReason: 'stop' | 'error';
  content?: unknown;
  errorMessage?: string;
}) {
  const entries = [
    {
      id: 'user-1',
      parentId: undefined,
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'Investigate this session' }] },
    },
    {
      id: 'assistant-1',
      parentId: 'user-1',
      type: 'message',
      message: {
        role: 'assistant',
        stopReason: assistantMessage.stopReason,
        content: assistantMessage.content ?? [],
        ...(assistantMessage.errorMessage ? { errorMessage: assistantMessage.errorMessage } : {}),
      },
    },
    {
      id: 'custom-1',
      parentId: 'assistant-1',
      type: 'custom',
      customType: 'smart-sessions/summary-cache',
      data: { cached: true },
    },
  ] as any[];

  return {
    sessionManager: {
      getSessionId: () => 'session-1',
      getLeafId: () => 'custom-1',
      getEntries: () => entries,
    },
  };
}

function createFakeEncryptedReasoningSession() {
  const encryptedSignature = JSON.stringify({
    id: 'rs_branch',
    type: 'reasoning',
    encrypted_content: 'opaque-branch-payload',
  });
  const offBranchEncryptedSignature = JSON.stringify({
    id: 'rs_off_branch',
    type: 'reasoning',
    encrypted_content: 'opaque-off-branch-payload',
  });
  const plainSignature = JSON.stringify({
    id: 'rs_plain',
    type: 'reasoning',
  });

  const entries = [
    {
      id: 'user-1',
      parentId: undefined,
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'Investigate this session' }] },
    },
    {
      id: 'assistant-branch',
      parentId: 'user-1',
      type: 'message',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [
          {
            type: 'thinking',
            thinking: 'Need to reason through branch payloads.',
            thinkingSignature: encryptedSignature,
          },
          {
            type: 'thinking',
            thinking: 'Keep plain signature intact.',
            thinkingSignature: plainSignature,
          },
          { type: 'text', text: 'Intermediate answer' },
        ],
      },
    },
    {
      id: 'assistant-off-branch',
      parentId: 'user-1',
      type: 'message',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [
          {
            type: 'thinking',
            thinking: 'Off-branch reasoning should stay untouched.',
            thinkingSignature: offBranchEncryptedSignature,
          },
        ],
      },
    },
    {
      id: 'user-2',
      parentId: 'assistant-branch',
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
    },
    {
      id: 'assistant-error',
      parentId: 'user-2',
      type: 'message',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage:
          '400 The encrypted content for item rs_00777bf6bda135fe0169deb0b1cd0c8197954b327221babc62 could not be verified. Reason: Encrypted content could not be decrypted or parsed.',
        content: [],
      },
    },
  ] as any[];

  const sessionManager = {
    leafId: 'assistant-error',
    getSessionId: () => 'session-1',
    getLeafId() {
      return this.leafId;
    },
    getEntries() {
      return entries;
    },
    branch(entryId: string) {
      this.leafId = entryId;
    },
    _buildIndex: vi.fn(),
    _rewriteFile: vi.fn(),
  };

  return {
    sessionManager,
    session: { sessionManager },
    entries,
    encryptedSignature,
    offBranchEncryptedSignature,
    plainSignature,
  };
}

function createFakeCreatedByCompactionSession() {
  const entries = [
    {
      id: 'user-1',
      parentId: undefined,
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'Investigate this session' }] },
    },
    {
      id: 'compaction-1',
      parentId: 'user-1',
      type: 'compaction',
      summary: '[OpenAI native compaction checkpoint]',
      firstKeptEntryId: 'user-1',
      tokensBefore: 123,
      details: {
        strategy: 'openai-native-compact-v1',
        provider: 'devai',
        api: 'openai-responses',
        model: 'gpt-5.4',
        compactedWindow: [
          {
            type: 'message',
            role: 'assistant',
            id: 'cmp-1',
            status: 'completed',
            created_by: {
              type: 'system',
              name: 'responses-api',
            },
            content: [{ type: 'output_text', text: 'Compacted output', annotations: [] }],
          },
        ],
      },
    },
    {
      id: 'user-2',
      parentId: 'compaction-1',
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
    },
    {
      id: 'assistant-error',
      parentId: 'user-2',
      type: 'message',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage:
          'Error: 400 litellm.BadRequestError: AzureException BadRequestError - { "error": { "message": "Unknown parameter: \'input[26].created_by\'.", "type": "invalid_request_error", "param": "input[26].created_by", "code": "unknown_parameter" } }.',
        content: [],
      },
    },
  ] as any[];

  const sessionManager = {
    leafId: 'assistant-error',
    getSessionId: () => 'session-1',
    getLeafId() {
      return this.leafId;
    },
    getEntries() {
      return entries;
    },
    branch(entryId: string) {
      this.leafId = entryId;
    },
    _buildIndex: vi.fn(),
    _rewriteFile: vi.fn(),
  };

  return {
    sessionManager,
    session: { sessionManager },
    entries,
  };
}

const REFUSAL_TEXT = "I'm sorry, but I cannot assist with that request.";

function refusalEvent(text = REFUSAL_TEXT) {
  return {
    messages: [
      {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text }],
      },
    ],
  };
}

function emptyStopEvent() {
  return {
    messages: [
      {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'thinking', thinking: 'Need to inspect sample code more closely.' }],
      },
    ],
  };
}

function createFakeRefusalSession() {
  const entries = [
    {
      id: 'user-1',
      parentId: undefined,
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] },
    },
  ] as any[];

  const sessionManager = {
    leafId: 'user-1',
    customEntries: [] as { customType: string; data: unknown }[],
    getSessionId: () => 'session-1',
    getLeafId() {
      return this.leafId;
    },
    getEntries() {
      return entries;
    },
    appendCustomEntry(customType: string, data: unknown) {
      this.customEntries.push({ customType, data });
      return `custom-${this.customEntries.length}`;
    },
    branch(entryId: string) {
      this.leafId = entryId;
    },
  };

  function pushRefusal(id: string, text = REFUSAL_TEXT) {
    entries.push({
      id,
      parentId: 'user-1',
      type: 'message',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text }],
      },
    });
    sessionManager.leafId = id;
  }

  return { sessionManager, entries, session: { sessionManager }, pushRefusal };
}

function createCtx(sessionManager: any, overrides: { [key: string]: unknown } = {}) {
  const statusCalls: (string | undefined)[] = [];
  const notify = vi.fn();
  const ctx = {
    hasUI: true,
    ui: {
      setStatus: (_key: string, text: string | undefined) => statusCalls.push(text),
      notify,
    },
    model: { provider: 'gust', id: 'claude-sonnet-4-6', api: 'anthropic-messages' },
    modelRegistry: {
      getAvailable: () => [
        { provider: 'gust', id: 'gpt-5.4', api: 'openai-responses', reasoning: true },
        {
          provider: 'gust',
          id: 'gemini-3.1-pro-preview',
          api: 'google-generative-ai',
          reasoning: true,
        },
      ],
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: 'test-key', headers: {} }),
    },
    sessionManager: {
      getSessionId: () => 'session-1',
      getEntries: sessionManager.getEntries,
    },
    signal: undefined,
    ...overrides,
  } as any;

  return { ctx, statusCalls, notify };
}

afterEach(() => {
  delete process.env.PI_RETRY_REFUSAL_CONTINUE_ATTEMPTS;
  delete process.env.PI_RETRY_REFUSAL_REWRITE_ATTEMPTS;
  delete process.env.PI_RETRY_REFUSAL_REWRITES_DISABLED;
  clearRuntimeState();
  vi.useRealTimers();
});

function expectStockContinueMessage(message: string | undefined) {
  expect(message).toBeTruthy();
  expect(STOCK_REFUSAL_CONTINUE_MESSAGES).toContain(message);
}

function expectStockContinueMessages(messages: string[]) {
  expect(messages).toHaveLength(5);
  for (const message of messages) {
    expectStockContinueMessage(message);
  }
}

async function exhaustRefusalContinuePhase(input: {
  session: any;
  sessionManager: any;
  pushRefusal: (id: string, text?: string) => void;
  ctx: any;
  reviewRewrite: any;
  sendUserMessage: any;
  statusCalls?: (string | undefined)[];
}) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    input.pushRefusal(`assistant-refusal-${attempt}`);
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx: input.ctx,
      patchedSession: input.session as any,
      reviewRewrite: input.reviewRewrite,
      sendUserMessage: input.sendUserMessage,
    });
    await dispatchPendingRecovery({
      sessionId: 'session-1',
      sendUserMessage: input.sendUserMessage,
      ui: input.statusCalls ? createDispatchUi(input.statusCalls) : undefined,
    });
  }
}

describe('recovery status helpers', () => {
  test('hides the 1/3 suffix and shows 2/3+ suffixes', () => {
    expect(formatRecoveryAttemptSuffix(1, 3)).toBe('');
    expect(formatRecoveryAttemptSuffix(2, 3)).toBe(' · 2/3');
    expect(formatRecoveryAttemptSuffix(3, 3)).toBe(' · 3/3');
  });

  test('picks a different stock continue message when the previous message is known', () => {
    expect(
      pickStockContinueMessage({
        previousMessage: STOCK_REFUSAL_CONTINUE_MESSAGES[0],
        random: () => 0,
      }),
    ).not.toBe(STOCK_REFUSAL_CONTINUE_MESSAGES[0]);
  });

  test('renders queued, sent, and reviewing statuses from active recovery state', () => {
    expect(
      buildRecoveryStatus({
        kind: 'refusal',
        phase: 'queued',
        attempt: 1,
        messageKind: 'continue',
      }),
    ).toBe('↻ Refusal detected; retrying...');
    expect(
      buildRecoveryStatus({
        kind: 'refusal',
        phase: 'queued',
        attempt: 2,
        messageKind: 'continue',
      }),
    ).toBe('↻ Refusal detected; retrying... · 2/5');
    expect(
      buildRecoveryStatus({ kind: 'refusal', phase: 'sent', attempt: 1, messageKind: 'continue' }),
    ).toBe('↻ Continue sent; waiting for recovery...');
    expect(
      buildRecoveryStatus({
        kind: 'refusal',
        phase: 'reviewing',
        attempt: 2,
        messageKind: 'rewrite',
        reviewModelId: 'gpt-5.4',
      }),
    ).toBe('↻ Refusal detected; asking gpt-5.4 for review... · 2/2');
    expect(
      buildRecoveryStatus({
        kind: 'empty-stop',
        phase: 'queued',
        attempt: 2,
        messageKind: 'continue',
      }),
    ).toBe('↻ Empty assistant response; retrying with Continue... · 2/3');
    expect(
      buildRecoveryStatus({
        kind: 'empty-stop',
        phase: 'sent',
        attempt: 3,
        messageKind: 'continue',
      }),
    ).toBe('↻ Continue sent; waiting for recovery... · 3/3');
  });
});

describe('branchLatestAssistantErrorOutOfMainPath', () => {
  test('moves the leaf to the failed entry parent and appends debug metadata', () => {
    const { sessionManager, session } = createFakeErrorSession();
    registerPatchedSession(session as any);

    const result = branchLatestAssistantErrorOutOfMainPath(session as any, {
      attempt: 1,
      errorMessage: 'The server had an error processing your request',
      reason: 'providerServerError',
    });

    expect(result).toEqual({
      branched: true,
      failedEntryId: 'assistant-error',
      parentEntryId: 'user-1',
    });
    expect(sessionManager.leafId).toBe('user-1');
    expect(sessionManager.customEntries).toEqual([]);
  });
});

describe('sanitizeEncryptedReasoningOnCurrentBranch', () => {
  test('clears encrypted thinking signatures only on the current branch and rewrites the session', () => {
    const { session, sessionManager, entries, offBranchEncryptedSignature, plainSignature } =
      createFakeEncryptedReasoningSession();

    const result = sanitizeEncryptedReasoningOnCurrentBranch(session as any);

    expect(result).toEqual({ sanitizedMessages: 1, sanitizedBlocks: 1 });
    expect(entries[1].message.content[0].thinkingSignature).toBeUndefined();
    expect(entries[1].message.content[1].thinkingSignature).toBe(plainSignature);
    expect(entries[2].message.content[0].thinkingSignature).toBe(offBranchEncryptedSignature);
    expect(sessionManager._buildIndex).toHaveBeenCalledTimes(1);
    expect(sessionManager._rewriteFile).toHaveBeenCalledTimes(1);
  });
});

describe('detectRetryableTerminalLeaf', () => {
  test('walks backward from a trailing custom leaf to the nearest terminal assistant refusal', () => {
    const { sessionManager } = createSessionWithTrailingCustomLeaf({
      stopReason: 'stop',
      content: [{ type: 'text', text: REFUSAL_TEXT }],
    });

    expect(detectRetryableTerminalLeaf(sessionManager as any)).toMatchObject({
      kind: 'refusal',
      entryId: 'assistant-1',
      parentEntryId: 'user-1',
    });
  });

  test('does not treat mixed answer plus refusal tail content as a retryable refusal', () => {
    const { sessionManager } = createSessionWithTrailingCustomLeaf({
      stopReason: 'stop',
      content: [
        {
          type: 'text',
          text: [
            'Done. I traced the ExampleService snapshot path end-to-end and validated it against retry/backoff behavior.',
            REFUSAL_TEXT,
          ].join('\n\n'),
        },
      ],
    });

    expect(detectRetryableTerminalLeaf(sessionManager as any)).toBeUndefined();
  });

  test('does not treat aborted leaves as retryable even with zero usage', () => {
    const { sessionManager } = createFakeAbortedSession();

    expect(detectRetryableTerminalLeaf(sessionManager as any)).toBeUndefined();
  });

  test('does not treat aborted leaves with visible output as retryable', () => {
    const { sessionManager } = createFakeAbortedSession({ outputText: 'Partial answer' });

    expect(detectRetryableTerminalLeaf(sessionManager as any)).toBeUndefined();
  });

  test('does not treat aborted leaves with non-zero usage as retryable', () => {
    const { sessionManager } = createFakeAbortedSession({
      usage: { input: 1, output: 0, total: 1 },
    });

    expect(detectRetryableTerminalLeaf(sessionManager as any)).toBeUndefined();
  });

  test('does not treat aborted leaves with tool calls as retryable', () => {
    const { sessionManager } = createFakeAbortedSession({ includeToolCall: true });

    expect(detectRetryableTerminalLeaf(sessionManager as any)).toBeUndefined();
  });
});

describe('handleRefusalRecovery', () => {
  test('clears queued recovery immediately when recovery abort is triggered', async () => {
    const reviewRewrite = vi.fn();
    const sendUserMessage = vi.fn();
    const { session, pushRefusal } = createFakeRefusalSession();
    pushRefusal('assistant-refusal-1');

    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx: createCtx(session.sessionManager).ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(getPendingRecovery('session-1')).toBeDefined();

    handleRecoveryAbort('session-1');

    expect(getPendingRecovery('session-1')).toBeUndefined();
    expect(getRefusalContinueAttempt('session-1')).toBe(0);
    expect(getRefusalAttempt('session-1')).toBe(0);
  });

  test('branches the first refusal and queues a stock continue message before asking review models', async () => {
    const reviewRewrite = vi.fn();
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    pushRefusal('assistant-refusal-1');
    const { ctx, statusCalls, notify } = createCtx(sessionManager);

    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(reviewRewrite).not.toHaveBeenCalled();
    expect(statusCalls).toEqual(['↻ Refusal detected; retrying...']);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getPendingRecovery('session-1')?.kind).toBe('refusal');
    expectStockContinueMessage(getPendingRecovery('session-1')?.message);

    await dispatchPendingRecovery({ sessionId: 'session-1', sendUserMessage });

    expectStockContinueMessage(sendUserMessage.mock.calls[0]?.[0]);
    expect(getPendingRecovery('session-1')).toBeUndefined();
    expect(sessionManager.leafId).toBe('user-1');
    expect(sessionManager.customEntries).toHaveLength(0);
    expect(getRefusalAttempt('session-1')).toBe(0);
    expect(getRefusalContinueAttempt('session-1')).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });

  test('uses five stock continue messages before entering rewrite review', async () => {
    const reviewRewrite = vi.fn().mockResolvedValue({ reason: 'first', rewrite: 'rewrite 1' });
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const { ctx, notify } = createCtx(sessionManager);

    await exhaustRefusalContinuePhase({
      session,
      sessionManager,
      pushRefusal,
      ctx,
      reviewRewrite,
      sendUserMessage,
    });

    expect(reviewRewrite).not.toHaveBeenCalled();
    expectStockContinueMessages(sendUserMessage.mock.calls.map(([message]) => message));
    expect(getRefusalContinueAttempt('session-1')).toBe(5);
    expect(getRefusalAttempt('session-1')).toBe(0);
    expect(notify).not.toHaveBeenCalled();

    pushRefusal('assistant-refusal-6');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(reviewRewrite).toHaveBeenCalledTimes(1);
  });

  test('updates queued Continue status to waiting once dispatch sends the message', async () => {
    const reviewRewrite = vi.fn();
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const { ctx, statusCalls } = createCtx(sessionManager);

    pushRefusal('assistant-refusal-1');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    await dispatchPendingRecovery({
      sessionId: 'session-1',
      sendUserMessage,
      ui: createDispatchUi(statusCalls),
    } as any);

    expect(statusCalls).toEqual([
      '↻ Refusal detected; retrying...',
      '↻ Continue sent; waiting for recovery...',
    ]);
  });

  test('retries a thinking-only stop once by queueing Continue for idle-safe dispatch and branches it out of the main path', async () => {
    const reviewRewrite = vi.fn();
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    pushRefusal('assistant-empty-1', '');
    sessionManager.getEntries()[1].message.content = [
      { type: 'thinking', thinking: 'Need to inspect sample code more closely.' },
    ];
    const { ctx, statusCalls, notify } = createCtx(sessionManager);

    await handleRefusalRecovery({
      event: emptyStopEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(reviewRewrite).not.toHaveBeenCalled();
    expect(statusCalls).toEqual(['↻ Empty assistant response; retrying with Continue...']);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(getPendingRecovery('session-1')).toMatchObject({
      kind: 'empty-stop',
      message: 'Continue.',
    });

    await dispatchPendingRecovery({ sessionId: 'session-1', sendUserMessage });

    expect(sendUserMessage).toHaveBeenCalledWith(
      'Continue.',
      expect.objectContaining({
        displayHint: 'linear-replacement',
        replacement: {
          supersedesEntryId: 'assistant-empty-1',
          parentEntryId: 'user-1',
        },
      }),
    );
    expect(getPendingRecovery('session-1')).toBeUndefined();
    expect(sessionManager.leafId).toBe('user-1');
    expect(notify).not.toHaveBeenCalled();
  });

  test('retries consecutive empty assistant stops up to three times', async () => {
    const reviewRewrite = vi.fn();
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const { ctx, statusCalls, notify } = createCtx(sessionManager);

    for (const attempt of [1, 2, 3]) {
      pushRefusal(`assistant-empty-${attempt}`, '');

      await handleRefusalRecovery({
        event: emptyStopEvent(),
        ctx,
        patchedSession: session as any,
        reviewRewrite,
        sendUserMessage,
      });

      expect(getPendingRecovery('session-1')).toMatchObject({
        kind: 'empty-stop',
        message: 'Continue.',
        details: expect.objectContaining({
          attempt,
          replacement: {
            supersedesEntryId: `assistant-empty-${attempt}`,
            parentEntryId: 'user-1',
          },
        }),
      });

      await dispatchPendingRecovery({
        sessionId: 'session-1',
        sendUserMessage,
        ui: createDispatchUi(statusCalls),
      } as any);
    }

    expect(reviewRewrite).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledTimes(3);
    expect(sendUserMessage.mock.calls).toEqual([
      ['Continue.', expect.objectContaining({ attempt: 1 })],
      ['Continue.', expect.objectContaining({ attempt: 2 })],
      ['Continue.', expect.objectContaining({ attempt: 3 })],
    ]);
    expect(statusCalls).toEqual([
      '↻ Empty assistant response; retrying with Continue...',
      '↻ Continue sent; waiting for recovery...',
      '↻ Empty assistant response; retrying with Continue... · 2/3',
      '↻ Continue sent; waiting for recovery... · 2/3',
      '↻ Empty assistant response; retrying with Continue... · 3/3',
      '↻ Continue sent; waiting for recovery... · 3/3',
    ]);
    expect(notify).not.toHaveBeenCalled();
  });

  test('warns after a fourth consecutive empty assistant stop', async () => {
    const reviewRewrite = vi.fn();
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const { ctx, notify } = createCtx(sessionManager);

    for (const attempt of [1, 2, 3]) {
      pushRefusal(`assistant-empty-${attempt}`, '');
      await handleRefusalRecovery({
        event: emptyStopEvent(),
        ctx,
        patchedSession: session as any,
        reviewRewrite,
        sendUserMessage,
      });
      await dispatchPendingRecovery({ sessionId: 'session-1', sendUserMessage });
    }

    pushRefusal('assistant-empty-4', '');
    await handleRefusalRecovery({
      event: emptyStopEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(reviewRewrite).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledTimes(3);
    expect(getPendingRecovery('session-1')).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      'pi-retry could not recover from an empty assistant response',
      'warning',
    );
  });

  test('sanitizes encrypted branch reasoning before queueing retry for encrypted-content verification errors', async () => {
    const reviewRewrite = vi.fn();
    const sendUserMessage = vi.fn();
    const { session, sessionManager, entries, plainSignature } =
      createFakeEncryptedReasoningSession();
    const { ctx, statusCalls, notify } = createCtx(sessionManager);

    await handleRefusalRecovery({
      event: {
        messages: [
          {
            role: 'assistant',
            stopReason: 'error',
            errorMessage:
              '400 The encrypted content for item rs_00777bf6bda135fe0169deb0b1cd0c8197954b327221babc62 could not be verified. Reason: Encrypted content could not be decrypted or parsed.',
            content: [],
          },
        ],
      },
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(entries[1].message.content[0].thinkingSignature).toBeUndefined();
    expect(entries[1].message.content[1].thinkingSignature).toBe(plainSignature);
    expect(sessionManager._buildIndex).toHaveBeenCalledTimes(1);
    expect(sessionManager._rewriteFile).toHaveBeenCalledTimes(1);
    expect(reviewRewrite).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(statusCalls).toEqual(['↻ Retryable error detected; retrying with Continue...']);
    expect(getPendingRecovery('session-1')).toMatchObject({
      kind: 'retryable-error',
      message: 'Continue.',
      expectedLeafId: 'user-2',
      details: {
        displayHint: 'linear-replacement',
        replacement: {
          supersedesEntryId: 'assistant-error',
          parentEntryId: 'user-2',
        },
      },
    });
    expect(sessionManager.leafId).toBe('user-2');
    expect(notify).not.toHaveBeenCalled();
  });

  test('sanitizes created_by metadata from native compaction replay before queueing retry', async () => {
    const reviewRewrite = vi.fn();
    const sendUserMessage = vi.fn();
    const { session, sessionManager, entries } = createFakeCreatedByCompactionSession();
    const { ctx, statusCalls, notify } = createCtx(sessionManager);

    await handleRefusalRecovery({
      event: {
        messages: [
          {
            role: 'assistant',
            stopReason: 'error',
            errorMessage:
              'Error: 400 litellm.BadRequestError: AzureException BadRequestError - { "error": { "message": "Unknown parameter: \'input[26].created_by\'.", "type": "invalid_request_error", "param": "input[26].created_by", "code": "unknown_parameter" } }.',
            content: [],
          },
        ],
      },
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(entries[1].details.compactedWindow[0].created_by).toBeUndefined();
    expect(entries[1].details.compactedWindow[0].content).toEqual([
      { type: 'output_text', text: 'Compacted output', annotations: [] },
    ]);
    expect(sessionManager._buildIndex).toHaveBeenCalledTimes(1);
    expect(sessionManager._rewriteFile).toHaveBeenCalledTimes(1);
    expect(reviewRewrite).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(statusCalls).toEqual(['↻ Retryable error detected; retrying with Continue...']);
    expect(getPendingRecovery('session-1')).toMatchObject({
      kind: 'retryable-error',
      message: 'Continue.',
      expectedLeafId: 'user-2',
      details: {
        displayHint: 'linear-replacement',
        replacement: {
          supersedesEntryId: 'assistant-error',
          parentEntryId: 'user-2',
        },
      },
    });
    expect(sessionManager.leafId).toBe('user-2');
    expect(notify).not.toHaveBeenCalled();
  });

  test('can disable rewrites entirely after the stock continue budget is exhausted', async () => {
    process.env.PI_RETRY_REFUSAL_REWRITES_DISABLED = '1';

    const reviewRewrite = vi.fn();
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const { ctx, notify } = createCtx(sessionManager);

    await exhaustRefusalContinuePhase({
      session,
      sessionManager,
      pushRefusal,
      ctx,
      reviewRewrite,
      sendUserMessage,
    });

    pushRefusal('assistant-refusal-6');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(reviewRewrite).not.toHaveBeenCalled();
    expectStockContinueMessages(sendUserMessage.mock.calls.map(([message]) => message));
    expect(notify).toHaveBeenCalledWith(
      'pi-retry could not recover from the refusal after 5 continue attempts',
      'warning',
    );
  });

  test('caps rewrite attempts by usable configured review models', async () => {
    const reviewRewrite = vi.fn().mockResolvedValue({ reason: 'first', rewrite: 'rewrite 1' });
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const { ctx, notify } = createCtx(sessionManager, {
      modelRegistry: {
        getAvailable: () => [
          { provider: 'gust', id: 'gpt-5.4', api: 'openai-responses', reasoning: true },
        ],
        getApiKeyAndHeaders: vi
          .fn()
          .mockResolvedValue({ ok: true, apiKey: 'test-key', headers: {} }),
      },
    });

    await exhaustRefusalContinuePhase({
      session,
      sessionManager,
      pushRefusal,
      ctx,
      reviewRewrite,
      sendUserMessage,
    });

    pushRefusal('assistant-refusal-6');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });
    await dispatchPendingRecovery({ sessionId: 'session-1', sendUserMessage });

    pushRefusal('assistant-refusal-7');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(reviewRewrite).toHaveBeenCalledTimes(1);
    expect(sendUserMessage.mock.calls.at(-1)?.[0]).toBe('rewrite 1');
    expect(notify).toHaveBeenCalledWith(
      'pi-retry could not recover from the refusal after 1 rewrite attempt',
      'warning',
    );
  });

  test('uses the first mapped review model after five stock continues still refuse', async () => {
    const reviewRewrite = vi.fn().mockResolvedValue({ reason: 'first', rewrite: 'rewrite 1' });
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const { ctx, statusCalls, notify } = createCtx(sessionManager);

    await exhaustRefusalContinuePhase({
      session,
      sessionManager,
      pushRefusal,
      ctx,
      reviewRewrite,
      sendUserMessage,
      statusCalls,
    });

    pushRefusal('assistant-refusal-6');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });
    await dispatchPendingRecovery({ sessionId: 'session-1', sendUserMessage });

    expect(reviewRewrite).toHaveBeenCalledTimes(1);
    expect(reviewRewrite.mock.calls[0]?.[0]?.model?.id).toBe('gpt-5.4');
    expectStockContinueMessages(sendUserMessage.mock.calls.slice(0, 5).map(([message]) => message));
    expect(sendUserMessage.mock.calls.at(-1)?.[0]).toBe('rewrite 1');
    expect(statusCalls).toContain('↻ Refusal detected; asking gpt-5.4 for review...');
    expect(statusCalls).toContain('↻ gpt-5.4 suggested a rewrite; retrying...');
    expect(sessionManager.leafId).toBe('user-1');
    expect(getRefusalAttempt('session-1')).toBe(1);
    expect(getRefusalContinueAttempt('session-1')).toBe(5);
    expect(notify).not.toHaveBeenCalled();
  });

  test('uses the second mapped review model on the second rewrite attempt and stops after that', async () => {
    const reviewRewrite = vi
      .fn()
      .mockResolvedValueOnce({ reason: 'first', rewrite: 'rewrite 1' })
      .mockResolvedValueOnce({ reason: 'second', rewrite: 'rewrite 2' });
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const { ctx, notify } = createCtx(sessionManager);

    await exhaustRefusalContinuePhase({
      session,
      sessionManager,
      pushRefusal,
      ctx,
      reviewRewrite,
      sendUserMessage,
    });

    pushRefusal('assistant-refusal-6');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });
    await dispatchPendingRecovery({ sessionId: 'session-1', sendUserMessage });

    pushRefusal('assistant-refusal-7');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });
    await dispatchPendingRecovery({ sessionId: 'session-1', sendUserMessage });

    pushRefusal('assistant-refusal-8');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(reviewRewrite).toHaveBeenCalledTimes(2);
    expect(reviewRewrite.mock.calls[0]?.[0]?.model?.id).toBe('gpt-5.4');
    expect(reviewRewrite.mock.calls[1]?.[0]?.model?.id).toBe('gemini-3.1-pro-preview');
    expectStockContinueMessages(sendUserMessage.mock.calls.slice(0, 5).map(([message]) => message));
    expect(sendUserMessage.mock.calls.slice(-2).map(([message]) => message)).toEqual([
      'rewrite 1',
      'rewrite 2',
    ]);
    expect(notify).toHaveBeenCalledWith(
      'pi-retry could not recover from the refusal after 2 rewrite attempts',
      'warning',
    );
  });

  test('shows continue status counters through 5 and rewrite counters through 2', async () => {
    const reviewRewrite = vi
      .fn()
      .mockResolvedValueOnce({ reason: 'first', rewrite: 'rewrite 1' })
      .mockResolvedValueOnce({ reason: 'second', rewrite: 'rewrite 2' });
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const { ctx, statusCalls } = createCtx(sessionManager);

    await exhaustRefusalContinuePhase({
      session,
      sessionManager,
      pushRefusal,
      ctx,
      reviewRewrite,
      sendUserMessage,
      statusCalls,
    });

    pushRefusal('assistant-refusal-6');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });
    await dispatchPendingRecovery({
      sessionId: 'session-1',
      sendUserMessage,
      ui: createDispatchUi(statusCalls),
    } as any);

    pushRefusal('assistant-refusal-7');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(statusCalls).toContain('↻ Refusal detected; retrying... · 2/5');
    expect(statusCalls).toContain('↻ Refusal detected; retrying... · 5/5');
    expect(statusCalls).toContain('↻ Refusal detected; asking gpt-5.4 for review...');
    expect(statusCalls).toContain('↻ gpt-5.4 suggested a rewrite; retrying...');
    expect(statusCalls).toContain(
      '↻ Refusal detected; asking gemini-3.1-pro-preview for review... · 2/2',
    );
  });

  test('falls through to the next review model when the first candidate fails auth', async () => {
    const reviewRewrite = vi.fn().mockResolvedValue({
      reason: 'Gemini could safely reframe the request.',
      rewrite: 'Please explain the blocker and suggest a safe implementation plan.',
    });
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const getApiKeyAndHeaders = vi.fn().mockImplementation(async (model: { id: string }) => {
      if ('gpt-5.4' === model.id) {
        return { ok: false, error: 'missing auth' };
      }
      return { ok: true, apiKey: 'fallback-key', headers: { 'x-test': '1' } };
    });
    const { ctx, statusCalls, notify } = createCtx(sessionManager, {
      modelRegistry: {
        getAvailable: () => [
          { provider: 'gust', id: 'gpt-5.4', api: 'openai-responses', reasoning: true },
          {
            provider: 'gust',
            id: 'gemini-3.1-pro-preview',
            api: 'google-generative-ai',
            reasoning: true,
          },
        ],
        getApiKeyAndHeaders,
      },
    });

    await exhaustRefusalContinuePhase({
      session,
      sessionManager,
      pushRefusal,
      ctx,
      reviewRewrite,
      sendUserMessage,
      statusCalls,
    });

    pushRefusal('assistant-refusal-6');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });
    await dispatchPendingRecovery({
      sessionId: 'session-1',
      sendUserMessage,
      ui: createDispatchUi(statusCalls),
    });

    expect(getApiKeyAndHeaders.mock.calls.map(([model]) => model.id)).toEqual([
      'gpt-5.4',
      'gemini-3.1-pro-preview',
    ]);
    expect(reviewRewrite).toHaveBeenCalledTimes(1);
    expect(reviewRewrite.mock.calls[0]?.[0]?.model?.id).toBe('gemini-3.1-pro-preview');
    expectStockContinueMessages(sendUserMessage.mock.calls.slice(0, 5).map(([message]) => message));
    expect(sendUserMessage.mock.calls.at(-1)?.[0]).toBe(
      'Please explain the blocker and suggest a safe implementation plan.',
    );
    expect(getRefusalAttempt('session-1')).toBe(1);
    expect(sessionManager.leafId).toBe('user-1');
    expect(sessionManager.customEntries).toEqual([]);
    expect(statusCalls).toContain('↻ Refusal detected; asking gpt-5.4 for review...');
    expect(statusCalls).toContain(
      '↻ Refusal detected; asking gemini-3.1-pro-preview for review...',
    );
    expect(statusCalls).toContain('↻ gemini-3.1-pro-preview suggested a rewrite; retrying...');
    expect(notify).not.toHaveBeenCalled();
  });

  test('falls through to the next review model when the first review sub-call errors', async () => {
    const reviewRewrite = vi
      .fn()
      .mockRejectedValueOnce(new Error("Cannot read properties of undefined (reading 'input')"))
      .mockResolvedValueOnce({
        reason: 'Gemini produced a usable rewrite.',
        rewrite: 'Please restate the request as analysis and recommend a safe next step.',
      });
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const { ctx, statusCalls, notify } = createCtx(sessionManager);

    await exhaustRefusalContinuePhase({
      session,
      sessionManager,
      pushRefusal,
      ctx,
      reviewRewrite,
      sendUserMessage,
      statusCalls,
    });

    pushRefusal('assistant-refusal-6');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });
    await dispatchPendingRecovery({ sessionId: 'session-1', sendUserMessage });

    expect(reviewRewrite).toHaveBeenCalledTimes(2);
    expect(reviewRewrite.mock.calls.map(([call]) => call.model.id)).toEqual([
      'gpt-5.4',
      'gemini-3.1-pro-preview',
    ]);
    expectStockContinueMessages(sendUserMessage.mock.calls.slice(0, 5).map(([message]) => message));
    expect(sendUserMessage.mock.calls.at(-1)?.[0]).toBe(
      'Please restate the request as analysis and recommend a safe next step.',
    );
    expect(getRefusalAttempt('session-1')).toBe(1);
    expect(sessionManager.leafId).toBe('user-1');
    expect(sessionManager.customEntries).toEqual([]);
    expect(statusCalls).toContain('↻ Refusal detected; asking gpt-5.4 for review...');
    expect(statusCalls).toContain(
      '↻ Refusal detected; asking gemini-3.1-pro-preview for review...',
    );
    expect(statusCalls).toContain('↻ gemini-3.1-pro-preview suggested a rewrite; retrying...');
    expect(notify).not.toHaveBeenCalled();
  });

  test('gives up only after all review candidates fail without consuming an attempt', async () => {
    const reviewRewrite = vi.fn().mockResolvedValue(undefined);
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const { ctx, statusCalls, notify } = createCtx(sessionManager);

    await exhaustRefusalContinuePhase({
      session,
      sessionManager,
      pushRefusal,
      ctx,
      reviewRewrite,
      sendUserMessage,
      statusCalls,
    });

    pushRefusal('assistant-refusal-6');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(reviewRewrite).toHaveBeenCalledTimes(2);
    expect(reviewRewrite.mock.calls.map(([call]) => call.model.id)).toEqual([
      'gpt-5.4',
      'gemini-3.1-pro-preview',
    ]);
    expectStockContinueMessages(sendUserMessage.mock.calls.map(([message]) => message));
    expect(getRefusalAttempt('session-1')).toBe(0);
    expect(sessionManager.leafId).toBe('assistant-refusal-6');
    expect(sessionManager.customEntries).toEqual([]);
    expect(statusCalls.at(-1)).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      'pi-retry could not produce a rewrite with any review model',
      'warning',
    );
  });

  test('shows a brief success status after recovery and then resets for the next refusal', async () => {
    vi.useFakeTimers();

    const reviewRewrite = vi.fn().mockResolvedValue({ reason: 'first', rewrite: 'rewrite 1' });
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const { ctx, statusCalls, notify } = createCtx(sessionManager);

    await exhaustRefusalContinuePhase({
      session,
      sessionManager,
      pushRefusal,
      ctx,
      reviewRewrite,
      sendUserMessage,
      statusCalls,
    });

    pushRefusal('assistant-refusal-6');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });
    await dispatchPendingRecovery({ sessionId: 'session-1', sendUserMessage });

    await handleRefusalRecovery({
      event: {
        messages: [
          {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'text', text: 'Here is the answer you asked for.' }],
          },
        ],
      },
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(statusCalls).toEqual([
      '↻ Refusal detected; retrying...',
      '↻ Continue sent; waiting for recovery...',
      '↻ Refusal detected; retrying... · 2/5',
      '↻ Continue sent; waiting for recovery... · 2/5',
      '↻ Refusal detected; retrying... · 3/5',
      '↻ Continue sent; waiting for recovery... · 3/5',
      '↻ Refusal detected; retrying... · 4/5',
      '↻ Continue sent; waiting for recovery... · 4/5',
      '↻ Refusal detected; retrying... · 5/5',
      '↻ Continue sent; waiting for recovery... · 5/5',
      '↻ Refusal detected; asking gpt-5.4 for review...',
      '↻ gpt-5.4 suggested a rewrite; retrying...',
      '✓ Recovered; continuing...',
    ]);

    await vi.advanceTimersByTimeAsync(4000);

    expect(statusCalls).toEqual([
      '↻ Refusal detected; retrying...',
      '↻ Continue sent; waiting for recovery...',
      '↻ Refusal detected; retrying... · 2/5',
      '↻ Continue sent; waiting for recovery... · 2/5',
      '↻ Refusal detected; retrying... · 3/5',
      '↻ Continue sent; waiting for recovery... · 3/5',
      '↻ Refusal detected; retrying... · 4/5',
      '↻ Continue sent; waiting for recovery... · 4/5',
      '↻ Refusal detected; retrying... · 5/5',
      '↻ Continue sent; waiting for recovery... · 5/5',
      '↻ Refusal detected; asking gpt-5.4 for review...',
      '↻ gpt-5.4 suggested a rewrite; retrying...',
      '✓ Recovered; continuing...',
      undefined,
    ]);

    pushRefusal('assistant-refusal-7');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });
    await dispatchPendingRecovery({
      sessionId: 'session-1',
      sendUserMessage,
      ui: createDispatchUi(statusCalls),
    });

    expect(reviewRewrite).toHaveBeenCalledTimes(1);
    expectStockContinueMessages(sendUserMessage.mock.calls.slice(0, 5).map(([message]) => message));
    expect(sendUserMessage.mock.calls[5]?.[0]).toBe('rewrite 1');
    expectStockContinueMessage(sendUserMessage.mock.calls[6]?.[0]);
    expect(getRefusalAttempt('session-1')).toBe(0);
    expect(statusCalls.at(-1)).toBe('↻ Continue sent; waiting for recovery...');
    expect(notify).not.toHaveBeenCalled();
  });

  test('clears queued recovery when the expected leaf changes before dispatch', async () => {
    const reviewRewrite = vi.fn();
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const { ctx, statusCalls } = createCtx(sessionManager);
    registerPatchedSession(session as any);

    pushRefusal('assistant-refusal-1');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    sessionManager.leafId = 'assistant-other';
    const dispatched = await dispatchPendingRecovery({
      sessionId: 'session-1',
      sendUserMessage,
      ui: createDispatchUi(statusCalls),
    });

    expect(dispatched).toBe(false);
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(statusCalls.at(-1)).toBeUndefined();
  });

  test('resets refusal recovery after mismatch so the next refusal retries with Continue again', async () => {
    const reviewRewrite = vi.fn();
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const { ctx, statusCalls } = createCtx(sessionManager);
    registerPatchedSession(session as any);

    pushRefusal('assistant-refusal-1');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    sessionManager.leafId = 'assistant-other';
    await dispatchPendingRecovery({
      sessionId: 'session-1',
      sendUserMessage,
      ui: createDispatchUi(statusCalls),
    });

    pushRefusal('assistant-refusal-2');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(reviewRewrite).not.toHaveBeenCalled();
    expect(statusCalls.at(-1)).toBe('↻ Refusal detected; retrying...');
  });

  test('preserves queued rewrite metadata when dispatch send fails', async () => {
    const reviewRewrite = vi.fn().mockResolvedValue({ reason: 'first', rewrite: 'rewrite 1' });
    const sendUserMessage = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('send failed'))
      .mockResolvedValueOnce(undefined);
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const { ctx, statusCalls } = createCtx(sessionManager);

    await exhaustRefusalContinuePhase({
      session,
      sessionManager,
      pushRefusal,
      ctx,
      reviewRewrite,
      sendUserMessage,
      statusCalls,
    });

    pushRefusal('assistant-refusal-6');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    await expect(
      dispatchPendingRecovery({
        sessionId: 'session-1',
        sendUserMessage,
        ui: createDispatchUi(statusCalls),
      }),
    ).rejects.toThrow('send failed');

    expect(getPendingRecovery('session-1')).toMatchObject({
      kind: 'refusal',
      message: 'rewrite 1',
    });
    expect(statusCalls.at(-1)).toBe('↻ gpt-5.4 suggested a rewrite; retrying...');

    await dispatchPendingRecovery({
      sessionId: 'session-1',
      sendUserMessage,
      ui: createDispatchUi(statusCalls),
    });

    expect(statusCalls).toContain('↻ Rewrite sent; waiting for recovery...');
  });

  test('does not require UI in headless contexts', async () => {
    const reviewRewrite = vi.fn();
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    pushRefusal('assistant-refusal-1');
    const { ctx } = createCtx(sessionManager, { hasUI: false, ui: undefined });

    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });
    await dispatchPendingRecovery({ sessionId: 'session-1', sendUserMessage });

    expect(reviewRewrite).not.toHaveBeenCalled();
    expectStockContinueMessage(sendUserMessage.mock.calls[0]?.[0]);
    expect(sessionManager.leafId).toBe('user-1');
  });
});

describe('resolveRecoveryOnAssistantMessage', () => {
  test('shows recovery success when assistant output resumes after a sent recovery', async () => {
    vi.useFakeTimers();

    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const { ctx, statusCalls } = createCtx(sessionManager);

    pushRefusal('assistant-refusal-1');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite: vi.fn(),
      sendUserMessage,
    });
    await dispatchPendingRecovery({
      sessionId: 'session-1',
      sendUserMessage,
      ui: createDispatchUi(statusCalls),
    });

    expect(
      resolveRecoveryOnAssistantMessage(ctx, {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: '.' } }],
      }),
    ).toBe(true);

    expect(statusCalls.at(-1)).toBe('✓ Recovered; continuing...');

    await vi.advanceTimersByTimeAsync(4000);

    expect(statusCalls.at(-1)).toBeUndefined();
  });

  test('does not show recovery success when the next assistant message is another refusal', async () => {
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushRefusal } = createFakeRefusalSession();
    const { ctx, statusCalls } = createCtx(sessionManager);

    pushRefusal('assistant-refusal-1');
    await handleRefusalRecovery({
      event: refusalEvent(),
      ctx,
      patchedSession: session as any,
      reviewRewrite: vi.fn(),
      sendUserMessage,
    });
    await dispatchPendingRecovery({
      sessionId: 'session-1',
      sendUserMessage,
      ui: createDispatchUi(statusCalls),
    });

    expect(
      resolveRecoveryOnAssistantMessage(ctx, {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: REFUSAL_TEXT }],
      }),
    ).toBe(false);

    expect(statusCalls.at(-1)).toBe('↻ Continue sent; waiting for recovery...');
  });
});
