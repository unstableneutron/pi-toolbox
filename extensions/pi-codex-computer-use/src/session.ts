import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { CodexAppServerClient } from './app-server';
import { getCodexComputerUsePaths } from './codex-paths';
import { answerComputerUseElicitation } from './elicitation';

const RETRYABLE_OBSERVATION_TOOLS = new Set(['list_apps', 'get_app_state']);
const TRANSIENT_PROCESS_ERROR = /NSOSStatusErrorDomain Code=-600|procNotFound/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function isRetryableMcpError(codexTool: string, message: string): boolean {
  return RETRYABLE_OBSERVATION_TOOLS.has(codexTool) && TRANSIENT_PROCESS_ERROR.test(message);
}

export class ComputerUseSession {
  private client?: CodexAppServerClient;
  private threadId?: string;

  async getStatus(ctx: ExtensionContext): Promise<string> {
    const paths = getCodexComputerUsePaths();
    const threadId = this.threadId ?? '(not started)';
    const lines = [
      'pi-codex-computer-use status',
      '',
      `Codex executable: ${paths.codexExecutable}`,
      `Codex home: ${paths.codexHome}`,
      `Computer Use app: ${paths.stableComputerUseApp}`,
      `Computer Use client: ${paths.stableComputerUseClient}`,
      `Thread: ${threadId}`,
    ];

    if (this.client && this.threadId) {
      const servers = await this.client.listMcpServers(this.threadId).catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }));
      lines.push('', `MCP status: ${JSON.stringify(servers).slice(0, 2000)}`);
    }

    if (!ctx.hasUI) {
      lines.push('', 'No Pi UI is available; app-use elicitations will be declined.');
    }

    return lines.join('\n');
  }

  async callTool(
    ctx: ExtensionContext,
    codexTool: string,
    args: unknown,
  ): Promise<{ threadId: string; rawResult: any }> {
    const client = await this.getClient();
    const threadId = await this.getThreadId(ctx, client);
    const restore = client.setElicitationHandler((params) =>
      answerComputerUseElicitation(params, ctx),
    );
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const rawResult = await client.callMcpTool({
          server: 'computer-use',
          threadId,
          tool: codexTool,
          arguments: args,
          timeoutMs: 120_000,
        });
        const errorMessage = getMcpErrorMessage(rawResult);
        if (!errorMessage) {
          return { threadId, rawResult };
        }
        if (attempt === 0 && isRetryableMcpError(codexTool, errorMessage)) {
          await sleep(250);
          continue;
        }
        throw new Error(`Codex Computer Use ${codexTool} failed: ${errorMessage}`);
      }
      throw new Error(`Codex Computer Use ${codexTool} failed unexpectedly`);
    } finally {
      restore();
    }
  }

  close(): void {
    this.client?.close();
    this.client = undefined;
    this.threadId = undefined;
  }

  private async getClient(): Promise<CodexAppServerClient> {
    if (!this.client) {
      const paths = getCodexComputerUsePaths();
      this.client = new CodexAppServerClient({
        codexExecutable: paths.codexExecutable,
        codexHome: paths.codexHome,
      });
      await this.client.init();
    }
    return this.client;
  }

  private async getThreadId(ctx: ExtensionContext, client: CodexAppServerClient): Promise<string> {
    if (!this.threadId) {
      this.threadId = await client.startThread({
        cwd: ctx.cwd ?? process.cwd(),
        name: 'Pi Computer Use',
      });
    }
    return this.threadId;
  }
}
