import {
  createAssistantMessageEventStream,
  getApiProvider,
  registerApiProvider,
  resetApiProviders,
} from '@earendil-works/pi-ai';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  installOpenAICodexTransportMetadataPatch,
  shouldPatchOpenAICodexTransportMetadata,
  wrapCodexStreamWithTransportMetadata,
} from './codex-transport-metadata';

function makeModel(): Model<any> {
  return {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 100000,
  } as Model<any>;
}

function makeAssistantMessage(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-5.5',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

describe('openai-codex transport metadata patch', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetApiProviders();
  });

  test('is disabled by default', () => {
    expect(shouldPatchOpenAICodexTransportMetadata()).toBe(false);
  });

  test('can be enabled by environment variable', () => {
    vi.stubEnv('OPENAI_WEBSOCKET_RESPONSES_PATCH_CODEX_TRANSPORT_METADATA', 'true');

    expect(shouldPatchOpenAICodexTransportMetadata()).toBe(true);
  });

  test('emits WebSocket upgrade metadata when stream starts before any HTTP response', async () => {
    const model = makeModel();
    const observed: Array<{ status: number; headers: Record<string, string> }> = [];
    const wrapped = wrapCodexStreamWithTransportMetadata((_model, _context, _options) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = makeAssistantMessage();
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
      });
      return stream;
    });

    const stream = wrapped(model, {} as any, {
      transport: 'auto',
      onResponse(response) {
        observed.push(response);
      },
    });

    await expect(stream.result()).resolves.toMatchObject({ api: 'openai-codex-responses' });
    expect(observed).toEqual([
      {
        status: 101,
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'x-pi-observed-transport': 'websocket',
        },
      },
    ]);
  });

  test('does not emit WebSocket metadata when SSE response metadata arrives first', async () => {
    const model = makeModel();
    const observed: Array<{ status: number; headers: Record<string, string> }> = [];
    const wrapped = wrapCodexStreamWithTransportMetadata((_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        await options?.onResponse?.(
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
          model,
        );
        const message = makeAssistantMessage();
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
      });
      return stream;
    });

    const stream = wrapped(model, {} as any, {
      transport: 'auto',
      onResponse(response) {
        observed.push(response);
      },
    });

    await expect(stream.result()).resolves.toMatchObject({ api: 'openai-codex-responses' });
    expect(observed).toEqual([{ status: 200, headers: { 'content-type': 'text/event-stream' } }]);
  });

  test('does not wrap the Codex API provider more than once', () => {
    vi.stubEnv('OPENAI_WEBSOCKET_RESPONSES_PATCH_CODEX_TRANSPORT_METADATA', 'true');
    const originalStream = vi.fn(() => createAssistantMessageEventStream());
    registerApiProvider(
      {
        api: 'openai-codex-responses',
        stream: originalStream as any,
        streamSimple: originalStream as any,
      },
      'test:codex-provider',
    );

    expect(installOpenAICodexTransportMetadataPatch()).toBe(true);
    const firstProvider = getApiProvider('openai-codex-responses');
    expect(firstProvider?.stream).not.toBe(originalStream);
    expect(firstProvider?.streamSimple).not.toBe(originalStream);

    expect(installOpenAICodexTransportMetadataPatch()).toBe(true);
    const secondProvider = getApiProvider('openai-codex-responses');
    expect(secondProvider?.stream).toBe(firstProvider?.stream);
    expect(secondProvider?.streamSimple).toBe(firstProvider?.streamSimple);
  });

  test('does not emit WebSocket metadata when SSE transport is forced', async () => {
    const model = makeModel();
    const observed: Array<{ status: number; headers: Record<string, string> }> = [];
    const wrapped = wrapCodexStreamWithTransportMetadata((_model, _context, _options) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = makeAssistantMessage();
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: 'stop', message });
      });
      return stream;
    });

    const stream = wrapped(model, {} as any, {
      transport: 'sse',
      onResponse(response) {
        observed.push(response);
      },
    });

    await expect(stream.result()).resolves.toMatchObject({ api: 'openai-codex-responses' });
    expect(observed).toEqual([]);
  });
});
