import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';

import type { McpElicitationRequestParams, McpElicitationResponse } from './elicitation';

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { message?: string; code?: number; data?: unknown };
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

interface CodexAppServerClientOptions {
  codexExecutable: string;
  codexHome: string;
  clientName?: string;
  onElicitation?: (params: McpElicitationRequestParams) => Promise<McpElicitationResponse>;
}

interface CodexThreadStartOptions {
  cwd: string;
  name?: string;
  signal?: AbortSignal;
}

interface CodexAppServerProcessInfo {
  pid?: number;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  lastStderr: string[];
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const THREAD_START_TIMEOUT_MS = 60_000;
const CANCEL_NOTIFICATION_GRACE_MS = 50;

function createOperationAbortedError(): Error {
  return new Error('Operation aborted');
}

function buildCancellationNotification(requestId: number | string, reason: string): unknown {
  return {
    method: 'notifications/cancelled',
    params: {
      requestId,
      reason,
    },
  };
}

function sendJsonLine(stream: NodeJS.WritableStream, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function waitForGracefulWrite(
  write: (callback: (error?: Error | null) => void) => void,
): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, CANCEL_NOTIFICATION_GRACE_MS);
    try {
      write(finish);
    } catch {
      finish();
    }
  });
}

function sendJsonLineAndWaitForFlush(stream: NodeJS.WritableStream, value: unknown): Promise<void> {
  return waitForGracefulWrite((callback) => {
    stream.write(`${JSON.stringify(value)}\n`, callback);
  });
}

function encodeClientWebSocketFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  let header: Buffer;
  let maskOffset: number;

  if (payload.length < 126) {
    header = Buffer.alloc(6);
    header[1] = 0x80 | payload.length;
    maskOffset = 2;
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(8);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
    maskOffset = 4;
  } else {
    header = Buffer.alloc(14);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
    maskOffset = 10;
  }

  header[0] = 0x81;
  crypto.randomFillSync(header, maskOffset, 4);
  const mask = header.subarray(maskOffset, maskOffset + 4);
  const frame = Buffer.alloc(header.length + payload.length);
  header.copy(frame, 0);
  for (let index = 0; index < payload.length; index++) {
    frame[header.length + index] = payload[index]! ^ mask[index % 4]!;
  }
  return frame;
}

function encodeClientPongFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(payload.length < 126 ? 6 : 8);
  let maskOffset: number;
  if (payload.length < 126) {
    header[1] = 0x80 | payload.length;
    maskOffset = 2;
  } else {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
    maskOffset = 4;
  }
  header[0] = 0x8a;
  crypto.randomFillSync(header, maskOffset, 4);
  const mask = header.subarray(maskOffset, maskOffset + 4);
  const frame = Buffer.alloc(header.length + payload.length);
  header.copy(frame, 0);
  for (let index = 0; index < payload.length; index++) {
    frame[header.length + index] = payload[index]! ^ mask[index % 4]!;
  }
  return frame;
}

function decodeServerWebSocketFrames(buffer: Buffer): {
  frames: Array<{ opcode: number; payload: Buffer; text?: string }>;
  rest: Buffer;
} {
  const frames: Array<{ opcode: number; payload: Buffer; text?: string }> = [];
  let offset = 0;

  while (buffer.length - offset >= 2) {
    const firstByte = buffer[offset]!;
    const secondByte = buffer[offset + 1]!;
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let length = secondByte & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }

    let mask: Buffer | undefined;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }

    if (buffer.length - cursor < length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) {
      for (let index = 0; index < payload.length; index++) {
        payload[index] ^= mask[index % 4]!;
      }
    }
    frames.push({ opcode, payload, ...(opcode === 1 ? { text: payload.toString('utf8') } : {}) });
    offset = cursor + length;
  }

  return { frames, rest: buffer.subarray(offset) };
}

