#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_REAL_CODEX_PATH = '/Applications/Codex.app/Contents/Resources/codex';
const DEFAULT_SOCKET_PATH = path.join(
  os.homedir(),
  '.codex',
  'pi-codex-desktop',
  'app-server.sock',
);
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const CONNECT_RETRY_DELAY_MS = 50;

/**
 * @typedef {object} BridgeSocket
 * @property {(chunk: Buffer | string) => boolean} write
 * @property {() => void} end
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} off
 */

function encodeClientFrame(opcode, payload) {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = payloadBuffer.length;
  let header;
  let maskOffset;

  if (length < 126) {
    header = Buffer.alloc(2 + 4);
    header[1] = 0x80 | length;
    maskOffset = 2;
  } else if (length < 65_536) {
    header = Buffer.alloc(4 + 4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
    maskOffset = 4;
  } else {
    header = Buffer.alloc(10 + 4);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
    maskOffset = 10;
  }

  header[0] = 0x80 | opcode;
  crypto.randomFillSync(header, maskOffset, 4);
  const mask = header.subarray(maskOffset, maskOffset + 4);
  const frame = Buffer.alloc(header.length + length);
  header.copy(frame, 0);
  for (let index = 0; index < length; index++) {
    frame[header.length + index] = payloadBuffer[index] ^ mask[index % 4];
  }
  return frame;
}

function encodeClientTextFrame(text) {
  return encodeClientFrame(0x1, Buffer.from(text));
}

function encodeClientPongFrame(payload) {
  return encodeClientFrame(0xa, payload);
}

function decodeWebSocketFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (buffer.length - offset >= 2) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    const fin = (firstByte & 0x80) !== 0;
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

    let mask;
    if (masked) {
      if (buffer.length - cursor < 4) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }

    if (buffer.length - cursor < length) break;

    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) {
      for (let index = 0; index < payload.length; index++) {
        payload[index] ^= mask[index % 4];
      }
    }

    frames.push({
      fin,
      masked,
      opcode,
      payload,
      ...(opcode === 0x1 ? { text: payload.toString('utf8') } : {}),
    });
    offset = cursor + length;
  }

  return { frames, rest: buffer.subarray(offset) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unixListenUrl(socketPath) {
  return `unix://${socketPath}`;
}

function readEnvPath(env, primary, fallback) {
  const value = env[primary]?.trim() || (fallback ? env[fallback]?.trim() : undefined);
  return value && value.length > 0 ? value : undefined;
}

function getConnectTimeoutMs(env = process.env) {
  const raw = env.PI_CODEX_DESKTOP_CONNECT_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_CONNECT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONNECT_TIMEOUT_MS;
}

export function buildRealAppServerArgs(argv, socketPath) {
  const rewritten = ['app-server', '--listen', unixListenUrl(socketPath)];
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--listen') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--listen=')) continue;
    rewritten.push(arg);
  }
  return rewritten;
}

export function buildWrapperPlan(argv = process.argv.slice(2), env = process.env) {
  const realCodexPath =
    readEnvPath(env, 'PI_CODEX_DESKTOP_REAL_CODEX', 'CODEX_DESKTOP_REAL_CODEX') ??
    DEFAULT_REAL_CODEX_PATH;
  if (argv[0] !== 'app-server') {
    return { mode: 'passthrough', realCodexPath, realArgs: [...argv] };
  }

  const socketPath =
    readEnvPath(env, 'PI_CODEX_DESKTOP_APP_SERVER_SOCKET', 'CODEX_DESKTOP_APP_SERVER_SOCKET') ??
    DEFAULT_SOCKET_PATH;
  return {
    mode: 'bridge-app-server',
    realCodexPath,
    realArgs: buildRealAppServerArgs(argv, socketPath),
    socketPath,
  };
}

export async function connectWebSocketUnix(
  socketPath,
  { timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {},
) {
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to ${socketPath}`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const key = crypto.randomBytes(16).toString('base64');
  socket.write(
    [
      'GET / HTTP/1.1',
      'Host: localhost',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'),
  );

  await new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for WebSocket upgrade from ${socketPath}`));
    }, timeoutMs);
    const onData = (chunk) => {
      chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const headerEnd = raw.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      socket.off('data', onData);
      clearTimeout(timer);
      const header = raw.subarray(0, headerEnd).toString('utf8');
      if (!header.includes('101 Switching Protocols')) {
        socket.destroy();
        reject(new Error(`WebSocket upgrade failed: ${header}`));
        return;
      }
      const rest = raw.subarray(headerEnd + 4);
      if (rest.length > 0) socket.unshift(rest);
      resolve();
    };
    socket.on('data', onData);
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  return socket;
}

