import type { Model } from '@mariozechner/pi-ai';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';

import {
  buildRefusalStatus,
  buildReviewTranscript,
  extractTextContent,
  isLikelyRefusalText,
  pickReviewModels,
} from './refusal-review';

const DEFAULT_REFUSAL_CONTINUE_ATTEMPTS = 5;
const DEFAULT_REFUSAL_REWRITE_ATTEMPTS = 2;
const MAX_EMPTY_RESPONSE_CONTINUE_ATTEMPTS = 3;
const CONTINUE_RETRY_MESSAGE = 'Continue.';
const CONTINUE_RETRY_STATUS = '↻ Refusal detected; retrying...';
const EMPTY_RESPONSE_RETRY_STATUS = '↻ Empty assistant response; retrying with Continue...';
const RETRYABLE_ERROR_CONTINUE_STATUS = '↻ Retryable error detected; retrying with Continue...';
const CONTINUE_SENT_WAITING_STATUS = '↻ Continue sent; waiting for recovery...';
const REWRITE_SENT_WAITING_STATUS = '↻ Rewrite sent; waiting for recovery...';
const RETRY_SUCCESS_STATUS = '✓ Recovered; continuing...';
const RETRY_SUCCESS_STATUS_DURATION_MS = 4000;
const REFUSAL_CONTINUE_ATTEMPTS_ENV_VAR = 'PI_RETRY_REFUSAL_CONTINUE_ATTEMPTS';
const REFUSAL_REWRITE_ATTEMPTS_ENV_VAR = 'PI_RETRY_REFUSAL_REWRITE_ATTEMPTS';
const REFUSAL_REWRITES_DISABLED_ENV_VAR = 'PI_RETRY_REFUSAL_REWRITES_DISABLED';

export const STOCK_REFUSAL_CONTINUE_MESSAGES = [
  'Continue.',
  'Please continue with the same task.',
  'Please continue from where you left off.',
  'Keep going with the same request.',
  'Please proceed and provide the best helpful answer you can for the same task.',
] as const;

type RetryableProviderErrorReason =
  | 'deploymentMissing'
  | 'encryptedContentVerification'
  | 'nativeCompactionCreatedBy'
  | 'providerServerError';

export const PI_RETRY_RECOVERY_CUSTOM_TYPE = 'pi-retry-recovery';

interface SessionManagerLike {
  getSessionId?: () => string | undefined;
  getEntries?: () => Array<{
    id?: string;
    parentId?: string;
    type?: string;
    message?: {
      role?: string;
      stopReason?: string;
      content?: unknown;
      errorMessage?: string;
      usage?: unknown;
    };
    customType?: string;
    data?: unknown;
  }>;
  getLeafId?: () => string | undefined;
  branch?: (entryId: string) => void;
  appendCustomEntry?: (customType: string, data: Record<string, unknown>) => void;
  _buildIndex?: () => void;
  _rewriteFile?: () => void;
}

interface PatchedSessionLike {
  sessionManager?: SessionManagerLike;
}

interface AssistantMessageLike {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  usage?: unknown;
}

type RecoveryMessageKind = 'continue' | 'rewrite';

export interface RetryRecoveryMessageDetails {
  version: 1;
  displayHint: 'linear-replacement';
  kind: PendingRecovery['kind'];
  messageKind: RecoveryMessageKind;
  attempt: number;
  expectedLeafId?: string;
  replacement?: {
    supersedesEntryId?: string;
    parentEntryId?: string;
  };
}

export interface PendingRecovery {
  kind: 'empty-stop' | 'refusal' | 'retryable-error';
  message: string;
  expectedLeafId?: string;
  details?: RetryRecoveryMessageDetails;
}

interface RetryableTerminalLeaf {
  kind: PendingRecovery['kind'];
  entryId?: string;
  parentEntryId?: string;
  message: AssistantMessageLike;
}

type RecoveryPhase = 'queued' | 'sent' | 'reviewing';

interface ActiveRecovery {
  kind: PendingRecovery['kind'];
  phase: RecoveryPhase;
  attempt: number;
  messageKind: RecoveryMessageKind;
  maxAttempts?: number;
  reviewModelId?: string;
  recoveryMessage?: string;
  expectedLeafId?: string;
  details?: RetryRecoveryMessageDetails;
}

interface RefusalRecoveryProgress {
  continueAttempts: number;
  rewriteAttempts: number;
  lastContinueMessage?: string;
}

interface SessionRuntimeState {
  activeRecovery?: ActiveRecovery;
  refusalProgress?: RefusalRecoveryProgress;
  session?: PatchedSessionLike;
}

type NotificationType = 'info' | 'warning' | 'error';

interface RecoveryUi {
  setStatus(text: string): void;
  clearStatus(): void;
  notify(message: string, type: NotificationType): void;
}

const stateBySessionId = new Map<string, SessionRuntimeState>();
const successStatusTimeoutBySessionId = new Map<string, ReturnType<typeof setTimeout>>();

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return '1' === normalized || 'true' === normalized || 'yes' === normalized;
}

function parsePositiveIntEnv(varName: string, fallback: number): number {
  const raw = process.env[varName]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && 0 < parsed ? parsed : fallback;
}

function getConfiguredRefusalContinueAttempts(): number {
  return parsePositiveIntEnv(REFUSAL_CONTINUE_ATTEMPTS_ENV_VAR, DEFAULT_REFUSAL_CONTINUE_ATTEMPTS);
}

