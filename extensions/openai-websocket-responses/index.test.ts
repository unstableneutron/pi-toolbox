import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAssistantMessageEventStream,
  getApiProvider,
  type AssistantMessage,
  type Model,
  unregisterApiProviders,
} from '@earendil-works/pi-ai/compat';
import { describe, expect, it, vi } from 'vitest';

const wsModuleMock = vi.hoisted(() => ({
  WebSocketCtor: undefined as any,
}));

vi.mock('ws', () => ({
  get WebSocket() {
    return wsModuleMock.WebSocketCtor;
  },
  get default() {
    return wsModuleMock.WebSocketCtor;
  },
}));

import {
  createIdleKeepaliveActivityTracker,
  formatWebSocketFailureNotification,
  formatWebSocketStatus,
  IDLE_KEEPALIVE_ACTIVITY_WINDOW_MS,
  installOpenAIWebSocketResponsesApiPatches,
  registerOpenAIWebSocketResponsesApiProvider,
  registerOpenAIWebSocketResponsesPatchRefreshHooks,
} from './index.ts';
import { buildResponsesBody } from './src/body.ts';
import { shortHash } from './src/debug.ts';
import {
  buildContinuationRequestBody,
  buildSocketCacheKey,
  clearAllContinuations,
  clearContinuation,
  getContinuation,
  headersFingerprint,
  requestBodyForContinuationComparison,
  setContinuation,
  type ContinuationState,
} from './src/continuation-cache.ts';
import {
  buildRequestHeaders,
  buildWebSocketHeaders,
  headersDiagnosticFields,
} from './src/headers.ts';
import { resolveModelTransportPolicy, shouldPatchModel } from './src/match.ts';
import { resolveRequestProfile } from './src/profile.ts';
import {
  buildWebSocketResponseHeaders,
  createOpenAIWebSocketResponsesStream,
  summarizeResponsesInputItemIds,
} from './src/provider.ts';
import {
  clearWebSocketCapabilityCache,
  isWebSocketUnsupportedError,
  wrapProviderForWebSocketResponses,
} from './src/patch.ts';
import {
  attachTransportDiagnostic,
  createTransportDiagnostics,
  extractTransportDiagnostics,
  mergeTransportDiagnostics,
  shouldIncludeSuccessTimeline,
} from './src/transport-diagnostics.ts';
import { recoverResponseByRetrieve } from './src/retrieve-recovery.ts';
import { isReplayUnsafeResponsesEvent } from '../shared/openai-responses-retry.ts';
import { TerminalResponseError } from '../shared/openai-responses-terminal.ts';
import {
  createTraceContext,
  createTraceContextForTraceId,
  isTraceparent,
  parseTraceparent,
} from './src/trace-context.ts';
import {
  assistantMessageToResponseItems,
  createResponsesEventProcessor,
  extractResponseOutputText,
  processResponsesEvents,
} from './src/responses-adapter.ts';
import {
  defaultOpenAIWebSocketResponsesOmpConfigPaths,
  normalizeSettings,
  readOpenAIWebSocketResponsesOmpSettings,
  readOpenAIWebSocketResponsesSettings,
} from './src/settings.ts';
import { createOpenAISseResponsesStream } from './src/sse-provider.ts';
import { resolveRetrieveResponseUrl, resolveWebSocketResponsesUrl } from './src/urls.ts';
import {
  closeAllCachedWebSockets,
  runWebSocketResponse,
  type WebSocketLifecycleEvent,
  WebSocketMidstreamError,
} from './src/websocket.ts';

function makeModel(overrides: Partial<Model<any>> = {}): Model<any> {
  return {
    id: 'gpt-5.5-nomoderation',
    name: 'GPT-5.5',
    api: 'openai-responses',
    provider: 'facade',
    baseUrl:
      'https://llm-fusion-hub.example/api/v2/proxy/experimental/azure_openai/openai/v1/?api-version=preview',
    headers: {
      'x-azure-deployment': 'gpt-5.5-nomoderation',
      'x-azure-region': 'global',
      'x-azure-resource-bucket': 'internal-productivity',
    },
    reasoning: true,
    thinkingLevelMap: { off: 'none', low: 'low', medium: 'medium', high: 'high' },
    input: ['text', 'image'],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4096,
    ...overrides,
  } as Model<any>;
}

function makeCodexModel(overrides: Partial<Model<any>> = {}): Model<any> {
  return makeModel({
    id: 'gpt-5.5-fast',
    name: 'GPT-5.5 Fast',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api',
    headers: { 'x-api-key': 'sk-pi-test' },
    ...overrides,
  });
}

function makeAssistantMessage(model = makeModel()): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-websocket-responses',
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
    timestamp: 1,
  };
}

async function* events(...items: Record<string, any>[]): AsyncIterable<Record<string, any>> {
  for (const item of items) yield item;
}

describe('transport diagnostics', () => {
  it('attaches significant transport timelines with sanitized bounded URLs', () => {
    const diagnostics = createTransportDiagnostics(
      {
        configuredTransport: 'auto',
        url: 'wss://user:pass@example.test/responses?deployment=gpt-5.5&api-key=secret&region=eastus',
        previousResponseId: 'resp_prev',
        requestBytes: 1234,
      },
      () => 1000,
    );
    expect(diagnostics.isSignificant()).toBe(false);

    for (let index = 0; index < 25; index++) diagnostics.record('ws_acquire', { index });
    diagnostics.record('ws_close', { attempt: 0, connectionId: 'ws#61245', code: 1006 });

    const message = makeAssistantMessage();
    expect(
      attachTransportDiagnostic(message, diagnostics, {
        finalTransport: 'websocket',
        outcome: 'transport_error',
      }),
    ).toBe(true);

    const [diagnostic] = extractTransportDiagnostics(message);
    expect(diagnostic?.type).toBe('openai_websocket_transport');
    expect(diagnostic?.details).toMatchObject({
      configuredTransport: 'auto',
      finalTransport: 'websocket',
      outcome: 'transport_error',
      previousResponseId: 'resp_prev',
      requestBytes: 1234,
    });
    expect(diagnostic?.details?.requestId).toMatch(/^owsr_/);
    const sanitizedUrl =
      'wss://example.test/responses?deployment=gpt-5.5&api-key=REDACTED&region=eastus';
    expect(diagnostic?.details?.url).toBe(sanitizedUrl);
    expect(diagnostic?.details?.urlHash).toBe(shortHash(sanitizedUrl));
    expect(diagnostic?.details?.timeline).toHaveLength(20);
    expect(diagnostics.hasEvent('ws_close')).toBe(true);
    expect(diagnostics.hasEvent('ws_retry')).toBe(false);
    expect(diagnostic?.details?.timeline).toContainEqual(
      expect.objectContaining({ type: 'ws_close', code: 1006, connectionId: 'ws#61245' }),
    );
  });

  it('merges websocket diagnostics onto fallback assistant messages', () => {
    const diagnostics = createTransportDiagnostics(
      { configuredTransport: 'auto', url: 'wss://example.test/responses' },
      () => 1000,
    );
    diagnostics.record('ws_close', { attempt: 0, code: 1006 });
    const websocketError = makeAssistantMessage();
    attachTransportDiagnostic(websocketError, diagnostics, {
      finalTransport: 'websocket',
      outcome: 'transport_error',
    });

    const sseMessage = makeAssistantMessage();
    mergeTransportDiagnostics(sseMessage, extractTransportDiagnostics(websocketError), {
      finalTransport: 'sse',
      fallbackTransport: 'sse',
      outcome: 'sse_fallback_after_websocket_failure',
      timelineEvent: { type: 'sse_fallback', reason: 'websocket_failed_before_stream_start' },
    });

    const [diagnostic] = extractTransportDiagnostics(sseMessage);
    expect(diagnostic?.details).toMatchObject({
      configuredTransport: 'auto',
      finalTransport: 'sse',
      fallbackTransport: 'sse',
      outcome: 'sse_fallback_after_websocket_failure',
    });
    expect(diagnostic?.details?.timeline).toContainEqual(
      expect.objectContaining({ type: 'sse_fallback' }),
    );
  });

  it('emits compact success timing fields and only includes timelines when requested', async () => {
    let now = 1000;
    const diagnostics = createTransportDiagnostics(
      {
        configuredTransport: 'websocket',
        url: 'wss://example.test/responses',
        logicalTraceId: 'trace-success-timing',
      },
      () => now,
    );

    class FakeWebSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        queueMicrotask(() => this.emit('open', {}));
      }

      send() {
        queueMicrotask(() => {
          now = 1042;
          this.emit('message', {
            data: JSON.stringify({ type: 'response.created', response: { id: 'resp_timing' } }),
          });
          now = 1100;
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.completed',
              response: { id: 'resp_timing', status: 'completed' },
            }),
          });
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    await runWebSocketResponse(
      {
        url: 'wss://example.test/responses',
        headers: new Headers(),
        body: { model: 'gpt', input: [] },
        settings: normalizeSettings({ websocket: { retries: 0 } }),
        WebSocketCtor: FakeWebSocket as any,
        diagnostics,
      },
      () => undefined,
    );

    const compactMessage = makeAssistantMessage();
    attachTransportDiagnostic(compactMessage, diagnostics, {
      finalTransport: 'websocket',
      outcome: 'completed',
    });
    const [compact] = extractTransportDiagnostics(compactMessage);
    expect(compact?.details).toMatchObject({
      firstEventMs: 42,
      responseCreatedMs: 42,
      lastEventMs: 100,
      completedMs: 100,
    });
    expect(compact?.details).not.toHaveProperty('timeline');

    const sampledMessage = makeAssistantMessage();
    attachTransportDiagnostic(sampledMessage, diagnostics, {
      finalTransport: 'websocket',
      outcome: 'completed',
      includeTimeline: true,
    });
    const [sampled] = extractTransportDiagnostics(sampledMessage);
    expect(sampled?.details?.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'first_event', tMs: 42, eventType: 'response.created' }),
        expect.objectContaining({ type: 'response_created', tMs: 42 }),
        expect.objectContaining({ type: 'response_completed', tMs: 100 }),
      ]),
    );
  });

  it('samples successful websocket timelines at the configured rate and for slow starts', () => {
    const settings = normalizeSettings({
      diagnostics: {
        successTimelineSampleRate: 0.05,
        successTimelineSlowStartThresholdMs: 30000,
      },
    });

    expect(shouldIncludeSuccessTimeline(settings, { responseCreatedMs: 1200 }, () => 0.049)).toBe(
      true,
    );
    expect(shouldIncludeSuccessTimeline(settings, { responseCreatedMs: 1200 }, () => 0.05)).toBe(
      false,
    );
    expect(shouldIncludeSuccessTimeline(settings, { responseCreatedMs: 30000 }, () => 0.99)).toBe(
      true,
    );
    expect(shouldIncludeSuccessTimeline(settings, { firstEventMs: 31000 }, () => 0.99)).toBe(true);
  });
});

