#!/usr/bin/env node
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_SOCKET_PATH = path.join(
  os.homedir(),
  '.codex/app-server-control/app-server-control.sock',
);
const DEFAULT_BROWSER_CLIENT_PATH = path.join(
  os.homedir(),
  '.codex/plugins/cache/openai-bundled/browser/26.527.31326/scripts/browser-client.mjs',
);
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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

export function encodeClientTextFrame(text) {
  return encodeClientFrame(0x1, Buffer.from(text));
}

function encodeClientPongFrame(payload) {
  return encodeClientFrame(0xa, payload);
}

export function decodeWebSocketFrames(buffer) {
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

export function getMcpText(rawResult) {
  if (!Array.isArray(rawResult?.content)) return JSON.stringify(rawResult ?? null);
  return rawResult.content
    .map((part) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

function parseJsonArgument(value, fallback) {
  if (value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON argument: ${message}`);
  }
}

function parseTrailingJson(text) {
  const newlineObjectStart = text.lastIndexOf('\n{');
  const candidates = [newlineObjectStart >= 0 ? text.slice(newlineObjectStart + 1) : undefined];
  const firstObjectStart = text.indexOf('{');
  if (firstObjectStart >= 0) candidates.push(text.slice(firstObjectStart));

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

export function summarizeMcpText(rawResult) {
  const text = getMcpText(rawResult);
  return {
    text,
    trailingJson: parseTrailingJson(text),
    discoveryLine: text.split('\n').find((line) => line.startsWith('IAB_DISCOVERY')) ?? null,
  };
}

export class CodexControlClient {
  constructor({
    socketPath = DEFAULT_SOCKET_PATH,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = {}) {
    this.socketPath = socketPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.notifications = [];
    this.socket = null;
  }

  async connect() {
    this.socket = net.createConnection(this.socketPath);
    await new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });

    await this.upgradeToWebSocket();
    this.socket.on('data', (chunk) => this.handleData(chunk));
    this.socket.on('error', (error) => this.rejectAll(error));
    this.socket.on('close', () => this.rejectAll(new Error('Codex control socket closed')));
    if (this.buffer.length > 0) {
      const existing = this.buffer;
      this.buffer = Buffer.alloc(0);
      this.handleData(existing);
    }
  }

  async initialize(clientName = 'pi-codex-control') {
    const result = await this.request('initialize', {
      clientInfo: { name: clientName, title: null, version: '0' },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    this.notify('initialized');
    return result;
  }

  notify(method, params) {
    this.sendJson(params === undefined ? { method } : { method, params });
  }

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId++;
    this.sendJson(params === undefined ? { id, method } : { id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  close() {
    this.socket?.end();
  }

  async upgradeToWebSocket() {
    const key = crypto.randomBytes(16).toString('base64');
    this.socket.write(
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
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for WebSocket upgrade')),
        5_000,
      );
      const onData = (chunk) => {
        chunks.push(chunk);
        const raw = Buffer.concat(chunks);
        const headerEnd = raw.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        this.socket.off('data', onData);
        clearTimeout(timer);
        const header = raw.subarray(0, headerEnd).toString('utf8');
        if (!header.includes('101 Switching Protocols')) {
          reject(new Error(`WebSocket upgrade failed: ${header}`));
          return;
        }
        this.buffer = raw.subarray(headerEnd + 4);
        resolve();
      };
      this.socket.on('data', onData);
      this.socket.once('error', reject);
    });
  }

  sendJson(value) {
    this.socket.write(encodeClientTextFrame(JSON.stringify(value)));
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const decoded = decodeWebSocketFrames(this.buffer);
    this.buffer = decoded.rest;

    for (const frame of decoded.frames) {
      if (frame.opcode === 0x9) {
        this.socket.write(encodeClientPongFrame(frame.payload));
        continue;
      }
      if (frame.opcode !== 0x1 || !frame.text) continue;
      this.handleTextMessage(frame.text);
    }
  }

  handleTextMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.notifications.push({ parseError: text });
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    this.notifications.push(message);
  }

  handleServerRequest(message) {
    if (message.method === 'mcpServer/elicitation/request') {
      this.sendJson({ id: message.id, result: { action: 'decline', content: null, _meta: null } });
      return;
    }
    this.sendJson({
      id: message.id,
      error: { code: -32601, message: `Unsupported server request: ${message.method}` },
    });
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function buildTurnMetadata(threadId, prefix = 'pi-codex-control') {
  return {
    'x-codex-turn-metadata': {
      session_id: threadId,
      thread_id: threadId,
      thread_source: 'user',
      turn_id: `${prefix}-${Date.now()}`,
    },
  };
}

function buildIabProbeCode(browserClientPath) {
  const browserClientUrl = pathToFileURL(browserClientPath).href;
  const suffix = `${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  return `
await (async () => {
  const probe_${suffix} = { meta: globalThis.nodeRepl?.requestMeta ?? null, browsers: null, error: null };
  try {
    const { setupBrowserRuntime } = await import(${JSON.stringify(browserClientUrl)});
    await setupBrowserRuntime({ globals: globalThis });
    const list = await agent.browsers.list();
    probe_${suffix}.browsers = list.map((browser) => ({
      id: browser.id,
      type: browser.type,
      name: browser.name,
    }));
  } catch (error) {
    probe_${suffix}.error = String(error?.stack || error?.message || error);
  }
  nodeRepl.write(JSON.stringify(probe_${suffix}, null, 2));
})();`;
}

async function withInitializedClient(options, fn) {
  const client = new CodexControlClient(options);
  await client.connect();
  try {
    await client.initialize(options.clientName);
    return await fn(client);
  } finally {
    client.close();
  }
}

function usage() {
  return `Usage: codex-control.mjs [--socket PATH] [--timeout MS] <command> [...args]

Commands:
  status
      Read remoteControl/status/read.
  rpc <method> [params-json]
      Call an app-server JSON-RPC method after initialize.
  resume <thread-id>
      Resume a Codex app-server thread.
  servers [thread-id]
      List MCP server status.
  mcp <thread-id> <server> <tool> [args-json] [meta-json]
      Call an MCP tool.
  computer-use <thread-id> <tool> [args-json]
      Alias for mcp <thread-id> computer-use <tool>.
  iab-probe <thread-id> [browser-client-path]
      Run browser-client setup and agent.browsers.list() through node_repl.
`;
}

function parseGlobalOptions(argv) {
  const options = {
    socketPath: DEFAULT_SOCKET_PATH,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    clientName: 'pi-codex-control',
  };
  const rest = [...argv];
  while (rest.length > 0) {
    const next = rest[0];
    if (next === '--socket') {
      rest.shift();
      options.socketPath = rest.shift();
    } else if (next === '--timeout') {
      rest.shift();
      options.requestTimeoutMs = Number(rest.shift());
    } else if (next === '--client-name') {
      rest.shift();
      options.clientName = rest.shift();
    } else if (next === '--help' || next === '-h') {
      rest.shift();
      rest.unshift('help');
      break;
    } else {
      break;
    }
  }
  if (!options.socketPath) throw new Error('--socket requires a path');
  if (!Number.isFinite(options.requestTimeoutMs)) throw new Error('--timeout requires a number');
  return { options, rest };
}

async function callMcpTool(client, threadId, server, tool, args, meta) {
  await client.request('thread/resume', { threadId, excludeTurns: true }, 60_000);
  return await client.request(
    'mcpServer/tool/call',
    {
      threadId,
      server,
      tool,
      arguments: args ?? {},
      ...(meta ? { _meta: meta } : {}),
    },
    150_000,
  );
}

export async function runCli(argv = process.argv.slice(2)) {
  const { options, rest } = parseGlobalOptions(argv);
  const command = rest.shift();

  if (!command || command === 'help') {
    return { text: usage() };
  }

  return await withInitializedClient(options, async (client) => {
    if (command === 'status') {
      return await client.request('remoteControl/status/read');
    }

    if (command === 'rpc') {
      const method = rest.shift();
      if (!method) throw new Error('rpc requires <method>');
      return await client.request(method, parseJsonArgument(rest.shift(), undefined));
    }

    if (command === 'resume') {
      const threadId = rest.shift();
      if (!threadId) throw new Error('resume requires <thread-id>');
      return await client.request('thread/resume', { threadId, excludeTurns: true }, 60_000);
    }

    if (command === 'servers') {
      const threadId = rest.shift();
      return await client.request('mcpServerStatus/list', {
        detail: 'toolsAndAuthOnly',
        limit: 50,
        cursor: null,
        threadId: threadId ?? null,
      });
    }

    if (command === 'mcp') {
      const [threadId, server, tool] = rest.splice(0, 3);
      if (!threadId || !server || !tool)
        throw new Error('mcp requires <thread-id> <server> <tool>');
      return await callMcpTool(
        client,
        threadId,
        server,
        tool,
        parseJsonArgument(rest.shift(), {}),
        parseJsonArgument(rest.shift(), undefined),
      );
    }

    if (command === 'computer-use') {
      const [threadId, tool] = rest.splice(0, 2);
      if (!threadId || !tool) throw new Error('computer-use requires <thread-id> <tool>');
      return await callMcpTool(
        client,
        threadId,
        'computer-use',
        tool,
        parseJsonArgument(rest.shift(), {}),
        undefined,
      );
    }

    if (command === 'iab-probe') {
      const threadId = rest.shift();
      if (!threadId) throw new Error('iab-probe requires <thread-id>');
      const browserClientPath = rest.shift() ?? DEFAULT_BROWSER_CLIENT_PATH;
      const rawResult = await callMcpTool(
        client,
        threadId,
        'node_repl',
        'js',
        { code: buildIabProbeCode(browserClientPath), timeout_ms: 120_000 },
        buildTurnMetadata(threadId, 'pi-codex-control-iab'),
      );
      return {
        threadId,
        isError: rawResult?.isError === true,
        ...summarizeMcpText(rawResult),
        rawResult,
      };
    }

    throw new Error(`Unknown command: ${command}`);
  });
}

async function main() {
  const result = await runCli();
  if (typeof result?.text === 'string' && Object.keys(result).length === 1) {
    process.stdout.write(result.text);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : error}\n`);
    process.exitCode = 1;
  });
}
