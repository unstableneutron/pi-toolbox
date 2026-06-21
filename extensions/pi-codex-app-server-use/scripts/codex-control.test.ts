import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const tempDirs: string[] = [];

async function makeTempSocketPath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-codex-control-test-'));
  tempDirs.push(directory);
  return path.join(directory, 'app-server.sock');
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve(undefined)));
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(predicate()).toBe(true);
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
}

function encodeServerTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length >= 126) throw new Error('test helper only supports short frames');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function encodeServerJson(value: unknown): Buffer {
  return encodeServerTextFrame(JSON.stringify(value));
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('codex-control websocket frames', () => {
  test('round-trips a masked client text frame', async () => {
    const { decodeWebSocketFrames, encodeClientTextFrame } = await import('./codex-control.mjs');

    const encoded = encodeClientTextFrame('{"id":1,"method":"initialize"}');
    const decoded = decodeWebSocketFrames(encoded);

    expect(decoded.rest).toHaveLength(0);
    expect(decoded.frames).toMatchObject([
      {
        opcode: 1,
        text: '{"id":1,"method":"initialize"}',
      },
    ]);
  });

  test('keeps incomplete frame bytes as rest', async () => {
    const { decodeWebSocketFrames, encodeClientTextFrame } = await import('./codex-control.mjs');
    const encoded = encodeClientTextFrame('hello');

    const decoded = decodeWebSocketFrames(encoded.subarray(0, 3));

    expect(decoded.frames).toEqual([]);
    expect(decoded.rest).toEqual(encoded.subarray(0, 3));
  });
});

describe('codex-control client lifecycle', () => {
  test('destroys the socket when WebSocket upgrade times out', async () => {
    const { CodexControlClient } = await import('./codex-control.mjs');
    const socketPath = await makeTempSocketPath();
    const server = net.createServer((socket) => {
      socket.on('data', () => {
        // Keep the connection open without answering the upgrade request.
      });
    });
    await listen(server, socketPath);
    const client = new CodexControlClient({ socketPath, requestTimeoutMs: 25 });

    await expect(client.connect()).rejects.toThrow('Timed out waiting for WebSocket upgrade');
    await waitUntil(() => client.socket?.destroyed === true);

    await closeServer(server);
  });

  test('handles a frame coalesced with the WebSocket upgrade response', async () => {
    const { CodexControlClient } = await import('./codex-control.mjs');
    const socketPath = await makeTempSocketPath();
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write(
          Buffer.concat([
            Buffer.from(
              [
                'HTTP/1.1 101 Switching Protocols',
                'Upgrade: websocket',
                'Connection: Upgrade',
                'Sec-WebSocket-Accept: test',
                '',
                '',
              ].join('\r\n'),
            ),
            encodeServerJson({ jsonrpc: '2.0', method: 'server/ready' }),
          ]),
        );
      });
    });
    await listen(server, socketPath);
    const client = new CodexControlClient({ socketPath, requestTimeoutMs: 1_000 });

    await client.connect();

    expect(client.notifications).toMatchObject([{ jsonrpc: '2.0', method: 'server/ready' }]);
    client.close();
    await closeServer(server);
  });
});

describe('codex-control MCP output helpers', () => {
  test('extracts text content from MCP tool results', async () => {
    const { getMcpText } = await import('./codex-control.mjs');

    expect(
      getMcpText({
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', data: 'ignored' },
          { type: 'text', text: 'second' },
        ],
      }),
    ).toBe('first\nsecond');
  });
});
