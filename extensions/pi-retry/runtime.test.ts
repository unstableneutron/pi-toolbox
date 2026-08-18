import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  PREMATURE_ABANDONMENT_CONTINUE_MESSAGE,
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
  waitForRecoveryOutcome,
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
        errorMessage: 'The server had an error while processing your request. Sorry about that!',
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

function createFakeStrandedToolResultSession(options?: {
  includeAllResults?: boolean;
  includeUnexpectedResult?: boolean;
  markAllResultsTerminating?: boolean;
}) {
  const includeAllResults = options?.includeAllResults ?? true;
  const entries = [
    {
      id: 'user-1',
      parentId: undefined,
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'Investigate this session' }] },
    },
    {
      id: 'assistant-tool-use',
      parentId: 'user-1',
      type: 'message',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: 'I’ll inspect the files.' },
          { type: 'toolCall', id: 'call_read|provider-id-1', name: 'read' },
          { type: 'toolCall', id: 'call_grep|provider-id-2', name: 'grep' },
        ],
      },
    },
    {
      id: 'tool-result-read',
      parentId: 'assistant-tool-use',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'call_read|provider-id-1',
        content: [{ type: 'text', text: 'file contents' }],
        ...(options?.markAllResultsTerminating ? { piRetry: { terminate: true } } : {}),
      },
    },
    ...(includeAllResults
      ? [
          {
            id: 'tool-result-grep',
            parentId: 'tool-result-read',
            type: 'message',
            message: {
              role: 'toolResult',
              toolCallId: options?.includeUnexpectedResult
                ? 'call_unexpected|provider-id-3'
                : 'call_grep|provider-id-2',
              content: [{ type: 'text', text: 'grep output' }],
              ...(options?.markAllResultsTerminating ? { piRetry: { terminate: true } } : {}),
            },
          },
        ]
      : []),
  ] as any[];

  return {
    sessionManager: {
      getSessionId: () => 'session-1',
      getLeafId: () => (includeAllResults ? 'tool-result-grep' : 'tool-result-read'),
      getEntries: () => entries,
    },
  };
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

function createFakeDuplicateResponsesItemSession() {
  const duplicateItemId = 'msg_6f97352f33075e8b997c8f1659a40e09';
  const textBlock = {
    type: 'text',
    text: 'Prior answer',
    textSignature: JSON.stringify({ v: 1, id: duplicateItemId, phase: 'final_answer' }),
  };
  const entries = [
    {
      id: 'assistant-prior',
      parentId: undefined,
      type: 'message',
      message: { role: 'assistant', content: [textBlock] },
    },
    {
      id: 'compaction-1',
      parentId: 'assistant-prior',
      type: 'compaction',
      details: {
        strategy: 'openai-native-compact-v1',
        compactedWindow: [{ type: 'message', role: 'assistant', id: duplicateItemId }],
      },
    },
    {
      id: 'user-1',
      parentId: 'compaction-1',
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
    },
    {
      id: 'assistant-error',
      parentId: 'user-1',
      type: 'message',
      message: { role: 'assistant', stopReason: 'error', content: [] },
    },
  ] as any[];
  const sessionManager = {
    leafId: 'assistant-error',
    getSessionId: () => 'session-1',
    getLeafId() {
      return this.leafId;
    },
    getEntries: () => entries,
    branch(entryId: string) {
      this.leafId = entryId;
    },
    _buildIndex: vi.fn(),
    _rewriteFile: vi.fn(),
  };
  return {
    duplicateItemId,
    entries,
    sessionManager,
    session: { sessionManager },
    textBlock,
  };
}

const REFUSAL_TEXT = "I'm sorry, but I cannot assist with that request.";
const PREMATURE_ABANDONMENT_TEXT =
  'I’m sorry, but I couldn’t complete the observer and multi-window work.';

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