function getConfiguredRefusalRewriteAttempts(): number {
  return parsePositiveIntEnv(REFUSAL_REWRITE_ATTEMPTS_ENV_VAR, DEFAULT_REFUSAL_REWRITE_ATTEMPTS);
}

function refusalRewritesDisabled(): boolean {
  return isTruthyEnv(process.env[REFUSAL_REWRITES_DISABLED_ENV_VAR]);
}

export function pickStockContinueMessage(input?: {
  previousMessage?: string;
  random?: () => number;
}): string {
  const random = input?.random ?? Math.random;
  const previousMessage = input?.previousMessage;
  const candidates =
    previousMessage && 1 < STOCK_REFUSAL_CONTINUE_MESSAGES.length
      ? STOCK_REFUSAL_CONTINUE_MESSAGES.filter((message) => message !== previousMessage)
      : [...STOCK_REFUSAL_CONTINUE_MESSAGES];

  const pool = 0 < candidates.length ? candidates : [...STOCK_REFUSAL_CONTINUE_MESSAGES];
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[index] ?? CONTINUE_RETRY_MESSAGE;
}

export function classifyRetryableProviderError(
  errorMessage: string | undefined,
): RetryableProviderErrorReason | undefined {
  if (!errorMessage) {
    return undefined;
  }

  const text = errorMessage.toLowerCase();

  if (text.includes('api deployment for this resource does not exist')) {
    return 'deploymentMissing';
  }

  if (text.includes('encrypted content') && text.includes('could not be verified')) {
    return 'encryptedContentVerification';
  }

  if (text.includes('unknown parameter') && text.includes('created_by')) {
    return 'nativeCompactionCreatedBy';
  }

  if (
    text.includes('currently experiencing high demand') &&
    text.includes('peak load') &&
    text.includes('provisioned throughput')
  ) {
    return 'providerServerError';
  }

  if (text.includes('server had an error processing your request')) {
    return 'providerServerError';
  }

  if (text.includes('model produced invalid content')) {
    return 'providerServerError';
  }

  if (text.includes('unknown error (no error details in response)')) {
    return 'providerServerError';
  }

  return undefined;
}

function cancelScheduledSuccessStatusClear(sessionId: string): void {
  const timeout = successStatusTimeoutBySessionId.get(sessionId);
  if (timeout === undefined) {
    return;
  }

  clearTimeout(timeout);
  successStatusTimeoutBySessionId.delete(sessionId);
}

function scheduleSuccessStatusClear(sessionId: string, ui: RecoveryUi): void {
  cancelScheduledSuccessStatusClear(sessionId);
  successStatusTimeoutBySessionId.set(
    sessionId,
    setTimeout(() => {
      successStatusTimeoutBySessionId.delete(sessionId);
      ui.clearStatus();
    }, RETRY_SUCCESS_STATUS_DURATION_MS),
  );
}

function getOrCreateSessionState(sessionId: string): SessionRuntimeState {
  let state = stateBySessionId.get(sessionId);
  if (!state) {
    state = {};
    stateBySessionId.set(sessionId, state);
  }
  return state;
}

function pruneSessionState(sessionId: string): void {
  const state = stateBySessionId.get(sessionId);
  if (!state) {
    return;
  }

  if (
    state.activeRecovery === undefined &&
    state.refusalProgress === undefined &&
    state.session === undefined
  ) {
    stateBySessionId.delete(sessionId);
  }
}

function getOrCreateRefusalProgress(sessionId: string): RefusalRecoveryProgress {
  const state = getOrCreateSessionState(sessionId);
  state.refusalProgress ??= {
    continueAttempts: 0,
    rewriteAttempts: 0,
  };
  return state.refusalProgress;
}

function getRefusalProgress(sessionId: string): RefusalRecoveryProgress | undefined {
  return stateBySessionId.get(sessionId)?.refusalProgress;
}

function rememberRefusalContinueAttempt(sessionId: string, message: string): number {
  const progress = getOrCreateRefusalProgress(sessionId);
  progress.continueAttempts += 1;
  progress.lastContinueMessage = message;
  return progress.continueAttempts;
}

function rememberRefusalRewriteAttempt(sessionId: string): number {
  const progress = getOrCreateRefusalProgress(sessionId);
  progress.rewriteAttempts += 1;
  return progress.rewriteAttempts;
}

export function formatRecoveryAttemptSuffix(attempt: number, maxAttempts: number): string {
  return attempt <= 1 ? '' : ` · ${attempt}/${maxAttempts}`;
}

function isContinueRecoveryMessage(message: string): boolean {
  return (
    CONTINUE_RETRY_MESSAGE === message || STOCK_REFUSAL_CONTINUE_MESSAGES.includes(message as any)
  );
}

function getRecoveryAttemptLimit(
  recovery: Pick<ActiveRecovery, 'kind' | 'messageKind' | 'maxAttempts'>,
): number {
  if (recovery.maxAttempts !== undefined) {
    return recovery.maxAttempts;
  }

  if ('empty-stop' === recovery.kind) {
    return MAX_EMPTY_RESPONSE_CONTINUE_ATTEMPTS;
  }

  if ('refusal' !== recovery.kind) {
    return 1;
  }

  return 'continue' === recovery.messageKind
    ? getConfiguredRefusalContinueAttempts()
    : getConfiguredRefusalRewriteAttempts();
}

function buildReviewStatusWithAttempt(
  modelId: string,
  attempt: number,
  maxAttempts: number,
): string {
  return `${buildRefusalStatus(modelId, 'review')}${formatRecoveryAttemptSuffix(
    attempt,
    maxAttempts,
  )}`;
}

