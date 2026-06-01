import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { McpElicitationRequestParams, McpElicitationResponse } from './elicitation';

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { message?: string; code?: number; data?: unknown };
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexAppServerClientOptions {
  codexExecutable: string;
  codexHome: string;
  clientName?: string;
  onElicitation?: (params: McpElicitationRequestParams) => Promise<McpElicitationResponse>;
}

export interface CodexThreadStartOptions {
  cwd: string;
  name?: string;
}

export interface CodexAppServerProcessInfo {
  pid?: number;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  lastStderr: string[];
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const THREAD_START_TIMEOUT_MS = 60_000;

function sendJsonLine(stream: NodeJS.WritableStream, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

export class CodexAppServerClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly codexHome: string;
  private readonly clientName: string;
  private buffer = '';
  private nextId = 1;
  private initialized?: Promise<void>;
  private readonly stderrLines: string[] = [];
  private onElicitation?: (params: McpElicitationRequestParams) => Promise<McpElicitationResponse>;

  constructor(options: CodexAppServerClientOptions) {
    this.codexHome = options.codexHome;
    this.clientName = options.clientName ?? 'pi-codex-computer-use';
    this.onElicitation = options.onElicitation;
    this.process = spawn(options.codexExecutable, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: options.codexHome },
    });
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (chunk) => this.recordStderr(chunk));
    this.process.on('exit', (code, signal) => {
      const error = new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'})`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  setElicitationHandler(
    handler: ((params: McpElicitationRequestParams) => Promise<McpElicitationResponse>) | undefined,
  ): () => void {
    const previous = this.onElicitation;
    this.onElicitation = handler;
    return () => {
      this.onElicitation = previous;
    };
  }

  async init(): Promise<void> {
    this.initialized ??= this.initialize();
    await this.initialized;
  }

  async startThread(options: CodexThreadStartOptions): Promise<string> {
    await this.init();
    const response = await this.request(
      'thread/start',
      {
        cwd: options.cwd,
        ephemeral: true,
        approvalPolicy: 'on-request',
        baseInstructions:
          'Pi-created Codex native tool bridge thread. Only execute Computer Use and browser Node REPL MCP calls requested by Pi.',
      },
      THREAD_START_TIMEOUT_MS,
    );
    const threadId = response?.thread?.id;
    if ('string' !== typeof threadId || threadId.length === 0) {
      throw new Error('Codex app-server did not return a thread id');
    }
    if (options.name) {
      await this.request('thread/name/set', { threadId, name: options.name }, 10_000).catch(() => {
        // Naming is cosmetic; keep the bridge usable if this fails.
      });
    }
    return threadId;
  }

  async callMcpTool(input: {
    threadId: string;
    server: string;
    tool: string;
    arguments?: unknown;
    timeoutMs?: number;
    _meta?: Record<string, unknown>;
  }): Promise<any> {
    await this.init();
    return await this.request(
      'mcpServer/tool/call',
      {
        server: input.server,
        threadId: input.threadId,
        tool: input.tool,
        arguments: input.arguments ?? {},
        ...(input._meta ? { _meta: input._meta } : {}),
      },
      input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
  }

  async listMcpServers(threadId?: string): Promise<any> {
    await this.init();
    return await this.request('mcpServerStatus/list', {
      detail: 'toolsAndAuthOnly',
      limit: 50,
      cursor: null,
      threadId: threadId ?? null,
    });
  }

  getProcessInfo(): CodexAppServerProcessInfo {
    return {
      pid: this.process.pid,
      killed: this.process.killed,
      exitCode: this.process.exitCode,
      signalCode: this.process.signalCode,
      lastStderr: [...this.stderrLines],
    };
  }

  close(): void {
    this.process.kill();
  }

  private recordStderr(chunk: string): void {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      this.stderrLines.push(trimmed);
    }
    if (this.stderrLines.length > 40) {
      this.stderrLines.splice(0, this.stderrLines.length - 40);
    }
  }

  private async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: this.clientName, title: null, version: '0' },
      capabilities: null,
    });
    sendJsonLine(this.process.stdin, { method: 'initialized' });
  }

  private request(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<any> {
    const id = this.nextId++;
    sendJsonLine(this.process.stdin, { id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      this.handleMessage(JSON.parse(line) as JsonRpcMessage).catch((error) => {
        if (error instanceof Error) {
          // Server-request errors are reflected to app-server in handleServerRequest.
          return;
        }
      });
    }
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    if (message.id !== undefined && message.method) {
      await this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    if (message.method !== 'mcpServer/elicitation/request') {
      sendJsonLine(this.process.stdin, {
        id: message.id,
        error: { code: -32601, message: `Unsupported app-server request: ${message.method}` },
      });
      return;
    }

    const answer = this.onElicitation
      ? await this.onElicitation(message.params as McpElicitationRequestParams)
      : { action: 'decline', content: null, _meta: null };
    sendJsonLine(this.process.stdin, { id: message.id, result: answer });
  }
}
