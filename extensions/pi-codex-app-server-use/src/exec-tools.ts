import crypto from 'node:crypto';
import path from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { CodexAppServerWebSocketClient } from './app-server';
import {
  checkCodexAppServerControlSocket,
  CODEX_APP_SERVER_ORIGIN,
  getCodexAppServerControlSocketPath,
} from './app-server-control';
import type { CodexAppServerExecModels } from './config';

export { checkCodexAppServerControlSocket } from './app-server-control';

const DEFAULT_CLIENT_NAME = 'pi-codex-app-server-use';
const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
const DEFAULT_WRITE_YIELD_TIME_MS = 250;
const DEFAULT_EMPTY_WRITE_YIELD_TIME_MS = 5_000;
const MIN_YIELD_TIME_MS = 250;
const MIN_NON_INTERACTIVE_EXEC_YIELD_TIME_MS = 5_000;
const MIN_EMPTY_WRITE_YIELD_TIME_MS = 5_000;
const MAX_YIELD_TIME_MS = 30_000;
const DEFAULT_MAX_EMPTY_WRITE_YIELD_TIME_MS = 300_000;
const LONG_RUNNING_RPC_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;

export const APP_SERVER_EXEC_TOOL_NAMES = ['exec_command', 'write_stdin'];
export const REPLACED_PI_LOCAL_TOOL_NAMES = ['read', 'bash', 'edit', 'write'];

const EXEC_COMMAND_PARAMETERS = Type.Object({
  cmd: Type.String({ description: 'Shell command to execute.' }),
  workdir: Type.Optional(
    Type.String({ description: 'Working directory for the command. Defaults to the Pi cwd.' }),
  ),
  shell: Type.Optional(
    Type.String({ description: "Shell binary to launch. Defaults to the user's shell." }),
  ),
  tty: Type.Optional(
    Type.Boolean({
      description: 'True allocates a PTY for the command; false or omitted uses pipes.',
    }),
  ),
  yield_time_ms: Type.Optional(
    Type.Number({ description: 'Wait before yielding output. Defaults to 10000 ms.' }),
  ),
  max_output_tokens: Type.Optional(
    Type.Number({ description: 'Output token budget. Defaults to 10000 tokens.' }),
  ),
  login: Type.Optional(
    Type.Boolean({ description: 'True runs the shell with login semantics. Defaults to true.' }),
  ),
});

const WRITE_STDIN_PARAMETERS = Type.Object({
  session_id: Type.Number({ description: 'Identifier of the running unified exec session.' }),
  chars: Type.Optional(
    Type.String({ description: 'Bytes to write to stdin. Empty or omitted polls.' }),
  ),
  yield_time_ms: Type.Optional(Type.Number({ description: 'Wait before yielding output.' })),
  max_output_tokens: Type.Optional(
    Type.Number({ description: 'Output token budget. Defaults to 10000 tokens.' }),
  ),
});

export interface ExecCommandParams {
  cmd: string;
  workdir?: string | undefined;
  shell?: string | undefined;
  tty?: boolean | undefined;
  yield_time_ms?: number | undefined;
  max_output_tokens?: number | undefined;
  login?: boolean | undefined;
}

interface WriteStdinParams {
  session_id: number;
  chars?: string | undefined;
  yield_time_ms?: number | undefined;
  max_output_tokens?: number | undefined;
}

export interface UnifiedExecResult {
  chunk_id: string;
  wall_time_seconds: number;
  output: string;
  exit_code?: number | undefined;
  session_id?: number | undefined;
  original_token_count?: number | undefined;
}

interface ExecSession {
  id: number;
  processId: string;
  command: string;
  buffer: string;
  emittedBuffer: string;
  exitCode: number | undefined;
  startedAt: number;
  tty: boolean;
  terminalCommitted: string;
  terminalLine: string[];
  terminalCursor: number;
}

interface CommandExecResponse {
  exitCode?: number | undefined;
  exit_code?: number | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
}

