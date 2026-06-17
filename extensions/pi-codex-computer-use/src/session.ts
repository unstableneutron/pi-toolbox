import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { CodexAppServerClient, CodexAppServerWebSocketClient } from './app-server';
import {
  ensureChromeExtensionAppServer,
  getConfiguredChromeAppServerOrigin,
} from './chrome-extension-host';
import { getCodexComputerUsePaths } from './codex-paths';
import { answerComputerUseElicitation } from './elicitation';

const COMPUTER_USE_SERVER = 'computer-use';
const NODE_REPL_SERVER = 'node_repl';
const RETRYABLE_OBSERVATION_TOOLS = new Set(['list_apps', 'get_app_state']);
const TRANSIENT_PROCESS_ERROR = /NSOSStatusErrorDomain Code=-600|procNotFound/;
const USE_DESKTOP_APP_SERVER_ENV = 'PI_CODEX_USE_DESKTOP_APP_SERVER';
const DESKTOP_APP_SERVER_SOCKET_ENV = 'PI_CODEX_DESKTOP_APP_SERVER_SOCKET';
const DESKTOP_APP_SERVER_ORIGIN_ENV = 'PI_CODEX_DESKTOP_APP_SERVER_ORIGIN';

type CodexAppServerBridgeClient = CodexAppServerClient | CodexAppServerWebSocketClient;

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

