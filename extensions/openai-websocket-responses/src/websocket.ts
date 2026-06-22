import { shortHash, writeDebugLog } from './debug.ts';
import { parsePartialJson } from './partial-json.ts';
import type { OpenAIWebSocketResponsesSettings } from './settings.ts';
import type { TransportDiagnosticsCollector } from './transport-diagnostics.ts';
import { cloneHeadersWithTraceparent, type TraceContext } from './trace-context.ts';
import type { ResponsesBody } from './body.ts';
import { isRetryableEmptyResponseFailure } from './responses-adapter.ts';
import {
  isReplayUnsafeResponsesEvent,
  shouldRetryResponsesTransportErrorBeforeOutput,
} from '../../shared/openai-responses-retry';
import {
  isRetryableResponsesErrorFrame,
  previousResponseNotFoundMessage,
  responsesErrorFrameMessage,
} from '../../shared/openai-responses-terminal';
import {
  classifyOpenAIResponsesFailure,
  type ProviderFailureClassification,
} from '../../shared/provider-errors';

interface WebSocketLike {
  readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  ping?(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  on?(event: string, listener: (...args: any[]) => void): void;
  off?(event: string, listener: (...args: any[]) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
}

interface WebSocketConstructorLike {
  new (url: string, options?: { headers?: Record<string, string> }): WebSocketLike;
}

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Headers; body?: string; signal?: AbortSignal },
) => Promise<{
  status: number;
  headers?: Headers | Record<string, string>;
  text(): Promise<string>;
}>;

class WebSocketUpgradeResponseError extends Error {
  readonly status?: number;
  readonly headers?: Record<string, unknown>;
  readonly bodyText?: string;
  readonly bodyJson?: unknown;
  classification?: ProviderFailureClassification;
  classificationProbeStatus?: number;
  classificationProbeHeaders?: Record<string, unknown>;
  classificationProbeBody?: string;

  constructor(input: {
    status?: number;
    headers?: Record<string, unknown>;
    bodyText?: string;
    bodyJson?: unknown;
  }) {
    const classification = classifyOpenAIResponsesFailure({
      status: input.status,
      body: input.bodyJson ?? input.bodyText,
    });
    super(formatUpgradeFailureMessage(input, classification));
    this.name = 'WebSocketUpgradeResponseError';
    this.status = input.status;
    this.headers = input.headers;
    this.bodyText = input.bodyText;
    this.bodyJson = input.bodyJson;
    this.classification = classification;
  }

  applyClassificationProbe(input: {
    status: number;
    headers?: Record<string, unknown>;
    bodyText: string;
    bodyJson?: unknown;
    classification?: ProviderFailureClassification;
  }): void {
    this.classificationProbeStatus = input.status;
    this.classificationProbeHeaders = input.headers;
    this.classificationProbeBody = input.bodyText;
    if (input.classification) {
      this.classification = input.classification;
      this.message = formatUpgradeFailureMessage(
        { status: this.status, bodyText: this.bodyText, bodyJson: this.bodyJson },
        input.classification,
      );
    }
  }
}

interface SocketCacheEntry {
  socket: WebSocketLike;
  busy: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleCloseListener?: (event: any) => void;
  idleErrorListener?: (event: any) => void;
  keepaliveTimer?: ReturnType<typeof setTimeout>;
  keepalivePongTimer?: ReturnType<typeof setTimeout>;
  keepalivePongListener?: (...args: any[]) => void;
  onLifecycleEvent?: WebSocketLifecycleObserver;
  traceContext?: TraceContext;
}

const IDLE_SOCKET_CACHE_TTL_MS = 15 * 60 * 1000;
const IDLE_SOCKET_KEEPALIVE_INTERVAL_MS = 30 * 1000;
const IDLE_SOCKET_KEEPALIVE_PONG_TIMEOUT_MS = 10 * 1000;
const CLOSED_READY_STATE = 3;
const socketCache = new Map<string, SocketCacheEntry>();
const socketIds = new WeakMap<WebSocketLike, string>();
const openedSockets = new WeakSet<WebSocketLike>();
const closedSockets = new WeakSet<WebSocketLike>();
let nextSocketId = 0;

export class WebSocketMidstreamError extends Error {
  constructor(
    message: string,
    readonly responseId: string | undefined,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WebSocketMidstreamError';
  }
}

class RetryableResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableResponseError';
  }
}

class TerminalResponseErrorFrame extends Error {
  readonly failureReason?: string;
  readonly failureCategory?: string;
  readonly retryable?: boolean;

  constructor(
    message: string,
    readonly event: Record<string, any>,
  ) {
    super(message);
    this.name = 'TerminalResponseErrorFrame';
    const status = typeof event.status === 'number' ? event.status : event.error?.status;
    const classification = classifyOpenAIResponsesFailure({ status, event });
    this.failureReason = classification?.reason;
    this.failureCategory = classification?.category;
    this.retryable = classification?.retryable;
  }
}

function formatUpgradeFailureMessage(
  input: { status?: number; bodyText?: string; bodyJson?: unknown },
  classification: ProviderFailureClassification | undefined,
): string {
  const body = input.bodyJson && typeof input.bodyJson === 'object' ? input.bodyJson : undefined;
  const message = (body as any)?.error?.message ?? (body as any)?.message;
  if (typeof message === 'string' && message.length > 0) return message;
  if (input.bodyText && input.bodyText.trim().length > 0) return input.bodyText.trim();
  return `Unexpected server response:${input.status ? ` ${input.status}` : ''}${
    classification ? ` (${classification.reason})` : ''
  }`;
}

