import { complete, completeSimple } from '@earendil-works/pi-ai/compat';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@earendil-works/pi-ai/compat', async () => {
  const actual = await vi.importActual<typeof import('@earendil-works/pi-ai/compat')>(
    '@earendil-works/pi-ai/compat',
  );
  return { ...actual, complete: vi.fn(), completeSimple: vi.fn() };
});

import { completeSimpleWithResolvedAuth, completeWithModelRegistry } from './model-completion';

const model = {
  provider: 'local',
  id: 'local-model',
  api: 'openai-responses',
} as any;
const response = { role: 'assistant', content: [], stopReason: 'stop' } as any;

describe('completeWithModelRegistry', () => {
  beforeEach(() => {
    vi.mocked(complete).mockReset();
    vi.mocked(completeSimple).mockReset();
  });

  test('uses ModelRegistry.complete for configured providers', async () => {
    const registryComplete = vi.fn().mockResolvedValue(response);
    const registry = {
      hasConfiguredAuth: vi.fn(() => true),
      complete: registryComplete,
      getApiKeyAndHeaders: vi.fn(),
    } as any;

    await expect(
      completeWithModelRegistry(registry, model, { messages: [] }, { maxTokens: 10 }),
    ).resolves.toBe(response);

    expect(registryComplete).toHaveBeenCalledWith(model, { messages: [] }, { maxTokens: 10 });
    expect(registry.getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  test('preserves keyless-provider compatibility and resolved request fields', async () => {
    vi.mocked(complete).mockResolvedValue(response);
    const registry = {
      hasConfiguredAuth: vi.fn(() => false),
      complete: vi.fn(),
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({
        ok: true,
        baseUrl: 'http://localhost:11434/v1',
        headers: { 'x-provider': 'local', 'x-remove': null },
        env: { LOCAL_PROVIDER: '1' },
      }),
    } as any;

    await expect(
      completeWithModelRegistry(
        registry,
        model,
        { messages: [] },
        {
          headers: { 'x-caller': 'test' },
          env: { REQUEST_ENV: '1' },
          transformHeaders: (headers) => ({ ...headers, 'x-transform': 'applied' }),
        },
      ),
    ).resolves.toBe(response);

    expect(registry.complete).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://localhost:11434/v1' }),
      { messages: [] },
      expect.objectContaining({
        headers: {
          'x-provider': 'local',
          'x-remove': null,
          'x-caller': 'test',
          'x-transform': 'applied',
        },
        env: { LOCAL_PROVIDER: '1', REQUEST_ENV: '1' },
      }),
    );
  });

  test('keeps simple completion semantics with credential-resolved fields', async () => {
    vi.mocked(completeSimple).mockResolvedValue(response);
    const registry = {
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({
        ok: true,
        apiKey: 'resolved-key',
        baseUrl: 'https://resolved.example/v1',
        headers: { 'x-resolved': '1' },
      }),
    } as any;

    await expect(
      completeSimpleWithResolvedAuth(registry, model, { messages: [] }, { reasoning: 'low' }),
    ).resolves.toBe(response);

    expect(completeSimple).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://resolved.example/v1' }),
      { messages: [] },
      expect.objectContaining({
        apiKey: 'resolved-key',
        headers: { 'x-resolved': '1' },
        reasoning: 'low',
      }),
    );
  });
});
