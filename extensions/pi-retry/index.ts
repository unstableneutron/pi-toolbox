import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';

import {
  hasAssistantToolCall,
  hasUserVisibleAssistantOutput,
  isSkippableEmptyFailedAssistantArtifact,
} from '../shared/assistant-message-state';
import {
  classifyRetryableAssistantProviderError,
  classifyRetryableProviderError,
  isNonRetryableAssistantProviderError,
  requiresSessionRepairForRetryableProviderError,
  type RetryableProviderErrorReason,
} from '../shared/provider-errors';

import {
  LENGTH_TRUNCATION_CONTINUE_MESSAGE,
  PI_RETRY_RECOVERY_CUSTOM_TYPE,
  buildRecoveryStatus,
  buildRetryableLeafPrompt,
  branchLatestAssistantErrorOutOfMainPath,
  clearRefusalStatus,
  clearRuntimeState,
  detectRetryableTerminalLeaf,
  dispatchPendingRecovery,
  getQueuedRecovery,
  getPendingRecovery,
  handleRecoveryAbort,
  handleRefusalRecovery,
  hasAwaitableRecovery,
  registerPatchedSession,
  setPendingRecovery,
  type RetryRecoveryMessageDetails,
  resolveRecoveryOnAssistantMessage,
  waitForRecoveryOutcome,
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
export { isSkippableEmptyFailedAssistantArtifact };

import { requestRefusalRewrite } from './refusal-review';
import { readCoreRetrySettings, type CoreRetrySettingsLike } from './settings';

const STATUS_KEY = 'pi-retry';
const PATCHED = Symbol.for('pi-retry.agent-session.patched');
const SESSION_MANAGER_PATCHED = Symbol.for('pi-retry.session-manager.patched');
const REFUSAL_DISABLE_ENV_VAR = 'PI_RETRY_REFUSAL_RECOVERY_DISABLED';
const DEFAULT_CORE_RETRY_BASE_DELAY_MS = 2000;
const DEFAULT_CORE_RETRY_MAX_RETRIES = 3;
const DEFAULT_COMPACTION_EXTRA_RETRIES = 2;
const LENGTH_TRUNCATION_MAX_RECOVERY_ATTEMPTS = 1;
const PROMPT_RECOVERY_TIMEOUT_MS = 120_000;
const RECOVERY_FALLBACK_QUIET_WINDOW_MS = 750;
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

export type RetryReason = RetryableProviderErrorReason;

export interface AssistantErrorLike {
  role?: string;
  api?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

const OPENAI_RESPONSES_APIS = new Set([
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'openai-websocket-responses',
]);
const INVALID_EMPTY_RESPONSES_ERROR =
  'Model produced invalid content: response.completed contained no assistant text or function calls';

export function normalizeInvalidOpenAIResponsesStop<TMessage extends AssistantErrorLike>(
  message: TMessage,
): (TMessage & { stopReason: 'error'; errorMessage: string }) | undefined {
  if (
    message.role !== 'assistant' ||
    message.stopReason !== 'stop' ||
    !OPENAI_RESPONSES_APIS.has(message.api ?? '') ||
    hasUserVisibleAssistantOutput(message.content)
  ) {
    return undefined;
  }

  return {
    ...message,
    stopReason: 'error',
    errorMessage: INVALID_EMPTY_RESPONSES_ERROR,
  };
}

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
const recoveryFallbackTimerBySessionId = new Map<string, ReturnType<typeof setTimeout>>();
const abortListenerBySessionId = new Map<string, { signal: AbortSignal; onAbort: () => void }>();
const terminatingToolCallIdsBySessionId = new Map<string, Set<string>>();
const pendingLengthTruncationBySessionId = new Map<string, { failedEntryId?: string }>();
const lengthTruncationRecoveryAttemptsBySessionId = new Map<string, number>();

let patchInstallPromise: Promise<PatchInstallResult> | undefined;
let patchFailureReason: string | undefined;
let patchFailureNotified = false;

function getRetryableProviderErrorReason(message: AssistantErrorLike): RetryReason | undefined {
  if ('assistant' !== message.role || 'error' !== message.stopReason) {
    return undefined;
  }
  return classifyRetryableAssistantProviderError(message);
}

function requiresPiRetryOwnedRecovery(reason: RetryReason | undefined): boolean {
  return requiresSessionRepairForRetryableProviderError(reason);
}

export function isExtraRetryableAssistantError(message: AssistantErrorLike): boolean {
  return getRetryableProviderErrorReason(message) !== undefined;
}

function isCoreSafeExtraRetryableAssistantError(message: AssistantErrorLike): boolean {
  const reason = getRetryableProviderErrorReason(message);
  return reason !== undefined && !requiresPiRetryOwnedRecovery(reason);
}

// Mirrors the regex used by `AgentSession._isRetryableError` in
// `@earendil-works/pi-coding-agent` 0.70.x. Kept local because the core
// exposes no extension hook for classifying retryable errors. When the core
// retries an error whose text matches, it starts a fresh agent_start/end
// cycle via `agent.continue()` without a `before_agent_start` event; we use
// this predicate in the `agent_end` handler to branch the failed leaf out
// of the main path before the next attempt writes a sibling.
const CORE_RETRYABLE_ERROR_PATTERN =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

function isLikelyCoreRetryableError(message: AssistantErrorLike): boolean {
  if (isNonRetryableAssistantProviderError(message)) return false;
  return (
    'assistant' === message.role &&
    'error' === message.stopReason &&
    'string' === typeof message.errorMessage &&
    CORE_RETRYABLE_ERROR_PATTERN.test(message.errorMessage)
  );
}

function getFinalAssistantMessage(
  messages: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      return messages[i];
    }
  }
  return undefined;
}

