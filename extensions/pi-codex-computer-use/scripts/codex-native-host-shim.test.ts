import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

const tempDirs: string[] = [];

function encodeNativeMessageFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function decodeNativeMessageFramesForTest(buffer: Buffer): unknown[] {
  const messages: unknown[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    if (buffer.length - offset - 4 < length) break;
    messages.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + length).toString('utf8')));
    offset += 4 + length;
  }
  return messages;
}

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-codex-native-shim-test-'));
  tempDirs.push(directory);
  return directory;
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

async function waitForStdoutBytes(chunks: Buffer[]): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (chunks.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for stdout bytes');
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('codex native host shim framing', () => {
  test('decodes coalesced and partial native messaging frames', async () => {
    const { decodeNativeMessageFrames } = await import('./codex-native-host-shim.mjs');
    const first = encodeNativeMessageFrame({ jsonrpc: '2.0', id: 'native-host:1', method: 'ping' });
    const second = encodeNativeMessageFrame({ jsonrpc: '2.0', id: 'native-host:1', result: {} });

    const partial = Buffer.concat([first, second.subarray(0, 6)]);
    const decoded = decodeNativeMessageFrames(partial);

    expect(decoded.frames).toHaveLength(1);
    expect((decoded.frames[0] as any).json).toEqual({
      jsonrpc: '2.0',
      id: 'native-host:1',
      method: 'ping',
    });
    expect(decoded.rest).toEqual(second.subarray(0, 6));

    const completed = decodeNativeMessageFrames(Buffer.concat([decoded.rest, second.subarray(6)]));
    expect((completed.frames[0] as any).json).toEqual({
      jsonrpc: '2.0',
      id: 'native-host:1',
      result: {},
    });
    expect(completed.rest).toHaveLength(0);
  });

  test('summarizes methods, ids, and truncated payload previews', async () => {
    const { decodeNativeMessageFrames, summarizeNativeMessage } =
      await import('./codex-native-host-shim.mjs');
    const [frame] = decodeNativeMessageFrames(
      encodeNativeMessageFrame({
        jsonrpc: '2.0',
        id: 7,
        method: 'large',
        params: { text: 'x'.repeat(100) },
      }),
    ).frames;

    const summary = summarizeNativeMessage('extension->host', frame, {
      maxPayloadChars: 60,
      now: () => new Date('2026-06-05T00:00:00.000Z'),
    });

    expect(summary).toMatchObject({
      direction: 'extension->host',
      id: 7,
      isJson: true,
      method: 'large',
      payloadTruncated: true,
      ts: '2026-06-05T00:00:00.000Z',
    });
    expect((summary as any).payloadPreview).toContain('"method":"large"');
    expect((summary as any).payload).toBeUndefined();
  });
});

describe('codex native host shim process', () => {
  test('starts the real host in its own directory', async () => {
    const directory = await makeTempDir();
    const hostDirectory = path.join(directory, 'host-dir');
    const fakeHostPath = path.join(hostDirectory, 'fake-native-host-cwd.mjs');
    const logPath = path.join(directory, 'native-host-cwd.jsonl');
    const cwdPath = path.join(directory, 'cwd.txt');
    await mkdir(hostDirectory, { recursive: true });
    await writeFile(
      fakeHostPath,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(cwdPath)}, process.cwd());
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`,
    );
    await chmod(fakeHostPath, 0o755);

    const shimPath = fileURLToPath(new URL('./codex-native-host-shim.mjs', import.meta.url));
    const child = spawn(process.execPath, [shimPath, 'chrome-extension://test-extension/'], {
      env: {
        ...process.env,
        PI_CODEX_NATIVE_HOST_SHIM_LOG: logPath,
        PI_CODEX_NATIVE_HOST_SHIM_REAL_HOST: fakeHostPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end();

    await expect(waitForExit(child)).resolves.toEqual({ code: 0 });
    await expect(waitForFileText(cwdPath)).resolves.toBe(await realpath(hostDirectory));
  });

  test('supplies default Codex browser env to the real host', async () => {
    const directory = await makeTempDir();
    const fakeHostPath = path.join(directory, 'fake-native-host-env.mjs');
    const envPath = path.join(directory, 'env.json');
    const logPath = path.join(directory, 'native-host-env.jsonl');
    await writeFile(
      fakeHostPath,
      `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({
  BROWSER_USE_CODEX_APP_BUILD_FLAVOR: process.env.BROWSER_USE_CODEX_APP_BUILD_FLAVOR,
  BROWSER_USE_CODEX_APP_VERSION: process.env.BROWSER_USE_CODEX_APP_VERSION,
  CODEX_HOME: process.env.CODEX_HOME,
}));
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`,
    );
    await chmod(fakeHostPath, 0o755);

    const shimPath = fileURLToPath(new URL('./codex-native-host-shim.mjs', import.meta.url));
    const child = spawn(process.execPath, [shimPath, 'chrome-extension://test-extension/'], {
      env: {
        HOME: '/Users/tester',
        PATH: process.env.PATH,
        PI_CODEX_NATIVE_HOST_SHIM_LOG: logPath,
        PI_CODEX_NATIVE_HOST_SHIM_REAL_HOST: fakeHostPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end();

    await expect(waitForExit(child)).resolves.toEqual({ code: 0 });
    await expect(waitForFileText(envPath)).resolves.toBe(
      JSON.stringify({
        BROWSER_USE_CODEX_APP_BUILD_FLAVOR: 'prod',
        BROWSER_USE_CODEX_APP_VERSION: '26.602.30954',
        CODEX_HOME: '/Users/tester/.codex',
      }),
    );
  });

  test('logs native host stderr chunks while preserving stderr forwarding', async () => {
    const directory = await makeTempDir();
    const fakeHostPath = path.join(directory, 'fake-native-host-stderr.mjs');
    const logPath = path.join(directory, 'native-host-stderr.jsonl');
    await writeFile(
      fakeHostPath,
      `#!/usr/bin/env node
process.stderr.write('extension-host diagnostic\\nsecond line');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`,
    );
    await chmod(fakeHostPath, 0o755);

    const shimPath = fileURLToPath(new URL('./codex-native-host-shim.mjs', import.meta.url));
    const child = spawn(process.execPath, [shimPath, 'chrome-extension://test-extension/'], {
      env: {
        ...process.env,
        PI_CODEX_NATIVE_HOST_SHIM_LOG: logPath,
        PI_CODEX_NATIVE_HOST_SHIM_REAL_HOST: fakeHostPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));

    child.stdin.end();

    await expect(waitForExit(child)).resolves.toEqual({ code: 0 });
    expect(Buffer.concat(stderrChunks).toString('utf8')).toBe(
      'extension-host diagnostic\nsecond line',
    );

    const logLines = (await waitForFileText(logPath))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(logLines).toContainEqual(
      expect.objectContaining({
        event: 'child-stderr',
        text: 'extension-host diagnostic\nsecond line',
      }),
    );
  });

  test('forwards native messaging frames and logs both directions', async () => {
    const directory = await makeTempDir();
    const fakeHostPath = path.join(directory, 'fake-native-host.mjs');
    const logPath = path.join(directory, 'native-host.jsonl');
    await writeFile(
      fakeHostPath,
      `#!/usr/bin/env node
let buffer = Buffer.alloc(0);
function encode(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length - 4 < length) return;
    const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
    buffer = buffer.subarray(4 + length);
    process.stdout.write(encode({ jsonrpc: '2.0', id: message.id, result: { argv: process.argv.slice(2), seen: message.method } }));
  }
});
`,
    );
    await chmod(fakeHostPath, 0o755);

    const shimPath = fileURLToPath(new URL('./codex-native-host-shim.mjs', import.meta.url));
    const child = spawn(process.execPath, [shimPath, 'chrome-extension://test-extension/'], {
      env: {
        ...process.env,
        PI_CODEX_NATIVE_HOST_SHIM_LOG: logPath,
        PI_CODEX_NATIVE_HOST_SHIM_MAX_PAYLOAD_CHARS: '1000',
        PI_CODEX_NATIVE_HOST_SHIM_REAL_HOST: fakeHostPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));

    child.stdin.end(
      encodeNativeMessageFrame({
        jsonrpc: '2.0',
        id: 'native-host:1',
        method: 'ensureCodexAppServer',
      }),
    );

    await expect(waitForExit(child)).resolves.toEqual({ code: 0 });
    expect(stderrChunks.map((chunk) => chunk.toString('utf8')).join('')).toBe('');
    expect(decodeNativeMessageFramesForTest(Buffer.concat(stdoutChunks))).toEqual([
      {
        jsonrpc: '2.0',
        id: 'native-host:1',
        result: {
          argv: ['chrome-extension://test-extension/'],
          seen: 'ensureCodexAppServer',
        },
      },
    ]);

    const logLines = (await waitForFileText(logPath))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(logLines.map((line) => line.event ?? line.direction)).toEqual([
      'shim-start',
      'extension->host',
      'host->extension',
      'child-exit',
    ]);
    expect(logLines[1]).toMatchObject({
      direction: 'extension->host',
      method: 'ensureCodexAppServer',
    });
    expect(logLines[2]).toMatchObject({ direction: 'host->extension', id: 'native-host:1' });
  });

  test('can fake extension getInfo replies for protocol debugging', async () => {
    const directory = await makeTempDir();
    const fakeHostPath = path.join(directory, 'fake-native-host-get-info.mjs');
    const logPath = path.join(directory, 'native-host-get-info.jsonl');
    await writeFile(
      fakeHostPath,
      `#!/usr/bin/env node
