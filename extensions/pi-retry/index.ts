import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from '@mariozechner/pi-coding-agent';

import {
  PI_RETRY_RECOVERY_CUSTOM_TYPE,
  buildRetryableLeafPrompt,
  branchLatestAssistantErrorOutOfMainPath,
  classifyRetryableProviderError,
  clearRefusalStatus,
  clearRuntimeState,
  detectRetryableTerminalLeaf,
  dispatchPendingRecovery,
  getQueuedRecovery,
  getPendingRecovery,
  getRegisteredPatchedSession,
  handleRecoveryAbort,
  handleRefusalRecovery,
  registerPatchedSession,
  type RetryRecoveryMessageDetails,
  resolveRecoveryOnAssistantMessage,
  unregisterPatchedSession,
} from './runtime';

export {
  buildRefusalStatus,
  extractAssistantText,
  inferModelFamily,
  isLikelyRefusalText,
  pickReviewModels,
  requestRefusalRewrite,
} from './refusal-review';

export { classifyRetryableProviderError };

import { requestRefusalRewrite } from './refusal-review';

const STATUS_KEY = 'pi-retry';
const PATCHED = Symbol.for('pi-retry.agent-session.patched');
const SESSION_MANAGER_PATCHED = Symbol.for('pi-retry.session-manager.patched');
const REFUSAL_DISABLE_ENV_VAR = 'PI_RETRY_REFUSAL_RECOVERY_DISABLED';
const RECOVERY_DISPATCH_BASE_DELAY_MS = 2000;
const RECOVERY_DISPATCH_IDLE_POLL_DELAY_MS = 100;

export interface PatchInstallResult {
  ok: boolean;
  reason?: string;
}

export interface AgentSessionModuleLike {
  AgentSession?: { prototype?: Record<PropertyKey, unknown> };
  SessionManager?: { prototype?: Record<PropertyKey, unknown> };
}

export type LoadAgentSessionModule = () => Promise<AgentSessionModuleLike>;

export type RetryReason =
  | 'deploymentMissing'
  | 'encryptedContentVerification'
  | 'nativeCompactionCreatedBy'
  | 'providerServerError';

export interface AssistantErrorLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface AutoRetryStartEventLike {
  type: 'auto_retry_start';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}

export interface AutoRetryEndEventLike {
  type: 'auto_retry_end';
  success: boolean;
  attempt: number;
  finalError?: string;
}

export type RetryLifecycleEventLike = AutoRetryStartEventLike | AutoRetryEndEventLike;

type StatusUi = Pick<ExtensionUIContext, 'setStatus' | 'notify'>;

type SessionManagerLike = {
  getLeafId?: () => string | undefined;
  getEntries?: () => ReadonlyArray<unknown>;
  getBranch?: () => Array<Record<string, any>>;
};

type LinearizedTreeCacheEntry = {
  entryCount: number;
  leafId: string | undefined;
  result: SessionTreeNodeLike[];
};

// Cache the linearized tree view per SessionManager instance. Keyed on the
// manager so that forked sessions and short-lived SDK instances drop their
// cache entry automatically when GC'd. In-memory only; not persisted.
const linearizedTreeCache = new WeakMap<object, LinearizedTreeCacheEntry>();

const uiBySessionId = new Map<string, StatusUi>();
const recoveryDispatchTimerBySessionId = new Map<string, ReturnType<typeof setTimeout>>();
const abortListenerBySessionId = new Map<string, { signal: AbortSignal; onAbort: () => void }>();

// Tracks sessions currently showing a retry-in-flight status. Used to
// defensively clear the status on agent_end when the retry cycle terminates
// without auto_retry_end (e.g. the retried attempt produces a non-retryable
// error, or the live LLM call is aborted mid-turn).
const retryStatusActiveSessions = new Set<string>();

let patchInstallPromise: Promise<PatchInstallResult> | undefined;
let patchFailureReason: string | undefined;
let patchFailureNotified = false;

