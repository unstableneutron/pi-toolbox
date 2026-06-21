#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REAL_HOST_PATH = path.join(
  os.homedir(),
  '.codex/plugins/cache/openai-bundled/chrome/latest/extension-host/macos/arm64/extension-host',
);
const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  '.codex/pi-codex-app-server-use/native-host-shim-config.json',
);
const DEFAULT_MAX_PAYLOAD_CHARS = 50_000;
const DEFAULT_FAKE_GET_INFO_VERSION = '1.1.5';
const DEFAULT_CODEX_APP_VERSION = '26.602.30954';

function buildRealHostChildEnv(env = process.env) {
  return {
    ...env,
    BROWSER_USE_CODEX_APP_BUILD_FLAVOR: env.BROWSER_USE_CODEX_APP_BUILD_FLAVOR || 'prod',
    BROWSER_USE_CODEX_APP_VERSION: env.BROWSER_USE_CODEX_APP_VERSION || DEFAULT_CODEX_APP_VERSION,
    CODEX_HOME: env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex'),
  };
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/gu, '-');
}

function readJsonFileIfExists(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    return {
      configReadError: error instanceof Error ? error.message : String(error),
    };
  }
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(String(value ?? '').trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function defaultLogPath() {
  return path.join(
    os.homedir(),
    '.codex/pi-codex-app-server-use',
    `native-host-shim-${timestampSlug()}-${process.pid}.jsonl`,
  );
}

export function resolveShimOptions(env = process.env) {
  const configPath = env.PI_CODEX_NATIVE_HOST_SHIM_CONFIG?.trim() || DEFAULT_CONFIG_PATH;
  const config = readJsonFileIfExists(configPath);
  const realHostPath =
    env.PI_CODEX_NATIVE_HOST_SHIM_REAL_HOST?.trim() ||
    (typeof config.realHostPath === 'string' ? config.realHostPath : undefined) ||
    DEFAULT_REAL_HOST_PATH;
  const logPath =
    env.PI_CODEX_NATIVE_HOST_SHIM_LOG?.trim() ||
    (typeof config.logPath === 'string' ? config.logPath : undefined) ||
    defaultLogPath();
  const maxPayloadChars = readPositiveInteger(
    env.PI_CODEX_NATIVE_HOST_SHIM_MAX_PAYLOAD_CHARS ?? config.maxPayloadChars,
    DEFAULT_MAX_PAYLOAD_CHARS,
  );
  const fakeGetInfo = readBoolean(
    env.PI_CODEX_NATIVE_HOST_SHIM_FAKE_GET_INFO ?? config.fakeGetInfo,
    false,
  );
  const fakeGetInfoVersion =
    env.PI_CODEX_NATIVE_HOST_SHIM_FAKE_GET_INFO_VERSION?.trim() ||
    (typeof config.fakeGetInfoVersion === 'string' ? config.fakeGetInfoVersion : undefined) ||
    DEFAULT_FAKE_GET_INFO_VERSION;
  const rewriteCloseTargetToFinalizeTabs = readBoolean(
    env.PI_CODEX_NATIVE_HOST_SHIM_REWRITE_CLOSE_TARGET_TO_FINALIZE_TABS ??
      config.rewriteCloseTargetToFinalizeTabs,
    false,
  );

  return {
    configPath,
    configReadError:
      typeof config.configReadError === 'string' ? config.configReadError : undefined,
    fakeGetInfo,
    fakeGetInfoVersion,
    logPath,
    maxPayloadChars,
    realHostPath,
    rewriteCloseTargetToFinalizeTabs,
  };
}

function encodeNativeMessageFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export function decodeNativeMessageFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32LE(offset);
    const payloadStart = offset + 4;
    const payloadEnd = payloadStart + length;
    if (buffer.length < payloadEnd) break;

    const payload = Buffer.from(buffer.subarray(payloadStart, payloadEnd));
    const text = payload.toString('utf8');
    const frame = { length, payload, text };
    try {
      frame.json = JSON.parse(text);
    } catch (error) {
      frame.parseError = error instanceof Error ? error.message : String(error);
    }
    frames.push(frame);
    frame.raw = Buffer.from(buffer.subarray(offset, payloadEnd));
    offset = payloadEnd;
  }

  return { frames, rest: Buffer.from(buffer.subarray(offset)) };
}

function extensionIdFromOriginArg(value) {
  const match = String(value ?? '').match(/^chrome-extension:\/\/([^/]+)\/?$/u);
  return match?.[1];
}

function buildFakeGetInfoResult({ extensionId, version }) {
  return {
    capabilities: {
      tab: [
        {
          description:
            'List assets already observed in the current page state and bundle selected assets into a temporary local artifact.',
          id: 'pageAssets',
        },
      ],
    },
    metadata: {
      extensionId,
      extensionInstanceId: 'pi-native-host-shim',
    },
    name: 'Chrome',
    type: 'extension',
    version,
  };
}