function parseJsonBody(text: string | undefined): unknown {
  if (!text || text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function websocketUrlToHttpUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    else if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    else return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function responseHeadersToRecord(headers: Headers | Record<string, string> | undefined) {
  if (!headers) return undefined;
  if (typeof (headers as Headers).forEach === 'function') {
    const output: Record<string, string> = {};
    (headers as Headers).forEach((value, key) => {
      output[key] = value;
    });
    return output;
  }
  return { ...(headers as Record<string, string>) };
}

function readNodeResponseBody(response: any): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    response.on?.('data', (chunk: unknown) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    response.on?.('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    response.on?.('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function failureDiagnosticFields(error: unknown): Record<string, unknown> {
  if (error instanceof WebSocketUpgradeResponseError) {
    return {
      httpStatus: error.status,
      responseHeaders: error.headers,
      responseBody: error.bodyText,
      classificationProbeStatus: error.classificationProbeStatus,
      classificationProbeHeaders: error.classificationProbeHeaders,
      classificationProbeBody: error.classificationProbeBody,
      failureReason: error.classification?.reason,
      failureCategory: error.classification?.category,
      retryable: error.classification?.retryable,
    };
  }
  if (error && typeof error === 'object') {
    const candidate = error as Record<string, unknown>;
    return {
      failureReason: candidate.failureReason,
      failureCategory: candidate.failureCategory,
      retryable: candidate.retryable,
    };
  }
  return {};
}

function isTerminalProviderFailure(error: unknown): boolean {
  if (error instanceof WebSocketUpgradeResponseError) {
    return error.classification?.retryable === false;
  }
  return Boolean(error && typeof error === 'object' && (error as any).retryable === false);
}

function shouldProbeEmptyUpgrade500(error: unknown): error is WebSocketUpgradeResponseError {
  return Boolean(
    error instanceof WebSocketUpgradeResponseError &&
    error.status === 500 &&
    (!error.bodyText || error.bodyText.trim().length === 0) &&
    error.classification?.retryable !== false,
  );
}

async function probeEmptyUpgrade500Classification(
  request: {
    url: string;
    headers: Headers;
    signal?: AbortSignal;
    diagnostics?: TransportDiagnosticsCollector;
    fetch?: FetchLike;
  },
  error: WebSocketUpgradeResponseError,
): Promise<void> {
  if (!shouldProbeEmptyUpgrade500(error) || request.signal?.aborted) return;
  const url = websocketUrlToHttpUrl(request.url);
  const fetchImpl = request.fetch ?? globalThis.fetch;
  if (!url || !fetchImpl) return;

  try {
    const headers = new Headers(request.headers);
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json');
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: '{}',
      signal: request.signal,
    });
    const bodyText = await response.text();
    const bodyJson = parseJsonBody(bodyText);
    const classification = classifyOpenAIResponsesFailure({
      status: response.status,
      body: bodyJson ?? bodyText,
    });
    const responseHeaders = responseHeadersToRecord(response.headers);
    error.applyClassificationProbe({
      status: response.status,
      headers: responseHeaders,
      bodyText,
      bodyJson,
      classification,
    });
    request.diagnostics?.record('ws_upgrade_classification_probe', {
      status: response.status,
      responseHeaders,
      responseBody: bodyText,
      failureReason: classification?.reason,
      failureCategory: classification?.category,
      retryable: classification?.retryable,
    });
  } catch (probeError) {
    request.diagnostics?.record('ws_upgrade_classification_probe_error', {
      message: probeError instanceof Error ? probeError.message : String(probeError),
    });
  }
}

interface WebSocketRunResult {
  responseId?: string;
  eventCount: number;
  connection?: WebSocketConnectionMetadata;
  fallbackUsed?: boolean;
  fallbackReason?: 'previous_response_not_found' | 'empty_response_failed_without_details';
}

export type WebSocketCacheStatus = 'disabled' | 'miss' | 'hit' | 'busy' | 'stale';

export interface WebSocketConnectionMetadata {
  connectionId: string;
  cacheStatus: WebSocketCacheStatus;
  cacheKeyHash?: string;
  localPort?: number;
  connectionTraceparent?: string;
  connectionTraceId?: string;
  connectionSpanId?: string;
}

export interface WebSocketTraceOptions {
  logicalTraceId: string;
  nextSpan(): TraceContext;
}

export type WebSocketLifecycleEvent =
  | {
      type: 'open';
      connectionId: string;
      cacheStatus: WebSocketCacheStatus;
      cacheKeyHash?: string;
      urlHash: string;
      localPort?: number;
    }
  | {
      type: 'close';
      connectionId: string;
      reason: string;
      cacheKeyHash?: string;
      localPort?: number;
      code?: number;
      closeReason?: string;
    }
  | {
      type: 'retry';
      reason: 'empty_response_failed_without_details' | 'midstream_error_before_output';
      action:
        | 'retry_fresh_websocket_same_previous_response_id'
        | 'retry_fresh_websocket_before_output';
      attempt: number;
      nextAttempt: number;
      maxAttempts: number;
      urlHash: string;
      connectionId?: string;
      cacheKeyHash?: string;
      responseId?: string;
      previousResponseId?: string;
    }
  | {
      type: 'fallback';
      reason: 'previous_response_not_found' | 'empty_response_failed_without_details';
      action: 'replay_full_conversation_without_previous_response_id';
      attempt: number;
      nextAttempt: number;
      maxAttempts: number;
      urlHash: string;
      connectionId?: string;
      cacheKeyHash?: string;
      responseId?: string;
      previousResponseId?: string;
    }
  | {
      type: 'recovering';
      reason: 'midstream_error';
      action: 'retrieve_response_snapshot';
      urlHash: string;
      responseId: string;
      message?: string;
    }
  | {
      type: 'recovered';
      mode: 'resumed' | 'full_replay';
      connectionId?: string;
      cacheKeyHash?: string;
      urlHash: string;
      responseId?: string;
    }
  | {
      type: 'failed';
      reason: 'recovery_failed';
      urlHash: string;
      responseId?: string;
      message?: string;
    };

export type WebSocketLifecycleObserver = (event: WebSocketLifecycleEvent) => void;

class PreviousResponseNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviousResponseNotFoundError';
  }
}

export function responseCreatePayloadBytes(body: ResponsesBody): number {
  return payloadBytes(responseCreatePayload(body));
}

function responseCreatePayload(body: ResponsesBody): string {
  return JSON.stringify({ type: 'response.create', ...body });
}

function payloadBytes(payload: string): number {
  return new TextEncoder().encode(payload).byteLength;
}

function isReusable(socket: WebSocketLike): boolean {
  return socket.readyState === undefined || socket.readyState === 1;
}

function getSocketLocalPort(socket: WebSocketLike): number | undefined {
  const localPort = (socket as { _socket?: { localPort?: unknown } })._socket?.localPort;
  return Number.isInteger(localPort) && Number(localPort) > 0 ? Number(localPort) : undefined;
}

function getSocketId(socket: WebSocketLike): string {
  let id = socketIds.get(socket);
  if (!id) {
    const localPort = getSocketLocalPort(socket);
    if (!localPort) nextSocketId += 1;
    id = localPort ? `ws#${localPort}` : `ws#${nextSocketId}`;
    socketIds.set(socket, id);
  }
  return id;
}

function getSocketConnectionMetadata(
  socket: WebSocketLike,
  cacheStatus: WebSocketCacheStatus,
  cacheKey: string | undefined,
  traceContext?: TraceContext,
): WebSocketConnectionMetadata {
  return {
    connectionId: getSocketId(socket),
    cacheStatus,
    cacheKeyHash: shortHash(cacheKey),
    localPort: getSocketLocalPort(socket),
    connectionTraceparent: traceContext?.traceparent,
    connectionTraceId: traceContext?.traceId,
    connectionSpanId: traceContext?.spanId,
  };
}

function emitLifecycle(
  onLifecycleEvent: WebSocketLifecycleObserver | undefined,
  event: WebSocketLifecycleEvent,
): void {
  try {
    onLifecycleEvent?.(event);
  } catch {
    // Lifecycle observers are diagnostic/UI-only and must not affect transport.
  }
}

