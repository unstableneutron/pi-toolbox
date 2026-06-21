import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { clearAllContinuations } from './src/continuation-cache.ts';
import { API, createOpenAIWebSocketResponsesStream } from './src/provider.ts';
import { readOpenAIWebSocketResponsesSettings } from './src/settings.ts';
import {
  closeAllCachedWebSockets,
  type WebSocketCacheStatus,
  type WebSocketLifecycleEvent,
} from './src/websocket.ts';

const WEBSOCKET_STATUS_KEY = 'openai-websocket-responses';
const WEBSOCKET_DIAGNOSTIC_ENTRY = 'openai-websocket-transport-diagnostic';
const WEBSOCKET_STATUS_TTL_MS = 3000;

function cacheStatusLabel(status: WebSocketCacheStatus): string {
  if (status === 'busy') return 'extra socket while previous is busy';
  if (status === 'hit') return 'reused idle socket';
  return 'new socket';
}

function formatWebSocketStatus(event: WebSocketLifecycleEvent): string | undefined {
  if (event.type === 'open') {
    if (!event.cacheKeyHash) return undefined;
    return `Responses WS: ${event.connectionId} connected · ${cacheStatusLabel(event.cacheStatus)}`;
  }
  if (event.type === 'retry') return 'Responses WS: retrying on a fresh socket...';
  if (event.type === 'fallback') return 'Responses WS: replaying full context...';
  if (event.type === 'recovering') return 'Responses WS: recovering interrupted response...';
  if (event.type === 'recovered') return 'Responses WS: recovered interrupted response';
  if (event.type === 'failed') return 'Responses WS recovery failed';
  return undefined;
}

export default function openAIWebSocketResponsesOmp(pi: ExtensionAPI): void {
  let currentCtx: ExtensionContext | undefined;
  let clearStatusTimer: ReturnType<typeof setTimeout> | undefined;

  const clearStatusSoon = () => {
    if (clearStatusTimer !== undefined) clearTimeout(clearStatusTimer);
    clearStatusTimer = setTimeout(() => {
      clearStatusTimer = undefined;
      currentCtx?.ui.setStatus(WEBSOCKET_STATUS_KEY, undefined);
    }, WEBSOCKET_STATUS_TTL_MS);
  };

  const streamWebSocket = createOpenAIWebSocketResponsesStream(
    () => readOpenAIWebSocketResponsesSettings(),
    (event) => {
      const status = formatWebSocketStatus(event);
      if (status && currentCtx?.hasUI) {
        currentCtx.ui.setStatus(WEBSOCKET_STATUS_KEY, status);
        if (event.type === 'recovered' || event.type === 'failed') clearStatusSoon();
      }
    },
    () => false,
    (diagnostic) => pi.appendEntry(WEBSOCKET_DIAGNOSTIC_ENTRY, diagnostic),
    ({ url }) => {
      currentCtx?.ui.notify(
        `openai-websocket-responses: missing chatgpt-account-id for ${url}`,
        'warning',
      );
    },
  );

  pi.registerProvider(API, {
    api: API,
    streamSimple: streamWebSocket,
  });

  pi.on('session_start', (_event, ctx) => {
    currentCtx = ctx;
  });

  pi.on('session_shutdown', () => {
    if (clearStatusTimer !== undefined) clearTimeout(clearStatusTimer);
    clearStatusTimer = undefined;
    currentCtx?.ui.setStatus(WEBSOCKET_STATUS_KEY, undefined);
    currentCtx = undefined;
    closeAllCachedWebSockets();
    clearAllContinuations();
  });
}
