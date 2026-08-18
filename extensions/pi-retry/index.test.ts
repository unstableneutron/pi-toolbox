import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  filterSessionContextForRetryDisplay,
  linearizeRetryRecoveryTreeForDisplay,
  classifyRetryableProviderError,
  createPiRetryExtension,
  getAbortListenerBindingCount,
  getRecoveryDispatchDelayMs,
  installAgentSessionPatch,
  isExtraRetryableAssistantError,
  isSkippableEmptyFailedAssistantArtifact,
  normalizeInvalidOpenAIResponsesStop,
  resetPiRetryTestState,
} from './index';
import * as runtime from './runtime';

const REPLAY_SAFE_WS_TRANSPORT_DIAGNOSTIC = {
  type: 'openai_websocket_transport',
  details: {
    finalTransport: 'websocket',
    outcome: 'transport_error',
    responseIdSeen: true,
    eventCount: 1,
    replayUnsafeEventSeen: false,
  },
};

const ENCRYPTED_CONTENT_ERROR =
  '{"type":"error","status":400,"error":{"type":"invalid_request_error","code":"invalid_encrypted_content","message":"The encrypted content for item rs_123 could not be verified. Reason: Encrypted content could not be decrypted or parsed."}}';

const CREATED_BY_ERROR = `Error: 400 litellm.BadRequestError: AzureException BadRequestError - {
  "error": {
    "message": "Unknown parameter: 'input[26].created_by'.",
    "type": "invalid_request_error",
    "param": "input[26].created_by",
    "code": "unknown_parameter"
  }
}`;

const ACTIVE_DEPLOYMENT_UNAVAILABLE_ERROR = `Error: OpenAI API error (404): {"message":"litellm.APIError: AzureException APIError - {\\"error\\":{\\"message\\":\\"Failed to find an active deployment in region: eastus2 for Azure resource bucket: EXAMPLE_BUCKET\\",\\"code\\":\\"not_found\\",\\"type\\":\\"not_found_error\\"},\\"status_code\\":404}. Received Model Group=gpt-5.6-luna Available Model Group Fallbacks=None","code":"404"}`;

function makeAssistantErrorMessage(
  errorMessage: string,
  overrides: { [key: string]: unknown } = {},
) {
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
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PI_RETRY_REFUSAL_RECOVERY_DISABLED;
  delete process.env.PI_SUBAGENT_CHILD;
  resetPiRetryTestState();
});