function emitSocketOpen(
  onLifecycleEvent: WebSocketLifecycleObserver | undefined,
  socket: WebSocketLike,
  cacheStatus: WebSocketCacheStatus,
  cacheKey: string | undefined,
  url: string,
  traceContext?: TraceContext,
): void {
  openedSockets.add(socket);
  emitLifecycle(onLifecycleEvent, {
    type: 'open',
    ...getSocketConnectionMetadata(socket, cacheStatus, cacheKey, traceContext),
    urlHash: shortHash(url) ?? '',
  });
}

function emitSocketClose(
  onLifecycleEvent: WebSocketLifecycleObserver | undefined,
  socket: WebSocketLike,
  cacheKey: string | undefined,
  reason: string,
  event?: any,
): void {
  if (!openedSockets.has(socket) || closedSockets.has(socket)) return;
  closedSockets.add(socket);
  emitLifecycle(onLifecycleEvent, {
    type: 'close',
    connectionId: getSocketId(socket),
    reason,
    cacheKeyHash: shortHash(cacheKey),
    localPort: getSocketLocalPort(socket),
    code: typeof event?.code === 'number' ? event.code : undefined,
    closeReason: typeof event?.reason === 'string' ? event.reason : undefined,
  });
}

function closeSilently(socket: WebSocketLike, code = 1000, reason = 'done'): void {
  if (socket.readyState === CLOSED_READY_STATE) return;

  const ignoreCloseError = () => {};
  const removeIgnoreCloseError = () => {
    socket.removeEventListener('error', ignoreCloseError);
    socket.removeEventListener('close', removeIgnoreCloseError);
  };

  try {
    socket.addEventListener('error', ignoreCloseError);
    socket.addEventListener('close', removeIgnoreCloseError);
    socket.close(code, reason);
    socket.terminate?.();
    if (socket.readyState === CLOSED_READY_STATE) removeIgnoreCloseError();
  } catch {
    removeIgnoreCloseError();
    // Ignore close failures.
  }
}

function refSocket(socket: WebSocketLike): void {
  try {
    (socket as any)._socket?.ref?.();
  } catch {
    // Ref/unref is a Node ws optimization only.
  }
}

function unrefSocket(socket: WebSocketLike): void {
  try {
    (socket as any)._socket?.unref?.();
  } catch {
    // Ref/unref is a Node ws optimization only.
  }
}

function removeKeepalivePongListener(entry: SocketCacheEntry): void {
  if (!entry.keepalivePongListener) return;
  entry.socket.off?.('pong', entry.keepalivePongListener);
  entry.socket.removeListener?.('pong', entry.keepalivePongListener);
  entry.keepalivePongListener = undefined;
}

function clearIdleKeepalive(entry: SocketCacheEntry): void {
  if (entry.keepaliveTimer) {
    clearTimeout(entry.keepaliveTimer);
    entry.keepaliveTimer = undefined;
  }
  if (entry.keepalivePongTimer) {
    clearTimeout(entry.keepalivePongTimer);
    entry.keepalivePongTimer = undefined;
  }
  removeKeepalivePongListener(entry);
}

function removeIdleListeners(entry: SocketCacheEntry): void {
  clearIdleKeepalive(entry);
  if (entry.idleErrorListener) {
    entry.socket.removeEventListener('error', entry.idleErrorListener);
    entry.idleErrorListener = undefined;
  }
  if (entry.idleCloseListener) {
    entry.socket.removeEventListener('close', entry.idleCloseListener);
    entry.idleCloseListener = undefined;
  }
}

function evictIdleSocket(
  key: string,
  entry: SocketCacheEntry,
  settings: OpenAIWebSocketResponsesSettings,
  reason: string,
  closeSocket: boolean,
  event?: any,
): void {
  removeIdleListeners(entry);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  emitSocketClose(entry.onLifecycleEvent, entry.socket, key, reason, event);
  if (closeSocket) closeSilently(entry.socket, 1000, reason);
  if (socketCache.get(key) === entry) socketCache.delete(key);
  writeDebugLog(settings, 'websocket.cache.evict', {
    cacheKeyHash: shortHash(key),
    reason,
    readyState: entry.socket.readyState,
  });
}

function addIdleListeners(
  key: string,
  entry: SocketCacheEntry,
  settings: OpenAIWebSocketResponsesSettings,
): void {
  if (!entry.idleErrorListener) {
    entry.idleErrorListener = (event: any) =>
      evictIdleSocket(key, entry, settings, 'idle_error', true, event);
    entry.socket.addEventListener('error', entry.idleErrorListener);
  }
  if (!entry.idleCloseListener) {
    entry.idleCloseListener = (event: any) =>
      evictIdleSocket(key, entry, settings, 'idle_close', false, event);
    entry.socket.addEventListener('close', entry.idleCloseListener);
  }
}

function canPingSocket(socket: WebSocketLike): boolean {
  return typeof socket.ping === 'function' && typeof socket.on === 'function';
}

function scheduleIdleKeepalive(
  key: string,
  entry: SocketCacheEntry,
  settings: OpenAIWebSocketResponsesSettings,
): void {
  if (entry.busy || socketCache.get(key) !== entry || !canPingSocket(entry.socket)) return;
  if (entry.keepaliveTimer || entry.keepalivePongTimer) return;
  entry.keepaliveTimer = setTimeout(() => {
    entry.keepaliveTimer = undefined;
    sendIdleKeepalivePing(key, entry, settings);
  }, IDLE_SOCKET_KEEPALIVE_INTERVAL_MS);
  entry.keepaliveTimer.unref?.();
}

function sendIdleKeepalivePing(
  key: string,
  entry: SocketCacheEntry,
  settings: OpenAIWebSocketResponsesSettings,
): void {
  if (entry.busy || socketCache.get(key) !== entry) return;
  if (!isReusable(entry.socket)) {
    evictIdleSocket(key, entry, settings, 'idle_ping_stale', true);
    return;
  }

  const onPong = () => {
    if (entry.keepalivePongTimer) {
      clearTimeout(entry.keepalivePongTimer);
      entry.keepalivePongTimer = undefined;
    }
    removeKeepalivePongListener(entry);
    scheduleIdleKeepalive(key, entry, settings);
  };

  entry.keepalivePongListener = onPong;
  entry.socket.on?.('pong', onPong);
  entry.keepalivePongTimer = setTimeout(() => {
    entry.keepalivePongTimer = undefined;
    removeKeepalivePongListener(entry);
    evictIdleSocket(key, entry, settings, 'idle_pong_timeout', true);
  }, IDLE_SOCKET_KEEPALIVE_PONG_TIMEOUT_MS);
  entry.keepalivePongTimer.unref?.();

  try {
    entry.socket.ping?.();
  } catch (error) {
    if (entry.keepalivePongTimer) {
      clearTimeout(entry.keepalivePongTimer);
      entry.keepalivePongTimer = undefined;
    }
    removeKeepalivePongListener(entry);
    evictIdleSocket(key, entry, settings, 'idle_ping_error', true, error);
  }
}