function buildRewriteQueuedStatus(modelId: string, attempt: number, maxAttempts: number): string {
  return `${buildRefusalStatus(modelId, 'rewrite')}${formatRecoveryAttemptSuffix(
    attempt,
    maxAttempts,
  )}`;
}

function buildSentRecoveryStatus(recovery: ActiveRecovery): string {
  const suffix = formatRecoveryAttemptSuffix(recovery.attempt, getRecoveryAttemptLimit(recovery));

  return 'rewrite' === recovery.messageKind
    ? `${REWRITE_SENT_WAITING_STATUS}${suffix}`
    : `${CONTINUE_SENT_WAITING_STATUS}${suffix}`;
}

export function buildRecoveryStatus(recovery: ActiveRecovery): string {
  const maxAttempts = getRecoveryAttemptLimit(recovery);

  if ('reviewing' === recovery.phase && recovery.reviewModelId) {
    return buildReviewStatusWithAttempt(recovery.reviewModelId, recovery.attempt, maxAttempts);
  }

  if ('sent' === recovery.phase) {
    return buildSentRecoveryStatus(recovery);
  }

  if ('rewrite' === recovery.messageKind && recovery.reviewModelId) {
    return buildRewriteQueuedStatus(recovery.reviewModelId, recovery.attempt, maxAttempts);
  }

  const suffix = formatRecoveryAttemptSuffix(recovery.attempt, maxAttempts);

  switch (recovery.kind) {
    case 'empty-stop':
      return `${EMPTY_RESPONSE_RETRY_STATUS}${suffix}`;
    case 'retryable-error':
      return RETRYABLE_ERROR_CONTINUE_STATUS;
    default:
      return `${CONTINUE_RETRY_STATUS}${suffix}`;
  }
}

function getActiveRecovery(sessionId: string): ActiveRecovery | undefined {
  return stateBySessionId.get(sessionId)?.activeRecovery;
}

function setActiveRecovery(sessionId: string, recovery: ActiveRecovery | undefined): void {
  const state = getOrCreateSessionState(sessionId);
  state.activeRecovery = recovery;
  pruneSessionState(sessionId);
}

function applyActiveRecoveryStatus(sessionId: string, ui: RecoveryUi | undefined): void {
  if (!ui) {
    return;
  }

  const recovery = getActiveRecovery(sessionId);
  if (!recovery) {
    ui.clearStatus();
    return;
  }

  ui.setStatus(buildRecoveryStatus(recovery));
}

function createRecoveryUi(ctx: ExtensionContext): RecoveryUi {
  if (!ctx?.hasUI || !ctx.ui) {
    return {
      setStatus: () => {},
      clearStatus: () => {},
      notify: () => {},
    };
  }

  return {
    setStatus(text: string) {
      ctx.ui.setStatus('pi-retry', text);
    },
    clearStatus() {
      ctx.ui.setStatus('pi-retry', undefined);
    },
    notify(message: string, type: NotificationType) {
      ctx.ui.notify(message, type);
    },
  };
}

function getLatestUserText(session: PatchedSessionLike): string {
  const entries = session?.sessionManager?.getEntries?.() ?? [];
  for (let i = entries.length - 1; 0 <= i; i--) {
    const entry = entries[i];
    if ('message' !== entry?.type || 'user' !== entry.message?.role) {
      continue;
    }

    const text = extractTextContent(entry.message.content);
    if (text) {
      return text;
    }
  }

  return '';
}

function getFinalAssistantMessage(messages: unknown[]): AssistantMessageLike | undefined {
  return [...messages]
    .reverse()
    .find(
      (message): message is AssistantMessageLike =>
        'object' === typeof message &&
        null !== message &&
        'role' in message &&
        'assistant' === message.role,
    );
}

function isTerminalAssistantMessageEntry(
  entry: ReturnType<NonNullable<SessionManagerLike['getEntries']>>[number] | undefined,
): boolean {
  return (
    'message' === entry?.type &&
    'assistant' === entry.message?.role &&
    ['stop', 'error'].includes(entry.message?.stopReason ?? '')
  );
}

function getRecoveryMessageKind(message: string): RecoveryMessageKind {
  return isContinueRecoveryMessage(message) ? 'continue' : 'rewrite';
}

export function clearRuntimeState(): void {
  for (const sessionId of successStatusTimeoutBySessionId.keys()) {
    cancelScheduledSuccessStatusClear(sessionId);
  }

  stateBySessionId.clear();
}

export function registerPatchedSession(session: PatchedSessionLike): void {
  const sessionId = session?.sessionManager?.getSessionId?.();
  if (!sessionId) {
    return;
  }

  getOrCreateSessionState(sessionId).session = session;
}

export function unregisterPatchedSession(sessionId: string): void {
  const state = stateBySessionId.get(sessionId);
  if (!state) {
    return;
  }

  state.session = undefined;
  pruneSessionState(sessionId);
}

export function getQueuedRecovery(sessionId: string): ActiveRecovery | undefined {
  const recovery = getActiveRecovery(sessionId);
  return 'queued' === recovery?.phase ? recovery : undefined;
}

export function getPendingRecovery(sessionId: string): PendingRecovery | undefined {
  const recovery = getQueuedRecovery(sessionId);
  if (!recovery?.recoveryMessage) {
    return undefined;
  }

  return {
    kind: recovery.kind,
    message: recovery.recoveryMessage,
    expectedLeafId: recovery.expectedLeafId,
    details: recovery.details,
  };
}