function buildWebSocketUpgradeRequest(url: URL, origin: string): string {
  const key = crypto.randomBytes(16).toString('base64');
  const isUnixSocket = url.protocol === 'unix:';
  const requestPath = isUnixSocket ? '/' : `${url.pathname || '/'}${url.search}`;
  const host = isUnixSocket ? 'localhost' : url.host;
  return [
    `GET ${requestPath} HTTP/1.1`,
    `Host: ${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    `Origin: ${origin}`,
    '',
    '',
  ].join('\r\n');
}

function getUnixSocketPath(url: URL): string {
  const socketPath = decodeURIComponent(url.pathname);
  if (!socketPath) throw new Error('Unix app-server URL is missing a socket path');
  return socketPath;
}

export class CodexAppServerClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly codexHome: string;
  private readonly clientName: string;
  private buffer = '';
  private nextId = 1;
  private initialized?: Promise<void>;
  private readonly stderrLines: string[] = [];
  private onElicitation?: (params: McpElicitationRequestParams) => Promise<McpElicitationResponse>;

  constructor(options: CodexAppServerClientOptions) {
    this.codexHome = options.codexHome;
    this.clientName = options.clientName ?? 'pi-codex-computer-use';
    this.onElicitation = options.onElicitation;
    this.process = spawn(options.codexExecutable, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: options.codexHome },
    });
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (chunk) => this.recordStderr(chunk));
    this.process.on('exit', (code, signal) => {
      const error = new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'})`);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  setElicitationHandler(
    handler: ((params: McpElicitationRequestParams) => Promise<McpElicitationResponse>) | undefined,
  ): () => void {
    const previous = this.onElicitation;
    this.onElicitation = handler;
    return () => {
      this.onElicitation = previous;
    };
  }

  async init(signal?: AbortSignal): Promise<void> {
    this.initialized ??= this.initialize(signal).catch((error: unknown) => {
      this.initialized = undefined;
      throw error;
    });
    await this.initialized;
  }

  async startThread(options: CodexThreadStartOptions): Promise<string> {
    await this.init(options.signal);
    const response = await this.request(
      'thread/start',
      {
        cwd: options.cwd,
        ephemeral: true,
        approvalPolicy: 'on-request',
        baseInstructions:
          'Pi-created Codex native tool bridge thread. Only execute Computer Use and browser Node REPL MCP calls requested by Pi.',
      },
      THREAD_START_TIMEOUT_MS,
      options.signal,
    );
    const threadId = response?.thread?.id;
    if ('string' !== typeof threadId || threadId.length === 0) {
      throw new Error('Codex app-server did not return a thread id');
    }
    if (options.name) {
      await this.request('thread/name/set', { threadId, name: options.name }, 10_000).catch(() => {
        // Naming is cosmetic; keep the bridge usable if this fails.
      });
    }
    return threadId;
  }

  async callMcpTool(input: {
    threadId: string;
    server: string;
    tool: string;
    arguments?: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
    _meta?: Record<string, unknown>;
  }): Promise<any> {
    await this.init(input.signal);
    return await this.request(
      'mcpServer/tool/call',
      {
        server: input.server,
        threadId: input.threadId,
        tool: input.tool,
        arguments: input.arguments ?? {},
        ...(input._meta ? { _meta: input._meta } : {}),
      },
      input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      input.signal,
    );
  }

  async listMcpServers(threadId?: string): Promise<any> {
    await this.init();
    return await this.request('mcpServerStatus/list', {
      detail: 'toolsAndAuthOnly',
      limit: 50,
      cursor: null,
      threadId: threadId ?? null,
    });
  }

  getProcessInfo(): CodexAppServerProcessInfo {
    return {
      pid: this.process.pid,
      killed: this.process.killed,
      exitCode: this.process.exitCode,
      signalCode: this.process.signalCode,
      lastStderr: [...this.stderrLines],
    };
  }

  close(): void {
    this.process.kill();
  }

  private recordStderr(chunk: string): void {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      this.stderrLines.push(trimmed);
    }
    if (this.stderrLines.length > 40) {
      this.stderrLines.splice(0, this.stderrLines.length - 40);
    }
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    await this.request(
      'initialize',
      {
        clientInfo: { name: this.clientName, title: null, version: '0' },
        capabilities: null,
      },
      DEFAULT_REQUEST_TIMEOUT_MS,
      signal,
    );
    sendJsonLine(this.process.stdin, { method: 'initialized' });
  }

  private request(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<any> {
    if (signal?.aborted) {
      return Promise.reject(createOperationAbortedError());
    }

    const id = this.nextId++;
    sendJsonLine(this.process.stdin, { id, method, params });
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const beginSettle = () => {
        if (settled) return false;
        settled = true;
        this.pending.delete(id);
        cleanup();
        return true;
      };
      const settle = (run: () => void) => {
        if (!beginSettle()) return;
        run();
      };
      const sendCancellation = (reason: string): Promise<void> => {
        if (method === 'initialize' || this.process.killed || this.process.stdin.destroyed) {
          return Promise.resolve();
        }
        return sendJsonLineAndWaitForFlush(
          this.process.stdin,
          buildCancellationNotification(id, reason),
        );
      };
      const fail = (error: Error, cancelReason?: string) => {
        if (!cancelReason) {
          settle(() => reject(error));
          return;
        }
        if (!beginSettle()) return;
        void sendCancellation(cancelReason).then(() => reject(error));
      };
      const onAbort = () => fail(createOperationAbortedError(), 'Operation aborted');
      const timer = setTimeout(() => {
        const message = `${method} timed out after ${timeoutMs}ms`;
        fail(new Error(message), message);
      }, timeoutMs);

      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => fail(error),
      });
    });
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      this.handleMessage(JSON.parse(line) as JsonRpcMessage).catch((error) => {
        if (error instanceof Error) {
          // Server-request errors are reflected to app-server in handleServerRequest.
          return;
        }
      });
    }
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    if (message.id !== undefined && message.method) {
      await this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    if (message.method !== 'mcpServer/elicitation/request') {
      sendJsonLine(this.process.stdin, {
        id: message.id,
        error: { code: -32601, message: `Unsupported app-server request: ${message.method}` },
      });
      return;
    }

    const answer = this.onElicitation
      ? await this.onElicitation(message.params as McpElicitationRequestParams)
      : { action: 'decline', content: null, _meta: null };
    sendJsonLine(this.process.stdin, { id: message.id, result: answer });
  }
}