function createFakePrematureAbandonmentSession() {
  const entries = [
    {
      id: 'user-1',
      parentId: undefined,
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'Finish the implementation' }] },
    },
    {
      id: 'assistant-tool-use',
      parentId: 'user-1',
      type: 'message',
      message: {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'call-edit', name: 'edit', arguments: {} }],
      },
    },
    {
      id: 'tool-result-1',
      parentId: 'assistant-tool-use',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'call-edit',
        content: [{ type: 'text', text: 'Applied patch' }],
      },
    },
    {
      id: 'assistant-abandonment-1',
      parentId: 'tool-result-1',
      type: 'message',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: PREMATURE_ABANDONMENT_TEXT }],
      },
    },
  ] as any[];

  const sessionManager = {
    leafId: 'assistant-abandonment-1',
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
  };

  function pushSecondAbandonment() {
    entries.push(
      {
        id: 'user-recovery-1',
        parentId: 'assistant-abandonment-1',
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: PREMATURE_ABANDONMENT_CONTINUE_MESSAGE }],
        },
      },
      {
        id: 'assistant-abandonment-2',
        parentId: 'user-recovery-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'Sorry, I wasn’t able to complete this.' }],
        },
      },
    );
    sessionManager.leafId = 'assistant-abandonment-2';
  }

  return { sessionManager, entries, session: { sessionManager }, pushSecondAbandonment };
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
  delete process.env.PI_RETRY_PROVIDER_ERROR_CONTINUE_ATTEMPTS;
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
    expect(
      buildRecoveryStatus({
        kind: 'retryable-error',
        phase: 'queued',
        attempt: 2,
        messageKind: 'continue',
        maxAttempts: 3,
      }),
    ).toBe('↻ Retryable error detected; retrying with Continue... · 2/3');
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

  test('leaves non-OpenAI Responses thinking signatures with encrypted_content untouched', () => {
    const { session, sessionManager, entries } = createFakeEncryptedReasoningSession();
    const nonResponsesSignature = JSON.stringify({
      type: 'vendor_thinking',
      encrypted_content: 'provider-owned-payload',
    });
    entries[1].message.content[0].thinkingSignature = nonResponsesSignature;

    const result = sanitizeEncryptedReasoningOnCurrentBranch(session as any);

    expect(result).toEqual({ sanitizedMessages: 0, sanitizedBlocks: 0 });
    expect(entries[1].message.content[0].thinkingSignature).toBe(nonResponsesSignature);
    expect(sessionManager._buildIndex).not.toHaveBeenCalled();
    expect(sessionManager._rewriteFile).not.toHaveBeenCalled();
  });
});