interface CommandExecOutputDeltaParams {
  processId?: string | undefined;
  process_id?: string | undefined;
  stream?: 'stdout' | 'stderr' | 'Stdout' | 'Stderr' | undefined;
  deltaBase64?: string | undefined;
  delta_base64?: string | undefined;
}

export interface AppServerExecSessionManagerOptions {
  clientFactory?: (() => CodexAppServerWebSocketClient) | undefined;
  socketPath?: string | undefined;
  origin?: string | undefined;
  clientName?: string | undefined;
}

function isFishShell(shell: string | undefined): boolean {
  const name = shell?.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
  return name === 'fish';
}

export function getDefaultCodexRuntimeShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  const shell = process.env.SHELL || '/bin/bash';
  return isFishShell(shell) ? '/bin/bash' : shell;
}

function getShellArgs(shell: string, command: string, login: boolean): string[] {
  const name = shell.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? shell.toLowerCase();
  if (name === 'cmd' || name === 'cmd.exe') return ['/d', '/s', '/c', command];
  if (
    name === 'powershell' ||
    name === 'powershell.exe' ||
    name === 'pwsh' ||
    name === 'pwsh.exe'
  ) {
    return ['-NoLogo', '-NoProfile', '-Command', command];
  }
  return login ? ['-lc', command] : ['-c', command];
}

function clampYieldTime(value: number | undefined, fallback: number): number {
  return Math.min(MAX_YIELD_TIME_MS, Math.max(MIN_YIELD_TIME_MS, value ?? fallback));
}

function clampExecYieldTime(
  value: number | undefined,
  fallback: number,
  isInteractive: boolean,
): number {
  const clamped = clampYieldTime(value, fallback);
  return isInteractive ? clamped : Math.max(MIN_NON_INTERACTIVE_EXEC_YIELD_TIME_MS, clamped);
}

function clampWriteYieldTime(
  value: number | undefined,
  fallback: number,
  isEmptyPoll: boolean,
): number {
  if (!isEmptyPoll) return clampYieldTime(value, fallback);
  return Math.min(
    DEFAULT_MAX_EMPTY_WRITE_YIELD_TIME_MS,
    Math.max(MIN_EMPTY_WRITE_YIELD_TIME_MS, value ?? fallback),
  );
}

function maxCharsForTokens(maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS): number {
  return Math.max(256, maxOutputTokens * 4);
}

function generateChunkId(): string {
  return crypto.randomBytes(3).toString('hex');
}

function truncateOutput(
  text: string,
  maxOutputTokens?: number,
): {
  output: string;
  original_token_count?: number | undefined;
} {
  if (text.length === 0) return { output: '' };
  const maxChars = maxCharsForTokens(maxOutputTokens);
  const originalTokenCount = Math.ceil(text.length / 4);
  if (text.length <= maxChars) return { output: text, original_token_count: originalTokenCount };
  return { output: text.slice(-maxChars), original_token_count: originalTokenCount };
}

