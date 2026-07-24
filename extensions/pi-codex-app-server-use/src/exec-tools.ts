import crypto from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import {
  formatSize,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type TruncationResult,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { executeApplyPatchPayload } from '../../multi-edit';
import { sanitizeBinaryOutput } from '../../shared/tui-width';
import { CodexAppServerWebSocketClient } from './app-server';
import { CODEX_APP_SERVER_ORIGIN, getCodexAppServerControlSocketPath } from './app-server-control';
import type { CodexAppServerExecModels } from './config';
import {
  ExecOutputAccumulator,
  maxBytesForOutputTokens,
  type ExecOutputSnapshot,
} from './exec-output-accumulator';
import {
  renderApplyPatchCall,
  renderApplyPatchResult,
  renderExecCommandCall,
  renderExecCommandResult,
  renderWriteStdinCall,
} from './rendering';
import {
  DEFAULT_EXEC_YIELD_TIME_MS,
  DEFAULT_EMPTY_WRITE_YIELD_TIME_MS,
  DEFAULT_WRITE_YIELD_TIME_MS,
  clampExecYieldTime,
  clampWriteYieldTime,
} from './yield-time';

export { checkCodexAppServerControlSocket } from './app-server-control';

const DEFAULT_CLIENT_NAME = 'pi-codex-app-server-use';
const LONG_RUNNING_RPC_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const EXEC_PROGRESS_UPDATE_INTERVAL_MS = 250;

const SHELL_ENVIRONMENT_ALLOWLIST = ['PATH', 'HERDR*', 'TMUX*', 'ZELLIJ*'];

export const APP_SERVER_EXEC_CONTROL_TOOL_NAMES = ['exec_command', 'write_stdin'];
export const APP_SERVER_EXEC_TOOL_NAMES = [...APP_SERVER_EXEC_CONTROL_TOOL_NAMES, 'apply_patch'];
export const REPLACED_PI_LOCAL_TOOL_NAMES = ['read', 'bash', 'edit', 'write'];

const APPLY_PATCH_PARAMETERS = Type.Object(
  {
    input: Type.String({
      description:
        'Full patch text. Use *** Begin Patch / *** End Patch with Add/Update/Delete File sections.',
    }),
  },
  { additionalProperties: false },
);

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

interface ApplyPatchParams {
  input: string;
}

export interface UnifiedExecResult {
  chunk_id: string;
  wall_time_seconds: number;
  output: string;
  exec_session_id?: number | undefined;
  command?: string | undefined;
  exit_code?: number | undefined;
  session_id?: number | undefined;
  original_token_count?: number | undefined;
  truncation?: TruncationResult | undefined;
  full_output_path?: string | undefined;
}

type ExecProgressCallback = (result: UnifiedExecResult) => void;

export interface ExecSessionSummary {
  session_id: number;
  command: string;
  running: boolean;
  tty: boolean;
  started_at: number;
  buffered_chars: number;
  exit_code?: number | undefined;
}

interface ExecSession {
  id: number;
  processId: string;
  command: string;
  output: ExecOutputAccumulator;
  outputDecoder: StreamingExecOutputDecoder;
  emittedCursor: number;
  exitCode: number | undefined;
  startedAt: number;
  tty: boolean;
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
  env?: NodeJS.ProcessEnv | undefined;
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

function generateChunkId(): string {
  return crypto.randomBytes(3).toString('hex');
}

type TerminalControlState =
  | 'text'
  | 'escape'
  | 'csi'
  | 'osc'
  | 'oscEscape'
  | 'string'
  | 'stringEscape';

class StreamingExecOutputDecoder {
  private readonly utf8 = new StringDecoder('utf8');
  private terminalState: TerminalControlState = 'text';
  private pendingCarriageReturn = false;
  private byteStreamFinished = false;

  writeBase64(value: string): string {
    if (this.byteStreamFinished) return '';
    return this.consume(this.utf8.write(Buffer.from(value, 'base64')));
  }

  writeText(text: string): string {
    return this.consume(text);
  }

  finishBytes(): string {
    if (this.byteStreamFinished) return '';
    this.byteStreamFinished = true;
    return this.consume(this.utf8.end());
  }

  finish(): string {
    return this.finishBytes() + this.consume('', true);
  }

  private consume(text: string, final = false): string {
    const output: string[] = [];

    for (const char of text) {
      let reprocess = true;
      while (reprocess) {
        reprocess = false;
        const code = char.codePointAt(0) ?? 0;

        switch (this.terminalState) {
          case 'text':
            if (char === '\u001b') this.terminalState = 'escape';
            else if (char === '\u009b') this.terminalState = 'csi';
            else if (char === '\u009d') this.terminalState = 'osc';
            else if ('\u0090\u0098\u009e\u009f'.includes(char)) this.terminalState = 'string';
            else this.appendTextCharacter(char, output);
            break;
          case 'escape':
            if (char === '[') this.terminalState = 'csi';
            else if (char === ']') this.terminalState = 'osc';
            else if ('P_X^'.includes(char)) this.terminalState = 'string';
            else if (char === '\u001b') this.terminalState = 'escape';
            else if (code >= 0x20 && code <= 0x2f) this.terminalState = 'escape';
            else if (code >= 0x40 && code <= 0x7e) this.terminalState = 'text';
            else {
              this.terminalState = 'text';
              reprocess = true;
            }
            break;
          case 'csi':
            if (char === '\u001b') this.terminalState = 'escape';
            else if (code >= 0x40 && code <= 0x7e) this.terminalState = 'text';
            break;
          case 'osc':
            if (char === '\u0007' || char === '\u009c') this.terminalState = 'text';
            else if (char === '\u001b') this.terminalState = 'oscEscape';
            break;
          case 'oscEscape':
            if (char === '\\') this.terminalState = 'text';
            else if (char !== '\u001b') this.terminalState = 'osc';
            break;
          case 'string':
            if (char === '\u009c') this.terminalState = 'text';
            else if (char === '\u001b') this.terminalState = 'stringEscape';
            break;
          case 'stringEscape':
            if (char === '\\') this.terminalState = 'text';
            else if (char !== '\u001b') this.terminalState = 'string';
            break;
        }
      }
    }

    if (final) {
      if (this.pendingCarriageReturn) output.push('\n');
      this.pendingCarriageReturn = false;
      this.terminalState = 'text';
    }

    return sanitizeBinaryOutput(output.join(''));
  }

  private appendTextCharacter(char: string, output: string[]): void {
    if (this.pendingCarriageReturn) {
      output.push('\n');
      this.pendingCarriageReturn = false;
      if (char === '\n') return;
    }
    if (char === '\r') {
      this.pendingCarriageReturn = true;
      return;
    }
    output.push(char);
  }
}

function normalizePipeOutput(text: string): string {
  const decoder = new StreamingExecOutputDecoder();
  return decoder.writeText(text) + decoder.finish();
}

function appendNormalizedOutput(session: ExecSession, text: string): void {
  if (text) session.output.append(text);
}

function appendOutput(session: ExecSession, text: string): void {
  appendNormalizedOutput(session, normalizePipeOutput(text));
}

function appendOutputDelta(session: ExecSession, deltaBase64: string): void {
  appendNormalizedOutput(session, session.outputDecoder.writeBase64(deltaBase64));
}

function finishOutputDeltas(session: ExecSession): void {
  appendNormalizedOutput(session, session.outputDecoder.finish());
}

function consumeOutput(session: ExecSession, maxOutputTokens?: number): ExecOutputSnapshot {
  const snapshot = session.output.snapshotSince(session.emittedCursor, maxOutputTokens);
  session.emittedCursor = session.output.cursor();
  return snapshot;
}

function peekOutputSince(
  session: ExecSession,
  baseline: number,
  maxOutputTokens?: number,
): ExecOutputSnapshot {
  return session.output.snapshotSince(baseline, maxOutputTokens);
}

function resultFromSnapshot(
  session: ExecSession,
  waitMs: number,
  snapshot: {
    output: string;
    original_token_count?: number | undefined;
    truncation?: TruncationResult | undefined;
    full_output_path?: string | undefined;
  },
): UnifiedExecResult {
  const result: UnifiedExecResult = {
    chunk_id: generateChunkId(),
    wall_time_seconds: waitMs / 1000,
    output: snapshot.output,
    exec_session_id: session.id,
  };
  if (snapshot.original_token_count !== undefined)
    result.original_token_count = snapshot.original_token_count;
  if (snapshot.truncation !== undefined) result.truncation = snapshot.truncation;
  if (snapshot.full_output_path !== undefined) result.full_output_path = snapshot.full_output_path;
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
  onProgress?: (elapsedMs: number) => void,
): Promise<number> {
  const start = Date.now();
  let lastProgressMs = -Infinity;
  const emitProgress = () => {
    if (!onProgress || session.exitCode !== undefined) return;
    const elapsedMs = Date.now() - start;
    onProgress(elapsedMs);
    lastProgressMs = elapsedMs;
  };
  emitProgress();
  while (session.exitCode === undefined && Date.now() - start < waitMs) {
    if (Date.now() - start - lastProgressMs >= EXEC_PROGRESS_UPDATE_INTERVAL_MS) {
      emitProgress();
    }
    await sleep(Math.min(50, waitMs - (Date.now() - start)), signal);
  }
  return Date.now() - start;
}

function normalizeExitCode(response: CommandExecResponse): number {
  return typeof response.exitCode === 'number' ? response.exitCode : (response.exit_code ?? 1);
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

function parseApplyPatchParams(params: unknown): ApplyPatchParams {
  if (
    !params ||
    typeof params !== 'object' ||
    !('input' in params) ||
    typeof params.input !== 'string'
  ) {
    throw new Error("apply_patch requires a string 'input' parameter");
  }
  return { input: params.input };
}

function prepareApplyPatchArguments(args: unknown): ApplyPatchParams {
  if (args && typeof args === 'object') {
    if ('input' in args && typeof args.input === 'string') return { input: args.input };
    if ('patchText' in args && typeof args.patchText === 'string') return { input: args.patchText };
    if ('patch' in args && typeof args.patch === 'string') return { input: args.patch };
  }
  return args as ApplyPatchParams;
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
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const environment = createShellEnvironment(env);
  return buildCommandExecRequestWithEnvironment(params, cwd, processId, environment);
}

function buildCommandExecRequestWithEnvironment(
  params: ExecCommandParams,
  cwd: string,
  processId: string,
  environment: Record<string, string>,
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
    env: environment,
    sandboxPolicy: { type: 'dangerFullAccess' },
  };
}

function buildApplyPatchCommandExecRequestWithEnvironment(
  params: ApplyPatchParams,
  cwd: string,
  environment: Record<string, string>,
): Record<string, unknown> {
  return {
    command: ['apply_patch', params.input],
    cwd,
    disableOutputCap: true,
    disableTimeout: true,
    env: environment,
    sandboxPolicy: { type: 'dangerFullAccess' },
  };
}

function createShellEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const shellEnv = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && shouldForwardShellEnvironmentVariable(entry[0]),
    ),
  );
  const binDir = path.join(getAgentDir(), 'bin');
  const pathKey = Object.keys(shellEnv).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  shellEnv[pathKey] = dedupePathEntries([
    binDir,
    ...(shellEnv[pathKey] ?? '').split(path.delimiter),
  ]);
  shellEnv.CLICOLOR = '0';
  shellEnv.FORCE_COLOR = '0';
  shellEnv.NO_COLOR = '1';
  return shellEnv;
}

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function commandExistsOnPath(command: string, environment: Record<string, string>): boolean {
  if (path.isAbsolute(command) || command.includes(path.sep)) return isExecutableFile(command);
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const pathValue = environment[pathKey];
  if (!pathValue) return false;
  return pathValue
    .split(path.delimiter)
    .some((entry) => entry.length > 0 && isExecutableFile(path.join(entry, command)));
}

