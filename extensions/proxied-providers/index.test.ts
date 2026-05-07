import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type StreamFunction } from '@earendil-works/pi-ai';

import {
  buildDelegatingStream,
  reportProviderResponse,
  resolveConfiguredTargetModel,
  resolveProxyRoute,
  resolveTargetProviderModel,
  summarizeProviderResponseHeaders,
} from './index';

function createDoneStream(model: any) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: 'done',
      reason: 'stop',
      message: {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
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
      },
    });
    stream.end();
  });
  return stream;
}

async function collectEvents(stream: AsyncIterable<any>) {
  const events: any[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

vi.mock('./settings', async () => {
  const actual = await vi.importActual<typeof import('./settings')>('./settings');
  return {
    ...actual,
    loadProxiedProviders: vi.fn(() => ({})),
    loadProxiedProviderRewrites: vi.fn(() => ({})),
    isProviderProxied: vi.fn(
      (_provider: string, map: Record<string, boolean>) => map[_provider] === true,
    ),
  };
});

describe('buildDelegatingStream', () => {
  test('routes proxied providers to proxied stream', () => {
    const original = vi.fn(() => createAssistantMessageEventStream());
    const proxied = vi.fn(() => createAssistantMessageEventStream());

    const stream = buildDelegatingStream(
      original,
      proxied,
      (provider) => provider === 'google-vertex',
    );

    stream({ provider: 'google-vertex' } as never, { messages: [] } as never, {} as never);

    expect(proxied).toHaveBeenCalledTimes(1);
    expect(original).not.toHaveBeenCalled();
  });

  test('routes non-proxied providers to original stream', () => {
    const original = vi.fn(() => createAssistantMessageEventStream());
    const proxied = vi.fn(() => createAssistantMessageEventStream());

    const stream = buildDelegatingStream(original, proxied, () => false);

    stream({ provider: 'google-vertex' } as never, { messages: [] } as never, {} as never);

    expect(original).toHaveBeenCalledTimes(1);
    expect(proxied).not.toHaveBeenCalled();
  });

  test('does not cross-talk between providers sharing API family', () => {
    const originalGemini = vi.fn(() => createAssistantMessageEventStream());
    const proxiedGemini = vi.fn(() => createAssistantMessageEventStream());
    const originalVertex = vi.fn(() => createAssistantMessageEventStream());
    const proxiedVertex = vi.fn(() => createAssistantMessageEventStream());

    const geminiStream = buildDelegatingStream(
      originalGemini,
      proxiedGemini,
      (provider) => provider === 'google-gemini-cli',
    );
    const vertexStream = buildDelegatingStream(
      originalVertex,
      proxiedVertex,
      (provider) => provider === 'google-gemini-cli',
    );

    geminiStream(
      { provider: 'google-gemini-cli' } as never,
      { messages: [] } as never,
      {} as never,
    );
    vertexStream({ provider: 'google-vertex' } as never, { messages: [] } as never, {} as never);

    expect(proxiedGemini).toHaveBeenCalledTimes(1);
    expect(originalGemini).not.toHaveBeenCalled();

    expect(originalVertex).toHaveBeenCalledTimes(1);
    expect(proxiedVertex).not.toHaveBeenCalled();
  });

  test('proxied and non-proxied providers on the same API family do not cross-talk', () => {
    const original = vi.fn((model: any) => `original:${model.provider}` as any);
    const proxied = vi.fn((model: any) => `proxied:${model.provider}` as any);
    const stream = buildDelegatingStream(
      original as any,
      proxied as any,
      (provider) => provider === 'openai-codex',
    );

    expect(stream({ provider: 'openai-codex' } as any, { messages: [] } as any, {} as any)).toBe(
      'proxied:openai-codex',
    );
    expect(stream({ provider: 'other-codex' } as any, { messages: [] } as any, {} as any)).toBe(
      'original:other-codex',
    );
  });
});

describe('resolveTargetProviderModel', () => {
  const providerModels = [
    {
      provider: 'devai',
      id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      name: 'claude-haiku-4-5',
    },
    {
      provider: 'devai',
      id: 'global.anthropic.claude-sonnet-4-6',
      name: 'claude-sonnet-4-6',
    },
    {
      provider: 'gust',
      id: 'claude-haiku-4-5',
      name: 'claude-haiku-4-5',
    },
  ] as any[];

  test('matches an exact target model id within the provider', () => {
    expect(
      resolveTargetProviderModel(
        providerModels as any,
        'devai',
        'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      ),
    ).toMatchObject({
      ok: true,
      model: providerModels[0],
    });
  });

  test('matches an exact target model name within the provider', () => {
    expect(
      resolveTargetProviderModel(providerModels as any, 'devai', 'claude-haiku-4-5'),
    ).toMatchObject({
      ok: true,
      model: providerModels[0],
    });
  });

  test('matches a realistic human-readable target model name within the provider', () => {
    const humanNamedModels = [
      {
        provider: 'devai',
        id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        name: 'Claude Haiku 4.5',
      },
    ] as any[];

    expect(
      resolveTargetProviderModel(humanNamedModels as any, 'devai', 'Claude Haiku 4.5'),
    ).toMatchObject({
      ok: true,
      model: humanNamedModels[0],
    });
  });

  test('matches a uniquely normalized dated target name within the provider', () => {
    expect(
      resolveTargetProviderModel(providerModels as any, 'devai', 'claude-haiku-4-5-20251001'),
    ).toMatchObject({
      ok: true,
      model: providerModels[0],
    });
  });

  test('prefers the most specific normalized dated target within the provider', () => {
    const datedModels = [
      {
        provider: 'devai',
        id: 'global.anthropic.claude-haiku-4-5-20241022-v1:0',
        name: 'claude-haiku-4-5',
      },
      {
        provider: 'devai',
        id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        name: 'claude-haiku-4-5',
      },
    ] as any[];

    expect(
      resolveTargetProviderModel(datedModels as any, 'devai', 'claude-haiku-4-5-20251001'),
    ).toMatchObject({
      ok: true,
      model: datedModels[1],
    });
  });

  test('prefers dated shorthand over base shorthand for versioned target refs', () => {
    const versionedModels = [
      {
        provider: 'devai',
        id: 'global.anthropic.claude-haiku-4-5-20241022-v1:0',
        name: 'claude-haiku-4-5',
      },
      {
        provider: 'devai',
        id: 'global.anthropic.claude-haiku-4-5-20251001-v2:0',
        name: 'claude-haiku-4-5',
      },
    ] as any[];

    expect(
      resolveTargetProviderModel(versionedModels as any, 'devai', 'claude-haiku-4-5-20251001-v1:0'),
    ).toMatchObject({
      ok: true,
      model: versionedModels[1],
    });
  });

  test('rejects ambiguous normalized matches within the provider', () => {
    const ambiguousModels = [
      {
        provider: 'devai',
        id: 'global.anthropic.claude-haiku-4-5-20241022-v1:0',
        name: 'Claude Haiku 4.5 October',
      },
      {
        provider: 'devai',
        id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        name: 'Claude Haiku 4.5 October Refresh',
      },
    ] as any[];

    expect(
      resolveTargetProviderModel(ambiguousModels as any, 'devai', 'claude-haiku-4-5'),
    ).toMatchObject({
      ok: false,
      kind: 'ambiguous',
      error: expect.stringContaining('Ambiguous target devai/claude-haiku-4-5'),
    });
  });

  test('returns an explicit error when the target provider has no models', () => {
    expect(
      resolveTargetProviderModel(providerModels as any, 'facade', 'claude-haiku-4-5'),
    ).toMatchObject({
      ok: false,
      kind: 'provider_missing',
      error: 'Target provider facade has no registered models',
    });
  });

  test('returns an explicit error when no target model matches within the provider', () => {
    expect(
      resolveTargetProviderModel(providerModels as any, 'devai', 'claude-opus-4-6'),
    ).toMatchObject({
      ok: false,
      kind: 'not_found',
      error: 'Target devai/claude-opus-4-6 not found',
    });
  });

  test('resolveConfiguredTargetModel expands nomoderation refs to the friendly base name', () => {
    const facadeModels = [
      {
        provider: 'facade',
        id: 'gpt-5.4-nomoderation',
        name: 'gpt-5.4',
      },
    ] as any[];

    expect(
      resolveConfiguredTargetModel(facadeModels as any, 'facade', ['gpt-5.4-nomoderation']),
    ).toMatchObject({
      ok: true,
      model: facadeModels[0],
    });
  });

  test('does not match models from other providers during fallback resolution', () => {
    expect(
      resolveTargetProviderModel(
        providerModels as any,
        'gust',
        'global.anthropic.claude-sonnet-4-6',
      ),
    ).toMatchObject({
      ok: false,
      kind: 'not_found',
      error: 'Target gust/global.anthropic.claude-sonnet-4-6 not found',
    });
  });
});

describe('resolveConfiguredTargetModel', () => {
  test('returns the first successful target ref', () => {
    const providerModels = [
      {
        provider: 'devai',
        id: 'global.anthropic.claude-sonnet-4-6',
        name: 'claude-sonnet-4-6',
      },
    ] as any[];

    expect(
      resolveConfiguredTargetModel(providerModels as any, 'devai', [
        'claude-opus-4-6',
        'claude-sonnet-4-6',
      ]),
    ).toMatchObject({ ok: true, model: providerModels[0] });
  });

  test('does not mask ambiguity with later fallback refs', () => {
    const providerModels = [
      {
        provider: 'devai',
        id: 'global.anthropic.claude-haiku-4-5-20241022-v1:0',
        name: 'Claude Haiku 4.5 October',
      },
      {
        provider: 'devai',
        id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        name: 'Claude Haiku 4.5 October Refresh',
      },
      {
        provider: 'devai',
        id: 'global.anthropic.claude-sonnet-4-6',
        name: 'claude-sonnet-4-6',
      },
    ] as any[];

    expect(
      resolveConfiguredTargetModel(providerModels as any, 'devai', [
        'claude-haiku-4-5',
        'claude-sonnet-4-6',
      ]),
    ).toMatchObject({
      ok: false,
      kind: 'ambiguous',
      error: expect.stringContaining('Ambiguous target devai/claude-haiku-4-5'),
    });
  });

  test('fails closed when no target ref resolves', () => {
    const providerModels = [
      {
        provider: 'devai',
        id: 'global.anthropic.claude-sonnet-4-6',
        name: 'claude-sonnet-4-6',
      },
    ] as any[];

    expect(
      resolveConfiguredTargetModel(providerModels as any, 'devai', ['claude-opus-4-6']),
    ).toMatchObject({
      ok: false,
      kind: 'not_found',
      error: 'Target devai/claude-opus-4-6 not found',
    });
  });
});

describe('resolveProxyRoute', () => {
  const state = {
    cwd: '/tmp/project',
    proxiedProviders: {},
    rewrites: {
      'anthropic/*': { kind: 'rewrite', targetProvider: 'devai' },
    },
    modelRegistry: undefined,
  } as any;

  test('prefers an explicit provider/model rewrite over the provider-wide fallback', () => {
    const aliasedState = {
      ...state,
      rewrites: {
        ...state.rewrites,
        'anthropic/claude-sonnet-4-6': {
          kind: 'rewrite',
          targetProvider: 'facade',
          targetModel: 'global.anthropic.claude-sonnet-4-6',
        },
      },
    } as any;

    expect(
      resolveProxyRoute(
        { provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' } as any,
        'Claude Sonnet 4.6',
        aliasedState,
      ),
    ).toEqual({
      sourceRef: 'anthropic/claude-sonnet-4-6',
      visitedKey: 'rewrite:anthropic/claude-sonnet-4-6',
      targetProvider: 'facade',
      targetRefs: ['global.anthropic.claude-sonnet-4-6'],
    });
  });

  test('falls back to provider-wide rewrite with source id and name as target refs', () => {
    expect(
      resolveProxyRoute(
        { provider: 'anthropic', id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 (latest)' } as any,
        'Claude Haiku 4.5 (latest)',
        state,
      ),
    ).toEqual({
      sourceRef: 'anthropic/*',
      visitedKey: 'rewrite:anthropic/*',
      targetProvider: 'devai',
      targetRefs: ['claude-haiku-4-5', 'Claude Haiku 4.5 (latest)'],
    });
  });

  test('returns undefined when no rewrite matches', () => {
    expect(
      resolveProxyRoute(
        { provider: 'openai', id: 'gpt-5.4', name: 'GPT-5.4' } as any,
        'GPT-5.4',
        state,
      ),
    ).toBeUndefined();
  });

  test('null exclusion blocks the provider-wide fallback', () => {
    const excludedState = {
      ...state,
      rewrites: {
        ...state.rewrites,
        'anthropic/claude-experimental': { kind: 'exclude' },
      },
    } as any;

    expect(
      resolveProxyRoute(
        { provider: 'anthropic', id: 'claude-experimental', name: 'Claude Experimental' } as any,
        'Claude Experimental',
        excludedState,
      ),
    ).toBeUndefined();
  });
});

describe('extension registration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  test('registers delegating providers for required apis', async () => {
    const registerApiProvider = vi.fn();

    vi.doMock('@earendil-works/pi-ai', async () => {
      const actual =
        await vi.importActual<typeof import('@earendil-works/pi-ai')>('@earendil-works/pi-ai');
      const make = (): StreamFunction<never, never> => () => createAssistantMessageEventStream();
      const provider = { stream: make(), streamSimple: make() };
      return {
        ...actual,
        registerApiProvider,
        getApiProvider: vi.fn((api: string) => {
          if (
            api === 'anthropic-messages' ||
            api === 'openai-responses' ||
            api === 'openai-completions' ||
            api === 'google-generative-ai'
          ) {
            return provider;
          }
          return undefined;
        }),
      };
    });

    const extMod = await import('./index');
    const ext: typeof extMod.default = extMod.default;

    ext({ on: vi.fn() } as unknown as ExtensionAPI);

    expect(registerApiProvider).toHaveBeenCalledTimes(4);
    expect(
      registerApiProvider.mock.calls.map((c) => c[0].api).sort((a, b) => a.localeCompare(b)),
    ).toEqual([
      'anthropic-messages',
      'google-generative-ai',
      'openai-completions',
      'openai-responses',
    ]);
  });

  test('routes through the target provider and rewrites emitted model metadata', async () => {
    const registerApiProvider = vi.fn();
    const registeredProviders = new Map<string, any>();
    const originalProviderStreamSimple = vi.fn((model: any) => createDoneStream(model));
    const originalProvider = {
      stream: vi.fn((model: any) => createDoneStream(model)),
      streamSimple: originalProviderStreamSimple,
    };

    vi.doMock('@earendil-works/pi-ai', async () => {
      const actual =
        await vi.importActual<typeof import('@earendil-works/pi-ai')>('@earendil-works/pi-ai');
      return {
        ...actual,
        registerApiProvider: vi.fn((provider: any, sourceId: string) => {
          registeredProviders.set(provider.api, provider);
          registerApiProvider(provider, sourceId);
        }),
        getApiProvider: vi.fn((api: string) => {
          if (api === 'anthropic-messages') return originalProvider;
          return originalProvider;
        }),
        streamSimple: vi.fn((model: any, context: any, options: any) =>
          registeredProviders.get(model.api).streamSimple(model, context, options),
        ),
        stream: vi.fn((model: any, context: any, options: any) =>
          registeredProviders.get(model.api).stream(model, context, options),
        ),
      };
    });

    const settingsMod = await import('./settings');
    vi.mocked(settingsMod.loadProxiedProviders).mockReturnValue({});
    vi.mocked(settingsMod.loadProxiedProviderRewrites).mockReturnValue({
      'anthropic/*': { kind: 'rewrite', targetProvider: 'devai' },
    });

    const extMod = await import('./index');
    const ext: typeof extMod.default = extMod.default;
    const handlers = new Map<string, any>();
    ext({ on: vi.fn((event: string, handler: any) => handlers.set(event, handler)) } as any);

    const modelRegistry = {
      find: vi.fn((provider: string, id: string) =>
        provider === 'anthropic' && id === 'claude-sonnet-4-6'
          ? {
              provider: 'anthropic',
              id: 'claude-sonnet-4-6',
              name: 'Claude Sonnet 4.6',
            }
          : undefined,
      ),
      getAll: vi.fn(() => [
        {
          provider: 'devai',
          id: 'global.anthropic.claude-sonnet-4-6',
          name: 'claude-sonnet-4-6',
          api: 'anthropic-messages',
        },
      ]),
      getApiKeyAndHeaders: vi.fn(async () => ({
        ok: true,
        apiKey: 'devai-key',
        headers: { 'x-routed': 'devai' },
      })),
    };

    handlers.get('session_start')({}, { cwd: '/tmp/project', modelRegistry });

    const wrappedAnthropic = registeredProviders.get('anthropic-messages');
    const events = await collectEvents(
      wrappedAnthropic.streamSimple(
        {
          provider: 'anthropic',
          id: 'claude-sonnet-4-6',
          name: 'Claude Sonnet 4.6',
          api: 'anthropic-messages',
        },
        { messages: [] },
        {},
      ),
    );

    expect(modelRegistry.getApiKeyAndHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'devai', id: 'global.anthropic.claude-sonnet-4-6' }),
    );
    expect(originalProviderStreamSimple).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'devai', id: 'global.anthropic.claude-sonnet-4-6' }),
      expect.anything(),
      expect.objectContaining({ apiKey: 'devai-key', headers: { 'x-routed': 'devai' } }),
    );
    expect(events).toMatchObject([
      {
        type: 'done',
        message: {
          provider: 'devai',
          model: 'global.anthropic.claude-sonnet-4-6',
          sourceProvider: 'anthropic',
          sourceModel: 'claude-sonnet-4-6',
        },
      },
    ]);
  });

  test('provider routes can fall back from source id to source model name for target lookup', async () => {
    const registeredProviders = new Map<string, any>();
    const originalProviderStreamSimple = vi.fn((model: any) => createDoneStream(model));

    vi.doMock('@earendil-works/pi-ai', async () => {
      const actual =
        await vi.importActual<typeof import('@earendil-works/pi-ai')>('@earendil-works/pi-ai');
      const originalProvider = {
        stream: vi.fn((model: any) => createDoneStream(model)),
        streamSimple: originalProviderStreamSimple,
      };
      return {
        ...actual,
        registerApiProvider: vi.fn((provider: any) =>
          registeredProviders.set(provider.api, provider),
        ),
        getApiProvider: vi.fn(() => originalProvider),
        streamSimple: vi.fn((model: any, context: any, options: any) =>
          registeredProviders.get(model.api).streamSimple(model, context, options),
        ),
        stream: vi.fn((model: any, context: any, options: any) =>
          registeredProviders.get(model.api).stream(model, context, options),
        ),
      };
    });

    const settingsMod = await import('./settings');
    vi.mocked(settingsMod.loadProxiedProviders).mockReturnValue({});
    vi.mocked(settingsMod.loadProxiedProviderRewrites).mockReturnValue({
      'anthropic/*': { kind: 'rewrite', targetProvider: 'devai' },
    });

    const extMod = await import('./index');
    const ext: typeof extMod.default = extMod.default;
    const handlers = new Map<string, any>();
    ext({ on: vi.fn((event: string, handler: any) => handlers.set(event, handler)) } as any);

    const modelRegistry = {
      find: vi.fn((provider: string, id: string) =>
        provider === 'anthropic' && id === 'opaque-source-id'
          ? {
              provider: 'anthropic',
              id: 'opaque-source-id',
              name: 'Claude Sonnet 4.6',
            }
          : undefined,
      ),
      getAll: vi.fn(() => [
        {
          provider: 'devai',
          id: 'global.anthropic.claude-sonnet-4-6',
          name: 'Claude Sonnet 4.6',
          api: 'anthropic-messages',
        },
      ]),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'devai-key', headers: {} })),
    };

    handlers.get('session_start')({}, { cwd: '/tmp/project', modelRegistry });

    const wrappedAnthropic = registeredProviders.get('anthropic-messages');
    const events = await collectEvents(
      wrappedAnthropic.streamSimple(
        {
          provider: 'anthropic',
          id: 'opaque-source-id',
          name: 'Claude Sonnet 4.6',
          api: 'anthropic-messages',
        },
        { messages: [] },
        {},
      ),
    );

    expect(originalProviderStreamSimple).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'devai', id: 'global.anthropic.claude-sonnet-4-6' }),
      expect.anything(),
      expect.objectContaining({ apiKey: 'devai-key' }),
    );
    expect(events).toMatchObject([
      {
        type: 'done',
        message: {
          provider: 'devai',
          model: 'global.anthropic.claude-sonnet-4-6',
          sourceProvider: 'anthropic',
          sourceModel: 'opaque-source-id',
        },
      },
    ]);
  });

  test('treats a self route as a no-op and falls through to the original provider', async () => {
    const registeredProviders = new Map<string, any>();

    vi.doMock('@earendil-works/pi-ai', async () => {
      const actual =
        await vi.importActual<typeof import('@earendil-works/pi-ai')>('@earendil-works/pi-ai');
      const originalProvider = {
        stream: vi.fn((model: any) => createDoneStream(model)),
        streamSimple: vi.fn((model: any) => createDoneStream(model)),
      };
      return {
        ...actual,
        registerApiProvider: vi.fn((provider: any) =>
          registeredProviders.set(provider.api, provider),
        ),
        getApiProvider: vi.fn(() => originalProvider),
        streamSimple: vi.fn((model: any, context: any, options: any) =>
          registeredProviders.get(model.api).streamSimple(model, context, options),
        ),
        stream: vi.fn((model: any, context: any, options: any) =>
          registeredProviders.get(model.api).stream(model, context, options),
        ),
      };
    });

    const settingsMod = await import('./settings');
    vi.mocked(settingsMod.loadProxiedProviders).mockReturnValue({});
    vi.mocked(settingsMod.loadProxiedProviderRewrites).mockReturnValue({
      'anthropic/*': { kind: 'rewrite', targetProvider: 'anthropic' },
    });

    const extMod = await import('./index');
    const ext: typeof extMod.default = extMod.default;
    const handlers = new Map<string, any>();
    ext({ on: vi.fn((event: string, handler: any) => handlers.set(event, handler)) } as any);

    const sourceModel = {
      provider: 'anthropic',
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      api: 'anthropic-messages',
    };
    const modelRegistry = {
      find: vi.fn(() => sourceModel),
      getAll: vi.fn(() => [sourceModel]),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'anthropic-key', headers: {} })),
    };

    handlers.get('session_start')({}, { cwd: '/tmp/project', modelRegistry });

    const wrappedAnthropic = registeredProviders.get('anthropic-messages');
    const events = await collectEvents(
      wrappedAnthropic.streamSimple(sourceModel, { messages: [] }, {}),
    );

    expect(events).toMatchObject([
      {
        type: 'done',
        message: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
        },
      },
    ]);
  });

  test('treats an alias resolving back to the same model as a no-op', async () => {
    const registeredProviders = new Map<string, any>();

    vi.doMock('@earendil-works/pi-ai', async () => {
      const actual =
        await vi.importActual<typeof import('@earendil-works/pi-ai')>('@earendil-works/pi-ai');
      const originalProvider = {
        stream: vi.fn((model: any) => createDoneStream(model)),
        streamSimple: vi.fn((model: any) => createDoneStream(model)),
      };
      return {
        ...actual,
        registerApiProvider: vi.fn((provider: any) =>
          registeredProviders.set(provider.api, provider),
        ),
        getApiProvider: vi.fn(() => originalProvider),
        streamSimple: vi.fn((model: any, context: any, options: any) =>
          registeredProviders.get(model.api).streamSimple(model, context, options),
        ),
        stream: vi.fn((model: any, context: any, options: any) =>
          registeredProviders.get(model.api).stream(model, context, options),
        ),
      };
    });

    const settingsMod = await import('./settings');
    vi.mocked(settingsMod.loadProxiedProviders).mockReturnValue({});
    vi.mocked(settingsMod.loadProxiedProviderRewrites).mockReturnValue({
      'anthropic/claude-sonnet-4-6': {
        kind: 'rewrite',
        targetProvider: 'anthropic',
        targetModel: 'claude-sonnet-4-6',
      },
    });

    const extMod = await import('./index');
    const ext: typeof extMod.default = extMod.default;
    const handlers = new Map<string, any>();
    ext({ on: vi.fn((event: string, handler: any) => handlers.set(event, handler)) } as any);

    const sourceModel = {
      provider: 'anthropic',
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      api: 'anthropic-messages',
    };
    const modelRegistry = {
      find: vi.fn(() => sourceModel),
      getAll: vi.fn(() => [sourceModel]),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: 'anthropic-key', headers: {} })),
    };

    handlers.get('session_start')({}, { cwd: '/tmp/project', modelRegistry });

    const wrappedAnthropic = registeredProviders.get('anthropic-messages');
    const events = await collectEvents(
      wrappedAnthropic.streamSimple(sourceModel, { messages: [] }, {}),
    );

    expect(events).toMatchObject([
      {
        type: 'done',
        message: {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
        },
      },
    ]);
  });
});