describe('settings and patch matching', () => {
  it('defaults to transparent patching for OpenAI Responses providers', () => {
    expect(normalizeSettings(undefined)).toMatchObject({
      patch: {
        enabled: true,
        apis: ['openai-responses', 'openai-codex-responses'],
        providers: ['openai', 'openai-codex'],
        providerModels: [],
        excludeProviderModels: [],
      },
      request: { queryParams: {}, storeByProviderModel: {} },
      websocket: {
        retries: 2,
        connectTimeoutMs: 15000,
        firstEventTimeoutMs: 60000,
        idleTimeoutMs: 0,
      },
      diagnostics: {
        successTimingFields: true,
        successTimelineSampleRate: 0.05,
        successTimelineSlowStartThresholdMs: 30000,
      },
      recovery: {
        enabled: true,
        pollIntervalMs: 1000,
        timeoutMs: 30000,
        notFoundGraceMs: 5000,
        emitSyntheticDeltas: true,
      },
      trace: { enabled: true },
    });
  });

  it('normalizes per-model transport policy and treats it as a parser route', () => {
    const settings = normalizeSettings({
      patch: {
        providers: [],
        providerModels: [],
        transportByProviderModel: {
          'devai/*': 'sse',
          'devai/gpt-5.6-ws': 'websocket',
          ignored: 'invalid',
        },
      },
    });
    const sseModel = makeModel({ provider: 'devai', id: 'gpt-5.6-sol' });
    const websocketModel = makeModel({ provider: 'devai', id: 'gpt-5.6-ws' });

    expect(settings.patch.transportByProviderModel).toEqual({
      'devai/*': 'sse',
      'devai/gpt-5.6-ws': 'websocket',
    });
    expect(shouldPatchModel(sseModel, settings)).toBe(true);
    expect(resolveModelTransportPolicy(sseModel, settings)).toBe('sse');
    expect(resolveModelTransportPolicy(websocketModel, settings)).toBe('websocket');
  });

  it('normalizes store overrides by provider/model glob', () => {
    expect(
      normalizeSettings({
        request: {
          storeByProviderModel: {
            'facade/productivity/gpt-5*': false,
            'devai/gpt-5*': true,
            invalid: 'nope',
          },
        },
      }).request.storeByProviderModel,
    ).toEqual({
      'facade/productivity/gpt-5*': false,
      'devai/gpt-5*': true,
    });
  });

  it('normalizes trace settings as default-on with an explicit opt-out', () => {
    expect(normalizeSettings(undefined).trace.enabled).toBe(true);
    expect(normalizeSettings({ trace: { enabled: false } }).trace.enabled).toBe(false);
    expect(normalizeSettings({ trace: { enabled: 'nope' } }).trace.enabled).toBe(true);
  });

  it('normalizes diagnostics sampling settings with safe defaults', () => {
    expect(
      normalizeSettings({
        diagnostics: {
          successTimingFields: false,
          successTimelineSampleRate: 2,
          successTimelineSlowStartThresholdMs: -1,
        },
      }).diagnostics,
    ).toEqual({
      successTimingFields: false,
      successTimelineSampleRate: 1,
      successTimelineSlowStartThresholdMs: 30000,
    });
  });

  it('reads the openaiWebsocketResponses key from commented settings JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openai-websocket-settings-'));
    const path = join(dir, 'settings.json');
    try {
      writeFileSync(
        path,
        `{
          // New public key: Websocket, not WebSocket.
          "openaiWebsocketResponses": {
            "patch": {
              "enabled": true,
              "providerModels": ["facade/gpt-5.5-nomoderation"]
            },
            "request": {
              "queryParams": {
                "api-version": "preview"
              }
            }
          }
        }`,
      );

      const settings = readOpenAIWebSocketResponsesSettings(path);
      expect(settings).toMatchObject({
        patch: { enabled: true, providerModels: ['facade/gpt-5.5-nomoderation'] },
        request: {
          profile: 'auto',
          queryParams: { 'api-version': 'preview' },
          queryParamsByProvider: {},
          queryParamsByProviderModel: {},
          storeByProviderModel: {},
        },
      });
      expect(settings).not.toHaveProperty('registerSmokeProvider');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the old openaiWebSocketResponses key as a compatibility alias', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openai-websocket-settings-'));
    const path = join(dir, 'settings.json');
    try {
      writeFileSync(
        path,
        JSON.stringify({
          openaiWebSocketResponses: {
            patch: { enabled: true, providers: ['facade'] },
          },
        }),
      );

      expect(readOpenAIWebSocketResponsesSettings(path)).toMatchObject({
        patch: { enabled: true, providers: ['facade'] },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the openaiWebsocketResponses key from OMP config YAML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openai-websocket-omp-config-'));
    const path = join(dir, 'config.yaml');
    try {
      writeFileSync(
        path,
        `openaiWebsocketResponses:
  patch:
    enabled: true
    providers:
      - facade
  request:
    queryParams:
      api-version: preview
    storeByProviderModel:
      facade/productivity/gpt-5*: false
  websocket:
    retries: 4
`,
      );

      expect(readOpenAIWebSocketResponsesOmpSettings(path)).toMatchObject({
        patch: { enabled: true, providers: ['facade'] },
        request: {
          queryParams: { 'api-version': 'preview' },
          storeByProviderModel: { 'facade/productivity/gpt-5*': false },
        },
        websocket: { retries: 4 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('continues from config.yml to config.yaml when the first OMP config has no extension block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openai-websocket-omp-config-'));
    const ymlPath = join(dir, 'config.yml');
    const yamlPath = join(dir, 'config.yaml');
    try {
      writeFileSync(ymlPath, 'theme:\n  dark: graphite\n');
      writeFileSync(
        yamlPath,
        `openaiWebsocketResponses:
  websocket:
    retries: 6
`,
      );

      expect(readOpenAIWebSocketResponsesOmpSettings([ymlPath, yamlPath])).toMatchObject({
        websocket: { retries: 6 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves default OMP config paths from profile and custom agent dir env', () => {
    expect(
      defaultOpenAIWebSocketResponsesOmpConfigPaths('/home/example', {
        OMP_PROFILE: 'work',
      }),
    ).toEqual([
      '/home/example/.omp/profiles/work/agent/config.yml',
      '/home/example/.omp/profiles/work/agent/config.yaml',
    ]);

    expect(
      defaultOpenAIWebSocketResponsesOmpConfigPaths('/home/example', {
        PI_CODING_AGENT_DIR: '/tmp/agent',
        OMP_PROFILE: 'work',
      }),
    ).toEqual(['/tmp/agent/config.yml', '/tmp/agent/config.yaml']);

    expect(
      defaultOpenAIWebSocketResponsesOmpConfigPaths('/home/example', {}, [
        'omp',
        '--profile',
        'cli',
      ]),
    ).toEqual([
      '/home/example/.omp/profiles/cli/agent/config.yml',
      '/home/example/.omp/profiles/cli/agent/config.yaml',
    ]);

    expect(
      defaultOpenAIWebSocketResponsesOmpConfigPaths('/home/example', {}, ['omp', '--profile=eq']),
    ).toEqual([
      '/home/example/.omp/profiles/eq/agent/config.yml',
      '/home/example/.omp/profiles/eq/agent/config.yaml',
    ]);
  });

  it('normalizes request profile and detects Azure vs Codex endpoints', () => {
    expect(normalizeSettings({ request: { profile: 'codex' } }).request.profile).toBe('codex');
    expect(normalizeSettings({ request: { profile: 'unknown' } }).request.profile).toBe('auto');

    expect(resolveRequestProfile(makeModel(), normalizeSettings(undefined))).toBe('azure');
    expect(resolveRequestProfile(makeCodexModel(), normalizeSettings(undefined))).toBe('codex');
    expect(
      resolveRequestProfile(
        makeModel({ baseUrl: 'https://example.test/openai/v1', headers: {} }),
        normalizeSettings({ request: { profile: 'generic' } }),
      ),
    ).toBe('generic');
  });

  it('matches provider/model globs and honors exclusions', () => {
    const settings = normalizeSettings({
      patch: {
        enabled: true,
        apis: ['openai-responses'],
        providers: [],
        providerModels: ['facade/gpt-*'],
        excludeProviderModels: ['facade/gpt-4*'],
      },
    });

    expect(shouldPatchModel(makeModel({ id: 'gpt-5.5' }), settings)).toBe(true);
    expect(shouldPatchModel(makeModel({ id: 'gpt-4.1' }), settings)).toBe(false);
    expect(shouldPatchModel(makeModel({ api: 'anthropic-messages' }), settings)).toBe(false);
  });

  it('treats provider star as all providers for the configured APIs', () => {
    const settings = normalizeSettings({
      patch: {
        enabled: true,
        apis: ['openai-responses'],
        providers: ['*'],
      },
    });

    expect(shouldPatchModel(makeModel({ provider: 'facade' }), settings)).toBe(true);
    expect(shouldPatchModel(makeModel({ provider: 'openai' }), settings)).toBe(true);
    expect(shouldPatchModel(makeCodexModel({ api: 'openai-codex-responses' }), settings)).toBe(
      false,
    );
  });
});

describe('URL and header helpers', () => {
  it('builds WSS and retrieve URLs from base URL plus explicit settings query params', () => {
    const settings = normalizeSettings({
      request: { queryParams: { deployment: 'from-settings' } },
    });
    const model = makeModel();

    expect(resolveWebSocketResponsesUrl(model, settings)).toBe(
      'wss://llm-fusion-hub.example/api/v2/proxy/experimental/azure_openai/openai/v1/responses?api-version=preview&deployment=from-settings',
    );
    expect(resolveRetrieveResponseUrl(model, settings, 'resp_123')).toBe(
      'https://llm-fusion-hub.example/api/v2/proxy/experimental/azure_openai/openai/v1/responses/resp_123?api-version=preview&deployment=from-settings',
    );
  });

  it('resolves query param templates from model metadata and headers', () => {
    const settings = normalizeSettings({
      request: {
        queryParams: {
          deployment: '${headers.X-Azure-Deployment}',
          region: '${headers.x-azure-region}',
          bucket: '${headers.x-azure-resource-bucket}',
          model: '${model.id}',
          provider: '${model.provider}',
          label: 'static-${model.name}',
        },
      },
    });
    const model = makeModel({ name: 'GPT 5.5' });

    expect(resolveWebSocketResponsesUrl(model, settings)).toBe(
      'wss://llm-fusion-hub.example/api/v2/proxy/experimental/azure_openai/openai/v1/responses?api-version=preview&deployment=gpt-5.5-nomoderation&region=global&bucket=internal-productivity&model=gpt-5.5-nomoderation&provider=facade&label=static-GPT+5.5',
    );
  });

  it('resolves query param header templates from merged runtime request headers', () => {
    const settings = normalizeSettings({
      request: {
        queryParams: {
          deployment: '${model.id}',
          region: '${headers.x-azure-region}',
          bucket: '${headers.x-azure-resource-bucket}',
        },
      },
    });
    const model = makeModel({ headers: undefined });
    const headers = new Headers({
      'x-azure-region': 'global',
      'x-azure-resource-bucket': 'internal-productivity',
    });

    expect(resolveWebSocketResponsesUrl(model, settings, headers)).toBe(
      'wss://llm-fusion-hub.example/api/v2/proxy/experimental/azure_openai/openai/v1/responses?api-version=preview&deployment=gpt-5.5-nomoderation&region=global&bucket=internal-productivity',
    );
    expect(resolveRetrieveResponseUrl(model, settings, 'resp_123', headers)).toBe(
      'https://llm-fusion-hub.example/api/v2/proxy/experimental/azure_openai/openai/v1/responses/resp_123?api-version=preview&deployment=gpt-5.5-nomoderation&region=global&bucket=internal-productivity',
    );
  });

  it('throws when query param templates reference missing headers', () => {
    const settings = normalizeSettings({
      request: {
        queryParams: {
          deployment: '${headers.x-missing-deployment}',
        },
      },
    });

    expect(() => resolveWebSocketResponsesUrl(makeModel(), settings)).toThrow(
      'Missing header "x-missing-deployment" referenced by query param "deployment"',
    );
  });

  it('omits query params with unresolved non-header templates', () => {
    const settings = normalizeSettings({
      request: {
        queryParams: {
          missing: '${unknown.value}',
          model: '${model.id}',
          static: 'ok',
        },
      },
    });

    expect(resolveWebSocketResponsesUrl(makeModel(), settings)).toBe(
      'wss://llm-fusion-hub.example/api/v2/proxy/experimental/azure_openai/openai/v1/responses?api-version=preview&model=gpt-5.5-nomoderation&static=ok',
    );
  });

  it('applies provider-scoped query params without leaking Azure routing into Codex URLs', () => {
    const settings = normalizeSettings({
      request: {
        queryParamsByProvider: {
          facade: {
            'api-version': 'preview',
            deployment: '${model.id}',
            region: '${headers.x-azure-region}',
            'azure-resource-bucket': '${headers.x-azure-resource-bucket}',
          },
        },
      },
    });

    expect(resolveWebSocketResponsesUrl(makeModel(), settings)).toBe(
      'wss://llm-fusion-hub.example/api/v2/proxy/experimental/azure_openai/openai/v1/responses?api-version=preview&deployment=gpt-5.5-nomoderation&region=global&azure-resource-bucket=internal-productivity',
    );
    expect(resolveWebSocketResponsesUrl(makeCodexModel(), settings)).toBe(
      'wss://chatgpt.com/backend-api/codex/responses',
    );
  });

  it('lets provider-model query params override provider query params', () => {
    const settings = normalizeSettings({
      request: {
        queryParamsByProvider: {
          facade: {
            region: '${headers.x-azure-region}',
            deployment: '${model.id}',
          },
        },
        queryParamsByProviderModel: {
          'facade/gpt-5*': {
            region: 'override-region',
          },
        },
      },
    });

    expect(resolveWebSocketResponsesUrl(makeModel(), settings)).toBe(
      'wss://llm-fusion-hub.example/api/v2/proxy/experimental/azure_openai/openai/v1/responses?api-version=preview&region=override-region&deployment=gpt-5.5-nomoderation',
    );
  });

  it('builds Codex WSS and retrieve URLs from backend-api base URLs', () => {
    const settings = normalizeSettings({ request: { profile: 'auto' } });
    const model = makeCodexModel();

    expect(resolveWebSocketResponsesUrl(model, settings)).toBe(
      'wss://chatgpt.com/backend-api/codex/responses',
    );
    expect(resolveRetrieveResponseUrl(model, settings, 'resp_123')).toBe(
      'https://chatgpt.com/backend-api/codex/responses/resp_123',
    );
  });

  it('builds Codex headers from a JWT api key and session id', () => {
    const apiKey =
      'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF8xMjMifX0.';
    const websocketHeaders = buildWebSocketHeaders(
      makeCodexModel(),
      { apiKey, sessionId: 'session-123', headers: { accept: 'application/json' } },
      'codex',
    );

    expect(websocketHeaders.get('authorization')).toBe(`Bearer ${apiKey}`);
    expect(websocketHeaders.get('chatgpt-account-id')).toBe('acct_123');
    expect(websocketHeaders.get('openai-beta')).toBe('responses_websockets=2026-02-06');
    expect(websocketHeaders.get('x-client-request-id')).toBe('session-123');
    expect(websocketHeaders.get('session-id')).toBe('session-123');
    expect(websocketHeaders.get('accept')).toBeNull();
  });

  it('merges request headers and strips only WSS transport headers', () => {
    const model = makeModel({
      headers: { accept: 'application/json', 'x-azure-deployment': 'gpt-5.5' },
    });
    const requestHeaders = buildRequestHeaders(model, {
      apiKey: 'token',
      headers: { 'content-type': 'application/json', 'x-extra': '1' },
    });
    const websocketHeaders = buildWebSocketHeaders(model, {
      apiKey: 'token',
      headers: { 'content-type': 'application/json', 'x-extra': '1' },
    });

    expect(requestHeaders.get('authorization')).toBe('Bearer token');
    expect(requestHeaders.get('content-type')).toBe('application/json');
    expect(websocketHeaders.get('authorization')).toBe('Bearer token');
    expect(websocketHeaders.get('content-type')).toBeNull();
    expect(websocketHeaders.get('accept')).toBeNull();
    expect(websocketHeaders.get('x-azure-deployment')).toBe('gpt-5.5');
  });

  it('creates valid trace contexts and continues inbound trace ids with a fresh span', () => {
    const root = createTraceContext();
    expect(root.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(root.traceId).not.toBe('00000000000000000000000000000000');
    expect(root.spanId).not.toBe('0000000000000000');
    expect(isTraceparent(root.traceparent)).toBe(true);

    const child = createTraceContext(root.traceparent);
    expect(child.traceId).toBe(root.traceId);
    expect(child.spanId).not.toBe(root.spanId);
    expect(parseTraceparent(child.traceparent)).toEqual(child);
  });

  it('omits traceparent from header fingerprints so tracing does not split socket caches', () => {
    const base = new Headers({ authorization: 'Bearer token', 'x-model': 'gpt' });
    const traced = new Headers(base);
    traced.set('traceparent', createTraceContext().traceparent);

    expect(headersFingerprint(traced)).toBe(headersFingerprint(base));
  });

  it('summarizes auth headers for diagnostics without exposing raw values', () => {
    const headers = new Headers({
      authorization: 'Bearer secret-token',
      'x-api-key': 'secret-key',
      'x-extra': 'safe',
      traceparent: createTraceContext().traceparent,
    });
    const diagnostics = headersDiagnosticFields(headers);

    expect(diagnostics).toEqual({
      headersHash: shortHash(headersFingerprint(headers)),
      authHeaders: ['authorization', 'x-api-key'],
      authHeadersHash: expect.any(String),
    });
    expect(JSON.stringify(diagnostics)).not.toContain('secret');
    expect(headersDiagnosticFields(new Headers({ 'x-extra': 'safe' }))).toEqual({
      headersHash: expect.any(String),
    });
  });
});

describe('body and continuation helpers', () => {
  it('builds Responses body with Azure-supported Codex-compatible fields', () => {
    const body = buildResponsesBody(
      makeModel(),
      {
        systemPrompt: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hi', timestamp: 1 }],
      },
      {
        reasoning: 'medium',
        maxTokens: 123,
        sessionId: 'session-abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789',
        cacheRetention: 'long',
        textVerbosity: 'high',
        serviceTier: 'priority',
      } as any,
    );

    expect(body).toMatchObject({
      model: 'gpt-5.5-nomoderation',
      max_output_tokens: 123,
      instructions: 'You are helpful.',
      store: true,
      text: { verbosity: 'high' },
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'session-abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ-01',
      prompt_cache_retention: '24h',
      reasoning: { effort: 'medium', summary: 'auto' },
    });
    expect(body.service_tier).toBeUndefined();
    expect(body.input).toEqual([expect.objectContaining({ role: 'user' })]);
  });

  it('ignores long non-Responses text signatures and uses fallback input item ids', () => {
    const legacyGeminiTextSignature = 'AY89a19o'.repeat(54);
    const body = buildResponsesBody(makeModel(), {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Previous answer from another provider.',
              textSignature: legacyGeminiTextSignature,
            },
          ],
          timestamp: 1,
          stopReason: 'stop',
        } as any,
      ],
    });

    expect(body.input).toHaveLength(1);
    expect((body.input[0] as any).id).toBe('msg_pi_0_0');
  });

  it('omits max_output_tokens unless a caller explicitly requests a cap', () => {
    const body = buildResponsesBody(
      makeModel({ maxTokens: 123 }),
      { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] },
      undefined,
      'generic',
    );

    expect(body.max_output_tokens).toBeUndefined();
  });

  it('defaults OpenAI provider requests to stateless storage', () => {
    const body = buildResponsesBody(
      makeModel({ provider: 'openai', id: 'gpt-5.4-mini' }),
      { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] },
      undefined,
      'generic',
    );

    expect(body.store).toBe(false);
  });

  it('allows provider/model store overrides for non-Codex profiles', () => {
    const body = buildResponsesBody(
      makeModel({ id: 'productivity/gpt-5.5-nomoderation' }),
      { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] },
      undefined,
      'generic',
      { storeByProviderModel: { 'facade/productivity/gpt-5*': false } },
    );

    expect(body.store).toBe(false);
  });

  it('builds Codex-profile request bodies with Codex-compatible defaults', () => {
    const body = buildResponsesBody(
      makeCodexModel(),
      { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] },
      {
        maxTokens: 123,
        sessionId: 'session-1',
        cacheRetention: 'long',
        serviceTier: 'priority',
      } as any,
      'codex',
    );

    expect(body).toMatchObject({
      model: 'gpt-5.5-fast',
      instructions: 'You are a helpful assistant.',
      store: false,
      text: { verbosity: 'low' },
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'session-1',
      tool_choice: 'auto',
      parallel_tool_calls: true,
      service_tier: 'priority',
    });
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.prompt_cache_retention).toBeUndefined();
  });

  it('omits prompt cache fields when cache retention is disabled for Azure-compatible profiles', () => {
    const body = buildResponsesBody(
      makeModel(),
      { messages: [{ role: 'user', content: 'Hi', timestamp: 1 }] },
      { sessionId: 'session-1', cacheRetention: 'none' },
    );

    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.prompt_cache_retention).toBeUndefined();
  });

  it('serializes tool-result images into function_call_output parts', () => {
    const body = buildResponsesBody(makeModel(), {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call_img|fc_img',
              name: 'view_image',
              arguments: { path: 'scene.png' },
            },
          ],
          timestamp: 1,
          stopReason: 'toolUse',
          provider: 'facade',
          model: 'gpt-5.5-nomoderation',
          api: 'openai-websocket-responses',
        } as any,
        {
          role: 'toolResult',
          toolCallId: 'call_img|fc_img',
          toolName: 'view_image',
          content: [
            { type: 'text', text: 'Read image file [image/png]' },
            { type: 'image', mimeType: 'image/png', data: 'abc123' },
          ],
          isError: false,
          timestamp: 2,
        },
      ],
    });

    expect(body.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_img',
      output: [
        { type: 'input_text', text: 'Read image file [image/png]' },
        { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,abc123' },
      ],
    });
  });

  it('downgrades image-only tool results for text-only Responses models', () => {
    const body = buildResponsesBody(makeModel({ input: ['text'] }), {
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call_img|fc_img',
              name: 'view_image',
              arguments: { path: 'scene.png' },
            },
          ],
          timestamp: 1,
          stopReason: 'toolUse',
          provider: 'facade',
          model: 'gpt-5.5-nomoderation',
          api: 'openai-websocket-responses',
        } as any,
        {
          role: 'toolResult',
          toolCallId: 'call_img|fc_img',
          toolName: 'view_image',
          content: [{ type: 'image', mimeType: 'image/png', data: 'abc123' }],
          isError: false,
          timestamp: 2,
        },
      ],
    });

    expect(body.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_img',
      output: '(see attached image)',
    });
  });

  it('uses Pi 0.80.7 native tool search when models.json enables supportsToolSearch', () => {
    const searchTools = {
      name: 'search_tools',
      description: 'Search for and enable tools',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    };
    const viewImage = {
      name: 'view_image',
      description: 'View an image',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    };
    const body = buildResponsesBody(
      makeModel({
        api: 'openai-websocket-responses',
        compat: { supportsToolSearch: true },
      }),
      {
        tools: [searchTools, viewImage],
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'call_search|fc_search',
                name: 'search_tools',
                arguments: { query: 'image' },
              },
            ],
            timestamp: 1,
            stopReason: 'toolUse',
            provider: 'facade',
            model: 'gpt-5.5-nomoderation',
            api: 'openai-websocket-responses',
          },
          {
            role: 'toolResult',
            toolCallId: 'call_search|fc_search',
            toolName: 'search_tools',
            content: [{ type: 'text', text: 'Loaded tools: view_image' }],
            addedToolNames: ['view_image'],
            isError: false,
            timestamp: 2,
          },
        ],
      } as any,
    );

    expect((body.tools as any[]).map((tool) => tool.name)).toEqual(['search_tools']);
    const searchCall = body.input.find((item: any) => item.type === 'tool_search_call') as any;
    const searchOutput = body.input.find((item: any) => item.type === 'tool_search_output') as any;
    expect(searchCall).toMatchObject({
      call_id: expect.stringMatching(/^pi_tool_load_[a-f0-9]{12}$/),
      execution: 'client',
      status: 'completed',
      arguments: { query: 'view_image', limit: 1 },
    });
    expect(searchOutput).toMatchObject({
      call_id: searchCall.call_id,
      execution: 'client',
      status: 'completed',
      tools: [
        {
          type: 'function',
          name: 'view_image',
          description: 'View an image',
          defer_loading: true,
          strict: false,
        },
      ],
    });
  });

  it('keeps the normal active tool list when supportsToolSearch is disabled', () => {
    const tools = [
      {
        name: 'search_tools',
        description: 'Search for and enable tools',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'view_image',
        description: 'View an image',
        parameters: { type: 'object', properties: {} },
      },
    ];
    const body = buildResponsesBody(makeModel(), {
      tools,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call_search|fc_search',
              name: 'search_tools',
              arguments: { query: 'image' },
            },
          ],
          timestamp: 1,
          stopReason: 'toolUse',
          provider: 'facade',
          model: 'gpt-5.5-nomoderation',
          api: 'openai-responses',
        },
        {
          role: 'toolResult',
          toolCallId: 'call_search|fc_search',
          toolName: 'search_tools',
          content: [{ type: 'text', text: 'Loaded tools: view_image' }],
          addedToolNames: ['view_image'],
          isError: false,
          timestamp: 2,
        },
      ],
    } as any);

    expect((body.tools as any[]).map((tool) => tool.name)).toEqual(['search_tools', 'view_image']);
    expect(body.input.some((item: any) => item.type === 'tool_search_call')).toBe(false);
    expect(body.input.some((item: any) => item.type === 'tool_search_output')).toBe(false);
  });

  it('uses previous_response_id and delta input only when the request prefix matches', () => {
    const previous = buildResponsesBody(makeModel(), {
      messages: [{ role: 'user', content: 'first', timestamp: 1 }],
    });
    const assistantItem = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'first response', annotations: [] }],
      status: 'completed',
      id: 'msg_1',
    };
    const next = {
      ...previous,
      reasoning: { effort: 'high' },
      input: [
        ...previous.input,
        assistantItem,
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
      ],
    };
    const continuation: ContinuationState = {
      lastRequestBody: previous,
      lastResponseId: 'resp_1',
      lastResponseItems: [assistantItem],
    };

    expect(requestBodyForContinuationComparison(next)).not.toHaveProperty('reasoning');
    expect(buildContinuationRequestBody(continuation, next)).toEqual({
      decision: 'delta',
      body: {
        ...next,
        previous_response_id: 'resp_1',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] }],
      },
    });
  });

  it('uses continuation with real assistant response items across turns', async () => {
    const model = makeModel();
    const previous = buildResponsesBody(model, {
      messages: [{ role: 'user', content: 'first', timestamp: 1 }],
    });
    const output = makeAssistantMessage(model);
    const stream = createAssistantMessageEventStream();

    await processResponsesEvents(
      events(
        { type: 'response.created', response: { id: 'resp_1' } },
        { type: 'response.output_item.added', item: { type: 'message', id: 'msg_server_1' } },
        { type: 'response.output_text.delta', delta: 'first response' },
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            id: 'msg_server_1',
            content: [{ type: 'output_text', text: 'first response' }],
          },
        },
        { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } },
      ),
      output,
      stream,
      model,
    );

    const next = buildResponsesBody(model, {
      messages: [
        { role: 'user', content: 'first', timestamp: 1 },
        output,
        { role: 'user', content: 'next', timestamp: 2 },
      ],
    });
    const continuation: ContinuationState = {
      lastRequestBody: previous,
      lastResponseId: 'resp_1',
      lastResponseItems: assistantMessageToResponseItems(output),
    };

    expect(buildContinuationRequestBody(continuation, next)).toEqual({
      decision: 'delta',
      body: {
        ...next,
        previous_response_id: 'resp_1',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'next' }] }],
      },
    });
  });

  it('uses tool output delta when strict prefix matching drifts after parallel tool calls', () => {
    const previous = buildResponsesBody(makeModel(), {
      messages: [{ role: 'user', content: 'inspect two files', timestamp: 1 }],
    });
    const callA = {
      type: 'function_call',
      id: 'fc_a',
      call_id: 'call_a',
      name: 'read',
      arguments: JSON.stringify({ path: 'a.ts' }),
    };
    const callB = {
      type: 'function_call',
      id: 'fc_b',
      call_id: 'call_b',
      name: 'grep',
      arguments: JSON.stringify({ pattern: 'needle' }),
    };
    const outputA = { type: 'function_call_output', call_id: 'call_a', output: 'a contents' };
    const outputB = { type: 'function_call_output', call_id: 'call_b', output: 'grep matches' };
    const next = {
      ...previous,
      input: [
        ...previous.input,
        { ...callA, arguments: JSON.stringify({ path: './a.ts' }) },
        { ...callB, arguments: JSON.stringify({ pattern: 'needle', flags: '' }) },
        outputA,
        outputB,
      ],
    };
    const continuation: ContinuationState = {
      lastRequestBody: previous,
      lastResponseId: 'resp_parallel',
      lastResponseItems: [callA, callB],
    };

    expect(buildContinuationRequestBody(continuation, next)).toEqual({
      decision: 'delta',
      body: {
        ...next,
        previous_response_id: 'resp_parallel',
        input: [outputA, outputB],
      },
    });
  });

  it('does not use tool output delta when a pending parallel tool result is missing', () => {
    const previous = buildResponsesBody(makeModel(), {
      messages: [{ role: 'user', content: 'inspect two files', timestamp: 1 }],
    });
    const callA = {
      type: 'function_call',
      id: 'fc_a',
      call_id: 'call_a',
      name: 'read',
      arguments: JSON.stringify({ path: 'a.ts' }),
    };
    const callB = {
      type: 'function_call',
      id: 'fc_b',
      call_id: 'call_b',
      name: 'grep',
      arguments: JSON.stringify({ pattern: 'needle' }),
    };
    const next = {
      ...previous,
      input: [
        ...previous.input,
        { ...callA, arguments: JSON.stringify({ path: './a.ts' }) },
        callB,
        { type: 'function_call_output', call_id: 'call_a', output: 'a contents' },
      ],
    };
    const continuation: ContinuationState = {
      lastRequestBody: previous,
      lastResponseId: 'resp_parallel',
      lastResponseItems: [callA, callB],
    };

    expect(buildContinuationRequestBody(continuation, next)).toEqual({
      decision: 'input_prefix_mismatch',
      body: next,
    });
  });

  it('does not replay tool calls from length-truncated assistant messages', () => {
    const model = makeModel();
    const truncated = makeAssistantMessage(model);
    truncated.stopReason = 'length';
    truncated.content.push(
      { type: 'text', text: 'Partial answer' },
      { type: 'toolCall', id: 'call_1|fc_1', name: 'bash', arguments: { command: 'echo cut' } },
    );

    const body = buildResponsesBody(model, {
      messages: [
        { role: 'user', content: 'inspect', timestamp: 1 },
        truncated,
        {
          role: 'toolResult',
          toolCallId: 'call_1|fc_1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'orphan' }],
          isError: false,
          timestamp: 2,
        },
        { role: 'user', content: 'retry', timestamp: 2 },
      ],
    });

    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'inspect' }] },
      expect.objectContaining({ type: 'message', content: expect.any(Array) }),
      { role: 'user', content: [{ type: 'input_text', text: 'retry' }] },
    ]);
    expect(body.input).not.toContainEqual(expect.objectContaining({ type: 'function_call' }));
    expect(body.input).not.toContainEqual(
      expect.objectContaining({ type: 'function_call_output' }),
    );
    expect(assistantMessageToResponseItems(truncated)).toEqual([
      expect.objectContaining({ type: 'message', content: expect.any(Array) }),
    ]);
  });

  it('can clear all continuation state on session shutdown', () => {
    setContinuation('key', {
      lastRequestBody: { model: 'gpt', input: [] },
      lastResponseId: 'resp_1',
      lastResponseItems: [],
    });

    clearAllContinuations();

    expect(getContinuation('key')).toBeUndefined();
  });
});