/**
 * Accessed dynamically from tests via `(runtime as any).setPendingRecovery?.()`.
 * @lintignore
 */
export function setPendingRecovery(sessionId: string, recovery: PendingRecovery): void {
  const messageKind = getRecoveryMessageKind(recovery.message);
  setActiveRecovery(sessionId, {
    kind: recovery.kind,
    phase: 'queued',
    attempt: 1,
    messageKind,
    maxAttempts: getRecoveryAttemptLimit({
      kind: recovery.kind,
      messageKind,
    } as Pick<ActiveRecovery, 'kind' | 'messageKind' | 'maxAttempts'>),
    recoveryMessage: recovery.message,
    expectedLeafId: recovery.expectedLeafId,
    details: recovery.details,
  });
}

function createRecoveryMessageDetails(input: {
  kind: PendingRecovery['kind'];
  messageKind: RecoveryMessageKind;
  attempt: number;
  expectedLeafId?: string;
  failedEntryId?: string;
  parentEntryId?: string;
}): RetryRecoveryMessageDetails {
  return {
    version: 1,
    displayHint: 'linear-replacement',
    kind: input.kind,
    messageKind: input.messageKind,
    attempt: input.attempt,
    expectedLeafId: input.expectedLeafId,
    replacement:
      input.failedEntryId || input.parentEntryId
        ? {
            supersedesEntryId: input.failedEntryId,
            parentEntryId: input.parentEntryId,
          }
        : undefined,
  };
}

export function getRefusalAttempt(sessionId: string): number {
  return getRefusalProgress(sessionId)?.rewriteAttempts ?? 0;
}

export function getRefusalContinueAttempt(sessionId: string): number {
  return getRefusalProgress(sessionId)?.continueAttempts ?? 0;
}

export function setRefusalAttempt(sessionId: string, attempt: number): void {
  if (attempt <= 0) {
    clearRecoveryState(sessionId);
    return;
  }

  const progress = getOrCreateRefusalProgress(sessionId);
  progress.rewriteAttempts = attempt;

  setActiveRecovery(sessionId, {
    kind: 'refusal',
    phase: 'reviewing',
    attempt,
    messageKind: 'rewrite',
    maxAttempts: getConfiguredRefusalRewriteAttempts(),
  });
}

function getEmptyResponseContinueAttempts(sessionId: string): number {
  const recovery = getActiveRecovery(sessionId);
  return 'empty-stop' === recovery?.kind ? recovery.attempt : 0;
}

function clearRecoveryState(sessionId: string): void {
  const state = stateBySessionId.get(sessionId);
  cancelScheduledSuccessStatusClear(sessionId);
  if (!state) {
    return;
  }

  state.activeRecovery = undefined;
  state.refusalProgress = undefined;
  pruneSessionState(sessionId);
}

export function handleRecoveryAbort(sessionId: string): void {
  clearRecoveryState(sessionId);
}

export function clearRefusalStatus(sessionId: string): void {
  cancelScheduledSuccessStatusClear(sessionId);
}

function appendDebugEntry(_session: PatchedSessionLike, _data: { [key: string]: unknown }): void {
  // Session-persisted debug logging intentionally disabled.
}

function parseEncryptedThinkingSignature(signature: string | undefined): boolean {
  if (!signature) {
    return false;
  }

  try {
    const parsed = JSON.parse(signature) as { encrypted_content?: unknown };
    return typeof parsed === 'object' && parsed !== null && 'encrypted_content' in parsed;
  } catch {
    return false;
  }
}

export function sanitizeEncryptedReasoningOnCurrentBranch(session: PatchedSessionLike): {
  sanitizedMessages: number;
  sanitizedBlocks: number;
} {
  const sessionManager = session?.sessionManager;
  const leafId = sessionManager?.getLeafId?.();
  const entries = sessionManager?.getEntries?.() ?? [];
  if (!leafId || 0 === entries.length) {
    return { sanitizedMessages: 0, sanitizedBlocks: 0 };
  }

  const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id!, entry]));
  const branchIds = new Set<string>();
  let currentId: string | undefined = leafId;
  while (currentId) {
    branchIds.add(currentId);
    const entry = byId.get(currentId);
    currentId = entry?.parentId;
  }

  let sanitizedMessages = 0;
  let sanitizedBlocks = 0;

  for (const entry of entries) {
    if (!entry.id || !branchIds.has(entry.id)) {
      continue;
    }
    if ('message' !== entry.type || 'assistant' !== entry.message?.role) {
      continue;
    }
    if (!Array.isArray(entry.message.content)) {
      continue;
    }

    let entrySanitized = false;
    for (const block of entry.message.content as Array<{
      type?: string;
      thinkingSignature?: string;
    }>) {
      if ('thinking' !== block?.type || !parseEncryptedThinkingSignature(block.thinkingSignature)) {
        continue;
      }

      delete block.thinkingSignature;
      sanitizedBlocks += 1;
      entrySanitized = true;
    }

    if (entrySanitized) {
      sanitizedMessages += 1;
    }
  }

  if (0 < sanitizedBlocks) {
    sessionManager?._buildIndex?.();
    sessionManager?._rewriteFile?.();
  }

  return { sanitizedMessages, sanitizedBlocks };
}

