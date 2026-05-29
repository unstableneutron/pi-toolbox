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
  idleErrorListener?: (event: any) => void;
}

const socketCache = new Map<string, SocketCacheEntry>();
const SOCKET_CACHE_TTL_MS = 5 * 60 * 1000;

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
}

function isReusable(socket: WebSocketLike): boolean {
  return socket.readyState === undefined || socket.readyState === 1;
}

function closeSilently(socket: WebSocketLike, code = 1000, reason = 'done'): void {
  try {
    socket.close(code, reason);
    socket.terminate?.();
  } catch {
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

function removeIdleErrorListener(entry: SocketCacheEntry): void {
  if (!entry.idleErrorListener) return;
  entry.socket.removeEventListener('error', entry.idleErrorListener);
  entry.idleErrorListener = undefined;
}

function addIdleErrorListener(key: string, entry: SocketCacheEntry): void {
  if (entry.idleErrorListener) return;
  entry.idleErrorListener = () => {
    removeIdleErrorListener(entry);
    closeSilently(entry.socket, 1000, 'idle_error');
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (socketCache.get(key) === entry) socketCache.delete(key);
  };
  entry.socket.addEventListener('error', entry.idleErrorListener);
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
  connectTimeoutMs: number;
  cacheKey?: string;
  WebSocketCtor?: WebSocketConstructorLike;
}): Promise<{ socket: WebSocketLike; release(keep: boolean): void }> {
  if (!request.cacheKey) {
    const socket = await connectSocket(
      request.url,
      request.headers,
      request.signal,
      request.connectTimeoutMs,
      request.WebSocketCtor,
    );
    return { socket, release: () => closeSilently(socket) };
  }
  const cached = socketCache.get(request.cacheKey);
  if (cached?.idleTimer) {
    clearTimeout(cached.idleTimer);
    cached.idleTimer = undefined;
  }
  if (cached?.busy) {
    const socket = await connectSocket(
      request.url,
      request.headers,
      request.signal,
      request.connectTimeoutMs,
      request.WebSocketCtor,
    );
    return { socket, release: () => closeSilently(socket) };
  }
  if (cached && isReusable(cached.socket)) {
    cached.busy = true;
    removeIdleErrorListener(cached);
    refSocket(cached.socket);
    return {
      socket: cached.socket,
      release: (keep) => releaseCached(request.cacheKey!, cached, keep),
    };
  }
  if (cached) {
    removeIdleErrorListener(cached);
    closeSilently(cached.socket);
    socketCache.delete(request.cacheKey);
  }
  const socket = await connectSocket(
    request.url,
    request.headers,
    request.signal,
    request.connectTimeoutMs,
    request.WebSocketCtor,
  );
  const entry: SocketCacheEntry = { socket, busy: true };
  socketCache.set(request.cacheKey, entry);
  return { socket, release: (keep) => releaseCached(request.cacheKey!, entry, keep) };
}

function releaseCached(key: string, entry: SocketCacheEntry, keep: boolean): void {
  if (!keep || !isReusable(entry.socket)) {
    removeIdleErrorListener(entry);
    closeSilently(entry.socket);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (socketCache.get(key) === entry) socketCache.delete(key);
    return;
  }
  entry.busy = false;
  addIdleErrorListener(key, entry);
  unrefSocket(entry.socket);
  entry.idleTimer = setTimeout(() => {
    if (entry.busy) return;
    removeIdleErrorListener(entry);
    closeSilently(entry.socket, 1000, 'idle_timeout');
    if (socketCache.get(key) === entry) socketCache.delete(key);
  }, SOCKET_CACHE_TTL_MS);
  entry.idleTimer.unref?.();
}

export async function runWebSocketResponse(
  request: {
    url: string;
    headers: Headers;
    body: ResponsesBody;
    settings: OpenAIWebSocketResponsesSettings;
    signal?: AbortSignal;
    cacheKey?: string;
    WebSocketCtor?: WebSocketConstructorLike;
  },
  onEvent: (event: Record<string, any>) => Promise<void> | void,
): Promise<WebSocketRunResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= request.settings.websocket.retries; attempt++) {
    let responseId: string | undefined;
    let eventCount = 0;
    let acquired: Awaited<ReturnType<typeof acquireSocket>> | undefined;
    let keepSocket = true;
    try {
      acquired = await acquireSocket({
        url: request.url,
        headers: request.headers,
        signal: request.signal,
        connectTimeoutMs: request.settings.websocket.connectTimeoutMs,
        cacheKey: request.cacheKey,
        WebSocketCtor: request.WebSocketCtor,
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
          eventCount++;
          responseId = extractResponseId(parsed) ?? responseId;
          const terminalEvent = isTerminalEvent(parsed.type);
          if (terminalEvent) terminal = true;
          processing = processing.then(async () => {
            await onEvent(parsed);
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
          fail(
            new Error(
              `WebSocket closed before response.completed${event?.code ? ` code=${event.code}` : ''}${event?.reason ? ` reason=${event.reason}` : ''}`,
            ),
          );
        };
        socket.addEventListener('message', onMessage as any);
        socket.addEventListener('error', onError);
        socket.addEventListener('close', onClose);
        armIdleTimer();
      });
      acquired.release(keepSocket);
      return { responseId, eventCount };
    } catch (error) {
      keepSocket = false;
      acquired?.release(false);
      lastError = error;
      if (error instanceof WebSocketMidstreamError) throw error;
      if (eventCount > 0 || responseId || attempt >= request.settings.websocket.retries)
        throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function closeAllCachedWebSockets(): void {
  for (const entry of socketCache.values()) {
    removeIdleErrorListener(entry);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    closeSilently(entry.socket, 1000, 'shutdown');
  }
  socketCache.clear();
}
