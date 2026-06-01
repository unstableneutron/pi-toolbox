import net from 'node:net';

import { afterEach, describe, expect, test } from 'vitest';

import { CodexAppServerWebSocketClient } from './app-server';

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

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