function stripKeyFromStructuredValue(value: unknown, keyToStrip: string): [unknown, boolean] {
  if (
    value === undefined ||
    value === null ||
    'string' === typeof value ||
    'number' === typeof value ||
    'boolean' === typeof value
  ) {
    return [value, false];
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const [sanitized, itemChanged] = stripKeyFromStructuredValue(item, keyToStrip);
      changed ||= itemChanged;
      return sanitized;
    });
    return [next, changed];
  }

  if (value && 'object' === typeof value) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key === keyToStrip) {
        changed = true;
        continue;
      }
      const [sanitized, nestedChanged] = stripKeyFromStructuredValue(nested, keyToStrip);
      changed ||= nestedChanged;
      next[key] = sanitized;
    }
    return [next, changed];
  }

  return [value, false];
}

function sanitizeNativeCompactionReplayMetadataOnCurrentBranch(session: PatchedSessionLike): {
  sanitizedCompactions: number;
  sanitizedItems: number;
} {
  const sessionManager = session?.sessionManager;
  const leafId = sessionManager?.getLeafId?.();
  const entries = sessionManager?.getEntries?.() ?? [];
  if (!leafId || 0 === entries.length) {
    return { sanitizedCompactions: 0, sanitizedItems: 0 };
  }

  const byId = new Map(entries.filter((entry) => entry.id).map((entry) => [entry.id!, entry]));
  const branchIds = new Set<string>();
  let currentId: string | undefined = leafId;
  while (currentId) {
    branchIds.add(currentId);
    const entry = byId.get(currentId);
    currentId = entry?.parentId;
  }

  let sanitizedCompactions = 0;
  let sanitizedItems = 0;

  for (const entry of entries as Array<Record<string, any>>) {
    if (!entry.id || !branchIds.has(entry.id)) {
      continue;
    }
    if ('compaction' !== entry.type) {
      continue;
    }

    const compactedWindow = entry.details?.compactedWindow;
    if (!Array.isArray(compactedWindow)) {
      continue;
    }

    let entryChanged = false;
    const sanitizedWindow = compactedWindow.map((item: unknown) => {
      const [sanitized, changed] = stripKeyFromStructuredValue(item, 'created_by');
      if (changed) {
        sanitizedItems += 1;
        entryChanged = true;
      }
      return sanitized;
    });

    if (entryChanged) {
      entry.details.compactedWindow = sanitizedWindow;
      sanitizedCompactions += 1;
    }
  }

  if (0 < sanitizedItems) {
    sessionManager?._buildIndex?.();
    sessionManager?._rewriteFile?.();
  }

  return { sanitizedCompactions, sanitizedItems };
}

function branchLatestAssistantLeafOutOfMainPath(
  session: PatchedSessionLike,
  options: {
    stopReason: 'error' | 'stop' | 'aborted';
    debugData: { [key: string]: unknown };
  },
): { branched: boolean; failedEntryId?: string; parentEntryId?: string } {
  const sessionManager = session?.sessionManager;
  const leafId = sessionManager?.getLeafId?.();
  const entries = sessionManager?.getEntries?.() ?? [];
  const assistantEntry = entries.find((entry) => entry.id === leafId && 'message' === entry.type);

  if (
    !assistantEntry?.message ||
    'assistant' !== assistantEntry.message.role ||
    assistantEntry.message.stopReason !== options.stopReason
  ) {
    return { branched: false };
  }

  appendDebugEntry(session, {
    ...options.debugData,
    failedEntryId: assistantEntry.id,
    parentEntryId: assistantEntry.parentId ?? undefined,
  });

  if (assistantEntry.parentId) {
    sessionManager?.branch?.(assistantEntry.parentId);
  }

  return {
    branched: true,
    failedEntryId: assistantEntry.id,
    parentEntryId: assistantEntry.parentId ?? undefined,
  };
}

export function branchLatestAssistantErrorOutOfMainPath(
  session: PatchedSessionLike,
  payload: { attempt: number; errorMessage: string; reason: string },
): { branched: boolean; failedEntryId?: string; parentEntryId?: string } {
  return branchLatestAssistantLeafOutOfMainPath(session, {
    stopReason: 'error',
    debugData: {
      kind: 'provider-retry-branch',
      attempt: payload.attempt,
      errorMessage: payload.errorMessage,
      reason: payload.reason,
    },
  });
}

function branchLatestAssistantStopOutOfMainPath(
  session: PatchedSessionLike,
  refusalText: string,
  attempt: number,
  reviewModelId: string,
): { branched: boolean; failedEntryId?: string; parentEntryId?: string } {
  return branchLatestAssistantLeafOutOfMainPath(session, {
    stopReason: 'stop',
    debugData: {
      kind: 'refusal-branch',
      refusalText,
      attempt,
      reviewModelId,
    },
  });
}