function shouldForwardShellEnvironmentVariable(name: string): boolean {
  const normalized = name.toUpperCase();
  return SHELL_ENVIRONMENT_ALLOWLIST.some((pattern) =>
    matchesShellEnvironmentPattern(normalized, pattern),
  );
}

function matchesShellEnvironmentPattern(normalizedName: string, pattern: string): boolean {
  const normalizedPattern = pattern.toUpperCase();
  if (!normalizedPattern.endsWith('*')) return normalizedName === normalizedPattern;
  return normalizedName.startsWith(normalizedPattern.slice(0, -1));
}

function dedupePathEntries(entries: string[]): string {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of entries) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    deduped.push(entry);
  }
  return deduped.join(path.delimiter);
}

function formatApplyPatchOutput(response: CommandExecResponse): string {
  const stdout = typeof response.stdout === 'string' ? response.stdout : '';
  const stderr = typeof response.stderr === 'string' ? response.stderr : '';
  return stdout || stderr || 'apply_patch completed with no output';
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
  if (result.truncation?.truncated) {
    sections.push(formatExecTruncationNotice(result.truncation, result.full_output_path));
  }
  sections.push('Output:', result.output);
  return sections.join('\n');
}

function formatExecTruncationNotice(
  truncation: TruncationResult,
  fullOutputPath: string | undefined,
): string {
  const fullOutputHint = fullOutputPath ? ` Full output: ${fullOutputPath}.` : '';
  if (truncation.truncatedBy === 'lines') {
    return `[Output truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines.${fullOutputHint} Rerun with a narrower command or line range to inspect more.]`;
  }
  return `[Output truncated: showing ${truncation.outputLines} lines from the end (${formatSize(truncation.maxBytes ?? maxBytesForOutputTokens())} limit).${fullOutputHint} Rerun with a narrower command or line range to inspect more.]`;
}