export function isExtraRetryableAssistantError(message: AssistantErrorLike): boolean {
  return (
    'assistant' === message.role &&
    'error' === message.stopReason &&
    'string' === typeof message.errorMessage &&
    classifyRetryableProviderError(message.errorMessage) !== undefined
  );
}

function hasUserVisibleAssistantOutput(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((part) => {
    if (!part || 'object' !== typeof part) {
      return false;
    }
    if ('type' in part && 'toolCall' === part.type) {
      return true;
    }
    if (
      'type' in part &&
      'text' === part.type &&
      'string' === typeof (part as { text?: unknown }).text
    ) {
      return 0 < (part as { text: string }).text.trim().length;
    }
    return false;
  });
}

export function formatRetryReason(reason: RetryReason | undefined): string | undefined {
  switch (reason) {
    case 'deploymentMissing':
      return 'deployment missing';
    case 'encryptedContentVerification':
      return 'encrypted content verify';
    case 'nativeCompactionCreatedBy':
      return 'native replay metadata';
    case 'providerServerError':
      return 'provider server error';
    default:
      return undefined;
  }
}

export function formatRetryDelay(delayMs: number): string {
  return `${Math.max(1, Math.ceil(delayMs / 1000))}s`;
}

export function getRecoveryDispatchDelayMs(attempt: number): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  return RECOVERY_DISPATCH_BASE_DELAY_MS * 2 ** (normalizedAttempt - 1);
}

export function buildRetryStatus(event: AutoRetryStartEventLike): string {
  const reason = formatRetryReason(classifyRetryableProviderError(event.errorMessage));
  const suffix = reason ? ` (${reason})` : '';
  return `↻ Retry ${event.attempt}/${event.maxAttempts} in ${formatRetryDelay(event.delayMs)}${suffix}`;
}

type SessionContextLike = {
  messages: Array<Record<string, unknown>>;
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
};

type SessionTreeNodeLike = {
  entry: Record<string, any>;
  children: SessionTreeNodeLike[];
  label?: string;
  labelTimestamp?: string;
};

function isHiddenRetryRecoveryCustomMessage(message: Record<string, unknown> | undefined): boolean {
  return (
    message?.role === 'custom' &&
    message.customType === PI_RETRY_RECOVERY_CUSTOM_TYPE &&
    message.display === false
  );
}

function isHiddenRetryRecoveryEntry(entry: Record<string, any> | undefined): boolean {
  return (
    entry?.type === 'custom_message' &&
    entry.customType === PI_RETRY_RECOVERY_CUSTOM_TYPE &&
    entry.display === false
  );
}

function parseRetryRecoveryDetails(value: unknown): RetryRecoveryMessageDetails | undefined {
  if (!value || 'object' !== typeof value) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || candidate.displayHint !== 'linear-replacement') {
    return undefined;
  }

  if (
    candidate.kind !== 'empty-stop' &&
    candidate.kind !== 'refusal' &&
    candidate.kind !== 'retryable-error'
  ) {
    return undefined;
  }

  if (candidate.messageKind !== 'continue' && candidate.messageKind !== 'rewrite') {
    return undefined;
  }

  return candidate as unknown as RetryRecoveryMessageDetails;
}

export function filterSessionContextForRetryDisplay(
  sessionContext: SessionContextLike,
  pathEntries: Array<Record<string, any>>,
  leafId?: string | null,
): SessionContextLike {
  const hiddenRecoveryEntries = pathEntries.filter(isHiddenRetryRecoveryEntry);
  if (hiddenRecoveryEntries.length === 0) {
    return sessionContext;
  }

  const keepTrailingRecoveryCount =
    leafId && hiddenRecoveryEntries[hiddenRecoveryEntries.length - 1]?.id === leafId ? 1 : 0;
  const hiddenMessagesToDrop = Math.max(
    0,
    hiddenRecoveryEntries.length - keepTrailingRecoveryCount,
  );

  if (hiddenMessagesToDrop === 0) {
    return sessionContext;
  }

  let dropped = 0;
  const filteredMessages = sessionContext.messages.filter((message) => {
    if (dropped >= hiddenMessagesToDrop || !isHiddenRetryRecoveryCustomMessage(message)) {
      return true;
    }
    dropped += 1;
    return false;
  });

  return dropped === 0 ? sessionContext : { ...sessionContext, messages: filteredMessages };
}