describe('Responses adapter and retrieve recovery', () => {
  it('preserves reasoning items required by following assistant messages', async () => {
    const model = makeModel();
    const output = makeAssistantMessage(model);
    const stream = createAssistantMessageEventStream();
    const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [] };

    await processResponsesEvents(
      events(
        { type: 'response.created', response: { id: 'resp_reasoning' } },
        { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1' } },
        { type: 'response.output_item.done', item: reasoningItem },
        { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1', content: [] } },
        { type: 'response.output_text.delta', delta: 'Need a tool' },
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            id: 'msg_1',
            content: [{ type: 'output_text', text: 'Need a tool' }],
          },
        },
        { type: 'response.completed', response: { id: 'resp_reasoning', status: 'completed' } },
      ),
      output,
      stream,
      model,
    );

    expect(output.content[0]).toEqual(
      expect.objectContaining({
        type: 'thinking',
        thinkingSignature: JSON.stringify(reasoningItem),
      }),
    );
    expect(buildResponsesBody(model, { messages: [output] }).input).toEqual([
      reasoningItem,
      expect.objectContaining({ type: 'message', id: 'msg_1' }),
    ]);
    expect(assistantMessageToResponseItems(output)).toEqual([
      reasoningItem,
      expect.objectContaining({ type: 'message', id: 'msg_1' }),
    ]);
  });

  it('backfills Azure encrypted reasoning from the terminal response', async () => {
    const model = makeModel();
    const output = makeAssistantMessage(model);
    const stream = createAssistantMessageEventStream();
    const doneItem = { type: 'reasoning', id: 'rs_backfill', summary: [] };

    await processResponsesEvents(
      events(
        { type: 'response.output_item.added', output_index: 0, item: doneItem },
        { type: 'response.output_item.done', output_index: 0, item: doneItem },
        {
          type: 'response.completed',
          response: {
            id: 'resp_backfill',
            status: 'completed',
            output: [{ ...doneItem, encrypted_content: 'encrypted-terminal-payload' }],
          },
        },
      ),
      output,
      stream,
      model,
    );

    expect(JSON.parse((output.content[0] as any).thinkingSignature)).toMatchObject({
      type: 'reasoning',
      id: 'rs_backfill',
      encrypted_content: 'encrypted-terminal-payload',
    });
  });

  it('records cache writes and reasoning tokens from terminal usage', async () => {
    const model = makeModel();
    const output = makeAssistantMessage(model);

    await processResponsesEvents(
      events({
        type: 'response.completed',
        response: {
          id: 'resp_usage',
          status: 'completed',
          usage: {
            input_tokens: 20,
            output_tokens: 8,
            total_tokens: 28,
            input_tokens_details: { cached_tokens: 5, cache_write_tokens: 3 },
            output_tokens_details: { reasoning_tokens: 6 },
          },
        },
      }),
      output,
      createAssistantMessageEventStream(),
      model,
    );

    expect(output.usage).toMatchObject({
      input: 12,
      output: 8,
      cacheRead: 5,
      cacheWrite: 3,
      reasoning: 6,
      totalTokens: 28,
    });
  });

  it('preserves completed native web search calls across replay', async () => {
    const model = makeModel();
    const output = makeAssistantMessage(model);
    const stream = createAssistantMessageEventStream();
    const webSearchItem = {
      type: 'web_search_call',
      id: 'ws_1',
      status: 'completed',
      action: { query: 'Responses API prompt caching' },
      results: [{ title: 'Docs', url: 'https://example.com/docs' }],
    };

    await processResponsesEvents(
      events(
        { type: 'response.created', response: { id: 'resp_web' } },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: webSearchItem,
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp_web',
            status: 'completed',
            output: [
              {
                type: 'message',
                id: 'msg_web',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Found the documentation.' }],
              },
            ],
          },
        },
      ),
      output,
      stream,
      model,
    );

    expect((output.content as any[]).filter((block) => block.type === 'response_item')).toEqual([
      { type: 'response_item', item: webSearchItem },
    ]);
    expect(assistantMessageToResponseItems(output)).toEqual([
      webSearchItem,
      expect.objectContaining({ type: 'message', id: 'msg_web' }),
    ]);
    expect(buildResponsesBody(model, { messages: [output] }).input).toEqual([
      webSearchItem,
      expect.objectContaining({ type: 'message', id: 'msg_web' }),
    ]);
  });

  it('omits provider item ids when prior reasoning is unavailable for replay', () => {
    const model = makeModel();
    const output = makeAssistantMessage(model);
    output.stopReason = 'toolUse';
    output.content.push(
      { type: 'thinking', thinking: 'Reasoning summary without a replayable signature' } as any,
      {
        type: 'text',
        text: 'I need to inspect the session.',
        textSignature: JSON.stringify({
          v: 1,
          id: 'msg_requires_missing_reasoning',
          phase: 'commentary',
        }),
      },
      {
        type: 'toolCall',
        id: 'call_missing_reasoning|fc_requires_missing_reasoning',
        name: 'read',
        arguments: { path: 'README.md' },
      },
    );

    const inputItems = buildResponsesBody(model, { messages: [output] }).input as any[];
    const responseItems = assistantMessageToResponseItems(output) as any[];
    const inputMessage = inputItems.find((item) => item.type === 'message');
    const responseMessage = responseItems.find((item) => item.type === 'message');
    const inputFunctionCall = inputItems.find((item) => item.type === 'function_call');
    const responseFunctionCall = responseItems.find((item) => item.type === 'function_call');

    expect(inputMessage).toMatchObject({ type: 'message', phase: 'commentary' });
    expect(responseMessage).toMatchObject({ type: 'message', phase: 'commentary' });
    expect(inputMessage).not.toHaveProperty('id');
    expect(responseMessage).not.toHaveProperty('id');
    expect(inputFunctionCall).toMatchObject({
      type: 'function_call',
      call_id: 'call_missing_reasoning',
      name: 'read',
    });
    expect(responseFunctionCall).toMatchObject({
      type: 'function_call',
      call_id: 'call_missing_reasoning',
      name: 'read',
    });
    expect(inputFunctionCall).not.toHaveProperty('id');
    expect(responseFunctionCall).not.toHaveProperty('id');
  });

  it('drops hidden provider response items after unreplayable reasoning', () => {
    const model = makeModel();
    const output = makeAssistantMessage(model);
    output.content.push(
      { type: 'thinking', thinking: 'Reasoning summary without a replayable signature' } as any,
      {
        type: 'response_item',
        item: {
          type: 'web_search_call',
          id: 'ws_requires_missing_reasoning',
          status: 'completed',
          action: { query: 'Responses replay' },
        },
      } as any,
      { type: 'text', text: 'Found the relevant docs.' },
    );

    expect(buildResponsesBody(model, { messages: [output] }).input).not.toContainEqual(
      expect.objectContaining({ type: 'web_search_call' }),
    );
    expect(assistantMessageToResponseItems(output)).not.toContainEqual(
      expect.objectContaining({ type: 'web_search_call' }),
    );
  });

  it('keeps interleaved output items separate by output_index', async () => {
    const model = makeModel();
    const output = makeAssistantMessage(model);
    const stream = createAssistantMessageEventStream();

    await processResponsesEvents(
      events(
        { type: 'response.created', response: { id: 'resp_interleaved' } },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'msg_a' },
        },
        {
          type: 'response.content_part.added',
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '' },
        },
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { type: 'message', id: 'msg_b' },
        },
        {
          type: 'response.content_part.added',
          output_index: 1,
          content_index: 0,
          part: { type: 'output_text', text: '' },
        },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'A' },
        { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'B' },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'message', id: 'msg_a', content: [{ type: 'output_text', text: 'A' }] },
        },
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: { type: 'message', id: 'msg_b', content: [{ type: 'output_text', text: 'B' }] },
        },
        { type: 'response.completed', response: { id: 'resp_interleaved', status: 'completed' } },
      ),
      output,
      stream,
      model,
    );

    expect(output.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: 'A',
        textSignature: JSON.stringify({ v: 1, id: 'msg_a' }),
      }),
      expect.objectContaining({
        type: 'text',
        text: 'B',
        textSignature: JSON.stringify({ v: 1, id: 'msg_b' }),
      }),
    ]);
  });

  it('recovers text and function calls found only in response.completed output', async () => {
    const model = makeModel();
    const output = makeAssistantMessage(model);
    const stream = createAssistantMessageEventStream();
    const push = vi.spyOn(stream, 'push');

    await processResponsesEvents(
      events({
        type: 'response.completed',
        response: {
          id: 'resp_terminal_only',
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'msg_terminal_only',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Recovered terminal text.' }],
            },
            {
              type: 'function_call',
              id: 'fc_terminal_only',
              call_id: 'call_terminal_only',
              name: 'read',
              arguments: '{"path":"README.md"}',
            },
          ],
        },
      }),
      output,
      stream,
      model,
    );

    expect(output.stopReason).toBe('toolUse');
    expect(output.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: 'Recovered terminal text.',
        textSignature: JSON.stringify({ v: 1, id: 'msg_terminal_only' }),
      }),
      expect.objectContaining({
        type: 'toolCall',
        id: 'call_terminal_only|fc_terminal_only',
        name: 'read',
        arguments: { path: 'README.md' },
      }),
    ]);
    expect(push.mock.calls.map(([event]) => event.type)).toEqual([
      'text_start',
      'text_delta',
      'text_end',
      'toolcall_start',
      'toolcall_delta',
      'toolcall_end',
    ]);
  });

  it('rejects completed responses with reasoning but no text or function calls', async () => {
    const model = makeModel();
    const output = makeAssistantMessage(model);
    const stream = createAssistantMessageEventStream();

    await expect(
      processResponsesEvents(
        events({
          type: 'response.completed',
          response: {
            id: 'resp_reasoning_only',
            status: 'completed',
            output: [{ type: 'reasoning', id: 'rs_only', summary: [] }],
          },
        }),
        output,
        stream,
        model,
      ),
    ).rejects.toThrow(
      'Model produced invalid content: response.completed contained no assistant text or function calls',
    );
  });

  it('preserves text phase in replay input', () => {
    const model = makeModel();
    const output = makeAssistantMessage(model);
    output.content.push({
      type: 'text',
      text: 'commentary text',
      textSignature: JSON.stringify({ v: 1, id: 'msg_phase', phase: 'commentary' }),
    });

    expect(buildResponsesBody(model, { messages: [output] }).input).toEqual([
      expect.objectContaining({ type: 'message', id: 'msg_phase', phase: 'commentary' }),
    ]);
  });

  it('omits failed assistant messages from replay input', () => {
    const model = makeModel();
    const failed = makeAssistantMessage(model);
    failed.stopReason = 'error';
    failed.content.push({ type: 'text', text: 'partial failure' });

    expect(buildResponsesBody(model, { messages: [failed] }).input).toEqual([]);
  });

  it('adds synthetic error tool results for unmatched assistant tool calls', () => {
    const model = makeModel();
    const assistant = makeAssistantMessage(model);
    assistant.stopReason = 'toolUse';
    assistant.content.push({
      type: 'toolCall',
      id: 'call_1|fc_1',
      name: 'read',
      arguments: { path: 'a' },
    });

    expect(
      buildResponsesBody(model, {
        messages: [assistant, { role: 'user', content: 'continue', timestamp: 2 }],
      }).input,
    ).toEqual([
      expect.objectContaining({ type: 'function_call', call_id: 'call_1', id: 'fc_1' }),
      { type: 'function_call_output', call_id: 'call_1', output: 'No result provided' },
      { role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
    ]);
  });

  it('maps response.incomplete terminal events to length stop reason', async () => {
    const model = makeModel();
    const output = makeAssistantMessage(model);
    const stream = createAssistantMessageEventStream();

    await processResponsesEvents(
      events({
        type: 'response.incomplete',
        response: { id: 'resp_incomplete', status: 'incomplete' },
      }),
      output,
      stream,
      model,
    );

    expect(output.responseId).toBe('resp_incomplete');
    expect(output.stopReason).toBe('length');
  });

  it('strips streamed tool calls when the response is incomplete', async () => {
    const model = makeModel();
    const output = makeAssistantMessage(model);
    const stream = createAssistantMessageEventStream();

    await processResponsesEvents(
      events(
        { type: 'response.created', response: { id: 'resp_incomplete' } },
        { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1' } },
        { type: 'response.output_text.delta', delta: 'I will inspect' },
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            id: 'msg_1',
            content: [{ type: 'output_text', text: 'I will inspect' }],
          },
        },
        {
          type: 'response.output_item.added',
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'bash',
            arguments: '',
          },
        },
        { type: 'response.function_call_arguments.delta', delta: '{"command":"for path in /alpha' },
        {
          type: 'response.incomplete',
          response: {
            id: 'resp_incomplete',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
          },
        },
      ),
      output,
      stream,
      model,
    );

    expect(output.responseId).toBe('resp_incomplete');
    expect(output.stopReason).toBe('length');
    expect(output.content).toEqual([
      expect.objectContaining({ type: 'text', text: 'I will inspect' }),
    ]);
    expect(output.content).not.toContainEqual(expect.objectContaining({ type: 'toolCall' }));
  });

  it('recovers reasoning items from retrieve snapshots for later continuation', async () => {
    const model = makeModel();
    const settings = normalizeSettings({ recovery: { pollIntervalMs: 1, timeoutMs: 20 } });
    const output = makeAssistantMessage(model);
    const stream = createAssistantMessageEventStream();
    const reasoningItem = { type: 'reasoning', id: 'rs_recovered', summary: [] };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'resp_reasoning_recovered',
            status: 'completed',
            output: [
              reasoningItem,
              {
                type: 'message',
                id: 'msg_recovered',
                content: [{ type: 'output_text', text: 'Recovered' }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await recoverResponseByRetrieve({
      model,
      settings,
      responseId: 'resp_reasoning_recovered',
      headers: new Headers(),
      emittedText: '',
      output,
      stream,
      fetchImpl,
    });

    expect(output.content[0]).toEqual(
      expect.objectContaining({
        type: 'thinking',
        thinkingSignature: JSON.stringify(reasoningItem),
      }),
    );
    expect(assistantMessageToResponseItems(output)).toEqual([
      reasoningItem,
      expect.objectContaining({ type: 'message', id: 'msg_recovered' }),
    ]);
  });

  it('processes text and function call Responses events', async () => {
    const model = makeModel();
    const output = makeAssistantMessage(model);
    const stream = createAssistantMessageEventStream();

    await processResponsesEvents(
      events(
        { type: 'response.created', response: { id: 'resp_1' } },
        { type: 'response.output_item.added', item: { type: 'message', id: 'msg_1', content: [] } },
        { type: 'response.content_part.added', part: { type: 'output_text', text: '' } },
        { type: 'response.output_text.delta', delta: 'Hello' },
        {
          type: 'response.output_item.done',
          item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Hello' }] },
        },
        {
          type: 'response.output_item.added',
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read',
            arguments: '',
          },
        },
        { type: 'response.function_call_arguments.delta', delta: '{"path":"a"}' },
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read',
            arguments: '{"path":"a"}',
          },
        },
        { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } },
      ),
      output,
      stream,
      model,
    );

    expect(output.responseId).toBe('resp_1');
    expect(output.stopReason).toBe('toolUse');
    expect(output.content).toEqual([
      expect.objectContaining({ type: 'text', text: 'Hello' }),
      expect.objectContaining({
        type: 'toolCall',
        id: 'call_1|fc_1',
        name: 'read',
        arguments: { path: 'a' },
      }),
    ]);
  });

  it('emits complete tool calls from retrieve snapshots without adding empty text', async () => {
    const model = makeModel();
    const settings = normalizeSettings({ recovery: { pollIntervalMs: 1, timeoutMs: 20 } });
    const output = makeAssistantMessage(model);
    const stream = createAssistantMessageEventStream();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'resp_tool',
            status: 'completed',
            output: [
              {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'read',
                arguments: '{"path":"a"}',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await recoverResponseByRetrieve({
      model,
      settings,
      responseId: 'resp_tool',
      headers: new Headers(),
      emittedText: '',
      output,
      stream,
      fetchImpl,
    });

    expect(output.stopReason).toBe('toolUse');
    expect(output.content).toEqual([
      expect.objectContaining({
        type: 'toolCall',
        id: 'call_1|fc_1',
        name: 'read',
        arguments: { path: 'a' },
      }),
    ]);
  });

  it('finalizes existing partial tool calls from retrieve snapshots', async () => {
    const model = makeModel();
    const settings = normalizeSettings({ recovery: { pollIntervalMs: 1, timeoutMs: 20 } });
    const output = makeAssistantMessage(model);
    output.content.push({
      type: 'toolCall',
      id: 'call_1|fc_1',
      name: 'read',
      arguments: {},
      partialJson: '{"path":',
    } as any);
    const stream = createAssistantMessageEventStream();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'resp_tool',
            status: 'completed',
            output: [
              {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'read',
                arguments: '{"path":"a"}',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await recoverResponseByRetrieve({
      model,
      settings,
      responseId: 'resp_tool',
      headers: new Headers(),
      emittedText: '',
      output,
      stream,
      fetchImpl,
    });

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toEqual(
      expect.objectContaining({
        type: 'toolCall',
        id: 'call_1|fc_1',
        name: 'read',
        arguments: { path: 'a' },
      }),
    );
    expect(output.content[0]).not.toHaveProperty('partialJson');
    expect((stream as any).queue.map((event: any) => event.type)).toContain('toolcall_end');
  });

  it('parses recovered tool call arguments with partial-json', async () => {
    const model = makeModel();
    const settings = normalizeSettings({ recovery: { pollIntervalMs: 1, timeoutMs: 20 } });
    const output = makeAssistantMessage(model);
    const stream = createAssistantMessageEventStream();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'resp_tool',
            status: 'completed',
            output: [
              {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'read',
                arguments: '{"path":"a",',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await recoverResponseByRetrieve({
      model,
      settings,
      responseId: 'resp_tool',
      headers: new Headers(),
      emittedText: '',
      output,
      stream,
      fetchImpl,
    });

    expect(output.content).toEqual([
      expect.objectContaining({
        type: 'toolCall',
        id: 'call_1|fc_1',
        name: 'read',
        arguments: { path: 'a' },
      }),
    ]);
  });

  it('applies usage from retrieved completed snapshots', async () => {
    const model = makeModel();
    const settings = normalizeSettings({ recovery: { pollIntervalMs: 1, timeoutMs: 20 } });
    const output = makeAssistantMessage(model);
    const stream = createAssistantMessageEventStream();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'resp_1',
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }],
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              input_tokens_details: { cached_tokens: 4 },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await recoverResponseByRetrieve({
      model,
      settings,
      responseId: 'resp_1',
      headers: new Headers(),
      emittedText: '',
      output,
      stream,
      fetchImpl,
    });

    expect(output.usage).toMatchObject({ input: 6, output: 5, cacheRead: 4, totalTokens: 15 });
  });

  it('does not duplicate text_end when retrieve completes already-finalized text', async () => {
    const model = makeModel();
    const settings = normalizeSettings({ recovery: { pollIntervalMs: 1, timeoutMs: 20 } });
    const output = makeAssistantMessage(model);
    output.content.push({
      type: 'text',
      text: 'Hello',
      textSignature: JSON.stringify({ v: 1, id: 'msg_1' }),
    });
    const stream = createAssistantMessageEventStream();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'resp_1',
            status: 'completed',
            output: [
              {
                type: 'message',
                id: 'msg_1',
                content: [{ type: 'output_text', text: 'Hello' }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await recoverResponseByRetrieve({
      model,
      settings,
      responseId: 'resp_1',
      headers: new Headers(),
      emittedText: 'Hello',
      output,
      stream,
      fetchImpl,
    });

    expect((stream as any).queue.filter((event: any) => event.type === 'text_end')).toHaveLength(0);
  });

  it('emits synthetic text deltas from retrieve snapshots', async () => {
    const model = makeModel();
    const settings = normalizeSettings({ recovery: { pollIntervalMs: 1, timeoutMs: 20 } });
    const output = makeAssistantMessage(model);
    output.content.push({ type: 'text', text: 'Hello' });
    const stream = createAssistantMessageEventStream();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'resp_1',
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const result = await recoverResponseByRetrieve({
      model,
      settings,
      responseId: 'resp_1',
      headers: new Headers(),
      emittedText: 'Hello',
      output,
      stream,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('/responses/resp_1?'),
      expect.anything(),
    );
    expect(result.recoveredText).toBe('Hello world');
    expect(result.polls).toBe(1);
    expect(output.content).toEqual([
      expect.objectContaining({ type: 'text', text: 'Hello world' }),
    ]);
    expect(extractResponseOutputText(result.response)).toBe('Hello world');
  });
});

describe('SSE Responses transport', () => {
  it('uses terminal response output when incremental item events are missing', async () => {
    const requests: Array<{ url: string; body: any }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      const requestBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ url: requestUrl, body: requestBody });
      const terminalEvent = {
        type: 'response.completed',
        response: {
          id: 'resp_sse_terminal',
          status: 'completed',
          usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
          output: [
            {
              type: 'message',
              id: 'msg_sse_terminal',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Recovered from terminal output.' }],
            },
          ],
        },
      };
      return new Response(`data: ${JSON.stringify(terminalEvent)}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const settings = normalizeSettings({});
    const streamFactory = createOpenAISseResponsesStream(
      () => settings,
      () => fetchImpl as typeof fetch,
    );

    const result = await collectStreamEvents(
      streamFactory(
        makeModel({ provider: 'devai', id: 'gpt-5.6-sol' }),
        { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
        { apiKey: 'test-token', transport: 'sse' },
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      'start',
      'text_start',
      'text_delta',
      'text_end',
      'done',
    ]);
    expect(result.at(-1)).toMatchObject({
      type: 'done',
      reason: 'stop',
      message: {
        api: 'openai-responses',
        content: [
          expect.objectContaining({ type: 'text', text: 'Recovered from terminal output.' }),
        ],
      },
    });
    expect(requests).toEqual([
      expect.objectContaining({
        url: expect.stringContaining('/responses'),
        body: expect.objectContaining({ stream: true, store: false }),
      }),
    ]);
  });

  it('emits an error for a completed SSE response with no actionable output', async () => {
    const fetchImpl = vi.fn(async () => {
      const terminalEvent = {
        type: 'response.completed',
        response: {
          id: 'resp_sse_empty',
          status: 'completed',
          output: [{ type: 'reasoning', id: 'rs_sse_empty', summary: [] }],
        },
      };
      return new Response(`data: ${JSON.stringify(terminalEvent)}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const streamFactory = createOpenAISseResponsesStream(
      () => normalizeSettings({}),
      () => fetchImpl as typeof fetch,
    );

    const result = await collectStreamEvents(
      streamFactory(makeModel(), { messages: [] }, { apiKey: 'test-token', transport: 'sse' }),
    );

    expect(result.at(-1)).toMatchObject({
      type: 'error',
      reason: 'error',
      error: {
        stopReason: 'error',
        errorMessage:
          'Model produced invalid content: response.completed contained no assistant text or function calls',
      },
    });
  });
});

describe('WebSocket transport', () => {
  function makeWebSocketCtor(
    behaviors: Array<(socket: any) => void>,
    config: { localPort?: number } = {},
  ) {
    const instances: any[] = [];
    class FakeWebSocket {
      readyState = 1;
      sent: string[] = [];
      listeners = new Map<string, Set<(event: any) => void>>();
      _socket = config.localPort ? { localPort: config.localPort } : undefined;

      constructor(
        readonly url: string,
        readonly socketOptions: unknown,
      ) {
        instances.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }

      send(data: string) {
        this.sent.push(data);
        const behavior = behaviors.shift();
        if (behavior) queueMicrotask(() => behavior(this));
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    return { WebSocketCtor: FakeWebSocket as any, instances };
  }

  it('classifies Responses control events as replay-safe until output starts', () => {
    expect(
      isReplayUnsafeResponsesEvent({ type: 'response.created', response: { id: 'resp_1' } }),
    ).toBe(false);
    expect(isReplayUnsafeResponsesEvent({ type: 'response.in_progress' })).toBe(false);
    expect(
      isReplayUnsafeResponsesEvent({
        type: 'response.output_item.added',
        item: { type: 'message', id: 'msg_1' },
      }),
    ).toBe(true);
    expect(
      isReplayUnsafeResponsesEvent({ type: 'response.output_text.delta', delta: 'hello' }),
    ).toBe(true);
    expect(isReplayUnsafeResponsesEvent({ type: 'response.unknown_new_stream_event' })).toBe(true);
  });

  it('fails fast when no first response event arrives', async () => {
    vi.useFakeTimers();
    class FakeWebSocket {
      readyState = 1;
      sent: string[] = [];
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        queueMicrotask(() => this.emit('open', {}));
      }

      send(data: string) {
        this.sent.push(data);
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    try {
      const run = runWebSocketResponse(
        {
          url: 'wss://example.test/responses',
          headers: new Headers(),
          body: { model: 'gpt', input: [] },
          settings: normalizeSettings({
            websocket: { retries: 0, firstEventTimeoutMs: 25, idleTimeoutMs: 0 },
          }),
          WebSocketCtor: FakeWebSocket as any,
        },
        () => undefined,
      );
      const settled = run.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

      await vi.advanceTimersByTimeAsync(25);
      await Promise.resolve();
      const state = await Promise.race([settled, Promise.resolve('pending')]);
      expect(state).toBe('WebSocket first-event timeout after 25ms');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry websocket upgrade deployment-not-found errors', async () => {
    const instances: any[] = [];
    class FakeWebSocket {
      readyState = 0;
      listeners = new Map<string, Set<(...args: any[]) => void>>();

      constructor() {
        instances.push(this);
        queueMicrotask(() =>
          this.emitNode(
            'unexpected-response',
            {},
            {
              statusCode: 404,
              headers: { 'content-type': 'application/json' },
              on(event: string, listener: (...args: any[]) => void) {
                if (event === 'data') {
                  listener(
                    Buffer.from(
                      JSON.stringify({
                        error: {
                          type: 'invalid_request_error',
                          code: 'DeploymentNotFound',
                          message: 'The API deployment for this resource does not exist.',
                        },
                      }),
                    ),
                  );
                }
                if (event === 'end') listener();
                return this;
              },
            },
          ),
        );
      }

      send() {}

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (...args: any[]) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (...args: any[]) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      on(type: string, listener: (...args: any[]) => void) {
        this.addEventListener(type, listener);
      }

      off(type: string, listener: (...args: any[]) => void) {
        this.removeEventListener(type, listener);
      }

      emitNode(type: string, ...args: any[]) {
        for (const listener of this.listeners.get(type) ?? []) listener(...args);
      }
    }

    const diagnostics = createTransportDiagnostics(
      { configuredTransport: 'auto', url: 'wss://example.test/responses' },
      () => 1000,
    );

    await expect(
      runWebSocketResponse(
        {
          url: 'wss://example.test/responses',
          headers: new Headers(),
          body: { model: 'gpt', input: [] },
          settings: normalizeSettings({ websocket: { retries: 2, firstEventTimeoutMs: 0 } }),
          WebSocketCtor: FakeWebSocket as any,
          diagnostics,
        },
        () => undefined,
      ),
    ).rejects.toThrow('The API deployment for this resource does not exist.');

    expect(instances).toHaveLength(1);
    expect(diagnostics.hasEvent('ws_retry')).toBe(false);
    expect(diagnostics.getFields()).toMatchObject({
      httpStatus: 404,
      failureReason: 'deploymentMissing',
      failureCategory: 'terminal_config_error',
      retryable: false,
    });
  });

  it('retries empty websocket upgrade 500s when the probe finds no active deployment', async () => {
    const instances: any[] = [];
    const fetchCalls: any[] = [];
    class FakeWebSocket {
      readyState = 0;
      listeners = new Map<string, Set<(...args: any[]) => void>>();

      constructor() {
        instances.push(this);
        queueMicrotask(() =>
          this.emitNode(
            'unexpected-response',
            {},
            {
              statusCode: 500,
              headers: { 'content-length': '0' },
              on(event: string, listener: (...args: any[]) => void) {
                if (event === 'end') listener();
                return this;
              },
            },
          ),
        );
      }

      send() {}

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (...args: any[]) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (...args: any[]) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      on(type: string, listener: (...args: any[]) => void) {
        this.addEventListener(type, listener);
      }

      off(type: string, listener: (...args: any[]) => void) {
        this.removeEventListener(type, listener);
      }

      emitNode(type: string, ...args: any[]) {
        for (const listener of this.listeners.get(type) ?? []) listener(...args);
      }
    }

    const diagnostics = createTransportDiagnostics(
      { configuredTransport: 'auto', url: 'wss://example.test/responses' },
      () => 1000,
    );
    const fetch = vi.fn(async (url: string, init: any) => {
      fetchCalls.push({ url, init });
      return new Response(
        JSON.stringify({
          error: {
            type: 'not_found_error',
            code: 'not_found',
            message:
              'Failed to find an active deployment in region: swedencentral for Azure resource bucket: PROTOTYPE',
          },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    });

    await expect(
      runWebSocketResponse(
        {
          url: 'wss://example.test/responses?deployment=missing',
          headers: new Headers({ authorization: 'Bearer test' }),
          body: { model: 'gpt', input: [] },
          settings: normalizeSettings({ websocket: { retries: 2, firstEventTimeoutMs: 0 } }),
          WebSocketCtor: FakeWebSocket as any,
          diagnostics,
          fetch,
        } as any,
        () => undefined,
      ),
    ).rejects.toThrow('Unexpected server response: 500');

    expect(instances).toHaveLength(3);
    expect(fetchCalls).toHaveLength(3);
    expect(fetchCalls[0].url).toBe('https://example.test/responses?deployment=missing');
    expect(JSON.parse(fetchCalls[0].init.body)).toEqual({});
    expect(diagnostics.hasEvent('ws_retry')).toBe(true);
    expect(diagnostics.getFields()).toMatchObject({
      failureReason: 'providerServerError',
      failureCategory: 'transient_retryable',
      retryable: true,
      classificationProbeStatus: 404,
    });
  });

  it('does not retry response.failed deployment-not-found errors', async () => {
    const instances: any[] = [];
    class FakeWebSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        instances.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }

      send() {
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({ type: 'response.created', response: { id: 'resp_failed' } }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.failed',
              response: {
                id: 'resp_failed',
                status: 'failed',
                error: {
                  type: 'invalid_request_error',
                  code: 'DeploymentNotFound',
                  message: 'The API deployment for this resource does not exist.',
                },
              },
            }),
          });
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const diagnostics = createTransportDiagnostics(
      { configuredTransport: 'auto', url: 'wss://example.test/responses' },
      () => 1000,
    );

    await expect(
      runWebSocketResponse(
        {
          url: 'wss://example.test/responses',
          headers: new Headers(),
          body: { model: 'gpt', input: [] },
          settings: normalizeSettings({ websocket: { retries: 2, firstEventTimeoutMs: 0 } }),
          WebSocketCtor: FakeWebSocket as any,
          diagnostics,
        },
        (event) => {
          if (event.type === 'response.failed') {
            throw new TerminalResponseError(event.type, event.response ?? {});
          }
        },
      ),
    ).rejects.toThrow('The API deployment for this resource does not exist.');

    expect(instances).toHaveLength(1);
    expect(diagnostics.hasEvent('ws_retry')).toBe(false);
    expect(diagnostics.getFields()).toMatchObject({
      failureReason: 'deploymentMissing',
      failureCategory: 'terminal_config_error',
      retryable: false,
    });
  });

  it.each([
    [
      'context_length_exceeded',
      'context_length_exceeded',
      "This model's maximum context length was exceeded. Please reduce your input.",
      'maximum context length was exceeded',
    ],
    [
      'model_context_window_exceeded',
      'model_context_window_exceeded',
      'prompt too long; exceeded max context length 131072 tokens.',
      'exceeded max context length',
    ],
  ])('does not retry %s websocket error frames', async (_label, code, message, expectedError) => {
    const instances: any[] = [];
    class FakeWebSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        instances.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }

      send() {
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                code,
                message,
                param: 'input',
              },
            }),
          });
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const diagnostics = createTransportDiagnostics(
      { configuredTransport: 'auto', url: 'wss://example.test/responses' },
      () => 1000,
    );

    await expect(
      runWebSocketResponse(
        {
          url: 'wss://example.test/responses',
          headers: new Headers(),
          body: { model: 'gpt', input: [] },
          settings: normalizeSettings({ websocket: { retries: 2, firstEventTimeoutMs: 0 } }),
          WebSocketCtor: FakeWebSocket as any,
          diagnostics,
        },
        () => undefined,
      ),
    ).rejects.toThrow(expectedError);

    expect(instances).toHaveLength(1);
    expect(diagnostics.hasEvent('ws_retry')).toBe(false);
    expect(diagnostics.getFields()).toMatchObject({
      failureReason: 'invalidRequest',
      failureCategory: 'terminal_config_error',
      retryable: false,
    });
  });

  it.each([
    ['response.incomplete', { status: 'incomplete' }],
    ['response.failed', { status: 'failed' }],
    ['response.cancelled', { status: 'cancelled' }],
    ['response.done', { status: 'incomplete' }],
  ])('evicts cached sockets after %s terminal responses', async (eventType, response) => {
    const instances: any[] = [];
    class FakeWebSocket {
      readyState = 1;
      sent: string[] = [];
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        instances.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }

      send(data: string) {
        this.sent.push(data);
        const responseId = `resp_${instances.length}`;
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({ type: 'response.created', response: { id: responseId } }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: eventType,
              response: { id: responseId, ...response },
            }),
          });
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const request = {
      url: 'wss://example.test/responses',
      headers: new Headers(),
      body: { model: 'gpt', input: [] },
      settings: normalizeSettings({ websocket: { retries: 0, firstEventTimeoutMs: 0 } }),
      cacheKey: `terminal-evicts-cache-key-${eventType}`,
      WebSocketCtor: FakeWebSocket as any,
    };

    try {
      await runWebSocketResponse(request, () => undefined);
      await runWebSocketResponse(request, () => undefined);

      expect(instances).toHaveLength(2);
    } finally {
      closeAllCachedWebSockets();
    }
  });

  it('clears continuation state and suppresses incomplete tool calls in provider streams', async () => {
    const instances: any[] = [];
    const sentBodies: any[] = [];
    class FakeWebSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        instances.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }

      send(data: string) {
        sentBodies.push(JSON.parse(data));
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({ type: 'response.created', response: { id: 'resp_cut' } }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.output_item.added',
              item: {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'bash',
                arguments: '',
              },
            }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.function_call_arguments.delta',
              delta: '{"command":"for path in /alpha',
            }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.incomplete',
              response: { id: 'resp_cut', status: 'incomplete' },
            }),
          });
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const model = makeCodexModel();
    const options = { apiKey: 'sk-test', sessionId: 'session-incomplete' } as any;
    const settings = normalizeSettings({ websocket: { retries: 0, firstEventTimeoutMs: 0 } });
    const websocketHeaders = buildWebSocketHeaders(model, options, 'codex');
    const url = resolveWebSocketResponsesUrl(model, settings, websocketHeaders, 'codex');
    const cacheKey = buildSocketCacheKey({
      sessionId: options.sessionId,
      url,
      provider: model.provider,
      modelId: model.id,
      headersFingerprint: headersFingerprint(websocketHeaders),
    });
    setContinuation(cacheKey, {
      lastRequestBody: buildResponsesBody(
        model,
        { messages: [{ role: 'user', content: 'first', timestamp: 1 }] },
        options,
        'codex',
      ),
      lastResponseId: 'resp_previous',
      lastResponseItems: [],
    });
    wsModuleMock.WebSocketCtor = FakeWebSocket as any;

    try {
      const stream = createOpenAIWebSocketResponsesStream(() => settings)(
        model,
        {
          messages: [
            { role: 'user', content: 'first', timestamp: 1 },
            { role: 'user', content: 'next', timestamp: 2 },
          ],
        },
        options,
      );
      const seen: any[] = [];
      for await (const event of stream) seen.push(event);

      const done = seen.find((event) => event.type === 'done');
      expect(done?.reason).toBe('length');
      expect(done?.message.content).not.toContainEqual(
        expect.objectContaining({ type: 'toolCall' }),
      );
      expect(getContinuation(cacheKey)).toBeUndefined();
      expect(sentBodies[0]).toMatchObject({ previous_response_id: 'resp_previous' });
      expect(instances).toHaveLength(1);
    } finally {
      wsModuleMock.WebSocketCtor = undefined;
      clearContinuation(cacheKey);
      closeAllCachedWebSockets();
    }
  });

  it('clears continuation and emits error when response.done carries failed status', async () => {
    class FakeWebSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        queueMicrotask(() => this.emit('open', {}));
      }

      send() {
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({ type: 'response.created', response: { id: 'resp_failed' } }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.done',
              response: { id: 'resp_failed', status: 'failed' },
            }),
          });
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const model = makeCodexModel();
    const options = { apiKey: 'sk-test', sessionId: 'session-failed-done' } as any;
    const settings = normalizeSettings({ websocket: { retries: 0, firstEventTimeoutMs: 0 } });
    const websocketHeaders = buildWebSocketHeaders(model, options, 'codex');
    const url = resolveWebSocketResponsesUrl(model, settings, websocketHeaders, 'codex');
    const cacheKey = buildSocketCacheKey({
      sessionId: options.sessionId,
      url,
      provider: model.provider,
      modelId: model.id,
      headersFingerprint: headersFingerprint(websocketHeaders),
    });
    setContinuation(cacheKey, {
      lastRequestBody: buildResponsesBody(model, { messages: [] }, options, 'codex'),
      lastResponseId: 'resp_previous',
      lastResponseItems: [],
    });
    wsModuleMock.WebSocketCtor = FakeWebSocket as any;

    try {
      const stream = createOpenAIWebSocketResponsesStream(() => settings)(
        model,
        { messages: [] },
        options,
      );
      const seen: any[] = [];
      for await (const event of stream) seen.push(event);

      expect(seen.at(-1)).toMatchObject({ type: 'error', reason: 'error' });
      expect(getContinuation(cacheKey)).toBeUndefined();
    } finally {
      wsModuleMock.WebSocketCtor = undefined;
      clearContinuation(cacheKey);
      closeAllCachedWebSockets();
    }
  });

  it('retries detail-less response.failed with only reasoning output on a fresh websocket', async () => {
    const instances: FakeWebSocket[] = [];
    const sentBodies: Array<{ instance: number; body: any }> = [];

    class FakeWebSocket {
      readyState = 1;
      readonly instance: number;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        this.instance = instances.push(this) - 1;
        queueMicrotask(() => this.emit('open', {}));
      }

      send(data: string) {
        sentBodies.push({ instance: this.instance, body: JSON.parse(data) });
        queueMicrotask(() => {
          if (this.instance === 0) {
            this.emit('message', {
              data: JSON.stringify({
                type: 'response.created',
                response: { id: 'resp_failed' },
              }),
            });
            this.emit('message', {
              data: JSON.stringify({
                type: 'response.failed',
                response: {
                  id: 'resp_failed',
                  status: 'failed',
                  model: 'gpt-5.5-fast',
                  previous_response_id: 'resp_previous',
                  error: null,
                  incomplete_details: null,
                  output: [{ type: 'reasoning', id: 'rs_failed', summary: [] }],
                },
              }),
            });
            return;
          }

          this.emit('message', {
            data: JSON.stringify({ type: 'response.created', response: { id: 'resp_ok' } }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp_ok',
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    id: 'msg_ok',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Recovered.' }],
                  },
                ],
              },
            }),
          });
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const model = makeCodexModel();
    const options = { apiKey: 'sk-test', sessionId: 'session-empty-failed-retry' } as any;
    const settings = normalizeSettings({ websocket: { retries: 1, firstEventTimeoutMs: 0 } });
    const websocketHeaders = buildWebSocketHeaders(model, options, 'codex');
    const url = resolveWebSocketResponsesUrl(model, settings, websocketHeaders, 'codex');
    const cacheKey = buildSocketCacheKey({
      sessionId: options.sessionId,
      url,
      provider: model.provider,
      modelId: model.id,
      headersFingerprint: headersFingerprint(websocketHeaders),
    });
    setContinuation(cacheKey, {
      lastRequestBody: buildResponsesBody(
        model,
        { messages: [{ role: 'user', content: 'first', timestamp: 1 }] },
        options,
        'codex',
      ),
      lastResponseId: 'resp_previous',
      lastResponseItems: [],
    });
    const lifecycle: any[] = [];
    wsModuleMock.WebSocketCtor = FakeWebSocket as any;

    try {
      const stream = createOpenAIWebSocketResponsesStream(
        () => settings,
        (event) => lifecycle.push(event),
      )(
        model,
        {
          messages: [
            { role: 'user', content: 'first', timestamp: 1 },
            { role: 'user', content: 'next', timestamp: 2 },
          ],
        },
        options,
      );
      const seen: any[] = [];
      for await (const event of stream) seen.push(event);

      expect(seen.at(-1)).toMatchObject({ type: 'done', reason: 'stop' });
      expect(instances).toHaveLength(2);
      expect(sentBodies).toHaveLength(2);
      expect(sentBodies.map(({ body }) => body.previous_response_id)).toEqual([
        'resp_previous',
        'resp_previous',
      ]);
      expect(sentBodies.map(({ body }) => body.input)).toEqual([
        [{ role: 'user', content: [{ type: 'input_text', text: 'next' }] }],
        [{ role: 'user', content: [{ type: 'input_text', text: 'next' }] }],
      ]);
      expect(lifecycle).toContainEqual(
        expect.objectContaining({
          type: 'retry',
          reason: 'empty_response_failed_without_details',
          action: 'retry_fresh_websocket_same_previous_response_id',
          responseId: 'resp_failed',
          previousResponseId: 'resp_previous',
          attempt: 1,
          nextAttempt: 2,
        }),
      );
      expect(lifecycle).toContainEqual(
        expect.objectContaining({
          type: 'recovered',
          mode: 'resumed',
          responseId: 'resp_ok',
        }),
      );
      expect(getContinuation(cacheKey)?.lastResponseId).toBe('resp_ok');
    } finally {
      wsModuleMock.WebSocketCtor = undefined;
      clearContinuation(cacheKey);
      closeAllCachedWebSockets();
    }
  });

  it('swallows ws abortHandshake errors when aborting during connect', async () => {
    const controller = new AbortController();
    let closeHadErrorListener: boolean | undefined;

    class FakeWebSocket {
      readyState = 0;
      listeners = new Map<string, Set<(event: any) => void>>();

      send() {
        throw new Error('should not send before connect');
      }

      close() {
        closeHadErrorListener = (this.listeners.get('error')?.size ?? 0) > 0;
        this.readyState = 2;
        queueMicrotask(() => {
          this.emit(
            'error',
            new Error('WebSocket was closed before the connection was established'),
          );
          this.readyState = 3;
          this.emit('close', { code: 1006 });
        });
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const run = runWebSocketResponse(
      {
        url: 'wss://example.test/responses',
        headers: new Headers(),
        body: { model: 'gpt', input: [] },
        settings: normalizeSettings({ websocket: { retries: 0, connectTimeoutMs: 0 } }),
        signal: controller.signal,
        WebSocketCtor: FakeWebSocket as any,
      },
      () => undefined,
    );

    controller.abort();

    await expect(run).rejects.toThrow('Request was aborted');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeHadErrorListener).toBe(true);
  });

  it('removes a cached socket when aborting after connect', async () => {
    const controller = new AbortController();
    const instances: any[] = [];

    class FakeWebSocket {
      readyState = 1;
      closed = false;
      terminated = false;
      sent: string[] = [];
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        instances.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }

      send(data: string) {
        this.sent.push(data);
        if (instances.length === 2) {
          queueMicrotask(() => {
            this.emit('message', {
              data: JSON.stringify({
                type: 'response.completed',
                response: { id: 'resp_after_abort', status: 'completed' },
              }),
            });
          });
        }
      }

      close() {
        this.closed = true;
        this.readyState = 3;
      }

      terminate() {
        this.terminated = true;
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const request = {
      url: 'wss://example.test/responses',
      headers: new Headers(),
      body: { model: 'gpt', input: [] },
      settings: normalizeSettings({ websocket: { retries: 0, idleTimeoutMs: 0 } }),
      cacheKey: 'active-abort-cache-key',
      signal: controller.signal,
      WebSocketCtor: FakeWebSocket as any,
    };

    const run = runWebSocketResponse(request, () => undefined);
    const settled = run.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    await vi.waitFor(() => expect(instances[0]?.sent).toHaveLength(1));

    controller.abort();

    await vi.waitFor(async () => {
      expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('Request was aborted');
    });
    expect(instances[0].closed).toBe(true);
    expect(instances[0].terminated).toBe(true);

    await runWebSocketResponse({ ...request, signal: undefined }, (event) => {
      expect(event.type).toBe('response.completed');
    });
    expect(instances).toHaveLength(2);
    closeAllCachedWebSockets();
  });

  it('retries WebSocket handshake errors before sending a request', async () => {
    let constructed = 0;
    const seen: string[] = [];
    class FakeWebSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        constructed++;
        queueMicrotask(() => {
          if (constructed === 1) this.emit('error', { message: 'handshake failed' });
          else this.emit('open', {});
        });
      }

      send() {
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({ type: 'response.created', response: { id: 'resp_retry' } }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.completed',
              response: { id: 'resp_retry', status: 'completed' },
            }),
          });
        });
      }

      close() {}

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    await runWebSocketResponse(
      {
        url: 'wss://example.test/responses',
        headers: new Headers(),
        body: { model: 'gpt', input: [] },
        settings: normalizeSettings({ websocket: { retries: 1 } }),
        WebSocketCtor: FakeWebSocket as any,
      },
      (event) => {
        seen.push(event.type);
      },
    );

    expect(constructed).toBe(2);
    expect(seen).toEqual(['response.created', 'response.completed']);
  });

  it('retries early WebSocket close before any response event', async () => {
    const { WebSocketCtor, instances } = makeWebSocketCtor([
      (socket) => socket.emit('close', { code: 1006 }),
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }),
        });
        socket.emit('message', {
          data: JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_1', status: 'completed' },
          }),
        });
      },
    ]);
    const seen: string[] = [];
    const diagnostics = createTransportDiagnostics({
      configuredTransport: 'websocket',
      url: 'wss://example.test/responses',
    });

    const result = await runWebSocketResponse(
      {
        url: 'wss://example.test/responses',
        headers: new Headers(),
        body: { model: 'gpt', input: [] },
        settings: normalizeSettings({ websocket: { retries: 1 } }),
        WebSocketCtor,
        diagnostics,
      },
      (event) => {
        seen.push(event.type);
      },
    );

    expect(instances).toHaveLength(2);
    expect(result).toMatchObject({ responseId: 'resp_1', eventCount: 2 });
    expect(seen).toEqual(['response.created', 'response.completed']);
    const message = makeAssistantMessage();
    expect(
      attachTransportDiagnostic(message, diagnostics, {
        finalTransport: 'websocket',
        outcome: 'websocket_retry_succeeded',
      }),
    ).toBe(true);
    const retryDetails = extractTransportDiagnostics(message)[0]?.details;
    expect(retryDetails?.requestBytes).toBe(
      new TextEncoder().encode(instances[1].sent[0]).byteLength,
    );
    expect(retryDetails?.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'ws_close', code: 1006, attempt: 0 }),
        expect.objectContaining({ type: 'ws_retry', attempt: 1 }),
        expect.objectContaining({ type: 'response_created', responseId: 'resp_1' }),
        expect.objectContaining({ type: 'response_completed', responseId: 'resp_1' }),
      ]),
    );
  });

  it('retries WebSocket close after response.created when no output event was seen', async () => {
    const { WebSocketCtor, instances } = makeWebSocketCtor([
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({ type: 'response.created', response: { id: 'resp_created_only' } }),
        });
        socket.emit('close', { code: 1006 });
      },
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({ type: 'response.created', response: { id: 'resp_retry_ok' } }),
        });
        socket.emit('message', {
          data: JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_retry_ok', status: 'completed' },
          }),
        });
      },
    ]);
    const seen: string[] = [];
    const diagnostics = createTransportDiagnostics({
      configuredTransport: 'websocket',
      url: 'wss://example.test/responses',
    });

    const result = await runWebSocketResponse(
      {
        url: 'wss://example.test/responses',
        headers: new Headers(),
        body: { model: 'gpt', input: [] },
        settings: normalizeSettings({ websocket: { retries: 1 } }),
        WebSocketCtor,
        diagnostics,
      },
      (event) => {
        seen.push(event.type);
      },
    );

    expect(instances).toHaveLength(2);
    expect(result).toMatchObject({ responseId: 'resp_retry_ok', eventCount: 2 });
    expect(seen).toEqual(['response.created', 'response.completed']);
    const message = makeAssistantMessage();
    attachTransportDiagnostic(message, diagnostics, {
      finalTransport: 'websocket',
      outcome: 'websocket_retry_succeeded',
    });
    const retryDetails = extractTransportDiagnostics(message)[0]?.details;
    expect(retryDetails).toMatchObject({ replayUnsafeEventSeen: false });
    expect(retryDetails).not.toHaveProperty('firstReplayUnsafeEventType');
    expect(retryDetails?.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'ws_retry',
          attempt: 1,
          reason: 'midstream_error_before_output',
          responseId: 'resp_created_only',
        }),
      ]),
    );
  });

  it('does not retry WebSocket close after output has started', async () => {
    const { WebSocketCtor, instances } = makeWebSocketCtor([
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({ type: 'response.created', response: { id: 'resp_output' } }),
        });
        socket.emit('message', {
          data: JSON.stringify({
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', id: 'msg_1' },
          }),
        });
        socket.emit('close', { code: 1006 });
      },
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_should_not_run' },
          }),
        });
      },
    ]);
    const seen: string[] = [];
    const diagnostics = createTransportDiagnostics({
      configuredTransport: 'websocket',
      url: 'wss://example.test/responses',
    });

    await expect(
      runWebSocketResponse(
        {
          url: 'wss://example.test/responses',
          headers: new Headers(),
          body: { model: 'gpt', input: [] },
          settings: normalizeSettings({ websocket: { retries: 1 } }),
          WebSocketCtor,
          diagnostics,
        },
        (event) => {
          seen.push(event.type);
        },
      ),
    ).rejects.toThrow(WebSocketMidstreamError);

    expect(instances).toHaveLength(1);
    expect(seen).toEqual(['response.created', 'response.output_item.added']);
    expect(diagnostics.getFields()).toMatchObject({
      replayUnsafeEventSeen: true,
      firstReplayUnsafeEventType: 'response.output_item.added',
    });
  });

  it('does not retry a truncated WebSocket frame that partially identifies output', async () => {
    const { WebSocketCtor, instances } = makeWebSocketCtor([
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({ type: 'response.created', response: { id: 'resp_partial' } }),
        });
        socket.emit('message', {
          data: '{"type":"response.output_text.delta","response_id":"resp_partial","delta":"hel',
        });
      },
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_should_not_run' },
          }),
        });
      },
    ]);
    const seen: string[] = [];
    const diagnostics = createTransportDiagnostics({
      configuredTransport: 'websocket',
      url: 'wss://example.test/responses',
    });

    await expect(
      runWebSocketResponse(
        {
          url: 'wss://example.test/responses',
          headers: new Headers(),
          body: { model: 'gpt', input: [] },
          settings: normalizeSettings({ websocket: { retries: 1 } }),
          WebSocketCtor,
          diagnostics,
        },
        (event) => {
          seen.push(event.type);
        },
      ),
    ).rejects.toThrow('Unterminated string');

    expect(instances).toHaveLength(1);
    expect(seen).toEqual([]);
    expect(diagnostics.getFields()).toMatchObject({
      replayUnsafeEventSeen: true,
      firstReplayUnsafeEventType: 'response.output_text.delta',
      websocketResponseId: 'resp_partial',
    });
  });

  it('records close codes when an active socket emits error before close', async () => {
    const { WebSocketCtor } = makeWebSocketCtor([
      (socket) => {
        socket.emit('error', { message: 'network reset' });
        socket.emit('close', { code: 1006 });
      },
    ]);
    const diagnostics = createTransportDiagnostics({
      configuredTransport: 'websocket',
      url: 'wss://example.test/responses',
    });

    await expect(
      runWebSocketResponse(
        {
          url: 'wss://example.test/responses',
          headers: new Headers(),
          body: { model: 'gpt', input: [] },
          settings: normalizeSettings({ websocket: { retries: 0 } }),
          WebSocketCtor,
          diagnostics,
        },
        () => undefined,
      ),
    ).rejects.toThrow('network reset');

    const message = makeAssistantMessage();
    attachTransportDiagnostic(message, diagnostics, {
      finalTransport: 'websocket',
      outcome: 'transport_error',
    });
    expect(extractTransportDiagnostics(message)[0]?.details?.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'ws_error', message: 'network reset' }),
        expect.objectContaining({ type: 'ws_close', code: 1006 }),
      ]),
    );
  });

  it('pings idle cached sockets without extending their idle TTL', async () => {
    vi.useFakeTimers();
    const instances: any[] = [];

    class FakeWebSocket {
      readyState = 1;
      closed = false;
      pings = 0;
      sent: string[] = [];
      listeners = new Map<string, Set<(event: any) => void>>();
      eventListeners = new Map<string, Set<(...args: any[]) => void>>();

      constructor() {
        instances.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }

      send(data: string) {
        this.sent.push(data);
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.created',
              response: { id: `resp_${instances.length}` },
            }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.completed',
              response: { id: `resp_${instances.length}`, status: 'completed' },
            }),
          });
        });
      }

      ping() {
        this.pings++;
        this.emitEvent('pong');
      }

      close() {
        this.closed = true;
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      on(type: string, listener: (...args: any[]) => void) {
        const listeners = this.eventListeners.get(type) ?? new Set();
        listeners.add(listener);
        this.eventListeners.set(type, listeners);
      }

      removeListener(type: string, listener: (...args: any[]) => void) {
        this.eventListeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }

      emitEvent(type: string, ...args: any[]) {
        for (const listener of this.eventListeners.get(type) ?? []) listener(...args);
      }
    }

    const request = {
      url: 'wss://example.test/responses',
      headers: new Headers(),
      body: { model: 'gpt', input: [] },
      settings: normalizeSettings({ websocket: { retries: 0 } }),
      cacheKey: 'idle-ping-cache-key',
      enableIdleKeepalive: true,
      WebSocketCtor: FakeWebSocket as any,
    };

    try {
      await runWebSocketResponse(request, () => undefined);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(instances[0].pings).toBe(1);
      expect(instances[0].closed).toBe(false);

      await vi.advanceTimersByTimeAsync(14 * 60 * 1000 + 29_999);
      expect(instances[0].closed).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(instances[0].closed).toBe(true);

      await runWebSocketResponse(request, () => undefined);
      expect(instances).toHaveLength(2);
    } finally {
      closeAllCachedWebSockets();
      vi.useRealTimers();
    }
  });

  it('does not ping a cached socket while it is busy with an active response', async () => {
    vi.useFakeTimers();
    const instances: any[] = [];
    let completeSecond!: () => void;
    const secondResponse = new Promise<void>((resolve) => {
      completeSecond = resolve;
    });

    class FakeWebSocket {
      readyState = 1;
      pings = 0;
      sent: string[] = [];
      listeners = new Map<string, Set<(event: any) => void>>();
      eventListeners = new Map<string, Set<(...args: any[]) => void>>();

      constructor() {
        instances.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }

      send(data: string) {
        this.sent.push(data);
        if (this.sent.length === 1) {
          queueMicrotask(() => this.complete('resp_first'));
          return;
        }
        void secondResponse.then(() => this.complete('resp_second'));
      }

      complete(id: string) {
        this.emit('message', {
          data: JSON.stringify({ type: 'response.created', response: { id } }),
        });
        this.emit('message', {
          data: JSON.stringify({
            type: 'response.completed',
            response: { id, status: 'completed' },
          }),
        });
      }

      ping() {
        this.pings++;
        this.emitEvent('pong');
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      on(type: string, listener: (...args: any[]) => void) {
        const listeners = this.eventListeners.get(type) ?? new Set();
        listeners.add(listener);
        this.eventListeners.set(type, listeners);
      }

      removeListener(type: string, listener: (...args: any[]) => void) {
        this.eventListeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }

      emitEvent(type: string, ...args: any[]) {
        for (const listener of this.eventListeners.get(type) ?? []) listener(...args);
      }
    }

    const request = {
      url: 'wss://example.test/responses',
      headers: new Headers(),
      body: { model: 'gpt', input: [] },
      settings: normalizeSettings({ websocket: { retries: 0, firstEventTimeoutMs: 0 } }),
      cacheKey: 'busy-no-ping-cache-key',
      enableIdleKeepalive: true,
      WebSocketCtor: FakeWebSocket as any,
    };

    try {
      await runWebSocketResponse(request, () => undefined);
      const second = runWebSocketResponse(request, () => undefined);
      await vi.waitFor(() => expect(instances[0].sent).toHaveLength(2));

      await vi.advanceTimersByTimeAsync(60_000);
      expect(instances[0].pings).toBe(0);

      completeSecond();
      await second;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(instances[0].pings).toBe(1);
    } finally {
      closeAllCachedWebSockets();
      vi.useRealTimers();
    }
  });

  it('installs active listeners before sending on a reused cached socket', async () => {
    const instances: any[] = [];
    const unhandledErrors: string[] = [];
    const listenerCountsAtCachedSend: Array<{ close: number; error: number }> = [];

    class FakeWebSocket {
      readyState = 1;
      sent: string[] = [];
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        instances.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }

      send(data: string) {
        this.sent.push(data);
        if (instances[0] === this && this.sent.length === 1) {
          queueMicrotask(() => {
            this.emit('message', {
              data: JSON.stringify({ type: 'response.created', response: { id: 'resp_cached' } }),
            });
            this.emit('message', {
              data: JSON.stringify({
                type: 'response.completed',
                response: { id: 'resp_cached', status: 'completed' },
              }),
            });
          });
          return;
        }
        if (instances[0] === this && this.sent.length === 2) {
          listenerCountsAtCachedSend.push({
            close: this.listeners.get('close')?.size ?? 0,
            error: this.listeners.get('error')?.size ?? 0,
          });
          this.emit('error', { message: 'WebSocket closed with code 1005' });
          this.emit('close', { code: 1005 });
          return;
        }
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({ type: 'response.created', response: { id: 'resp_retry' } }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.completed',
              response: { id: 'resp_retry', status: 'completed' },
            }),
          });
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        const listeners = this.listeners.get(type) ?? new Set();
        if (type === 'error' && listeners.size === 0) {
          unhandledErrors.push(event?.message ?? String(event));
          return;
        }
        for (const listener of listeners) listener(event);
      }
    }

    const request = {
      url: 'wss://example.test/responses',
      headers: new Headers(),
      body: { model: 'gpt', input: [] },
      settings: normalizeSettings({ websocket: { retries: 1, idleTimeoutMs: 5 } }),
      cacheKey: 'stale-reused-socket-cache-key',
      WebSocketCtor: FakeWebSocket as any,
    };
    const seen: string[] = [];

    try {
      await runWebSocketResponse(request, () => undefined);
      const result = await runWebSocketResponse(request, (event) => {
        seen.push(event.type);
      });

      expect(listenerCountsAtCachedSend).toEqual([{ close: 1, error: 1 }]);
      expect(unhandledErrors).toEqual([]);
      expect(instances).toHaveLength(2);
      expect(result).toMatchObject({ responseId: 'resp_retry', eventCount: 2 });
      expect(seen).toEqual(['response.created', 'response.completed']);
    } finally {
      closeAllCachedWebSockets();
    }
  });

  it('treats close after terminal event as success even when event handling is async', async () => {
    const { WebSocketCtor } = makeWebSocketCtor([
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }),
        });
        socket.emit('message', {
          data: JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_1', status: 'completed' },
          }),
        });
        socket.emit('close', { code: 1000 });
      },
    ]);
    const seen: string[] = [];

    const result = await runWebSocketResponse(
      {
        url: 'wss://example.test/responses',
        headers: new Headers(),
        body: { model: 'gpt', input: [] },
        settings: normalizeSettings({ websocket: { retries: 0 } }),
        WebSocketCtor,
      },
      async (event) => {
        seen.push(event.type);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    );

    expect(result).toMatchObject({ responseId: 'resp_1', eventCount: 2 });
    expect(seen).toEqual(['response.created', 'response.completed']);
  });

  it('processes binary terminal frames before a following close event', async () => {
    const { WebSocketCtor } = makeWebSocketCtor([
      (socket) => {
        socket.emit('message', {
          data: Buffer.from(
            JSON.stringify({ type: 'response.created', response: { id: 'resp_binary' } }),
          ),
        });
        socket.emit('message', {
          data: Buffer.from(
            JSON.stringify({
              type: 'response.completed',
              response: { id: 'resp_binary', status: 'completed' },
            }),
          ),
        });
        socket.emit('close', { code: 1000 });
      },
    ]);
    const seen: string[] = [];

    const result = await runWebSocketResponse(
      {
        url: 'wss://example.test/responses',
        headers: new Headers(),
        body: { model: 'gpt', input: [] },
        settings: normalizeSettings({ websocket: { retries: 0 } }),
        WebSocketCtor,
      },
      (event) => {
        seen.push(event.type);
      },
    );

    expect(result).toMatchObject({ responseId: 'resp_binary', eventCount: 2 });
    expect(seen).toEqual(['response.created', 'response.completed']);
  });

  it('does not keep a cached socket after the server closes following a terminal event', async () => {
    const instances: any[] = [];
    class FakeWebSocket {
      readyState = 1;
      sent: string[] = [];
      closed = false;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        instances.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }

      send(data: string) {
        this.sent.push(data);
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.created',
              response: { id: `resp_${instances.length}` },
            }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.completed',
              response: { id: `resp_${instances.length}`, status: 'completed' },
            }),
          });
          this.emit('close', { code: 1000 });
        });
      }

      close() {
        this.closed = true;
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const request = {
      url: 'wss://example.test/responses',
      headers: new Headers(),
      body: { model: 'gpt', input: [] },
      settings: normalizeSettings({ websocket: { retries: 0 } }),
      cacheKey: 'terminal-close-cache-key',
      WebSocketCtor: FakeWebSocket as any,
    };

    await runWebSocketResponse(request, () => undefined);
    await runWebSocketResponse(request, () => undefined);

    expect(instances).toHaveLength(2);
    closeAllCachedWebSockets();
  });

  it('emits lifecycle events with the local port as the connection id when available', async () => {
    const { WebSocketCtor, instances } = makeWebSocketCtor(
      [
        (socket) => {
          socket.emit('message', {
            data: JSON.stringify({
              type: 'response.created',
              response: { id: 'resp_lifecycle' },
            }),
          });
          socket.emit('message', {
            data: JSON.stringify({
              type: 'response.completed',
              response: { id: 'resp_lifecycle', status: 'completed' },
            }),
          });
        },
      ],
      { localPort: 61243 },
    );
    const lifecycle: WebSocketLifecycleEvent[] = [];

    await runWebSocketResponse(
      {
        url: 'wss://example.test/responses',
        headers: new Headers(),
        body: { model: 'gpt', input: [] },
        settings: normalizeSettings({ websocket: { retries: 0 } }),
        cacheKey: 'lifecycle-cache-key',
        WebSocketCtor,
        onLifecycleEvent: (event) => lifecycle.push(event),
      },
      () => undefined,
    );
    instances[0].emit('close', { code: 1000, reason: 'server_idle' });

    expect(lifecycle).toEqual([
      expect.objectContaining({
        type: 'open',
        connectionId: 'ws#61243',
        cacheStatus: 'miss',
      }),
      expect.objectContaining({
        type: 'close',
        connectionId: 'ws#61243',
        reason: 'idle_close',
        code: 1000,
      }),
    ]);
    closeAllCachedWebSockets();
  });

  it('falls back to a process-local connection id when the local port is unavailable', async () => {
    const { WebSocketCtor } = makeWebSocketCtor([
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({ type: 'response.created', response: { id: 'resp_lifecycle' } }),
        });
        socket.emit('message', {
          data: JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_lifecycle', status: 'completed' },
          }),
        });
      },
    ]);
    const lifecycle: WebSocketLifecycleEvent[] = [];

    await runWebSocketResponse(
      {
        url: 'wss://example.test/responses',
        headers: new Headers(),
        body: { model: 'gpt', input: [] },
        settings: normalizeSettings({ websocket: { retries: 0 } }),
        cacheKey: 'lifecycle-fallback-cache-key',
        WebSocketCtor,
        onLifecycleEvent: (event) => lifecycle.push(event),
      },
      () => undefined,
    );

    expect(lifecycle[0]).toEqual(
      expect.objectContaining({ type: 'open', connectionId: expect.stringMatching(/^ws#\d+$/) }),
    );
    closeAllCachedWebSockets();
  });

  it('builds synthetic response headers with connection metadata', () => {
    expect(
      buildWebSocketResponseHeaders(
        {
          connectionId: 'ws#61245',
          cacheStatus: 'miss',
          cacheKeyHash: 'cache',
          localPort: 61245,
        },
        'wss://example.test/responses?deployment=gpt',
      ),
    ).toEqual({
      connection: 'Upgrade',
      upgrade: 'websocket',
      'x-pi-connection-id': 'ws#61245',
      'x-pi-connection-cache-status': 'miss',
      'x-pi-request-url': 'wss://example.test/responses?deployment=gpt',
    });
  });

  it('records the attempted traceparent when websocket connect fails before open', async () => {
    const logicalTraceId = 'fedcba0987654321fedcba0987654321';
    class FakeWebSocket {
      readyState = 0;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor(
        readonly url: string,
        readonly socketOptions: { headers?: Record<string, string> },
      ) {
        queueMicrotask(() => this.emit('error', { message: 'handshake failed' }));
      }

      send() {
        throw new Error('should not send before open');
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const diagnostics = createTransportDiagnostics({
      configuredTransport: 'websocket',
      requestId: 'owsr_trace_connect_error',
      url: 'wss://example.test/responses',
      logicalTraceId,
    });

    await expect(
      runWebSocketResponse(
        {
          url: 'wss://example.test/responses',
          headers: new Headers({ authorization: 'Bearer token' }),
          body: { model: 'gpt', input: [] },
          settings: normalizeSettings({ websocket: { retries: 0 } }),
          WebSocketCtor: FakeWebSocket as any,
          diagnostics,
          trace: {
            logicalTraceId,
            nextSpan: () => createTraceContextForTraceId(logicalTraceId),
          },
        },
        () => undefined,
      ),
    ).rejects.toThrow('handshake failed');

    const message = makeAssistantMessage();
    attachTransportDiagnostic(message, diagnostics, {
      finalTransport: 'websocket',
      outcome: 'transport_error',
    });
    const timeline = extractTransportDiagnostics(message)[0]?.details?.timeline as any[];
    expect(timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'ws_connect_error',
          traceparent: expect.stringMatching(
            /^00-fedcba0987654321fedcba0987654321-[0-9a-f]{16}-01$/,
          ),
          traceId: logicalTraceId,
        }),
      ]),
    );
  });

  it('sends traceparent on new websocket connections and reports cached connection traces', async () => {
    const logicalTraceId = '1234567890abcdef1234567890abcdef';
    const instances: any[] = [];
    class FakeWebSocket {
      readyState = 1;
      sent: string[] = [];
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor(
        readonly url: string,
        readonly socketOptions: { headers?: Record<string, string> },
      ) {
        instances.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }

      send(data: string) {
        this.sent.push(data);
        const responseId = `resp_${this.sent.length}`;
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({ type: 'response.created', response: { id: responseId } }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.completed',
              response: { id: responseId, status: 'completed' },
            }),
          });
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const diagnostics = createTransportDiagnostics({
      configuredTransport: 'websocket-cached',
      requestId: 'owsr_trace_cache',
      url: 'wss://example.test/responses',
      logicalTraceId,
    });
    const trace = {
      logicalTraceId,
      nextSpan: () => createTraceContextForTraceId(logicalTraceId),
    };
    const request = {
      url: 'wss://example.test/responses',
      headers: new Headers({ authorization: 'Bearer token' }),
      body: { model: 'gpt', input: [] },
      settings: normalizeSettings({ websocket: { retries: 0 } }),
      cacheKey: 'trace-cache-key',
      WebSocketCtor: FakeWebSocket as any,
      diagnostics,
      trace,
    };

    try {
      await runWebSocketResponse(request, () => undefined);
      await runWebSocketResponse(request, () => undefined);

      expect(instances).toHaveLength(1);
      const traceparent = instances[0].socketOptions.headers.traceparent;
      expect(traceparent).toMatch(/^00-1234567890abcdef1234567890abcdef-[0-9a-f]{16}-01$/);
      const message = makeAssistantMessage();
      attachTransportDiagnostic(message, diagnostics, {
        finalTransport: 'websocket',
        outcome: 'completed',
      });
      expect(extractTransportDiagnostics(message)[0]?.details).toMatchObject({
        logicalTraceId,
        connectionTraceparent: traceparent,
        connectionTraceId: logicalTraceId,
        cacheStatus: 'hit',
      });
    } finally {
      closeAllCachedWebSockets();
    }
  });

  it('passes connection metadata to response event handlers', async () => {
    const { WebSocketCtor } = makeWebSocketCtor(
      [
        (socket) => {
          socket.emit('message', {
            data: JSON.stringify({
              type: 'response.created',
              response: { id: 'resp_connection_metadata' },
            }),
          });
          socket.emit('message', {
            data: JSON.stringify({
              type: 'response.completed',
              response: { id: 'resp_connection_metadata', status: 'completed' },
            }),
          });
        },
      ],
      { localPort: 61245 },
    );
    const seen: unknown[] = [];

    await runWebSocketResponse(
      {
        url: 'wss://example.test/responses',
        headers: new Headers(),
        body: { model: 'gpt', input: [] },
        settings: normalizeSettings({ websocket: { retries: 0 } }),
        cacheKey: 'connection-metadata-cache-key',
        WebSocketCtor,
      },
      (_event, connection) => {
        seen.push(connection);
      },
    );

    expect(seen[0]).toEqual(
      expect.objectContaining({ connectionId: 'ws#61245', cacheStatus: 'miss' }),
    );
    closeAllCachedWebSockets();
  });

  it('enables idle WebSocket keepalive only during and shortly after interactive runs', () => {
    let now = 1_000;
    const tracker = createIdleKeepaliveActivityTracker(() => now);

    tracker.setContext({ hasUI: true });
    expect(tracker.shouldEnable()).toBe(false);

    tracker.noteInput({ source: 'rpc' });
    tracker.noteAgentStart();
    expect(tracker.shouldEnable()).toBe(false);
    tracker.noteAgentEnd();
    expect(tracker.shouldEnable()).toBe(false);

    tracker.noteInput({ source: 'interactive' });
    tracker.noteAgentStart();
    expect(tracker.shouldEnable()).toBe(true);

    tracker.noteAgentEnd();
    expect(tracker.shouldEnable()).toBe(true);

    now += IDLE_KEEPALIVE_ACTIVITY_WINDOW_MS - 1;
    expect(tracker.shouldEnable()).toBe(true);

    now += 1;
    expect(tracker.shouldEnable()).toBe(false);
  });

  it('disables idle WebSocket keepalive when the UI context is unavailable or reset', () => {
    const tracker = createIdleKeepaliveActivityTracker(() => 1_000);

    tracker.setContext({ hasUI: false });
    tracker.noteInput({ source: 'interactive' });
    tracker.noteAgentStart();
    expect(tracker.shouldEnable()).toBe(false);

    tracker.setContext({ hasUI: true });
    tracker.noteInput({ source: 'interactive' });
    tracker.noteAgentStart();
    expect(tracker.shouldEnable()).toBe(true);

    tracker.clear();
    expect(tracker.shouldEnable()).toBe(false);
  });

  it('formats status text only for main-session WebSocket opens', () => {
    expect(
      formatWebSocketStatus({
        type: 'open',
        connectionId: 'ws#61243',
        cacheStatus: 'miss',
        cacheKeyHash: '336920397f78',
        urlHash: 'urlhash',
      }),
    ).toBe('Responses WS: ws#61243 connected · new socket');
    expect(
      formatWebSocketStatus({
        type: 'open',
        connectionId: 'ws#61245',
        cacheStatus: 'hit',
        cacheKeyHash: '336920397f78',
        urlHash: 'urlhash',
      }),
    ).toBe('Responses WS: ws#61245 connected · reused idle socket');
    expect(
      formatWebSocketStatus({
        type: 'open',
        connectionId: 'ws#61244',
        cacheStatus: 'busy',
        cacheKeyHash: '336920397f78',
        urlHash: 'urlhash',
      }),
    ).toBe('Responses WS: ws#61244 connected · extra socket while previous is busy');
    expect(
      formatWebSocketStatus({
        type: 'open',
        connectionId: 'ws#1',
        cacheStatus: 'disabled',
        urlHash: 'urlhash',
      }),
    ).toBeUndefined();
    expect(
      formatWebSocketStatus({
        type: 'close',
        connectionId: 'ws#61243',
        reason: 'idle_timeout',
        cacheKeyHash: '336920397f78',
      }),
    ).toBeUndefined();
  });

  it('formats recovery success text for the status bar', () => {
    expect(
      formatWebSocketStatus({
        type: 'recovered',
        mode: 'resumed',
        connectionId: 'ws#1293',
        responseId: 'resp_ok',
        urlHash: 'urlhash',
      }),
    ).toBe('✓ WS recovered · resumed');
    expect(
      formatWebSocketStatus({
        type: 'recovered',
        mode: 'full_replay',
        connectionId: 'ws#1294',
        responseId: 'resp_ok',
        urlHash: 'urlhash',
      }),
    ).toBe('✓ WS recovered · replayed');
  });

  it('formats websocket retry/fallback/recovery as temporary status text', () => {
    expect(
      formatWebSocketStatus({
        type: 'retry',
        reason: 'empty_response_failed_without_details',
        action: 'retry_fresh_websocket_same_previous_response_id',
        attempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        urlHash: 'abc123',
        connectionId: 'ws#1292',
        responseId: 'resp_0091b44445adddfa006a21cb87efc48194a1b3e5756122ca56',
        previousResponseId: 'resp_0091b44445adddfa006a21cb733a2081948de63f4cd8a9579b',
      }),
    ).toBe('↻ WS resuming request · empty response');
    expect(
      formatWebSocketStatus({
        type: 'retry',
        reason: 'midstream_error_before_output',
        action: 'retry_fresh_websocket_before_output',
        attempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        urlHash: 'abc123',
        connectionId: 'ws#1292',
        responseId: 'resp_0091b44445adddfa006a21cb87efc48194a1b3e5756122ca56',
      }),
    ).toBe('↻ WS retrying request · closed before output');
    expect(
      formatWebSocketStatus({
        type: 'fallback',
        reason: 'empty_response_failed_without_details',
        action: 'replay_full_conversation_without_previous_response_id',
        attempt: 2,
        nextAttempt: 3,
        maxAttempts: 3,
        urlHash: 'abc123',
        connectionId: 'ws#1293',
        responseId: 'resp_0091b44445adddfa006a21cb8aac448194b4aee1903076f4c2',
        previousResponseId: 'resp_0091b44445adddfa006a21cb733a2081948de63f4cd8a9579b',
      }),
    ).toBe('↻ WS replaying conversation · empty response · 2/2');
    expect(
      formatWebSocketStatus({
        type: 'fallback',
        reason: 'previous_response_not_found',
        action: 'replay_full_conversation_without_previous_response_id',
        attempt: 1,
        nextAttempt: 2,
        maxAttempts: 2,
        urlHash: 'abc123',
        connectionId: 'ws#1293',
        previousResponseId: 'resp_0091b44445adddfa006a21cb733a2081948de63f4cd8a9579b',
      }),
    ).toBe('↻ WS replaying conversation · previous response missing');
    expect(
      formatWebSocketStatus({
        type: 'recovering',
        reason: 'midstream_error',
        action: 'retrieve_response_snapshot',
        urlHash: 'abc123',
        responseId: 'resp_0091b44445adddfa006a21cb8aac448194b4aee1903076f4c2',
        message: 'websocket: close 1006 (abnormal closure): unexpected EOF',
      }),
    ).toBe('↻ WS retrieving snapshot · stream interrupted');
    expect(
      formatWebSocketStatus({
        type: 'failed',
        reason: 'recovery_failed',
        urlHash: 'abc123',
        responseId: 'resp_0091b44445adddfa006a21cb8aac448194b4aee1903076f4c2',
        message: 'Retrieve recovery failed: response not found',
      }),
    ).toBe('⚠ WS unavailable');
    expect(
      formatWebSocketStatus({
        type: 'transport_fallback',
        reason: 'websocket_failed_before_stream_start',
        from: 'websocket',
        to: 'sse',
        message: 'Unexpected server response: 500 (providerServerError)',
      }),
    ).toBe('↻ Continuing via SSE fallback · WS unavailable');
    expect(
      formatWebSocketStatus({
        type: 'transport_fallback_completed',
        from: 'websocket',
        to: 'sse',
      }),
    ).toBe('✓ Continued via SSE fallback');
    expect(
      formatWebSocketStatus({
        type: 'transport_fallback_failed',
        from: 'websocket',
        to: 'sse',
        message: 'SSE failed',
      }),
    ).toBe('⚠ SSE fallback failed');
  });

  it('keeps unrecovered websocket failures out of error notifications', () => {
    expect(
      formatWebSocketFailureNotification({
        type: 'failed',
        reason: 'recovery_failed',
        urlHash: 'abc123',
        responseId: 'resp_0091b44445adddfa006a21cb8aac448194b4aee1903076f4c2',
        message: 'Retrieve recovery failed: response not found',
      }),
    ).toBeUndefined();
  });

  it('removes an idle cached socket when the server closes it', async () => {
    const instances: any[] = [];
    class FakeWebSocket {
      readyState = 1;
      sent: string[] = [];
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        instances.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }

      send(data: string) {
        this.sent.push(data);
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.created',
              response: { id: `resp_${instances.length}` },
            }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.completed',
              response: { id: `resp_${instances.length}`, status: 'completed' },
            }),
          });
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const request = {
      url: 'wss://example.test/responses',
      headers: new Headers(),
      body: { model: 'gpt', input: [] },
      settings: normalizeSettings({ websocket: { retries: 0 } }),
      cacheKey: 'idle-close-cache-key',
      WebSocketCtor: FakeWebSocket as any,
    };

    await runWebSocketResponse(request, () => undefined);
    instances[0].emit('close', { code: 1000, reason: 'server_idle' });
    await runWebSocketResponse(request, () => undefined);

    expect(instances).toHaveLength(2);
    closeAllCachedWebSockets();
  });

  it('does not cache one-shot sockets opened while a same-key socket is busy', async () => {
    const instances: any[] = [];
    let firstSent!: () => void;
    const firstSentPromise = new Promise<void>((resolve) => {
      firstSent = resolve;
    });
    let completeFirst!: () => void;
    const firstRelease = new Promise<void>((resolve) => {
      completeFirst = resolve;
    });

    class FakeWebSocket {
      readyState = 1;
      sent: string[] = [];
      closed = false;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        instances.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }

      send(data: string) {
        this.sent.push(data);
        if (instances[0] === this) {
          firstSent();
          void firstRelease.then(() => {
            this.emit('message', {
              data: JSON.stringify({ type: 'response.created', response: { id: 'resp_first' } }),
            });
            this.emit('message', {
              data: JSON.stringify({
                type: 'response.completed',
                response: { id: 'resp_first', status: 'completed' },
              }),
            });
          });
          return;
        }
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({ type: 'response.created', response: { id: 'resp_second' } }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.completed',
              response: { id: 'resp_second', status: 'completed' },
            }),
          });
        });
      }

      close() {
        this.closed = true;
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const request = {
      url: 'wss://example.test/responses',
      headers: new Headers(),
      body: { model: 'gpt', input: [] },
      settings: normalizeSettings({ websocket: { retries: 0 } }),
      cacheKey: 'concurrent-cache-key',
      WebSocketCtor: FakeWebSocket as any,
    };

    const first = runWebSocketResponse(request, () => undefined);
    await firstSentPromise;
    await runWebSocketResponse(request, () => undefined);

    expect(instances).toHaveLength(2);
    expect(instances[1].closed).toBe(true);

    completeFirst();
    await first;
    closeAllCachedWebSockets();
  });

  it('does not retry after response output has started', async () => {
    const { WebSocketCtor, instances } = makeWebSocketCtor([
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({ type: 'response.created', response: { id: 'resp_mid' } }),
        });
        socket.emit('message', {
          data: JSON.stringify({
            type: 'response.output_item.added',
            item: { type: 'message', id: 'msg_mid' },
          }),
        });
        socket.emit('close', { code: 1006 });
      },
    ]);

    await expect(
      runWebSocketResponse(
        {
          url: 'wss://example.test/responses',
          headers: new Headers(),
          body: { model: 'gpt', input: [] },
          settings: normalizeSettings({ websocket: { retries: 3 } }),
          WebSocketCtor,
        },
        () => undefined,
      ),
    ).rejects.toMatchObject({ responseId: 'resp_mid' } satisfies Partial<WebSocketMidstreamError>);
    expect(instances).toHaveLength(1);
  });

  it('falls back to a full body when previous_response_id is no longer cached', async () => {
    const { WebSocketCtor, instances } = makeWebSocketCtor([
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              code: 'previous_response_not_found',
              message: "Previous response with id 'resp_old' not found.",
              param: 'previous_response_id',
            },
            status: 400,
          }),
        });
      },
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({ type: 'response.created', response: { id: 'resp_new' } }),
        });
        socket.emit('message', {
          data: JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_new', status: 'completed' },
          }),
        });
      },
    ]);
    const seen: string[] = [];
    const fullBody = {
      model: 'gpt',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'full' }] }],
    };

    const result = await runWebSocketResponse(
      {
        url: 'wss://example.test/responses',
        headers: new Headers(),
        body: {
          ...fullBody,
          previous_response_id: 'resp_old',
          input: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
          ],
        },
        fallbackBodyOnPreviousResponseNotFound: fullBody,
        settings: normalizeSettings({ websocket: { retries: 0, idleTimeoutMs: 25 } }),
        WebSocketCtor,
      },
      (event) => {
        seen.push(event.type);
      },
    );

    expect(result).toMatchObject({ responseId: 'resp_new', eventCount: 2, fallbackUsed: true });
    expect(instances).toHaveLength(2);
    expect(JSON.parse(instances[0].sent[0])).toMatchObject({
      previous_response_id: 'resp_old',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] }],
    });
    expect(JSON.parse(instances[1].sent[0])).toMatchObject(fullBody);
    expect(JSON.parse(instances[1].sent[0])).not.toHaveProperty('previous_response_id');
    expect(seen).toEqual(['response.created', 'response.completed']);
  });

  it('falls back to a full body for an xAI message-only previous-response miss', async () => {
    const previousResponseId = '25a6b917-9417-9fa4-a21a-1e097d64a96b-xai-13';
    const { WebSocketCtor, instances } = makeWebSocketCtor([
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({
            type: 'error',
            status: 500,
            error: {
              type: 'api_error',
              message: `gRPC error: Response with id=${previousResponseId} not found`,
            },
          }),
        });
      },
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({ type: 'response.created', response: { id: 'resp_xai_replay' } }),
        });
        socket.emit('message', {
          data: JSON.stringify({
            type: 'response.completed',
            response: { id: 'resp_xai_replay', status: 'completed' },
          }),
        });
      },
    ]);
    const fullBody = {
      model: 'gpt',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'full' }] }],
    };
    const seen: string[] = [];

    const result = await runWebSocketResponse(
      {
        url: 'wss://example.test/responses',
        headers: new Headers(),
        body: {
          ...fullBody,
          previous_response_id: previousResponseId,
          input: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
          ],
        },
        fallbackBodyOnPreviousResponseNotFound: fullBody,
        settings: normalizeSettings({ websocket: { retries: 0 } }),
        WebSocketCtor,
      },
      (event) => {
        seen.push(event.type);
      },
    );

    expect(result).toMatchObject({
      responseId: 'resp_xai_replay',
      fallbackUsed: true,
      fallbackReason: 'previous_response_not_found',
    });
    expect(instances).toHaveLength(2);
    expect(JSON.parse(instances[0].sent[0])).toHaveProperty(
      'previous_response_id',
      previousResponseId,
    );
    expect(JSON.parse(instances[1].sent[0])).not.toHaveProperty('previous_response_id');
    expect(seen).toEqual(['response.created', 'response.completed']);
  });

  it('falls back to a full body when empty response.failed repeats after retry', async () => {
    const { WebSocketCtor, instances } = makeWebSocketCtor([
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({ type: 'response.created', response: { id: 'resp_failed_1' } }),
        });
        socket.emit('message', {
          data: JSON.stringify({
            type: 'response.failed',
            response: {
              id: 'resp_failed_1',
              status: 'failed',
              previous_response_id: 'resp_old',
              error: null,
              incomplete_details: null,
              output: [],
            },
          }),
        });
      },
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({ type: 'response.created', response: { id: 'resp_failed_2' } }),
        });
        socket.emit('message', {
          data: JSON.stringify({
            type: 'response.failed',
            response: {
              id: 'resp_failed_2',
              status: 'failed',
              previous_response_id: 'resp_old',
              error: null,
              incomplete_details: null,
              output: [],
            },
          }),
        });
      },
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({ type: 'response.created', response: { id: 'resp_full' } }),
        });
        socket.emit('message', {
          data: JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_full',
              status: 'completed',
              output: [
                {
                  type: 'message',
                  id: 'msg_full',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'Recovered from full replay.' }],
                },
              ],
            },
          }),
        });
      },
    ]);
    const lifecycle: WebSocketLifecycleEvent[] = [];
    const model = makeModel();
    const output = makeAssistantMessage(model);
    const stream = createAssistantMessageEventStream();
    const processor = createResponsesEventProcessor(output, stream, model);
    const url = 'wss://example.test/responses';
    const headers = new Headers({ authorization: 'Bearer direct-secret' });
    const diagnostics = createTransportDiagnostics({
      url,
      ...headersDiagnosticFields(headers),
    });
    const fullBody = {
      model: 'gpt',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'full' }] }],
    };

    const result = await runWebSocketResponse(
      {
        url,
        headers,
        body: {
          ...fullBody,
          previous_response_id: 'resp_old',
          input: [
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
          ],
        },
        fallbackBodyOnPreviousResponseNotFound: fullBody,
        settings: normalizeSettings({ websocket: { retries: 1, idleTimeoutMs: 25 } }),
        WebSocketCtor,
        onLifecycleEvent: (event) => lifecycle.push(event),
        diagnostics,
      },
      (event) => processor.apply(event),
    );

    expect(result).toMatchObject({
      responseId: 'resp_full',
      eventCount: 2,
      fallbackUsed: true,
      fallbackReason: 'empty_response_failed_without_details',
    });
    expect(instances).toHaveLength(3);
    expect(JSON.parse(instances[0].sent[0])).toMatchObject({
      previous_response_id: 'resp_old',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] }],
    });
    expect(JSON.parse(instances[1].sent[0])).toMatchObject({
      previous_response_id: 'resp_old',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] }],
    });
    expect(JSON.parse(instances[2].sent[0])).toMatchObject(fullBody);
    expect(JSON.parse(instances[2].sent[0])).not.toHaveProperty('previous_response_id');
    expect(lifecycle).toContainEqual(
      expect.objectContaining({
        type: 'fallback',
        reason: 'empty_response_failed_without_details',
        action: 'replay_full_conversation_without_previous_response_id',
        responseId: 'resp_failed_2',
        previousResponseId: 'resp_old',
      }),
    );
    expect(lifecycle).toContainEqual(
      expect.objectContaining({
        type: 'recovered',
        mode: 'full_replay',
        responseId: 'resp_full',
      }),
    );
    const diagnostic = diagnostics.toDiagnostic({
      outcome: 'empty_response_failed_full_fallback_succeeded',
      finalTransport: 'websocket',
    });
    expect(diagnostic?.details).toMatchObject({
      headersHash: shortHash(headersFingerprint(headers)),
      authHeaders: ['authorization'],
      authHeadersHash: expect.any(String),
      recoveryPath: 'delta_retry_full_replay',
      recoveryAttemptCount: 3,
      finalAttemptMode: 'full_replay',
    });
    expect(JSON.stringify(diagnostic?.details)).not.toContain('direct-secret');
    expect(diagnostic?.details?.timeline).toContainEqual(
      expect.objectContaining({ type: 'ws_attempt_start', mode: 'delta' }),
    );
    expect(diagnostic?.details?.timeline).toContainEqual(
      expect.objectContaining({ type: 'ws_attempt_start', mode: 'retry_delta' }),
    );
    expect(diagnostic?.details?.timeline).toContainEqual(
      expect.objectContaining({ type: 'ws_attempt_start', mode: 'full_replay' }),
    );
  });
});