function throwIfExecFailed(result: UnifiedExecResult): void {
  if (result.exit_code === undefined || result.exit_code === 0) return;
  const output = result.output.trimEnd();
  const duration = `${result.wall_time_seconds.toFixed(1)}s`;
  const id = result.exec_session_id ?? result.session_id;
  const tokens = formatExecTokenCount(result.original_token_count);
  const tokenSuffix = tokens ? ` · ${tokens}` : '';
  const status =
    id !== undefined
      ? `Exec #${id} exited ${result.exit_code} · Took ${duration}${tokenSuffix}`
      : `Command exited with code ${result.exit_code}`;
  throw new Error(output ? `${output}\n\n${status}` : status);
}

function formatExecTokenCount(tokens: number | undefined): string | undefined {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return undefined;
  if (tokens < 1000) return `${tokens} token${tokens === 1 ? '' : 's'}`;
  return `${(tokens / 1000).toFixed(1)}k tokens`;
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
  const isOpenAIResponsesApi = /^openai(?:-[a-z0-9]+)*-responses$/.test(api);
  const isGpt5ModelId = /(?:^|[/:.])gpt-5(?:$|[.-])/.test(id);
  return (
    provider.includes('codex') ||
    api.includes('codex') ||
    id.includes('codex') ||
    (provider.includes('openai') && id.includes('gpt')) ||
    isCopilotGpt ||
    (isOpenAIResponsesApi && isGpt5ModelId)
  );
}