describe('pi-retry extra provider classification', () => {
  test('does not classify a missing configured deployment as retryable', () => {
    expect(
      classifyRetryableProviderError(
        '404 The API deployment for this resource does not exist. If you created the deployment recently, please wait a moment and try again.',
      ),
    ).toBeUndefined();
  });

  test('normalizes empty completed OpenAI Responses output into a retryable provider error', () => {
    const normalized = normalizeInvalidOpenAIResponsesStop({
      role: 'assistant',
      api: 'openai-responses',
      stopReason: 'stop',
      content: [
        {
          type: 'thinking',
          thinking: '',
          thinkingSignature: JSON.stringify({ type: 'reasoning', id: 'rs_empty' }),
        },
      ],
    });

    expect(normalized).toMatchObject({
      stopReason: 'error',
      errorMessage:
        'Model produced invalid content: response.completed contained no assistant text or function calls',
    });
    expect(classifyRetryableProviderError(normalized?.errorMessage)).toBe('providerServerError');
    expect(
      normalizeInvalidOpenAIResponsesStop({
        role: 'assistant',
        api: 'openai-responses',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'visible output' }],
      }),
    ).toBeUndefined();
    expect(
      normalizeInvalidOpenAIResponsesStop({
        role: 'assistant',
        api: 'anthropic-messages',
        stopReason: 'stop',
        content: [],
      }),
    ).toBeUndefined();
  });

  test('classifies an unavailable active resource-bucket deployment as retryable', () => {
    expect(classifyRetryableProviderError(ACTIVE_DEPLOYMENT_UNAVAILABLE_ERROR)).toBe(
      'providerServerError',
    );
  });

  test('classifies encrypted-content verification 400 as retryable', () => {
    expect(
      classifyRetryableProviderError(
        '400 The encrypted content in the request could not be verified by the server.',
      ),
    ).toBe('encryptedContentVerification');
  });

  test('classifies native compaction created_by replay payload failures as retryable', () => {
    expect(
      classifyRetryableProviderError(
        `Error: 400 litellm.BadRequestError: AzureException BadRequestError - {
          "error": {
            "message": "Unknown parameter: 'input[26].created_by'.",
            "type": "invalid_request_error",
            "param": "input[26].created_by",
            "code": "unknown_parameter"
          }
        }. Received Model Group=gpt-5.4`,
      ),
    ).toBe('nativeCompactionCreatedBy');
  });

  test('classifies provider server-processing failure as retryable', () => {
    expect(
      classifyRetryableProviderError(
        'The server had an error processing your request. Sorry about that!',
      ),
    ).toBe('providerServerError');
  });

  test('classifies invalid-model-content failures as retryable', () => {
    expect(
      classifyRetryableProviderError(
        'Error: The model produced invalid content. Consider modifying your prompt if you are seeing this error persistently.',
      ),
    ).toBe('providerServerError');
  });

  test('classifies no-details unknown errors as retryable', () => {
    expect(classifyRetryableProviderError('Unknown error (no error details in response)')).toBe(
      'providerServerError',
    );
  });

  test('classifies missing-tool-call output errors as retryable', () => {
    expect(
      classifyRetryableProviderError(
        '400 No tool call found for function call output with call_id call_t9dSFr1B217OEXGFGKzOL5vw.',
      ),
    ).toBe('providerServerError');
  });

  test('classifies Bedrock tool-result/tool-use count mismatch as retryable', () => {
    expect(
      classifyRetryableProviderError(
        'Error: 400 litellm.BadRequestError: BedrockException - {"message":"The number of toolResult blocks at messages.198.content exceeds the number of toolUse blocks of previous turn."}. Received Model Group=global.anthropic.claude-opus-4-6-v1 Available Model Group Fallbacks=None',
      ),
    ).toBe('providerServerError');
  });

  test('classifies peak-load provisioned-throughput failures as retryable', () => {
    expect(
      classifyRetryableProviderError(
        'Error: The system is currently experiencing high demand and cannot process your request. Your request exceeds the maximum usage size allowed during peak load. For improved capacity reliability, consider switching to Provisioned Throughput.',
      ),
    ).toBe('providerServerError');
  });

  test('classifies proxy stream-close timeouts as retryable provider errors', () => {
    const errorMessage =
      '{"type":"error","status":408,"error":{"message":"stream closed before response.completed","type":"invalid_request_error"}}';

    expect(classifyRetryableProviderError(errorMessage)).toBe('providerServerError');
    expect(isExtraRetryableAssistantError(makeAssistantErrorMessage(errorMessage))).toBe(true);
  });

  test('does not classify unrelated generic 404 text as retryable', () => {
    expect(classifyRetryableProviderError('404 Resource not found')).toBeUndefined();
  });

  test('does not classify unrelated generic 400 text as retryable', () => {
    expect(classifyRetryableProviderError('400 Invalid request payload')).toBeUndefined();
  });

  test.each([
    'model_context_window_exceeded: the request is too large for the model context window.',
    'prompt too long; exceeded max context length 131072 tokens.',
    'context window exceeded while preparing the request.',
  ])('does not classify context-overflow aliases as retryable', (errorMessage) => {
    expect(classifyRetryableProviderError(errorMessage)).toBeUndefined();
    expect(isExtraRetryableAssistantError(makeAssistantErrorMessage(errorMessage))).toBe(false);
  });

  test('requires final assistant error shape before allowing retry', () => {
    expect(
      isExtraRetryableAssistantError(
        makeAssistantErrorMessage('404 The API deployment for this resource does not exist.', {
          stopReason: 'stop',
        }),
      ),
    ).toBe(false);

    expect(
      isExtraRetryableAssistantError({
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'todo entry is locked by another session',
      }),
    ).toBe(false);
  });

  test('classifies replay-safe websocket Responses transport failures as retryable', () => {
    expect(
      isExtraRetryableAssistantError(
        makeAssistantErrorMessage('WebSocket closed before response.completed code=1006', {
          api: 'openai-websocket-responses',
          diagnostics: [REPLAY_SAFE_WS_TRANSPORT_DIAGNOSTIC],
        }),
      ),
    ).toBe(true);
  });

  test('does not classify websocket Responses transport failures after output as retryable', () => {
    expect(
      isExtraRetryableAssistantError(
        makeAssistantErrorMessage('WebSocket closed before response.completed code=1006', {
          api: 'openai-websocket-responses',
          content: [{ type: 'text', text: 'partial' }],
          diagnostics: [
            {
              type: 'openai_websocket_transport',
              details: {
                finalTransport: 'websocket',
                outcome: 'transport_error',
                replayUnsafeEventSeen: true,
                firstReplayUnsafeEventType: 'response.output_text.delta',
              },
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe('pi-retry skippable empty failed assistant artifacts', () => {
  test('detects empty zero-token assistant error artifacts', () => {
    expect(
      isSkippableEmptyFailedAssistantArtifact({
        role: 'assistant',
        stopReason: 'error',
        content: [],
        usage: { input: 0, output: 0, total: 0 },
      }),
    ).toBe(true);
  });

  test('detects empty aborted assistant artifacts with empty usage', () => {
    expect(
      isSkippableEmptyFailedAssistantArtifact({
        role: 'assistant',
        stopReason: 'aborted',
        content: [],
        usage: {},
      }),
    ).toBe(true);
  });

  test('keeps failed assistant messages that have visible output, tool calls, or token usage', () => {
    expect(
      isSkippableEmptyFailedAssistantArtifact({
        role: 'assistant',
        stopReason: 'error',
        content: [{ type: 'text', text: 'Partial answer' }],
        usage: { input: 0, output: 0, total: 0 },
      }),
    ).toBe(false);

    expect(
      isSkippableEmptyFailedAssistantArtifact({
        role: 'assistant',
        stopReason: 'aborted',
        content: [{ type: 'toolCall', id: 'call-1', name: 'read' }],
        usage: { input: 0, output: 0, total: 0 },
      }),
    ).toBe(false);

    expect(
      isSkippableEmptyFailedAssistantArtifact({
        role: 'assistant',
        stopReason: 'error',
        content: [],
        usage: { input: 12, output: 0, total: 12 },
      }),
    ).toBe(false);
  });
});

describe('pi-retry recovery backoff', () => {
  test('uses aggressive early delays before backing off for queued recovery dispatch', () => {
    const settings = { baseDelayMs: 250, maxRetries: 8 };
    expect(getRecoveryDispatchDelayMs(1, settings)).toBe(250);
    expect(getRecoveryDispatchDelayMs(2, settings)).toBe(500);
    expect(getRecoveryDispatchDelayMs(3, settings)).toBe(1000);
    expect(getRecoveryDispatchDelayMs(4, settings)).toBe(2000);
    expect(getRecoveryDispatchDelayMs(8, settings)).toBe(32000);
    expect(getRecoveryDispatchDelayMs(9, settings)).toBe(32000);
  });
});

function makeFakeAgentSessionModule() {
  class FakeAgentSession {
    public sessionManager = {
      getSessionId: () => 'session-1',
    };

    public baseClassifierCalls: unknown[] = [];

    _isRetryableError(message: { role?: string; stopReason?: string; errorMessage?: string }) {
      this.baseClassifierCalls.push(message);
      return 'overloaded_error' === message.errorMessage || /500/.test(message.errorMessage ?? '');
    }

    async prompt(_text: string) {
      throw new Error('original retryable prompt failure');
    }
  }

  class FakeSessionManager {
    private leafId = 'assistant-success';

    getLeafId() {
      return this.leafId;
    }

    getBranch() {
      return [
        { id: 'user-1', parentId: null, type: 'message' },
        {
          id: 'recovery-1',
          parentId: 'user-1',
          type: 'custom_message',
          customType: 'pi-retry-recovery',
          display: false,
          details: {
            version: 1,
            displayHint: 'linear-replacement',
            kind: 'retryable-error',
            messageKind: 'continue',
            attempt: 1,
            replacement: {
              supersedesEntryId: 'assistant-error',
              parentEntryId: 'user-1',
            },
          },
        },
        { id: 'assistant-success', parentId: 'recovery-1', type: 'message' },
      ];
    }

    buildSessionContext() {
      return {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] },
          {
            role: 'custom',
            customType: 'pi-retry-recovery',
            content: 'Continue.',
            display: false,
          },
          { role: 'assistant', content: [{ type: 'text', text: 'Recovered answer' }] },
        ],
        thinkingLevel: 'high',
        model: { provider: 'gust', modelId: 'gpt-5.4' },
      };
    }

    getTree() {
      return [
        {
          entry: { id: 'user-1', parentId: null, type: 'message' },
          children: [
            {
              entry: {
                id: 'assistant-error',
                parentId: 'user-1',
                type: 'message',
                message: {
                  role: 'assistant',
                  stopReason: 'error',
                  errorMessage: 'boom',
                  content: [],
                },
              },
              children: [],
            },
            {
              entry: {
                id: 'recovery-1',
                parentId: 'user-1',
                type: 'custom_message',
                customType: 'pi-retry-recovery',
                content: 'Continue.',
                display: false,
                details: {
                  version: 1,
                  displayHint: 'linear-replacement',
                  kind: 'retryable-error',
                  messageKind: 'continue',
                  attempt: 1,
                  replacement: {
                    supersedesEntryId: 'assistant-error',
                    parentEntryId: 'user-1',
                  },
                },
              },
              children: [
                {
                  entry: {
                    id: 'assistant-success',
                    parentId: 'recovery-1',
                    type: 'message',
                    message: { role: 'assistant', stopReason: 'stop', content: [] },
                  },
                  children: [],
                },
              ],
            },
          ],
        },
      ];
    }
  }

  return { AgentSession: FakeAgentSession, SessionManager: FakeSessionManager };
}

async function createExtensionHarness(loader: () => Promise<{ AgentSession?: any }>) {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
  const sendUserMessageCalls: Array<{
    content: string;
    options?: { deliverAs?: 'steer' | 'followUp' };
  }> = [];
  const sendMessageCalls: Array<{
    message: { customType: string; content: string; display: boolean; details?: unknown };
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' };
  }> = [];
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
      handlers.set(event, handler);
    },
    registerCommand(
      name: string,
      options: { handler: (args: string, ctx: any) => Promise<void> | void },
    ) {
      commands.set(name, options);
    },
    sendUserMessage(content: string, options?: { deliverAs?: 'steer' | 'followUp' }) {
      sendUserMessageCalls.push({ content, options });
    },
    sendMessage(
      message: { customType: string; content: string; display: boolean; details?: unknown },
      options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' },
    ) {
      sendMessageCalls.push({ message, options });
    },
  } as any;

  const extension = createPiRetryExtension(loader);
  await extension(pi);

  const statusCalls: { key: string; text: string | undefined }[] = [];
  const notifyCalls: { message: string; type?: string }[] = [];
  const confirmCalls: Array<{ title: string; message: string }> = [];
  const ctx = {
    hasUI: true,
    isIdle: () => true,
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    model: { provider: 'gust', id: 'claude-sonnet-4-6', api: 'anthropic-messages' },
    modelRegistry: {
      getAvailable: vi.fn().mockReturnValue([]),
      getApiKeyAndHeaders: vi.fn(),
    },
    signal: undefined,
    sessionManager: {
      getSessionId: () => 'session-1',
      getEntries: () => [],
      getLeafId: () => undefined,
    },
    hasPendingMessages: () => false,
    ui: {
      setStatus(key: string, text: string | undefined) {
        statusCalls.push({ key, text });
      },
      notify(message: string, type?: string) {
        notifyCalls.push({ message, type });
      },
      confirm(title: string, message: string) {
        confirmCalls.push({ title, message });
        return Promise.resolve(false);
      },
    },
  } as any;

  return {
    handlers,
    commands,
    ctx,
    statusCalls,
    notifyCalls,
    confirmCalls,
    sendUserMessageCalls,
    sendMessageCalls,
  };
}

function getHandler(
  handlers: Map<string, (event: any, ctx: any) => Promise<void> | void>,
  name: string,
) {
  const handler = handlers.get(name);
  if (!handler) {
    throw new Error(`Missing handler: ${name}`);
  }
  return handler;
}

describe('pi-retry patch installation', () => {
  test('installs the patch once and preserves the original classifier first', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const loader = vi.fn().mockResolvedValue(fakeModule);

    await installAgentSessionPatch(loader);
    await installAgentSessionPatch(loader);

    const session = new fakeModule.AgentSession();

    expect(
      session._isRetryableError({
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'overloaded_error',
      }),
    ).toBe(true);

    expect(
      session._isRetryableError({
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '404 The API deployment for this resource does not exist.',
      }),
    ).toBe(false);

    expect(
      session._isRetryableError({
        role: 'assistant',
        stopReason: 'error',
        errorMessage: ACTIVE_DEPLOYMENT_UNAVAILABLE_ERROR,
      }),
    ).toBe(true);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(session.baseClassifierCalls).toHaveLength(2);
  });

  test('keeps terminal websocket deployment diagnostics out of the core retry classifier', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const loader = vi.fn().mockResolvedValue(fakeModule);

    await installAgentSessionPatch(loader);

    const session = new fakeModule.AgentSession();

    expect(
      session._isRetryableError({
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'Unexpected server response: 500 (deploymentMissing)',
        diagnostics: [
          {
            type: 'openai_websocket_transport',
            details: {
              finalTransport: 'websocket',
              outcome: 'transport_error',
              retryable: false,
              failureReason: 'deploymentMissing',
              failureCategory: 'terminal_config_error',
            },
          },
        ],
      } as any),
    ).toBe(false);

    expect(session.baseClassifierCalls).toHaveLength(0);
  });

  test('keeps sanitizer-owned provider errors out of the core retry classifier', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const loader = vi.fn().mockResolvedValue(fakeModule);

    await installAgentSessionPatch(loader);

    const session = new fakeModule.AgentSession();

    expect(
      session._isRetryableError({
        role: 'assistant',
        stopReason: 'error',
        errorMessage: ENCRYPTED_CONTENT_ERROR,
      }),
    ).toBe(false);

    expect(
      session._isRetryableError({
        role: 'assistant',
        stopReason: 'error',
        errorMessage: CREATED_BY_ERROR,
      }),
    ).toBe(false);

    expect(
      session._isRetryableError({
        role: 'assistant',
        stopReason: 'error',
        errorMessage:
          'OpenAI Responses SSE HTTP 500: {"error":{"message":"litellm.APIConnectionError: Bedrock_mantleException - {\\"error\\":{\\"code\\":\\"validation_error\\",\\"message\\":\\"Duplicate item found with id msg_123. Remove duplicate items from your input and try again.\\",\\"type\\":\\"invalid_request_error\\"}}"}}',
      }),
    ).toBe(false);

    expect(
      session._isRetryableError({
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '404 The API deployment for this resource does not exist.',
      }),
    ).toBe(false);
    expect(session.baseClassifierCalls).toHaveLength(0);
  });

  test('patches prompt to suppress retryable prompt failures after awaitable recovery succeeds', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const loader = vi.fn().mockResolvedValue(fakeModule);

    vi.spyOn(runtime, 'hasAwaitableRecovery').mockReturnValue(true);
    vi.spyOn(runtime, 'waitForRecoveryOutcome').mockResolvedValue({ ok: true });

    await installAgentSessionPatch(loader);

    const session = new fakeModule.AgentSession();

    await expect(session.prompt('Do the thing')).resolves.toBeUndefined();
    expect(runtime.waitForRecoveryOutcome).toHaveBeenCalledWith('session-1', {
      timeoutMs: expect.any(Number),
    });
  });

  test('patches SessionManager getTree to hide historical retry recovery nodes', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const loader = vi.fn().mockResolvedValue(fakeModule);

    await installAgentSessionPatch(loader);

    const sessionManager = new fakeModule.SessionManager();

    // buildSessionContext is no longer patched. LLM-context filtering now
    // happens via the `context` extension event; that path is covered in the
    // dedicated "pi-retry context hook" describe block below.
    const rawContext = sessionManager.buildSessionContext();
    expect(rawContext.messages).toHaveLength(3);

    const tree = sessionManager.getTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].entry.id).toBe('assistant-success');
    expect(tree[0].children[0].entry.parentId).toBe('user-1');
  });

  test('filters hidden retry-recovery custom messages via the context event', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const loader = vi.fn().mockResolvedValue(fakeModule);

    const { handlers, ctx } = await createExtensionHarness(loader);

    // Branch containing two hidden recovery entries plus a trailing assistant.
    (ctx.sessionManager as any).getBranch = () => [
      { id: 'user-1', parentId: null, type: 'message' },
      { id: 'assistant-error-1', parentId: 'user-1', type: 'message' },
      {
        id: 'recovery-1',
        parentId: 'assistant-error-1',
        type: 'custom_message',
        customType: 'pi-retry-recovery',
        display: false,
      },
      {
        id: 'recovery-2',
        parentId: 'recovery-1',
        type: 'custom_message',
        customType: 'pi-retry-recovery',
        display: false,
      },
      { id: 'assistant-success', parentId: 'recovery-2', type: 'message' },
    ];
    (ctx.sessionManager as any).getLeafId = () => 'assistant-success';

    const contextHandler = getHandler(handlers, 'context');
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] },
      {
        role: 'custom',
        customType: 'pi-retry-recovery',
        content: 'Continue.',
        display: false,
      },
      {
        role: 'custom',
        customType: 'pi-retry-recovery',
        content: 'Please continue.',
        display: false,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Recovered answer' }],
      },
    ];

    const result = await contextHandler({ type: 'context', messages }, ctx);

    // Both hidden recovery messages are dropped because neither is the leaf.
    expect(result).toEqual({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Recovered answer' }],
        },
      ],
    });
  });

  test('keeps the trailing retry-recovery message when it is the current leaf', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const loader = vi.fn().mockResolvedValue(fakeModule);

    const { handlers, ctx } = await createExtensionHarness(loader);

    (ctx.sessionManager as any).getBranch = () => [
      { id: 'user-1', parentId: null, type: 'message' },
      { id: 'assistant-error-1', parentId: 'user-1', type: 'message' },
      {
        id: 'recovery-1',
        parentId: 'assistant-error-1',
        type: 'custom_message',
        customType: 'pi-retry-recovery',
        display: false,
      },
    ];
    (ctx.sessionManager as any).getLeafId = () => 'recovery-1';

    const contextHandler = getHandler(handlers, 'context');
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] },
      {
        role: 'custom',
        customType: 'pi-retry-recovery',
        content: 'Continue.',
        display: false,
      },
    ];

    const result = await contextHandler({ type: 'context', messages }, ctx);
    // Trailing recovery entry is the leaf, so it survives the filter.
    expect(result).toBeUndefined();
  });

  test('returns undefined when the current branch has no recovery entries', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const loader = vi.fn().mockResolvedValue(fakeModule);

    const { handlers, ctx } = await createExtensionHarness(loader);

    (ctx.sessionManager as any).getBranch = () => [
      { id: 'user-1', parentId: null, type: 'message' },
      { id: 'assistant-1', parentId: 'user-1', type: 'message' },
    ];
    (ctx.sessionManager as any).getLeafId = () => 'assistant-1';

    const contextHandler = getHandler(handlers, 'context');
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
    ];

    const result = await contextHandler({ type: 'context', messages }, ctx);
    expect(result).toBeUndefined();
  });

  test('skips an empty zero-token assistant error artifact from retry/resume context', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const loader = vi.fn().mockResolvedValue(fakeModule);

    const { handlers, ctx } = await createExtensionHarness(loader);

    (ctx.sessionManager as any).getBranch = () => [
      { id: 'user-1', parentId: null, type: 'message' },
      {
        id: 'assistant-error-empty',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'error',
          content: [],
          usage: { input: 0, output: 0, total: 0 },
          errorMessage: 'upstream stream bootstrap timed out before first chunk',
        },
      },
      { id: 'user-continue', parentId: 'assistant-error-empty', type: 'message' },
    ];
    (ctx.sessionManager as any).getLeafId = () => 'user-continue';

    const contextHandler = getHandler(handlers, 'context');
    const originalPrompt = { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] };
    const emptyError = {
      role: 'assistant',
      stopReason: 'error',
      content: [],
      usage: { input: 0, output: 0, total: 0 },
      errorMessage: 'upstream stream bootstrap timed out before first chunk',
    };
    const continuePrompt = { role: 'user', content: [{ type: 'text', text: 'Continue' }] };

    const result = await contextHandler(
      { type: 'context', messages: [originalPrompt, emptyError, continuePrompt] },
      ctx,
    );

    expect(result).toEqual({ messages: [originalPrompt, continuePrompt] });
  });

  test('skips an interrupted unexecuted tool call from continuation context', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const { handlers, ctx } = await createExtensionHarness(async () => fakeModule);

    const interruptedError = {
      role: 'assistant',
      api: 'openai-responses',
      stopReason: 'error',
      errorMessage: 'OpenAI Responses SSE ended before a terminal event',
      content: [{ type: 'toolCall', id: 'call_read|fc_1', name: 'read', arguments: { path: '.' } }],
    };
    const originalPrompt = { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] };
    const continuePrompt = {
      role: 'custom',
      customType: 'pi-retry-recovery',
      content: runtime.INTERRUPTED_TOOL_CALL_CONTINUE_MESSAGE,
    };

    const result = await getHandler(handlers, 'context')(
      { type: 'context', messages: [originalPrompt, interruptedError, continuePrompt] },
      ctx,
    );

    expect(result).toEqual({ messages: [originalPrompt, continuePrompt] });
  });

  test('skips an empty aborted assistant artifact from retry/resume context', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const loader = vi.fn().mockResolvedValue(fakeModule);

    const { handlers, ctx } = await createExtensionHarness(loader);

    (ctx.sessionManager as any).getBranch = () => [
      { id: 'user-1', parentId: null, type: 'message' },
      {
        id: 'assistant-aborted-empty',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'aborted',
          content: [],
          usage: {},
        },
      },
    ];
    (ctx.sessionManager as any).getLeafId = () => 'assistant-aborted-empty';

    const contextHandler = getHandler(handlers, 'context');
    const originalPrompt = { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] };
    const emptyAborted = {
      role: 'assistant',
      stopReason: 'aborted',
      content: [],
      usage: {},
    };

    const result = await contextHandler(
      { type: 'context', messages: [originalPrompt, emptyAborted] },
      ctx,
    );

    expect(result).toEqual({ messages: [originalPrompt] });
  });

  test('filters orphan tool results from context before provider calls', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const loader = vi.fn().mockResolvedValue(fakeModule);

    const { handlers, ctx } = await createExtensionHarness(loader);

    (ctx.sessionManager as any).getBranch = () => [
      { id: 'user-1', parentId: null, type: 'message' },
      { id: 'assistant-1', parentId: 'user-1', type: 'message' },
      { id: 'result-1', parentId: 'assistant-1', type: 'message' },
      { id: 'orphan-result', parentId: 'result-1', type: 'message' },
    ];
    (ctx.sessionManager as any).getLeafId = () => 'orphan-result';

    const contextHandler = getHandler(handlers, 'context');
    const validToolResult = {
      role: 'toolResult',
      toolCallId: 'toolu_valid|fc_valid',
      toolName: 'bash',
      content: [{ type: 'text', text: 'valid output' }],
    };
    const orphanToolResult = {
      role: 'toolResult',
      toolCallId: 'toolu_orphan|fc_orphan',
      toolName: 'bash',
      content: [{ type: 'text', text: 'orphan output' }],
    };
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'toolu_valid|fc_valid', name: 'bash', arguments: {} }],
      },
      validToolResult,
      orphanToolResult,
    ];

    const result = await contextHandler({ type: 'context', messages }, ctx);

    expect(result).toEqual({
      messages: [messages[0], messages[1], validToolResult],
    });
  });

  test('filters duplicate tool results after their tool call is matched once', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const loader = vi.fn().mockResolvedValue(fakeModule);

    const { handlers, ctx } = await createExtensionHarness(loader);

    (ctx.sessionManager as any).getBranch = () => [
      { id: 'user-1', parentId: null, type: 'message' },
      { id: 'assistant-1', parentId: 'user-1', type: 'message' },
      { id: 'result-1', parentId: 'assistant-1', type: 'message' },
      { id: 'duplicate-result', parentId: 'result-1', type: 'message' },
    ];
    (ctx.sessionManager as any).getLeafId = () => 'duplicate-result';

    const contextHandler = getHandler(handlers, 'context');
    const firstToolResult = {
      role: 'toolResult',
      toolCallId: 'call_once|fc_once',
      toolName: 'bash',
      content: [{ type: 'text', text: 'first output' }],
    };
    const duplicateToolResult = {
      role: 'toolResult',
      toolCallId: 'call_once|fc_once',
      toolName: 'bash',
      content: [{ type: 'text', text: 'duplicate output' }],
    };
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_once|fc_once', name: 'bash', arguments: {} }],
      },
      firstToolResult,
      duplicateToolResult,
    ];

    const result = await contextHandler({ type: 'context', messages }, ctx);

    expect(result).toEqual({
      messages: [messages[0], messages[1], firstToolResult],
    });
  });

  test('preserves multiple tool results that match the previous assistant tool calls', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const loader = vi.fn().mockResolvedValue(fakeModule);

    const { handlers, ctx } = await createExtensionHarness(loader);

    (ctx.sessionManager as any).getBranch = () => [
      { id: 'user-1', parentId: null, type: 'message' },
      { id: 'assistant-1', parentId: 'user-1', type: 'message' },
      { id: 'result-1', parentId: 'assistant-1', type: 'message' },
      { id: 'result-2', parentId: 'result-1', type: 'message' },
    ];
    (ctx.sessionManager as any).getLeafId = () => 'result-2';

    const contextHandler = getHandler(handlers, 'context');
    const firstToolResult = {
      role: 'toolResult',
      toolCallId: 'call_one|fc_one',
      toolName: 'read',
      content: [{ type: 'text', text: 'first output' }],
    };
    const secondToolResult = {
      role: 'toolResult',
      toolCallId: 'call_two|fc_two',
      toolName: 'bash',
      content: [{ type: 'text', text: 'second output' }],
    };
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] },
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'call_one|fc_one', name: 'read', arguments: {} },
          { type: 'toolCall', id: 'call_two|fc_two', name: 'bash', arguments: {} },
        ],
      },
      firstToolResult,
      secondToolResult,
    ];

    const result = await contextHandler({ type: 'context', messages }, ctx);

    expect(result).toBeUndefined();
  });

  test('filters tool results that exceed the previous assistant tool calls', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const loader = vi.fn().mockResolvedValue(fakeModule);

    const { handlers, ctx } = await createExtensionHarness(loader);

    (ctx.sessionManager as any).getBranch = () => [
      { id: 'user-1', parentId: null, type: 'message' },
      { id: 'assistant-old', parentId: 'user-1', type: 'message' },
      { id: 'assistant-current', parentId: 'assistant-old', type: 'message' },
      { id: 'result-old', parentId: 'assistant-current', type: 'message' },
      { id: 'result-current', parentId: 'result-old', type: 'message' },
    ];
    (ctx.sessionManager as any).getLeafId = () => 'result-current';

    const contextHandler = getHandler(handlers, 'context');
    const staleToolResult = {
      role: 'toolResult',
      toolCallId: 'call_old|fc_old',
      toolName: 'read',
      content: [{ type: 'text', text: 'stale output' }],
    };
    const currentToolResult = {
      role: 'toolResult',
      toolCallId: 'call_current|fc_current',
      toolName: 'bash',
      content: [{ type: 'text', text: 'current output' }],
    };
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_old|fc_old', name: 'read', arguments: {} }],
      },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_current|fc_current', name: 'bash', arguments: {} }],
      },
      staleToolResult,
      currentToolResult,
    ];

    const result = await contextHandler({ type: 'context', messages }, ctx);

    expect(result).toEqual({
      messages: [messages[0], messages[1], messages[2], currentToolResult],
    });
  });

  test('filters non-adjacent tool results after another assistant turn', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const loader = vi.fn().mockResolvedValue(fakeModule);

    const { handlers, ctx } = await createExtensionHarness(loader);

    (ctx.sessionManager as any).getBranch = () => [
      { id: 'user-1', parentId: null, type: 'message' },
      { id: 'assistant-1', parentId: 'user-1', type: 'message' },
      { id: 'result-1', parentId: 'assistant-1', type: 'message' },
      { id: 'assistant-2', parentId: 'result-1', type: 'message' },
      { id: 'stale-result', parentId: 'assistant-2', type: 'message' },
    ];
    (ctx.sessionManager as any).getLeafId = () => 'stale-result';

    const contextHandler = getHandler(handlers, 'context');
    const validToolResult = {
      role: 'toolResult',
      toolCallId: 'call_once|fc_once',
      toolName: 'read',
      content: [{ type: 'text', text: 'valid output' }],
    };
    const staleToolResult = {
      role: 'toolResult',
      toolCallId: 'call_once|fc_once',
      toolName: 'read',
      content: [{ type: 'text', text: 'stale output' }],
    };
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_once|fc_once', name: 'read', arguments: {} }],
      },
      validToolResult,
      { role: 'assistant', content: [{ type: 'text', text: 'Intermediate answer' }] },
      staleToolResult,
    ];

    const result = await contextHandler({ type: 'context', messages }, ctx);

    expect(result).toEqual({
      messages: [messages[0], messages[1], validToolResult, messages[3]],
    });
  });

  test('fails soft when the internal module shape is unavailable', async () => {
    await expect(
      installAgentSessionPatch(async () => ({ AgentSession: undefined })),
    ).resolves.toEqual({
      ok: false,
      reason: 'AgentSession export not found',
    });
  });

  test('caches the linearized tree per SessionManager and invalidates on change', async () => {
    type Node = {
      entry: {
        id: string;
        parentId: string | null;
        type: string;
        customType?: string;
        display?: boolean;
        details?: unknown;
      };
      children: Node[];
    };

    let rebuildCount = 0;
    let entries: Array<{ id: string; parentId: string | null; type: string }> = [
      { id: 'user-1', parentId: null, type: 'message' },
      { id: 'assistant-1', parentId: 'user-1', type: 'message' },
    ];
    let leafId: string | undefined = 'assistant-1';

    function buildTreeFromEntries(): Node[] {
      // Emulate pi-coding-agent's getTree: rebuild nodes from entries list
      // (returns fresh objects on every call).
      rebuildCount += 1;
      const byId = new Map<string, Node>();
      const roots: Node[] = [];
      for (const entry of entries) {
        byId.set(entry.id, { entry: { ...entry }, children: [] });
      }
      for (const entry of entries) {
        const node = byId.get(entry.id) as Node;
        if (entry.parentId === null) {
          roots.push(node);
        } else {
          byId.get(entry.parentId)?.children.push(node);
        }
      }
      return roots;
    }

    class CachingTestSessionManager {
      getLeafId() {
        return leafId;
      }
      getEntries() {
        return entries;
      }
      buildSessionContext() {
        return { messages: [], thinkingLevel: 'high', model: null };
      }
      getTree() {
        return buildTreeFromEntries();
      }
    }

    const fakeModule = {
      AgentSession: class {
        _isRetryableError() {
          return false;
        }
      },
      SessionManager: CachingTestSessionManager,
    };

    await installAgentSessionPatch(async () => fakeModule as any);

    const sessionManager = new fakeModule.SessionManager();

    // First call: cache miss, rebuilds tree.
    const firstTree = sessionManager.getTree();
    expect(rebuildCount).toBe(1);
    expect(firstTree).toHaveLength(1);
    expect(firstTree[0].entry.id).toBe('user-1');

    // Second call with identical state: cache hit, no rebuild, same reference.
    const secondTree = sessionManager.getTree();
    expect(rebuildCount).toBe(1);
    expect(secondTree).toBe(firstTree);

    // Changing leafId invalidates the cache.
    leafId = 'user-1';
    const thirdTree = sessionManager.getTree();
    expect(rebuildCount).toBe(2);
    expect(thirdTree).not.toBe(secondTree);

    // Appending an entry invalidates the cache too.
    entries = [...entries, { id: 'assistant-2', parentId: 'assistant-1', type: 'message' }];
    leafId = 'assistant-2';
    const fourthTree = sessionManager.getTree();
    expect(rebuildCount).toBe(3);
    expect(fourthTree).not.toBe(thirdTree);

    // Separate SessionManager instances get independent cache slots.
    const otherManager = new fakeModule.SessionManager();
    const otherTree = otherManager.getTree();
    expect(rebuildCount).toBe(4);
    expect(otherTree).not.toBe(fourthTree);

    // And repeated reads on the other instance hit its own cache.
    const otherTreeAgain = otherManager.getTree();
    expect(rebuildCount).toBe(4);
    expect(otherTreeAgain).toBe(otherTree);
  });
});