describe('detectRetryableTerminalLeaf', () => {
  test('detects a stranded tool-result leaf after all assistant tool calls returned', () => {
    const { sessionManager } = createFakeStrandedToolResultSession();

    expect(detectRetryableTerminalLeaf(sessionManager as any)).toMatchObject({
      kind: 'stranded-tool-results',
      entryId: 'tool-result-grep',
      parentEntryId: 'assistant-tool-use',
    });
  });

  test('does not detect stranded tool results until every assistant tool call returned', () => {
    const { sessionManager } = createFakeStrandedToolResultSession({ includeAllResults: false });

    expect(detectRetryableTerminalLeaf(sessionManager as any)).toBeUndefined();
  });

  test('does not detect stranded tool results when a tool result has no matching tool call', () => {
    const { sessionManager } = createFakeStrandedToolResultSession({
      includeUnexpectedResult: true,
    });

    expect(detectRetryableTerminalLeaf(sessionManager as any)).toBeUndefined();
  });

  test('does not detect stranded tool results when every result intentionally terminated', () => {
    const { sessionManager } = createFakeStrandedToolResultSession({
      markAllResultsTerminating: true,
    });

    expect(detectRetryableTerminalLeaf(sessionManager as any)).toBeUndefined();
  });

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

  test('detects terse premature abandonment after tool results', () => {
    const { sessionManager } = createFakePrematureAbandonmentSession();

    expect(detectRetryableTerminalLeaf(sessionManager as any)).toMatchObject({
      kind: 'premature-abandonment',
      entryId: 'assistant-abandonment-1',
      parentEntryId: 'tool-result-1',
    });
  });

  test('does not detect premature abandonment when the assistant made no tool-backed progress', () => {
    const { sessionManager } = createSessionWithTrailingCustomLeaf({
      stopReason: 'stop',
      content: [{ type: 'text', text: PREMATURE_ABANDONMENT_TEXT }],
    });

    expect(detectRetryableTerminalLeaf(sessionManager as any)).toBeUndefined();
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

  test('queues one visible continuation for tool-backed premature abandonment', async () => {
    const reviewRewrite = vi.fn();
    const sendUserMessage = vi.fn();
    const { session, sessionManager } = createFakePrematureAbandonmentSession();
    const { ctx, statusCalls, notify } = createCtx(sessionManager);

    await handleRefusalRecovery({
      event: refusalEvent(PREMATURE_ABANDONMENT_TEXT),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(reviewRewrite).not.toHaveBeenCalled();
    expect(statusCalls).toEqual([
      '↻ Premature abandonment detected; sending a visible continuation...',
    ]);
    expect(getPendingRecovery('session-1')).toMatchObject({
      kind: 'premature-abandonment',
      message: PREMATURE_ABANDONMENT_CONTINUE_MESSAGE,
      expectedLeafId: 'assistant-abandonment-1',
      details: {
        kind: 'premature-abandonment',
        attempt: 1,
        expectedLeafId: 'assistant-abandonment-1',
      },
    });
    expect(getPendingRecovery('session-1')?.details?.replacement).toBeUndefined();
    expect(sessionManager.leafId).toBe('assistant-abandonment-1');

    await dispatchPendingRecovery({ sessionId: 'session-1', sendUserMessage });

    expect(sendUserMessage).toHaveBeenCalledWith(
      PREMATURE_ABANDONMENT_CONTINUE_MESSAGE,
      expect.objectContaining({ kind: 'premature-abandonment', attempt: 1 }),
    );
    expect(notify).not.toHaveBeenCalled();
  });

  test('does not loop when the first visible continuation receives another give-up response', async () => {
    const reviewRewrite = vi.fn();
    const sendUserMessage = vi.fn();
    const { session, sessionManager, pushSecondAbandonment } =
      createFakePrematureAbandonmentSession();
    const { ctx, notify } = createCtx(sessionManager);

    await handleRefusalRecovery({
      event: refusalEvent(PREMATURE_ABANDONMENT_TEXT),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });
    await dispatchPendingRecovery({ sessionId: 'session-1', sendUserMessage });

    pushSecondAbandonment();
    await handleRefusalRecovery({
      event: refusalEvent('Sorry, I wasn’t able to complete this.'),
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(getPendingRecovery('session-1')).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      'pi-retry stopped premature-abandonment recovery after one attempt',
      'warning',
    );
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

  test('stops after three consecutive retryable provider error recovery attempts', async () => {
    process.env.PI_RETRY_PROVIDER_ERROR_CONTINUE_ATTEMPTS = '3';

    const reviewRewrite = vi.fn();
    const sendUserMessage = vi.fn();
    const { session, sessionManager, entries } = createFakeErrorSession();
    const { ctx, statusCalls, notify } = createCtx(sessionManager);

    for (const attempt of [1, 2, 3]) {
      await handleRefusalRecovery({
        event: {
          messages: [
            {
              role: 'assistant',
              stopReason: 'error',
              errorMessage: 'Unknown error (no error details in response)',
              content: [],
            },
          ],
        },
        ctx,
        patchedSession: session as any,
        reviewRewrite,
        sendUserMessage,
      });

      expect(getPendingRecovery('session-1')).toMatchObject({
        kind: 'retryable-error',
        message: 'Continue.',
        details: expect.objectContaining({ attempt }),
      });

      await dispatchPendingRecovery({
        sessionId: 'session-1',
        sendUserMessage,
        ui: createDispatchUi(statusCalls),
      });

      entries.push({
        id: `assistant-error-${attempt + 1}`,
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'Unknown error (no error details in response)',
          content: [],
        },
      });
      sessionManager.leafId = `assistant-error-${attempt + 1}`;
    }

    await handleRefusalRecovery({
      event: {
        messages: [
          {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'Unknown error (no error details in response)',
            content: [],
          },
        ],
      },
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(reviewRewrite).not.toHaveBeenCalled();
    expect(sendUserMessage).toHaveBeenCalledTimes(3);
    expect(statusCalls).toEqual([
      '↻ Retryable error detected; retrying with Continue...',
      '↻ Continue sent; waiting for recovery...',
      '↻ Retryable error detected; retrying with Continue... · 2/3',
      '↻ Continue sent; waiting for recovery... · 2/3',
      '↻ Retryable error detected; retrying with Continue... · 3/3',
      '↻ Continue sent; waiting for recovery... · 3/3',
      undefined,
    ]);
    expect(getPendingRecovery('session-1')).toBeUndefined();
    expect(sessionManager.leafId).toBe('assistant-error-4');
    expect(notify).toHaveBeenCalledWith(
      'pi-retry stopped after 3 retryable provider error recovery attempts',
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

  test('removes a duplicated Responses text item id before queueing retry', async () => {
    const reviewRewrite = vi.fn();
    const sendUserMessage = vi.fn();
    const { duplicateItemId, session, sessionManager, textBlock } =
      createFakeDuplicateResponsesItemSession();
    const { ctx, statusCalls, notify } = createCtx(sessionManager);
    const inner = JSON.stringify({
      error: {
        code: 'validation_error',
        message: `Duplicate item found with id ${duplicateItemId}. Remove duplicate items from your input and try again.`,
        type: 'invalid_request_error',
      },
    });
    const errorMessage = `OpenAI Responses SSE HTTP 500: ${JSON.stringify({
      error: {
        message: `litellm.APIConnectionError: Bedrock_mantleException - ${inner}`,
        code: '500',
      },
    })}`;

    await handleRefusalRecovery({
      event: {
        messages: [{ role: 'assistant', stopReason: 'error', errorMessage, content: [] }],
      },
      ctx,
      patchedSession: session as any,
      reviewRewrite,
      sendUserMessage,
    });

    expect(textBlock.textSignature).toBeUndefined();
    expect(sessionManager._buildIndex).toHaveBeenCalledTimes(1);
    expect(sessionManager._rewriteFile).toHaveBeenCalledTimes(1);
    expect(statusCalls).toEqual(['↻ Retryable error detected; retrying with Continue...']);
    expect(getPendingRecovery('session-1')).toMatchObject({
      kind: 'retryable-error',
      expectedLeafId: 'user-1',
      details: { replacement: { parentEntryId: 'user-1' } },
    });
    expect(notify).not.toHaveBeenCalled();
  });

  test('does not retry a duplicate Responses item error when the offending id is absent', async () => {
    const { duplicateItemId, session, sessionManager, textBlock } =
      createFakeDuplicateResponsesItemSession();
    textBlock.textSignature = JSON.stringify({ v: 1, id: 'msg_other' });
    const { ctx, notify } = createCtx(sessionManager);

    await handleRefusalRecovery({
      event: {
        messages: [
          {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: `Duplicate item found with id ${duplicateItemId}.`,
            content: [],
          },
        ],
      },
      ctx,
      patchedSession: session as any,
      reviewRewrite: vi.fn(),
      sendUserMessage: vi.fn(),
    });

    expect(getPendingRecovery('session-1')).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      `pi-retry could not remove duplicate Responses item ${duplicateItemId} before retry`,
      'warning',
    );
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
      return {
        ok: true,
        apiKey: 'fallback-key',
        baseUrl: 'https://resolved.example/v1',
        headers: { 'x-test': '1' },
      };
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
    expect(reviewRewrite.mock.calls[0]?.[0]).toMatchObject({
      model: { id: 'gemini-3.1-pro-preview' },
      baseUrl: 'https://resolved.example/v1',
    });
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
  test('keeps a successful awaitable recovery outcome until prompt observes it', async () => {
    const { session, sessionManager } = createFakeErrorSession();
    const ctx = {
      cwd: process.cwd(),
      hasUI: false,
      sessionManager,
      ui: createDispatchUi([]),
    } as any;

    await handleRefusalRecovery({
      event: { messages: [sessionManager.getEntries().at(-1)?.message] },
      ctx,
      patchedSession: session as any,
      reviewRewrite: vi.fn(),
      sendUserMessage: vi.fn(),
      dispatchMode: 'immediate',
    });

    expect(
      resolveRecoveryOnAssistantMessage(ctx, {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Recovered answer' }],
      }),
    ).toBe(true);

    await expect(waitForRecoveryOutcome('session-1')).resolves.toEqual({ ok: true });
  });

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