async function getWebSocketConstructor(): Promise<WebSocketConstructorLike> {
  try {
    const mod = await import('ws');
    return (mod.WebSocket ?? mod.default) as WebSocketConstructorLike;
  } catch {
    return globalThis.WebSocket as unknown as WebSocketConstructorLike;
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function extractResponseId(event: Record<string, any>): string | undefined {
  return event.response?.id ?? event.response_id ?? event.id;
}

function isTerminalEvent(type: string | undefined): boolean {
  return (
    type === 'response.completed' ||
    type === 'response.done' ||
    type === 'response.failed' ||
    type === 'response.incomplete' ||
    type === 'response.cancelled'
  );
}

function shouldKeepSocketAfterTerminalEvent(event: Record<string, any>): boolean {
  if (event.type === 'response.completed') return true;
  if (event.type !== 'response.done') return false;
  const status = typeof event.response?.status === 'string' ? event.response.status : undefined;
  return status === undefined || status === 'completed';
}

function decodeImmediateData(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return undefined;
}

function parsePartialWebSocketEvent(text: string): Record<string, any> | undefined {
  try {
    const parsed = parsePartialJson(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, any>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function decodeData(data: unknown): Promise<string> {
  const immediate = decodeImmediateData(data);
  if (immediate !== undefined) return immediate;
  if (data && typeof data === 'object' && 'arrayBuffer' in data) {
    return new TextDecoder().decode(new Uint8Array(await (data as Blob).arrayBuffer()));
  }
  return String(data);
}

async function connectSocket(
  url: string,
  headers: Headers,
  signal: AbortSignal | undefined,
  connectTimeoutMs: number,
  WebSocketCtor?: WebSocketConstructorLike,
): Promise<WebSocketLike> {
  const Ctor = WebSocketCtor ?? (await getWebSocketConstructor());
  return new Promise((resolve, reject) => {
    const socket = new Ctor(url, { headers: headersToRecord(headers) });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      socket.off?.('unexpected-response', onUnexpectedResponse);
      socket.removeListener?.('unexpected-response', onUnexpectedResponse);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error, reason?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (reason) closeSilently(socket, 1000, reason);
      reject(error);
    };
    const onOpen = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onError = (event: any) =>
      fail(new Error(event?.message || event?.error?.message || 'WebSocket error'));
    const onClose = (event: any) =>
      fail(new Error(`WebSocket closed${event?.code ? ` ${event.code}` : ''}`));
    const onAbort = () => fail(new Error('Request was aborted'), 'aborted');
    const onUnexpectedResponse = (_request: unknown, response: any) => {
      void readNodeResponseBody(response).then((bodyText) => {
        fail(
          new WebSocketUpgradeResponseError({
            status: response?.statusCode,
            headers: response?.headers,
            bodyText,
            bodyJson: parseJsonBody(bodyText),
          }),
        );
      });
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
    socket.on?.('unexpected-response', onUnexpectedResponse);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (connectTimeoutMs > 0) {
      timeout = setTimeout(
        () =>
          fail(
            new Error(`WebSocket connect timeout after ${connectTimeoutMs}ms`),
            'connect_timeout',
          ),
        connectTimeoutMs,
      );
    }
    if (signal?.aborted) onAbort();
  });
}

function traceDiagnosticFields(
  traceContext: TraceContext | undefined,
): Record<string, string | undefined> {
  return {
    traceparent: traceContext?.traceparent,
    traceId: traceContext?.traceId,
    spanId: traceContext?.spanId,
  };
}

async function tracedConnectSocket(
  request: {
    url: string;
    headers: Headers;
    signal?: AbortSignal;
    connectTimeoutMs: number;
    WebSocketCtor?: WebSocketConstructorLike;
    diagnostics?: TransportDiagnosticsCollector;
  },
  traceContext: TraceContext | undefined,
): Promise<WebSocketLike> {
  try {
    return await connectSocket(
      request.url,
      cloneHeadersWithTraceparent(request.headers, traceContext),
      request.signal,
      request.connectTimeoutMs,
      request.WebSocketCtor,
    );
  } catch (error) {
    request.diagnostics?.record('ws_connect_error', {
      message: error instanceof Error ? error.message : String(error),
      ...failureDiagnosticFields(error),
      ...traceDiagnosticFields(traceContext),
    });
    request.diagnostics?.set(failureDiagnosticFields(error));
    throw error;
  }
}

async function acquireSocket(request: {
  url: string;
  headers: Headers;
  signal?: AbortSignal;
  settings: OpenAIWebSocketResponsesSettings;
  connectTimeoutMs: number;
  cacheKey?: string;
  WebSocketCtor?: WebSocketConstructorLike;
  onLifecycleEvent?: WebSocketLifecycleObserver;
  enableIdleKeepalive?: boolean;
  trace?: WebSocketTraceOptions;
  diagnostics?: TransportDiagnosticsCollector;
}): Promise<{
  socket: WebSocketLike;
  connection: WebSocketConnectionMetadata;
  release(keep: boolean): void;
}> {
  if (!request.cacheKey) {
    const traceContext = request.trace?.nextSpan();
    writeDebugLog(request.settings, 'websocket.cache.disabled', {
      logicalTraceId: request.trace?.logicalTraceId,
      traceparent: traceContext?.traceparent,
      traceId: traceContext?.traceId,
      spanId: traceContext?.spanId,
    });
    const socket = await tracedConnectSocket(request, traceContext);
    emitSocketOpen(
      request.onLifecycleEvent,
      socket,
      'disabled',
      undefined,
      request.url,
      traceContext,
    );
    return {
      socket,
      connection: getSocketConnectionMetadata(socket, 'disabled', undefined, traceContext),
      release: () => {
        emitSocketClose(request.onLifecycleEvent, socket, undefined, 'done');
        closeSilently(socket);
      },
    };
  }
  const cached = socketCache.get(request.cacheKey);
  if (cached?.idleTimer) {
    clearTimeout(cached.idleTimer);
    cached.idleTimer = undefined;
  }
  if (cached?.busy) {
    const traceContext = request.trace?.nextSpan();
    writeDebugLog(request.settings, 'websocket.cache.busy', {
      cacheKeyHash: shortHash(request.cacheKey),
      logicalTraceId: request.trace?.logicalTraceId,
      traceparent: traceContext?.traceparent,
      traceId: traceContext?.traceId,
      spanId: traceContext?.spanId,
    });
    const socket = await tracedConnectSocket(request, traceContext);
    emitSocketOpen(
      request.onLifecycleEvent,
      socket,
      'busy',
      request.cacheKey,
      request.url,
      traceContext,
    );
    return {
      socket,
      connection: getSocketConnectionMetadata(socket, 'busy', request.cacheKey, traceContext),
      release: () => {
        emitSocketClose(request.onLifecycleEvent, socket, request.cacheKey, 'done');
        closeSilently(socket);
      },
    };
  }
  if (cached && isReusable(cached.socket)) {
    writeDebugLog(request.settings, 'websocket.cache.hit', {
      cacheKeyHash: shortHash(request.cacheKey),
      readyState: cached.socket.readyState,
      logicalTraceId: request.trace?.logicalTraceId,
      connectionTraceparent: cached.traceContext?.traceparent,
      connectionTraceId: cached.traceContext?.traceId,
      connectionSpanId: cached.traceContext?.spanId,
    });
    cached.busy = true;
    cached.onLifecycleEvent = request.onLifecycleEvent;
    removeIdleListeners(cached);
    refSocket(cached.socket);
    return {
      socket: cached.socket,
      connection: getSocketConnectionMetadata(
        cached.socket,
        'hit',
        request.cacheKey,
        cached.traceContext,
      ),
      release: (keep) =>
        releaseCached(
          request.cacheKey!,
          cached,
          keep,
          request.settings,
          request.enableIdleKeepalive ?? false,
        ),
    };
  }
  if (cached) {
    writeDebugLog(request.settings, 'websocket.cache.stale', {
      cacheKeyHash: shortHash(request.cacheKey),
      readyState: cached.socket.readyState,
    });
    removeIdleListeners(cached);
    emitSocketClose(cached.onLifecycleEvent, cached.socket, request.cacheKey, 'stale_cache');
    closeSilently(cached.socket);
    socketCache.delete(request.cacheKey);
  }
  const traceContext = request.trace?.nextSpan();
  writeDebugLog(request.settings, 'websocket.cache.miss', {
    cacheKeyHash: shortHash(request.cacheKey),
    logicalTraceId: request.trace?.logicalTraceId,
    traceparent: traceContext?.traceparent,
    traceId: traceContext?.traceId,
    spanId: traceContext?.spanId,
  });
  const socket = await tracedConnectSocket(request, traceContext);
  const cacheStatus = cached ? 'stale' : 'miss';
  emitSocketOpen(
    request.onLifecycleEvent,
    socket,
    cacheStatus,
    request.cacheKey,
    request.url,
    traceContext,
  );
  const entry: SocketCacheEntry = {
    socket,
    busy: true,
    onLifecycleEvent: request.onLifecycleEvent,
    traceContext,
  };
  socketCache.set(request.cacheKey, entry);
  return {
    socket,
    connection: getSocketConnectionMetadata(socket, cacheStatus, request.cacheKey, traceContext),
    release: (keep) =>
      releaseCached(
        request.cacheKey!,
        entry,
        keep,
        request.settings,
        request.enableIdleKeepalive ?? false,
      ),
  };
}

function releaseCached(
  key: string,
  entry: SocketCacheEntry,
  keep: boolean,
  settings: OpenAIWebSocketResponsesSettings,
  enableIdleKeepalive: boolean,
): void {
  if (!keep || !isReusable(entry.socket)) {
    removeIdleListeners(entry);
    emitSocketClose(entry.onLifecycleEvent, entry.socket, key, 'done');
    closeSilently(entry.socket);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (socketCache.get(key) === entry) socketCache.delete(key);
    return;
  }
  entry.busy = false;
  addIdleListeners(key, entry, settings);
  unrefSocket(entry.socket);
  entry.idleTimer = setTimeout(() => {
    if (entry.busy) return;
    evictIdleSocket(key, entry, settings, 'idle_timeout', true);
  }, IDLE_SOCKET_CACHE_TTL_MS);
  if (enableIdleKeepalive) scheduleIdleKeepalive(key, entry, settings);
  entry.idleTimer.unref?.();
}

export async function runWebSocketResponse(
  request: {
    url: string;
    headers: Headers;
    body: ResponsesBody;
    fallbackBodyOnPreviousResponseNotFound?: ResponsesBody;
    settings: OpenAIWebSocketResponsesSettings;
    signal?: AbortSignal;
    cacheKey?: string;
    WebSocketCtor?: WebSocketConstructorLike;
    onLifecycleEvent?: WebSocketLifecycleObserver;
    enableIdleKeepalive?: boolean;
    diagnostics?: TransportDiagnosticsCollector;
    trace?: WebSocketTraceOptions;
    attemptMode?: 'full_replay';
    fetch?: FetchLike;
  },
  onEvent: (
    event: Record<string, any>,
    connection: WebSocketConnectionMetadata,
  ) => Promise<void> | void,
): Promise<WebSocketRunResult> {
  let lastError: unknown;
  let retriedEmptyResponseFailure = false;
  if (request.trace?.logicalTraceId)
    request.diagnostics?.set({ logicalTraceId: request.trace.logicalTraceId });
  for (let attempt = 0; attempt <= request.settings.websocket.retries; attempt++) {
    const currentAttemptMode =
      request.attemptMode ??
      (typeof request.body.previous_response_id === 'string'
        ? retriedEmptyResponseFailure
          ? 'retry_delta'
          : 'delta'
        : 'full_context');
    request.diagnostics?.set({ attempts: attempt + 1 });
    request.diagnostics?.record(
      'ws_attempt_start',
      {
        attempt,
        mode: currentAttemptMode,
        hasPreviousResponseId: typeof request.body.previous_response_id === 'string',
        inputItems: request.body.input?.length ?? 0,
      },
      { significant: false },
    );
    let responseId: string | undefined;
    let eventCount = 0;
    let replayUnsafeEventSeen = false;
    let firstReplayUnsafeEventType: string | undefined;
    let acquired: Awaited<ReturnType<typeof acquireSocket>> | undefined;
    let keepSocket = true;
    try {
      writeDebugLog(request.settings, 'websocket.response.create', {
        attempt,
        cacheKeyHash: shortHash(request.cacheKey),
        hasPreviousResponseId: typeof request.body.previous_response_id === 'string',
        inputItems: request.body.input?.length ?? 0,
        hasFallbackBody: !!request.fallbackBodyOnPreviousResponseNotFound,
      });
      acquired = await acquireSocket({
        url: request.url,
        headers: request.headers,
        signal: request.signal,
        settings: request.settings,
        connectTimeoutMs: request.settings.websocket.connectTimeoutMs,
        cacheKey: request.cacheKey,
        WebSocketCtor: request.WebSocketCtor,
        onLifecycleEvent: request.onLifecycleEvent,
        enableIdleKeepalive: request.enableIdleKeepalive,
        trace: request.trace,
        diagnostics: request.diagnostics,
      });
      request.diagnostics?.record(
        'ws_acquire',
        { attempt, mode: currentAttemptMode, ...acquired.connection },
        { significant: false },
      );
      if (acquired.connection.cacheStatus === 'stale') {
        request.diagnostics?.record('ws_cache_stale', { attempt, ...acquired.connection });
      }
      const socket = acquired.socket;
      await new Promise<void>((resolve, reject) => {
        let terminal = false;
        let settled = false;
        let streamCommitted = false;
        let pendingReplaySafeEvents: Record<string, any>[] = [];
        let processing = Promise.resolve();
        let firstEventTimer: ReturnType<typeof setTimeout> | undefined;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (firstEventTimer) clearTimeout(firstEventTimer);
          if (idleTimer) clearTimeout(idleTimer);
          socket.removeEventListener('message', onMessage);
          socket.removeEventListener('error', onError);
          socket.removeEventListener('close', onClose);
          request.signal?.removeEventListener('abort', onAbort);
        };
        const resolveAfterProcessing = () => {
          if (settled) return;
          settled = true;
          cleanup();
          void processing.then(resolve, reject);
        };
        const rejectNow = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const queueEventForProcessing = (event: Record<string, any>, terminalEvent: boolean) => {
          processing = processing.then(async () => {
            await onEvent(event, acquired!.connection);
            if (terminalEvent) resolveAfterProcessing();
          });
          void processing.catch(rejectNow);
        };
        const commitAndQueueEvent = (event: Record<string, any>, terminalEvent: boolean) => {
          const eventsToDeliver = streamCommitted ? [event] : [...pendingReplaySafeEvents, event];
          pendingReplaySafeEvents = [];
          streamCommitted = true;
          for (const item of eventsToDeliver) {
            queueEventForProcessing(item, terminalEvent && item === event);
          }
        };
        const armFirstEventTimer = () => {
          if (firstEventTimer) clearTimeout(firstEventTimer);
          if (request.settings.websocket.firstEventTimeoutMs > 0) {
            firstEventTimer = setTimeout(
              () =>
                rejectNow(
                  new Error(
                    `WebSocket first-event timeout after ${request.settings.websocket.firstEventTimeoutMs}ms`,
                  ),
                ),
              request.settings.websocket.firstEventTimeoutMs,
            );
          }
        };
        const clearFirstEventTimer = () => {
          if (!firstEventTimer) return;
          clearTimeout(firstEventTimer);
          firstEventTimer = undefined;
        };
        const armIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer);
          if (request.settings.websocket.idleTimeoutMs > 0) {
            idleTimer = setTimeout(
              () =>
                rejectNow(
                  new Error(
                    `WebSocket idle timeout after ${request.settings.websocket.idleTimeoutMs}ms`,
                  ),
                ),
              request.settings.websocket.idleTimeoutMs,
            );
          }
        };
        const noteEventMetadata = (
          parsed: Record<string, any>,
          options: { partial?: boolean } = {},
        ): { replayUnsafeEvent: boolean; terminalEvent: boolean } => {
          const previousResponseError = options.partial
            ? undefined
            : previousResponseNotFoundMessage(parsed);
          if (previousResponseError) throw new PreviousResponseNotFoundError(previousResponseError);
          if (eventCount === 0) {
            clearFirstEventTimer();
            request.diagnostics?.record(
              'first_event',
              { attempt, eventType: parsed.type, partial: options.partial ? true : undefined },
              { significant: false },
            );
          }
          eventCount++;
          const nextResponseId = extractResponseId(parsed);
          if (nextResponseId && nextResponseId !== responseId) {
            responseId = nextResponseId;
            request.diagnostics?.set({ websocketResponseId: responseId, responseIdSeen: true });
            request.diagnostics?.record(
              parsed.type === 'response.created' ? 'response_created' : 'response_id',
              { attempt, responseId, eventCount, eventType: parsed.type },
              { significant: false },
            );
          } else {
            responseId = nextResponseId ?? responseId;
          }
          if (!options.partial && responseId && isRetryableResponsesErrorFrame(parsed)) {
            throw new RetryableResponseError(responsesErrorFrameMessage(parsed));
          }
          if (!options.partial && parsed.type === 'error') {
            const status = typeof parsed.status === 'number' ? parsed.status : parsed.error?.status;
            const classification = classifyOpenAIResponsesFailure({ status, event: parsed });
            if (classification?.retryable === false) {
              throw new TerminalResponseErrorFrame(responsesErrorFrameMessage(parsed), parsed);
            }
          }
          const replayUnsafeEvent = isReplayUnsafeResponsesEvent(parsed);
          if (replayUnsafeEvent && !replayUnsafeEventSeen) {
            replayUnsafeEventSeen = true;
            firstReplayUnsafeEventType = parsed.type;
            request.diagnostics?.set({ replayUnsafeEventSeen, firstReplayUnsafeEventType });
            request.diagnostics?.record(
              'response_output_started',
              { attempt, responseId, eventCount, eventType: parsed.type },
              { significant: false },
            );
          }
          if (options.partial) {
            request.diagnostics?.record(
              'partial_json_event',
              { attempt, responseId, eventCount, eventType: parsed.type },
              { significant: false },
            );
            return { replayUnsafeEvent, terminalEvent: false };
          }
          const terminalEvent = isTerminalEvent(parsed.type) || parsed.type === 'error';
          if (terminalEvent) {
            terminal = true;
            if (!shouldKeepSocketAfterTerminalEvent(parsed)) keepSocket = false;
            request.diagnostics?.record(
              parsed.type === 'response.completed' ? 'response_completed' : 'response_terminal',
              { attempt, responseId, eventCount, eventType: parsed.type },
              { significant: parsed.type !== 'response.completed' },
            );
          }
          return { replayUnsafeEvent, terminalEvent };
        };
        const handleInvalidJsonMessage = (text: string, error: unknown) => {
          const partialEvent = parsePartialWebSocketEvent(text);
          if (partialEvent) noteEventMetadata(partialEvent, { partial: true });
          throw error;
        };
        const handleParsedMessage = (parsed: Record<string, any>) => {
          const { replayUnsafeEvent, terminalEvent } = noteEventMetadata(parsed);
          if (!streamCommitted && !replayUnsafeEvent && !terminalEvent) {
            pendingReplaySafeEvents.push(parsed);
            return;
          }
          commitAndQueueEvent(parsed, terminalEvent);
        };
        const onMessage = (messageEvent: MessageEvent) => {
          try {
            armIdleTimer();
            const immediate = decodeImmediateData(messageEvent.data);
            if (immediate !== undefined) {
              try {
                handleParsedMessage(JSON.parse(immediate) as Record<string, any>);
              } catch (error) {
                handleInvalidJsonMessage(immediate, error);
              }
              return;
            }
            void (async () => {
              try {
                const text = await decodeData(messageEvent.data);
                try {
                  handleParsedMessage(JSON.parse(text) as Record<string, any>);
                } catch (error) {
                  handleInvalidJsonMessage(text, error);
                }
              } catch (error) {
                rejectNow(error);
              }
            })();
          } catch (error) {
            rejectNow(error);
          }
        };
        let pendingError: Error | undefined;
        const fail = (error: Error, options: { defer?: boolean } = {}) => {
          if (terminal) {
            resolveAfterProcessing();
            return;
          }
          const rejectError = responseId
            ? new WebSocketMidstreamError(error.message, responseId, error)
            : error;
          if (!options.defer) {
            pendingError = undefined;
            rejectNow(rejectError);
            return;
          }
          pendingError ??= error;
          queueMicrotask(() => {
            if (!pendingError) return;
            const nextError = pendingError;
            pendingError = undefined;
            rejectNow(
              responseId
                ? new WebSocketMidstreamError(nextError.message, responseId, nextError)
                : nextError,
            );
          });
        };
        const onError = (event: any) => {
          request.diagnostics?.record(
            'ws_error',
            {
              attempt,
              connectionId: acquired?.connection.connectionId,
              eventCount,
              message: event?.message || event?.error?.message || 'WebSocket error',
              responseId,
            },
            { significant: !terminal },
          );
          fail(new Error(event?.message || event?.error?.message || 'WebSocket error'), {
            defer: true,
          });
        };
        const onClose = (event: any) => {
          keepSocket = false;
          emitSocketClose(
            request.onLifecycleEvent,
            socket,
            request.cacheKey,
            'active_close',
            event,
          );
          request.diagnostics?.record(
            'ws_close',
            {
              attempt,
              code: typeof event?.code === 'number' ? event.code : undefined,
              connectionId: acquired?.connection.connectionId,
              eventCount,
              phase: terminal
                ? 'after_terminal_event'
                : responseId
                  ? 'after_response_id'
                  : eventCount > 0
                    ? 'after_response_event'
                    : 'before_response_event',
              reason: typeof event?.reason === 'string' ? event.reason : undefined,
              responseId,
            },
            { significant: !terminal },
          );
          fail(
            pendingError ??
              new Error(
                `WebSocket closed before response.completed${event?.code ? ` code=${event.code}` : ''}${event?.reason ? ` reason=${event.reason}` : ''}`,
              ),
          );
        };
        const onAbort = () => {
          keepSocket = false;
          rejectNow(new Error('Request was aborted'));
        };
        socket.addEventListener('message', onMessage as any);
        socket.addEventListener('error', onError);
        socket.addEventListener('close', onClose);
        request.signal?.addEventListener('abort', onAbort, { once: true });
        if (request.signal?.aborted) {
          onAbort();
          return;
        }
        armFirstEventTimer();
        armIdleTimer();
        try {
          const payload = responseCreatePayload(request.body);
          request.diagnostics?.set({ requestBytes: payloadBytes(payload) });
          socket.send(payload);
        } catch (error) {
          request.diagnostics?.record('ws_send_error', {
            attempt,
            connectionId: acquired?.connection.connectionId,
            message: error instanceof Error ? error.message : String(error),
          });
          rejectNow(error);
        }
      });
      acquired.release(keepSocket);
      request.diagnostics?.set({
        eventCount,
        replayUnsafeEventSeen,
        firstReplayUnsafeEventType,
        responseIdSeen: !!responseId,
        websocketResponseId: responseId,
      });
      writeDebugLog(request.settings, 'websocket.response.done', {
        cacheKeyHash: shortHash(request.cacheKey),
        responseId,
        eventCount,
        keepSocket,
      });
      if (retriedEmptyResponseFailure) {
        emitLifecycle(request.onLifecycleEvent, {
          type: 'recovered',
          mode: 'resumed',
          connectionId: acquired.connection.connectionId,
          cacheKeyHash: acquired.connection.cacheKeyHash,
          urlHash: shortHash(request.url) ?? '',
          responseId,
        });
      }
      return { responseId, eventCount, connection: acquired.connection };
    } catch (error) {
      keepSocket = false;
      acquired?.release(false);
      lastError = error;
      request.diagnostics?.set(failureDiagnosticFields(error));
      if (error instanceof WebSocketUpgradeResponseError) {
        await probeEmptyUpgrade500Classification(request, error);
        request.diagnostics?.set(failureDiagnosticFields(error));
      }
      if (
        error instanceof PreviousResponseNotFoundError &&
        request.fallbackBodyOnPreviousResponseNotFound
      ) {
        const previousResponseId =
          typeof request.body.previous_response_id === 'string'
            ? request.body.previous_response_id
            : undefined;
        request.diagnostics?.record('previous_response_not_found_fallback', {
          attempt,
          action: 'replay_full_conversation_without_previous_response_id',
          previousResponseId,
          fallbackInputItems: request.fallbackBodyOnPreviousResponseNotFound.input?.length ?? 0,
        });
        emitLifecycle(request.onLifecycleEvent, {
          type: 'fallback',
          reason: 'previous_response_not_found',
          action: 'replay_full_conversation_without_previous_response_id',
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          maxAttempts: attempt + 2,
          urlHash: shortHash(request.url) ?? '',
          connectionId: acquired?.connection.connectionId,
          cacheKeyHash: request.cacheKey ? shortHash(request.cacheKey) : undefined,
          previousResponseId,
        });
        writeDebugLog(request.settings, 'websocket.previous_response_not_found.fallback', {
          cacheKeyHash: shortHash(request.cacheKey),
          message: error.message,
          fallbackInputItems: request.fallbackBodyOnPreviousResponseNotFound.input?.length ?? 0,
        });
        const result = await runWebSocketResponse(
          {
            ...request,
            body: request.fallbackBodyOnPreviousResponseNotFound,
            fallbackBodyOnPreviousResponseNotFound: undefined,
            attemptMode: 'full_replay',
          },
          onEvent,
        );
        emitLifecycle(request.onLifecycleEvent, {
          type: 'recovered',
          mode: 'full_replay',
          connectionId: result.connection?.connectionId,
          cacheKeyHash: result.connection?.cacheKeyHash,
          urlHash: shortHash(request.url) ?? '',
          responseId: result.responseId,
        });
        return { ...result, fallbackUsed: true, fallbackReason: 'previous_response_not_found' };
      }
      if (
        !acquired &&
        !(error instanceof PreviousResponseNotFoundError) &&
        !request.diagnostics?.hasEvent('ws_connect_error')
      ) {
        request.diagnostics?.record('ws_connect_error', {
          attempt,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      request.diagnostics?.set({
        eventCount,
        replayUnsafeEventSeen,
        firstReplayUnsafeEventType,
        responseIdSeen: !!responseId,
        websocketResponseId: responseId,
      });
      const retryBeforeOutputResponseId =
        error instanceof WebSocketMidstreamError ? error.responseId : responseId;
      if (
        (error instanceof WebSocketMidstreamError || error instanceof RetryableResponseError) &&
        shouldRetryResponsesTransportErrorBeforeOutput({
          attempt,
          maxRetries: request.settings.websocket.retries,
          responseId: retryBeforeOutputResponseId,
          replayUnsafeEventSeen,
          aborted: request.signal?.aborted,
        })
      ) {
        request.diagnostics?.record('ws_retry', {
          attempt: attempt + 1,
          previousAttempt: attempt,
          reason: 'midstream_error_before_output',
          action: 'retry_fresh_websocket_before_output',
          eventCount,
          responseId: retryBeforeOutputResponseId,
        });
        emitLifecycle(request.onLifecycleEvent, {
          type: 'retry',
          reason: 'midstream_error_before_output',
          action: 'retry_fresh_websocket_before_output',
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          maxAttempts: request.settings.websocket.retries + 1,
          urlHash: shortHash(request.url) ?? '',
          connectionId: acquired?.connection.connectionId,
          cacheKeyHash: request.cacheKey ? shortHash(request.cacheKey) : undefined,
          responseId: retryBeforeOutputResponseId,
        });
        writeDebugLog(request.settings, 'websocket.before_output.retry', {
          attempt,
          nextAttempt: attempt + 1,
          cacheKeyHash: shortHash(request.cacheKey),
          responseId: retryBeforeOutputResponseId,
          eventCount,
        });
        continue;
      }
      if (error instanceof RetryableResponseError && responseId) {
        request.diagnostics?.record('transport_error', {
          attempt,
          eventCount,
          message: error.message,
          responseId,
        });
        throw new WebSocketMidstreamError(error.message, responseId, error);
      }
      const previousResponseId = request.body.previous_response_id;
      if (
        isRetryableEmptyResponseFailure(error) &&
        !retriedEmptyResponseFailure &&
        eventCount <= 2 &&
        typeof previousResponseId === 'string' &&
        attempt < request.settings.websocket.retries &&
        !request.signal?.aborted
      ) {
        retriedEmptyResponseFailure = true;
        const retryResponseId = error.responseId ?? responseId;
        request.diagnostics?.set({
          recoveryPath: 'delta_retry',
          recoveryAttemptCount: 2,
        });
        request.diagnostics?.record('ws_retry', {
          attempt: attempt + 1,
          previousAttempt: attempt,
          reason: 'empty_response_failed_without_details',
          action: 'retry_fresh_websocket_same_previous_response_id',
          eventCount,
          responseId: retryResponseId,
          previousResponseId,
        });
        emitLifecycle(request.onLifecycleEvent, {
          type: 'retry',
          reason: 'empty_response_failed_without_details',
          action: 'retry_fresh_websocket_same_previous_response_id',
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          maxAttempts: request.fallbackBodyOnPreviousResponseNotFound ? 3 : 2,
          urlHash: shortHash(request.url) ?? '',
          connectionId: acquired?.connection.connectionId,
          cacheKeyHash: request.cacheKey ? shortHash(request.cacheKey) : undefined,
          responseId: retryResponseId,
          previousResponseId,
        });
        writeDebugLog(request.settings, 'websocket.response_failed.retry', {
          attempt,
          nextAttempt: attempt + 1,
          cacheKeyHash: shortHash(request.cacheKey),
          responseId: retryResponseId,
          previousResponseId,
        });
        continue;
      }
      if (
        isRetryableEmptyResponseFailure(error) &&
        retriedEmptyResponseFailure &&
        eventCount <= 2 &&
        request.fallbackBodyOnPreviousResponseNotFound &&
        !request.signal?.aborted
      ) {
        const retryResponseId = error.responseId ?? responseId;
        const previousResponseId =
          typeof request.body.previous_response_id === 'string'
            ? request.body.previous_response_id
            : undefined;
        request.diagnostics?.set({
          recoveryPath: 'delta_retry_full_replay',
          recoveryAttemptCount: 3,
        });
        request.diagnostics?.record('empty_response_failed_full_fallback', {
          attempt,
          action: 'replay_full_conversation_without_previous_response_id',
          eventCount,
          responseId: retryResponseId,
          previousResponseId,
          fallbackInputItems: request.fallbackBodyOnPreviousResponseNotFound.input?.length ?? 0,
        });
        emitLifecycle(request.onLifecycleEvent, {
          type: 'fallback',
          reason: 'empty_response_failed_without_details',
          action: 'replay_full_conversation_without_previous_response_id',
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          maxAttempts: 3,
          urlHash: shortHash(request.url) ?? '',
          connectionId: acquired?.connection.connectionId,
          cacheKeyHash: request.cacheKey ? shortHash(request.cacheKey) : undefined,
          responseId: retryResponseId,
          previousResponseId,
        });
        writeDebugLog(request.settings, 'websocket.response_failed.full_fallback', {
          attempt,
          cacheKeyHash: shortHash(request.cacheKey),
          responseId: retryResponseId,
          previousResponseId,
          fallbackInputItems: request.fallbackBodyOnPreviousResponseNotFound.input?.length ?? 0,
        });
        const result = await runWebSocketResponse(
          {
            ...request,
            body: request.fallbackBodyOnPreviousResponseNotFound,
            fallbackBodyOnPreviousResponseNotFound: undefined,
            attemptMode: 'full_replay',
          },
          onEvent,
        );
        emitLifecycle(request.onLifecycleEvent, {
          type: 'recovered',
          mode: 'full_replay',
          connectionId: result.connection?.connectionId,
          cacheKeyHash: result.connection?.cacheKeyHash,
          urlHash: shortHash(request.url) ?? '',
          responseId: result.responseId,
        });
        return {
          ...result,
          fallbackUsed: true,
          fallbackReason: 'empty_response_failed_without_details',
        };
      }
      if (error instanceof WebSocketMidstreamError) {
        request.diagnostics?.record('transport_error', {
          attempt,
          eventCount,
          message: error.message,
          responseId: error.responseId,
        });
        throw error;
      }
      const willRetry =
        eventCount === 0 &&
        !responseId &&
        attempt < request.settings.websocket.retries &&
        !isTerminalProviderFailure(error) &&
        !request.signal?.aborted;
      writeDebugLog(request.settings, 'websocket.response.error', {
        attempt,
        cacheKeyHash: shortHash(request.cacheKey),
        responseId,
        eventCount,
        message: error instanceof Error ? error.message : String(error),
        willRetry,
      });
      if (willRetry) {
        request.diagnostics?.record('ws_retry', {
          attempt: attempt + 1,
          previousAttempt: attempt,
          reason: 'no_response_events_or_response_id',
        });
      }
      if (
        eventCount > 0 ||
        responseId ||
        attempt >= request.settings.websocket.retries ||
        isTerminalProviderFailure(error)
      ) {
        request.diagnostics?.record('transport_error', {
          attempt,
          eventCount,
          message: error instanceof Error ? error.message : String(error),
          responseId,
          ...failureDiagnosticFields(error),
        });
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function closeAllCachedWebSockets(): void {
  for (const entry of socketCache.values()) {
    removeIdleListeners(entry);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    emitSocketClose(entry.onLifecycleEvent, entry.socket, undefined, 'shutdown');
    closeSilently(entry.socket, 1000, 'shutdown');
  }
  socketCache.clear();
}