export class CodexAppServerExecSessionManager {
  private client?: CodexAppServerWebSocketClient;
  private cleanupNotifications?: () => void;
  private nextSessionId = 1;
  private readonly applyPatchCliAvailable: boolean;
  private readonly shellEnvironment: Record<string, string>;
  private readonly sessions = new Map<number, ExecSession>();
  private readonly sessionsByProcessId = new Map<string, ExecSession>();

  constructor(private readonly options: AppServerExecSessionManagerOptions = {}) {
    this.shellEnvironment = createShellEnvironment(options.env ?? process.env);
    this.applyPatchCliAvailable = commandExistsOnPath('apply_patch', this.shellEnvironment);
  }

  hasApplyPatchCli(): boolean {
    return this.applyPatchCliAvailable;
  }

  async exec(
    input: ExecCommandParams,
    cwd: string,
    signal?: AbortSignal,
    onProgress?: ExecProgressCallback,
    toolCallId?: string,
  ): Promise<UnifiedExecResult> {
    const client = await this.getClient(signal);
    const session = this.createSession(input, toolCallId);
    const request = buildCommandExecRequestWithEnvironment(
      input,
      cwd,
      session.processId,
      this.shellEnvironment,
    );
    this.sessions.set(session.id, session);
    this.sessionsByProcessId.set(session.processId, session);

    void client
      .callRpc('command/exec', request, LONG_RUNNING_RPC_TIMEOUT_MS)
      .then((response: CommandExecResponse) => {
        finishOutputDeltas(session);
        if (typeof response.stdout === 'string') appendOutput(session, response.stdout);
        if (typeof response.stderr === 'string') appendOutput(session, response.stderr);
        session.exitCode = normalizeExitCode(response);
      })
      .catch((error: unknown) => {
        finishOutputDeltas(session);
        appendOutput(session, `${error instanceof Error ? error.message : String(error)}\n`);
        session.exitCode = 1;
      });

    const waitedMs = await waitForExitOrTimeout(
      session,
      clampExecYieldTime(input.yield_time_ms, DEFAULT_EXEC_YIELD_TIME_MS, session.tty),
      signal,
      (elapsedMs) => {
        onProgress?.(
          resultFromSnapshot(
            session,
            elapsedMs,
            peekOutputSince(session, session.emittedCursor, input.max_output_tokens),
          ),
        );
      },
    );
    const result = resultFromSnapshot(
      session,
      waitedMs,
      consumeOutput(session, input.max_output_tokens),
    );
    if (session.exitCode !== undefined && session.emittedCursor === session.output.cursor()) {
      await this.deleteSession(session);
    }
    return result;
  }

