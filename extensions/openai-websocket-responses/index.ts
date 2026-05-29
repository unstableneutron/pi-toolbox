import { registerApiProvider } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { installOpenAICodexTransportMetadataPatch } from './codex-transport-metadata';
import { clearAllContinuations } from './src/continuation-cache.ts';
import { installOpenAIWebSocketResponsesPatch } from './src/patch.ts';
import { API, createOpenAIWebSocketResponsesStream } from './src/provider.ts';
import { readOpenAIWebSocketResponsesSettings } from './src/settings.ts';
import { closeAllCachedWebSockets } from './src/websocket.ts';

const FACADE_WS_BASE_URL =
  'https://llm-fusion-hub.a.musta.ch/api/v2/proxy/experimental/azure_openai/openai/v1/?api-version=preview&deployment=gpt-5.5-nomoderation&region=global&azure-resource-bucket=internal-productivity';

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

  if (!settingsProvider().registerSmokeProvider) return;

  pi.registerProvider('facade-ws', {
    baseUrl: FACADE_WS_BASE_URL,
    apiKey: '!iap-auth',
    authHeader: true,
    api: API,
    models: [
      {
        id: 'gpt-5.5-nomoderation',
        name: 'facade-ws/gpt-5.5',
        api: API,
        baseUrl: FACADE_WS_BASE_URL,
        headers: {
          'x-azure-region': 'global',
          'x-azure-resource-bucket': 'internal-productivity',
          'x-azure-deployment': 'gpt-5.5-nomoderation',
        },
        reasoning: true,
        thinkingLevelMap: { off: 'none', minimal: null, high: null, xhigh: 'xhigh' },
        input: ['text', 'image'],
        cost: { input: 2.5, output: 15, cacheRead: 0.5, cacheWrite: 0 },
        contextWindow: 296384,
        maxTokens: 128000,
      },
    ],
  });
}
