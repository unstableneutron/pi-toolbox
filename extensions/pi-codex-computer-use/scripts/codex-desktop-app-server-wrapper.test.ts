import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

class MockSocket extends EventEmitter {
  writes: Buffer[] = [];
  ended = false;

  write(chunk: Buffer | string): boolean {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  end(): void {
    this.ended = true;
  }
}

const tempDirs: string[] = [];

async function makeTempSocketPath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-codex-wrapper-test-'));
  tempDirs.push(directory);
  return path.join(directory, 'app-server.sock');
}

function encodeServerTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length >= 126) throw new Error('test helper only supports short frames');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null }> {
  return await new Promise((resolve) => {
    child.once('exit', (code) => resolve({ code }));
  });
}

async function waitForFileText(filePath: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

async function waitForOutput(chunks: Buffer[], expected: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (Buffer.concat(chunks).toString('utf8') === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(Buffer.concat(chunks).toString('utf8')).toBe(expected);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('codex desktop app-server wrapper planning', () => {
  test('inserts a Unix listener for Desktop app-server argv', async () => {
    const { buildWrapperPlan } = await import('./codex-desktop-app-server-wrapper.mjs');

    const plan = buildWrapperPlan(['app-server', '--analytics-default-enabled'], {
      PI_CODEX_DESKTOP_REAL_CODEX: '/Applications/Codex.app/Contents/Resources/codex',
      PI_CODEX_DESKTOP_APP_SERVER_SOCKET: '/tmp/codex-desktop.sock',
    });

    expect(plan).toEqual({
      mode: 'bridge-app-server',
      realCodexPath: '/Applications/Codex.app/Contents/Resources/codex',
      realArgs: [
        'app-server',
        '--listen',
        'unix:///tmp/codex-desktop.sock',
        '--analytics-default-enabled',
      ],
      socketPath: '/tmp/codex-desktop.sock',
    });
  });

  test('replaces any existing --listen option instead of adding a second one', async () => {
    const { buildRealAppServerArgs } = await import('./codex-desktop-app-server-wrapper.mjs');

    expect(
      buildRealAppServerArgs(
        ['app-server', '--listen', 'stdio://', '--analytics-default-enabled'],
        '/tmp/desktop.sock',
      ),
    ).toEqual([
      'app-server',
      '--listen',
      'unix:///tmp/desktop.sock',
      '--analytics-default-enabled',
    ]);
    expect(
      buildRealAppServerArgs(
        ['app-server', '--listen=stdio://', '--analytics-default-enabled'],
        '/tmp/desktop.sock',
      ),
    ).toEqual([
      'app-server',
      '--listen',
      'unix:///tmp/desktop.sock',
      '--analytics-default-enabled',
    ]);
  });

  test('passes through non app-server commands to the real Codex binary', async () => {
    const { buildWrapperPlan } = await import('./codex-desktop-app-server-wrapper.mjs');

    const plan = buildWrapperPlan(['--version'], {
      PI_CODEX_DESKTOP_REAL_CODEX: '/real/codex',
      PI_CODEX_DESKTOP_APP_SERVER_SOCKET: '/tmp/unused.sock',
    });

    expect(plan).toEqual({
      mode: 'passthrough',
      realCodexPath: '/real/codex',
      realArgs: ['--version'],
    });
  });
});

describe('codex desktop app-server wrapper WebSocket transport', () => {
  test('connects to a Unix socket with a WebSocket upgrade request', async () => {
    const { connectWebSocketUnix } = await import('./codex-desktop-app-server-wrapper.mjs');
    const socketPath = await makeTempSocketPath();
    let observedRequest = '';

    const server = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        observedRequest = chunk.toString('utf8');
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
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const socket = await connectWebSocketUnix(socketPath, { timeoutMs: 1_000 });
    socket.destroy();
    server.close();

    expect(observedRequest).toContain('GET / HTTP/1.1\r\n');
    expect(observedRequest).toContain('Upgrade: websocket\r\n');
    expect(observedRequest).toContain('Connection: Upgrade\r\n');
    expect(observedRequest).toContain('Sec-WebSocket-Key:');
  });

  test('preserves WebSocket frame bytes coalesced with the upgrade response', async () => {
    const { bridgeStdioToWebSocket, connectWebSocketUnix } =
      await import('./codex-desktop-app-server-wrapper.mjs');
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
            encodeServerTextFrame('{"id":1,"result":{}}'),
          ]),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const socket = await connectWebSocketUnix(socketPath, { timeoutMs: 1_000 });
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    const bridge = bridgeStdioToWebSocket(socket, new PassThrough(), stdout);

    await waitForOutput(chunks, '{"id":1,"result":{}}\n');

    bridge.dispose();
    socket.destroy();
    server.close();
  });
});

describe('codex desktop app-server wrapper CLI lifecycle', () => {
  test('kills the real app-server process if bridge setup fails', async () => {
    const socketPath = await makeTempSocketPath();
    const directory = path.dirname(socketPath);
    const fakeCodexPath = path.join(directory, 'fake-codex.mjs');
    const signalPath = path.join(directory, 'fake-codex-signal.txt');
    const startedPath = path.join(directory, 'fake-codex-started.txt');
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(startedPath)}, 'STARTED');
process.on('SIGTERM', () => {
  writeFileSync(${JSON.stringify(signalPath)}, 'SIGTERM');
  process.exit(0);
});
setInterval(() => {}, 1_000);
`,
    );
    await chmod(fakeCodexPath, 0o755);

    const wrapperPath = fileURLToPath(
      new URL('./codex-desktop-app-server-wrapper.mjs', import.meta.url),
    );
    const child = spawn(process.execPath, [wrapperPath, 'app-server'], {
      env: {
        ...process.env,
        PI_CODEX_DESKTOP_APP_SERVER_SOCKET: socketPath,
        PI_CODEX_DESKTOP_CONNECT_TIMEOUT_MS: '1000',
        PI_CODEX_DESKTOP_REAL_CODEX: fakeCodexPath,
      },
      stdio: 'ignore',
    });

    await expect(waitForFileText(startedPath)).resolves.toBe('STARTED');
    const exit = await waitForExit(child);

    expect(exit.code).toBe(1);
    await expect(waitForFileText(signalPath)).resolves.toBe('SIGTERM');
  });

  test('reports passthrough spawn errors instead of waiting forever', async () => {
    const wrapperPath = fileURLToPath(
      new URL('./codex-desktop-app-server-wrapper.mjs', import.meta.url),
    );
    const child = spawn(process.execPath, [wrapperPath, '--version'], {
      env: {
        ...process.env,
        PI_CODEX_DESKTOP_REAL_CODEX: '/definitely/not/a/codex/binary',
      },
      stdio: 'ignore',
    });

    const exit = await waitForExit(child);

    expect(exit.code).toBe(1);
  });
});

describe('codex desktop app-server wrapper stdio bridge', () => {
  test('forwards newline-delimited stdin messages as masked WebSocket text frames', async () => {
    const { bridgeStdioToWebSocket } = await import('./codex-desktop-app-server-wrapper.mjs');
    const { decodeWebSocketFrames } = await import('./codex-control.mjs');
    const socket = new MockSocket();
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const bridge = bridgeStdioToWebSocket(socket, stdin, stdout);
    stdin.write('{"id":1,"method":"initialize"}\n');
    bridge.dispose();

    expect(socket.writes).toHaveLength(1);
    const decoded = decodeWebSocketFrames(socket.writes[0]);
    expect(decoded.rest).toHaveLength(0);
    expect(decoded.frames).toMatchObject([
      { opcode: 1, masked: true, text: '{"id":1,"method":"initialize"}' },
    ]);
  });

  test('forwards WebSocket text frames as newline-delimited stdout messages', async () => {
    const { bridgeStdioToWebSocket } = await import('./codex-desktop-app-server-wrapper.mjs');
    const socket = new MockSocket();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));

    const bridge = bridgeStdioToWebSocket(socket, stdin, stdout);
    socket.emit('data', encodeServerTextFrame('{"id":1,"result":{}}'));
    bridge.dispose();

    expect(Buffer.concat(chunks).toString('utf8')).toBe('{"id":1,"result":{}}\n');
  });
});