async function collectStreamEvents(stream: AsyncIterable<any>): Promise<any[]> {
  const items: any[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

function streamFromEvents(...events: any[]) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const event of events) stream.push(event);
  });
  return stream;
}

function responseCreateBytes(body: Record<string, any>): number {
  return new TextEncoder().encode(JSON.stringify({ type: 'response.create', ...body })).byteLength;
}

describe('provider transport diagnostics', () => {
  it('summarizes replayed provider item ids without exposing them', () => {
    const summary = summarizeResponsesInputItemIds({
      input: [
        { type: 'reasoning', id: 'rs_private-xai-13' },
        { type: 'message', id: 'msg_private-xai-13' },
        { type: 'message', role: 'user' },
      ],
    });

    expect(summary).toEqual({ count: 2, hash: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(JSON.stringify(summary)).not.toContain('private');
    expect(summarizeResponsesInputItemIds({ input: [{ role: 'user' }] })).toEqual({
      count: 0,
      hash: undefined,
    });
  });

  it('adds compact continuation diagnostics for full-context websocket requests', async () => {
    class FakeWebSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        queueMicrotask(() => this.emit('open', {}));
      }

      send() {
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({ type: 'response.created', response: { id: 'resp_full' } }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp_full',
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    id: 'msg_full_diagnostic',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Full-context response.' }],
                  },
                ],
              },
            }),
          });
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    vi.doMock('ws', () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));
    try {
      const settings = normalizeSettings({ websocket: { retries: 0 } });
      const streamFactory = createOpenAIWebSocketResponsesStream(() => settings);
      const model = makeModel();
      const context = { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] } as any;
      const options = { apiKey: 'test-token', sessionId: 'session-full' } as any;
      const profile = resolveRequestProfile(model, settings);
      const websocketHeaders = buildWebSocketHeaders(model, options, profile);

      const events = await collectStreamEvents(streamFactory(model, context, options));
      const done = events.find((event) => event.type === 'done');
      const [diagnostic] = extractTransportDiagnostics(done?.message ?? {});

      expect(diagnostic?.details).toMatchObject({
        continuation: 'no_continuation',
        sentInputItems: 1,
        sentInputItemIds: 0,
        headersHash: shortHash(headersFingerprint(websocketHeaders)),
        authHeaders: ['authorization'],
        authHeadersHash: expect.any(String),
      });
      expect(JSON.stringify(diagnostic?.details)).not.toContain('test-token');
      expect(diagnostic?.details).not.toHaveProperty('fullInputItems');
      expect(diagnostic?.details).not.toHaveProperty('fullBytes');
    } finally {
      vi.doUnmock('ws');
      closeAllCachedWebSockets();
      clearAllContinuations();
    }
  });

  it('adds compact continuation diagnostics and full-byte estimate for delta requests', async () => {
    const sentPayloads: any[] = [];
    class FakeWebSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        queueMicrotask(() => this.emit('open', {}));
      }

      send(payload: string) {
        sentPayloads.push(JSON.parse(payload));
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({ type: 'response.created', response: { id: 'resp_delta' } }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp_delta',
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    id: 'msg_delta_diagnostic',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Delta response.' }],
                  },
                ],
              },
            }),
          });
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    vi.doMock('ws', () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));
    try {
      clearAllContinuations();
      const settings = normalizeSettings({ websocket: { retries: 0 } });
      const streamFactory = createOpenAIWebSocketResponsesStream(() => settings);
      const model = makeModel();
      const options = { apiKey: 'test-token', sessionId: 'session-delta' } as any;
      const profile = resolveRequestProfile(model, settings);
      const websocketHeaders = buildWebSocketHeaders(model, options, profile);
      const cacheKey = buildSocketCacheKey({
        sessionId: options.sessionId,
        url: resolveWebSocketResponsesUrl(model, settings, websocketHeaders, profile),
        provider: model.provider,
        modelId: model.id,
        headersFingerprint: headersFingerprint(websocketHeaders),
      });
      const firstContext = { messages: [{ role: 'user', content: 'first', timestamp: 1 }] } as any;
      const fullContext = {
        messages: [
          { role: 'user', content: 'first', timestamp: 1 },
          { role: 'user', content: 'next', timestamp: 2 },
        ],
      } as any;
      const previousBody = buildResponsesBody(model, firstContext, options, profile);
      const fullBody = buildResponsesBody(model, fullContext, options, profile);
      setContinuation(cacheKey, {
        lastRequestBody: previousBody,
        lastResponseId: 'resp_previous',
        lastResponseItems: [],
      });

      const events = await collectStreamEvents(streamFactory(model, fullContext, options));
      const done = events.find((event) => event.type === 'done');
      const [diagnostic] = extractTransportDiagnostics(done?.message ?? {});

      expect(sentPayloads[0]).toMatchObject({
        previous_response_id: 'resp_previous',
        input: [expect.objectContaining({ role: 'user' })],
      });
      expect(diagnostic?.details).toMatchObject({
        continuation: 'delta',
        fullInputItems: 2,
        sentInputItems: 1,
        fullInputItemIds: 0,
        sentInputItemIds: 0,
        fullBytes: responseCreateBytes(fullBody),
      });
      expect(Number(diagnostic?.details?.requestBytes)).toBeLessThan(
        Number(diagnostic?.details?.fullBytes),
      );
    } finally {
      vi.doUnmock('ws');
      closeAllCachedWebSockets();
      clearAllContinuations();
    }
  });

  it('preserves and classifies a first nested 408 error without emitting start', async () => {
    class FakeWebSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        queueMicrotask(() => this.emit('open', {}));
      }

      send() {
        queueMicrotask(() =>
          this.emit('message', {
            data: JSON.stringify({
              type: 'error',
              status: 408,
              error: {
                type: 'invalid_request_error',
                message: 'stream closed before response.completed',
              },
            }),
          }),
        );
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    vi.doMock('ws', () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));
    try {
      const settings = normalizeSettings({ websocket: { retries: 0 } });
      const streamFactory = createOpenAIWebSocketResponsesStream(() => settings);
      const events = await collectStreamEvents(
        streamFactory(makeModel(), { messages: [] }, {
          apiKey: 'test-token',
          transport: 'websocket',
        } as any),
      );
      const error = events.find((event) => event.type === 'error')?.error as AssistantMessage;
      const [diagnostic] = extractTransportDiagnostics(error);

      expect(events.map((event) => event.type)).toEqual(['error']);
      expect(error.errorMessage).toBe('stream closed before response.completed');
      expect(diagnostic?.details).toMatchObject({
        finalTransport: 'websocket',
        outcome: 'transport_error',
        failureReason: 'providerServerError',
        failureCategory: 'transient_retryable',
        retryable: true,
        responseErrorStatus: 408,
        responseErrorType: 'invalid_request_error',
        responseErrorMessage: 'stream closed before response.completed',
        replayUnsafeEventSeen: false,
        responseIdSeen: false,
      });
    } finally {
      vi.doUnmock('ws');
      closeAllCachedWebSockets();
    }
  });

  it('clears cached continuation after an upstream invalid_encrypted_content error frame', async () => {
    const sentPayloads: any[] = [];
    class FakeWebSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        queueMicrotask(() => this.emit('open', {}));
      }

      send(payload: string) {
        sentPayloads.push(JSON.parse(payload));
        queueMicrotask(() =>
          this.emit('message', {
            data: JSON.stringify({
              type: 'error',
              status: 400,
              error: {
                type: 'invalid_request_error',
                code: 'invalid_encrypted_content',
                message:
                  'The encrypted content for item rs_123 could not be verified. Reason: Encrypted content could not be decrypted or parsed.',
              },
            }),
          }),
        );
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    vi.doMock('ws', () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));
    try {
      clearAllContinuations();
      const settings = normalizeSettings({ websocket: { retries: 0 } });
      const streamFactory = createOpenAIWebSocketResponsesStream(() => settings);
      const model = makeModel();
      const context = { messages: [{ role: 'user', content: 'hello' }] } as any;
      const options = {
        apiKey: 'test-token',
        sessionId: 'session-invalid-encrypted-content',
        transport: 'websocket',
      } as any;
      const profile = resolveRequestProfile(model, settings);
      const websocketHeaders = buildWebSocketHeaders(model, options, profile);
      const cacheKey = buildSocketCacheKey({
        sessionId: options.sessionId,
        url: resolveWebSocketResponsesUrl(model, settings, websocketHeaders, profile),
        provider: model.provider,
        modelId: model.id,
        headersFingerprint: headersFingerprint(websocketHeaders),
      });
      const fullBody = buildResponsesBody(model, context, options, profile);
      setContinuation(cacheKey, {
        lastRequestBody: fullBody,
        lastResponseId: 'resp_previous',
        lastResponseItems: [],
      });

      const stream = streamFactory(model, context, options);
      const events = await collectStreamEvents(stream);
      const error = events.find((event) => event.type === 'error')?.error as AssistantMessage;

      expect(sentPayloads[0]).toMatchObject({ previous_response_id: 'resp_previous' });
      expect(error.errorMessage).toContain(
        'encrypted content for item rs_123 could not be verified',
      );
      expect(extractTransportDiagnostics(error)[0]?.details).toMatchObject({
        responseErrorStatus: 400,
        responseErrorType: 'invalid_request_error',
        responseErrorCode: 'invalid_encrypted_content',
      });
      expect(getContinuation(cacheKey)).toBeUndefined();
    } finally {
      clearAllContinuations();
      vi.doUnmock('ws');
    }
  });

  it('persists diagnostics when an assistant error message cannot be emitted', async () => {
    class FakeWebSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        queueMicrotask(() => this.emit('open', {}));
      }

      send() {
        queueMicrotask(() => this.emit('close', { code: 1006 }));
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    vi.doMock('ws', () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));
    try {
      const persisted: unknown[] = [];
      const streamFactory = createOpenAIWebSocketResponsesStream(
        () => normalizeSettings({ websocket: { retries: 0 } }),
        undefined,
        undefined,
        (diagnostic) => persisted.push(diagnostic),
      );
      const stream = streamFactory(makeModel(), { messages: [] }, {
        apiKey: 'test-token',
        transport: 'websocket',
      } as any);
      (stream as any).push = () => {
        throw new Error('push failed');
      };

      await vi.waitFor(() => expect(persisted).toHaveLength(1));
      expect(persisted[0]).toMatchObject({
        type: 'openai_websocket_transport',
        details: { outcome: 'transport_error', finalTransport: 'websocket' },
      });
    } finally {
      vi.doUnmock('ws');
    }
  });

  it('adds trace context to provider websocket handshakes and compact success diagnostics', async () => {
    const instances: any[] = [];
    class FakeWebSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor(
        readonly url: string,
        readonly socketOptions: { headers?: Record<string, string> },
      ) {
        instances.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }

      send() {
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({ type: 'response.created', response: { id: 'resp_trace' } }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp_trace',
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    id: 'msg_trace',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Traced response.' }],
                  },
                ],
              },
            }),
          });
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    vi.doMock('ws', () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));
    try {
      const streamFactory = createOpenAIWebSocketResponsesStream(() =>
        normalizeSettings({
          websocket: { retries: 0 },
          diagnostics: { successTimelineSampleRate: 0 },
        }),
      );
      const events = await collectStreamEvents(
        streamFactory(makeModel(), { messages: [] }, {
          apiKey: 'test-token',
          sessionId: 'provider-trace-session',
          transport: 'websocket-cached',
        } as any),
      );
      const done = events.find((event) => event.type === 'done')?.message as AssistantMessage;
      const traceparent = instances[0].socketOptions.headers.traceparent;
      const parsed = parseTraceparent(traceparent);

      expect(parsed).toBeDefined();
      expect(extractTransportDiagnostics(done)[0]?.details).toMatchObject({
        logicalTraceId: parsed?.traceId,
        connectionTraceparent: traceparent,
        connectionTraceId: parsed?.traceId,
        finalResponseId: 'resp_trace',
        finalTransport: 'websocket',
        outcome: 'completed',
      });
      expect(extractTransportDiagnostics(done)[0]?.details?.timeline).toBeUndefined();
    } finally {
      vi.doUnmock('ws');
      closeAllCachedWebSockets();
    }
  });

  it('sends a same-trace new-span traceparent on retrieve recovery GETs', async () => {
    const instances: any[] = [];
    class FakeWebSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor(
        readonly url: string,
        readonly socketOptions: { headers?: Record<string, string> },
      ) {
        instances.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }

      send() {
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({ type: 'response.created', response: { id: 'resp_recover' } }),
          });
          this.emit('close', { code: 1006 });
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'resp_recover', status: 'completed', output: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.doMock('ws', () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const streamFactory = createOpenAIWebSocketResponsesStream(() =>
        normalizeSettings({ websocket: { retries: 0, idleTimeoutMs: 0 } }),
      );
      await collectStreamEvents(
        streamFactory(makeModel(), { messages: [] }, {
          apiKey: 'test-token',
          sessionId: 'provider-recovery-trace-session',
          transport: 'websocket-cached',
        } as any),
      );

      const websocketTrace = parseTraceparent(instances[0].socketOptions.headers.traceparent)!;
      const retrieveOptions = (fetchImpl as any).mock.calls[0]?.[1] as { headers: Headers };
      const retrieveTrace = parseTraceparent(
        retrieveOptions.headers.get('traceparent') ?? undefined,
      )!;
      expect(retrieveTrace.traceId).toBe(websocketTrace.traceId);
      expect(retrieveTrace.spanId).not.toBe(websocketTrace.spanId);
    } finally {
      vi.unstubAllGlobals();
      vi.doUnmock('ws');
      closeAllCachedWebSockets();
    }
  });

  it('recovers transient server error frames by retrieving the response snapshot', async () => {
    class FakeWebSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        queueMicrotask(() => this.emit('open', {}));
      }

      send() {
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({ type: 'response.created', response: { id: 'resp_eof' } }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.output_item.added',
              output_index: 0,
              item: { type: 'message', id: 'msg_eof' },
            }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.content_part.added',
              output_index: 0,
              content_index: 0,
              part: { type: 'output_text', text: '' },
            }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.output_text.delta',
              output_index: 0,
              content_index: 0,
              delta: 'Hello',
            }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'error',
              status: 500,
              error: {
                message: 'websocket: close 1006 (abnormal closure): unexpected EOF',
                type: 'server_error',
                code: 'internal_server_error',
              },
            }),
          });
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'resp_eof',
            status: 'completed',
            output: [
              {
                type: 'message',
                id: 'msg_eof',
                content: [{ type: 'output_text', text: 'Hello world' }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const lifecycle: WebSocketLifecycleEvent[] = [];

    vi.doMock('ws', () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const streamFactory = createOpenAIWebSocketResponsesStream(
        () => normalizeSettings({ websocket: { retries: 0, idleTimeoutMs: 0 } }),
        (event) => lifecycle.push(event),
      );
      const events = await collectStreamEvents(
        streamFactory(makeModel(), { messages: [] }, {
          apiKey: 'test-token',
          sessionId: 'provider-transient-error-recovery-session',
          transport: 'websocket-cached',
        } as any),
      );

      expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'stop' });
      expect((events.at(-1) as any).message.content).toContainEqual(
        expect.objectContaining({ type: 'text', text: 'Hello world' }),
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(lifecycle).toContainEqual(
        expect.objectContaining({
          type: 'recovering',
          reason: 'midstream_error',
          action: 'retrieve_response_snapshot',
          responseId: 'resp_eof',
        }),
      );
      expect(lifecycle).toContainEqual(
        expect.objectContaining({ type: 'recovered', mode: 'resumed', responseId: 'resp_eof' }),
      );
    } finally {
      vi.unstubAllGlobals();
      vi.doUnmock('ws');
      closeAllCachedWebSockets();
    }
  });

  it('labels stale-cache success as transport events rather than retry success', async () => {
    const instances: any[] = [];
    class FakeWebSocket {
      readyState = 1;
      sent: string[] = [];
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        instances.push(this);
        queueMicrotask(() => this.emit('open', {}));
      }

      send() {
        const id = `resp_stale_${instances.length}`;
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({ type: 'response.created', response: { id } }),
          });
          this.emit('message', {
            data: JSON.stringify({
              type: 'response.completed',
              response: {
                id,
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    id: `msg_${id}`,
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Cached response.' }],
                  },
                ],
              },
            }),
          });
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    vi.doMock('ws', () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));
    try {
      const streamFactory = createOpenAIWebSocketResponsesStream(() =>
        normalizeSettings({ websocket: { retries: 0 } }),
      );
      await collectStreamEvents(
        streamFactory(makeModel(), { messages: [] }, {
          apiKey: 'test-token',
          sessionId: 'stale-cache-session',
          transport: 'websocket-cached',
        } as any),
      );
      instances[0].readyState = 3;

      const events = await collectStreamEvents(
        streamFactory(makeModel(), { messages: [] }, {
          apiKey: 'test-token',
          sessionId: 'stale-cache-session',
          transport: 'websocket-cached',
        } as any),
      );
      const done = events.find((event) => event.type === 'done')?.message as AssistantMessage;

      expect(extractTransportDiagnostics(done)[0]?.details).toMatchObject({
        finalTransport: 'websocket',
        outcome: 'websocket_succeeded_with_transport_events',
      });
      expect(extractTransportDiagnostics(done)[0]?.details?.timeline).toContainEqual(
        expect.objectContaining({ type: 'ws_cache_stale' }),
      );
    } finally {
      closeAllCachedWebSockets();
      vi.doUnmock('ws');
    }
  });

  it('attaches transport diagnostics to strict websocket errors', async () => {
    class FakeWebSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        queueMicrotask(() => this.emit('open', {}));
      }

      send() {
        queueMicrotask(() => this.emit('close', { code: 1006 }));
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    vi.doMock('ws', () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));
    try {
      const streamFactory = createOpenAIWebSocketResponsesStream(() =>
        normalizeSettings({ websocket: { retries: 0 } }),
      );
      const stream = streamFactory(makeModel(), { messages: [] }, {
        apiKey: 'test-token',
        transport: 'websocket',
      } as any);

      const events = await collectStreamEvents(stream);
      const error = events.find((event) => event.type === 'error')?.error as AssistantMessage;

      expect(error.errorMessage).toBe(
        'Connection error: WebSocket closed before response.completed code=1006',
      );
      expect(extractTransportDiagnostics(error)[0]?.details).toMatchObject({
        configuredTransport: 'websocket',
        finalTransport: 'websocket',
        outcome: 'transport_error',
        eventCount: 0,
        responseIdSeen: false,
      });
      expect(extractTransportDiagnostics(error)[0]?.details).not.toHaveProperty('error');
      expect(extractTransportDiagnostics(error)[0]?.details?.timeline).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'ws_close', code: 1006 }),
          expect.objectContaining({ type: 'transport_error' }),
        ]),
      );
    } finally {
      vi.doUnmock('ws');
    }
  });
});