function cloneEntryWithParent(
  entry: Record<string, any>,
  parentId: string | null,
): Record<string, any> {
  if ((entry.parentId ?? null) === parentId) {
    return entry;
  }
  return { ...entry, parentId };
}

function linearizeRetryRecoveryNodes(
  nodes: SessionTreeNodeLike[],
  displayParentId: string | null,
  currentLeafId?: string,
): { nodes: SessionTreeNodeLike[]; supersededIds: Set<string> } {
  // Implemented iteratively to tolerate deep session trees (pi sessions are
  // effectively linked lists of thousands of entries, which overflowed the
  // native call stack in the previous recursive implementation).
  type Frame = {
    nodes: SessionTreeNodeLike[];
    idx: number;
    // Parent id to stamp on emitted nodes at this level.
    emitParentId: string | null;
    // Output array that transformed nodes at this level are appended to.
    // Hoist frames share their parent's array; non-hoist frames own a fresh
    // `children` array that belongs to an eagerly-emitted clone.
    output: SessionTreeNodeLike[];
  };

  const supersededIds = collectSupersededIds(nodes, currentLeafId);

  const finalOutput: SessionTreeNodeLike[] = [];
  const stack: Frame[] = [{ nodes, idx: 0, emitParentId: displayParentId, output: finalOutput }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];

    if (frame.idx >= frame.nodes.length) {
      stack.pop();
      continue;
    }

    const node = frame.nodes[frame.idx++];

    // A node superseded by a hidden recovery entry (and its whole subtree)
    // is dropped entirely.
    if (node.entry.id && supersededIds.has(node.entry.id)) {
      continue;
    }

    if (isHiddenRetryRecoveryEntry(node.entry) && node.entry.id !== currentLeafId) {
      // Hoist: descend into children but append them into the current
      // frame's output, keeping the same parent id so hoisted grandchildren
      // get the recovery node's display parent stamped on them.
      stack.push({
        nodes: node.children,
        idx: 0,
        emitParentId: frame.emitParentId,
        output: frame.output,
      });
      continue;
    }

    // Non-hidden node: eagerly emit a transformed clone whose `children`
    // array is the descent frame's output target. This keeps the frame
    // state machine to a single shape (no deferred "pending" emission).
    const children: SessionTreeNodeLike[] = [];
    frame.output.push({
      ...node,
      entry: cloneEntryWithParent(node.entry, frame.emitParentId),
      children,
    });
    stack.push({
      nodes: node.children,
      idx: 0,
      emitParentId: node.entry.id ?? frame.emitParentId,
      output: children,
    });
  }

  return { nodes: finalOutput, supersededIds };
}

function collectSupersededIds(roots: SessionTreeNodeLike[], currentLeafId?: string): Set<string> {
  // Walks the whole tree iteratively and aggregates every
  // `details.replacement.supersedesEntryId` contributed by hidden,
  // non-current-leaf retry-recovery entries. The original recursive
  // implementation merged these up across levels; filtering must therefore
  // be applied globally, regardless of where the superseded id appears.
  const supersededIds = new Set<string>();
  const stack: SessionTreeNodeLike[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop() as SessionTreeNodeLike;
    if (isHiddenRetryRecoveryEntry(node.entry) && node.entry.id !== currentLeafId) {
      const details = parseRetryRecoveryDetails(node.entry.details);
      const supersededId = details?.replacement?.supersedesEntryId;
      if (supersededId) {
        supersededIds.add(supersededId);
      }
    }
    for (const child of node.children) {
      stack.push(child);
    }
  }
  return supersededIds;
}