export class CodexAppServerWebSocketClient {
  private socket?: net.Socket;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly clientName: string;
  private readonly origin: string;
  private readonly url: URL;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private connected?: Promise<void>;
  private initialized?: Promise<void>;
  private onElicitation?: (params: McpElicitationRequestParams) => Promise<McpElicitationResponse>;

  constructor(options: {
    clientName?: string;
    onElicitation?: (params: McpElicitationRequestParams) => Promise<McpElicitationResponse>;
    origin: string;
    url: string;
  }) {
    this.clientName = options.clientName ?? 'pi-codex-computer-use-chrome';
    this.onElicitation = options.onElicitation;
    this.origin = options.origin;
    this.url = new URL(options.url);
  }

  setElicitationHandler(
    handler: ((params: McpElicitationRequestParams) => Promise<McpElicitationResponse>) | undefined,
  ): () => void {
    const previous = this.onElicitation;
    this.onElicitation = handler;
    return () => {
      this.onElicitation = previous;
    };
  }

  async init(signal?: AbortSignal): Promise<void> {
    this.initialized ??= this.initialize(signal).catch((error: unknown) => {
      this.initialized = undefined;
      throw error;
    });
    await this.initialized;
  }

  async startThread(options: CodexThreadStartOptions): Promise<string> {
    await this.init(options.signal);
    const response = await this.request(
      'thread/start',
      {
        cwd: options.cwd,
        ephemeral: true,
        approvalPolicy: 'on-request',
        baseInstructions:
          'Pi-created Codex Chrome Extension browser bridge thread. Only execute browser Node REPL MCP calls requested by Pi.',
      },
      THREAD_START_TIMEOUT_MS,
      options.signal,
    );
    const threadId = response?.thread?.id;
    if ('string' !== typeof threadId || threadId.length === 0) {
      throw new Error('Codex extension-host app-server did not return a thread id');
    }
    if (options.name) {
      await this.request('thread/name/set', { threadId, name: options.name }, 10_000).catch(() => {
        // Naming is cosmetic; keep the bridge usable if this fails.
      });
    }
    return threadId;
  }

  async callMcpTool(input: {
    threadId: string;
    server: string;
    tool: string;
    arguments?: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
    _meta?: Record<string, unknown>;
  }): Promise<any> {
    await this.init(input.signal);
    return await this.request(
      'mcpServer/tool/call',
      {
        server: input.server,
        threadId: input.threadId,
        tool: input.tool,
        arguments: input.arguments ?? {},
        ...(input._meta ? { _meta: input._meta } : {}),
      },
      input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      input.signal,
    );
  }

  async listMcpServers(threadId?: string): Promise<any> {
    await this.init();
    return await this.request('mcpServerStatus/list', {
      detail: 'toolsAndAuthOnly',
      limit: 50,
      cursor: null,
      threadId: threadId ?? null,
    });
  }

  getProcessInfo(): CodexAppServerProcessInfo {
    return {
      killed: false,
      exitCode: null,
      signalCode: null,
      lastStderr: [],
    };
  }

  close(): void {
    this.socket?.end();
    this.socket = undefined;
    this.connected = undefined;
    this.initialized = undefined;
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    await this.connect(signal);
    try {
      await this.request(
        'initialize',
        {
          clientInfo: { name: this.clientName, title: null, version: '0' },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            optOutNotificationMethods: [],
          },
        },
        DEFAULT_REQUEST_TIMEOUT_MS,
        signal,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Already initialized')) throw error;
    }
    this.sendJson({ method: 'initialized' });
  }

  private async connect(signal?: AbortSignal): Promise<void> {
    this.connected ??= this.openSocket(signal).catch((error: unknown) => {
      this.connected = undefined;
      throw error;
    });
    await this.connected;
  }

