import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { CodexAppServerClient, CodexAppServerWebSocketClient } from './app-server';

const OPENAI_EXTENSION_ORIGIN = 'chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg';

function encodeServerFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length >= 126) throw new Error('test helper only supports small frames');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function decodeClientFrame(buffer: Buffer): { value: any; rest: Buffer } | undefined {
  if (buffer.length < 6) return undefined;
  let length = buffer[1]! & 0x7f;
  let cursor = 2;
  if (length === 126) {
    if (buffer.length < cursor + 2 + 4) return undefined;
    length = buffer.readUInt16BE(cursor);
    cursor += 2;
  } else if (length === 127) {
    if (buffer.length < cursor + 8 + 4) return undefined;
    length = Number(buffer.readBigUInt64BE(cursor));
    cursor += 8;
  }
  const mask = buffer.subarray(cursor, cursor + 4);
  cursor += 4;
  if (buffer.length < cursor + length) return undefined;
  const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
  for (let index = 0; index < payload.length; index++) {
    payload[index] ^= mask[index % 4]!;
  }
  return {
    value: JSON.parse(payload.toString('utf8')),
    rest: buffer.subarray(cursor + length),
  };
}

function writeFakeCodexExecutable(): { directory: string; executable: string; logFile: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-codex-app-server-test-'));
  const executable = path.join(directory, 'fake-codex.mjs');
  const logFile = path.join(directory, 'messages.jsonl');
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
let buffer = '';
const logFile = path.join(process.env.CODEX_HOME, 'messages.jsonl');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    fs.appendFileSync(logFile, JSON.stringify(message) + '\\n');
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ id: message.id, result: { ok: true } }) + '\\n');
    }
  }
});
`,
  );
  fs.chmodSync(executable, 0o755);
  return { directory, executable, logFile };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForImmediate(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('CodexAppServerClient', () => {
  test('aborts pending stdio MCP tool requests without waiting for timeout', async () => {
    const { directory, executable, logFile } = writeFakeCodexExecutable();
    const client = new CodexAppServerClient({
      codexExecutable: executable,
      codexHome: directory,
      clientName: 'test-client',
    });
    const controller = new AbortController();

    try {
      await client.init();
      const pending = client.callMcpTool({
        threadId: 'thread-1',
        server: 'computer-use',
        tool: 'get_app_state',
        arguments: { app: 'Finder' },
        timeoutMs: 50,
        signal: controller.signal,
      });
      await waitFor(() =>
        fs
          .readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .some((line) => JSON.parse(line).method === 'mcpServer/tool/call'),
      );
      controller.abort();

      await expect(pending).rejects.toThrow('Operation aborted');
      await waitFor(() =>
        fs
          .readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .some((line) => JSON.parse(line).method === 'notifications/cancelled'),
      );
      const messages = fs
        .readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(messages).toContainEqual({
        method: 'notifications/cancelled',
        params: { requestId: 2, reason: 'Operation aborted' },
      });
    } finally {
      client.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('waits for stdio cancellation notification flush before rejecting aborts', async () => {
    const { directory, executable, logFile } = writeFakeCodexExecutable();
    const client = new CodexAppServerClient({
      codexExecutable: executable,
      codexHome: directory,
      clientName: 'test-client',
    });
    const controller = new AbortController();
    let rejectObserved = false;
    let cancelWriteDone: (() => void) | undefined;

    try {
      await client.init();
      const pending = client.callMcpTool({
        threadId: 'thread-1',
        server: 'computer-use',
        tool: 'get_app_state',
        arguments: { app: 'Finder' },
        timeoutMs: 5_000,
        signal: controller.signal,
      });
      pending.catch(() => {
        rejectObserved = true;
      });
      await waitFor(() =>
        fs
          .readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .some((line) => JSON.parse(line).method === 'mcpServer/tool/call'),
      );

      const stdin = (client as any).process.stdin as NodeJS.WritableStream;
      const originalWrite = stdin.write.bind(stdin);
      stdin.write = ((chunk: any, encodingOrCallback?: any, callback?: any) => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        const writeDone = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
        if (text.includes('notifications/cancelled')) {
          cancelWriteDone = writeDone;
          return true;
        }
        return originalWrite(chunk, encodingOrCallback, callback);
      }) as typeof stdin.write;

      controller.abort();
      await waitForImmediate();

      expect(cancelWriteDone).toBeTypeOf('function');
      expect(rejectObserved).toBe(false);

      cancelWriteDone?.();
      await expect(pending).rejects.toThrow('Operation aborted');
      expect(rejectObserved).toBe(true);
    } finally {
      client.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('CodexAppServerWebSocketClient', () => {
  const servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    servers.length = 0;
  });

  test('connects to extension-host app-server proxy with the extension Origin header', async () => {
    const observed: { origin?: string; messages: any[] } = { messages: [] };
    const server = net.createServer((socket) => {
      let header = '';
      let frameBuffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        if (!header) {
          const raw = chunk.toString('utf8');
          const headerEnd = raw.indexOf('\r\n\r\n');
          if (headerEnd < 0) return;
          header = raw.slice(0, headerEnd);
          observed.origin = header.match(/^Origin: (.+)$/m)?.[1];
          socket.write(
            [
              'HTTP/1.1 101 Switching Protocols',
              'Upgrade: websocket',
              'Connection: Upgrade',
              'Sec-WebSocket-Accept: test',
              '',
              '',
            ].join('\r\n'),
          );
          frameBuffer = Buffer.from(raw.slice(headerEnd + 4), 'binary');
        } else {
          frameBuffer = Buffer.concat([frameBuffer, chunk]);
        }

        let decoded;
        while ((decoded = decodeClientFrame(frameBuffer))) {
          frameBuffer = Buffer.from(decoded.rest);
          observed.messages.push(decoded.value);
          if (decoded.value.method === 'initialize') {
            socket.write(encodeServerFrame({ id: decoded.value.id, result: { ok: true } }));
          }
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || 'string' === typeof address) throw new Error('expected TCP address');

    const client = new CodexAppServerWebSocketClient({
      clientName: 'test-client',
      origin: OPENAI_EXTENSION_ORIGIN,
      url: `ws://127.0.0.1:${address.port}?token=test`,
    });
    try {
      await client.init();
      await waitFor(() => observed.messages.some((message) => message.method === 'initialized'));
    } finally {
      client.close();
    }

    expect(observed.origin).toBe(OPENAI_EXTENSION_ORIGIN);
    expect(observed.messages.map((message) => message.method)).toContain('initialize');
    expect(observed.messages.map((message) => message.method)).toContain('initialized');
  });

  test('aborts pending WebSocket MCP tool requests without waiting for timeout', async () => {
    const observed: { messages: any[] } = { messages: [] };
    const server = net.createServer((socket) => {
      let upgraded = false;
      let frameBuffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        if (!upgraded) {
          const raw = chunk.toString('utf8');
          const headerEnd = raw.indexOf('\r\n\r\n');
          if (headerEnd < 0) return;
          upgraded = true;
          socket.write(
            [
              'HTTP/1.1 101 Switching Protocols',
              'Upgrade: websocket',
              'Connection: Upgrade',
              'Sec-WebSocket-Accept: test',
              '',
              '',
            ].join('\r\n'),
          );
          frameBuffer = Buffer.from(raw.slice(headerEnd + 4), 'binary');
        } else {
          frameBuffer = Buffer.concat([frameBuffer, chunk]);
        }

        let decoded;
        while ((decoded = decodeClientFrame(frameBuffer))) {
          frameBuffer = Buffer.from(decoded.rest);
          observed.messages.push(decoded.value);
          if (decoded.value.method === 'initialize') {
            socket.write(encodeServerFrame({ id: decoded.value.id, result: { ok: true } }));
          }
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || 'string' === typeof address) throw new Error('expected TCP address');

    const client = new CodexAppServerWebSocketClient({
      clientName: 'test-client',
      origin: OPENAI_EXTENSION_ORIGIN,
      url: `ws://127.0.0.1:${address.port}?token=test`,
    });
    const controller = new AbortController();
    try {
      await client.init();
      const pending = client.callMcpTool({
        threadId: 'thread-1',
        server: 'node_repl',
        tool: 'js',
        arguments: { code: '1 + 1' },
        timeoutMs: 50,
        signal: controller.signal,
      });
      await waitFor(() =>
        observed.messages.some((message) => message.method === 'mcpServer/tool/call'),
      );
      controller.abort();

      await expect(pending).rejects.toThrow('Operation aborted');
      await waitFor(() =>
        observed.messages.some((message) => message.method === 'notifications/cancelled'),
      );
      expect(observed.messages).toContainEqual({
        method: 'notifications/cancelled',
        params: { requestId: 2, reason: 'Operation aborted' },
      });
    } finally {
      client.close();
    }
  });

  test('waits for WebSocket cancellation notification flush before rejecting aborts', async () => {
    const observed: { messages: any[] } = { messages: [] };
    const server = net.createServer((socket) => {
      let upgraded = false;
      let frameBuffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        if (!upgraded) {
          const raw = chunk.toString('utf8');
          const headerEnd = raw.indexOf('\r\n\r\n');
          if (headerEnd < 0) return;
          upgraded = true;
          socket.write(
            [
              'HTTP/1.1 101 Switching Protocols',
              'Upgrade: websocket',
              'Connection: Upgrade',
              'Sec-WebSocket-Accept: test',
              '',
              '',
            ].join('\r\n'),
          );
          frameBuffer = Buffer.from(raw.slice(headerEnd + 4), 'binary');
        } else {
          frameBuffer = Buffer.concat([frameBuffer, chunk]);
        }

        let decoded;
        while ((decoded = decodeClientFrame(frameBuffer))) {
          frameBuffer = Buffer.from(decoded.rest);
          observed.messages.push(decoded.value);
          if (decoded.value.method === 'initialize') {
            socket.write(encodeServerFrame({ id: decoded.value.id, result: { ok: true } }));
          }
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || 'string' === typeof address) throw new Error('expected TCP address');

    const client = new CodexAppServerWebSocketClient({
      clientName: 'test-client',
      origin: OPENAI_EXTENSION_ORIGIN,
      url: `ws://127.0.0.1:${address.port}?token=test`,
    });
    const controller = new AbortController();
    let rejectObserved = false;
    let cancelWriteDone: (() => void) | undefined;
    try {
      await client.init();
      const pending = client.callMcpTool({
        threadId: 'thread-1',
        server: 'node_repl',
        tool: 'js',
        arguments: { code: '1 + 1' },
        timeoutMs: 5_000,
        signal: controller.signal,
      });
      pending.catch(() => {
        rejectObserved = true;
      });
      await waitFor(() =>
        observed.messages.some((message) => message.method === 'mcpServer/tool/call'),
      );

      const socket = (client as any).socket as net.Socket;
      const originalWrite = socket.write.bind(socket);
      socket.write = ((chunk: any, encodingOrCallback?: any, callback?: any) => {
        const decoded = Buffer.isBuffer(chunk) ? decodeClientFrame(Buffer.from(chunk)) : undefined;
        const writeDone = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
        if (decoded?.value.method === 'notifications/cancelled') {
          cancelWriteDone = writeDone;
          return true;
        }
        return originalWrite(chunk, encodingOrCallback, callback);
      }) as typeof socket.write;

      controller.abort();
      await waitForImmediate();

      expect(cancelWriteDone).toBeTypeOf('function');
      expect(rejectObserved).toBe(false);

      cancelWriteDone?.();
      await expect(pending).rejects.toThrow('Operation aborted');
      expect(rejectObserved).toBe(true);
    } finally {
      client.close();
    }
  });

  test('treats Already initialized from an extension-host proxy as a usable connection', async () => {
    const observed: { messages: any[] } = { messages: [] };
    const server = net.createServer((socket) => {
      let upgraded = false;
      let frameBuffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        if (!upgraded) {
          const raw = chunk.toString('utf8');
          const headerEnd = raw.indexOf('\r\n\r\n');
          if (headerEnd < 0) return;
          upgraded = true;
          socket.write(
            [
              'HTTP/1.1 101 Switching Protocols',
              'Upgrade: websocket',
              'Connection: Upgrade',
              'Sec-WebSocket-Accept: test',
              '',
              '',
            ].join('\r\n'),
          );
          frameBuffer = Buffer.from(raw.slice(headerEnd + 4), 'binary');
        } else {
          frameBuffer = Buffer.concat([frameBuffer, chunk]);
        }

        let decoded;
        while ((decoded = decodeClientFrame(frameBuffer))) {
          frameBuffer = Buffer.from(decoded.rest);
          observed.messages.push(decoded.value);
          if (decoded.value.method === 'initialize') {
            socket.write(
              encodeServerFrame({
                id: decoded.value.id,
                error: { code: 1, message: 'Already initialized' },
              }),
            );
          }
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || 'string' === typeof address) throw new Error('expected TCP address');

    const client = new CodexAppServerWebSocketClient({
      clientName: 'test-client',
      origin: OPENAI_EXTENSION_ORIGIN,
      url: `ws://127.0.0.1:${address.port}?token=test`,
    });
    try {
      await expect(client.init()).resolves.toBeUndefined();
      await waitFor(() => observed.messages.some((message) => message.method === 'initialized'));
    } finally {
      client.close();
    }
  });
});