function shouldTreatAsCoreWillRetry(
  event: { willRetry?: unknown },
  ctx: ExtensionContext,
  lastAssistant: Record<string, unknown> | undefined,
): boolean {
  if (event.willRetry === true) {
    if (lastAssistant && isNonRetryableAssistantProviderError(lastAssistant)) return false;
    return true;
  }
  if (event.willRetry === false) {
    return false;
  }

  const settings = getCoreRetrySettings(ctx.cwd);
  if (settings.enabled === false || settings.maxRetries <= 0) {
    return false;
  }

  return Boolean(
    lastAssistant && isCoreExpectedRetryableError(lastAssistant as AssistantErrorLike),
  );
}

function isBranchableRetryableError(message: AssistantErrorLike): boolean {
  if (isNonRetryableAssistantProviderError(message)) return false;
  return isExtraRetryableAssistantError(message) || isLikelyCoreRetryableError(message);
}

function isCoreExpectedRetryableError(message: AssistantErrorLike): boolean {
  if (isNonRetryableAssistantProviderError(message)) return false;
  const reason = getRetryableProviderErrorReason(message);
  if (requiresPiRetryOwnedRecovery(reason)) {
    return false;
  }
  return isLikelyCoreRetryableError(message) || isCoreSafeExtraRetryableAssistantError(message);
}

function isLengthTruncatedAssistantMessage(message: unknown): boolean {
  if (!message || 'object' !== typeof message) {
    return false;
  }
  const candidate = message as Record<string, unknown>;
  return Boolean(
    candidate.role === 'assistant' &&
    candidate.stopReason === 'length' &&
    !hasAssistantToolCall(candidate.content),
  );
}

type CompactionEndEventLike = {
  type?: unknown;
  result?: unknown;
  aborted?: unknown;
  errorMessage?: unknown;
};

function isCompactionEndEvent(event: unknown): event is CompactionEndEventLike {
  return Boolean(
    event && 'object' === typeof event && 'compaction_end' === (event as { type?: unknown }).type,
  );
}

function isRetryableCompactionFailure(event: CompactionEndEventLike | undefined): boolean {
  return Boolean(
    event &&
    true !== event.aborted &&
    event.result === undefined &&
    'string' === typeof event.errorMessage &&
    classifyRetryableProviderError(event.errorMessage) !== undefined,
  );
}

function getCoreRetrySettings(cwd: string | undefined): CoreRetrySettingsLike {
  try {
    return readCoreRetrySettings(cwd);
  } catch {
    return {
      baseDelayMs: DEFAULT_CORE_RETRY_BASE_DELAY_MS,
      maxRetries: DEFAULT_CORE_RETRY_MAX_RETRIES,
    };
  }
}

export function getRecoveryDispatchDelayMs(
  attempt: number,
  settings: CoreRetrySettingsLike = {
    baseDelayMs: DEFAULT_CORE_RETRY_BASE_DELAY_MS,
    maxRetries: DEFAULT_CORE_RETRY_MAX_RETRIES,
  },
): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const cappedAttempt = Math.min(normalizedAttempt, Math.max(1, settings.maxRetries));
  return settings.baseDelayMs * 2 ** (cappedAttempt - 1);
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

function isAssistantErrorEntry(entry: Record<string, any> | undefined): boolean {
  return (
    entry?.type === 'message' &&
    entry.message?.role === 'assistant' &&
    entry.message?.stopReason === 'error'
  );
}