function buildCloseTargetFinalizeTabsRewrite(json) {
  if (json?.method !== 'executeCdp') return undefined;
  const params = json.params;
  if (params?.method !== 'Target.closeTarget' || json.id === undefined) return undefined;
  if (typeof params.session_id !== 'string' || typeof params.turn_id !== 'string') {
    return undefined;
  }

  return {
    frame: {
      jsonrpc: typeof json.jsonrpc === 'string' ? json.jsonrpc : '2.0',
      id: json.id,
      method: 'finalizeTabs',
      params: {
        keep: [],
        session_id: params.session_id,
        turn_id: params.turn_id,
      },
    },
    tabId: params.target?.tabId,
    targetId: params.commandParams?.targetId,
  };
}

function jsonRpcField(json, field) {
  return json && typeof json === 'object' && field in json ? json[field] : undefined;
}

function serializeFramePayload(frame) {
  return frame.parseError ? frame.text : JSON.stringify(frame.json);
}

function summarizeError(error) {
  if (error && typeof error === 'object') {
    if ('message' in error && typeof error.message === 'string') return error.message;
    return JSON.stringify(error);
  }
  return String(error);
}

export function summarizeNativeMessage(direction, frame, options = {}) {
  const now = options.now ?? (() => new Date());
  const maxPayloadChars = options.maxPayloadChars ?? DEFAULT_MAX_PAYLOAD_CHARS;
  const payloadText = serializeFramePayload(frame);
  const payloadTruncated = payloadText.length > maxPayloadChars;
  const id = jsonRpcField(frame.json, 'id');
  const method = jsonRpcField(frame.json, 'method');
  const result = jsonRpcField(frame.json, 'result');
  const error = jsonRpcField(frame.json, 'error');
  const summary = {
    direction,
    isJson: !frame.parseError,
    payloadBytes: frame.length,
    payloadTruncated,
    ts: now().toISOString(),
  };

  if (id !== undefined) summary.id = id;
  if (typeof method === 'string') summary.method = method;
  if (result !== undefined) summary.hasResult = true;
  if (error !== undefined) {
    summary.hasError = true;
    summary.error = summarizeError(error);
  }
  if (frame.parseError) summary.parseError = frame.parseError;

  if (payloadTruncated) {
    summary.payloadPreview = `${payloadText.slice(0, maxPayloadChars)}…`;
  } else {
    summary.payload = frame.parseError ? frame.text : frame.json;
  }
  return summary;
}

function appendJsonLine(logPath, entry) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function logTextChunk({ bytes, event, logPath, maxPayloadChars }) {
  const text = bytes.toString('utf8');
  const textTruncated = text.length > maxPayloadChars;
  appendJsonLine(logPath, {
    event,
    textBytes: bytes.length,
    textTruncated,
    ts: new Date().toISOString(),
    ...(textTruncated ? { textPreview: `${text.slice(0, maxPayloadChars)}…` } : { text }),
  });
}

function createNativeMessageLogger({ direction, logPath, maxPayloadChars }) {
  let buffered = Buffer.alloc(0);
  return {
    append(chunk) {
      const decoded = decodeNativeMessageFrames(Buffer.concat([buffered, chunk]));
      buffered = decoded.rest;
      for (const frame of decoded.frames) {
        appendJsonLine(logPath, summarizeNativeMessage(direction, frame, { maxPayloadChars }));
      }
    },
    flushIncomplete() {
      if (buffered.length === 0) return;
      appendJsonLine(logPath, {
        direction,
        event: 'incomplete-frame',
        pendingBytes: buffered.length,
        ts: new Date().toISOString(),
      });
      buffered = Buffer.alloc(0);
    },
  };
}

