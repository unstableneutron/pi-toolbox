import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { afterEach, describe, expect, test } from 'vitest';

const tempDirs: string[] = [];

async function makeTempSocketPath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-browser-test-'));
  tempDirs.push(directory);
  return path.join(directory, 'browser.sock');
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve(undefined)));
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('Browser Use native pipe framing', () => {
  test('encodes and decodes length-prefixed JSON frames', async () => {
    const { decodeNativeFrames, encodeNativeFrame } = await import('./browser-use-protocol.mjs');
    const first = encodeNativeFrame({ jsonrpc: '2.0', id: 1, method: 'getInfo' });
    const second = encodeNativeFrame({ jsonrpc: '2.0', id: 1, result: { type: 'extension' } });

    const partial = decodeNativeFrames(Buffer.concat([first, second.subarray(0, 5)]));

    expect(partial.frames).toEqual([{ jsonrpc: '2.0', id: 1, method: 'getInfo' }]);
    expect(partial.rest).toEqual(second.subarray(0, 5));

    const complete = decodeNativeFrames(Buffer.concat([partial.rest, second.subarray(5)]));
    expect(complete.frames).toEqual([{ jsonrpc: '2.0', id: 1, result: { type: 'extension' } }]);
    expect(complete.rest).toHaveLength(0);
  });
});

describe('Browser Use socket client', () => {
  test('sends session-scoped requests and resolves matching responses', async () => {
    const { BrowserUseSocketClient, decodeNativeFrames, encodeNativeFrame } =
      await import('./browser-use-protocol.mjs');
    const socketPath = await makeTempSocketPath();
    const seen: unknown[] = [];
    const server = net.createServer((socket) => {
      let pending = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        const decoded = decodeNativeFrames(Buffer.concat([pending, chunk]));
        pending = decoded.rest;
        for (const frame of decoded.frames) {
          seen.push(frame);
          socket.write(
            encodeNativeFrame({
              jsonrpc: '2.0',
              id: frame.id,
              result: { ok: true, echoMethod: frame.method },
            }),
          );
        }
      });
    });
    await listen(server, socketPath);
    const client = new BrowserUseSocketClient({
      sessionId: 'session-1',
      socketPath,
      turnId: 'turn-1',
    } as any);

    await client.connect();
    const result = await client.request('getUserTabs', {});
    await client.close();

    expect(result).toEqual({ ok: true, echoMethod: 'getUserTabs' });
    expect(seen).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getUserTabs',
        params: { session_id: 'session-1', turn_id: 'turn-1' },
      },
    ]);

    await closeServer(server);
  });
});

describe('Browser backend discovery', () => {
  test('keeps extension backends and reports non-extension candidates', async () => {
    const { selectChromeBackends } = await import('./browser-use-protocol.mjs');

    const result = selectChromeBackends([
      {
        ok: true,
        socketPath: '/tmp/one.sock',
        info: { type: 'iab', name: 'In-app Browser', metadata: { codexSessionId: 'abc' } },
      },
      {
        ok: true,
        socketPath: '/tmp/two.sock',
        info: { type: 'extension', name: 'Chrome', metadata: { extensionId: 'ext' } },
      },
      {
        ok: false,
        socketPath: '/tmp/bad.sock',
        error: 'closed',
      },
    ]);

    expect(result.selected).toEqual([
      {
        ok: true,
        socketPath: '/tmp/two.sock',
        info: { type: 'extension', name: 'Chrome', metadata: { extensionId: 'ext' } },
      },
    ]);
    expect(result.candidates).toHaveLength(3);
  });
});
