import { shortHash, writeDebugLog } from './debug.ts';
import type { OpenAIWebSocketResponsesSettings } from './settings.ts';
import type { ResponsesBody } from './body.ts';

interface WebSocketLike {
  readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  on?(event: string, listener: (...args: any[]) => void): void;
}

interface WebSocketConstructorLike {
  new (url: string, options?: { headers?: Record<string, string> }): WebSocketLike;
}

interface SocketCacheEntry {
  socket: WebSocketLike;
  busy: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleCloseListener?: (event: any) => void;
  idleErrorListener?: (event: any) => void;
  onLifecycleEvent?: WebSocketLifecycleObserver;
}

const IDLE_SOCKET_CACHE_TTL_MS = 15 * 60 * 1000;
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

export interface WebSocketRunResult {
  responseId?: string;
  eventCount: number;
  fallbackUsed?: boolean;
}

export type WebSocketCacheStatus = 'disabled' | 'miss' | 'hit' | 'busy' | 'stale';

export interface WebSocketConnectionMetadata {
  connectionId: string;
  cacheStatus: WebSocketCacheStatus;
  cacheKeyHash?: string;
  localPort?: number;
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
    };

export type WebSocketLifecycleObserver = (event: WebSocketLifecycleEvent) => void;

class PreviousResponseNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreviousResponseNotFoundError';
  }
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
): WebSocketConnectionMetadata {
  return {
    connectionId: getSocketId(socket),
    cacheStatus,
    cacheKeyHash: shortHash(cacheKey),
    localPort: getSocketLocalPort(socket),
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
): void {
  openedSockets.add(socket);
  emitLifecycle(onLifecycleEvent, {
    type: 'open',
    ...getSocketConnectionMetadata(socket, cacheStatus, cacheKey),
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

function removeIdleListeners(entry: SocketCacheEntry): void {
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

function previousResponseNotFoundMessage(event: Record<string, any>): string | undefined {
  const error = event.error ?? {};
  if (event.type !== 'error' || error.code !== 'previous_response_not_found') return undefined;
  return typeof error.message === 'string' ? error.message : JSON.stringify(event);
}

function decodeImmediateData(data: unknown): string | undefined {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return undefined;
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
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
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

async function acquireSocket(request: {
  url: string;
  headers: Headers;
  signal?: AbortSignal;
  settings: OpenAIWebSocketResponsesSettings;
  connectTimeoutMs: number;
  cacheKey?: string;
  WebSocketCtor?: WebSocketConstructorLike;
  onLifecycleEvent?: WebSocketLifecycleObserver;
}): Promise<{
  socket: WebSocketLike;
  connection: WebSocketConnectionMetadata;
  release(keep: boolean): void;
}> {
  if (!request.cacheKey) {
    writeDebugLog(request.settings, 'websocket.cache.disabled');
    const socket = await connectSocket(
      request.url,
      request.headers,
      request.signal,
      request.connectTimeoutMs,
      request.WebSocketCtor,
    );
    emitSocketOpen(request.onLifecycleEvent, socket, 'disabled', undefined, request.url);
    return {
      socket,
      connection: getSocketConnectionMetadata(socket, 'disabled', undefined),
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
    writeDebugLog(request.settings, 'websocket.cache.busy', {
      cacheKeyHash: shortHash(request.cacheKey),
    });
    const socket = await connectSocket(
      request.url,
      request.headers,
      request.signal,
      request.connectTimeoutMs,
      request.WebSocketCtor,
    );
    emitSocketOpen(request.onLifecycleEvent, socket, 'busy', request.cacheKey, request.url);
    return {
      socket,
      connection: getSocketConnectionMetadata(socket, 'busy', request.cacheKey),
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
    });
    cached.busy = true;
    cached.onLifecycleEvent = request.onLifecycleEvent;
    removeIdleListeners(cached);
    refSocket(cached.socket);
    return {
      socket: cached.socket,
      connection: getSocketConnectionMetadata(cached.socket, 'hit', request.cacheKey),
      release: (keep) => releaseCached(request.cacheKey!, cached, keep, request.settings),
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
  writeDebugLog(request.settings, 'websocket.cache.miss', {
    cacheKeyHash: shortHash(request.cacheKey),
  });
  const socket = await connectSocket(
    request.url,
    request.headers,
    request.signal,
    request.connectTimeoutMs,
    request.WebSocketCtor,
  );
  const cacheStatus = cached ? 'stale' : 'miss';
  emitSocketOpen(request.onLifecycleEvent, socket, cacheStatus, request.cacheKey, request.url);
  const entry: SocketCacheEntry = {
    socket,
    busy: true,
    onLifecycleEvent: request.onLifecycleEvent,
  };
  socketCache.set(request.cacheKey, entry);
  return {
    socket,
    connection: getSocketConnectionMetadata(socket, cacheStatus, request.cacheKey),
    release: (keep) => releaseCached(request.cacheKey!, entry, keep, request.settings),
  };
}

function releaseCached(
  key: string,
  entry: SocketCacheEntry,
  keep: boolean,
  settings: OpenAIWebSocketResponsesSettings,
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
  },
  onEvent: (
    event: Record<string, any>,
    connection: WebSocketConnectionMetadata,
  ) => Promise<void> | void,
): Promise<WebSocketRunResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= request.settings.websocket.retries; attempt++) {
    let responseId: string | undefined;
    let eventCount = 0;
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
      });
      const socket = acquired.socket;
      socket.send(JSON.stringify({ type: 'response.create', ...request.body }));
      await new Promise<void>((resolve, reject) => {
        let terminal = false;
        let settled = false;
        let processing = Promise.resolve();
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
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
        const handleParsedMessage = (parsed: Record<string, any>) => {
          const previousResponseError = previousResponseNotFoundMessage(parsed);
          if (previousResponseError) throw new PreviousResponseNotFoundError(previousResponseError);
          eventCount++;
          responseId = extractResponseId(parsed) ?? responseId;
          const terminalEvent = isTerminalEvent(parsed.type);
          if (terminalEvent) terminal = true;
          processing = processing.then(async () => {
            await onEvent(parsed, acquired!.connection);
            if (terminalEvent) resolveAfterProcessing();
          });
          void processing.catch(rejectNow);
        };
        const onMessage = (messageEvent: MessageEvent) => {
          try {
            armIdleTimer();
            const immediate = decodeImmediateData(messageEvent.data);
            if (immediate !== undefined) {
              handleParsedMessage(JSON.parse(immediate) as Record<string, any>);
              return;
            }
            void (async () => {
              try {
                handleParsedMessage(
                  JSON.parse(await decodeData(messageEvent.data)) as Record<string, any>,
                );
              } catch (error) {
                rejectNow(error);
              }
            })();
          } catch (error) {
            rejectNow(error);
          }
        };
        const fail = (error: Error) => {
          if (terminal) {
            resolveAfterProcessing();
            return;
          }
          rejectNow(
            responseId ? new WebSocketMidstreamError(error.message, responseId, error) : error,
          );
        };
        const onError = (event: any) =>
          fail(new Error(event?.message || event?.error?.message || 'WebSocket error'));
        const onClose = (event: any) => {
          keepSocket = false;
          emitSocketClose(
            request.onLifecycleEvent,
            socket,
            request.cacheKey,
            'active_close',
            event,
          );
          fail(
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
        if (request.signal?.aborted) onAbort();
        armIdleTimer();
      });
      acquired.release(keepSocket);
      writeDebugLog(request.settings, 'websocket.response.done', {
        cacheKeyHash: shortHash(request.cacheKey),
        responseId,
        eventCount,
        keepSocket,
      });
      return { responseId, eventCount };
    } catch (error) {
      keepSocket = false;
      acquired?.release(false);
      lastError = error;
      if (
        error instanceof PreviousResponseNotFoundError &&
        request.fallbackBodyOnPreviousResponseNotFound
      ) {
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
          },
          onEvent,
        );
        return { ...result, fallbackUsed: true };
      }
      if (error instanceof WebSocketMidstreamError) throw error;
      writeDebugLog(request.settings, 'websocket.response.error', {
        attempt,
        cacheKeyHash: shortHash(request.cacheKey),
        responseId,
        eventCount,
        message: error instanceof Error ? error.message : String(error),
        willRetry: eventCount === 0 && !responseId && attempt < request.settings.websocket.retries,
      });
      if (eventCount > 0 || responseId || attempt >= request.settings.websocket.retries)
        throw error;
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