describe('pi-retry display linearization helpers', () => {
  test('preserves visible tree history while skipping empty failed assistant context', () => {
    const originalPrompt = { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] };
    const emptyError = {
      role: 'assistant',
      stopReason: 'error',
      content: [],
      usage: { input: 0, output: 0, total: 0 },
      errorMessage: 'upstream stream bootstrap timed out before first chunk',
    };
    const pathEntries = [
      { id: 'user-1', parentId: null, type: 'message', message: originalPrompt },
      {
        id: 'assistant-error-empty',
        parentId: 'user-1',
        type: 'message',
        message: emptyError,
      },
    ];

    const context = filterSessionContextForRetryDisplay(
      {
        messages: [originalPrompt, emptyError],
        thinkingLevel: 'high',
        model: { provider: 'gust', modelId: 'gpt-5.4' },
      },
      pathEntries,
      'assistant-error-empty',
    );

    expect(context.messages).toEqual([originalPrompt]);

    const tree = linearizeRetryRecoveryTreeForDisplay(
      [
        {
          entry: pathEntries[0],
          children: [{ entry: pathEntries[1], children: [] }],
        },
      ],
      'assistant-error-empty',
    );

    expect(tree[0].children.map((child) => child.entry.id)).toEqual(['assistant-error-empty']);
  });

  test('keeps the hidden retry recovery prompt when it is still the current leaf', () => {
    const context = filterSessionContextForRetryDisplay(
      {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] },
          {
            role: 'custom',
            customType: 'pi-retry-recovery',
            content: 'Continue.',
            display: false,
          },
        ],
        thinkingLevel: 'high',
        model: { provider: 'gust', modelId: 'gpt-5.4' },
      },
      [
        { id: 'user-1', parentId: null, type: 'message' },
        {
          id: 'recovery-1',
          parentId: 'user-1',
          type: 'custom_message',
          customType: 'pi-retry-recovery',
          display: false,
        },
      ],
      'recovery-1',
    );

    expect(context.messages).toHaveLength(2);
    expect(context.messages[1]).toMatchObject({ customType: 'pi-retry-recovery', display: false });
  });

  test('keeps the hidden retry recovery node visible while it is still the current tree leaf', () => {
    const tree = linearizeRetryRecoveryTreeForDisplay(
      [
        {
          entry: { id: 'user-1', parentId: null, type: 'message' },
          children: [
            {
              entry: {
                id: 'recovery-1',
                parentId: 'user-1',
                type: 'custom_message',
                customType: 'pi-retry-recovery',
                content: 'Continue.',
                display: false,
                details: {
                  version: 1,
                  displayHint: 'linear-replacement',
                  kind: 'retryable-error',
                  messageKind: 'continue',
                  attempt: 1,
                },
              },
              children: [],
            },
          ],
        },
      ],
      'recovery-1',
    );

    expect(tree[0].children[0]?.entry.id).toBe('recovery-1');
  });

  test('tolerates deep session trees without hidden retry recovery entries', () => {
    // Reproduces pi-retry/index.ts stack overflow from a long linear session
    // chain (~3k entries). Depth chosen well above Node's recursion limit.
    const depth = 6000;
    let current: {
      entry: { id: string; parentId: string | null; type: string };
      children: any[];
    } = {
      entry: { id: 'node-0', parentId: null, type: 'message' },
      children: [],
    };
    const root = current;
    for (let i = 1; i < depth; i++) {
      const next = {
        entry: { id: `node-${i}`, parentId: `node-${i - 1}`, type: 'message' },
        children: [],
      };
      current.children.push(next);
      current = next;
    }

    const tree = linearizeRetryRecoveryTreeForDisplay([root], `node-${depth - 1}`);
    expect(tree).toHaveLength(1);
    expect(tree[0].entry.id).toBe('node-0');

    // Walk down iteratively to verify depth is preserved.
    let seen = 0;
    let cursor: any = tree[0];
    while (cursor) {
      seen += 1;
      cursor = cursor.children[0];
    }
    expect(seen).toBe(depth);
  });

  test('tolerates deep session trees that contain a hidden retry recovery entry', () => {
    // Stresses the iterative pass-2 transform at depth by placing a hidden
    // non-leaf recovery entry near the root, so the fast path cannot apply.
    const depth = 6000;
    type Node = {
      entry: {
        id: string;
        parentId: string | null;
        type: string;
        customType?: string;
        display?: boolean;
        details?: unknown;
      };
      children: Node[];
    };
    const root: Node = {
      entry: { id: 'node-0', parentId: null, type: 'message' },
      children: [],
    };
    const recovery: Node = {
      entry: {
        id: 'recovery-early',
        parentId: 'node-0',
        type: 'custom_message',
        customType: 'pi-retry-recovery',
        display: false,
        details: {
          version: 1,
          displayHint: 'linear-replacement',
          kind: 'retryable-error',
          messageKind: 'continue',
          attempt: 1,
        },
      },
      children: [],
    };
    root.children.push(recovery);
    let cursor: Node = recovery;
    for (let i = 1; i < depth; i++) {
      const next: Node = {
        entry: { id: `node-${i}`, parentId: cursor.entry.id, type: 'message' },
        children: [],
      };
      cursor.children.push(next);
      cursor = next;
    }

    const tree = linearizeRetryRecoveryTreeForDisplay([root], `node-${depth - 1}`);
    expect(tree).toHaveLength(1);
    expect(tree[0].entry.id).toBe('node-0');
    // recovery-early should be hoisted away; its sole child (node-1) becomes
    // a direct child of node-0 with parentId rewritten.
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].entry.id).toBe('node-1');
    expect(tree[0].children[0].entry.parentId).toBe('node-0');

    // Verify the chain underneath still has full depth.
    let seen = 0;
    let walker: any = tree[0];
    while (walker) {
      seen += 1;
      walker = walker.children[0];
    }
    // depth-many original chain nodes + root (node-0) minus the hoisted-out
    // recovery node = depth.
    expect(seen).toBe(depth);
  });

  test('drops the entire superseded subtree, including descendants', () => {
    const tree = linearizeRetryRecoveryTreeForDisplay(
      [
        {
          entry: { id: 'user-1', parentId: null, type: 'message' },
          children: [
            {
              entry: {
                id: 'assistant-error',
                parentId: 'user-1',
                type: 'message',
                message: { role: 'assistant', stopReason: 'error', content: [] },
              },
              children: [
                {
                  entry: {
                    id: 'assistant-error-child',
                    parentId: 'assistant-error',
                    type: 'message',
                  },
                  children: [],
                },
              ],
            },
            {
              entry: {
                id: 'recovery-1',
                parentId: 'user-1',
                type: 'custom_message',
                customType: 'pi-retry-recovery',
                display: false,
                details: {
                  version: 1,
                  displayHint: 'linear-replacement',
                  kind: 'retryable-error',
                  messageKind: 'continue',
                  attempt: 1,
                  replacement: {
                    supersedesEntryId: 'assistant-error',
                    parentEntryId: 'user-1',
                  },
                },
              },
              children: [
                {
                  entry: {
                    id: 'assistant-success',
                    parentId: 'recovery-1',
                    type: 'message',
                  },
                  children: [],
                },
              ],
            },
          ],
        },
      ],
      'assistant-success',
    );

    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].entry.id).toBe('assistant-success');
    expect(tree[0].children[0].entry.parentId).toBe('user-1');
    // assistant-error-child must be gone along with its superseded parent.
    const ids = new Set<string>();
    const walk = [tree[0] as any];
    while (walk.length) {
      const next = walk.pop();
      ids.add(next.entry.id);
      for (const child of next.children) walk.push(child);
    }
    expect(ids.has('assistant-error')).toBe(false);
    expect(ids.has('assistant-error-child')).toBe(false);
  });

  test('collapses nested hidden retry recovery entries onto the nearest display parent', () => {
    const tree = linearizeRetryRecoveryTreeForDisplay(
      [
        {
          entry: { id: 'user-1', parentId: null, type: 'message' },
          children: [
            {
              entry: {
                id: 'recovery-outer',
                parentId: 'user-1',
                type: 'custom_message',
                customType: 'pi-retry-recovery',
                display: false,
                details: {
                  version: 1,
                  displayHint: 'linear-replacement',
                  kind: 'retryable-error',
                  messageKind: 'continue',
                  attempt: 1,
                },
              },
              children: [
                {
                  entry: {
                    id: 'recovery-inner',
                    parentId: 'recovery-outer',
                    type: 'custom_message',
                    customType: 'pi-retry-recovery',
                    display: false,
                    details: {
                      version: 1,
                      displayHint: 'linear-replacement',
                      kind: 'retryable-error',
                      messageKind: 'continue',
                      attempt: 2,
                    },
                  },
                  children: [
                    {
                      entry: {
                        id: 'assistant-ok',
                        parentId: 'recovery-inner',
                        type: 'message',
                      },
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      'assistant-ok',
    );

    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].entry.id).toBe('assistant-ok');
    expect(tree[0].children[0].entry.parentId).toBe('user-1');
  });

  test('preserves sibling order when hoisting a hidden recovery between siblings', () => {
    const tree = linearizeRetryRecoveryTreeForDisplay(
      [
        {
          entry: { id: 'user-1', parentId: null, type: 'message' },
          children: [
            {
              entry: { id: 'sibling-before', parentId: 'user-1', type: 'message' },
              children: [],
            },
            {
              entry: {
                id: 'recovery-1',
                parentId: 'user-1',
                type: 'custom_message',
                customType: 'pi-retry-recovery',
                display: false,
                details: {
                  version: 1,
                  displayHint: 'linear-replacement',
                  kind: 'retryable-error',
                  messageKind: 'continue',
                  attempt: 1,
                },
              },
              children: [
                {
                  entry: { id: 'hoisted-a', parentId: 'recovery-1', type: 'message' },
                  children: [],
                },
                {
                  entry: { id: 'hoisted-b', parentId: 'recovery-1', type: 'message' },
                  children: [],
                },
              ],
            },
            {
              entry: { id: 'sibling-after', parentId: 'user-1', type: 'message' },
              children: [],
            },
          ],
        },
      ],
      'sibling-after',
    );

    expect(tree[0].children.map((c: any) => c.entry.id)).toEqual([
      'sibling-before',
      'hoisted-a',
      'hoisted-b',
      'sibling-after',
    ]);
    expect(tree[0].children[1].entry.parentId).toBe('user-1');
    expect(tree[0].children[2].entry.parentId).toBe('user-1');
  });

  test('hoists a hidden retry recovery entry sitting at the root', () => {
    const tree = linearizeRetryRecoveryTreeForDisplay(
      [
        {
          entry: {
            id: 'recovery-root',
            parentId: null,
            type: 'custom_message',
            customType: 'pi-retry-recovery',
            display: false,
            details: {
              version: 1,
              displayHint: 'linear-replacement',
              kind: 'retryable-error',
              messageKind: 'continue',
              attempt: 1,
            },
          },
          children: [
            {
              entry: { id: 'hoisted-root-child', parentId: 'recovery-root', type: 'message' },
              children: [],
            },
          ],
        },
      ],
      'hoisted-root-child',
    );

    expect(tree).toHaveLength(1);
    expect(tree[0].entry.id).toBe('hoisted-root-child');
    expect(tree[0].entry.parentId).toBe(null);
  });

  test('drops a hidden recovery leaf when an earlier recovery supersedes it', () => {
    // Pins current behavior: the supersededIds check fires before the
    // "is current leaf?" check, so a hidden recovery that is both the
    // current leaf and superseded by a prior recovery is dropped.
    const tree = linearizeRetryRecoveryTreeForDisplay(
      [
        {
          entry: { id: 'user-1', parentId: null, type: 'message' },
          children: [
            {
              entry: {
                id: 'recovery-1',
                parentId: 'user-1',
                type: 'custom_message',
                customType: 'pi-retry-recovery',
                display: false,
                details: {
                  version: 1,
                  displayHint: 'linear-replacement',
                  kind: 'retryable-error',
                  messageKind: 'continue',
                  attempt: 1,
                  replacement: {
                    supersedesEntryId: 'recovery-2',
                    parentEntryId: 'user-1',
                  },
                },
              },
              children: [],
            },
            {
              entry: {
                id: 'recovery-2',
                parentId: 'user-1',
                type: 'custom_message',
                customType: 'pi-retry-recovery',
                display: false,
                details: {
                  version: 1,
                  displayHint: 'linear-replacement',
                  kind: 'retryable-error',
                  messageKind: 'continue',
                  attempt: 2,
                },
              },
              children: [],
            },
          ],
        },
      ],
      'recovery-2',
    );

    expect(tree).toHaveLength(1);
    // recovery-1 is hoisted (not the leaf); recovery-2 is superseded and
    // dropped even though it is the current leaf.
    expect(tree[0].children).toHaveLength(0);
  });

  test('hides assistant error leaves that were retried successfully', () => {
    const tree = linearizeRetryRecoveryTreeForDisplay(
      [
        {
          entry: { id: 'toolresult-1', parentId: null, type: 'message' },
          children: [
            {
              entry: {
                id: 'assistant-error',
                parentId: 'toolresult-1',
                type: 'message',
                message: {
                  role: 'assistant',
                  stopReason: 'error',
                  errorMessage: 'Internal server error',
                },
              },
              children: [],
            },
            {
              entry: {
                id: 'assistant-success',
                parentId: 'toolresult-1',
                type: 'message',
                message: { role: 'assistant', stopReason: 'toolUse' },
              },
              children: [],
            },
          ],
        },
      ],
      'assistant-success',
    );

    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((c) => c.entry.id)).toEqual(['assistant-success']);
  });

  test('keeps a terminal assistant error when no sibling recovered it', () => {
    const tree = linearizeRetryRecoveryTreeForDisplay(
      [
        {
          entry: { id: 'toolresult-1', parentId: null, type: 'message' },
          children: [
            {
              entry: {
                id: 'assistant-error',
                parentId: 'toolresult-1',
                type: 'message',
                message: {
                  role: 'assistant',
                  stopReason: 'error',
                  errorMessage: 'Internal server error',
                },
              },
              children: [],
            },
          ],
        },
      ],
      'assistant-error',
    );

    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((c) => c.entry.id)).toEqual(['assistant-error']);
  });

  test('keeps an assistant error when it is still the current leaf', () => {
    const tree = linearizeRetryRecoveryTreeForDisplay(
      [
        {
          entry: { id: 'toolresult-1', parentId: null, type: 'message' },
          children: [
            {
              entry: {
                id: 'assistant-error',
                parentId: 'toolresult-1',
                type: 'message',
                message: {
                  role: 'assistant',
                  stopReason: 'error',
                  errorMessage: 'Internal server error',
                },
              },
              children: [],
            },
            {
              entry: {
                id: 'assistant-success',
                parentId: 'toolresult-1',
                type: 'message',
                message: { role: 'assistant', stopReason: 'toolUse' },
              },
              children: [],
            },
          ],
        },
      ],
      'assistant-error',
    );

    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((c) => c.entry.id)).toEqual([
      'assistant-error',
      'assistant-success',
    ]);
  });

  test('keeps both assistant errors when neither sibling recovered the chain', () => {
    const tree = linearizeRetryRecoveryTreeForDisplay(
      [
        {
          entry: { id: 'toolresult-1', parentId: null, type: 'message' },
          children: [
            {
              entry: {
                id: 'error-1',
                parentId: 'toolresult-1',
                type: 'message',
                message: { role: 'assistant', stopReason: 'error' },
              },
              children: [],
            },
            {
              entry: {
                id: 'error-2',
                parentId: 'toolresult-1',
                type: 'message',
                message: { role: 'assistant', stopReason: 'error' },
              },
              children: [],
            },
          ],
        },
      ],
      'error-2',
    );

    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((c) => c.entry.id)).toEqual(['error-1', 'error-2']);
  });
});

