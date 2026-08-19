import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test, vi } from 'vitest';

import { installPrimeOpenAIWebSocketResponsesHooks } from './prime';
import { normalizeSettings, readOpenAIWebSocketResponsesPrimeSettings } from './src/settings';

function createStream(): any {
  return {
    async *[Symbol.asyncIterator]() {},
    result: async () => ({ role: 'assistant' }),
  };
}

function createRegistry() {
  const providers = new Map<string, any>();
  const registrations: Array<{ api: string; sourceId?: string }> = [];
  const originals = new Map<string, ReturnType<typeof vi.fn>>();

  for (const api of ['openai-responses', 'openai-codex-responses']) {
    const stream = vi.fn(() => createStream());
    originals.set(api, stream);
    providers.set(api, { api, stream, streamSimple: stream });
  }

  return {
    getApiProvider(api: string) {
      return providers.get(api);
    },
    registerApiProvider(provider: any, sourceId?: string) {
      registrations.push({ api: provider.api, sourceId });
      providers.set(provider.api, {
        api: provider.api,
        stream: (...args: any[]) => provider.stream(...args),
        streamSimple: (...args: any[]) => provider.streamSimple(...args),
      });
    },
    providers,
    registrations,
    originals,
  };
}

const model = {
  api: 'openai-codex-responses',
  provider: 'openai-codex',
  id: 'gpt-5.6',
};

describe('Prime Agent Responses hooks', () => {
  test('keeps Prime native transport options unchanged by default', () => {
    const registry = createRegistry();
    installPrimeOpenAIWebSocketResponsesHooks(registry as any, () => normalizeSettings({}));

    const provider = registry.getApiProvider(model.api)!;
    provider.streamSimple(model, {});

    expect(registry.registrations).toHaveLength(2);
    expect(registry.originals.get(model.api)).toHaveBeenCalledWith(model, {}, undefined);
  });

  test('selects a configured native WebSocket transport without replacing the provider', () => {
    const registry = createRegistry();
    installPrimeOpenAIWebSocketResponsesHooks(registry as any, () =>
      normalizeSettings({
        patch: { transportByProviderModel: { 'openai-codex/gpt-5.6': 'websocket' } },
      }),
    );

    const provider = registry.getApiProvider(model.api)!;
    provider.streamSimple(model, {}, { sessionId: 'session-1' });

    expect(registry.originals.get(model.api)).toHaveBeenCalledWith(
      model,
      {},
      {
        sessionId: 'session-1',
        transport: 'websocket',
      },
    );
  });

  test('reads project Prime settings after user settings', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'openai-websocket-prime-settings-'));
    try {
      const agentDir = join(cwd, '.prime', 'agent');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, 'settings.json'),
        JSON.stringify({
          openaiWebsocketResponses: {
            patch: { transportByProviderModel: { 'openai-codex/gpt-5.6': 'websocket' } },
          },
        }),
      );

      expect(readOpenAIWebSocketResponsesPrimeSettings(cwd).patch.transportByProviderModel).toEqual(
        {
          'openai-codex/gpt-5.6': 'websocket',
        },
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('does not double-wrap providers on extension reload', () => {
    const registry = createRegistry();
    const settings = () => normalizeSettings({});

    installPrimeOpenAIWebSocketResponsesHooks(registry as any, settings);
    const afterFirstLoad = registry.registrations.length;
    installPrimeOpenAIWebSocketResponsesHooks(registry as any, settings);

    expect(afterFirstLoad).toBe(2);
    expect(registry.registrations).toHaveLength(afterFirstLoad);
  });
});
