import {
  calculateCost,
  clampThinkingLevel,
  createAssistantMessageEventStream,
  registerApiProvider,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type Usage,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { installOpenAICodexTransportMetadataPatch } from './codex-transport-metadata';

const API = 'openai-websocket-responses';
const DEFAULT_GPT_STYLE_MAX_OUTPUT_TOKENS = 128000;

type ResponsesInputItem = {
  type: 'message';
  role: 'user' | 'assistant';
  content: Array<{ type: 'input_text' | 'output_text'; text: string }>;
};

type ResponsesEvent = Record<string, any>;

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createOutput(model: Model<Api>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: API,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function textFromContent(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((item): item is TextContent => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((item): item is TextContent => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function convertMessage(message: Message): ResponsesInputItem | undefined {
  if (message.role === 'user') {
    const text = textFromContent(message.content).trim();
    if (!text) return undefined;
    return {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    };
  }

  if (message.role === 'assistant') {
    const text = assistantText(message).trim();
    if (!text) return undefined;
    return {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    };
  }

  return undefined;
}

function convertMessages(context: Context): ResponsesInputItem[] {
  return context.messages
    .map(convertMessage)
    .filter((item): item is ResponsesInputItem => Boolean(item));
}

function resolveResponsesUrl(model: Model<Api>): URL {
  if (!model.baseUrl) throw new Error('model.baseUrl is required for openai-websocket-responses');
  const url = new URL(model.baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/responses`;
  return url;
}

function resolveWebSocketUrl(model: Model<Api>, headers: Headers): string {
  const url = resolveResponsesUrl(model);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';

  const deployment = headers.get('x-azure-deployment');
  const region = headers.get('x-azure-region');
  const bucket = headers.get('x-azure-resource-bucket');
  if (deployment && !url.searchParams.has('deployment'))
    url.searchParams.set('deployment', deployment);
  if (region && !url.searchParams.has('region')) url.searchParams.set('region', region);
  if (bucket && !url.searchParams.has('azure-resource-bucket')) {
    url.searchParams.set('azure-resource-bucket', bucket);
  }
  return url.toString();
}

function buildHeaders(model: Model<Api>, options?: SimpleStreamOptions): Headers {
  const headers = new Headers(model.headers ?? {});
  for (const [key, value] of Object.entries(options?.headers ?? {})) {
    headers.set(key, value);
  }
  if (!headers.has('Authorization') && options?.apiKey) {
    headers.set('Authorization', `Bearer ${options.apiKey}`);
  }
  headers.delete('accept');
  headers.delete('content-type');
  return headers;
}

function resolveMaxOutputTokens(model: Model<Api>, options?: SimpleStreamOptions): number {
  return options?.maxTokens ?? model.maxTokens ?? DEFAULT_GPT_STYLE_MAX_OUTPUT_TOKENS;
}

function buildBody(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): Record<string, any> {
  const clampedReasoning = options?.reasoning
    ? clampThinkingLevel(model, options.reasoning)
    : undefined;
  const effort =
    clampedReasoning && clampedReasoning !== 'off'
      ? (model.thinkingLevelMap?.[clampedReasoning] ?? clampedReasoning)
      : undefined;

  const body: Record<string, any> = {
    model: model.headers?.['x-azure-deployment'] ?? model.id,
    store: false,
    input: convertMessages(context),
    max_output_tokens: resolveMaxOutputTokens(model, options),
  };
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (effort !== undefined && effort !== null) {
    body.reasoning = { effort };
  }
  return body;
}

function updateUsage(output: AssistantMessage, model: Model<Api>, response: any): void {
  const usage = response?.usage;
  if (!usage) return;
  output.usage.input = usage.input_tokens ?? 0;
  output.usage.output = usage.output_tokens ?? 0;
  output.usage.cacheRead = usage.input_tokens_details?.cached_tokens ?? 0;
  output.usage.cacheWrite = 0;
  output.usage.totalTokens = usage.total_tokens ?? output.usage.input + output.usage.output;
  output.usage.cost = calculateCost(model, output.usage);
}

function ensureTextBlock(output: AssistantMessage, stream: AssistantMessageEventStream): number {
  let index = output.content.findIndex((item) => item.type === 'text');
  if (index !== -1) return index;
  index = output.content.length;
  output.content.push({ type: 'text', text: '' });
  stream.push({ type: 'text_start', contentIndex: index, partial: output });
  return index;
}

function applyEvent(
  event: ResponsesEvent,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  model: Model<Api>,
): boolean {
  const type = event.type;
  if (event.response?.id) output.responseId = event.response.id;

  if (type === 'response.output_text.delta') {
    const delta = String(event.delta ?? '');
    if (!delta) return false;
    const index = ensureTextBlock(output, stream);
    const block = output.content[index];
    if (block?.type === 'text') block.text += delta;
    stream.push({ type: 'text_delta', contentIndex: index, delta, partial: output });
    return false;
  }

  if (type === 'response.completed') {
    updateUsage(output, model, event.response);
    const index = output.content.findIndex((item) => item.type === 'text');
    if (index !== -1) {
      const block = output.content[index];
      if (block?.type === 'text') {
        stream.push({
          type: 'text_end',
          contentIndex: index,
          content: block.text,
          partial: output,
        });
      }
    }
    return true;
  }

  if (
    type === 'response.failed' ||
    type === 'response.incomplete' ||
    type === 'response.cancelled'
  ) {
    throw new Error(
      JSON.stringify(event.response?.error ?? event.response?.incomplete_details ?? event),
    );
  }

  return false;
}

async function getWebSocketConstructor(): Promise<any> {
  try {
    const mod = await import('ws');
    return mod.WebSocket ?? mod.default;
  } catch {
    return globalThis.WebSocket;
  }
}

function stringifyHeaderValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(stringifyHeaderValue).join(',');
  try {
    return JSON.stringify(value);
  } catch {
    return '<unserializable>';
  }
}

function summarizeHeaders(headers: unknown): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const record = headers as Record<string, unknown>;
  const wanted = [
    'content-type',
    'x-request-id',
    'apim-request-id',
    'x-envoy-upstream-service-time',
    'x-ambassador-response-flags',
    'x-ambassador-upstream',
    'server',
  ];
  const values = wanted
    .map((key) => {
      const value = record[key] ?? record[key.toLowerCase()] ?? record[key.toUpperCase()];
      return value === undefined ? undefined : `${key}=${stringifyHeaderValue(value)}`;
    })
    .filter(Boolean);
  return values.length > 0 ? values.join('; ') : undefined;
}

function formatWebSocketError(event: any): string {
  const message = event?.message ?? event?.error?.message ?? event?.target?._closeMessage;
  const code = event?.code ?? event?.target?._closeCode;
  const response = event?.response ?? event?.handshake ?? event?.target?._req?.res;
  const statusCode = response?.statusCode ?? response?.status;
  const statusMessage = response?.statusMessage ?? response?.statusText;
  const headers = summarizeHeaders(response?.headers);
  const body = response?.body ?? response?.data ?? response?._body;
  return [
    'WebSocket error',
    event?.url ? `url=${event.url}` : undefined,
    statusCode ? `status=${statusCode}` : undefined,
    statusMessage ? `statusText=${statusMessage}` : undefined,
    code ? `code=${code}` : undefined,
    message ? `message=${String(message)}` : undefined,
    headers ? `headers={${headers}}` : undefined,
    body ? `body=${String(body).slice(0, 2000)}` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
}

async function openSocket(url: string, headers: Headers, signal?: AbortSignal): Promise<WebSocket> {
  const WebSocketCtor = await getWebSocketConstructor();
  return new Promise((resolve, reject) => {
    let handshakeFailure: any;
    const socket = new WebSocketCtor(url, { headers: Object.fromEntries(headers.entries()) });
    const cleanup = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (event: any) => {
      cleanup();
      reject(new Error(formatWebSocketError({ ...event, url, handshake: handshakeFailure })));
    };
    const onUnexpectedResponse = (_request: unknown, response: any) => {
      let body = '';
      handshakeFailure = {
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        headers: response.headers,
        body,
      };
      response.on?.('data', (chunk: Buffer | string) => {
        body += chunk.toString();
        handshakeFailure.body = body;
      });
      response.on?.('end', () => {
        cleanup();
        reject(new Error(formatWebSocketError({ url, response: handshakeFailure })));
      });
    };
    const onAbort = () => {
      cleanup();
      socket.close(1000, 'aborted');
      reject(new Error('Request was aborted'));
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.on?.('unexpected-response', onUnexpectedResponse);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readSocketText(event: MessageEvent): Promise<string> {
  if (typeof event.data === 'string') return event.data;
  if (event.data instanceof Blob) return await event.data.text();
  if (event.data instanceof ArrayBuffer) return new TextDecoder().decode(event.data);
  return String(event.data);
}

function streamWebSocket(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output = createOutput(model);
    let socket: WebSocket | undefined;
    try {
      const headers = buildHeaders(model, options);
      const url = resolveWebSocketUrl(model, headers);
      if (!headers.has('Authorization')) {
        throw new Error(`Missing Authorization header for ${url}`);
      }
      const body = buildBody(model, context, options);
      socket = await openSocket(url, headers, options?.signal);
      await options?.onResponse?.(
        { status: 101, headers: { connection: 'Upgrade', upgrade: 'websocket' } },
        model,
      );
      stream.push({ type: 'start', partial: output });
      socket.send(JSON.stringify({ type: 'response.create', ...body }));

      await new Promise<void>((resolve, reject) => {
        const onMessage = async (event: MessageEvent) => {
          try {
            const payload = JSON.parse(await readSocketText(event));
            if (applyEvent(payload, output, stream, model)) resolve();
          } catch (error) {
            reject(error);
          }
        };
        const onError = (event: any) => reject(new Error(formatWebSocketError(event)));
        const onClose = (event: any) => {
          const code = event?.code ? ` code=${event.code}` : '';
          const reason = event?.reason ? ` reason=${event.reason}` : '';
          reject(new Error(`WebSocket closed before response.completed${code}${reason}`));
        };
        socket!.addEventListener('message', onMessage);
        socket!.addEventListener('error', onError);
        socket!.addEventListener('close', onClose);
      });

      stream.push({ type: 'done', reason: 'stop', message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: 'error', reason: output.stopReason, error: output });
      stream.end();
    } finally {
      socket?.close(1000, 'done');
    }
  })();
  return stream;
}

export default function (pi: ExtensionAPI) {
  installOpenAICodexTransportMetadataPatch();

  registerApiProvider(
    {
      api: API,
      stream: streamWebSocket,
      streamSimple: streamWebSocket,
    },
    'extension:openai-websocket-responses',
  );

  // Temporary smoke-test provider. If this works, move these api/baseUrl fields
  // onto the regular facade entries in models.json.
  pi.registerProvider('facade-ws', {
    baseUrl:
      'https://llm-fusion-hub.a.musta.ch/api/v2/proxy/experimental/azure_openai/openai/v1/?api-version=preview',
    apiKey: '!iap-auth',
    authHeader: true,
    api: API,
    models: [
      {
        id: 'gpt-5.5-nomoderation',
        name: 'facade-ws/gpt-5.5',
        api: API,
        baseUrl:
          'https://llm-fusion-hub.a.musta.ch/api/v2/proxy/experimental/azure_openai/openai/v1/?api-version=preview',
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