describe('pi-retry extension runtime', () => {
  test('registers a retry slash command', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    expect(harness.commands.has('retry')).toBe(true);
  });

  test('retry command waits for idle, confirms retryable leaf recovery, and sends Continue on confirm', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    harness.ctx.sessionManager.getLeafId = () => 'assistant-empty-1';
    harness.ctx.sessionManager.getEntries = () => [
      {
        id: 'user-1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        id: 'assistant-empty-1',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'thinking', thinking: 'Need to inspect sample code more closely.' }],
        },
      },
    ];
    harness.ctx.ui.confirm = vi.fn().mockResolvedValue(true);

    const retryCommand = harness.commands.get('retry');
    if (!retryCommand) {
      throw new Error('Missing retry command');
    }

    await retryCommand.handler('', harness.ctx);

    expect(harness.ctx.waitForIdle).toHaveBeenCalledTimes(1);
    expect(harness.ctx.ui.confirm).toHaveBeenCalled();
    expect(harness.sendUserMessageCalls).toEqual([]);
    expect(harness.sendMessageCalls).toEqual([
      {
        message: expect.objectContaining({
          customType: 'pi-retry-recovery',
          content: 'Continue.',
          display: false,
          details: {
            version: 1,
            displayHint: 'linear-replacement',
            kind: 'empty-stop',
            messageKind: 'continue',
            attempt: 1,
            expectedLeafId: 'user-1',
            replacement: {
              supersedesEntryId: 'assistant-empty-1',
              parentEntryId: 'user-1',
            },
          },
        }),
        options: { triggerTurn: true },
      },
    ]);
  });

  test('message_end rewrites empty OpenAI Responses stops before persistence', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    const messageEnd = getHandler(harness.handlers, 'message_end');

    const result = await messageEnd(
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          api: 'openai-responses',
          provider: 'devai',
          model: 'gpt-5.6-sol',
          stopReason: 'stop',
          content: [{ type: 'thinking', thinking: '', thinkingSignature: '{"id":"rs_1"}' }],
        },
      },
      harness.ctx,
    );

    expect(result).toEqual({
      message: expect.objectContaining({
        role: 'assistant',
        stopReason: 'error',
        errorMessage:
          'Model produced invalid content: response.completed contained no assistant text or function calls',
      }),
    });
  });

  test('marks terminating tool results before persistence', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    const toolExecutionEnd = getHandler(harness.handlers, 'tool_execution_end');
    await toolExecutionEnd(
      {
        type: 'tool_execution_end',
        toolCallId: 'call_done|provider-id-1',
        toolName: 'done',
        result: { content: [{ type: 'text', text: 'done' }], terminate: true },
        isError: false,
      },
      harness.ctx,
    );

    const messageEnd = getHandler(harness.handlers, 'message_end');
    const result = await (messageEnd as any)(
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'call_done|provider-id-1',
          toolName: 'done',
          content: [{ type: 'text', text: 'done' }],
          isError: false,
        },
      },
      harness.ctx,
    );

    expect(result).toEqual({
      message: expect.objectContaining({
        role: 'toolResult',
        toolCallId: 'call_done|provider-id-1',
        piRetry: { terminate: true },
      }),
    });
  });

  test('retry command confirms and continues from a stranded tool-result leaf', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    harness.ctx.sessionManager.getLeafId = () => 'tool-result-grep';
    harness.ctx.sessionManager.getEntries = () => [
      {
        id: 'user-1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        id: 'assistant-tool-use',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [
            { type: 'text', text: 'I’ll inspect this.' },
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
        },
      },
      {
        id: 'tool-result-grep',
        parentId: 'tool-result-read',
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'call_grep|provider-id-2',
          content: [{ type: 'text', text: 'grep output' }],
        },
      },
    ];
    harness.ctx.ui.confirm = vi.fn().mockResolvedValue(true);

    const retryCommand = harness.commands.get('retry');
    if (!retryCommand) {
      throw new Error('Missing retry command');
    }

    await retryCommand.handler('', harness.ctx);

    expect(harness.ctx.ui.confirm).toHaveBeenCalledWith(
      'pi-retry: Stranded tool results detected',
      'This session appears to have stopped after tool results were returned. Send Continue now?',
    );
    expect(harness.sendMessageCalls).toEqual([
      {
        message: expect.objectContaining({
          customType: 'pi-retry-recovery',
          content: 'Continue.',
          display: false,
          details: {
            version: 1,
            displayHint: 'linear-replacement',
            kind: 'stranded-tool-results',
            messageKind: 'continue',
            attempt: 1,
            expectedLeafId: 'tool-result-grep',
          },
        }),
        options: { triggerTurn: true },
      },
    ]);
  });

  test('retry command does not treat an aborted leaf as retryable', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    harness.ctx.sessionManager.getLeafId = () => 'assistant-aborted-1';
    harness.ctx.sessionManager.getEntries = () => [
      {
        id: 'user-1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        id: 'assistant-aborted-1',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'aborted',
          errorMessage: 'Operation aborted',
          usage: { input: 0, output: 0, total: 0 },
          content: [{ type: 'thinking', thinking: 'Need to inspect sample code more closely.' }],
        },
      },
    ];
    harness.ctx.ui.confirm = vi.fn().mockResolvedValue(true);

    const retryCommand = harness.commands.get('retry');
    if (!retryCommand) {
      throw new Error('Missing retry command');
    }

    await retryCommand.handler('', harness.ctx);

    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(harness.notifyCalls).toContainEqual({
      message: 'pi-retry: current leaf is not retryable',
      type: 'info',
    });
    expect(harness.sendUserMessageCalls).toEqual([]);
  });

  test('retry command notifies when the current leaf is not retryable', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    harness.ctx.sessionManager.getLeafId = () => 'assistant-ok-1';
    harness.ctx.sessionManager.getEntries = () => [
      {
        id: 'user-1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        id: 'assistant-ok-1',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'All done.' }],
        },
      },
    ];

    const retryCommand = harness.commands.get('retry');
    if (!retryCommand) {
      throw new Error('Missing retry command');
    }

    await retryCommand.handler('', harness.ctx);

    expect(harness.notifyCalls).toContainEqual({
      message: 'pi-retry: current leaf is not retryable',
      type: 'info',
    });
    expect(harness.sendUserMessageCalls).toEqual([]);
  });
  test('does not register the deprecated session_switch handler in 0.65+', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    expect(harness.handlers.has('session_switch')).toBe(false);
  });

  test('session_start does not auto-recover stranded tool results inside subagent children', async () => {
    process.env.PI_SUBAGENT_CHILD = '1';
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    harness.ctx.sessionManager.getLeafId = () => 'tool-result-read';
    harness.ctx.sessionManager.getEntries = () => [
      {
        id: 'user-1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        id: 'assistant-tool-use',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'call_read|provider-id-1', name: 'read' }],
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
        },
      },
    ];
    harness.ctx.ui.confirm = vi.fn().mockResolvedValue(true);

    await getHandler(harness.handlers, 'session_start')(
      { type: 'session_start', reason: 'startup' },
      harness.ctx,
    );

    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(harness.sendMessageCalls).toEqual([]);
  });

  test('session_start does not auto-recover stranded tool results without UI', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    harness.ctx.hasUI = false;
    harness.ctx.sessionManager.getLeafId = () => 'tool-result-read';
    harness.ctx.sessionManager.getEntries = () => [
      {
        id: 'user-1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        id: 'assistant-tool-use',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'call_read|provider-id-1', name: 'read' }],
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
        },
      },
    ];
    harness.ctx.ui.confirm = vi.fn().mockResolvedValue(true);

    await getHandler(harness.handlers, 'session_start')(
      { type: 'session_start', reason: 'startup' },
      harness.ctx,
    );

    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(harness.sendMessageCalls).toEqual([]);
  });

  test('clears bound status and unregisters the patched session on session shutdown', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    const unregisterPatchedSessionSpy = vi.spyOn(runtime, 'unregisterPatchedSession');

    await getHandler(harness.handlers, 'session_start')({ type: 'session_start' }, harness.ctx);
    await getHandler(harness.handlers, 'session_shutdown')(
      { type: 'session_shutdown' },
      harness.ctx,
    );

    expect(harness.statusCalls).toEqual([{ key: 'pi-retry', text: undefined }]);
    expect(unregisterPatchedSessionSpy).toHaveBeenCalledWith('session-1');
  });

  test('shows the compatibility warning only once when patching fails', async () => {
    const harness = await createExtensionHarness(async () => ({ AgentSession: undefined }));

    await getHandler(harness.handlers, 'session_start')({ type: 'session_start' }, harness.ctx);
    await getHandler(harness.handlers, 'agent_start')({ type: 'agent_start' }, harness.ctx);

    expect(harness.notifyCalls).toEqual([
      {
        message: 'pi-retry disabled: AgentSession export not found',
        type: 'warning',
      },
    ]);
  });

  test('turn_end dispatches sanitizer-owned encrypted-content recovery immediately', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    let leafId = 'assistant-error-1';
    const branchSpy = vi.fn((nextLeaf: string) => {
      leafId = nextLeaf;
    });

    (harness.ctx.sessionManager as any).branch = branchSpy;
    (harness.ctx.sessionManager as any).getLeafId = () => leafId;
    (harness.ctx.sessionManager as any).getEntries = () => [
      { id: 'user-1', type: 'message', message: { role: 'user' } },
      {
        id: 'assistant-error-1',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: ENCRYPTED_CONTENT_ERROR,
          content: [],
        },
      },
    ];

    await getHandler(harness.handlers, 'turn_end')(
      {
        type: 'turn_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: ENCRYPTED_CONTENT_ERROR,
          content: [],
        },
        toolResults: [],
      },
      harness.ctx,
    );

    expect(branchSpy).toHaveBeenCalledWith('user-1');
    expect(harness.sendMessageCalls).toEqual([
      {
        message: expect.objectContaining({
          customType: 'pi-retry-recovery',
          content: 'Continue.',
          display: false,
          details: expect.objectContaining({
            kind: 'retryable-error',
            messageKind: 'continue',
            attempt: 1,
            expectedLeafId: 'user-1',
            replacement: {
              supersedesEntryId: 'assistant-error-1',
              parentEntryId: 'user-1',
            },
          }),
        }),
        options: { triggerTurn: true },
      },
    ]);
  });

  test('agent_end is a no-op when no retry status is currently shown', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    await getHandler(harness.handlers, 'session_start')({ type: 'session_start' }, harness.ctx);

    await getHandler(harness.handlers, 'agent_end')(
      {
        type: 'agent_end',
        messages: [{ role: 'assistant', stopReason: 'stop', content: [] }],
      },
      harness.ctx,
    );

    // No setStatus calls should have happened from the agent_end handler.
    expect(harness.statusCalls).toEqual([]);
  });

  test('agent_end branches the failed leaf out of main path for retryable errors', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    const branchSpy = vi.fn();
    (harness.ctx.sessionManager as any).branch = branchSpy;
    (harness.ctx.sessionManager as any).getLeafId = () => 'assistant-error-1';
    (harness.ctx.sessionManager as any).getEntries = () => [
      { id: 'user-1', type: 'message', message: { role: 'user' } },
      {
        id: 'assistant-error-1',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'overloaded_error',
        },
      },
    ];

    await getHandler(harness.handlers, 'agent_end')(
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'overloaded_error',
            content: [],
          },
        ],
      },
      harness.ctx,
    );

    expect(branchSpy).toHaveBeenCalledWith('user-1');
  });

  test('agent_end does not branch when the final assistant error is not retryable', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    const branchSpy = vi.fn();
    (harness.ctx.sessionManager as any).branch = branchSpy;
    (harness.ctx.sessionManager as any).getLeafId = () => 'assistant-error-1';
    (harness.ctx.sessionManager as any).getEntries = () => [
      { id: 'user-1', type: 'message', message: { role: 'user' } },
      {
        id: 'assistant-error-1',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'context window exceeded',
        },
      },
    ];

    await getHandler(harness.handlers, 'agent_end')(
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'context window exceeded',
            content: [],
          },
        ],
      },
      harness.ctx,
    );

    expect(branchSpy).not.toHaveBeenCalled();
  });

  test('interactive input resets refusal recovery state and clears the current session status', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    runtime.setRefusalAttempt('session-1', 1);

    await getHandler(harness.handlers, 'input')(
      { type: 'input', text: 'new prompt', source: 'interactive' },
      harness.ctx,
    );

    expect(runtime.getRefusalAttempt('session-1')).toBe(0);
    expect(harness.statusCalls).toEqual([{ key: 'pi-retry', text: undefined }]);
  });

  test('aborting an in-progress run clears queued recovery so agent_end does not send a delayed follow-up', async () => {
    vi.useFakeTimers();

    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    const controller = new AbortController();

    harness.ctx.signal = controller.signal;
    harness.ctx.isIdle = () => false;

    await getHandler(harness.handlers, 'agent_start')({ type: 'agent_start' }, harness.ctx);

    (runtime as any).setPendingRecovery?.('session-1', {
      kind: 'refusal',
      message: 'Continue.',
    });

    controller.abort();

    harness.ctx.isIdle = () => true;
    await getHandler(harness.handlers, 'agent_end')(
      { type: 'agent_end', messages: [] },
      harness.ctx,
    );
    await vi.runAllTimersAsync();

    expect(harness.sendUserMessageCalls).toEqual([]);
  });

  test('aborting an in-progress run also clears abort listener bookkeeping immediately', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    const controller = new AbortController();

    harness.ctx.signal = controller.signal;

    await getHandler(harness.handlers, 'before_agent_start')(
      { type: 'before_agent_start' },
      harness.ctx,
    );

    expect(getAbortListenerBindingCount()).toBe(1);

    controller.abort();

    expect(getAbortListenerBindingCount()).toBe(0);
  });

  test('turn_end leaves terminal stop recovery to the post-run fallback path', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    const handleRefusalRecoverySpy = vi
      .spyOn(runtime, 'handleRefusalRecovery')
      .mockResolvedValue(undefined);

    await getHandler(harness.handlers, 'session_start')({ type: 'session_start' }, harness.ctx);

    await getHandler(harness.handlers, 'turn_end')(
      {
        type: 'turn_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: "I'm sorry, but I cannot assist with that request." }],
        },
        toolResults: [],
      },
      harness.ctx,
    );

    expect(handleRefusalRecoverySpy).not.toHaveBeenCalled();
    expect(harness.sendMessageCalls).toEqual([]);
    expect(harness.sendUserMessageCalls).toEqual([]);
  });

  test('agent_end dispatches terminal refusal fallback only after idle with no pending messages', async () => {
    vi.useFakeTimers();

    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    let leafId = 'assistant-refusal-1';
    let hasPendingMessages = true;

    harness.ctx.isIdle = () => true;
    harness.ctx.hasPendingMessages = () => hasPendingMessages;
    harness.ctx.sessionManager.branch = vi.fn((nextLeafId: string) => {
      leafId = nextLeafId;
    });
    harness.ctx.sessionManager.getLeafId = () => leafId;
    harness.ctx.sessionManager.getEntries = () => [
      {
        id: 'user-1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        id: 'assistant-refusal-1',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: "I'm sorry, but I cannot assist with that request." }],
        },
      },
    ];

    await getHandler(harness.handlers, 'agent_end')(
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'text', text: "I'm sorry, but I cannot assist with that request." }],
          },
        ],
      },
      harness.ctx,
    );

    await vi.runOnlyPendingTimersAsync();
    expect(harness.sendMessageCalls).toEqual([]);

    hasPendingMessages = false;
    await vi.runAllTimersAsync();

    expect(harness.ctx.sessionManager.branch).toHaveBeenCalledWith('user-1');
    expect(harness.sendMessageCalls).toEqual([
      {
        message: expect.objectContaining({
          customType: 'pi-retry-recovery',
          display: false,
          details: expect.objectContaining({
            version: 1,
            displayHint: 'linear-replacement',
            kind: 'refusal',
            messageKind: 'continue',
            attempt: 1,
            expectedLeafId: 'user-1',
            replacement: {
              supersedesEntryId: 'assistant-refusal-1',
              parentEntryId: 'user-1',
            },
          }),
        }),
        options: { triggerTurn: true },
      },
    ]);
  });

  test('agent_end sends premature-abandonment recovery as a visible user message', async () => {
    vi.useFakeTimers();

    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    let leafId = 'assistant-abandonment-1';

    harness.ctx.isIdle = () => true;
    harness.ctx.hasPendingMessages = () => false;
    harness.ctx.sessionManager.branch = vi.fn((nextLeafId: string) => {
      leafId = nextLeafId;
    });
    harness.ctx.sessionManager.getLeafId = () => leafId;
    harness.ctx.sessionManager.getEntries = () => [
      {
        id: 'user-1',
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
          content: [{ type: 'text', text: 'I’m sorry, but I couldn’t complete the work.' }],
        },
      },
    ];

    await getHandler(harness.handlers, 'agent_end')(
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'text', text: 'I’m sorry, but I couldn’t complete the work.' }],
          },
        ],
      },
      harness.ctx,
    );

    await vi.runAllTimersAsync();

    expect(harness.ctx.sessionManager.branch).not.toHaveBeenCalled();
    expect(harness.sendUserMessageCalls).toEqual([
      { content: runtime.PREMATURE_ABANDONMENT_CONTINUE_MESSAGE, options: undefined },
    ]);
    expect(harness.sendMessageCalls).toEqual([]);
  });

  test('auto-continues an interrupted unexecuted Responses tool call once', async () => {
    vi.useFakeTimers();

    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    let leafId = 'assistant-interrupted-1';

    harness.ctx.isIdle = () => true;
    harness.ctx.hasPendingMessages = () => false;
    harness.ctx.sessionManager.branch = vi.fn((nextLeafId: string) => {
      leafId = nextLeafId;
    });
    harness.ctx.sessionManager.getLeafId = () => leafId;
    const message = {
      role: 'assistant',
      api: 'openai-responses',
      stopReason: 'error',
      errorMessage: 'OpenAI Responses SSE ended before a terminal event',
      usage: { input: 0, output: 0, totalTokens: 0 },
      content: [
        { type: 'thinking', thinking: '' },
        {
          type: 'toolCall',
          id: 'call_exec|fc_1',
          name: 'exec_command',
          arguments: { cmd: 'git status --short' },
        },
      ],
    };
    harness.ctx.sessionManager.getEntries = () => [
      { id: 'user-1', type: 'message', message: { role: 'user' } },
      {
        id: 'assistant-interrupted-1',
        parentId: 'user-1',
        type: 'message',
        message,
      },
    ];

    await getHandler(harness.handlers, 'turn_end')(
      { type: 'turn_end', message, toolResults: [] },
      harness.ctx,
    );

    expect(harness.ctx.sessionManager.branch).toHaveBeenCalledWith('user-1');
    expect(harness.statusCalls).toContainEqual({
      key: 'pi-retry',
      text: '↻ Interrupted tool-call response detected; continuing in this session...',
    });

    await getHandler(harness.handlers, 'agent_end')(
      { type: 'agent_end', willRetry: false, messages: [message] },
      harness.ctx,
    );
    await vi.runAllTimersAsync();

    expect(harness.sendMessageCalls).toEqual([
      {
        message: {
          customType: 'pi-retry-recovery',
          content: runtime.INTERRUPTED_TOOL_CALL_CONTINUE_MESSAGE,
          display: false,
          details: {
            version: 1,
            displayHint: 'linear-replacement',
            kind: 'interrupted-tool-call',
            messageKind: 'continue',
            attempt: 1,
            expectedLeafId: 'user-1',
            replacement: {
              supersedesEntryId: 'assistant-interrupted-1',
              parentEntryId: 'user-1',
            },
          },
        },
        options: { triggerTurn: true },
      },
    ]);

    leafId = 'assistant-interrupted-2';
    await getHandler(harness.handlers, 'message_end')(
      { type: 'message_end', message },
      harness.ctx,
    );
    await getHandler(harness.handlers, 'turn_end')(
      { type: 'turn_end', message, toolResults: [] },
      harness.ctx,
    );

    expect(harness.notifyCalls).toContainEqual({
      message: 'pi-retry stopped interrupted tool-call recovery after one attempt',
      type: 'warning',
    });
    expect(harness.sendMessageCalls).toHaveLength(1);
  });

  test('turn_end queues replay-safe websocket transport fallback as retryable error', async () => {
    vi.useFakeTimers();

    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    let leafId = 'assistant-ws-error-1';

    harness.ctx.isIdle = () => true;
    harness.ctx.hasPendingMessages = () => false;
    harness.ctx.sessionManager.branch = vi.fn((nextLeafId: string) => {
      leafId = nextLeafId;
    });
    harness.ctx.sessionManager.getLeafId = () => leafId;
    harness.ctx.sessionManager.getEntries = () => [
      {
        id: 'user-1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        id: 'assistant-ws-error-1',
        parentId: 'user-1',
        type: 'message',
        message: makeAssistantErrorMessage('WebSocket closed before response.completed code=1006', {
          api: 'openai-websocket-responses',
          diagnostics: [REPLAY_SAFE_WS_TRANSPORT_DIAGNOSTIC],
        }),
      },
    ];

    const message = makeAssistantErrorMessage(
      'WebSocket closed before response.completed code=1006',
      {
        api: 'openai-websocket-responses',
        diagnostics: [REPLAY_SAFE_WS_TRANSPORT_DIAGNOSTIC],
      },
    );

    await getHandler(harness.handlers, 'turn_end')(
      {
        type: 'turn_end',
        message,
        toolResults: [],
      },
      harness.ctx,
    );

    expect(harness.ctx.sessionManager.branch).toHaveBeenCalledWith('user-1');
    expect(harness.sendMessageCalls).toEqual([]);

    await getHandler(harness.handlers, 'agent_end')(
      {
        type: 'agent_end',
        willRetry: false,
        messages: [message],
      },
      harness.ctx,
    );

    await vi.runAllTimersAsync();

    expect(harness.sendMessageCalls).toEqual([
      {
        message: expect.objectContaining({
          customType: 'pi-retry-recovery',
          display: false,
          details: expect.objectContaining({
            kind: 'retryable-error',
            messageKind: 'continue',
            attempt: 1,
            expectedLeafId: 'user-1',
            replacement: {
              supersedesEntryId: 'assistant-ws-error-1',
              parentEntryId: 'user-1',
            },
          }),
        }),
        options: { triggerTurn: true },
      },
    ]);
  });

  test('agent_end cancels terminal fallback if another extension advances the leaf first', async () => {
    vi.useFakeTimers();

    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    let leafId = 'assistant-empty-1';

    harness.ctx.isIdle = () => true;
    harness.ctx.hasPendingMessages = () => false;
    harness.ctx.sessionManager.branch = vi.fn((nextLeafId: string) => {
      leafId = nextLeafId;
    });
    harness.ctx.sessionManager.getLeafId = () => leafId;
    harness.ctx.sessionManager.getEntries = () => [
      {
        id: 'user-1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        id: 'assistant-empty-1',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'thinking', thinking: 'Need to inspect sample code more closely.' }],
        },
      },
      {
        id: 'other-extension-recovery',
        parentId: 'assistant-empty-1',
        type: 'custom',
        customType: 'other-extension-recovery',
        data: { queued: true },
      },
    ];

    await getHandler(harness.handlers, 'agent_end')(
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            stopReason: 'stop',
            content: [{ type: 'thinking', thinking: 'Need to inspect sample code more closely.' }],
          },
        ],
      },
      harness.ctx,
    );

    leafId = 'other-extension-recovery';
    await vi.runAllTimersAsync();

    expect(harness.ctx.sessionManager.branch).not.toHaveBeenCalled();
    expect(harness.sendMessageCalls).toEqual([]);
  });

  test('turn_end dispatches retryable provider errors immediately in headless sessions', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    harness.ctx.hasUI = false;

    const handleRefusalRecoverySpy = vi
      .spyOn(runtime, 'handleRefusalRecovery')
      .mockResolvedValue(undefined);

    await getHandler(harness.handlers, 'turn_end')(
      {
        type: 'turn_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage:
            '400 The encrypted content for item rs_123 could not be verified. Reason: Encrypted content could not be decrypted or parsed.',
          content: [],
        },
        toolResults: [],
      },
      harness.ctx,
    );

    expect(handleRefusalRecoverySpy).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchMode: 'immediate' }),
    );
  });

  test('agent_end dispatches a pending recovery once the session becomes idle', async () => {
    vi.useFakeTimers();

    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    harness.ctx.isIdle = () => false;
    (runtime as any).setPendingRecovery?.('session-1', {
      kind: 'empty-stop',
      message: 'Continue.',
    });

    await getHandler(harness.handlers, 'agent_end')(
      { type: 'agent_end', messages: [] },
      harness.ctx,
    );

    expect(harness.sendUserMessageCalls).toEqual([]);
    expect(harness.sendMessageCalls).toEqual([]);

    await vi.runOnlyPendingTimersAsync();
    expect(harness.sendMessageCalls).toEqual([]);

    harness.ctx.isIdle = () => true;
    await vi.runAllTimersAsync();

    expect(harness.sendUserMessageCalls).toEqual([]);
    expect(harness.sendMessageCalls).toEqual([
      {
        message: { customType: 'pi-retry-recovery', content: 'Continue.', display: false },
        options: { triggerTurn: true },
      },
    ]);
  });

  test('successful threshold compaction after length truncation queues continuation on compaction leaf', async () => {
    vi.useFakeTimers();

    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    let leafId = 'assistant-length';
    harness.ctx.sessionManager.getLeafId = () => leafId;

    await getHandler(harness.handlers, 'turn_end')(
      {
        type: 'turn_end',
        message: {
          role: 'assistant',
          stopReason: 'length',
          content: [{ type: 'thinking', thinking: '' }],
        },
        toolResults: [],
      },
      harness.ctx,
    );

    expect(harness.sendMessageCalls).toEqual([]);

    leafId = 'compaction-1';
    await getHandler(harness.handlers, 'session_compact')(
      {
        type: 'session_compact',
        compactionEntry: { id: 'compaction-1' },
      },
      harness.ctx,
    );
    await vi.runAllTimersAsync();

    expect(harness.sendMessageCalls).toEqual([
      {
        message: {
          customType: 'pi-retry-recovery',
          content: 'Continue from where you were cut off. Do not repeat prior content.',
          display: false,
          details: {
            version: 1,
            displayHint: 'linear-replacement',
            kind: 'length-truncated',
            messageKind: 'continue',
            attempt: 1,
            expectedLeafId: 'compaction-1',
            replacement: {
              supersedesEntryId: 'assistant-length',
              parentEntryId: 'compaction-1',
            },
          },
        },
        options: { triggerTurn: true },
      },
    ]);
    expect(harness.statusCalls).toContainEqual({
      key: 'pi-retry',
      text: '↻ Length-truncated response detected; continuing after compaction...',
    });
  });

  test('agent_end queues recovery when the session strands after returned tool results', async () => {
    vi.useFakeTimers();

    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    harness.ctx.isIdle = () => false;
    harness.ctx.sessionManager.getLeafId = () => 'tool-result-grep';
    harness.ctx.sessionManager.getEntries = () => [
      {
        id: 'user-1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        id: 'assistant-tool-use',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [
            { type: 'text', text: 'I’ll inspect this.' },
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
        },
      },
      {
        id: 'tool-result-grep',
        parentId: 'tool-result-read',
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'call_grep|provider-id-2',
          content: [{ type: 'text', text: 'grep output' }],
        },
      },
    ];

    await getHandler(harness.handlers, 'agent_end')(
      { type: 'agent_end', messages: [] },
      harness.ctx,
    );

    expect(harness.sendMessageCalls).toEqual([]);
    expect(harness.statusCalls).toEqual([]);

    harness.ctx.isIdle = () => true;
    await vi.runAllTimersAsync();

    expect(harness.statusCalls).toContainEqual({
      key: 'pi-retry',
      text: '↻ Stranded tool results detected; retrying with Continue...',
    });

    expect(harness.sendMessageCalls).toEqual([
      {
        message: {
          customType: 'pi-retry-recovery',
          content: 'Continue.',
          display: false,
          details: {
            version: 1,
            displayHint: 'linear-replacement',
            kind: 'stranded-tool-results',
            messageKind: 'continue',
            attempt: 1,
            expectedLeafId: 'tool-result-grep',
          },
        },
        options: { triggerTurn: true },
      },
    ]);
  });

  test('agent_end does not queue stranded tool-result recovery when recovery is disabled', async () => {
    vi.useFakeTimers();

    process.env.PI_RETRY_REFUSAL_RECOVERY_DISABLED = '1';
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    harness.ctx.sessionManager.getLeafId = () => 'tool-result-read';
    harness.ctx.sessionManager.getEntries = () => [
      {
        id: 'user-1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        id: 'assistant-tool-use',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'call_read|provider-id-1', name: 'read' }],
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
        },
      },
    ];

    await getHandler(harness.handlers, 'agent_end')(
      { type: 'agent_end', messages: [] },
      harness.ctx,
    );
    await vi.runAllTimersAsync();

    expect(harness.statusCalls).toEqual([]);
    expect(harness.sendMessageCalls).toEqual([]);
  });

  test.each([
    'overloaded_error',
    'getaddrinfo ENOTFOUND api.example.com',
    'getaddrinfo EAI_AGAIN api.example.com',
  ])('agent_end clears extension recovery when core will retry: %s', async (errorMessage) => {
    vi.useFakeTimers();

    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    const branchSpy = vi.fn();

    harness.ctx.isIdle = () => true;
    harness.ctx.sessionManager.branch = branchSpy;
    harness.ctx.sessionManager.getLeafId = () => 'assistant-error-1';
    harness.ctx.sessionManager.getEntries = () => [
      { id: 'user-1', type: 'message', message: { role: 'user' } },
      {
        id: 'assistant-error-1',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage,
        },
      },
    ];
    (runtime as any).setPendingRecovery?.('session-1', {
      kind: 'retryable-error',
      message: 'Continue.',
    });
    harness.ctx.ui.setStatus('pi-retry', '↻ Retryable error detected; retrying with Continue...');

    await getHandler(harness.handlers, 'agent_end')(
      {
        type: 'agent_end',
        willRetry: true,
        messages: [
          {
            role: 'assistant',
            stopReason: 'error',
            errorMessage,
            content: [],
          },
        ],
      },
      harness.ctx,
    );
    await vi.runAllTimersAsync();

    expect(harness.sendMessageCalls).toEqual([]);
    expect(harness.statusCalls.at(-1)).toEqual({ key: 'pi-retry', text: undefined });
    expect(branchSpy).toHaveBeenCalledWith('user-1');
  });

  test('agent_end infers core retry for retryable provider errors without willRetry', async () => {
    vi.useFakeTimers();

    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    const branchSpy = vi.fn();

    harness.ctx.isIdle = () => true;
    harness.ctx.sessionManager.branch = branchSpy;
    harness.ctx.sessionManager.getLeafId = () => 'assistant-error-1';
    harness.ctx.sessionManager.getEntries = () => [
      { id: 'user-1', type: 'message', message: { role: 'user' } },
      {
        id: 'assistant-error-1',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'Unknown error (no error details in response)',
        },
      },
    ];
    (runtime as any).setPendingRecovery?.('session-1', {
      kind: 'retryable-error',
      message: 'Continue.',
    });
    harness.ctx.ui.setStatus('pi-retry', '↻ Retryable error detected; retrying with Continue...');

    await getHandler(harness.handlers, 'agent_end')(
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'Unknown error (no error details in response)',
            content: [],
          },
        ],
      },
      harness.ctx,
    );
    await vi.runAllTimersAsync();

    expect(harness.sendMessageCalls).toEqual([]);
    expect(harness.statusCalls.at(-1)).toEqual({ key: 'pi-retry', text: undefined });
    expect(branchSpy).toHaveBeenCalledWith('user-1');
  });

  test('agent_end post-idle dispatch replaces queued status with waiting status', async () => {
    vi.useFakeTimers();

    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    harness.ctx.isIdle = () => false;
    (runtime as any).setPendingRecovery?.('session-1', {
      kind: 'refusal',
      message: 'Continue.',
    });
    harness.ctx.ui.setStatus('pi-retry', '↻ Refusal detected; retrying with Continue...');

    await getHandler(harness.handlers, 'agent_end')(
      { type: 'agent_end', messages: [] },
      harness.ctx,
    );

    harness.ctx.isIdle = () => true;
    await vi.runAllTimersAsync();

    expect(harness.sendUserMessageCalls).toEqual([]);
    expect(harness.sendMessageCalls).toEqual([
      {
        message: { customType: 'pi-retry-recovery', content: 'Continue.', display: false },
        options: { triggerTurn: true },
      },
    ]);
    expect(harness.statusCalls).toContainEqual({
      key: 'pi-retry',
      text: '↻ Continue sent; waiting for recovery...',
    });
  });

  test('message_end replaces sent recovery status once assistant output resumes', async () => {
    vi.useFakeTimers();

    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    harness.ctx.isIdle = () => false;
    (runtime as any).setPendingRecovery?.('session-1', {
      kind: 'refusal',
      message: 'Continue.',
    });
    harness.ctx.ui.setStatus('pi-retry', '↻ Refusal detected; retrying with Continue...');

    await getHandler(harness.handlers, 'agent_end')(
      { type: 'agent_end', messages: [] },
      harness.ctx,
    );

    harness.ctx.isIdle = () => true;
    await vi.runAllTimersAsync();

    expect(harness.statusCalls).toContainEqual({
      key: 'pi-retry',
      text: '↻ Continue sent; waiting for recovery...',
    });

    await getHandler(harness.handlers, 'message_end')(
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: '.' } }],
        },
      },
      harness.ctx,
    );

    expect(harness.statusCalls.at(-1)).toEqual({
      key: 'pi-retry',
      text: '✓ Recovered; continuing...',
    });

    await vi.advanceTimersByTimeAsync(4000);

    expect(harness.statusCalls.at(-1)).toEqual({
      key: 'pi-retry',
      text: undefined,
    });
  });

  test('session_start on resume prompts for an empty-stop recovery and sends Continue on confirm', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    harness.ctx.sessionManager.getLeafId = () => 'assistant-empty-1';
    harness.ctx.sessionManager.getEntries = () => [
      {
        id: 'user-1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        id: 'assistant-empty-1',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'thinking', thinking: 'Need to inspect sample code more closely.' }],
        },
      },
    ];
    harness.ctx.ui.confirm = vi.fn().mockResolvedValue(true);

    await getHandler(harness.handlers, 'session_start')(
      {
        type: 'session_start',
        reason: 'resume',
        previousSessionFile: '/tmp/previous-session.jsonl',
      },
      harness.ctx,
    );

    expect(harness.ctx.ui.confirm).toHaveBeenCalled();
    expect(harness.sendUserMessageCalls).toEqual([]);
    expect(harness.sendMessageCalls).toEqual([
      {
        message: expect.objectContaining({
          customType: 'pi-retry-recovery',
          content: 'Continue.',
          display: false,
          details: {
            version: 1,
            displayHint: 'linear-replacement',
            kind: 'empty-stop',
            messageKind: 'continue',
            attempt: 1,
            expectedLeafId: 'user-1',
            replacement: {
              supersedesEntryId: 'assistant-empty-1',
              parentEntryId: 'user-1',
            },
          },
        }),
        options: { triggerTurn: true },
      },
    ]);
  });

  test('session_start on resume does not prompt for an aborted leaf', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    harness.ctx.sessionManager.getLeafId = () => 'assistant-aborted-1';
    harness.ctx.sessionManager.getEntries = () => [
      {
        id: 'user-1',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        id: 'assistant-aborted-1',
        parentId: 'user-1',
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'aborted',
          errorMessage: 'Operation aborted',
          usage: { input: 0, output: 0, total: 0 },
          content: [{ type: 'thinking', thinking: 'Need to inspect sample code more closely.' }],
        },
      },
    ];
    harness.ctx.ui.confirm = vi.fn().mockResolvedValue(true);

    await getHandler(harness.handlers, 'session_start')(
      {
        type: 'session_start',
        reason: 'resume',
        previousSessionFile: '/tmp/previous-session.jsonl',
      },
      harness.ctx,
    );

    expect(harness.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(harness.sendUserMessageCalls).toEqual([]);
  });

  test('turn_end leaves empty-stop turns with tool results for post-run fallback', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    const handleRefusalRecoverySpy = vi
      .spyOn(runtime, 'handleRefusalRecovery')
      .mockResolvedValue(undefined);

    await getHandler(harness.handlers, 'turn_end')(
      {
        type: 'turn_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'thinking', thinking: 'Need to inspect more closely.' }],
        },
        toolResults: [{ role: 'toolResult', content: [{ type: 'text', text: 'done' }] }],
      },
      harness.ctx,
    );

    expect(handleRefusalRecoverySpy).not.toHaveBeenCalled();
  });

  test('turn_end ignores visible assistant turns that still have tool results', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    const handleRefusalRecoverySpy = vi
      .spyOn(runtime, 'handleRefusalRecovery')
      .mockResolvedValue(undefined);

    await getHandler(harness.handlers, 'turn_end')(
      {
        type: 'turn_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: "I'm sorry, but I cannot assist with that request." }],
        },
        toolResults: [{ role: 'toolResult', content: [{ type: 'text', text: 'still working' }] }],
      },
      harness.ctx,
    );

    expect(handleRefusalRecoverySpy).not.toHaveBeenCalled();
  });

  test('turn_end ignores terminal stop turns when there are already pending queued messages', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    harness.ctx.hasPendingMessages = () => true;

    const handleRefusalRecoverySpy = vi
      .spyOn(runtime, 'handleRefusalRecovery')
      .mockResolvedValue(undefined);

    await getHandler(harness.handlers, 'turn_end')(
      {
        type: 'turn_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: "I'm sorry, but I cannot assist with that request." }],
        },
        toolResults: [],
      },
      harness.ctx,
    );

    expect(handleRefusalRecoverySpy).not.toHaveBeenCalled();
  });

  test('refusal recovery can be disabled with PI_RETRY_REFUSAL_RECOVERY_DISABLED', async () => {
    process.env.PI_RETRY_REFUSAL_RECOVERY_DISABLED = '1';

    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    const handleRefusalRecoverySpy = vi
      .spyOn(runtime, 'handleRefusalRecovery')
      .mockResolvedValue(undefined);

    await getHandler(harness.handlers, 'turn_end')(
      {
        type: 'turn_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: "I'm sorry, but I cannot assist with that request." }],
        },
        toolResults: [],
      },
      harness.ctx,
    );

    expect(handleRefusalRecoverySpy).not.toHaveBeenCalled();
  });
});