  private async openSocket(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw createOperationAbortedError();
    if (this.url.protocol !== 'ws:' && this.url.protocol !== 'unix:') {
      throw new Error(`Unsupported Codex extension-host app-server URL: ${this.url.protocol}`);
    }

    const socket =
      this.url.protocol === 'unix:'
        ? net.createConnection(getUnixSocketPath(this.url))
        : net.createConnection({
            host: this.url.hostname,
            port: Number(this.url.port),
          });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let cleanupAbort = () => {};
      if (signal) {
        const onAbort = () => {
          cleanupAbort();
          socket.destroy();
          reject(createOperationAbortedError());
        };
        cleanupAbort = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
      }
      socket.once('connect', () => {
        cleanupAbort();
        resolve();
      });
      socket.once('error', (error) => {
        cleanupAbort();
        reject(error);
      });
    });

    socket.write(buildWebSocketUpgradeRequest(this.url, this.origin));
    await this.waitForUpgrade(socket, signal);
    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('error', (error) => this.rejectAll(error));
    socket.on('close', () => this.rejectAll(new Error('Codex extension-host app-server closed')));
    if (this.buffer.length > 0) {
      const existing = this.buffer;
      this.buffer = Buffer.alloc(0);
      this.handleData(existing);
    }
  }

  private async waitForUpgrade(socket: net.Socket, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('data', onData);
        socket.off('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: Error) => {
        cleanup();
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error('Timed out waiting for Codex extension-host WebSocket upgrade')),
        5_000,
      );
      const onError = (error: Error) => fail(error);
      const onAbort = () => fail(createOperationAbortedError());
      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        const headerEnd = raw.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        cleanup();
        const header = raw.subarray(0, headerEnd).toString('utf8');
        if (!header.includes('101 Switching Protocols')) {
          fail(new Error(`Codex extension-host WebSocket upgrade failed: ${header}`));
          return;
        }
        this.buffer = raw.subarray(headerEnd + 4);
        resolve();
      };
      socket.on('data', onData);
      socket.once('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private request(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<any> {
    if (signal?.aborted) {
      return Promise.reject(createOperationAbortedError());
    }

    const id = this.nextId++;
    this.sendJson(params === undefined ? { id, method } : { id, method, params });
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const beginSettle = () => {
        if (settled) return false;
        settled = true;
        this.pending.delete(id);
        cleanup();
        return true;
      };
      const settle = (run: () => void) => {
        if (!beginSettle()) return;
        run();
      };
      const sendCancellation = (reason: string): Promise<void> => {
        if (method === 'initialize' || !this.socket || this.socket.destroyed) {
          return Promise.resolve();
        }
        const notification = buildCancellationNotification(id, reason);
        return waitForGracefulWrite((callback) => {
          this.socket!.write(encodeClientWebSocketFrame(notification), callback);
        });
      };
      const fail = (error: Error, cancelReason?: string) => {
        if (!cancelReason) {
          settle(() => reject(error));
          return;
        }
        if (!beginSettle()) return;
        void sendCancellation(cancelReason).then(() => reject(error));
      };
      const onAbort = () => fail(createOperationAbortedError(), 'Operation aborted');
      const timer = setTimeout(() => {
        const message = `${method} timed out after ${timeoutMs}ms`;
        fail(new Error(message), message);
      }, timeoutMs);

      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => fail(error),
      });
    });
  }

  private sendJson(value: unknown): void {
    if (!this.socket) throw new Error('Codex extension-host app-server is not connected');
    this.socket.write(encodeClientWebSocketFrame(value));
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const decoded = decodeServerWebSocketFrames(this.buffer);
    this.buffer = Buffer.from(decoded.rest);

    for (const frame of decoded.frames) {
      if (frame.opcode === 0x9) {
        this.socket?.write(encodeClientPongFrame(frame.payload));
        continue;
      }
      if (frame.opcode !== 0x1 || !frame.text) continue;
      this.handleTextMessage(frame.text).catch(() => {
        // Errors in server-request handling are reflected in handleServerRequest.
      });
    }
  }

  private async handleTextMessage(text: string): Promise<void> {
    const message = JSON.parse(text) as JsonRpcMessage;
    if (message.id !== undefined && message.method) {
      await this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    if (message.method !== 'mcpServer/elicitation/request') {
      this.sendJson({
        id: message.id,
        error: { code: -32601, message: `Unsupported app-server request: ${message.method}` },
      });
      return;
    }

    const answer = this.onElicitation
      ? await this.onElicitation(message.params as McpElicitationRequestParams)
      : { action: 'decline', content: null, _meta: null };
    this.sendJson({ id: message.id, result: answer });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