async function connectWebSocketUnixWithRetry(
  socketPath,
  childProcess,
  { timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, getChildError = () => undefined } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() <= deadline) {
    const childError = getChildError();
    if (childError) throw childError;
    if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
      throw new Error(
        `Codex app-server exited before socket became ready (${childProcess.exitCode ?? childProcess.signalCode})`,
      );
    }
    try {
      return await connectWebSocketUnix(socketPath, {
        timeoutMs: Math.min(1_000, Math.max(100, deadline - Date.now())),
      });
    } catch (error) {
      lastError = error;
      await sleep(CONNECT_RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `Timed out waiting for Codex app-server socket ${socketPath}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

/**
 * Bridge newline-delimited JSON-RPC stdio messages to WebSocket text frames.
 *
 * @param {BridgeSocket} socket
 * @param {NodeJS.ReadableStream} [stdin]
 * @param {NodeJS.WritableStream} [stdout]
 * @returns {{ dispose(): void }}
 */
export function bridgeStdioToWebSocket(socket, stdin = process.stdin, stdout = process.stdout) {
  let stdinBuffer = '';
  let socketBuffer = Buffer.alloc(0);
  const disposers = [];

  const sendLine = (line) => {
    if (line.trim().length === 0) return;
    socket.write(encodeClientTextFrame(line));
  };

  const onStdinData = (chunk) => {
    stdinBuffer += chunk.toString('utf8');
    const lines = stdinBuffer.split('\n');
    stdinBuffer = lines.pop() ?? '';
    for (const line of lines) sendLine(line.replace(/\r$/, ''));
  };
  const onStdinEnd = () => {
    if (stdinBuffer.length > 0) sendLine(stdinBuffer.replace(/\r$/, ''));
    socket.end();
  };
  const onSocketData = (chunk) => {
    socketBuffer = Buffer.concat([socketBuffer, chunk]);
    const decoded = decodeWebSocketFrames(socketBuffer);
    socketBuffer = decoded.rest;
    for (const frame of decoded.frames) {
      if (frame.opcode === 0x9) {
        socket.write(encodeClientPongFrame(frame.payload));
      } else if (frame.opcode === 0x1 && frame.text !== undefined) {
        stdout.write(`${frame.text}\n`);
      } else if (frame.opcode === 0x8) {
        socket.end();
      }
    }
  };

  stdin.setEncoding('utf8');
  stdin.on('data', onStdinData);
  stdin.on('end', onStdinEnd);
  socket.on('data', onSocketData);
  disposers.push(() => stdin.off('data', onStdinData));
  disposers.push(() => stdin.off('end', onStdinEnd));
  disposers.push(() => socket.off('data', onSocketData));
  return {
    dispose() {
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}

async function runPassthrough(plan) {
  const child = spawn(plan.realCodexPath, plan.realArgs, { stdio: 'inherit', env: process.env });
  await new Promise((resolve) => child.once('exit', resolve));
  if (child.signalCode) process.kill(process.pid, child.signalCode);
  process.exitCode = child.exitCode ?? 1;
}

function killChildIfRunning(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

async function runBridge(plan) {
  mkdirSync(path.dirname(plan.socketPath), { recursive: true, mode: 0o700 });
  const child = spawn(plan.realCodexPath, plan.realArgs, {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: process.env,
  });
  let childSpawnError;
  child.once('error', (error) => {
    childSpawnError = error;
  });
  child.stderr?.on('data', (chunk) => process.stderr.write(chunk));

  let socket;
  let bridge;
  try {
    socket = await connectWebSocketUnixWithRetry(plan.socketPath, child, {
      timeoutMs: getConnectTimeoutMs(),
      getChildError: () => childSpawnError,
    });
    bridge = bridgeStdioToWebSocket(socket);
  } catch (error) {
    socket?.destroy();
    killChildIfRunning(child);
    throw error;
  }

  const closeAll = () => {
    bridge.dispose();
    socket.destroy();
    killChildIfRunning(child);
  };
  process.once('SIGINT', closeAll);
  process.once('SIGTERM', closeAll);
  socket.once('close', () => {
    killChildIfRunning(child);
  });
  child.once('exit', (code, signal) => {
    bridge.dispose();
    socket.destroy();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

export async function runWrapper(argv = process.argv.slice(2), env = process.env) {
  const plan = buildWrapperPlan(argv, env);
  if (plan.mode === 'passthrough') {
    await runPassthrough(plan);
    return;
  }
  await runBridge(plan);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWrapper().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