function encode(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}
let buffer = Buffer.alloc(0);
process.stdout.write(encode({ jsonrpc: '2.0', id: 'native-host:1:1', method: 'getInfo' }));
const timer = setTimeout(() => process.exit(2), 500);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length - 4 < length) return;
    const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
    buffer = buffer.subarray(4 + length);
    clearTimeout(timer);
    process.stdout.write(encode({
      jsonrpc: '2.0',
      id: 'after-get-info',
      method: 'nextProtocolStep',
      params: {
        extensionId: message.result?.metadata?.extensionId,
        version: message.result?.version,
      },
    }));
    process.exit(0);
  }
});
`,
    );
    await chmod(fakeHostPath, 0o755);

    const shimPath = fileURLToPath(new URL('./codex-native-host-shim.mjs', import.meta.url));
    const child = spawn(process.execPath, [shimPath, 'chrome-extension://test-extension/'], {
      env: {
        ...process.env,
        PI_CODEX_NATIVE_HOST_SHIM_FAKE_GET_INFO: '1',
        PI_CODEX_NATIVE_HOST_SHIM_LOG: logPath,
        PI_CODEX_NATIVE_HOST_SHIM_REAL_HOST: fakeHostPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));

    await waitForStdoutBytes(stdoutChunks);
    child.stdin.end();

    await expect(waitForExit(child)).resolves.toEqual({ code: 0 });
    expect(decodeNativeMessageFramesForTest(Buffer.concat(stdoutChunks))).toEqual([
      {
        jsonrpc: '2.0',
        id: 'after-get-info',
        method: 'nextProtocolStep',
        params: {
          extensionId: 'test-extension',
          version: '1.1.5',
        },
      },
    ]);

    const logLines = (await waitForFileText(logPath))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(logLines).toContainEqual(
      expect.objectContaining({
        event: 'fake-get-info-reply',
        id: 'native-host:1:1',
      }),
    );
  });

  test('can rewrite Target.closeTarget to finalizeTabs for protocol debugging', async () => {
    const directory = await makeTempDir();
    const fakeHostPath = path.join(directory, 'fake-native-host-close-target.mjs');
    const logPath = path.join(directory, 'native-host-close-target.jsonl');
    await writeFile(
      fakeHostPath,
      `#!/usr/bin/env node
