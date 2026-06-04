import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { installOpenAICodexTransportMetadataPatch } from './codex-transport-metadata';
import { clearAllContinuations } from './src/continuation-cache.ts';
import { installOpenAIWebSocketResponsesPatch } from './src/patch.ts';
import {
  API,
  createOpenAIWebSocketResponsesStream,
  type MissingCodexAccountIdWarningEvent,
} from './src/provider.ts';
import { readOpenAIWebSocketResponsesSettings } from './src/settings.ts';
import {
  closeAllCachedWebSockets,
  type WebSocketCacheStatus,
  type WebSocketLifecycleEvent,
} from './src/websocket.ts';

const WEBSOCKET_LIFECYCLE_EVENT = 'openai-websocket-responses:websocket-lifecycle';
const WEBSOCKET_STATUS_KEY = 'openai-websocket-responses';
const WEBSOCKET_DIAGNOSTIC_ENTRY = 'openai-websocket-transport-diagnostic';
const WEBSOCKET_STATUS_TTL_MS = 3000;
export const IDLE_KEEPALIVE_ACTIVITY_WINDOW_MS = 15 * 60 * 1000;

interface InputEventLike {
  source?: string;
}

interface UIContextLike {
  hasUI?: boolean;
}

interface NotifyContextLike extends UIContextLike {
  ui: Pick<ExtensionContext['ui'], 'notify'>;
}

type WebSocketStreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export function registerOpenAIWebSocketResponsesApiProvider(
  pi: Pick<ExtensionAPI, 'registerProvider'>,
  streamWebSocket: WebSocketStreamSimple,
): void {
  pi.registerProvider(API, {
    api: API,
    streamSimple: streamWebSocket,
  });
}

export function installOpenAIWebSocketResponsesApiPatches(
  installCodexTransportMetadataPatch: () => void,
  installTransparentPatch: () => void,
): void {
  installCodexTransportMetadataPatch();
  installTransparentPatch();
}

export function registerOpenAIWebSocketResponsesPatchRefreshHooks(
  pi: Pick<ExtensionAPI, 'on'>,
  installPatch: () => void,
): void {
  const reapplyPatch = () => {
    installPatch();
  };

  pi.on('session_start', reapplyPatch);
  pi.on('model_select', reapplyPatch);
  pi.on('agent_start', reapplyPatch);
  pi.on('before_provider_request', reapplyPatch);
}

function cacheStatusLabel(status: WebSocketCacheStatus): string {
  if (status === 'busy') return 'extra socket while previous is busy';
  if (status === 'hit') return 'reused idle socket';
  return 'new socket';
}

function recoveryModeLabel(mode: 'resumed' | 'full_replay'): string {
  return mode === 'resumed' ? 'resumed from previous_response_id' : 'full conversation replay';
}

export function formatWebSocketStatus(event: WebSocketLifecycleEvent): string | undefined {
  if (event.type === 'open') {
    if (!event.cacheKeyHash) return undefined;
    return `Responses WS: ${event.connectionId} connected · ${cacheStatusLabel(event.cacheStatus)}`;
  }
  if (event.type === 'recovered') {
    const target = event.connectionId ? ` on ${event.connectionId}` : '';
    return `Responses WS: recovered${target} · ${recoveryModeLabel(event.mode)}`;
  }
  return undefined;
}