function normalizeToolCallId(value: unknown): string | undefined {
  if ('string' !== typeof value || value.trim().length === 0) {
    return undefined;
  }
  return value.split('|', 1)[0];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return 'object' === typeof value && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function getTerminatingToolCallIds(sessionId: string): Set<string> {
  let toolCallIds = terminatingToolCallIdsBySessionId.get(sessionId);
  if (!toolCallIds) {
    toolCallIds = new Set<string>();
    terminatingToolCallIdsBySessionId.set(sessionId, toolCallIds);
  }
  return toolCallIds;
}

function rememberTerminatingToolCall(sessionId: string, toolCallId: unknown): void {
  const normalizedToolCallId = normalizeToolCallId(toolCallId);
  if (!normalizedToolCallId) {
    return;
  }
  getTerminatingToolCallIds(sessionId).add(normalizedToolCallId);
}

function isTerminatingToolResult(sessionId: string, message: Record<string, unknown>): boolean {
  const normalizedToolCallId = normalizeToolCallId(message.toolCallId);
  return (
    normalizedToolCallId !== undefined &&
    getTerminatingToolCallIds(sessionId).has(normalizedToolCallId)
  );
}

function markTerminatingToolResultMessage(
  message: Record<string, unknown>,
): Record<string, unknown> {
  const piRetry = asRecord(message.piRetry) ?? {};
  if (true === piRetry.terminate) {
    return message;
  }
  return { ...message, piRetry: { ...piRetry, terminate: true } };
}

function rememberToolCallId(toolCallIds: Set<string>, value: unknown): void {
  const normalized = normalizeToolCallId(value);
  if (!normalized) {
    return;
  }
  toolCallIds.add(normalized);
}

function messageContentParts(message: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
}

function getAssistantToolCallIds(message: Record<string, unknown>): Set<string> {
  const toolCallIds = new Set<string>();
  for (const part of messageContentParts(message)) {
    if (part.type === 'toolCall') {
      rememberToolCallId(toolCallIds, part.id);
    }
  }
  return toolCallIds;
}

function filterOrphanToolResults(sessionContext: SessionContextLike): SessionContextLike {
  let expectedToolCallIds: Set<string> | undefined;
  let changed = false;
  const filteredMessages: Array<Record<string, unknown>> = [];

  for (const message of sessionContext.messages) {
    if (message.role === 'toolResult') {
      const normalizedToolCallId = normalizeToolCallId(
        (message as { toolCallId?: unknown }).toolCallId,
      );
      const hasMatchingToolCall =
        normalizedToolCallId !== undefined && expectedToolCallIds?.has(normalizedToolCallId);

      if (!hasMatchingToolCall) {
        changed = true;
        continue;
      }

      expectedToolCallIds?.delete(normalizedToolCallId);
      filteredMessages.push(message);
      continue;
    }

    filteredMessages.push(message);

    if (message.role === 'assistant') {
      const toolCallIds = getAssistantToolCallIds(message);
      expectedToolCallIds = toolCallIds.size > 0 ? toolCallIds : undefined;
      continue;
    }

    expectedToolCallIds = undefined;
  }

  return changed ? { ...sessionContext, messages: filteredMessages } : sessionContext;
}

function isAssistantNonErrorMessage(node: SessionTreeNodeLike | undefined): boolean {
  const entry = node?.entry;
  return (
    entry?.type === 'message' &&
    entry.message?.role === 'assistant' &&
    entry.message?.stopReason !== 'error'
  );
}

/**
 * An assistant error entry is considered "retried" (and therefore safe to
 * hide from the display tree) when:
 *   - it is not the current leaf,
 *   - it has no children of its own (branching always moves the leaf back to
 *     the error's parent, so retry responses land as siblings rather than
 *     descendants of the error), and
 *   - at least one of its siblings is a non-error assistant message (i.e.
 *     the recovery that superseded it).
 *
 * The check operates on a parent's children list so we can evaluate siblings
 * in one pass while walking the tree.
 */
function isRetriedAssistantError(
  node: SessionTreeNodeLike,
  siblings: SessionTreeNodeLike[],
  currentLeafId: string | undefined,
): boolean {
  if (!isAssistantErrorEntry(node.entry)) {
    return false;
  }
  if (node.entry.id && node.entry.id === currentLeafId) {
    return false;
  }
  if (node.children.length > 0) {
    return false;
  }
  return siblings.some((sibling) => sibling !== node && isAssistantNonErrorMessage(sibling));
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
    candidate.kind !== 'length-truncated' &&
    candidate.kind !== 'premature-abandonment' &&
    candidate.kind !== 'refusal' &&
    candidate.kind !== 'retryable-error' &&
    candidate.kind !== 'stranded-tool-results'
  ) {
    return undefined;
  }

  if (candidate.messageKind !== 'continue' && candidate.messageKind !== 'rewrite') {
    return undefined;
  }

  return candidate as unknown as RetryRecoveryMessageDetails;
}

function filterSkippableEmptyFailedAssistantArtifacts(
  sessionContext: SessionContextLike,
): SessionContextLike {
  let changed = false;
  const filteredMessages = sessionContext.messages.filter((message) => {
    if (!isSkippableEmptyFailedAssistantArtifact(message)) {
      return true;
    }
    changed = true;
    return false;
  });

  return changed ? { ...sessionContext, messages: filteredMessages } : sessionContext;
}