function getRawResultText(rawResult: any): string {
  const content = rawResult?.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => ('text' === part?.type && 'string' === typeof part.text ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(rawResult ?? null);
}

function getMcpErrorMessage(rawResult: any): string | undefined {
  if (rawResult?.isError !== true) return undefined;
  return getRawResultText(rawResult) || 'Codex MCP tool returned an error';
}

function isRetryableMcpError(server: string, codexTool: string, message: string): boolean {
  return (
    server === COMPUTER_USE_SERVER &&
    RETRYABLE_OBSERVATION_TOOLS.has(codexTool) &&
    TRANSIENT_PROCESS_ERROR.test(message)
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readBooleanEnv(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function getConfiguredDesktopAppServerSocket(): string | undefined {
  if (!readBooleanEnv(USE_DESKTOP_APP_SERVER_ENV)) return undefined;
  const socketPath = process.env[DESKTOP_APP_SERVER_SOCKET_ENV]?.trim();
  if (!socketPath) {
    throw new Error(
      `${USE_DESKTOP_APP_SERVER_ENV}=1 requires ${DESKTOP_APP_SERVER_SOCKET_ENV} to point at the Codex.app wrapper socket.`,
    );
  }
  return socketPath;
}

function getConfiguredDesktopAppServerOrigin(): string {
  return process.env[DESKTOP_APP_SERVER_ORIGIN_ENV]?.trim() || 'app://codex';
}

function isUnknownMcpServerError(error: unknown): boolean {
  return /unknown MCP server/i.test(getErrorMessage(error));
}

function shouldResetBridgeAfterError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return message.includes('Operation aborted') || message.includes('timed out after');
}

function makeUnknownMcpServerError(error: unknown): Error {
  return new Error(
    `${getErrorMessage(error)}. Run /codex-computer-use-doctor to install, enable, or reset Codex Computer Use.`,
  );
}

function formatPathStatus(label: string, filePath: string | undefined): string {
  if (!filePath) {
    return `${label}: (not found)`;
  }
  return `${label}: ${filePath} [${fs.existsSync(filePath) ? 'exists' : 'missing'}]`;
}

function truncate(value: string, maxLength = 100): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function normalizeMcpServers(mcpStatus: any): any[] {
  if (Array.isArray(mcpStatus?.data)) return mcpStatus.data;
  if (Array.isArray(mcpStatus?.servers)) return mcpStatus.servers;
  return [];
}

function normalizeMcpTools(server: any): Array<{ name: string; description?: string }> {
  const tools = server?.tools;
  if (Array.isArray(tools)) {
    return tools
      .map((tool) => ({
        name: String(tool?.name ?? '(unnamed)'),
        description: 'string' === typeof tool?.description ? tool.description : undefined,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
  if (tools && 'object' === typeof tools) {
    return Object.values(tools)
      .map((tool: any) => ({
        name: String(tool?.name ?? '(unnamed)'),
        description: 'string' === typeof tool?.description ? tool.description : undefined,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
  return [];
}

function formatMcpServerLine(server: any): string {
  const tools = normalizeMcpTools(server);
  const authStatus = server?.authStatus ? ` auth: ${server.authStatus}` : '';
  return `  ✓ ${server.name}${authStatus} tools: ${tools.length}`;
}

function formatMcpServerTools(server: any): string[] {
  return normalizeMcpTools(server)
    .slice(0, 12)
    .map((tool) => {
      const description = tool.description ? ` — ${truncate(tool.description)}` : '';
      return `    - ${tool.name}${description}`;
    });
}

function formatMcpSummary(mcpStatus: unknown): string[] {
  const lines: string[] = [];
  if ((mcpStatus as any)?.error) {
    return [`MCP servers/tools: failed to list (${(mcpStatus as any).error})`];
  }

  const servers = normalizeMcpServers(mcpStatus);
  const byName = new Map(servers.map((server) => [String(server?.name ?? ''), server]));
  const expectedNames = ['computer-use', 'node_repl'];

  lines.push('Expected bridge servers:');
  for (const name of expectedNames) {
    const server = byName.get(name);
    if (!server) {
      lines.push(`  ✗ ${name} (not reported)`);
      continue;
    }
    lines.push(formatMcpServerLine(server), ...formatMcpServerTools(server));
  }

  lines.push('', 'Other app-server MCP servers:');
  const otherServers = servers.filter((server) => !expectedNames.includes(String(server?.name)));
  if (otherServers.length === 0) {
    lines.push('  (none)');
  } else {
    for (const server of otherServers) {
      const tools = normalizeMcpTools(server);
      const authStatus = server?.authStatus ? ` auth: ${server.authStatus}` : '';
      lines.push(`  - ${server.name}${authStatus} tools: ${tools.length}`);
    }
  }
  return lines;
}

function writeVerboseDiagnosticJson(value: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-codex-computer-use-'));
  const filePath = path.join(directory, 'diagnostics.json');
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

interface CodexMcpToolCall {
  server: string;
  tool: string;
  arguments?: unknown;
  timeoutMs?: number;
}

type BrowserBackend = 'iab' | 'chrome';

interface ChromeBrowserBridgeOptions {
  debugBaseUrl?: string;
  extensionId?: string;
}

function buildNodeReplRequestMeta(threadId: string, turnNumber: number): Record<string, unknown> {
  return {
    'x-codex-turn-metadata': {
      session_id: threadId,
      thread_id: threadId,
      thread_source: 'pi-codex-computer-use',
      turn_id: `pi-codex-computer-use-turn-${turnNumber}`,
    },
  };
}

export interface CodexDiagnosticStatusOptions {
  verbose?: boolean;
}

export class ComputerUseSession {
  private client?: CodexAppServerBridgeClient;
  private chromeClient?: CodexAppServerWebSocketClient;
  private chromeClientKey?: string;
  private chromeThreadId?: string;
  private threadId?: string;
  private nextNodeReplTurnNumber = 1;

  async getStatus(ctx: ExtensionContext): Promise<string> {
    return await this.getDiagnosticStatus(ctx);
  }

  async getDiagnosticStatus(
    ctx: ExtensionContext,
    options: CodexDiagnosticStatusOptions = {},
  ): Promise<string> {
    const paths = getCodexComputerUsePaths();
    const cwd = ctx.cwd ?? process.cwd();
    const lines = [
      'pi-codex-computer-use diagnostics',
      '',
      'Codex paths:',
      formatPathStatus('  Codex app', paths.codexApp),
      formatPathStatus('  Codex executable', paths.codexExecutable),
      formatPathStatus('  Codex home', paths.codexHome),
      formatPathStatus('  Computer Use app', paths.stableComputerUseApp),
      formatPathStatus('  Computer Use client', paths.stableComputerUseClient),
      formatPathStatus('  IAB browser client', paths.browserClientScripts.iab),
      formatPathStatus('  Chrome browser client', paths.browserClientScripts.chrome),
      '',
      'Bridge:',
      `  CWD: ${cwd}`,
      `  Pi UI: ${ctx.hasUI ? 'available' : 'not available; app/browser elicitations will be declined'}`,
    ];

    try {
      const client = await this.getClient();
      const threadId = await this.getThreadId(ctx, client);
      const processInfo = client.getProcessInfo();
      lines.push(
        `  App-server: connected (pid ${processInfo.pid ?? 'unknown'})`,
        `  Process: killed=${processInfo.killed} exitCode=${processInfo.exitCode ?? 'null'} signal=${processInfo.signalCode ?? 'null'}`,
        `  Thread: ${threadId}`,
      );
      if (processInfo.lastStderr.length > 0) {
        lines.push('  Recent stderr:', ...processInfo.lastStderr.map((line) => `    ${line}`));
      }

      const servers = await client.listMcpServers(threadId).catch((error: unknown) => ({
        error: getErrorMessage(error),
      }));
      lines.push('', ...formatMcpSummary(servers));
      if (options.verbose) {
        const verbosePath = writeVerboseDiagnosticJson({
          generatedAt: new Date().toISOString(),
          cwd,
          hasUI: ctx.hasUI,
          paths,
          bridge: { threadId, processInfo },
          mcpServers: servers,
        });
        lines.push('', `Verbose diagnostic JSON: ${verbosePath}`);
      }
    } catch (error) {
      lines.push(`  App-server: failed to connect (${getErrorMessage(error)})`);
    }

    return lines.join('\n');
  }

  async callTool(
    ctx: ExtensionContext,
    codexTool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<{ threadId: string; rawResult: any }> {
    return await this.callMcpTool(
      ctx,
      {
        server: COMPUTER_USE_SERVER,
        tool: codexTool,
        arguments: args,
        timeoutMs: 30_000,
      },
      signal,
    );
  }

  async callMcpTool(
    ctx: ExtensionContext,
    input: CodexMcpToolCall,
    signal?: AbortSignal,
  ): Promise<{ threadId: string; rawResult: any }> {
    let lastError: unknown;
    for (let bridgeAttempt = 0; bridgeAttempt < 2; bridgeAttempt++) {
      const client = await this.getClient(signal);
      const threadId = await this.getThreadId(ctx, client, signal);
      const restore = client.setElicitationHandler((params) =>
        answerComputerUseElicitation(params, ctx),
      );
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const rawResult = await client.callMcpTool({
            server: input.server,
            threadId,
            tool: input.tool,
            arguments: input.arguments,
            timeoutMs: input.timeoutMs ?? 120_000,
            signal,
            ...(input.server === NODE_REPL_SERVER
              ? { _meta: buildNodeReplRequestMeta(threadId, this.nextNodeReplTurnNumber++) }
              : {}),
          });
          const errorMessage = getMcpErrorMessage(rawResult);
          if (!errorMessage) {
            return { threadId, rawResult };
          }
          if (attempt === 0 && isRetryableMcpError(input.server, input.tool, errorMessage)) {
            await sleep(250, signal);
            continue;
          }
          throw new Error(`Codex MCP ${input.server}.${input.tool} failed: ${errorMessage}`);
        }
        throw new Error(`Codex MCP ${input.server}.${input.tool} failed unexpectedly`);
      } catch (error) {
        lastError = error;
        if (isUnknownMcpServerError(error) && bridgeAttempt === 0) {
          this.resetDefaultBridge();
          continue;
        }
        if (shouldResetBridgeAfterError(error) || isUnknownMcpServerError(error)) {
          this.resetDefaultBridge();
        }
        throw isUnknownMcpServerError(error) ? makeUnknownMcpServerError(error) : error;
      } finally {
        restore();
      }
    }
    throw isUnknownMcpServerError(lastError) ? makeUnknownMcpServerError(lastError) : lastError;
  }

  async callBrowserMcpTool(
    ctx: ExtensionContext,
    backend: BrowserBackend,
    input: CodexMcpToolCall,
    signal?: AbortSignal,
    options: ChromeBrowserBridgeOptions = {},
  ): Promise<{ threadId: string; rawResult: any }> {
    if (backend !== 'chrome') {
      return await this.callMcpTool(ctx, input, signal);
    }

    if (getConfiguredDesktopAppServerSocket()) {
      return await this.callMcpTool(ctx, input, signal);
    }

    const client = await this.getChromeClient(options, signal);
    const threadId = await this.getChromeThreadId(ctx, client, signal);
    const restore = client.setElicitationHandler((params) =>
      answerComputerUseElicitation(params, ctx),
    );
    try {
      const rawResult = await client.callMcpTool({
        server: input.server,
        threadId,
        tool: input.tool,
        arguments: input.arguments,
        timeoutMs: input.timeoutMs ?? 120_000,
        signal,
        ...(input.server === NODE_REPL_SERVER
          ? { _meta: buildNodeReplRequestMeta(threadId, this.nextNodeReplTurnNumber++) }
          : {}),
      });
      const errorMessage = getMcpErrorMessage(rawResult);
      if (errorMessage) {
        throw new Error(`Codex MCP ${input.server}.${input.tool} failed: ${errorMessage}`);
      }
      return { threadId, rawResult };
    } catch (error) {
      if (shouldResetBridgeAfterError(error) || isUnknownMcpServerError(error)) {
        this.resetChromeBridge();
      }
      throw isUnknownMcpServerError(error) ? makeUnknownMcpServerError(error) : error;
    } finally {
      restore();
    }
  }

  async getMcpServerAvailability(ctx: ExtensionContext): Promise<{
    computerUseAvailable: boolean;
    nodeReplAvailable: boolean;
  }> {
    const client = await this.getClient();
    const threadId = await this.getThreadId(ctx, client);
    const servers = normalizeMcpServers(await client.listMcpServers(threadId));
    return {
      computerUseAvailable: servers.some((server) => server?.name === COMPUTER_USE_SERVER),
      nodeReplAvailable: servers.some((server) => server?.name === NODE_REPL_SERVER),
    };
  }

  resetBridge(): void {
    this.resetDefaultBridge();
  }

  close(): void {
    this.resetDefaultBridge();
    this.resetChromeBridge();
  }

  private resetDefaultBridge(): void {
    this.client?.close();
    this.client = undefined;
    this.threadId = undefined;
  }

  private resetChromeBridge(): void {
    this.chromeClient?.close();
    this.chromeClient = undefined;
    this.chromeClientKey = undefined;
    this.chromeThreadId = undefined;
  }

  private async getClient(signal?: AbortSignal): Promise<CodexAppServerBridgeClient> {
    if (!this.client) {
      const desktopSocket = getConfiguredDesktopAppServerSocket();
      if (desktopSocket) {
        this.client = new CodexAppServerWebSocketClient({
          clientName: 'pi-codex-computer-use-desktop',
          origin: getConfiguredDesktopAppServerOrigin(),
          url: `unix://${desktopSocket}`,
        });
      } else {
        const paths = getCodexComputerUsePaths();
        this.client = new CodexAppServerClient({
          codexExecutable: paths.codexExecutable,
          codexHome: paths.codexHome,
        });
      }
      await this.client.init(signal);
    }
    return this.client;
  }

  private async getThreadId(
    ctx: ExtensionContext,
    client: CodexAppServerBridgeClient,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.threadId) {
      this.threadId = await client.startThread({
        cwd: ctx.cwd ?? process.cwd(),
        name: 'Pi Computer Use',
        signal,
      });
    }
    return this.threadId;
  }

  private async getChromeClient(
    options: ChromeBrowserBridgeOptions = {},
    signal?: AbortSignal,
  ): Promise<CodexAppServerWebSocketClient> {
    const origin = getConfiguredChromeAppServerOrigin();
    const key = JSON.stringify({
      debugBaseUrl: options.debugBaseUrl ?? null,
      extensionId: options.extensionId ?? null,
      origin,
    });
    if (this.chromeClient && this.chromeClientKey === undefined) {
      this.chromeClientKey = key;
    } else if (this.chromeClient && this.chromeClientKey !== key) {
      this.resetChromeBridge();
    }
    if (!this.chromeClient) {
      const appServer = await ensureChromeExtensionAppServer({
        debugBaseUrl: options.debugBaseUrl,
        extensionId: options.extensionId,
        signal,
      });
      this.chromeClient = new CodexAppServerWebSocketClient({
        origin,
        url: appServer.localAppServerUrl,
      });
      await this.chromeClient.init(signal);
      this.chromeClientKey = key;
    }
    return this.chromeClient;
  }

  private async getChromeThreadId(
    ctx: ExtensionContext,
    client: CodexAppServerWebSocketClient,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.chromeThreadId) {
      this.chromeThreadId = await client.startThread({
        cwd: ctx.cwd ?? process.cwd(),
        name: 'Pi Chrome Browser',
        signal,
      });
    }
    return this.chromeThreadId;
  }
}
