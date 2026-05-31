import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';

import {
  createIdleKeepaliveActivityTracker,
  formatWebSocketStatus,
  IDLE_KEEPALIVE_ACTIVITY_WINDOW_MS,
} from './index.ts';
import { buildResponsesBody } from './src/body.ts';
import { shortHash } from './src/debug.ts';
import {
  buildContinuationRequestBody,
  clearAllContinuations,
  getContinuation,
  requestBodyForContinuationComparison,
  setContinuation,
  type ContinuationState,
} from './src/continuation-cache.ts';
import { buildRequestHeaders, buildWebSocketHeaders } from './src/headers.ts';
import { shouldPatchModel } from './src/match.ts';
import { resolveRequestProfile } from './src/profile.ts';
import {
  buildWebSocketResponseHeaders,
  createOpenAIWebSocketResponsesStream,
} from './src/provider.ts';
import { wrapProviderForWebSocketResponses } from './src/patch.ts';
import {
  attachTransportDiagnostic,
  createTransportDiagnostics,
  extractTransportDiagnostics,
  mergeTransportDiagnostics,
} from './src/transport-diagnostics.ts';
import { recoverResponseByRetrieve } from './src/retrieve-recovery.ts';
import {
  assistantMessageToResponseItems,
  extractResponseOutputText,
  processResponsesEvents,
} from './src/responses-adapter.ts';
import { normalizeSettings, readOpenAIWebSocketResponsesSettings } from './src/settings.ts';
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
});

describe('settings and patch matching', () => {
  it('defaults to explicit API enabled and transparent patch disabled', () => {
    expect(normalizeSettings(undefined)).toMatchObject({
      patch: { enabled: false, apis: ['openai-responses', 'openai-codex-responses'] },
      request: { queryParams: {} },
      websocket: { retries: 2, connectTimeoutMs: 15000, idleTimeoutMs: 0 },
      recovery: {
        enabled: true,
        pollIntervalMs: 1000,
        timeoutMs: 30000,
        notFoundGraceMs: 5000,
        emitSyntheticDeltas: true,
      },
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
      store: false,
      text: { verbosity: 'high' },
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'session-abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ-01',
      prompt_cache_retention: '24h',
      reasoning: { effort: 'medium', summary: 'auto' },
    });
    expect(body.service_tier).toBeUndefined();
    expect(body.input).toEqual([expect.objectContaining({ role: 'user' })]);
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
      settings: normalizeSettings({ websocket: { retries: 0 } }),
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
    ).toBe('WebSocket ws#61243 connected · new');
    expect(
      formatWebSocketStatus({
        type: 'open',
        connectionId: 'ws#61244',
        cacheStatus: 'busy',
        cacheKeyHash: '336920397f78',
        urlHash: 'urlhash',
      }),
    ).toBe('WebSocket ws#61244 connected · extra');
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

  it('does not retry after response_id has been observed', async () => {
    const { WebSocketCtor, instances } = makeWebSocketCtor([
      (socket) => {
        socket.emit('message', {
          data: JSON.stringify({ type: 'response.created', response: { id: 'resp_mid' } }),
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

describe('provider transport diagnostics', () => {
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
              response: { id, status: 'completed' },
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
  it('routes matching models to the websocket stream and delegates non-matching models', async () => {
    const settings = normalizeSettings({
      patch: { enabled: true, providerModels: ['facade/gpt-5*'] },
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

    expect(websocketStream).toHaveBeenCalledTimes(1);
    expect(originalStreamSimple).toHaveBeenCalledTimes(1);
    expect(originalStreamSimple.mock.calls[0]?.[2]).toMatchObject({ transport: 'sse' });
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
});
