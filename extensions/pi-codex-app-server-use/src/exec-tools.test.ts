import { describe, expect, test, vi } from 'vitest';

import {
  CodexAppServerExecSessionManager,
  buildCommandExecRequest,
  checkCodexAppServerControlSocket,
  formatUnifiedExecResult,
  registerAppServerExecTools,
  shouldUseAppServerExecTools,
} from './exec-tools';

function createPendingClient() {
  let notificationHandler: ((message: { method?: string; params?: unknown }) => void) | undefined;
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    emit(message: { method?: string; params?: unknown }) {
      notificationHandler?.(message);
    },
    client: {
      init: async () => undefined,
      close: () => undefined,
      onNotification(handler: (message: { method?: string; params?: unknown }) => void) {
        notificationHandler = handler;
        return () => {
          notificationHandler = undefined;
        };
      },
      callRpc(method: string, params: unknown) {
        calls.push({ method, params });
        if (method === 'command/exec/write') throw new Error('write RPC should not be called');
        return new Promise(() => undefined);
      },
    },
  };
}

function createResolvingClient(response: unknown) {
  let notificationHandler: ((message: { method?: string; params?: unknown }) => void) | undefined;
  const calls: Array<{
    method: string;
    params: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
  }> = [];
  return {
    calls,
    emit(message: { method?: string; params?: unknown }) {
      notificationHandler?.(message);
    },
    client: {
      init: async () => undefined,
      close: () => undefined,
      onNotification(handler: (message: { method?: string; params?: unknown }) => void) {
        notificationHandler = handler;
        return () => {
          notificationHandler = undefined;
        };
      },
      async callRpc(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal) {
        calls.push({ method, params, timeoutMs, signal });
        return response;
      },
    },
  };
}