function stripTerminalControlSequences(text: string, preserveCsi = false): string {
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  let output = '';

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char !== escape) {
      output += char;
      continue;
    }

    const next = text[index + 1];
    if (next === ']') {
      index += 2;
      while (index < text.length) {
        if (text[index] === bell) break;
        if (text[index] === escape && text[index + 1] === '\\') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (next && 'P_X^'.includes(next)) {
      index += 2;
      while (index < text.length) {
        if (text[index] === escape && text[index + 1] === '\\') {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (next === '[') {
      const sequenceStart = index;
      index += 2;
      while (index < text.length) {
        const code = text.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) break;
        index += 1;
      }
      if (preserveCsi) output += text.slice(sequenceStart, Math.min(index + 1, text.length));
      continue;
    }

    if (next) index += 1;
  }

  return output;
}

function sanitizeBinaryOutput(text: string, preserveBackspace = false): string {
  return Array.from(text)
    .filter((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (preserveBackspace && code === 0x08) return true;
      if (code <= 0x1f) return false;
      if (code >= 0xfff9 && code <= 0xfffb) return false;
      return true;
    })
    .join('');
}

function normalizePipeOutput(text: string): string {
  return sanitizeBinaryOutput(stripTerminalControlSequences(text))
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function writeTerminalChar(session: ExecSession, char: string): void {
  if (session.terminalCursor > session.terminalLine.length) {
    session.terminalLine.push(
      ...Array.from({ length: session.terminalCursor - session.terminalLine.length }, () => ' '),
    );
  }
  session.terminalLine[session.terminalCursor] = char;
  session.terminalCursor += 1;
}

function applyTerminalOutput(session: ExecSession, text: string): string {
  const sanitized = stripTerminalControlSequences(text, true);
  if (sanitized.length === 0) return session.terminalCommitted + session.terminalLine.join('');

  for (let index = 0; index < sanitized.length; index += 1) {
    const char = sanitized[index]!;
    if (char === '\u001b') {
      if (sanitized[index + 1] === '[') {
        let sequenceEnd = index + 2;
        while (sequenceEnd < sanitized.length) {
          const code = sanitized.charCodeAt(sequenceEnd);
          if (code >= 0x40 && code <= 0x7e) break;
          sequenceEnd += 1;
        }
        if (sequenceEnd >= sanitized.length) break;
        const params = sanitized.slice(index + 2, sequenceEnd);
        const finalByte = sanitized[sequenceEnd]!;
        if (finalByte === 'K') {
          const mode = Number(params || '0');
          if (mode === 0)
            session.terminalLine = session.terminalLine.slice(0, session.terminalCursor);
          else if (mode === 1) {
            session.terminalLine = [
              ...Array.from(
                { length: Math.min(session.terminalCursor, session.terminalLine.length) },
                () => ' ',
              ),
              ...session.terminalLine.slice(session.terminalCursor),
            ];
          } else if (mode === 2) session.terminalLine = [];
        }
        index = sequenceEnd;
        continue;
      }
      const next = sanitized[index + 1]!;
      if (next && /[()*+,\-./]/.test(next) && index + 2 < sanitized.length) {
        index += 2;
        continue;
      }
      if (next) index += 1;
      continue;
    }

    const code = char.codePointAt(0);
    if (
      code !== undefined &&
      code <= 0x1f &&
      char !== '\t' &&
      char !== '\n' &&
      char !== '\r' &&
      char !== '\b'
    )
      continue;

    switch (char) {
      case '\r':
        session.terminalCursor = 0;
        break;
      case '\n':
        session.terminalCommitted += `${session.terminalLine.join('')}\n`;
        session.terminalLine = [];
        session.terminalCursor = 0;
        break;
      case '\b':
        session.terminalCursor = Math.max(0, session.terminalCursor - 1);
        break;
      default:
        writeTerminalChar(session, char);
        break;
    }
  }
  return session.terminalCommitted + session.terminalLine.join('');
}

function computePtyDelta(previous: string, current: string): string {
  if (current.startsWith(previous)) return current.slice(previous.length);
  const lineStart = previous.lastIndexOf('\n') + 1;
  const stablePrefix = previous.slice(0, lineStart);
  if (current.startsWith(stablePrefix)) return `\r${current.slice(lineStart)}`;
  return current;
}

function appendOutput(session: ExecSession, text: string): void {
  if (!text) return;
  session.buffer = session.tty
    ? applyTerminalOutput(session, text)
    : `${session.buffer}${normalizePipeOutput(text)}`;
}

function consumeOutput(
  session: ExecSession,
  maxOutputTokens?: number,
): {
  output: string;
  original_token_count?: number | undefined;
} {
  const text = session.tty
    ? computePtyDelta(session.emittedBuffer, session.buffer)
    : session.buffer.slice(session.emittedBuffer.length);
  session.emittedBuffer = session.buffer;
  return truncateOutput(text, maxOutputTokens);
}

function peekOutputSince(
  session: ExecSession,
  baseline: string,
  maxOutputTokens?: number,
): {
  output: string;
  original_token_count?: number | undefined;
} {
  const text = session.tty
    ? computePtyDelta(baseline, session.buffer)
    : session.buffer.slice(baseline.length);
  return truncateOutput(text, maxOutputTokens);
}

function resultFromSnapshot(
  session: ExecSession,
  waitMs: number,
  snapshot: { output: string; original_token_count?: number | undefined },
): UnifiedExecResult {
  const result: UnifiedExecResult = {
    chunk_id: generateChunkId(),
    wall_time_seconds: waitMs / 1000,
    output: snapshot.output,
  };
  if (snapshot.original_token_count !== undefined)
    result.original_token_count = snapshot.original_token_count;
  if (session.exitCode === undefined) result.session_id = session.id;
  else result.exit_code = session.exitCode;
  return result;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Operation aborted'));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new Error('Operation aborted'));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForExitOrTimeout(
  session: ExecSession,
  waitMs: number,
  signal?: AbortSignal,
): Promise<number> {
  const start = Date.now();
  while (session.exitCode === undefined && Date.now() - start < waitMs) {
    await sleep(Math.min(50, waitMs - (Date.now() - start)), signal);
  }
  return Date.now() - start;
}

function normalizeExitCode(response: CommandExecResponse): number {
  return typeof response.exitCode === 'number' ? response.exitCode : (response.exit_code ?? 1);
}

function decodeBase64Text(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8');
}

function parseExecCommandParams(params: unknown): ExecCommandParams {
  if (
    !params ||
    typeof params !== 'object' ||
    !('cmd' in params) ||
    typeof params.cmd !== 'string'
  ) {
    throw new Error("exec_command requires a string 'cmd' parameter");
  }
  return {
    cmd: params.cmd,
    workdir: 'workdir' in params && typeof params.workdir === 'string' ? params.workdir : undefined,
    shell: 'shell' in params && typeof params.shell === 'string' ? params.shell : undefined,
    tty: 'tty' in params && typeof params.tty === 'boolean' ? params.tty : undefined,
    yield_time_ms:
      'yield_time_ms' in params && typeof params.yield_time_ms === 'number'
        ? params.yield_time_ms
        : undefined,
    max_output_tokens:
      'max_output_tokens' in params && typeof params.max_output_tokens === 'number'
        ? params.max_output_tokens
        : undefined,
    login: 'login' in params && typeof params.login === 'boolean' ? params.login : undefined,
  };
}

function parseWriteStdinParams(params: unknown): WriteStdinParams {
  if (
    !params ||
    typeof params !== 'object' ||
    !('session_id' in params) ||
    typeof params.session_id !== 'number'
  ) {
    throw new Error("write_stdin requires numeric 'session_id'");
  }
  return {
    session_id: params.session_id,
    chars: 'chars' in params && typeof params.chars === 'string' ? params.chars : undefined,
    yield_time_ms:
      'yield_time_ms' in params && typeof params.yield_time_ms === 'number'
        ? params.yield_time_ms
        : undefined,
    max_output_tokens:
      'max_output_tokens' in params && typeof params.max_output_tokens === 'number'
        ? params.max_output_tokens
        : undefined,
  };
}

function prepareExecCommandArguments(args: unknown): ExecCommandParams {
  if (!args || typeof args !== 'object') return args as ExecCommandParams;
  const record = args as Record<string, unknown>;
  const prepared: Record<string, unknown> = { ...record };
  if (!('cmd' in prepared) && 'command' in prepared) prepared.cmd = prepared.command;
  if (!('workdir' in prepared)) {
    if ('cwd' in prepared) prepared.workdir = prepared.cwd;
    else if ('working_directory' in prepared) prepared.workdir = prepared.working_directory;
  }
  return prepared as unknown as ExecCommandParams;
}

export function buildCommandExecRequest(
  params: ExecCommandParams,
  cwd: string,
  processId: string,
): Record<string, unknown> {
  const shell = params.shell || getDefaultCodexRuntimeShell();
  const login = params.login ?? true;
  const workdir = params.workdir ? path.resolve(cwd, params.workdir) : cwd;
  return {
    command: [shell, ...getShellArgs(shell, params.cmd, login)],
    processId,
    cwd: workdir,
    tty: Boolean(params.tty),
    streamStdin: Boolean(params.tty),
    streamStdoutStderr: true,
    disableOutputCap: true,
    disableTimeout: true,
    sandboxPolicy: { type: 'dangerFullAccess' },
  };
}

export function formatUnifiedExecResult(result: UnifiedExecResult, command?: string): string {
  const sections: string[] = [];
  if (command) sections.push(`Command: ${command}`);
  if (result.chunk_id) sections.push(`Chunk ID: ${result.chunk_id}`);
  sections.push(`Wall time: ${result.wall_time_seconds.toFixed(4)} seconds`);
  if (result.exit_code !== undefined) sections.push(`Process exited with code ${result.exit_code}`);
  if (result.session_id !== undefined) {
    sections.push(`Process running with session ID ${result.session_id}`);
  }
  if (result.original_token_count !== undefined) {
    sections.push(`Original token count: ${result.original_token_count}`);
  }
  sections.push('Output:', result.output);
  return sections.join('\n');
}

export function shouldUseAppServerExecTools(
  model:
    | { provider?: string | undefined; api?: string | undefined; id?: string | undefined }
    | undefined,
  models: CodexAppServerExecModels,
): boolean {
  if (models === 'all') return true;
  if (!model) return false;
  const provider = (model.provider ?? '').toLowerCase();
  const api = (model.api ?? '').toLowerCase();
  const id = (model.id ?? '').toLowerCase();
  const isCopilotGpt =
    (provider.includes('copilot') || api.includes('copilot')) && id.includes('gpt');
  return (
    provider.includes('codex') ||
    api.includes('codex') ||
    id.includes('codex') ||
    (provider.includes('openai') && id.includes('gpt')) ||
    isCopilotGpt
  );
}

export class CodexAppServerExecSessionManager {
  private client?: CodexAppServerWebSocketClient;
  private cleanupNotifications?: () => void;
  private nextSessionId = 1;
  private readonly sessions = new Map<number, ExecSession>();
  private readonly sessionsByProcessId = new Map<string, ExecSession>();

  constructor(private readonly options: AppServerExecSessionManagerOptions = {}) {}

  async exec(
    input: ExecCommandParams,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<UnifiedExecResult> {
    const client = await this.getClient(signal);
    const session = this.createSession(input);
    const request = buildCommandExecRequest(input, cwd, session.processId);
    this.sessions.set(session.id, session);
    this.sessionsByProcessId.set(session.processId, session);

    void client
      .callRpc('command/exec', request, LONG_RUNNING_RPC_TIMEOUT_MS)
      .then((response: CommandExecResponse) => {
        if (typeof response.stdout === 'string') appendOutput(session, response.stdout);
        if (typeof response.stderr === 'string') appendOutput(session, response.stderr);
        session.exitCode = normalizeExitCode(response);
      })
      .catch((error: unknown) => {
        appendOutput(session, `${error instanceof Error ? error.message : String(error)}\n`);
        session.exitCode = 1;
      });

    const waitedMs = await waitForExitOrTimeout(
      session,
      clampExecYieldTime(input.yield_time_ms, DEFAULT_EXEC_YIELD_TIME_MS, session.tty),
      signal,
    );
    const result = resultFromSnapshot(
      session,
      waitedMs,
      consumeOutput(session, input.max_output_tokens),
    );
    if (session.exitCode !== undefined && session.emittedBuffer === session.buffer) {
      this.deleteSession(session);
    }
    return result;
  }

  async write(input: WriteStdinParams, signal?: AbortSignal): Promise<UnifiedExecResult> {
    const session = this.sessions.get(input.session_id);
    if (!session) throw new Error(`Unknown process id ${input.session_id}`);
    const baseline = session.buffer;
    if (input.chars && input.chars.length > 0) {
      if (!session.tty) {
        throw new Error(
          'stdin is closed for this session; rerun exec_command with tty=true to keep stdin open',
        );
      }
      const client = await this.getClient(signal);
      await client.callRpc(
        'command/exec/write',
        {
          processId: session.processId,
          deltaBase64: Buffer.from(input.chars, 'utf8').toString('base64'),
          closeStdin: false,
        },
        30_000,
        signal,
      );
    }
    const waitedMs = await waitForExitOrTimeout(
      session,
      clampWriteYieldTime(
        input.yield_time_ms,
        input.chars && input.chars.length > 0
          ? DEFAULT_WRITE_YIELD_TIME_MS
          : DEFAULT_EMPTY_WRITE_YIELD_TIME_MS,
        !input.chars || input.chars.length === 0,
      ),
      signal,
    );
    const result = resultFromSnapshot(
      session,
      waitedMs,
      peekOutputSince(session, baseline, input.max_output_tokens),
    );
    session.emittedBuffer = session.buffer;
    if (session.exitCode !== undefined && session.emittedBuffer === session.buffer) {
      this.deleteSession(session);
    }
    return result;
  }

  getSessionCommand(sessionId: number): string | undefined {
    return this.sessions.get(sessionId)?.command;
  }

  close(): void {
    this.cleanupNotifications?.();
    this.cleanupNotifications = undefined;
    this.client?.close();
    this.client = undefined;
    this.sessions.clear();
    this.sessionsByProcessId.clear();
  }

  private createSession(input: ExecCommandParams): ExecSession {
    const id = this.nextSessionId++;
    return {
      id,
      processId: `pi-app-server-${process.pid}-${Date.now()}-${id}`,
      command: input.cmd,
      buffer: '',
      emittedBuffer: '',
      exitCode: undefined,
      startedAt: Date.now(),
      tty: Boolean(input.tty),
      terminalCommitted: '',
      terminalLine: [],
      terminalCursor: 0,
    };
  }

  private async getClient(signal?: AbortSignal): Promise<CodexAppServerWebSocketClient> {
    if (!this.client) {
      this.client = this.options.clientFactory
        ? this.options.clientFactory()
        : new CodexAppServerWebSocketClient({
            clientName: this.options.clientName ?? DEFAULT_CLIENT_NAME,
            origin: this.options.origin ?? CODEX_APP_SERVER_ORIGIN,
            url: `unix://${this.options.socketPath ?? getCodexAppServerControlSocketPath()}`,
          });
      this.cleanupNotifications = this.client.onNotification((message) =>
        this.handleNotification(message),
      );
      await this.client.init(signal);
    }
    return this.client;
  }

  private handleNotification(message: { method?: string; params?: unknown }): void {
    if (message.method !== 'command/exec/outputDelta') return;
    const params = message.params as CommandExecOutputDeltaParams;
    const processId = params.processId ?? params.process_id;
    const deltaBase64 = params.deltaBase64 ?? params.delta_base64;
    if (!processId || !deltaBase64) return;
    const session = this.sessionsByProcessId.get(processId);
    if (!session) return;
    appendOutput(session, decodeBase64Text(deltaBase64));
  }

  private deleteSession(session: ExecSession): void {
    this.sessions.delete(session.id);
    this.sessionsByProcessId.delete(session.processId);
  }
}

export function registerAppServerExecTools(
  pi: ExtensionAPI,
  sessions: CodexAppServerExecSessionManager,
): void {
  pi.registerTool({
    name: 'exec_command',
    label: 'exec_command',
    description: 'Run shell commands; may return session_id.',
    promptSnippet: 'Run command.',
    parameters: EXEC_COMMAND_PARAMETERS,
    prepareArguments: prepareExecCommandArguments as (args: unknown) => ExecCommandParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const typedParams = parseExecCommandParams(params);
      const result = await sessions.exec(typedParams, ctx.cwd, signal);
      return {
        content: [{ type: 'text', text: formatUnifiedExecResult(result, typedParams.cmd) }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: 'write_stdin',
    label: 'write_stdin',
    description: 'Write/poll exec session.',
    promptSnippet: 'Write to exec session.',
    parameters: WRITE_STDIN_PARAMETERS,
    async execute(_toolCallId, params, signal) {
      const typedParams = parseWriteStdinParams(params);
      const command = sessions.getSessionCommand(typedParams.session_id);
      const result = await sessions.write(typedParams, signal);
      return {
        content: [{ type: 'text', text: formatUnifiedExecResult(result, command) }],
        details: result,
      };
    },
  });
}