  async write(
    input: WriteStdinParams,
    signal?: AbortSignal,
    onProgress?: ExecProgressCallback,
  ): Promise<UnifiedExecResult> {
    const session = this.sessions.get(input.session_id);
    if (!session) throw new Error(`Unknown process id ${input.session_id}`);
    const baseline = session.output.cursor();
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
      (elapsedMs) => {
        onProgress?.(
          resultFromSnapshot(
            session,
            elapsedMs,
            peekOutputSince(session, baseline, input.max_output_tokens),
          ),
        );
      },
    );
    const result = resultFromSnapshot(
      session,
      waitedMs,
      peekOutputSince(session, baseline, input.max_output_tokens),
    );
    session.emittedCursor = session.output.cursor();
    if (session.exitCode !== undefined && session.emittedCursor === session.output.cursor()) {
      await this.deleteSession(session);
    }
    return result;
  }

  async applyPatch(
    input: ApplyPatchParams,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{ output: string; response: CommandExecResponse }> {
    const client = await this.getClient(signal);
    const response = (await client.callRpc(
      'command/exec',
      buildApplyPatchCommandExecRequestWithEnvironment(input, cwd, this.shellEnvironment),
      LONG_RUNNING_RPC_TIMEOUT_MS,
      signal,
    )) as CommandExecResponse;
    const exitCode = normalizeExitCode(response);
    const output = formatApplyPatchOutput(response);
    if (exitCode !== 0) {
      throw new Error(`apply_patch failed: ${output.trim()}`);
    }
    return { output, response };
  }

  getSessionCommand(sessionId: number): string | undefined {
    return this.sessions.get(sessionId)?.command;
  }

  listSessions(): ExecSessionSummary[] {
    return [...this.sessions.values()].map((session) => ({
      session_id: session.id,
      command: session.command,
      running: session.exitCode === undefined,
      tty: session.tty,
      started_at: session.startedAt,
      buffered_chars: session.output.bufferedChars(),
      ...(session.exitCode === undefined ? {} : { exit_code: session.exitCode }),
    }));
  }

  close(): void {
    this.cleanupNotifications?.();
    this.cleanupNotifications = undefined;
    this.client?.close();
    this.client = undefined;
    for (const session of this.sessions.values()) session.output.dispose();
    this.sessions.clear();
    this.sessionsByProcessId.clear();
  }

  private createSession(input: ExecCommandParams, toolCallId: string | undefined): ExecSession {
    const id = this.nextSessionId++;
    return {
      id,
      processId: `pi-app-server-${process.pid}-${Date.now()}-${id}`,
      command: input.cmd,
      output: new ExecOutputAccumulator({
        fileStem: toolCallId ? `exec_${toolCallId}` : `exec_session-${id}`,
      }),
      outputDecoder: new StreamingExecOutputDecoder(),
      emittedCursor: 0,
      exitCode: undefined,
      startedAt: Date.now(),
      tty: Boolean(input.tty),
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
    appendOutputDelta(session, deltaBase64);
  }

  private async deleteSession(session: ExecSession): Promise<void> {
    this.sessions.delete(session.id);
    this.sessionsByProcessId.delete(session.processId);
    await session.output.closeTempFile();
  }
}

export function registerAppServerExecControlTools(
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
    renderCall: renderExecCommandCall,
    renderResult: renderExecCommandResult,
    async execute(toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
      const typedParams = parseExecCommandParams(params);
      const emitUpdate = (partial: UnifiedExecResult) => {
        onUpdate?.({
          content: [{ type: 'text', text: formatUnifiedExecResult(partial, typedParams.cmd) }],
          details: { ...partial, command: typedParams.cmd },
        });
      };
      const result = await sessions.exec(typedParams, ctx.cwd, signal, emitUpdate, toolCallId);
      throwIfExecFailed(result);
      return {
        content: [{ type: 'text', text: formatUnifiedExecResult(result, typedParams.cmd) }],
        details: { ...result, command: typedParams.cmd },
      };
    },
  });

  pi.registerTool({
    name: 'write_stdin',
    label: 'write_stdin',
    description: 'Write/poll exec session.',
    promptSnippet: 'Write to exec session.',
    parameters: WRITE_STDIN_PARAMETERS,
    renderCall: renderWriteStdinCall,
    renderResult: renderExecCommandResult,
    async execute(_toolCallId, params, signal, onUpdate) {
      const typedParams = parseWriteStdinParams(params);
      const command = sessions.getSessionCommand(typedParams.session_id);
      const emitUpdate = (partial: UnifiedExecResult) => {
        onUpdate?.({
          content: [{ type: 'text', text: formatUnifiedExecResult(partial, command) }],
          details: command ? { ...partial, command } : partial,
        });
      };
      const result = await sessions.write(typedParams, signal, emitUpdate);
      throwIfExecFailed(result);
      return {
        content: [{ type: 'text', text: formatUnifiedExecResult(result, command) }],
        details: command ? { ...result, command } : result,
      };
    },
  });
}