describe('AppServer exec tool helpers', () => {
  test('builds danger-full-access command/exec requests from exec_command params', () => {
    expect(
      buildCommandExecRequest(
        {
          cmd: 'printf hello',
          workdir: 'subdir',
          shell: '/bin/zsh',
          tty: true,
          login: false,
        },
        '/repo',
        'pi-1',
      ),
    ).toEqual({
      command: ['/bin/zsh', '-c', 'printf hello'],
      processId: 'pi-1',
      cwd: '/repo/subdir',
      tty: true,
      streamStdin: true,
      streamStdoutStderr: true,
      disableOutputCap: true,
      disableTimeout: true,
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  });

  test('formats unified exec output in Codex-compatible transcript form', () => {
    expect(
      formatUnifiedExecResult(
        {
          chunk_id: 'abc123',
          wall_time_seconds: 1.25,
          output: 'hello\n',
          session_id: 7,
          original_token_count: 1234,
        },
        'printf hello',
      ),
    ).toBe(
      [
        'Command: printf hello',
        'Chunk ID: abc123',
        'Wall time: 1.2500 seconds',
        'Process running with session ID 7',
        'Original token count: 1234',
        'Output:',
        'hello\n',
      ].join('\n'),
    );
  });

  test('uses conservative GPT/Codex model gating by default', () => {
    expect(
      shouldUseAppServerExecTools(
        { provider: 'openai', api: 'openai-responses', id: 'gpt-5.5' },
        'auto',
      ),
    ).toBe(true);
    expect(
      shouldUseAppServerExecTools(
        { provider: 'anthropic', api: 'anthropic-messages', id: 'claude-sonnet-4-6' },
        'auto',
      ),
    ).toBe(false);
    expect(
      shouldUseAppServerExecTools(
        { provider: 'proxy', api: 'openai-websocket-responses', id: 'gpt-5.5-nomoderation' },
        'auto',
      ),
    ).toBe(true);
    expect(
      shouldUseAppServerExecTools(
        { provider: 'proxy', api: 'openai-websocket-responses', id: 'not-gpt-5' },
        'auto',
      ),
    ).toBe(false);
    expect(shouldUseAppServerExecTools(undefined, 'all')).toBe(true);
  });

  test('registers Codex-compatible exec tool descriptions and prompt snippets', () => {
    const registeredTools: Array<{ name: string; description?: string; promptSnippet?: string }> =
      [];
    registerAppServerExecTools(
      {
        registerTool(tool: { name: string; description?: string; promptSnippet?: string }) {
          registeredTools.push(tool);
        },
      } as any,
      {} as any,
    );

    expect(registeredTools).toMatchObject([
      {
        name: 'exec_command',
        description: 'Run shell commands; may return session_id.',
        promptSnippet: 'Run command.',
      },
      {
        name: 'write_stdin',
        description: 'Write/poll exec session.',
        promptSnippet: 'Write to exec session.',
      },
      {
        name: 'apply_patch',
        description: 'Patch files.',
        promptSnippet: 'Edit files with patch.',
      },
    ]);
  });

  test('apply_patch executes patch text through AppServer command/exec argv', async () => {
    const patch = '*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch';
    const fake = createResolvingClient({ exitCode: 0, stdout: 'Success\n', stderr: '' });
    const sessions = new CodexAppServerExecSessionManager({
      clientFactory: () => fake.client as any,
    });
    const registeredTools: Array<{ name: string; execute?: (...args: any[]) => Promise<any> }> = [];
    registerAppServerExecTools(
      {
        registerTool(tool: { name: string; execute?: (...args: any[]) => Promise<any> }) {
          registeredTools.push(tool);
        },
      } as any,
      sessions,
    );

    const tool = registeredTools.find((registeredTool) => registeredTool.name === 'apply_patch');
    expect(tool).toBeDefined();
    const result = await tool!.execute?.('call-1', { input: patch }, undefined, undefined, {
      cwd: '/repo',
    });

    expect(fake.calls).toMatchObject([
      {
        method: 'command/exec',
        params: {
          command: ['apply_patch', patch],
          cwd: '/repo',
          disableOutputCap: true,
          disableTimeout: true,
          sandboxPolicy: { type: 'dangerFullAccess' },
        },
      },
    ]);
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'Success\n' }] });
    sessions.close();
  });

  test('control socket health check reports missing sockets without throwing', async () => {
    const health = await checkCodexAppServerControlSocket({
      socketPath: '/tmp/pi-codex-app-server-use-missing.sock',
      timeoutMs: 250,
    });

    expect(health).toMatchObject({
      ok: false,
      socketPath: '/tmp/pi-codex-app-server-use-missing.sock',
    });
    expect(health.ok).toBe(false);
    if (health.ok) throw new Error('expected missing socket health check to fail');
    expect(health.error).toMatch(/ENOENT|Operation aborted/);
  });

  test('clamps non-interactive exec yield time to the Codex minimum', async () => {
    vi.useFakeTimers();
    const fake = createPendingClient();
    const sessions = new CodexAppServerExecSessionManager({
      clientFactory: () => fake.client as any,
    });
    let settled = false;
    const pending = sessions
      .exec({ cmd: 'sleep 10', shell: '/bin/bash', login: false, yield_time_ms: 1 }, '/repo')
      .then((result) => {
        settled = true;
        return result;
      });

    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({ session_id: 1, wall_time_seconds: 5 });
    sessions.close();
    vi.useRealTimers();
  });

  test('rejects stdin writes for non-tty exec sessions before calling AppServer write', async () => {
    vi.useFakeTimers();
    const fake = createPendingClient();
    const sessions = new CodexAppServerExecSessionManager({
      clientFactory: () => fake.client as any,
    });
    const startedPromise = sessions.exec(
      { cmd: 'sleep 10', shell: '/bin/bash', login: false, yield_time_ms: 250 },
      '/repo',
    );
    await vi.advanceTimersByTimeAsync(5000);
    const started = await startedPromise;

    await expect(
      sessions.write({ session_id: started.session_id!, chars: 'hello\n', yield_time_ms: 1 }),
    ).rejects.toThrow(/stdin is closed.*tty=true/i);
    expect(fake.calls.map((call) => call.method)).not.toContain('command/exec/write');
    sessions.close();
    vi.useRealTimers();
  });
});