/**
 * Returns a display-oriented view of the session tree with hidden retry
 * recovery entries linearized into their display parent.
 *
 * When the tree has no hidden recovery entries that need linearizing, the
 * original `roots` reference (and its descendants) is returned unchanged as
 * a referential-equality optimization. Callers must treat the returned tree
 * as read-only; mutating it may mutate the input.
 */
export function linearizeRetryRecoveryTreeForDisplay(
  roots: SessionTreeNodeLike[],
  currentLeafId?: string,
): SessionTreeNodeLike[] {
  if (!hasLinearizableRetryRecoveryEntry(roots, currentLeafId)) {
    return roots;
  }
  return linearizeRetryRecoveryNodes(roots, null, currentLeafId).nodes;
}

function hasLinearizableRetryRecoveryEntry(
  roots: SessionTreeNodeLike[],
  currentLeafId?: string,
): boolean {
  const stack: SessionTreeNodeLike[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop() as SessionTreeNodeLike;
    if (isHiddenRetryRecoveryEntry(node.entry) && node.entry.id !== currentLeafId) {
      return true;
    }
    for (const child of node.children) {
      stack.push(child);
    }
  }
  return false;
}

export async function defaultLoadAgentSessionModule(): Promise<AgentSessionModuleLike> {
  const [pathModule, urlModule] = await Promise.all([import('node:path'), import('node:url')]);

  const packageEntryUrl = import.meta.resolve('@mariozechner/pi-coding-agent');
  const packageEntryPath = urlModule.fileURLToPath(packageEntryUrl);
  const coreDir = pathModule.join(pathModule.dirname(packageEntryPath), 'core');
  const agentSessionUrl = urlModule.pathToFileURL(
    pathModule.join(coreDir, 'agent-session.js'),
  ).href;
  const sessionManagerUrl = urlModule.pathToFileURL(
    pathModule.join(coreDir, 'session-manager.js'),
  ).href;

  const [agentSessionModule, sessionManagerModule] = await Promise.all([
    import(/* @vite-ignore */ agentSessionUrl),
    import(/* @vite-ignore */ sessionManagerUrl),
  ]);

  return {
    ...agentSessionModule,
    ...sessionManagerModule,
  };
}

function bindStatusUi(ctx: ExtensionContext): void {
  if (!ctx.hasUI) {
    return;
  }
  uiBySessionId.set(ctx.sessionManager.getSessionId(), ctx.ui);
}

function clearStatusForSession(sessionId: string | undefined, removeBinding = false): void {
  if (!sessionId) {
    return;
  }

  clearRefusalStatus(sessionId);

  retryStatusActiveSessions.delete(sessionId);

  const ui = uiBySessionId.get(sessionId);
  ui?.setStatus(STATUS_KEY, undefined);

  if (removeBinding) {
    uiBySessionId.delete(sessionId);
  }
}

function cancelScheduledRecoveryDispatch(sessionId: string | undefined): void {
  if (!sessionId) {
    return;
  }
  const timer = recoveryDispatchTimerBySessionId.get(sessionId);
  if (timer === undefined) {
    return;
  }
  clearTimeout(timer);
  recoveryDispatchTimerBySessionId.delete(sessionId);
}

function unbindAbortListener(sessionId: string | undefined): void {
  if (!sessionId) {
    return;
  }

  const binding = abortListenerBySessionId.get(sessionId);
  if (!binding) {
    return;
  }

  binding.signal.removeEventListener('abort', binding.onAbort);
  abortListenerBySessionId.delete(sessionId);
}