type RefusalReviewFailureKind = 'auth' | 'error' | 'unusable-output';

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if ('string' === typeof error && error) {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function formatAttemptCount(count: number, noun: string): string {
  return `after ${count} ${noun}${1 === count ? '' : 's'}`;
}

function appendRefusalReviewFailure(
  session: PatchedSessionLike,
  data: {
    attempt: number;
    reviewModelId: string;
    failureKind: RefusalReviewFailureKind;
    error?: string;
  },
): void {
  appendDebugEntry(session, {
    kind: 'refusal-review-failure',
    ...data,
  });
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

export function resolveRecoveryOnAssistantMessage(
  ctx: ExtensionContext,
  message: AssistantMessageLike | undefined,
): boolean {
  if ('assistant' !== message?.role) {
    return false;
  }

  const sessionId = ctx.sessionManager.getSessionId();
  const recovery = getActiveRecovery(sessionId);
  if ('sent' !== recovery?.phase) {
    return false;
  }

  if (!hasUserVisibleAssistantOutput(message.content)) {
    return false;
  }

  const assistantText = extractTextContent(message.content);
  if (isLikelyRefusalText(assistantText)) {
    return false;
  }

  const ui = createRecoveryUi(ctx);
  clearRecoveryState(sessionId);
  ui.setStatus(RETRY_SUCCESS_STATUS);
  scheduleSuccessStatusClear(sessionId, ui);
  return true;
}

function getNearestTerminalAssistantMessageEntry(sessionManager: SessionManagerLike | undefined) {
  const leafId = sessionManager?.getLeafId?.();
  const entries = sessionManager?.getEntries?.() ?? [];
  if (!leafId || 0 === entries.length) {
    return undefined;
  }

  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  let currentEntry = entriesById.get(leafId);

  while (currentEntry) {
    if (isTerminalAssistantMessageEntry(currentEntry)) {
      return currentEntry;
    }

    currentEntry = currentEntry.parentId ? entriesById.get(currentEntry.parentId) : undefined;
  }

  return undefined;
}

export function detectRetryableTerminalLeaf(
  sessionManager: SessionManagerLike | undefined,
): RetryableTerminalLeaf | undefined {
  const leafEntry = getNearestTerminalAssistantMessageEntry(sessionManager);
  const message = leafEntry?.message;
  if (!message || 'assistant' !== message.role) {
    return undefined;
  }

  if (
    'error' === message.stopReason &&
    'string' === typeof message.errorMessage &&
    classifyRetryableProviderError(message.errorMessage)
  ) {
    return {
      kind: 'retryable-error',
      entryId: leafEntry?.id,
      parentEntryId: leafEntry?.parentId,
      message,
    };
  }

  if ('stop' !== message.stopReason) {
    return undefined;
  }

  if (!hasUserVisibleAssistantOutput(message.content)) {
    return {
      kind: 'empty-stop',
      entryId: leafEntry?.id,
      parentEntryId: leafEntry?.parentId,
      message,
    };
  }

  const refusalText = extractTextContent(message.content);
  if (!isLikelyRefusalText(refusalText)) {
    return undefined;
  }

  return {
    kind: 'refusal',
    entryId: leafEntry?.id,
    parentEntryId: leafEntry?.parentId,
    message,
  };
}

export function buildRetryableLeafPrompt(candidate: RetryableTerminalLeaf): {
  title: string;
  message: string;
} {
  switch (candidate.kind) {
    case 'empty-stop':
      return {
        title: 'pi-retry: Empty response detected',
        message:
          'This session appears to have stopped on an empty assistant response. Send Continue now?',
      };
    case 'refusal':
      return {
        title: 'pi-retry: Refusal detected',
        message: 'This session appears to have stopped on a refusal. Send Continue now?',
      };
    case 'retryable-error':
      return {
        title: 'pi-retry: Retryable error detected',
        message: 'This session appears to have stopped on a retryable error. Send Continue now?',
      };
  }
}

export async function dispatchPendingRecovery(input: {
  sessionId: string;
  sendUserMessage: (content: string, details?: RetryRecoveryMessageDetails) => void | Promise<void>;
  ui?: RecoveryUi;
}): Promise<boolean> {
  const queuedRecovery = getQueuedRecovery(input.sessionId);
  if (!queuedRecovery?.recoveryMessage) {
    return false;
  }

  const session = stateBySessionId.get(input.sessionId)?.session;
  const currentLeafId = session?.sessionManager?.getLeafId?.();
  if (
    queuedRecovery.expectedLeafId &&
    currentLeafId &&
    queuedRecovery.expectedLeafId !== currentLeafId
  ) {
    clearRecoveryState(input.sessionId);
    input.ui?.clearStatus();
    return false;
  }

  const sentRecovery: ActiveRecovery = {
    ...queuedRecovery,
    phase: 'sent',
  };

  setActiveRecovery(input.sessionId, sentRecovery);
  applyActiveRecoveryStatus(input.sessionId, input.ui);

  try {
    await input.sendUserMessage(queuedRecovery.recoveryMessage, queuedRecovery.details);
  } catch (error) {
    setActiveRecovery(input.sessionId, queuedRecovery);
    applyActiveRecoveryStatus(input.sessionId, input.ui);
    throw error;
  }

  return true;
}

export async function handleRefusalRecovery(input: {
  event: { messages: unknown[] };
  ctx: ExtensionContext;
  patchedSession: PatchedSessionLike;
  reviewRewrite: (args: {
    model: Model<any>;
    apiKey: string;
    headers?: { [key: string]: string };
    transcriptText: string;
    signal?: AbortSignal;
  }) => Promise<{ reason: string; rewrite: string } | undefined>;
  sendUserMessage: (content: string, details?: RetryRecoveryMessageDetails) => void | Promise<void>;
  dispatchMode?: 'pending' | 'immediate';
}): Promise<void> {
  const sessionId = input.ctx.sessionManager.getSessionId();
  const ui = createRecoveryUi(input.ctx);
  const dispatchMode = input.dispatchMode ?? 'pending';
  cancelScheduledSuccessStatusClear(sessionId);

  const finalAssistant = getFinalAssistantMessage(input.event.messages);
  const refusalText = extractTextContent(finalAssistant?.content);
  const isEmptyAssistantStop =
    'stop' === finalAssistant?.stopReason &&
    !hasUserVisibleAssistantOutput(finalAssistant?.content);

  const deliverRecoveryMessage = async (
    recovery: Omit<ActiveRecovery, 'phase' | 'recoveryMessage' | 'expectedLeafId'>,
    message: string,
    expectedLeafId?: string,
    details?: RetryRecoveryMessageDetails,
  ): Promise<void> => {
    const queuedRecovery: ActiveRecovery = {
      ...recovery,
      phase: 'queued',
      recoveryMessage: message,
      expectedLeafId,
      details,
    };

    if ('immediate' === dispatchMode) {
      const sentRecovery: ActiveRecovery = { ...queuedRecovery, phase: 'sent' };
      setActiveRecovery(sessionId, sentRecovery);
      applyActiveRecoveryStatus(sessionId, ui);
      try {
        await input.sendUserMessage(message, details);
      } catch (error) {
        clearRecoveryState(sessionId);
        ui.clearStatus();
        throw error;
      }
      return;
    }

    setActiveRecovery(sessionId, queuedRecovery);
    applyActiveRecoveryStatus(sessionId, ui);
  };

  if (
    'error' === finalAssistant?.stopReason &&
    'string' === typeof finalAssistant.errorMessage &&
    classifyRetryableProviderError(finalAssistant.errorMessage)
  ) {
    const reason =
      classifyRetryableProviderError(finalAssistant.errorMessage) ?? 'providerServerError';

    if ('encryptedContentVerification' === reason) {
      try {
        sanitizeEncryptedReasoningOnCurrentBranch(input.patchedSession);
      } catch (error) {
        clearRecoveryState(sessionId);
        ui.clearStatus();
        ui.notify(
          `pi-retry could not sanitize encrypted reasoning before retry: ${formatUnknownError(error)}`,
          'warning',
        );
        return;
      }
    }

    if ('nativeCompactionCreatedBy' === reason) {
      try {
        sanitizeNativeCompactionReplayMetadataOnCurrentBranch(input.patchedSession);
      } catch (error) {
        clearRecoveryState(sessionId);
        ui.clearStatus();
        ui.notify(
          `pi-retry could not sanitize native compaction replay metadata before retry: ${formatUnknownError(error)}`,
          'warning',
        );
        return;
      }
    }

    const branchResult = branchLatestAssistantErrorOutOfMainPath(input.patchedSession, {
      attempt: 0,
      errorMessage: finalAssistant.errorMessage,
      reason,
    });

    await deliverRecoveryMessage(
      { kind: 'retryable-error', attempt: 1, messageKind: 'continue' },
      CONTINUE_RETRY_MESSAGE,
      branchResult.parentEntryId,
      createRecoveryMessageDetails({
        kind: 'retryable-error',
        messageKind: 'continue',
        attempt: 1,
        expectedLeafId: branchResult.parentEntryId,
        failedEntryId: branchResult.failedEntryId,
        parentEntryId: branchResult.parentEntryId,
      }),
    );
    return;
  }

  if (isEmptyAssistantStop) {
    const currentEmptyResponseAttempts = getEmptyResponseContinueAttempts(sessionId);
    if (currentEmptyResponseAttempts >= MAX_EMPTY_RESPONSE_CONTINUE_ATTEMPTS) {
      clearRecoveryState(sessionId);
      ui.clearStatus();
      ui.notify('pi-retry could not recover from an empty assistant response', 'warning');
      return;
    }

    const nextEmptyResponseAttempt = currentEmptyResponseAttempts + 1;

    const branchResult = branchLatestAssistantLeafOutOfMainPath(input.patchedSession, {
      stopReason: 'stop',
      debugData: {
        kind: 'empty-response-continue',
        attempt: nextEmptyResponseAttempt,
      },
    });

    appendDebugEntry(input.patchedSession, {
      kind: 'empty-response-continue',
      attempt: nextEmptyResponseAttempt,
      branchResult,
    });

    await deliverRecoveryMessage(
      {
        kind: 'empty-stop',
        attempt: nextEmptyResponseAttempt,
        messageKind: 'continue',
        maxAttempts: MAX_EMPTY_RESPONSE_CONTINUE_ATTEMPTS,
      },
      CONTINUE_RETRY_MESSAGE,
      branchResult.parentEntryId,
      createRecoveryMessageDetails({
        kind: 'empty-stop',
        messageKind: 'continue',
        attempt: nextEmptyResponseAttempt,
        expectedLeafId: branchResult.parentEntryId,
        failedEntryId: branchResult.failedEntryId,
        parentEntryId: branchResult.parentEntryId,
      }),
    );
    return;
  }

  if (!isLikelyRefusalText(refusalText)) {
    const recovered = getActiveRecovery(sessionId) !== undefined;
    clearRecoveryState(sessionId);
    if (!recovered) {
      ui.clearStatus();
      return;
    }

    ui.setStatus(RETRY_SUCCESS_STATUS);
    scheduleSuccessStatusClear(sessionId, ui);
    return;
  }

  const refusalContinueAttemptLimit = getConfiguredRefusalContinueAttempts();
  const currentContinueAttempt = getRefusalContinueAttempt(sessionId);
  if (currentContinueAttempt < refusalContinueAttemptLimit) {
    const continueMessage = pickStockContinueMessage({
      previousMessage: getRefusalProgress(sessionId)?.lastContinueMessage,
    });
    const nextContinueAttempt = rememberRefusalContinueAttempt(sessionId, continueMessage);
    const branchResult = branchLatestAssistantStopOutOfMainPath(
      input.patchedSession,
      refusalText,
      nextContinueAttempt,
      'continue',
    );

    appendDebugEntry(input.patchedSession, {
      kind: 'refusal-continue',
      attempt: nextContinueAttempt,
      message: continueMessage,
      refusalText,
      branchResult,
    });

    await deliverRecoveryMessage(
      {
        kind: 'refusal',
        attempt: nextContinueAttempt,
        messageKind: 'continue',
        maxAttempts: refusalContinueAttemptLimit,
      },
      continueMessage,
      branchResult.parentEntryId,
      createRecoveryMessageDetails({
        kind: 'refusal',
        messageKind: 'continue',
        attempt: nextContinueAttempt,
        expectedLeafId: branchResult.parentEntryId,
        failedEntryId: branchResult.failedEntryId,
        parentEntryId: branchResult.parentEntryId,
      }),
    );
    return;
  }

  if (refusalRewritesDisabled()) {
    clearRecoveryState(sessionId);
    ui.clearStatus();
    ui.notify(
      `pi-retry could not recover from the refusal ${formatAttemptCount(refusalContinueAttemptLimit, 'continue attempt')}`,
      'warning',
    );
    return;
  }

  const availableModels = input.ctx.modelRegistry.getAvailable();
  const reviewModels = pickReviewModels(input.ctx.model, availableModels);
  if (0 === reviewModels.length) {
    clearRecoveryState(sessionId);
    ui.clearStatus();
    ui.notify('pi-retry could not find a configured review model for refusal recovery', 'warning');
    return;
  }

  const effectiveRewriteAttemptLimit = Math.min(
    getConfiguredRefusalRewriteAttempts(),
    reviewModels.length,
  );
  const currentRewriteAttempt = getRefusalAttempt(sessionId);
  if (currentRewriteAttempt >= effectiveRewriteAttemptLimit) {
    clearRecoveryState(sessionId);
    ui.clearStatus();
    ui.notify(
      `pi-retry could not recover from the refusal ${formatAttemptCount(effectiveRewriteAttemptLimit, 'rewrite attempt')}`,
      'warning',
    );
    return;
  }

  const transcriptText = buildReviewTranscript({
    userText: getLatestUserText(input.patchedSession),
    refusalText,
  });
  const nextRewriteAttempt = currentRewriteAttempt + 1;

  for (const reviewModel of reviewModels.slice(currentRewriteAttempt)) {
    setActiveRecovery(sessionId, {
      kind: 'refusal',
      phase: 'reviewing',
      attempt: nextRewriteAttempt,
      messageKind: 'rewrite',
      maxAttempts: effectiveRewriteAttemptLimit,
      reviewModelId: reviewModel.id,
    });
    applyActiveRecoveryStatus(sessionId, ui);

    const auth = await input.ctx.modelRegistry.getApiKeyAndHeaders(reviewModel);
    if (!auth.ok) {
      appendRefusalReviewFailure(input.patchedSession, {
        attempt: nextRewriteAttempt,
        reviewModelId: reviewModel.id,
        failureKind: 'auth',
        error: auth.error,
      });
      continue;
    }

    if (!auth.apiKey) {
      appendRefusalReviewFailure(input.patchedSession, {
        attempt: nextRewriteAttempt,
        reviewModelId: reviewModel.id,
        failureKind: 'auth',
        error: 'Missing API key',
      });
      continue;
    }

    let review: { reason: string; rewrite: string } | undefined;
    try {
      review = await input.reviewRewrite({
        model: reviewModel,
        apiKey: auth.apiKey,
        headers: auth.headers,
        transcriptText,
        signal: input.ctx.signal,
      });
    } catch (error) {
      appendRefusalReviewFailure(input.patchedSession, {
        attempt: nextRewriteAttempt,
        reviewModelId: reviewModel.id,
        failureKind: 'error',
        error: formatUnknownError(error),
      });
      continue;
    }

    if (!review) {
      appendRefusalReviewFailure(input.patchedSession, {
        attempt: nextRewriteAttempt,
        reviewModelId: reviewModel.id,
        failureKind: 'unusable-output',
      });
      continue;
    }

    const branchResult = branchLatestAssistantStopOutOfMainPath(
      input.patchedSession,
      refusalText,
      nextRewriteAttempt,
      reviewModel.id,
    );

    appendDebugEntry(input.patchedSession, {
      kind: 'refusal-rewrite',
      attempt: nextRewriteAttempt,
      reviewModelId: reviewModel.id,
      reason: review.reason,
      rewrite: review.rewrite,
      branchResult,
    });

    rememberRefusalRewriteAttempt(sessionId);

    await deliverRecoveryMessage(
      {
        kind: 'refusal',
        attempt: nextRewriteAttempt,
        messageKind: 'rewrite',
        maxAttempts: effectiveRewriteAttemptLimit,
        reviewModelId: reviewModel.id,
      },
      review.rewrite,
      branchResult.parentEntryId,
      createRecoveryMessageDetails({
        kind: 'refusal',
        messageKind: 'rewrite',
        attempt: nextRewriteAttempt,
        expectedLeafId: branchResult.parentEntryId,
        failedEntryId: branchResult.failedEntryId,
        parentEntryId: branchResult.parentEntryId,
      }),
    );
    return;
  }

  clearRecoveryState(sessionId);
  ui.clearStatus();
  ui.notify('pi-retry could not produce a rewrite with any review model', 'warning');
}
