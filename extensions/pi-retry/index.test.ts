import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  filterSessionContextForRetryDisplay,
  linearizeRetryRecoveryTreeForDisplay,
  buildRetryStatus,
  classifyRetryableProviderError,
  createPiRetryExtension,
  getAbortListenerBindingCount,
  getRecoveryDispatchDelayMs,
  installAgentSessionPatch,
  isExtraRetryableAssistantError,
  resetPiRetryTestState,
} from './index';
import * as runtime from './runtime';

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
  resetPiRetryTestState();
});

describe('pi-retry extra provider classification', () => {
  test('classifies deployment-missing 404 as retryable', () => {
    expect(
      classifyRetryableProviderError(
        '404 The API deployment for this resource does not exist. If you created the deployment recently, please wait a moment and try again.',
      ),
    ).toBe('deploymentMissing');
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

  test('classifies peak-load provisioned-throughput failures as retryable', () => {
    expect(
      classifyRetryableProviderError(
        'Error: The system is currently experiencing high demand and cannot process your request. Your request exceeds the maximum usage size allowed during peak load. For improved capacity reliability, consider switching to Provisioned Throughput.',
      ),
    ).toBe('providerServerError');
  });

  test('does not classify unrelated generic 404 text as retryable', () => {
    expect(classifyRetryableProviderError('404 Resource not found')).toBeUndefined();
  });

  test('does not classify unrelated generic 400 text as retryable', () => {
    expect(classifyRetryableProviderError('400 Invalid request payload')).toBeUndefined();
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
});

describe('pi-retry status text', () => {
  test('formats compact retry status with a reason label', () => {
    expect(
      buildRetryStatus({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        errorMessage:
          '404 The API deployment for this resource does not exist. If you created the deployment recently, please wait a moment and try again.',
      }),
    ).toBe('↻ Retry 1/3 in 2s (deployment missing)');
  });

  test('omits the reason suffix when the error has no custom label', () => {
    expect(
      buildRetryStatus({
        type: 'auto_retry_start',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 4000,
        errorMessage: 'overloaded_error',
      }),
    ).toBe('↻ Retry 2/3 in 4s');
  });

  test('uses the same exponential backoff pattern for queued recovery dispatch', () => {
    expect(getRecoveryDispatchDelayMs(1)).toBe(2000);
    expect(getRecoveryDispatchDelayMs(2)).toBe(4000);
    expect(getRecoveryDispatchDelayMs(3)).toBe(8000);
  });
});

function makeFakeAgentSessionModule() {
  class FakeAgentSession {
    public sessionManager = {
      getSessionId: () => 'session-1',
    };

    public emitCalls: unknown[] = [];
    public baseClassifierCalls: unknown[] = [];

    _isRetryableError(message: { role?: string; stopReason?: string; errorMessage?: string }) {
      this.baseClassifierCalls.push(message);
      return 'overloaded_error' === message.errorMessage;
    }

    _emit(event: unknown) {
      this.emitCalls.push(event);
      return event;
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
    ).toBe(true);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(session.baseClassifierCalls).toHaveLength(2);
  });

  test('patches SessionManager display paths to hide historical retry recovery nodes', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const loader = vi.fn().mockResolvedValue(fakeModule);

    await installAgentSessionPatch(loader);

    const sessionManager = new fakeModule.SessionManager();
    const context = sessionManager.buildSessionContext();
    expect(context.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Do the thing' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Recovered answer' }] },
    ]);

    const tree = sessionManager.getTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].entry.id).toBe('assistant-success');
    expect(tree[0].children[0].entry.parentId).toBe('user-1');
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
  test('mirrors auto-retry events into UI status and clears them later', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    const session = new fakeModule.AgentSession();

    await getHandler(harness.handlers, 'session_start')({ type: 'session_start' }, harness.ctx);

    const retryStartEvent = {
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: '404 The API deployment for this resource does not exist.',
    };

    const retryEndEvent = {
      type: 'auto_retry_end',
      success: true,
      attempt: 1,
    };

    expect(session._emit(retryStartEvent)).toBe(retryStartEvent);
    expect(session._emit(retryEndEvent)).toBe(retryEndEvent);
    expect(session.emitCalls).toEqual([retryStartEvent, retryEndEvent]);

    expect(harness.statusCalls).toEqual([
      { key: 'pi-retry', text: '↻ Retry 1/3 in 2s (deployment missing)' },
      { key: 'pi-retry', text: undefined },
    ]);
  });

  test('does not register the deprecated session_switch handler in 0.65+', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);

    expect(harness.handlers.has('session_switch')).toBe(false);
  });

  test('binds status UI from session_start for resume flows using event.reason', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    const session = new fakeModule.AgentSession();

    await getHandler(harness.handlers, 'session_start')(
      {
        type: 'session_start',
        reason: 'resume',
        previousSessionFile: '/tmp/previous-session.jsonl',
      },
      harness.ctx,
    );

    session._emit({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: '404 The API deployment for this resource does not exist.',
    });

    expect(harness.statusCalls).toEqual([
      { key: 'pi-retry', text: '↻ Retry 1/3 in 2s (deployment missing)' },
    ]);
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

  test('agent_end clears a stuck retry status when auto_retry_end never fires', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    const session = new fakeModule.AgentSession();

    await getHandler(harness.handlers, 'session_start')({ type: 'session_start' }, harness.ctx);

    session._emit({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: 'overloaded_error',
    });

    expect(harness.statusCalls).toEqual([{ key: 'pi-retry', text: '↻ Retry 1/3 in 2s' }]);

    // Simulate the retried attempt producing a non-retryable error: agent_end
    // fires carrying a non-retryable assistant error, so core never emits
    // auto_retry_end.
    await getHandler(harness.handlers, 'agent_end')(
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            stopReason: 'error',
            errorMessage: '400 bad request: unknown parameter',
            content: [],
          },
        ],
      },
      harness.ctx,
    );

    expect(harness.statusCalls).toEqual([
      { key: 'pi-retry', text: '↻ Retry 1/3 in 2s' },
      { key: 'pi-retry', text: undefined },
    ]);
  });

  test('agent_end preserves retry status when another auto_retry_start follows', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    const session = new fakeModule.AgentSession();

    await getHandler(harness.handlers, 'session_start')({ type: 'session_start' }, harness.ctx);

    session._emit({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: 'overloaded_error',
    });

    // agent_end carries a retryable error message — our handler must leave
    // the status alone so the core's next auto_retry_start can refresh it.
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
    session._emit({
      type: 'auto_retry_start',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 4000,
      errorMessage: 'overloaded_error',
    });

    expect(harness.statusCalls).toEqual([
      { key: 'pi-retry', text: '↻ Retry 1/3 in 2s' },
      { key: 'pi-retry', text: '↻ Retry 2/3 in 4s' },
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

  test('agent_end defensively clears a retry status even on a successful stop', async () => {
    // auto_retry_end on the success path is emitted from message_end, but if
    // for any reason it did not fire, agent_end should still clear a lingering
    // retry status when the final assistant message is a clean stop.
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    const session = new fakeModule.AgentSession();

    await getHandler(harness.handlers, 'session_start')({ type: 'session_start' }, harness.ctx);

    session._emit({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: 'overloaded_error',
    });

    await getHandler(harness.handlers, 'agent_end')(
      {
        type: 'agent_end',
        messages: [{ role: 'assistant', stopReason: 'stop', content: [] }],
      },
      harness.ctx,
    );

    expect(harness.statusCalls).toEqual([
      { key: 'pi-retry', text: '↻ Retry 1/3 in 2s' },
      { key: 'pi-retry', text: undefined },
    ]);
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

  test('turn_end triggers refusal recovery through the registered patched session for terminal stop turns', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    const session = new fakeModule.AgentSession();

    const getRegisteredPatchedSessionSpy = vi
      .spyOn(runtime, 'getRegisteredPatchedSession')
      .mockReturnValue(session as any);
    const handleRefusalRecoverySpy = vi
      .spyOn(runtime, 'handleRefusalRecovery')
      .mockResolvedValue(undefined);

    await getHandler(harness.handlers, 'session_start')({ type: 'session_start' }, harness.ctx);
    session._emit({
      type: 'auto_retry_end',
      success: true,
      attempt: 1,
    });

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

    expect(getRegisteredPatchedSessionSpy).toHaveBeenCalledWith('session-1');
    expect(handleRefusalRecoverySpy).toHaveBeenCalledTimes(1);
    expect(handleRefusalRecoverySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: {
          messages: [
            {
              role: 'assistant',
              stopReason: 'stop',
              content: [
                { type: 'text', text: "I'm sorry, but I cannot assist with that request." },
              ],
            },
          ],
        },
      }),
    );

    expect(harness.sendUserMessageCalls).toEqual([]);
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

    await vi.advanceTimersByTimeAsync(1999);
    expect(harness.sendMessageCalls).toEqual([]);

    harness.ctx.isIdle = () => true;
    await vi.advanceTimersByTimeAsync(1);

    expect(harness.sendUserMessageCalls).toEqual([]);
    expect(harness.sendMessageCalls).toEqual([
      {
        message: { customType: 'pi-retry-recovery', content: 'Continue.', display: false },
        options: { triggerTurn: true },
      },
    ]);
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
    await vi.advanceTimersByTimeAsync(2000);

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

  test('turn_end recovers empty-stop turns even when tool results are present', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    const session = new fakeModule.AgentSession();

    const getRegisteredPatchedSessionSpy = vi
      .spyOn(runtime, 'getRegisteredPatchedSession')
      .mockReturnValue(session as any);
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

    expect(getRegisteredPatchedSessionSpy).toHaveBeenCalledWith('session-1');
    expect(handleRefusalRecoverySpy).toHaveBeenCalledTimes(1);
  });

  test('turn_end ignores visible assistant turns that still have tool results', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    const session = new fakeModule.AgentSession();

    const getRegisteredPatchedSessionSpy = vi
      .spyOn(runtime, 'getRegisteredPatchedSession')
      .mockReturnValue(session as any);
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

    expect(getRegisteredPatchedSessionSpy).not.toHaveBeenCalled();
    expect(handleRefusalRecoverySpy).not.toHaveBeenCalled();
  });

  test('turn_end ignores terminal stop turns when there are already pending queued messages', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    const session = new fakeModule.AgentSession();

    harness.ctx.hasPendingMessages = () => true;

    const getRegisteredPatchedSessionSpy = vi
      .spyOn(runtime, 'getRegisteredPatchedSession')
      .mockReturnValue(session as any);
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

    expect(getRegisteredPatchedSessionSpy).not.toHaveBeenCalled();
    expect(handleRefusalRecoverySpy).not.toHaveBeenCalled();
  });

  test('refusal recovery can be disabled with PI_RETRY_REFUSAL_RECOVERY_DISABLED', async () => {
    process.env.PI_RETRY_REFUSAL_RECOVERY_DISABLED = '1';

    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    const session = new fakeModule.AgentSession();

    const getRegisteredPatchedSessionSpy = vi
      .spyOn(runtime, 'getRegisteredPatchedSession')
      .mockReturnValue(session as any);
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

    expect(getRegisteredPatchedSessionSpy).not.toHaveBeenCalled();
    expect(handleRefusalRecoverySpy).not.toHaveBeenCalled();
  });

  test('provider retry branching does not call sendUserMessage', async () => {
    const fakeModule = makeFakeAgentSessionModule();
    const harness = await createExtensionHarness(async () => fakeModule);
    const session = new fakeModule.AgentSession();

    await getHandler(harness.handlers, 'session_start')({ type: 'session_start' }, harness.ctx);
    session._emit({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: 'The server had an error processing your request',
    });

    expect(harness.sendUserMessageCalls).toEqual([]);
  });
});