export function registerAppServerApplyPatchTool(
  pi: ExtensionAPI,
  sessions: CodexAppServerExecSessionManager,
): void {
  pi.registerTool({
    name: 'apply_patch',
    label: 'apply_patch',
    description: 'Patch files.',
    promptSnippet: 'Edit files with patch.',
    parameters: APPLY_PATCH_PARAMETERS,
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    prepareArguments: prepareApplyPatchArguments as (args: unknown) => ApplyPatchParams,
    renderCall: renderApplyPatchCall,
    renderResult: renderApplyPatchResult,
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const typedParams = parseApplyPatchParams(params);
      if (!sessions.hasApplyPatchCli()) {
        return executeApplyPatchPayload(
          typedParams.input,
          ctx.cwd,
          signal,
          _onUpdate as any,
          ctx as any,
        );
      }
      const result = await sessions.applyPatch(typedParams, ctx.cwd, signal);
      const originalTokenCount =
        result.output.length > 0 ? Math.ceil(result.output.length / 4) : undefined;
      return {
        content: [{ type: 'text', text: result.output }],
        details: {
          ...result.response,
          ...(originalTokenCount !== undefined ? { original_token_count: originalTokenCount } : {}),
        },
      };
    },
  });
}

export function registerAppServerExecTools(
  pi: ExtensionAPI,
  sessions: CodexAppServerExecSessionManager,
): void {
  registerAppServerExecControlTools(pi, sessions);
  registerAppServerApplyPatchTool(pi, sessions);
}