function clearRecoveryForSession(
  sessionId: string | undefined,
  options?: { removeBinding?: boolean; cancelDispatch?: boolean },
): void {
  if (!sessionId) {
    return;
  }

  if (options?.cancelDispatch ?? true) {
    cancelScheduledRecoveryDispatch(sessionId);
  }
  handleRecoveryAbort(sessionId);
  clearStatusForSession(sessionId, options?.removeBinding ?? false);
}

function bindAbortCleanup(sessionId: string, ctx: ExtensionContext): void {
  const signal = ctx.signal;
  if (!signal) {
    unbindAbortListener(sessionId);
    return;
  }

  const existing = abortListenerBySessionId.get(sessionId);
  if (existing?.signal === signal) {
    return;
  }

  unbindAbortListener(sessionId);

  const onAbort = () => {
    unbindAbortListener(sessionId);
    clearRecoveryForSession(sessionId, { cancelDispatch: true });
  };

  signal.addEventListener('abort', onAbort, { once: true });
  abortListenerBySessionId.set(sessionId, { signal, onAbort });

  if (signal.aborted) {
    onAbort();
  }
}

function createDispatchRecoveryUi(ctx: ExtensionContext):
  | {
      setStatus: (text: string) => void;
      clearStatus: () => void;
      notify: (message: string, type: 'info' | 'warning' | 'error') => void;
    }
  | undefined {
  if (!ctx.hasUI) {
    return undefined;
  }

  return {
    setStatus: (text) => ctx.ui.setStatus(STATUS_KEY, text),
    clearStatus: () => ctx.ui.setStatus(STATUS_KEY, undefined),
    notify: (message, type) => ctx.ui.notify(message, type),
  };
}

function schedulePendingRecoveryDispatch(
  sessionId: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): void {
  if (recoveryDispatchTimerBySessionId.has(sessionId)) {
    return;
  }

  const queuedRecovery = getQueuedRecovery(sessionId);
  if (!queuedRecovery) {
    return;
  }

  const scheduleTick = (delayMs: number) => {
    recoveryDispatchTimerBySessionId.set(
      sessionId,
      setTimeout(() => void tick(), delayMs),
    );
  };

  const tick = async () => {
    if (!getPendingRecovery(sessionId)) {
      cancelScheduledRecoveryDispatch(sessionId);
      return;
    }

    if (!ctx.isIdle()) {
      scheduleTick(RECOVERY_DISPATCH_IDLE_POLL_DELAY_MS);
      return;
    }

    cancelScheduledRecoveryDispatch(sessionId);
    try {
      await dispatchPendingRecovery({
        sessionId,
        sendUserMessage: (content, details) =>
          pi.sendMessage(
            { customType: PI_RETRY_RECOVERY_CUSTOM_TYPE, content, display: false, details },
            { triggerTurn: true },
          ),
        ui: createDispatchRecoveryUi(ctx),
      });
    } catch {
      // Leave pending recovery state intact for a future retryable reopen/resume prompt.
    }
  };

  scheduleTick(getRecoveryDispatchDelayMs(queuedRecovery.attempt));
}

function maybeWarnAboutPatchFailure(ctx: ExtensionContext): void {
  if (!ctx.hasUI || !patchFailureReason || patchFailureNotified) {
    return;
  }
  patchFailureNotified = true;
  ctx.ui.notify(`pi-retry disabled: ${patchFailureReason}`, 'warning');
}

function getSessionIdFromPatchedSession(session: any): string | undefined {
  return session?.sessionManager?.getSessionId?.();
}

function refusalRecoveryDisabled(): boolean {
  const value = process.env[REFUSAL_DISABLE_ENV_VAR]?.trim().toLowerCase();
  return '1' === value || 'true' === value || 'yes' === value;
}

function handleRetryLifecycleEvent(session: any, event: RetryLifecycleEventLike): void {
  const sessionId = getSessionIdFromPatchedSession(session);
  if (!sessionId) {
    return;
  }

  const ui = uiBySessionId.get(sessionId);
  if (!ui) {
    return;
  }

  if ('auto_retry_start' === event.type) {
    retryStatusActiveSessions.add(sessionId);
    ui.setStatus(STATUS_KEY, buildRetryStatus(event));
    return;
  }

  retryStatusActiveSessions.delete(sessionId);
  ui.setStatus(STATUS_KEY, undefined);
}