export function filterSessionContextForRetryDisplay(
  sessionContext: SessionContextLike,
  pathEntries: Array<Record<string, any>>,
  leafId?: string | null,
): SessionContextLike {
  const sanitizedContext = filterSkippableEmptyFailedAssistantArtifacts(
    filterOrphanToolResults(sessionContext),
  );
  const hiddenRecoveryEntries = pathEntries.filter(isHiddenRetryRecoveryEntry);
  if (hiddenRecoveryEntries.length === 0) {
    return sanitizedContext;
  }

  const keepTrailingRecoveryCount =
    leafId && hiddenRecoveryEntries[hiddenRecoveryEntries.length - 1]?.id === leafId ? 1 : 0;
  const hiddenMessagesToDrop = Math.max(
    0,
    hiddenRecoveryEntries.length - keepTrailingRecoveryCount,
  );

  if (hiddenMessagesToDrop === 0) {
    return sanitizedContext;
  }

  let dropped = 0;
  const filteredMessages = sanitizedContext.messages.filter((message) => {
    if (dropped >= hiddenMessagesToDrop || !isHiddenRetryRecoveryCustomMessage(message)) {
      return true;
    }
    dropped += 1;
    return false;
  });

  return dropped === 0 ? sanitizedContext : { ...sanitizedContext, messages: filteredMessages };
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

    // Drop assistant error messages whose sibling list contains a
    // non-error assistant recovery. These are failed attempts that the
    // core (or pi-retry) subsequently retried successfully, so showing
    // them in the display tree just adds noise.
    if (isRetriedAssistantError(node, frame.nodes, currentLeafId)) {
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
  if (!hasLinearizableDisplayNode(roots, currentLeafId)) {
    return roots;
  }
  return linearizeRetryRecoveryNodes(roots, null, currentLeafId).nodes;
}

function hasLinearizableDisplayNode(roots: SessionTreeNodeLike[], currentLeafId?: string): boolean {
  const stack: Array<{ nodes: SessionTreeNodeLike[] }> = [{ nodes: roots }];
  while (stack.length > 0) {
    const frame = stack.pop() as { nodes: SessionTreeNodeLike[] };
    for (const node of frame.nodes) {
      if (isHiddenRetryRecoveryEntry(node.entry) && node.entry.id !== currentLeafId) {
        return true;
      }
      if (isRetriedAssistantError(node, frame.nodes, currentLeafId)) {
        return true;
      }
      if (node.children.length > 0) {
        stack.push({ nodes: node.children });
      }
    }
  }
  return false;
}

export async function defaultLoadAgentSessionModule(): Promise<AgentSessionModuleLike> {
  const [pathModule, urlModule] = await Promise.all([import('node:path'), import('node:url')]);

  const packageEntryUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
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

function cancelScheduledFallbackRecovery(sessionId: string | undefined): void {
  if (!sessionId) {
    return;
  }
  const timer = recoveryFallbackTimerBySessionId.get(sessionId);
  if (timer === undefined) {
    return;
  }
  clearTimeout(timer);
  recoveryFallbackTimerBySessionId.delete(sessionId);
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

function clearLengthTruncationRecoveryForSession(sessionId: string | undefined): void {
  if (!sessionId) {
    return;
  }
  pendingLengthTruncationBySessionId.delete(sessionId);
  lengthTruncationRecoveryAttemptsBySessionId.delete(sessionId);
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
    cancelScheduledFallbackRecovery(sessionId);
  }
  clearLengthTruncationRecoveryForSession(sessionId);
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

    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
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

  scheduleTick(getRecoveryDispatchDelayMs(queuedRecovery.attempt, getCoreRetrySettings(ctx.cwd)));
}

function maybeWarnAboutPatchFailure(ctx: ExtensionContext): void {
  if (!ctx.hasUI || !patchFailureReason || patchFailureNotified) {
    return;
  }
  patchFailureNotified = true;
  ctx.ui.notify(`pi-retry disabled: ${patchFailureReason}`, 'warning');
}

function refusalRecoveryDisabled(): boolean {
  const value = process.env[REFUSAL_DISABLE_ENV_VAR]?.trim().toLowerCase();
  return '1' === value || 'true' === value || 'yes' === value;
}

function isSubagentChildProcess(): boolean {
  return process.env.PI_SUBAGENT_CHILD === '1';
}

function maybePatchSessionManager(
  SessionManager: { prototype?: Record<PropertyKey, any> } | undefined,
): void {
  const proto = SessionManager?.prototype as Record<PropertyKey, any> | undefined;
  if (!proto || proto[SESSION_MANAGER_PATCHED]) {
    return;
  }

  // NOTE: We only patch `getTree` here. Filtering hidden retry-recovery
  // entries out of the LLM context used to be done via a `buildSessionContext`
  // prototype patch, but since pi-coding-agent 0.70.x we can do the same work
  // through the public `context` extension event (see the `pi.on('context',
  // ...)` handler in `createPiRetryExtension`). Tree-display linearization has
  // no equivalent extension hook yet, so `getTree` remains patched.
  const originalGetTree = proto.getTree;

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
    const originalPrompt = proto.prompt;
    const originalRunAutoCompaction = proto._runAutoCompaction;

    if ('function' !== typeof originalIsRetryableError) {
      patchFailureReason = 'AgentSession._isRetryableError is not available';
      return { ok: false, reason: patchFailureReason };
    }

    // _isRetryableError is extended to add provider-specific error strings
    // that the core's built-in regex doesn't cover. There is no public
    // extension hook to register additional retryable-error matchers, so this
    // remains a prototype patch. Remove once core exposes such an API.
    proto._isRetryableError = function patchedIsRetryableError(
      message: AssistantErrorLike,
    ): boolean {
      if (isNonRetryableAssistantProviderError(message)) return false;
      return Boolean(
        originalIsRetryableError.call(this, message) ||
        isCoreSafeExtraRetryableAssistantError(message),
      );
    };

    if ('function' === typeof originalPrompt) {
      proto.prompt = async function patchedPrompt(...args: unknown[]) {
        try {
          return await originalPrompt.apply(this, args);
        } catch (error) {
          const sessionId = this?.sessionManager?.getSessionId?.();
          if (!hasAwaitableRecovery(sessionId)) {
            throw error;
          }

          const outcome = await waitForRecoveryOutcome(sessionId, {
            timeoutMs: PROMPT_RECOVERY_TIMEOUT_MS,
          });
          if (outcome.ok) {
            return undefined;
          }

          throw error;
        }
      };
    }

    if ('function' === typeof originalRunAutoCompaction) {
      proto._runAutoCompaction = async function patchedRunAutoCompaction(...args: unknown[]) {
        let retriesRemaining = DEFAULT_COMPACTION_EXTRA_RETRIES;

        while (true) {
          const originalEmit = this?._emit;
          let compactionEndEvent: CompactionEndEventLike | undefined;

          if ('function' === typeof originalEmit) {
            this._emit = function patchedCompactionRetryEmit(
              event: unknown,
              ...emitArgs: unknown[]
            ) {
              if (isCompactionEndEvent(event)) {
                compactionEndEvent = event;
              }
              return originalEmit.call(this, event, ...emitArgs);
            };
          }

          let result;
          try {
            result = await originalRunAutoCompaction.apply(this, args);
          } finally {
            if ('function' === typeof originalEmit) {
              this._emit = originalEmit;
            }
          }

          if (
            false !== result ||
            retriesRemaining <= 0 ||
            !isRetryableCompactionFailure(compactionEndEvent)
          ) {
            return result;
          }

          retriesRemaining -= 1;
        }
      };
    }

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
  for (const sessionId of recoveryDispatchTimerBySessionId.keys()) {
    cancelScheduledRecoveryDispatch(sessionId);
  }
  for (const sessionId of recoveryFallbackTimerBySessionId.keys()) {
    cancelScheduledFallbackRecovery(sessionId);
  }
  for (const sessionId of abortListenerBySessionId.keys()) {
    unbindAbortListener(sessionId);
  }
  terminatingToolCallIdsBySessionId.clear();
  pendingLengthTruncationBySessionId.clear();
  lengthTruncationRecoveryAttemptsBySessionId.clear();
  clearRuntimeState();
  patchInstallPromise = undefined;
  patchFailureReason = undefined;
  patchFailureNotified = false;
}

export function getAbortListenerBindingCount(): number {
  return abortListenerBySessionId.size;
}

export interface CreatePiRetryExtensionOptions {
  loadAgentSessionModule?: LoadAgentSessionModule;
  installAgentSessionPatch?: boolean;
  shouldPromptOnSessionStart?: (event: Record<string, unknown>) => boolean;
}

function normalizeCreateOptions(
  input: LoadAgentSessionModule | CreatePiRetryExtensionOptions = {},
): Required<Pick<CreatePiRetryExtensionOptions, 'installAgentSessionPatch'>> &
  Omit<CreatePiRetryExtensionOptions, 'installAgentSessionPatch'> {
  if ('function' === typeof input) {
    return { loadAgentSessionModule: input, installAgentSessionPatch: true };
  }
  return {
    ...input,
    installAgentSessionPatch: input.installAgentSessionPatch ?? true,
  };
}

function shouldPromptOnPiSessionStart(event: Record<string, unknown>): boolean {
  return event.reason === 'startup' || event.reason === 'resume' || event.reason === 'reload';
}

export function createPiRetryExtension(
  optionsOrLoadAgentSessionModule: LoadAgentSessionModule | CreatePiRetryExtensionOptions = {},
) {
  const options = normalizeCreateOptions(optionsOrLoadAgentSessionModule);
  const loadAgentSessionModule = options.loadAgentSessionModule ?? defaultLoadAgentSessionModule;
  const shouldPromptOnSessionStart =
    options.shouldPromptOnSessionStart ?? shouldPromptOnPiSessionStart;

  return async function piRetry(pi: ExtensionAPI): Promise<void> {
    if (options.installAgentSessionPatch) {
      await installAgentSessionPatch(loadAgentSessionModule);
    } else {
      patchFailureReason = undefined;
    }

    const sendHiddenRecoveryMessage = (content: string, details?: RetryRecoveryMessageDetails) =>
      pi.sendMessage(
        { customType: PI_RETRY_RECOVERY_CUSTOM_TYPE, content, display: false, details },
        { triggerTurn: true },
      );

    const sendRoutedRecoveryMessage = (content: string, details?: RetryRecoveryMessageDetails) => {
      if ('premature-abandonment' === details?.kind) {
        pi.sendUserMessage(content);
        return;
      }
      sendHiddenRecoveryMessage(content, details);
    };

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

      if ('stranded-tool-results' === candidate.kind) {
        const details: RetryRecoveryMessageDetails = {
          version: 1,
          displayHint: 'linear-replacement',
          kind: candidate.kind,
          messageKind: 'continue',
          attempt: 1,
          expectedLeafId: candidate.entryId,
        };
        pi.sendMessage(
          {
            customType: PI_RETRY_RECOVERY_CUSTOM_TYPE,
            content: 'Continue.',
            display: false,
            details,
          },
          { triggerTurn: true },
        );
        return true;
      }

      await handleRefusalRecovery({
        event: { messages: [candidate.message] },
        ctx,
        patchedSession: { sessionManager: ctx.sessionManager as any },
        reviewRewrite: requestRefusalRewrite,
        sendUserMessage: sendRoutedRecoveryMessage,
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

    // Filter hidden retry-recovery custom messages out of the LLM context on
    // every call. This replaces the older `SessionManager.buildSessionContext`
    // prototype patch. `agent.state.messages` may still contain recovery
    // entries after a session is restored, but the LLM itself never sees more
    // than the most recent one (kept when it is the current leaf).
    pi.on('context', async (event, ctx) => {
      const sessionManagerLike = ctx.sessionManager as unknown as {
        getBranch?: () => Array<Record<string, any>>;
        getLeafId?: () => string | undefined;
      };
      const pathEntries =
        typeof sessionManagerLike.getBranch === 'function' ? sessionManagerLike.getBranch() : [];
      const leafId =
        typeof sessionManagerLike.getLeafId === 'function'
          ? sessionManagerLike.getLeafId()
          : undefined;
      const input: SessionContextLike = {
        messages: event.messages as unknown as SessionContextLike['messages'],
        thinkingLevel: 'off',
        model: null,
      };
      const filtered = filterSessionContextForRetryDisplay(input, pathEntries, leafId);
      if (filtered.messages === input.messages) {
        return undefined;
      }
      return { messages: filtered.messages as unknown as typeof event.messages };
    });

    // Capture `{ sessionManager }` in the runtime's per-session stash so
    // downstream helpers (e.g. dispatchPendingRecovery's expected-leaf
    // check) can reach the same SessionManager without relying on a
    // prototype patch. This used to be done from the patched `_emit`; now
    // it happens on every normal lifecycle boundary.
    const stashSessionReference = (ctx: ExtensionContext) => {
      registerPatchedSession({ sessionManager: ctx.sessionManager as any });
    };

    const rememberLengthTruncationCandidate = (ctx: ExtensionContext): void => {
      const sessionId = ctx.sessionManager.getSessionId();
      pendingLengthTruncationBySessionId.set(sessionId, {
        failedEntryId: ctx.sessionManager.getLeafId() ?? undefined,
      });
    };

    const queueLengthTruncationRecoveryAfterCompaction = (
      event: { compactionEntry?: { id?: unknown } },
      ctx: ExtensionContext,
    ): void => {
      const sessionId = ctx.sessionManager.getSessionId();
      const pending = pendingLengthTruncationBySessionId.get(sessionId);
      if (!pending) {
        return;
      }

      pendingLengthTruncationBySessionId.delete(sessionId);
      if (refusalRecoveryDisabled()) {
        return;
      }

      const currentAttempts = lengthTruncationRecoveryAttemptsBySessionId.get(sessionId) ?? 0;
      if (currentAttempts >= LENGTH_TRUNCATION_MAX_RECOVERY_ATTEMPTS) {
        if (ctx.hasUI) {
          ctx.ui.notify('pi-retry stopped length-truncation recovery after one attempt', 'warning');
        }
        return;
      }

      const compactionLeafId =
        'string' === typeof event.compactionEntry?.id
          ? event.compactionEntry.id
          : ctx.sessionManager.getLeafId();
      if (!compactionLeafId) {
        return;
      }

      const nextAttempt = currentAttempts + 1;
      lengthTruncationRecoveryAttemptsBySessionId.set(sessionId, nextAttempt);

      const details: RetryRecoveryMessageDetails = {
        version: 1,
        displayHint: 'linear-replacement',
        kind: 'length-truncated',
        messageKind: 'continue',
        attempt: nextAttempt,
        expectedLeafId: compactionLeafId,
        replacement: {
          supersedesEntryId: pending.failedEntryId,
          parentEntryId: compactionLeafId,
        },
      };

      setPendingRecovery(sessionId, {
        kind: 'length-truncated',
        message: LENGTH_TRUNCATION_CONTINUE_MESSAGE,
        expectedLeafId: compactionLeafId,
        details,
      });

      const queuedRecovery = getQueuedRecovery(sessionId);
      if (queuedRecovery && ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, buildRecoveryStatus(queuedRecovery));
      }
      schedulePendingRecoveryDispatch(sessionId, ctx, pi);
    };

    const sameTerminalLeaf = (
      expected: NonNullable<ReturnType<typeof detectRetryableTerminalLeaf>>,
      ctx: ExtensionContext,
    ): NonNullable<ReturnType<typeof detectRetryableTerminalLeaf>> | undefined => {
      if (expected.entryId && ctx.sessionManager.getLeafId() !== expected.entryId) {
        return undefined;
      }
      const current = detectRetryableTerminalLeaf(ctx.sessionManager as any);
      if (!current || current.kind !== expected.kind || current.entryId !== expected.entryId) {
        return undefined;
      }
      return current;
    };

    const dispatchTerminalFallbackRecovery = async (
      candidate: NonNullable<ReturnType<typeof detectRetryableTerminalLeaf>>,
      ctx: ExtensionContext,
    ): Promise<void> => {
      const current = sameTerminalLeaf(candidate, ctx);
      if (!current) {
        return;
      }

      const sessionId = ctx.sessionManager.getSessionId();
      if (current.kind === 'stranded-tool-results') {
        const details: RetryRecoveryMessageDetails = {
          version: 1,
          displayHint: 'linear-replacement',
          kind: current.kind,
          messageKind: 'continue',
          attempt: 1,
          expectedLeafId: current.entryId,
        };
        setPendingRecovery(sessionId, {
          kind: current.kind,
          message: 'Continue.',
          expectedLeafId: current.entryId,
          details,
        });
        const queuedRecovery = getQueuedRecovery(sessionId);
        if (queuedRecovery && ctx.hasUI) {
          ctx.ui.setStatus(STATUS_KEY, buildRecoveryStatus(queuedRecovery));
        }
      } else {
        await handleRefusalRecovery({
          event: { messages: [current.message] },
          ctx,
          patchedSession: { sessionManager: ctx.sessionManager as any },
          reviewRewrite: requestRefusalRewrite,
          sendUserMessage: sendRoutedRecoveryMessage,
          dispatchMode: 'pending',
        });
      }

      if (getPendingRecovery(sessionId)) {
        await dispatchPendingRecovery({
          sessionId,
          sendUserMessage: sendRoutedRecoveryMessage,
          ui: createDispatchRecoveryUi(ctx),
        });
      }
    };

    const scheduleTerminalFallbackRecovery = (
      candidate: NonNullable<ReturnType<typeof detectRetryableTerminalLeaf>>,
      ctx: ExtensionContext,
    ): void => {
      const sessionId = ctx.sessionManager.getSessionId();
      if (recoveryFallbackTimerBySessionId.has(sessionId)) {
        return;
      }

      const scheduleTick = (delayMs: number) => {
        const timer = setTimeout(() => void tick(), delayMs);
        timer.unref?.();
        recoveryFallbackTimerBySessionId.set(sessionId, timer);
      };

      const tick = async () => {
        recoveryFallbackTimerBySessionId.delete(sessionId);
        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
          scheduleTick(RECOVERY_DISPATCH_IDLE_POLL_DELAY_MS);
          return;
        }
        if (getPendingRecovery(sessionId)) {
          schedulePendingRecoveryDispatch(sessionId, ctx, pi);
          return;
        }
        try {
          await dispatchTerminalFallbackRecovery(candidate, ctx);
        } catch {
          // Keep terminal fallback best-effort. The retryable leaf remains in the session
          // for manual /retry if a custom extension or review model fails during dispatch.
        }
      };

      scheduleTick(RECOVERY_FALLBACK_QUIET_WINDOW_MS);
    };

    pi.on('session_start', async (event, ctx) => {
      bindStatusUi(ctx);
      stashSessionReference(ctx);
      maybeWarnAboutPatchFailure(ctx);

      if (!shouldPromptOnSessionStart(event as unknown as Record<string, unknown>)) {
        return;
      }

      if (!ctx.hasUI || isSubagentChildProcess() || refusalRecoveryDisabled()) {
        return;
      }

      await promptAndRecoverCurrentLeaf(ctx);
    });

    pi.on('input', async (event, ctx) => {
      bindStatusUi(ctx);
      stashSessionReference(ctx);
      maybeWarnAboutPatchFailure(ctx);
      if ('extension' === event.source) {
        return;
      }
      clearRecoveryForSession(ctx.sessionManager.getSessionId());
    });

    pi.on('session_compact', async (event, ctx) => {
      bindStatusUi(ctx);
      stashSessionReference(ctx);
      maybeWarnAboutPatchFailure(ctx);
      queueLengthTruncationRecoveryAfterCompaction(event as any, ctx);
    });

    pi.on('before_agent_start', async (_event, ctx) => {
      bindStatusUi(ctx);
      stashSessionReference(ctx);
      maybeWarnAboutPatchFailure(ctx);
      bindAbortCleanup(ctx.sessionManager.getSessionId(), ctx);
    });

    pi.on('agent_start', async (_event, ctx) => {
      bindStatusUi(ctx);
      stashSessionReference(ctx);
      maybeWarnAboutPatchFailure(ctx);
      bindAbortCleanup(ctx.sessionManager.getSessionId(), ctx);
    });

    pi.on('turn_end', async (event, ctx) => {
      if ('assistant' !== event.message?.role) {
        return;
      }

      const sessionId = ctx.sessionManager.getSessionId();
      const hasToolResults = 0 < (event.toolResults?.length ?? 0);
      const hasPendingMessages = ctx.hasPendingMessages();

      if (isLengthTruncatedAssistantMessage(event.message)) {
        if (!hasToolResults && !hasPendingMessages && !refusalRecoveryDisabled()) {
          rememberLengthTruncationCandidate(ctx);
        }
        return;
      }

      if (hasUserVisibleAssistantOutput(event.message?.content)) {
        clearLengthTruncationRecoveryForSession(sessionId);
      }

      if (!['stop', 'error'].includes(event.message?.stopReason ?? '')) {
        return;
      }

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

      if (refusalRecoveryDisabled() || event.message?.stopReason === 'stop') {
        return;
      }

      const retryableProviderErrorReason = getRetryableProviderErrorReason(
        event.message as AssistantErrorLike,
      );
      const shouldDispatchImmediately =
        retryableProviderErrorReason !== undefined &&
        (!ctx.hasUI || requiresPiRetryOwnedRecovery(retryableProviderErrorReason));

      await handleRefusalRecovery({
        event: { messages: [event.message] },
        ctx,
        patchedSession: { sessionManager: ctx.sessionManager as any },
        reviewRewrite: requestRefusalRewrite,
        sendUserMessage: sendRoutedRecoveryMessage,
        dispatchMode: shouldDispatchImmediately ? 'immediate' : 'pending',
      });
    });

    pi.on('tool_execution_end', async (event, ctx) => {
      if (true !== (event as { result?: { terminate?: unknown } }).result?.terminate) {
        return;
      }
      rememberTerminatingToolCall(ctx.sessionManager.getSessionId(), event.toolCallId);
    });

    pi.on('message_end', async (event, ctx) => {
      const message = event.message as unknown as Record<string, unknown>;
      if ('assistant' === message.role) {
        const normalized = normalizeInvalidOpenAIResponsesStop(message);
        if (normalized) {
          return { message: normalized as unknown as typeof event.message };
        }
      }

      if ('toolResult' === message.role) {
        if (isTerminatingToolResult(ctx.sessionManager.getSessionId(), message)) {
          return {
            message: markTerminatingToolResultMessage(message) as unknown as typeof event.message,
          };
        }
        return;
      }

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
      bindStatusUi(ctx);
      stashSessionReference(ctx);
      const sessionId = ctx.sessionManager.getSessionId();
      const messages =
        (event as unknown as { messages?: Array<Record<string, unknown>> }).messages ?? [];
      const lastAssistant = getFinalAssistantMessage(messages);
      const willRetry = shouldTreatAsCoreWillRetry(
        event as unknown as { willRetry?: unknown },
        ctx,
        lastAssistant,
      );

      if (willRetry) {
        clearRecoveryForSession(sessionId);
      } else {
        if (!getPendingRecovery(sessionId) && !refusalRecoveryDisabled()) {
          const candidate = detectRetryableTerminalLeaf(ctx.sessionManager as any);
          if (candidate) {
            scheduleTerminalFallbackRecovery(candidate, ctx);
          }
        }

        if (getPendingRecovery(sessionId)) {
          schedulePendingRecoveryDispatch(sessionId, ctx, pi);
        }
      }

      // Branch the failed leaf out of the main path BEFORE the core's
      // `_handleRetryableError` fires a retry. Extension agent_end is awaited
      // inside `_processAgentEvent` before the retry path runs, so by the
      // time the retry emits `auto_retry_start` and calls `agent.continue()`
      // the SessionManager's leaf already points at the error's parent.
      // The retry's new message therefore lands as a sibling of the error
      // rather than a child of it, preserving the same session-tree shape
      // the old `_emit` prototype patch produced.
      if (!lastAssistant) {
        return;
      }
      const lastAssistantLike = lastAssistant as unknown as AssistantErrorLike;
      if (!isBranchableRetryableError(lastAssistantLike)) {
        return;
      }
      const reason =
        classifyRetryableProviderError(lastAssistantLike.errorMessage) ?? 'providerServerError';
      branchLatestAssistantErrorOutOfMainPath(
        { sessionManager: ctx.sessionManager as any },
        {
          attempt: 0,
          errorMessage: lastAssistantLike.errorMessage ?? '',
          reason,
        },
      );
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
