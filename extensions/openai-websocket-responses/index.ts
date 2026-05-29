import { registerApiProvider } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { installOpenAICodexTransportMetadataPatch } from './codex-transport-metadata';
import { clearAllContinuations } from './src/continuation-cache.ts';
import { installOpenAIWebSocketResponsesPatch } from './src/patch.ts';
import { API, createOpenAIWebSocketResponsesStream } from './src/provider.ts';
import { readOpenAIWebSocketResponsesSettings } from './src/settings.ts';
import { closeAllCachedWebSockets } from './src/websocket.ts';

export default function (pi: ExtensionAPI) {
  installOpenAICodexTransportMetadataPatch();

  const settingsProvider = () => readOpenAIWebSocketResponsesSettings();
  const streamWebSocket = createOpenAIWebSocketResponsesStream(settingsProvider);

  registerApiProvider(
    {
      api: API,
      stream: streamWebSocket,
      streamSimple: streamWebSocket,
    },
    'extension:openai-websocket-responses',
  );
  installOpenAIWebSocketResponsesPatch(settingsProvider, streamWebSocket);

  pi.on('session_shutdown', () => {
    closeAllCachedWebSockets();
    clearAllContinuations();
  });
}