function maybePatchSessionManager(
  SessionManager: { prototype?: Record<PropertyKey, any> } | undefined,
): void {
  const proto = SessionManager?.prototype as Record<PropertyKey, any> | undefined;
  if (!proto || proto[SESSION_MANAGER_PATCHED]) {
    return;
  }

  const originalBuildSessionContext = proto.buildSessionContext;
  const originalGetTree = proto.getTree;

  if ('function' === typeof originalBuildSessionContext) {
    proto.buildSessionContext = function patchedBuildSessionContext() {
      const sessionContext = originalBuildSessionContext.call(this) as SessionContextLike;
      const pathEntries = 'function' === typeof this.getBranch ? this.getBranch() : [];
      const leafId = 'function' === typeof this.getLeafId ? this.getLeafId() : undefined;
      return filterSessionContextForRetryDisplay(sessionContext, pathEntries, leafId);
    };
  }

  if ('function' === typeof originalGetTree) {
    proto.getTree = function patchedGetTree(this: SessionManagerLike) {
      const leafId = 'function' === typeof this.getLeafId ? this.getLeafId() : undefined;
      const entryCount = 'function' === typeof this.getEntries ? this.getEntries().length : -1;

      // Pi session entries are append-only and retry-recovery entries are
      // immutable once appended, so (entryCount, leafId) is a sound proxy for
      // "has the linearized tree output changed?". The cache is keyed on the
      // SessionManager instance so forks naturally get their own slot and
      // GC'd sessions drop their cache entry.
      const cached = linearizedTreeCache.get(this);
      if (cached && cached.entryCount === entryCount && cached.leafId === leafId) {
        return cached.result;
      }

      const tree = originalGetTree.call(this) as SessionTreeNodeLike[];
      const result = linearizeRetryRecoveryTreeForDisplay(tree, leafId);
      linearizedTreeCache.set(this, { entryCount, leafId, result });
      return result;
    };
  }

  Object.defineProperty(proto, SESSION_MANAGER_PATCHED, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export async function installAgentSessionPatch(
  loadAgentSessionModule: LoadAgentSessionModule = defaultLoadAgentSessionModule,
): Promise<PatchInstallResult> {
  if (patchInstallPromise) {
    return patchInstallPromise;
  }

  patchInstallPromise = (async () => {
    const module = await loadAgentSessionModule();
    const AgentSession = module.AgentSession as any;
    maybePatchSessionManager(module.SessionManager as any);

    if (!AgentSession?.prototype) {
      patchFailureReason = 'AgentSession export not found';
      return { ok: false, reason: patchFailureReason };
    }

    const proto = AgentSession.prototype as Record<PropertyKey, any>;
    if (proto[PATCHED]) {
      patchFailureReason = undefined;
      return { ok: true };
    }

    const originalIsRetryableError = proto._isRetryableError;
    const originalEmit = proto._emit;

    if ('function' !== typeof originalIsRetryableError) {
      patchFailureReason = 'AgentSession._isRetryableError is not available';
      return { ok: false, reason: patchFailureReason };
    }

    if ('function' !== typeof originalEmit) {
      patchFailureReason = 'AgentSession._emit is not available';
      return { ok: false, reason: patchFailureReason };
    }

    proto._isRetryableError = function patchedIsRetryableError(
      message: AssistantErrorLike,
    ): boolean {
      return Boolean(
        originalIsRetryableError.call(this, message) || isExtraRetryableAssistantError(message),
      );
    };

    proto._emit = function patchedEmit(event: RetryLifecycleEventLike) {
      registerPatchedSession(this);
      const result = originalEmit.call(this, event);
      if ('auto_retry_start' === event?.type) {
        const reason = classifyRetryableProviderError(event.errorMessage) ?? 'providerServerError';
        branchLatestAssistantErrorOutOfMainPath(this, {
          attempt: event.attempt,
          errorMessage: event.errorMessage,
          reason,
        });
        handleRetryLifecycleEvent(this, event);
      } else if ('auto_retry_end' === event?.type) {
        handleRetryLifecycleEvent(this, event);
      }
      return result;
    };

    Object.defineProperty(proto, PATCHED, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    patchFailureReason = undefined;
    return { ok: true };
  })().catch((error) => {
    patchFailureReason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: patchFailureReason };
  });

  return patchInstallPromise;
}

export function resetPiRetryTestState(): void {
  uiBySessionId.clear();
  retryStatusActiveSessions.clear();
  for (const sessionId of abortListenerBySessionId.keys()) {
    unbindAbortListener(sessionId);
  }
  clearRuntimeState();
  patchInstallPromise = undefined;
  patchFailureReason = undefined;
  patchFailureNotified = false;
}

export function getAbortListenerBindingCount(): number {
  return abortListenerBySessionId.size;
}

export function createPiRetryExtension(
  loadAgentSessionModule: LoadAgentSessionModule = defaultLoadAgentSessionModule,
) {
  return async function piRetry(pi: ExtensionAPI): Promise<void> {
    await installAgentSessionPatch(loadAgentSessionModule);

    const promptAndRecoverCurrentLeaf = async (
      ctx: ExtensionContext,
      options?: { notifyWhenNotRetryable?: boolean },
    ): Promise<boolean> => {
      const candidate = detectRetryableTerminalLeaf(ctx.sessionManager as any);
      if (!candidate) {
        if (options?.notifyWhenNotRetryable && ctx.hasUI) {
          ctx.ui.notify('pi-retry: current leaf is not retryable', 'info');
        }
        return false;
      }

      if (ctx.hasUI) {
        const prompt = buildRetryableLeafPrompt(candidate);
        const ok = await ctx.ui.confirm(prompt.title, prompt.message);
        if (!ok) {
          return false;
        }
      }

      await handleRefusalRecovery({
        event: { messages: [candidate.message] },
        ctx,
        patchedSession: { sessionManager: ctx.sessionManager as any },
        reviewRewrite: requestRefusalRewrite,
        sendUserMessage: (content, details) =>
          pi.sendMessage(
            { customType: PI_RETRY_RECOVERY_CUSTOM_TYPE, content, display: false, details },
            { triggerTurn: true },
          ),
        dispatchMode: 'immediate',
      });
      return true;
    };

    pi.registerCommand('retry', {
      description: 'Retry the current retryable leaf in this session',
      handler: async (_args, ctx) => {
        await ctx.waitForIdle();
        await promptAndRecoverCurrentLeaf(ctx, { notifyWhenNotRetryable: true });
      },
    });

    pi.on('session_start', async (event, ctx) => {
      bindStatusUi(ctx);
      maybeWarnAboutPatchFailure(ctx);

      if ('startup' !== event.reason && 'resume' !== event.reason && 'reload' !== event.reason) {
        return;
      }

      if (refusalRecoveryDisabled()) {
        return;
      }

      await promptAndRecoverCurrentLeaf(ctx);
    });

    pi.on('input', async (event, ctx) => {
      bindStatusUi(ctx);
      maybeWarnAboutPatchFailure(ctx);
      if ('extension' === event.source) {
        return;
      }
      clearRecoveryForSession(ctx.sessionManager.getSessionId());
    });

    pi.on('before_agent_start', async (_event, ctx) => {
      bindStatusUi(ctx);
      maybeWarnAboutPatchFailure(ctx);
      bindAbortCleanup(ctx.sessionManager.getSessionId(), ctx);
    });

    pi.on('agent_start', async (_event, ctx) => {
      bindStatusUi(ctx);
      maybeWarnAboutPatchFailure(ctx);
      bindAbortCleanup(ctx.sessionManager.getSessionId(), ctx);
    });

    pi.on('turn_end', async (event, ctx) => {
      if (
        'assistant' !== event.message?.role ||
        !['stop', 'error'].includes(event.message?.stopReason ?? '')
      ) {
        return;
      }

      const hasToolResults = 0 < (event.toolResults?.length ?? 0);
      const hasPendingMessages = ctx.hasPendingMessages();
      const isToolBackedEmptyStop =
        hasToolResults &&
        'stop' === event.message?.stopReason &&
        !hasUserVisibleAssistantOutput(event.message?.content);

      if (hasToolResults || hasPendingMessages) {
        resolveRecoveryOnAssistantMessage(ctx, event.message);
        if (!isToolBackedEmptyStop || hasPendingMessages) {
          return;
        }
      }

      if (refusalRecoveryDisabled()) {
        return;
      }

      const patchedSession = getRegisteredPatchedSession(ctx.sessionManager.getSessionId());
      if (!patchedSession) {
        return;
      }

      await handleRefusalRecovery({
        event: { messages: [event.message] },
        ctx,
        patchedSession,
        reviewRewrite: requestRefusalRewrite,
        sendUserMessage: (content, details) =>
          pi.sendMessage(
            { customType: PI_RETRY_RECOVERY_CUSTOM_TYPE, content, display: false, details },
            { triggerTurn: true },
          ),
        dispatchMode: 'pending',
      });
    });

    pi.on('message_end', async (event, ctx) => {
      if (!Array.isArray((event.message as { content?: unknown }).content)) {
        return;
      }

      const hasToolCall = (event.message as { content: Array<{ type?: unknown }> }).content.some(
        (part) => 'toolCall' === part?.type,
      );
      if (!hasToolCall) {
        return;
      }

      resolveRecoveryOnAssistantMessage(ctx, event.message);
    });

    pi.on('agent_end', async (event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      if (getPendingRecovery(sessionId)) {
        schedulePendingRecoveryDispatch(sessionId, ctx, pi);
      }

      // Defensive clear: the core only emits auto_retry_end on successful
      // recovery (message_end), max retries exceeded, or sleep-cancelled
      // aborts. When a retry attempt produces a non-retryable error (or the
      // live LLM call is aborted mid-turn), no auto_retry_end fires and the
      // retry status would otherwise stay stuck until the next user input.
      //
      // Classify the final assistant message synchronously: if it's a
      // retryable error the core will refresh the status via a new
      // auto_retry_start, so leave it alone. Otherwise clear.
      if (!retryStatusActiveSessions.has(sessionId)) {
        return;
      }
      const messages =
        (event as unknown as { messages?: Array<Record<string, unknown>> }).messages ?? [];
      let lastAssistant: Record<string, unknown> | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'assistant') {
          lastAssistant = messages[i];
          break;
        }
      }
      if (!lastAssistant) {
        return;
      }
      if (lastAssistant.stopReason === 'error') {
        const patchedSession = getRegisteredPatchedSession(sessionId) as
          | { _isRetryableError?: (message: AssistantErrorLike) => boolean }
          | undefined;
        const isRetryable = Boolean(
          patchedSession?._isRetryableError?.(lastAssistant as unknown as AssistantErrorLike),
        );
        if (isRetryable) {
          return;
        }
      }
      retryStatusActiveSessions.delete(sessionId);
      const ui = uiBySessionId.get(sessionId);
      ui?.setStatus(STATUS_KEY, undefined);
    });

    pi.on('session_shutdown', async (_event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      unbindAbortListener(sessionId);
      clearRecoveryForSession(sessionId, { removeBinding: true, cancelDispatch: true });
      unregisterPatchedSession(sessionId);
    });
  };
}

export default createPiRetryExtension();
