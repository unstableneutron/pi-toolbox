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
const WEBSOCKET_STATUS_TTL_MS = 3000;

function cacheStatusLabel(status: WebSocketCacheStatus): string {
  if (status === 'busy') return 'extra';
  if (status === 'hit') return 'cached';
  return 'new';
}

export function formatWebSocketStatus(event: WebSocketLifecycleEvent): string | undefined {
  if (event.type !== 'open' || !event.cacheKeyHash) return undefined;
  return `WebSocket ${event.connectionId} connected · ${cacheStatusLabel(event.cacheStatus)}`;
}

export default function (pi: ExtensionAPI) {
  installOpenAICodexTransportMetadataPatch();

  let currentCtx: ExtensionContext | undefined;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
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
  const streamWebSocket = createOpenAIWebSocketResponsesStream(settingsProvider, onLifecycleEvent);

  registerApiProvider(
    {
      api: API,
      stream: streamWebSocket,
      streamSimple: streamWebSocket,
    },
    'extension:openai-websocket-responses',
  );
  installOpenAIWebSocketResponsesPatch(settingsProvider, streamWebSocket);

  pi.on('session_start', (_event, ctx) => {
    currentCtx = ctx;
  });

  pi.on('session_shutdown', () => {
    clearStatus();
    closeAllCachedWebSockets();
    clearAllContinuations();
    currentCtx = undefined;
  });
}