function shortResponseId(value: string | undefined): string | undefined {
  if (!value || value.length <= 24) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

export function formatWebSocketRetryNotification(
  event: WebSocketLifecycleEvent,
): string | undefined {
  if (event.type !== 'retry') return undefined;
  const source = event.connectionId ? `${event.connectionId} returned` : 'API returned';
  return [
    `Responses WS: ${source} response.failed without details; retrying fresh with previous_response_id=${shortResponseId(event.previousResponseId)}.`,
    event.responseId ? `Failed response_id=${shortResponseId(event.responseId)}.` : undefined,
    `Attempt ${event.nextAttempt}/${event.maxAttempts}.`,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');
}

export function formatWebSocketFallbackNotification(
  event: WebSocketLifecycleEvent,
): string | undefined {
  if (event.type !== 'fallback') return undefined;
  if (event.reason === 'empty_response_failed_without_details') {
    const source = event.connectionId ? `retry on ${event.connectionId}` : 'retry';
    return [
      `Responses WS: ${source} also returned response.failed; replaying full conversation.`,
      event.responseId ? `Failed response_id=${shortResponseId(event.responseId)}.` : undefined,
      `Attempt ${event.nextAttempt}/${event.maxAttempts}.`,
    ]
      .filter((part): part is string => typeof part === 'string')
      .join(' ');
  }
  return [
    `Responses WS: previous_response_id=${shortResponseId(event.previousResponseId)} was not found; replaying full conversation.`,
    `Attempt ${event.nextAttempt}/${event.maxAttempts}.`,
  ].join(' ');
}

export function createMissingCodexAccountIdNotifier(
  getContext: () => NotifyContextLike | undefined,
): (event: MissingCodexAccountIdWarningEvent) => void {
  const warned = new Set<string>();
  return (event) => {
    const ctx = getContext();
    if (!ctx?.hasUI) return;

    const key = `${event.model.provider}:${event.url}`;
    if (warned.has(key)) return;
    warned.add(key);

    ctx.ui.notify(
      `OpenAI Codex WebSocket is using the direct ChatGPT Codex backend without chatgpt-account-id. Pi could not derive it from the JWT, so requests may fail or use the wrong ChatGPT account. URL: ${event.url}`,
      'warning',
    );
  };
}

export function createIdleKeepaliveActivityTracker(now = () => Date.now()) {
  let currentCtx: UIContextLike | undefined;
  let nextRunIsInteractive = false;
  let currentRunIsInteractive = false;
  let keepaliveAllowedUntil = 0;

  const hasUI = () => currentCtx?.hasUI === true;

  return {
    setContext(ctx: UIContextLike | undefined): void {
      currentCtx = ctx;
      if (!hasUI()) {
        nextRunIsInteractive = false;
        currentRunIsInteractive = false;
        keepaliveAllowedUntil = 0;
      }
    },

    noteInput(event: InputEventLike): void {
      if (!hasUI() || event.source !== 'interactive') return;
      nextRunIsInteractive = true;
    },

    noteAgentStart(): void {
      currentRunIsInteractive = hasUI() && nextRunIsInteractive;
      nextRunIsInteractive = false;
    },

    noteAgentEnd(): void {
      if (hasUI() && currentRunIsInteractive) {
        keepaliveAllowedUntil = now() + IDLE_KEEPALIVE_ACTIVITY_WINDOW_MS;
      }
      currentRunIsInteractive = false;
    },

    shouldEnable(): boolean {
      return hasUI() && (currentRunIsInteractive || now() < keepaliveAllowedUntil);
    },

    clear(): void {
      currentCtx = undefined;
      nextRunIsInteractive = false;
      currentRunIsInteractive = false;
      keepaliveAllowedUntil = 0;
    },
  };
}

export default function (pi: ExtensionAPI) {
  let currentCtx: ExtensionContext | undefined;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  const idleKeepaliveActivity = createIdleKeepaliveActivityTracker();
  const clearStatus = () => {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = undefined;
    currentCtx?.ui.setStatus(WEBSOCKET_STATUS_KEY, undefined);
  };
  const onLifecycleEvent = (event: WebSocketLifecycleEvent) => {
    pi.events.emit(WEBSOCKET_LIFECYCLE_EVENT, event);
    const retryNotification = formatWebSocketRetryNotification(event);
    if (retryNotification && currentCtx?.hasUI) currentCtx.ui.notify(retryNotification, 'warning');
    const fallbackNotification = formatWebSocketFallbackNotification(event);
    if (fallbackNotification && currentCtx?.hasUI)
      currentCtx.ui.notify(fallbackNotification, 'warning');
    const status = formatWebSocketStatus(event);
    if (!status || !currentCtx?.hasUI) return;
    currentCtx.ui.setStatus(WEBSOCKET_STATUS_KEY, status);
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(clearStatus, WEBSOCKET_STATUS_TTL_MS);
    statusTimer.unref?.();
  };

  const settingsProvider = () => readOpenAIWebSocketResponsesSettings();
  const notifyMissingCodexAccountId = createMissingCodexAccountIdNotifier(() => currentCtx);
  const streamWebSocket = createOpenAIWebSocketResponsesStream(
    settingsProvider,
    onLifecycleEvent,
    () => idleKeepaliveActivity.shouldEnable(),
    (diagnostic) => pi.appendEntry(WEBSOCKET_DIAGNOSTIC_ENTRY, diagnostic),
    notifyMissingCodexAccountId,
  );
  const installTransparentPatch = () => {
    installOpenAIWebSocketResponsesPatch(settingsProvider, streamWebSocket);
  };
  const installApiPatches = () => {
    installOpenAIWebSocketResponsesApiPatches(
      installOpenAICodexTransportMetadataPatch,
      installTransparentPatch,
    );
  };

  registerOpenAIWebSocketResponsesApiProvider(pi, streamWebSocket);
  installApiPatches();
  registerOpenAIWebSocketResponsesPatchRefreshHooks(pi, installApiPatches);

  pi.on('session_start', (_event, ctx) => {
    currentCtx = ctx;
    idleKeepaliveActivity.setContext(ctx);
  });

  pi.on('input', (event) => {
    idleKeepaliveActivity.noteInput(event as InputEventLike);
  });

  pi.on('agent_start', () => {
    idleKeepaliveActivity.noteAgentStart();
  });

  pi.on('agent_end', () => {
    idleKeepaliveActivity.noteAgentEnd();
  });

  pi.on('session_shutdown', () => {
    clearStatus();
    closeAllCachedWebSockets();
    clearAllContinuations();
    currentCtx = undefined;
    idleKeepaliveActivity.clear();
  });
}
