import crypto from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const env = typeof process === 'undefined' ? {} : process.env;

export const DEFAULT_SOCKET_DIR =
  env.CODEX_BROWSER_USE_SOCKET_DIR ??
  env.BROWSER_USE_SOCKET_DIR ??
  (os.platform() === 'win32' ? '\\\\.\\pipe\\codex-browser-use' : '/tmp/codex-browser-use');

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
const MAX_FRAME_BYTES = 128 * 1024 * 1024;

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function encodeNativeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function decodeNativeFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (length > MAX_FRAME_BYTES) {
      throw new Error(`Browser Use frame is too large: ${length} bytes`);
    }
    if (buffer.length - offset - 4 < length) break;
    const payload = buffer.subarray(offset + 4, offset + 4 + length);
    frames.push(JSON.parse(payload.toString('utf8')));
    offset += 4 + length;
  }

  return { frames, rest: buffer.subarray(offset) };
}

export function makeSessionIds({ sessionId, turnId } = {}) {
  const resolvedSessionId =
    sessionId ??
    env.CODEX_BROWSER_USE_SESSION_ID ??
    env.CODEX_SESSION_ID ??
    `pi-codex-browser-${crypto.randomUUID()}`;
  const resolvedTurnId =
    turnId ??
    env.CODEX_BROWSER_USE_TURN_ID ??
    env.CODEX_TURN_ID ??
    `pi-codex-browser-turn-${crypto.randomUUID()}`;
  return { sessionId: resolvedSessionId, turnId: resolvedTurnId };
}

export class BrowserUseSocketClient {
  constructor({
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    sessionId,
    socketPath,
    turnId,
  } = {}) {
    if (!socketPath) throw new Error('BrowserUseSocketClient requires socketPath');
    const ids = makeSessionIds({ sessionId, turnId });
    this.socketPath = socketPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.sessionId = ids.sessionId;
    this.turnId = ids.turnId;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.notifications = [];
    this.socket = null;
    this.closing = false;
  }

  async connect(timeoutMs = this.requestTimeoutMs) {
    if (this.socket) return;
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('error', onError);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error(`Timed out connecting to ${this.socketPath}`));
      }, timeoutMs);
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });

    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('error', (error) => this.rejectAll(error));
    socket.on('close', () => {
      if (!this.closing) this.rejectAll(new Error('Browser Use socket closed'));
    });
  }

  async request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.socket) throw new Error('BrowserUseSocketClient is not connected');
    const id = this.nextId++;
    const message = {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        session_id: this.sessionId,
        turn_id: this.turnId,
      },
    };

    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });

    this.socket.write(encodeNativeFrame(message));
    return await response;
  }

  handleData(chunk) {
    try {
      const decoded = decodeNativeFrames(Buffer.concat([this.buffer, chunk]));
      this.buffer = decoded.rest;
      for (const frame of decoded.frames) this.handleFrame(frame);
    } catch (error) {
      this.rejectAll(error);
      this.socket?.destroy(error);
    }
  }

  handleFrame(frame) {
    if (frame?.id !== undefined && this.pending.has(frame.id)) {
      const pending = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.error) {
        pending.reject(new Error(frame.error.message ?? JSON.stringify(frame.error)));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }

    this.notifications.push(frame);
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close() {
    if (!this.socket) return;
    this.closing = true;
    const socket = this.socket;
    this.socket = null;
    this.rejectAll(new Error('Browser Use socket closing'));
    if (socket.destroyed) return;
    await new Promise((resolve) => {
      socket.once('close', resolve);
      socket.end();
      setTimeout(() => {
        if (!socket.destroyed) socket.destroy();
      }, 250).unref?.();
    });
  }
}

async function socketInfo(socketPath) {
  const stat = await lstat(socketPath);
  if (!stat.isSocket()) return null;
  return { socketPath, mtimeMs: stat.mtimeMs };
}

export async function listBrowserUseSockets({ socketDir = DEFAULT_SOCKET_DIR } = {}) {
  try {
    const entries = await readdir(socketDir);
    const sockets = (
      await Promise.all(
        entries.map((entry) => socketInfo(path.resolve(socketDir, entry)).catch(() => null)),
      )
    )
      .filter(Boolean)
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    return { socketDir, sockets };
  } catch (error) {
    if (error?.code === 'ENOENT') return { socketDir, sockets: [], error: null };
    return { socketDir, sockets: [], error: errorMessage(error) };
  }
}

export async function probeBrowserUseSocket(
  socketPath,
  { requestTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS, sessionId, turnId } = {},
) {
  const client = new BrowserUseSocketClient({
    requestTimeoutMs,
    sessionId,
    socketPath,
    turnId,
  });
  try {
    await withTimeout(
      client.connect(requestTimeoutMs),
      requestTimeoutMs,
      `Timed out connecting to ${socketPath}`,
    );
    const info = await client.request('getInfo', {}, requestTimeoutMs);
    return { ok: true, socketPath, info };
  } catch (error) {
    return { ok: false, socketPath, error: errorMessage(error) };
  } finally {
    await client.close().catch(() => {});
  }
}

export async function discoverBrowserUseBackends({
  requestTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  sessionId,
  socketDir = DEFAULT_SOCKET_DIR,
  turnId,
} = {}) {
  const listing = await listBrowserUseSockets({ socketDir });
  const probes = await Promise.all(
    listing.sockets.map(({ socketPath }) =>
      probeBrowserUseSocket(socketPath, {
        requestTimeoutMs,
        sessionId,
        turnId,
      }),
    ),
  );
  return {
    socketDir: listing.socketDir,
    socketCount: listing.sockets.length,
    socketListingError: listing.error ?? null,
    candidates: probes,
  };
}

export function selectChromeBackends(candidates) {
  return {
    selected: candidates.filter(
      (candidate) => candidate.ok && candidate.info?.type === 'extension',
    ),
    candidates,
  };
}

export async function createConnectedChromeClient({
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  sessionId,
  socketDir = DEFAULT_SOCKET_DIR,
  socketPath,
  turnId,
} = {}) {
  const ids = makeSessionIds({ sessionId, turnId });
  let selected;
  let discovery;

  if (socketPath) {
    const candidate = await probeBrowserUseSocket(socketPath, {
      requestTimeoutMs,
      sessionId: ids.sessionId,
      turnId: ids.turnId,
    });
    discovery = { socketDir: path.dirname(socketPath), socketCount: 1, candidates: [candidate] };
    selected = candidate.ok ? candidate : null;
  } else {
    discovery = await discoverBrowserUseBackends({
      requestTimeoutMs,
      sessionId: ids.sessionId,
      socketDir,
      turnId: ids.turnId,
    });
    selected = selectChromeBackends(discovery.candidates).selected[0] ?? null;
  }

  if (!selected) {
    throw new Error('No connected Chrome/Brave Browser Use extension backend was discovered');
  }

  const client = new BrowserUseSocketClient({
    requestTimeoutMs,
    sessionId: ids.sessionId,
    socketPath: selected.socketPath,
    turnId: ids.turnId,
  });
  await client.connect();
  return { client, backend: selected, discovery, sessionId: ids.sessionId, turnId: ids.turnId };
}