function runShim() {
  const options = resolveShimOptions();
  const childArgs = process.argv.slice(2);
  const extensionId = extensionIdFromOriginArg(childArgs[0]) ?? 'unknown-extension';
  appendJsonLine(options.logPath, {
    argv: childArgs,
    configPath: options.configPath,
    event: 'shim-start',
    fakeGetInfo: options.fakeGetInfo,
    logPath: options.logPath,
    pid: process.pid,
    realHostPath: options.realHostPath,
    rewriteCloseTargetToFinalizeTabs: options.rewriteCloseTargetToFinalizeTabs,
    ts: new Date().toISOString(),
    ...(options.configReadError ? { configReadError: options.configReadError } : {}),
  });

  const child = spawn(options.realHostPath, childArgs, {
    cwd: path.dirname(options.realHostPath),
    env: buildRealHostChildEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const inbound = createNativeMessageLogger({
    direction: 'extension->host',
    logPath: options.logPath,
    maxPayloadChars: options.maxPayloadChars,
  });
  let outboundBuffer = Buffer.alloc(0);

  child.on('error', (error) => {
    appendJsonLine(options.logPath, {
      error: error instanceof Error ? error.message : String(error),
      event: 'child-error',
      ts: new Date().toISOString(),
    });
    process.exitCode = 1;
  });

  process.stdin.on('data', (chunk) => {
    inbound.append(chunk);
    child.stdin.write(chunk);
  });
  process.stdin.on('end', () => {
    inbound.flushIncomplete();
    child.stdin.end();
  });
  process.stdin.on('error', (error) => {
    appendJsonLine(options.logPath, {
      error: error instanceof Error ? error.message : String(error),
      event: 'stdin-error',
      ts: new Date().toISOString(),
    });
    child.stdin.destroy(error);
  });

  child.stdout.on('data', (chunk) => {
    const decoded = decodeNativeMessageFrames(Buffer.concat([outboundBuffer, chunk]));
    outboundBuffer = decoded.rest;
    for (const frame of decoded.frames) {
      appendJsonLine(
        options.logPath,
        summarizeNativeMessage('host->extension', frame, {
          maxPayloadChars: options.maxPayloadChars,
        }),
      );
      if (options.fakeGetInfo && frame.json?.method === 'getInfo' && frame.json.id !== undefined) {
        // Diagnostic workaround for Codex Chrome extension 1.1.5:
        //   1. extension-host asks the extension for JSON-RPC `getInfo`.
        //   2. The extension's internal getInfo handler tries
        //      `chrome.runtime.getVersion()`.
        //   3. Chrome's extension API does not provide that function; the
        //      standard source is `chrome.runtime.getManifest().version`.
        //   4. The native-host shim cannot rewrite that internal JS call: the
        //      only protocol frame crossing this boundary is `getInfo`, followed
        //      by the extension's error response.
        //
        // For local protocol debugging, synthesize the same shape of getInfo
        // response that the extension would have returned with the manifest
        // version, then feed it back to extension-host. This keeps the official
        // extension/native-host path intact after the bad version lookup and
        // lets us inspect the next browser-control protocol steps.
        const reply = {
          jsonrpc: '2.0',
          id: frame.json.id,
          result: buildFakeGetInfoResult({
            extensionId,
            version: options.fakeGetInfoVersion,
          }),
        };
        appendJsonLine(options.logPath, {
          event: 'fake-get-info-reply',
          id: frame.json.id,
          ts: new Date().toISOString(),
        });
        child.stdin.write(encodeNativeMessageFrame(reply));
      } else if (options.rewriteCloseTargetToFinalizeTabs) {
        const rewrite = buildCloseTargetFinalizeTabsRewrite(frame.json);
        if (rewrite) {
          // Diagnostic workaround for Chrome extension-backed tab cleanup:
          // browser-client currently closes tabs by sending CDP
          // `Target.closeTarget` through the extension's `executeCdp` RPC.
          // Chrome rejects that method via `chrome.debugger.sendCommand` with
          // `Not allowed`, while the extension-native `finalizeTabs` RPC uses
          // `chrome.tabs.remove(...)` and succeeds for agent-owned tabs.
          //
          // The shim cannot call `chrome.tabs.remove` directly, so in this
          // opt-in local-debug mode it rewrites the host->extension request to
          // a same-id `finalizeTabs({ keep: [] })` frame. The same id lets the
          // real extension response satisfy the original extension-host
          // request. Keep this off by default: `keep: []` means "close all
          // non-kept agent-created tabs for this turn/session", which is close
          // to cleanup semantics but not identical to a one-tab CDP close.
          appendJsonLine(options.logPath, {
            event: 'rewrite-close-target-to-finalize-tabs',
            id: frame.json.id,
            tabId: rewrite.tabId,
            targetId: rewrite.targetId,
            ts: new Date().toISOString(),
          });
          process.stdout.write(encodeNativeMessageFrame(rewrite.frame));
        } else {
          process.stdout.write(frame.raw);
        }
      } else {
        process.stdout.write(frame.raw);
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    logTextChunk({
      bytes: Buffer.from(chunk),
      event: 'child-stderr',
      logPath: options.logPath,
      maxPayloadChars: options.maxPayloadChars,
    });
    process.stderr.write(chunk);
  });
  child.on('exit', (code, signal) => {
    if (outboundBuffer.length > 0) {
      appendJsonLine(options.logPath, {
        direction: 'host->extension',
        event: 'incomplete-frame',
        pendingBytes: outboundBuffer.length,
        ts: new Date().toISOString(),
      });
      outboundBuffer = Buffer.alloc(0);
    }
    appendJsonLine(options.logPath, {
      code,
      event: 'child-exit',
      signal,
      ts: new Date().toISOString(),
    });
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runShim();
}
