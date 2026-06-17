import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { afterEach, describe, expect, test } from 'vitest';

const tempDirs: string[] = [];

async function makeTempSocketPath(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-browser-bridge-test-'));
  tempDirs.push(directory);
  return path.join(directory, name);
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve(undefined)));
  });
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('codex-browser bridge', () => {
  test('lists Chrome tabs through a Browser Use backend socket', async () => {
    const { decodeNativeFrames, encodeNativeFrame } = await import('./browser-use-protocol.mjs');
    const { sendBridgeCommand, startCodexBrowserBridge } =
      await import('./codex-browser-bridge.mjs');
    const browserSocketPath = await makeTempSocketPath('browser.sock');
    const bridgeSocketPath = await makeTempSocketPath('bridge.sock');
    const seen: unknown[] = [];
    const browserServer = net.createServer((socket) => {
      let pending = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        const decoded = decodeNativeFrames(Buffer.concat([pending, chunk]));
        pending = decoded.rest;
        for (const frame of decoded.frames) {
          seen.push(frame);
          const result =
            frame.method === 'getInfo'
              ? { type: 'extension', name: 'Chrome' }
              : [
                  {
                    id: 123,
                    title: 'Example',
                    url: 'https://example.com/',
                  },
                ];
          socket.write(encodeNativeFrame({ jsonrpc: '2.0', id: frame.id, result }));
        }
      });
    });
    await listen(browserServer, browserSocketPath);
    const bridge = await startCodexBrowserBridge({
      bridgeSocketPath,
      browserSocketPath,
      requestMeta: { session_id: 'session-1', turn_id: 'turn-1' },
    });

    const result = await sendBridgeCommand(bridgeSocketPath, 'chrome_tabs_list', { limit: 5 });
    const rawResult = await sendBridgeCommand(bridgeSocketPath, 'raw', {
      method: 'getUserTabs',
      params: {},
    });
    await bridge.close();
    await closeServer(browserServer);

    expect(result).toEqual({
      tabs: [{ id: 123, title: 'Example', url: 'https://example.com/' }],
      totalTabs: 1,
      transport: 'node-repl-bridge-raw-rpc',
    });
    expect(rawResult).toEqual({
      method: 'getUserTabs',
      result: [{ id: 123, title: 'Example', url: 'https://example.com/' }],
      transport: 'node-repl-bridge-raw-rpc',
    });
    expect(seen).toContainEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'getInfo',
      params: { session_id: 'session-1', turn_id: 'turn-1' },
    });
    expect(seen).toContainEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'getUserTabs',
      params: { session_id: 'session-1', turn_id: 'turn-1' },
    });
  });

  test('navigates a newly created tab with raw CDP', async () => {
    const { decodeNativeFrames, encodeNativeFrame } = await import('./browser-use-protocol.mjs');
    const { sendBridgeCommand, startCodexBrowserBridge } =
      await import('./codex-browser-bridge.mjs');
    const browserSocketPath = await makeTempSocketPath('browser.sock');
    const bridgeSocketPath = await makeTempSocketPath('bridge.sock');
    const methods: string[] = [];
    const browserServer = net.createServer((socket) => {
      let pending = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        const decoded = decodeNativeFrames(Buffer.concat([pending, chunk]));
        pending = decoded.rest;
        for (const frame of decoded.frames) {
          methods.push(frame.method);
          let result: unknown = {};
          if (frame.method === 'getInfo') result = { type: 'extension', name: 'Chrome' };
          if (frame.method === 'createTab') result = { id: 456, title: '', url: '' };
          if (frame.method === 'getTabs') {
            result = [{ id: 456, title: 'Example', url: 'https://example.com/' }];
          }
          if (frame.method === 'executeCdp' && frame.params.method === 'Runtime.evaluate') {
            result = {
              result: {
                value: {
                  href: 'https://example.com/',
                  readyState: 'complete',
                  title: 'Example',
                },
              },
            };
          }
          socket.write(encodeNativeFrame({ jsonrpc: '2.0', id: frame.id, result }));
        }
      });
    });
    await listen(browserServer, browserSocketPath);
    const bridge = await startCodexBrowserBridge({
      bridgeSocketPath,
      browserSocketPath,
      requestMeta: { session_id: 'session-1', turn_id: 'turn-1' },
    });

    const result = await sendBridgeCommand(bridgeSocketPath, 'chrome_tab_goto', {
      url: 'https://example.com/',
    });
    await bridge.close();
    await closeServer(browserServer);

    expect(result.tab).toEqual({ id: 456, title: 'Example', url: 'https://example.com/' });
    expect(result.state).toEqual({
      href: 'https://example.com/',
      readyState: 'complete',
      title: 'Example',
    });
    expect(methods).toEqual([
      'getInfo',
      'createTab',
      'attach',
      'executeCdp',
      'executeCdp',
      'getTabs',
    ]);
  });
});
