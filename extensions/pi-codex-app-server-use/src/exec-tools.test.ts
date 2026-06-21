import { describe, expect, test, vi } from 'vitest';

import {
  CodexAppServerExecSessionManager,
  buildCommandExecRequest,
  checkCodexAppServerControlSocket,
  formatUnifiedExecResult,
  registerAppServerExecTools,
  shouldUseAppServerExecTools,
} from './exec-tools';

function createPendingClient(options: { allowWrite?: boolean } = {}) {
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
        if (method === 'command/exec/write') {
          if (!options.allowWrite) throw new Error('write RPC should not be called');
          return Promise.resolve({});
        }
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

  test('formats exec truncation metadata as a model-visible continuation notice', () => {
    expect(
      formatUnifiedExecResult({
        chunk_id: 'abc123',
        wall_time_seconds: 1.25,
        output: 'line 106\nline 107',
        exit_code: 0,
        truncation: {
          content: 'line 106\nline 107',
          truncated: true,
          truncatedBy: 'lines',
          totalLines: 2105,
          outputLines: 2000,
          totalBytes: 25_000,
          outputBytes: 20_000,
          lastLinePartial: false,
          firstLineExceedsLimit: false,
          maxLines: 2000,
          maxBytes: 40_000,
        },
      }),
    ).toContain(
      '[Output truncated: showing last 2000 of 2105 lines. Rerun with a narrower command or line range to inspect more.]',
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
    expect(result).toMatchObject({ details: { original_token_count: 2 } });
    sessions.close();
  });

  test('exec_command rejects non-zero exits as tool errors with output preserved', async () => {
    const fake = createResolvingClient({ exitCode: 2, stdout: 'bad output\n', stderr: '' });
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

    const tool = registeredTools.find((registeredTool) => registeredTool.name === 'exec_command')!;
    await expect(
      tool.execute?.('call-1', { cmd: 'exit 2', yield_time_ms: 250 }, undefined, undefined, {
        cwd: '/repo',
      }),
    ).rejects.toThrow(/bad output\n\nExec #1 exited 2 · Took \d+\.\d+s/);
    sessions.close();
  });

  test('write_stdin rejects non-zero exits as tool errors with output preserved', async () => {
    const registeredTools: Array<{ name: string; execute?: (...args: any[]) => Promise<any> }> = [];
    registerAppServerExecTools(
      {
        registerTool(tool: { name: string; execute?: (...args: any[]) => Promise<any> }) {
          registeredTools.push(tool);
        },
      } as any,
      {
        getSessionCommand: () => 'npm test',
        write: async () => ({
          chunk_id: 'abc123',
          wall_time_seconds: 0.5,
          exec_session_id: 15,
          output: 'failed tests\n',
          original_token_count: 2_345,
          exit_code: 1,
        }),
      } as any,
    );

    const tool = registeredTools.find((registeredTool) => registeredTool.name === 'write_stdin')!;
    await expect(
      tool.execute?.('call-2', { session_id: 15, yield_time_ms: 250 }, undefined, undefined),
    ).rejects.toThrow(/failed tests\n\nExec #15 exited 1 · Took 0\.5s · 2\.3k tokens/);
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

  test('exec_command streams partial updates with session id and output', async () => {
    vi.useFakeTimers();
    const fake = createPendingClient();
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
    const updates: any[] = [];
    const tool = registeredTools.find((registeredTool) => registeredTool.name === 'exec_command')!;

    const pending = tool.execute?.(
      'call-1',
      { cmd: 'sleep 10', yield_time_ms: 6_000 },
      undefined,
      (update: unknown) => updates.push(update),
      { cwd: '/repo' },
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(updates.at(-1)?.details).toMatchObject({
      exec_session_id: 1,
      session_id: 1,
      command: 'sleep 10',
    });
    const execCall = fake.calls.find((call) => call.method === 'command/exec')!;
    const processId = (execCall.params as { processId: string }).processId;
    fake.emit({
      method: 'command/exec/outputDelta',
      params: { processId, deltaBase64: Buffer.from('ready\n').toString('base64') },
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(updates.some((update) => update.details?.output?.includes('ready'))).toBe(true);
    await vi.advanceTimersByTimeAsync(5_750);
    await expect(pending).resolves.toMatchObject({
      details: { exec_session_id: 1, session_id: 1, command: 'sleep 10' },
    });
    sessions.close();
    vi.useRealTimers();
  });

  test('write_stdin streams partial updates for new output since the poll baseline', async () => {
    vi.useFakeTimers();
    const fake = createPendingClient({ allowWrite: true });
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

    const startedPromise = sessions.exec({ cmd: 'cat', tty: true, yield_time_ms: 250 }, '/repo');
    await vi.advanceTimersByTimeAsync(250);
    const started = await startedPromise;
    const writeTool = registeredTools.find(
      (registeredTool) => registeredTool.name === 'write_stdin',
    )!;
    const updates: any[] = [];
    const pending = writeTool.execute?.(
      'call-2',
      { session_id: started.session_id, chars: 'x', yield_time_ms: 500 },
      undefined,
      (update: unknown) => updates.push(update),
    );
    await Promise.resolve();
    const execCall = fake.calls.find((call) => call.method === 'command/exec')!;
    const processId = (execCall.params as { processId: string }).processId;
    fake.emit({
      method: 'command/exec/outputDelta',
      params: { processId, deltaBase64: Buffer.from('response\n').toString('base64') },
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(updates.some((update) => update.details?.output?.includes('response'))).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toMatchObject({
      details: { exec_session_id: 1, session_id: 1, command: 'cat' },
    });
    sessions.close();
    vi.useRealTimers();
  });

  test('lists running exec sessions for /ps-style status', async () => {
    const pending = createPendingClient();
    const manager = new CodexAppServerExecSessionManager({
      clientFactory: () => pending.client as any,
    });

    const first = await manager.exec({ cmd: 'sleep 10', yield_time_ms: 250 }, '/tmp');

    expect(first.session_id).toBe(1);
    expect(manager.listSessions()).toEqual([
      expect.objectContaining({ session_id: 1, command: 'sleep 10', running: true }),
    ]);
  });

  test('truncates exec output by line count before returning it to the model', async () => {
    const stdout = Array.from({ length: 2105 }, (_unused, index) => `line ${index + 1}`).join('\n');
    const fake = createResolvingClient({ exitCode: 0, stdout, stderr: '' });
    const sessions = new CodexAppServerExecSessionManager({
      clientFactory: () => fake.client as any,
    });

    const result = await sessions.exec({ cmd: 'seq 1 2105', yield_time_ms: 250 }, '/repo');

    expect(result.output.startsWith('line 106\n')).toBe(true);
    expect(result.output).toContain('line 2105');
    expect(result.truncation).toMatchObject({
      truncated: true,
      truncatedBy: 'lines',
      totalLines: 2105,
      outputLines: 2000,
      maxLines: 2000,
    });
    sessions.close();
  });

  test('strips binary/control bytes from non-tty exec output before returning it', async () => {
    const fake = createResolvingClient({
      exitCode: 0,
      stdout: 'ok\u0000\u001b[31mred\u001b[0m\ufffd\u0085done\n',
      stderr: '',
    });
    const sessions = new CodexAppServerExecSessionManager({
      clientFactory: () => fake.client as any,
    });

    const result = await sessions.exec({ cmd: 'binary-ish', yield_time_ms: 250 }, '/repo');

    expect(result.output).toBe('okreddone\n');
    sessions.close();
  });

  test('strips binary/control bytes from tty exec output before returning it', async () => {
    const fake = createResolvingClient({
      exitCode: 0,
      stdout: 'ok\u0000\u001b[31mred\u001b[0m\ufffd\u0085done\n',
      stderr: '',
    });
    const sessions = new CodexAppServerExecSessionManager({
      clientFactory: () => fake.client as any,
    });

    const result = await sessions.exec(
      { cmd: 'binary-ish', tty: true, yield_time_ms: 250 },
      '/repo',
    );

    expect(result.output).toBe('okreddone\n');
    sessions.close();
  });
});
