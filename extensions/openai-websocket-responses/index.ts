import { registerApiProvider } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { installOpenAICodexTransportMetadataPatch } from './codex-transport-metadata';
import { clearAllContinuations } from './src/continuation-cache.ts';
import { installOpenAIWebSocketResponsesPatch } from './src/patch.ts';
import { API, createOpenAIWebSocketResponsesStream } from './src/provider.ts';
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
  if (status === 'busy') return 'extra';
  if (status === 'hit') return 'cached';
  return 'new';
}

export function formatWebSocketStatus(event: WebSocketLifecycleEvent): string | undefined {
  if (event.type !== 'open' || !event.cacheKeyHash) return undefined;
  return `WebSocket ${event.connectionId} connected · ${cacheStatusLabel(event.cacheStatus)}`;
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
  installOpenAICodexTransportMetadataPatch();

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
    const status = formatWebSocketStatus(event);
    if (!status || !currentCtx?.hasUI) return;
    currentCtx.ui.setStatus(WEBSOCKET_STATUS_KEY, status);
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(clearStatus, WEBSOCKET_STATUS_TTL_MS);
    statusTimer.unref?.();
  };

  const settingsProvider = () => readOpenAIWebSocketResponsesSettings();
  const streamWebSocket = createOpenAIWebSocketResponsesStream(
    settingsProvider,
    onLifecycleEvent,
    () => idleKeepaliveActivity.shouldEnable(),
    (diagnostic) => pi.appendEntry(WEBSOCKET_DIAGNOSTIC_ENTRY, diagnostic),
  );
  const installTransparentPatch = () => {
    installOpenAIWebSocketResponsesPatch(settingsProvider, streamWebSocket);
  };

  registerApiProvider(
    {
      api: API,
      stream: streamWebSocket,
      streamSimple: streamWebSocket,
    },
    'extension:openai-websocket-responses',
  );
  installTransparentPatch();
  registerOpenAIWebSocketResponsesPatchRefreshHooks(pi, installTransparentPatch);

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