describe('transparent provider patching', () => {
  it('registers the explicit websocket API in the global API registry', () => {
    const streamSimple = vi.fn();
    const registerApi = vi.fn();

    registerOpenAIWebSocketResponsesApiProvider(streamSimple as any, registerApi);

    expect(registerApi).toHaveBeenCalledWith(
      {
        api: 'openai-websocket-responses',
        stream: expect.any(Function),
        streamSimple,
      },
      'provider:openai-websocket-responses',
    );
  });

  it('makes the explicit API available to models owned by other providers', () => {
    const streamSimple = vi.fn();

    try {
      registerOpenAIWebSocketResponsesApiProvider(streamSimple as any);

      expect(getApiProvider('openai-websocket-responses' as any)?.streamSimple).toBeTypeOf(
        'function',
      );
    } finally {
      unregisterApiProviders('provider:openai-websocket-responses');
    }
  });

  it('installs the transparent websocket patch and Codex transport metadata patch together', () => {
    const installCodexTransportMetadataPatch = vi.fn();
    const installTransparentPatch = vi.fn();

    installOpenAIWebSocketResponsesApiPatches(
      installCodexTransportMetadataPatch,
      installTransparentPatch,
    );

    expect(installCodexTransportMetadataPatch).toHaveBeenCalledOnce();
    expect(installTransparentPatch).toHaveBeenCalledOnce();
    expect(installCodexTransportMetadataPatch.mock.invocationCallOrder[0]).toBeLessThan(
      installTransparentPatch.mock.invocationCallOrder[0],
    );
  });

  it('reapplies API provider wrappers after model-registry refresh events', async () => {
    const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
    const pi = {
      on(event: string, handler: (event?: unknown, ctx?: unknown) => unknown) {
        handlers.set(event, handler);
      },
    } as any;
    const installPatch = vi.fn();

    registerOpenAIWebSocketResponsesPatchRefreshHooks(pi, installPatch);

    expect([...handlers.keys()].sort()).toEqual([
      'agent_start',
      'before_provider_request',
      'model_select',
      'session_start',
    ]);

    handlers.get('session_start')?.();
    handlers.get('model_select')?.();
    handlers.get('agent_start')?.();
    handlers.get('before_provider_request')?.();

    expect(installPatch).toHaveBeenCalledTimes(4);
  });

  it('routes matching models to the websocket stream and delegates non-matching models', async () => {
    const settings = normalizeSettings({
      patch: { enabled: true, providers: [], providerModels: ['facade/gpt-5*'] },
    });
    const websocketStream = vi.fn((_model: Model<any>, _context: any) =>
      createAssistantMessageEventStream(),
    );
    const originalStreamSimple = vi.fn((_model: Model<any>, _context: any) =>
      createAssistantMessageEventStream(),
    );
    const provider = wrapProviderForWebSocketResponses(
      {
        api: 'openai-responses',
        stream: originalStreamSimple as any,
        streamSimple: originalStreamSimple,
      },
      () => settings,
      websocketStream as any,
    );

    provider.streamSimple(makeModel({ id: 'gpt-5.5' }), { messages: [] });
    provider.streamSimple(makeModel({ id: 'gpt-4.1' }), { messages: [] });

    expect(websocketStream).toHaveBeenCalledTimes(1);
    expect(originalStreamSimple).toHaveBeenCalledTimes(1);
  });

  it('delegates matching models to the original SSE stream when transport is sse', async () => {
    const settings = normalizeSettings({
      patch: { enabled: true, providerModels: ['facade/gpt-5*'] },
    });
    const websocketStream = vi.fn((_model: Model<any>, _context: any, _options?: any) =>
      createAssistantMessageEventStream(),
    );
    const originalMessage = makeAssistantMessage(makeModel({ id: 'gpt-5.5' }));
    const originalStreamSimple = vi.fn((_model: Model<any>, _context: any, _options?: any) =>
      streamFromEvents(
        { type: 'start', partial: originalMessage },
        { type: 'done', reason: 'stop', message: originalMessage },
      ),
    );
    const provider = wrapProviderForWebSocketResponses(
      {
        api: 'openai-responses',
        stream: originalStreamSimple as any,
        streamSimple: originalStreamSimple,
      },
      () => settings,
      websocketStream as any,
    );

    const events = await collectStreamEvents(
      provider.streamSimple(makeModel({ id: 'gpt-5.5' }), { messages: [] }, { transport: 'sse' }),
    );

    expect(websocketStream).not.toHaveBeenCalled();
    expect(originalStreamSimple).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(['start', 'done']);
  });

  it('routes configured SSE models through the shared Responses SSE parser', async () => {
    const settings = normalizeSettings({
      patch: {
        enabled: true,
        providers: [],
        providerModels: [],
        transportByProviderModel: { 'devai/*': 'sse' },
      },
    });
    const websocketStream = vi.fn((_model: Model<any>, _context: any, _options?: any) =>
      createAssistantMessageEventStream(),
    );
    const originalStreamSimple = vi.fn((_model: Model<any>, _context: any, _options?: any) =>
      createAssistantMessageEventStream(),
    );
    const sseMessage = makeAssistantMessage(makeModel({ provider: 'devai', id: 'gpt-5.6-sol' }));
    sseMessage.content.push({ type: 'text', text: 'SSE response' });
    const sseStream = vi.fn((_model: Model<any>, _context: any, _options?: any) =>
      streamFromEvents(
        { type: 'start', partial: sseMessage },
        { type: 'done', reason: 'stop', message: sseMessage },
      ),
    );
    const provider = wrapProviderForWebSocketResponses(
      {
        api: 'openai-responses',
        stream: originalStreamSimple as any,
        streamSimple: originalStreamSimple,
      },
      () => settings,
      websocketStream as any,
      undefined,
      sseStream as any,
    );

    const result = await collectStreamEvents(
      provider.streamSimple(makeModel({ provider: 'devai', id: 'gpt-5.6-sol' }), { messages: [] }),
    );

    expect(result.map((event) => event.type)).toEqual(['start', 'done']);
    expect(sseStream).toHaveBeenCalledOnce();
    expect(sseStream.mock.calls[0]?.[2]).toMatchObject({ transport: 'sse' });
    expect(websocketStream).not.toHaveBeenCalled();
    expect(originalStreamSimple).not.toHaveBeenCalled();
  });

  it('remembers deterministic WebSocket incompatibility for the rest of the session', async () => {
    clearWebSocketCapabilityCache();
    const settings = normalizeSettings({
      patch: { enabled: true, providers: [], providerModels: ['facade/gpt-5*'] },
    });
    const websocketError = makeAssistantMessage(makeModel({ id: 'gpt-5.5' }));
    websocketError.stopReason = 'error';
    websocketError.errorMessage = 'WebSocket transport is not supported by this endpoint';
    const websocketStream = vi.fn((_model: Model<any>, _context: any, _options?: any) =>
      streamFromEvents({ type: 'error', reason: 'error', error: websocketError }),
    );
    const sseMessage = makeAssistantMessage(makeModel({ id: 'gpt-5.5' }));
    sseMessage.content.push({ type: 'text', text: 'SSE fallback' });
    const sseStream = vi.fn((_model: Model<any>, _context: any, _options?: any) =>
      streamFromEvents(
        { type: 'start', partial: sseMessage },
        { type: 'done', reason: 'stop', message: sseMessage },
      ),
    );
    const originalStreamSimple = vi.fn();
    const provider = wrapProviderForWebSocketResponses(
      {
        api: 'openai-responses',
        stream: originalStreamSimple as any,
        streamSimple: originalStreamSimple as any,
      },
      () => settings,
      websocketStream as any,
      undefined,
      sseStream as any,
    );
    const model = makeModel({ id: 'gpt-5.5' });
    const options = { sessionId: 'capability-session', transport: 'auto' } as any;

    try {
      await collectStreamEvents(provider.streamSimple(model, { messages: [] }, options));
      await collectStreamEvents(provider.streamSimple(model, { messages: [] }, options));

      expect(isWebSocketUnsupportedError(websocketError)).toBe(true);
      expect(isWebSocketUnsupportedError(new Error('Unexpected server response: 500'))).toBe(false);
      expect(isWebSocketUnsupportedError(new Error('WebSocket timed out'))).toBe(false);
      expect(websocketStream).toHaveBeenCalledOnce();
      expect(sseStream).toHaveBeenCalledTimes(2);
      expect(originalStreamSimple).not.toHaveBeenCalled();
    } finally {
      clearWebSocketCapabilityCache();
    }
  });

  it('falls back to the original SSE stream when auto WebSocket fails before start', async () => {
    const settings = normalizeSettings({
      patch: { enabled: true, providerModels: ['facade/gpt-5*'] },
    });
    const websocketMessage = makeAssistantMessage(makeModel({ id: 'gpt-5.5' }));
    websocketMessage.stopReason = 'error';
    websocketMessage.errorMessage = 'Connection error: WebSocket closed 1006';
    const websocketDiagnostics = createTransportDiagnostics({
      configuredTransport: 'auto',
      url: 'wss://example.test/responses',
      logicalTraceId: 'abcdefabcdefabcdefabcdefabcdefab',
    });
    websocketDiagnostics.record('ws_close', { code: 1006, attempt: 0 });
    attachTransportDiagnostic(websocketMessage, websocketDiagnostics, {
      finalTransport: 'websocket',
      outcome: 'transport_error',
    });
    const websocketStream = vi.fn((_model: Model<any>, _context: any, _options?: any) =>
      streamFromEvents({ type: 'error', reason: 'error', error: websocketMessage }),
    );
    const originalMessage = makeAssistantMessage(makeModel({ id: 'gpt-5.5' }));
    const originalStreamSimple = vi.fn((_model: Model<any>, _context: any, _options?: any) =>
      streamFromEvents(
        { type: 'start', partial: originalMessage },
        { type: 'done', reason: 'stop', message: originalMessage },
      ),
    );
    const lifecycle: WebSocketLifecycleEvent[] = [];
    const provider = wrapProviderForWebSocketResponses(
      {
        api: 'openai-responses',
        stream: originalStreamSimple as any,
        streamSimple: originalStreamSimple,
      },
      () => settings,
      websocketStream as any,
      (event) => lifecycle.push(event),
    );

    const events = await collectStreamEvents(
      provider.streamSimple(
        makeModel({ id: 'gpt-5.5' }),
        { messages: [] },
        {
          transport: 'auto',
          headers: { Traceparent: '00-abcdefabcdefabcdefabcdefabcdefab-1111111111111111-01' },
        },
      ),
    );

    expect(websocketStream).toHaveBeenCalledTimes(1);
    expect(originalStreamSimple).toHaveBeenCalledTimes(1);
    expect(originalStreamSimple.mock.calls[0]?.[2]).toMatchObject({
      transport: 'sse',
      headers: {
        traceparent: expect.stringMatching(/^00-abcdefabcdefabcdefabcdefabcdefab-[0-9a-f]{16}-01$/),
      },
    });
    expect(originalStreamSimple.mock.calls[0]?.[2]?.headers).not.toHaveProperty('Traceparent');
    expect(events.map((event) => event.type)).toEqual(['start', 'done']);
    expect(events[1]?.message).toBe(originalMessage);
    expect(extractTransportDiagnostics(events[1]?.message)[0]?.details).toMatchObject({
      configuredTransport: 'auto',
      fallbackTransport: 'sse',
      finalTransport: 'sse',
      outcome: 'sse_fallback_after_websocket_failure',
    });
    expect(extractTransportDiagnostics(events[1]?.message)[0]?.details?.timeline).toContainEqual(
      expect.objectContaining({ type: 'sse_fallback' }),
    );
    expect(lifecycle).toEqual([
      expect.objectContaining({
        type: 'transport_fallback',
        reason: 'websocket_failed_before_stream_start',
        from: 'websocket',
        to: 'sse',
        message: 'Connection error: WebSocket closed 1006',
      }),
      expect.objectContaining({
        type: 'transport_fallback_completed',
        from: 'websocket',
        to: 'sse',
      }),
    ]);
  });

  it('preserves websocket diagnostics when auto WebSocket throws before start', async () => {
    const settings = normalizeSettings({
      patch: { enabled: true, providerModels: ['facade/gpt-5*'] },
    });
    const websocketMessage = makeAssistantMessage(makeModel({ id: 'gpt-5.5' }));
    const websocketDiagnostics = createTransportDiagnostics({
      configuredTransport: 'auto',
      url: 'wss://example.test/responses',
    });
    websocketDiagnostics.record('ws_error', { message: 'boom' });
    attachTransportDiagnostic(websocketMessage, websocketDiagnostics, {
      finalTransport: 'websocket',
      outcome: 'transport_error',
    });
    const websocketStream = vi.fn(
      (_model: Model<any>, _context: any, _options?: any) =>
        ({
          [Symbol.asyncIterator]() {
            return {
              async next() {
                throw websocketMessage;
              },
            };
          },
        }) as any,
    );
    const originalMessage = makeAssistantMessage(makeModel({ id: 'gpt-5.5' }));
    const originalStreamSimple = vi.fn((_model: Model<any>, _context: any, _options?: any) =>
      streamFromEvents(
        { type: 'start', partial: originalMessage },
        { type: 'done', reason: 'stop', message: originalMessage },
      ),
    );
    const provider = wrapProviderForWebSocketResponses(
      {
        api: 'openai-responses',
        stream: originalStreamSimple as any,
        streamSimple: originalStreamSimple,
      },
      () => settings,
      websocketStream as any,
    );

    const events = await collectStreamEvents(
      provider.streamSimple(makeModel({ id: 'gpt-5.5' }), { messages: [] }, { transport: 'auto' }),
    );

    expect(events.map((event) => event.type)).toEqual(['start', 'done']);
    expect(extractTransportDiagnostics(events[1]?.message)[0]?.details).toMatchObject({
      fallbackTransport: 'sse',
      finalTransport: 'sse',
      outcome: 'sse_fallback_after_websocket_failure',
    });
  });

  it('does not fall back when strict websocket transport fails before start', async () => {
    const settings = normalizeSettings({
      patch: { enabled: true, providerModels: ['facade/gpt-5*'] },
    });
    const websocketMessage = makeAssistantMessage(makeModel({ id: 'gpt-5.5' }));
    websocketMessage.stopReason = 'error';
    websocketMessage.errorMessage = 'Connection error: WebSocket closed 1006';
    const websocketStream = vi.fn((_model: Model<any>, _context: any, _options?: any) =>
      streamFromEvents({ type: 'error', reason: 'error', error: websocketMessage }),
    );
    const originalStreamSimple = vi.fn((_model: Model<any>, _context: any, _options?: any) =>
      createAssistantMessageEventStream(),
    );
    const provider = wrapProviderForWebSocketResponses(
      {
        api: 'openai-responses',
        stream: originalStreamSimple as any,
        streamSimple: originalStreamSimple,
      },
      () => settings,
      websocketStream as any,
    );

    const events = await collectStreamEvents(
      provider.streamSimple(
        makeModel({ id: 'gpt-5.5' }),
        { messages: [] },
        { transport: 'websocket' },
      ),
    );

    expect(originalStreamSimple).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: 'error', reason: 'error', error: websocketMessage }]);
  });

  it('does not fall back after the WebSocket stream has started', async () => {
    const settings = normalizeSettings({
      patch: { enabled: true, providerModels: ['facade/gpt-5*'] },
    });
    const websocketMessage = makeAssistantMessage(makeModel({ id: 'gpt-5.5' }));
    const websocketError = makeAssistantMessage(makeModel({ id: 'gpt-5.5' }));
    websocketError.stopReason = 'error';
    websocketError.errorMessage = 'Connection error: WebSocket closed 1006';
    const websocketStream = vi.fn((_model: Model<any>, _context: any, _options?: any) =>
      streamFromEvents(
        { type: 'start', partial: websocketMessage },
        { type: 'error', reason: 'error', error: websocketError },
      ),
    );
    const originalStreamSimple = vi.fn((_model: Model<any>, _context: any, _options?: any) =>
      createAssistantMessageEventStream(),
    );
    const provider = wrapProviderForWebSocketResponses(
      {
        api: 'openai-responses',
        stream: originalStreamSimple as any,
        streamSimple: originalStreamSimple,
      },
      () => settings,
      websocketStream as any,
    );

    const events = await collectStreamEvents(
      provider.streamSimple(makeModel({ id: 'gpt-5.5' }), { messages: [] }, { transport: 'auto' }),
    );

    expect(originalStreamSimple).not.toHaveBeenCalled();
    expect(events.map((event) => event.type)).toEqual(['start', 'error']);
  });

  it('falls back to SSE when the first WebSocket frame is a terminal 408 error', async () => {
    const settings = normalizeSettings({
      patch: { enabled: true, providerModels: ['facade/gpt-5*'] },
      websocket: { retries: 0, firstEventTimeoutMs: 0 },
    });
    class FakeWebSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        queueMicrotask(() => this.emit('open', {}));
      }

      send() {
        queueMicrotask(() =>
          this.emit('message', {
            data: JSON.stringify({
              type: 'error',
              status: 408,
              error: {
                type: 'invalid_request_error',
                message: 'stream closed before response.completed',
              },
            }),
          }),
        );
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    vi.doMock('ws', () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));
    const originalMessage = makeAssistantMessage(makeModel({ id: 'gpt-5.5' }));
    const originalStreamSimple = vi.fn((_model: Model<any>, _context: any, _options?: any) =>
      streamFromEvents(
        { type: 'start', partial: originalMessage },
        { type: 'done', reason: 'stop', message: originalMessage },
      ),
    );
    const provider = wrapProviderForWebSocketResponses(
      {
        api: 'openai-responses',
        stream: originalStreamSimple as any,
        streamSimple: originalStreamSimple,
      },
      () => settings,
      createOpenAIWebSocketResponsesStream(() => settings),
    );

    try {
      const events = await collectStreamEvents(
        provider.streamSimple(makeModel({ id: 'gpt-5.5' }), { messages: [] }, {
          apiKey: 'test-token',
          transport: 'auto',
        } as any),
      );

      expect(originalStreamSimple).toHaveBeenCalledTimes(1);
      expect(events.map((event) => event.type)).toEqual(['start', 'done']);
      expect(extractTransportDiagnostics(events[1]?.message)[0]?.details).toMatchObject({
        fallbackTransport: 'sse',
        finalTransport: 'sse',
        outcome: 'sse_fallback_after_websocket_failure',
        failureReason: 'providerServerError',
        retryable: true,
        responseErrorStatus: 408,
      });
    } finally {
      vi.doUnmock('ws');
      closeAllCachedWebSockets();
    }
  });

  it('falls back to SSE when auto WebSocket closes after response.created before output', async () => {
    const settings = normalizeSettings({
      patch: { enabled: true, providerModels: ['facade/gpt-5*'] },
      websocket: { retries: 0, firstEventTimeoutMs: 0 },
    });
    class FakeWebSocket {
      readyState = 1;
      listeners = new Map<string, Set<(event: any) => void>>();

      constructor() {
        queueMicrotask(() => this.emit('open', {}));
      }

      send() {
        queueMicrotask(() => {
          this.emit('message', {
            data: JSON.stringify({ type: 'response.created', response: { id: 'resp_preoutput' } }),
          });
          this.emit('close', { code: 1006 });
        });
      }

      close() {
        this.readyState = 3;
      }

      addEventListener(type: string, listener: (event: any) => void) {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      emit(type: string, event: any) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    vi.doMock('ws', () => ({ WebSocket: FakeWebSocket, default: FakeWebSocket }));
    const originalMessage = makeAssistantMessage(makeModel({ id: 'gpt-5.5' }));
    const originalStreamSimple = vi.fn((_model: Model<any>, _context: any, _options?: any) =>
      streamFromEvents(
        { type: 'start', partial: originalMessage },
        { type: 'done', reason: 'stop', message: originalMessage },
      ),
    );
    const provider = wrapProviderForWebSocketResponses(
      {
        api: 'openai-responses',
        stream: originalStreamSimple as any,
        streamSimple: originalStreamSimple,
      },
      () => settings,
      createOpenAIWebSocketResponsesStream(() => settings),
    );

    try {
      const events = await collectStreamEvents(
        provider.streamSimple(
          makeModel({ id: 'gpt-5.5' }),
          { messages: [] },
          { transport: 'auto' },
        ),
      );

      expect(originalStreamSimple).toHaveBeenCalledTimes(1);
      expect(events.map((event) => event.type)).toEqual(['start', 'done']);
    } finally {
      vi.doUnmock('ws');
      closeAllCachedWebSockets();
    }
  });
});
