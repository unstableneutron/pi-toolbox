import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';
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

function createControlledClient() {
  let notificationHandler: ((message: { method?: string; params?: unknown }) => void) | undefined;
  let resolveExec: ((response: unknown) => void) | undefined;
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    emit(message: { method?: string; params?: unknown }) {
      notificationHandler?.(message);
    },
    resolve(response: unknown) {
      if (!resolveExec) throw new Error('command/exec has not started');
      resolveExec(response);
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
        return new Promise((resolve) => {
          resolveExec = resolve;
        });
      },
    },
  };
}

describe('AppServer exec tool helpers', () => {
  function createFakeApplyPatchBin(): string {
    const bin = mkdtempSync(path.join(tmpdir(), 'pi-apply-patch-bin-'));
    const executable = path.join(bin, 'apply_patch');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    return bin;
  }

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
        { PATH: '/usr/bin' },
      ),
    ).toMatchObject({
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

  test('forwards allowlisted shell env overrides into command/exec requests', () => {
    const request = buildCommandExecRequest({ cmd: 'env' }, '/repo', 'pi-1', {
      HERDR: '1',
      HERDR_ENV: '1',
      HERDR_SOCKET_PATH: '/tmp/herdr.sock',
      HERDR_PANE_ID: 'w1:p1',
      HERDR_PI_IDLE_DEBOUNCE_MS: '10000',
      PATH: '/usr/bin',
      TMUX: '/tmp/tmux-501/default,123,0',
      TMUX_PANE: '%1',
      ZELLIJ: '0',
      ZELLIJ_SOCKET_DIR: '/tmp/zellij',
      KITTY_PUBLIC_KEY: 'drop-me',
      LANG: 'drop-me',
      OPENAI_API_KEY: 'drop-me',
      PIP_INDEX_URL: 'drop-me',
      SHELL: 'drop-me',
      TERM: 'drop-me',
      UNRELATED: 'drop-me',
    });

    const env = request.env as Record<string, string>;
    expect(env).toMatchObject({
      HERDR: '1',
      HERDR_ENV: '1',
      HERDR_SOCKET_PATH: '/tmp/herdr.sock',
      HERDR_PANE_ID: 'w1:p1',
      HERDR_PI_IDLE_DEBOUNCE_MS: '10000',
      TMUX: '/tmp/tmux-501/default,123,0',
      TMUX_PANE: '%1',
      ZELLIJ: '0',
      ZELLIJ_SOCKET_DIR: '/tmp/zellij',
    });
    expect(env).not.toHaveProperty('KITTY_PUBLIC_KEY');
    expect(env).not.toHaveProperty('LANG');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('PIP_INDEX_URL');
    expect(env).not.toHaveProperty('SHELL');
    expect(env).not.toHaveProperty('TERM');
    expect(env).not.toHaveProperty('UNRELATED');
    expect(env.CLICOLOR).toBe('0');
    expect(env.FORCE_COLOR).toBe('0');
    expect(env.NO_COLOR).toBe('1');
    expect(env.PATH.split(path.delimiter)).toEqual([path.join(getAgentDir(), 'bin'), '/usr/bin']);
  });

  test('does not duplicate the Pi agent bin dir when it is already on PATH', () => {
    const binDir = path.join(getAgentDir(), 'bin');
    const request = buildCommandExecRequest({ cmd: 'env' }, '/repo', 'pi-1', {
      PATH: ['/usr/bin', binDir, '/usr/bin', '/bin', binDir].join(path.delimiter),
    });

    expect((request.env as Record<string, string>).PATH.split(path.delimiter)).toEqual([
      binDir,
      '/usr/bin',
      '/bin',
    ]);
  });

  test('snapshots manager shell environment at construction', async () => {
    const fake = createResolvingClient({ exitCode: 0, stdout: 'Success\n', stderr: '' });
    const applyPatchBin = createFakeApplyPatchBin();
    const env: NodeJS.ProcessEnv = {
      HERDR_PANE_ID: 'before',
      PATH: `${applyPatchBin}${path.delimiter}/before`,
    };
    const sessions = new CodexAppServerExecSessionManager({
      clientFactory: () => fake.client as any,
      env,
    });
    env.PATH = '/after';
    env.HERDR_PANE_ID = 'after';

    await sessions.applyPatch({ input: '*** Begin Patch\n*** End Patch' }, '/repo');

    const params = fake.calls.find((call) => call.method === 'command/exec')!.params as {
      env: Record<string, string>;
    };
    expect(params.env.HERDR_PANE_ID).toBe('before');
    expect(params.env.PATH.split(path.delimiter)).toEqual([
      path.join(getAgentDir(), 'bin'),
      applyPatchBin,
      '/before',
    ]);
    sessions.close();
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
    const registeredTools: Array<{
      name: string;
      description?: string;
      promptSnippet?: string;
      parameters?: Record<string, unknown>;
      constrainedSampling?: unknown;
    }> = [];
    registerAppServerExecTools(
      {
        registerTool(tool: {
          name: string;
          description?: string;
          promptSnippet?: string;
          parameters?: Record<string, unknown>;
          constrainedSampling?: unknown;
        }) {
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
        parameters: expect.objectContaining({ additionalProperties: false }),
        constrainedSampling: { type: 'json_schema', strict: 'prefer' },
      },
    ]);
  });

  test('apply_patch executes patch text through AppServer command/exec argv', async () => {
    const patch = '*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch';
    const fake = createResolvingClient({ exitCode: 0, stdout: 'Success\n', stderr: '' });
    const sessions = new CodexAppServerExecSessionManager({
      clientFactory: () => fake.client as any,
      env: { PATH: createFakeApplyPatchBin() },
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

  test('apply_patch falls back to the multi-edit implementation when no CLI is on PATH', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'pi-apply-patch-fallback-'));
    const patch = '*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch';
    const fake = createResolvingClient({ exitCode: 0, stdout: 'should not run\n', stderr: '' });
    const sessions = new CodexAppServerExecSessionManager({
      clientFactory: () => fake.client as any,
      env: { PATH: '/definitely/missing' },
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
    const result = await tool!.execute?.('call-1', { input: patch }, undefined, undefined, {
      cwd,
    });

    expect(fake.calls).toEqual([]);
    expect(readFileSync(path.join(cwd, 'hello.txt'), 'utf8')).toBe('hello\n');
    expect(result?.content?.[0]?.text).toContain('Applied patch');
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

  test('decodes split UTF-8 and terminal controls consistently in partial and final TTY output', async () => {
    vi.useFakeTimers();
    const fake = createControlledClient();
    const sessions = new CodexAppServerExecSessionManager({
      clientFactory: () => fake.client as any,
    });
    const updates: any[] = [];
    const pending = sessions.exec(
      { cmd: 'stream-wide-output', tty: true, yield_time_ms: 1_000 },
      '/repo',
      undefined,
      (update) => updates.push(update),
    );
    await vi.advanceTimersByTimeAsync(0);

    const execCall = fake.calls.find((call) => call.method === 'command/exec')!;
    const processId = (execCall.params as { processId: string }).processId;
    const emit = (bytes: Buffer) =>
      fake.emit({
        method: 'command/exec/outputDelta',
        params: { processId, deltaBase64: bytes.toString('base64') },
      });
    const wide = Buffer.from('界🙂', 'utf8');
    emit(Buffer.from('start '));
    emit(wide.subarray(0, 2));
    emit(wide.subarray(2, 5));
    emit(wide.subarray(5));
    emit(Buffer.from('\n\u001b[3'));
    emit(Buffer.from('1mred\u001b]0;ti'));
    emit(Buffer.from('tle\u0007done\ufffd\r'));
    emit(Buffer.from('\n\u009b32mgreen\u009b0mtail\u001b[31'));

    await vi.advanceTimersByTimeAsync(250);
    const expected = 'start 界🙂\nreddone\ngreentail';
    expect(updates.at(-1)?.output).toBe(expected);

    fake.resolve({ exitCode: 0, stdout: '', stderr: '' });
    await Promise.resolve();
    emit(Buffer.from('late output after the final response'));
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toMatchObject({ output: expected, exit_code: 0 });
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

  test('spills full exec output to a temp file when truncated by bytes', async () => {
    const stdout = 'x'.repeat(45_000);
    const fake = createResolvingClient({ exitCode: 0, stdout, stderr: '' });
    const sessions = new CodexAppServerExecSessionManager({
      clientFactory: () => fake.client as any,
    });

    const result = await sessions.exec(
      { cmd: 'big-output', yield_time_ms: 250 },
      '/repo',
      undefined,
      undefined,
      'call/foo:bar',
    );

    expect(result.output.length).toBeLessThan(stdout.length);
    expect(result.truncation).toMatchObject({ truncated: true, truncatedBy: 'bytes' });
    expect(path.basename(result.full_output_path!)).toMatch(/^exec_call_foo_bar-[a-f0-9]{8}\.log$/);
    expect(result.full_output_path).toContain(`${path.sep}pi-codex-app-server-use${path.sep}`);
    if (process.platform === 'darwin')
      expect(result.full_output_path).toMatch(/^\/tmp\/pi-codex-app-server-use\//);
    expect(readFileSync(result.full_output_path!, 'utf8')).toBe(stdout);
    sessions.close();
  });

  test('strips binary/control bytes from non-tty exec output before returning it', async () => {
    const fake = createResolvingClient({
      exitCode: 0,
      stdout: 'ok\u0000\u001b[31mred\u001b[0m\ufffd\u0085done\n\u001b]unterminated',
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
      stdout: 'ok\u0000\u001b[31mred\u001b[0m\ufffd\u0085done\n\u001b]unterminated',
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