function encode(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}
let buffer = Buffer.alloc(0);
process.stdout.write(encode({
  jsonrpc: '2.0',
  id: 'native-host:1:close',
  method: 'executeCdp',
  params: {
    commandParams: { targetId: 'target-abc' },
    method: 'Target.closeTarget',
    session_id: 'session-1',
    target: { tabId: 123 },
    turn_id: 'turn-1',
  },
}));
const timer = setTimeout(() => process.exit(2), 500);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (buffer.length - 4 < length) return;
    const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
    buffer = buffer.subarray(4 + length);
    if (message.id === 'native-host:1:close') {
      clearTimeout(timer);
      process.exit(message.result?.ok === true ? 0 : 3);
    }
  }
});
`,
    );
    await chmod(fakeHostPath, 0o755);

    const shimPath = fileURLToPath(new URL('./codex-native-host-shim.mjs', import.meta.url));
    const child = spawn(process.execPath, [shimPath, 'chrome-extension://test-extension/'], {
      env: {
        ...process.env,
        PI_CODEX_NATIVE_HOST_SHIM_LOG: logPath,
        PI_CODEX_NATIVE_HOST_SHIM_REAL_HOST: fakeHostPath,
        PI_CODEX_NATIVE_HOST_SHIM_REWRITE_CLOSE_TARGET_TO_FINALIZE_TABS: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));

    await waitForStdoutBytes(stdoutChunks);
    const [rewrittenFrame] = decodeNativeMessageFramesForTest(Buffer.concat(stdoutChunks));
    expect(rewrittenFrame).toEqual({
      jsonrpc: '2.0',
      id: 'native-host:1:close',
      method: 'finalizeTabs',
      params: {
        keep: [],
        session_id: 'session-1',
        turn_id: 'turn-1',
      },
    });

    child.stdin.end(
      encodeNativeMessageFrame({
        jsonrpc: '2.0',
        id: 'native-host:1:close',
        result: { ok: true },
      }),
    );

    await expect(waitForExit(child)).resolves.toEqual({ code: 0 });
    const logLines = (await waitForFileText(logPath))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(logLines).toContainEqual(
      expect.objectContaining({
        event: 'rewrite-close-target-to-finalize-tabs',
        id: 'native-host:1:close',
        tabId: 123,
        targetId: 'target-abc',
      }),
    );
  });
});