describe('provider response diagnostics', () => {
  beforeEach(() => {
    delete process.env.PI_PROXIED_PROVIDERS_DIAGNOSTICS;
  });

  test('summarizes rate-limit and retry headers', () => {
    const summary = summarizeProviderResponseHeaders({
      'retry-after': '12',
      'x-ratelimit-remaining-requests': '0',
      'x-ratelimit-reset-requests': '1700000000',
      server: 'cloudflare',
    });
    expect(summary).toBe(
      'retry-after=12 x-ratelimit-remaining-requests=0 x-ratelimit-reset-requests=1700000000 server=cloudflare',
    );
  });

  test('returns undefined when no interesting headers are present', () => {
    expect(
      summarizeProviderResponseHeaders({ 'content-type': 'application/json' }),
    ).toBeUndefined();
  });

  test('warns on 429 responses with retry-after', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      reportProviderResponse({ status: 429, headers: { 'retry-after': '3' } });
      expect(warn).toHaveBeenCalledWith(
        '[proxied-providers] provider response 429 — retry-after=3',
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('warns on 5xx responses without headers using a short form', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      reportProviderResponse({ status: 503, headers: {} });
      expect(warn).toHaveBeenCalledWith('[proxied-providers] provider response 503');
    } finally {
      warn.mockRestore();
    }
  });

  test('stays silent for successful responses', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      reportProviderResponse({ status: 200, headers: { 'retry-after': '10' } });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('honors PI_PROXIED_PROVIDERS_DIAGNOSTICS=0 to opt out', () => {
    process.env.PI_PROXIED_PROVIDERS_DIAGNOSTICS = '0';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      reportProviderResponse({ status: 500, headers: { 'retry-after': '1' } });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
