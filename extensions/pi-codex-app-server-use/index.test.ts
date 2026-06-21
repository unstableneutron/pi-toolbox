import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import piCodexAppServerUseExtension from './src/extension';

function registerExtensionWithHealthyAppServer(
  pi: Parameters<typeof piCodexAppServerUseExtension>[0],
) {
  piCodexAppServerUseExtension(pi, {
    checkAppServerControlSocket: async () => ({ ok: true, socketPath: '/tmp/codex.sock' }),
  });
}

function makeSessionContext(root: string) {
  return {
    cwd: path.join(root, 'project'),
    sessionManager: {
      getSessionFile: () => path.join(root, 'sessions/session.jsonl'),
    },
  };
}

describe('pi-codex-app-server-use extension commands and activation', () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-use-extension-'));
    process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { force: true, recursive: true });
  });
  test('registers stable control and doctor slash commands', () => {
    const commands = new Map<string, unknown>();
    const pi = {
      getActiveTools: () => [],
      registerTool() {},
      registerCommand(name: string, command: unknown) {
        commands.set(name, command);
      },
      on() {},
      setActiveTools() {},
    };

    registerExtensionWithHealthyAppServer(pi as any);

    expect(commands.has('codex-app-server')).toBe(true);
    expect(commands.has('codex-app-server-doctor')).toBe(true);
    expect(commands.has('codex-computer-use-enable')).toBe(false);
    expect(commands.has('codex-computer-use-disable')).toBe(false);
    expect(commands.has('computer-use')).toBe(false);
  });

  test('keeps all optional tools inactive by default', async () => {
    const commands = new Map<string, unknown>();
    const tools: string[] = [];
    let activeTools = ['read', 'bash'];
    let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const pi = {
      getActiveTools: () => activeTools,
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
      registerCommand(name: string, command: unknown) {
        commands.set(name, command);
      },
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
        if (event === 'session_start') sessionStart = handler;
      },
      setActiveTools(nextActiveTools: string[]) {
        activeTools = nextActiveTools;
      },
    };

    piCodexAppServerUseExtension(pi as any, {
      checkAppServerControlSocket: async () => {
        throw new Error('health check should not run when all capabilities are disabled');
      },
    });
    await sessionStart?.({ type: 'session_start' }, makeSessionContext(root));

    expect(commands.has('codex-app-server')).toBe(true);
    expect(tools).toEqual([]);
    expect(activeTools).toEqual(['read', 'bash']);
  });

  test('registers computer and browser tools only when computerUse is enabled', async () => {
    const tools: string[] = [];
    let activeTools: string[] = [];
    let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const userSettings = path.join(root, 'agent/settings.json');
    fs.mkdirSync(path.dirname(userSettings), { recursive: true });
    fs.writeFileSync(
      userSettings,
      JSON.stringify({ codexAppServerUse: { computerUse: { enabled: true } } }),
    );
    const pi = {
      getActiveTools: () => activeTools,
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
      registerCommand() {},
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
        if (event === 'session_start') sessionStart = handler;
      },
      setActiveTools(nextActiveTools: string[]) {
        activeTools = nextActiveTools;
      },
    };

    registerExtensionWithHealthyAppServer(pi as any);
    expect(tools).toEqual([]);

    await sessionStart?.({ type: 'session_start' }, makeSessionContext(root));

    expect(tools).toEqual([
      'computer_list_apps',
      'computer_get_app_state',
      'computer_action',
      'codex_browser_list',
      'codex_browser_eval',
    ]);
    expect(activeTools).toEqual(tools);
  });

  test('adds exec tools alongside existing tools in enabled mode for gated models', async () => {
    const tools: string[] = [];
    let activeTools = ['read', 'bash', 'apply_patch'];
    let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const projectSettings = path.join(root, 'project/.pi/settings.json');
    fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
    fs.writeFileSync(
      projectSettings,
      JSON.stringify({ codexAppServerUse: { exec: { enabled: true, models: 'all' } } }),
    );
    const pi = {
      getActiveTools: () => activeTools,
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
      registerCommand() {},
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
        if (event === 'session_start') sessionStart = handler;
      },
      setActiveTools(nextActiveTools: string[]) {
        activeTools = nextActiveTools;
      },
    };

    registerExtensionWithHealthyAppServer(pi as any);
    await sessionStart?.(
      { type: 'session_start' },
      {
        ...makeSessionContext(root),
        model: { provider: 'openai', api: 'openai-responses', id: 'gpt-5.5', input: ['image'] },
      },
    );

    expect(tools).toContain('exec_command');
    expect(tools).toContain('write_stdin');
    expect(activeTools).toEqual([
      'read',
      'bash',
      'apply_patch',
      'exec_command',
      'write_stdin',
      'view_image',
    ]);
  });

  test('replaces Pi local shell and edit tools when replacement is enabled', async () => {
    let activeTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'apply_patch'];
    let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const projectSettings = path.join(root, 'project/.pi/settings.json');
    fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
    fs.writeFileSync(
      projectSettings,
      JSON.stringify({
        codexAppServerUse: { exec: { enabled: true, replaceLocalTools: true, models: 'all' } },
      }),
    );
    const pi = {
      getActiveTools: () => activeTools,
      registerTool() {},
      registerCommand() {},
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
        if (event === 'session_start') sessionStart = handler;
      },
      setActiveTools(nextActiveTools: string[]) {
        activeTools = nextActiveTools;
      },
    };

    registerExtensionWithHealthyAppServer(pi as any);
    await sessionStart?.(
      { type: 'session_start' },
      {
        ...makeSessionContext(root),
        model: {
          provider: 'openai-codex',
          api: 'openai-codex-responses',
          id: 'gpt-5.5',
          input: ['image'],
        },
      },
    );

    expect(activeTools).toEqual([
      'exec_command',
      'write_stdin',
      'apply_patch',
      'view_image',
      'grep',
      'find',
    ]);
  });

  test('does not add view_image for text-only models', async () => {
    let activeTools = ['read', 'bash'];
    let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const projectSettings = path.join(root, 'project/.pi/settings.json');
    fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
    fs.writeFileSync(
      projectSettings,
      JSON.stringify({ codexAppServerUse: { exec: { enabled: true, models: 'all' } } }),
    );
    const pi = {
      getActiveTools: () => activeTools,
      registerTool() {},
      registerCommand() {},
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
        if (event === 'session_start') sessionStart = handler;
      },
      setActiveTools(nextActiveTools: string[]) {
        activeTools = nextActiveTools;
      },
    };

    registerExtensionWithHealthyAppServer(pi as any);
    await sessionStart?.(
      { type: 'session_start' },
      {
        ...makeSessionContext(root),
        model: { provider: 'openai', api: 'openai-responses', id: 'gpt-5.5', input: ['text'] },
      },
    );

    expect(activeTools).toEqual(['read', 'bash', 'exec_command', 'write_stdin', 'apply_patch']);
  });

  test('keeps replacement inactive for non-Codex-like models in auto model mode', async () => {
    let activeTools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'apply_patch'];
    let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const projectSettings = path.join(root, 'project/.pi/settings.json');
    fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
    fs.writeFileSync(
      projectSettings,
      JSON.stringify({
        codexAppServerUse: { exec: { enabled: true, replaceLocalTools: true, models: 'auto' } },
      }),
    );
    const pi = {
      getActiveTools: () => activeTools,
      registerTool() {},
      registerCommand() {},
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
        if (event === 'session_start') sessionStart = handler;
      },
      setActiveTools(nextActiveTools: string[]) {
        activeTools = nextActiveTools;
      },
    };

    registerExtensionWithHealthyAppServer(pi as any);
    await sessionStart?.(
      { type: 'session_start' },
      {
        ...makeSessionContext(root),
        model: { provider: 'anthropic', api: 'anthropic-messages', id: 'claude-opus-4-8' },
      },
    );

    expect(activeTools).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'apply_patch']);
  });

  test('injects Codex exec guidelines into the system prompt only when exec tools are active', async () => {
    let beforeAgentStart:
      | ((
          event: { systemPrompt: string },
          ctx: unknown,
        ) => Promise<{ systemPrompt: string } | undefined>)
      | undefined;
    const projectSettings = path.join(root, 'project/.pi/settings.json');
    fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
    fs.writeFileSync(
      projectSettings,
      JSON.stringify({ codexAppServerUse: { exec: { enabled: true, models: 'auto' } } }),
    );
    const pi = {
      getActiveTools: () => ['read', 'bash'],
      registerTool() {},
      registerCommand() {},
      on(event: string, handler: typeof beforeAgentStart) {
        if (event === 'before_agent_start') beforeAgentStart = handler;
      },
      setActiveTools() {},
    };

    registerExtensionWithHealthyAppServer(pi as any);
    const activeResult = await beforeAgentStart?.(
      { systemPrompt: 'Guidelines:\n- Existing rule\n\nCurrent date: 2026-06-20' },
      {
        ...makeSessionContext(root),
        model: { provider: 'openai', api: 'openai-responses', id: 'gpt-5.5' },
      },
    );
    const inactiveResult = await beforeAgentStart?.(
      { systemPrompt: 'Guidelines:\n- Existing rule\n\nCurrent date: 2026-06-20' },
      {
        ...makeSessionContext(root),
        model: { provider: 'anthropic', api: 'anthropic-messages', id: 'claude-opus-4-8' },
      },
    );

    expect(activeResult?.systemPrompt).toContain(
      'Use exec_command for shell commands, file inspection, builds, and tests; prefer rg / rg --files for discovery and focused commands over truncation.',
    );
    expect(activeResult?.systemPrompt).toContain('Current shell:');
    expect(inactiveResult).toBeUndefined();
  });

  test('does not probe AppServer health when all capabilities are disabled', async () => {
    let activeTools = ['read', 'bash'];
    let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const checkAppServerControlSocket = vi.fn(async () => ({
      ok: false as const,
      socketPath: '/tmp/missing.sock',
      error: 'missing',
    }));
    const notifications: string[] = [];
    const pi = {
      getActiveTools: () => activeTools,
      registerTool() {},
      registerCommand() {},
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
        if (event === 'session_start') sessionStart = handler;
      },
      setActiveTools(nextActiveTools: string[]) {
        activeTools = nextActiveTools;
      },
    };

    piCodexAppServerUseExtension(pi as any, { checkAppServerControlSocket });
    await sessionStart?.(
      { type: 'session_start' },
      {
        ...makeSessionContext(root),
        hasUI: true,
        ui: { notify: (message: string) => notifications.push(message), setStatus() {} },
      },
    );

    expect(checkAppServerControlSocket).not.toHaveBeenCalled();
    expect(notifications).toEqual([]);
    expect(activeTools).toEqual(['read', 'bash']);
  });

  test('warns and suppresses exec tools when AppServer health check fails', async () => {
    let activeTools = ['read', 'bash', 'edit', 'write', 'grep'];
    let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const projectSettings = path.join(root, 'project/.pi/settings.json');
    fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
    fs.writeFileSync(
      projectSettings,
      JSON.stringify({
        codexAppServerUse: { exec: { enabled: true, replaceLocalTools: true, models: 'all' } },
      }),
    );
    const notifications: Array<{ message: string; level?: string }> = [];
    const pi = {
      getActiveTools: () => activeTools,
      registerTool() {},
      registerCommand() {},
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
        if (event === 'session_start') sessionStart = handler;
      },
      setActiveTools(nextActiveTools: string[]) {
        activeTools = nextActiveTools;
      },
    };

    piCodexAppServerUseExtension(pi as any, {
      checkAppServerControlSocket: async () => ({
        ok: false,
        socketPath: '/tmp/missing.sock',
        error: 'connect ENOENT /tmp/missing.sock',
      }),
    });
    await sessionStart?.(
      { type: 'session_start' },
      {
        ...makeSessionContext(root),
        hasUI: true,
        model: { provider: 'openai', api: 'openai-responses', id: 'gpt-5.5' },
        ui: {
          notify: (message: string, level?: string) => notifications.push({ message, level }),
          setStatus() {},
        },
      },
    );

    expect(activeTools).toEqual(['read', 'bash', 'edit', 'write', 'grep']);
    expect(notifications).toEqual([
      {
        level: 'warning',
        message:
          'Codex AppServer daemon is unavailable at /tmp/missing.sock; AppServer-backed tools are disabled for this session. Run `codex app-server daemon --help` for setup help. connect ENOENT /tmp/missing.sock',
      },
    ]);
  });

  test('warns and suppresses Computer Use tools when AppServer health check fails', async () => {
    const tools: string[] = [];
    let activeTools: string[] = [];
    let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const userSettings = path.join(root, 'agent/settings.json');
    fs.mkdirSync(path.dirname(userSettings), { recursive: true });
    fs.writeFileSync(
      userSettings,
      JSON.stringify({ codexAppServerUse: { computerUse: { enabled: true } } }),
    );
    const notifications: string[] = [];
    const pi = {
      getActiveTools: () => activeTools,
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
      registerCommand() {},
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
        if (event === 'session_start') sessionStart = handler;
      },
      setActiveTools(nextActiveTools: string[]) {
        activeTools = nextActiveTools;
      },
    };

    piCodexAppServerUseExtension(pi as any, {
      checkAppServerControlSocket: async () => ({
        ok: false,
        socketPath: '/tmp/missing.sock',
        error: 'connect ENOENT /tmp/missing.sock',
      }),
    });
    await sessionStart?.(
      { type: 'session_start' },
      {
        ...makeSessionContext(root),
        hasUI: true,
        ui: { notify: (message: string) => notifications.push(message), setStatus() {} },
      },
    );

    expect(tools).toEqual([]);
    expect(activeTools).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain(
      'Codex AppServer daemon is unavailable at /tmp/missing.sock',
    );
    expect(notifications[0]).toContain('codex app-server daemon --help');
  });

  test('suppresses Computer Use skills when AppServer health check fails', async () => {
    let resourcesDiscover:
      | ((event: unknown, ctx: unknown) => Promise<{ skillPaths: string[] } | undefined>)
      | undefined;
    const userSettings = path.join(root, 'agent/settings.json');
    fs.mkdirSync(path.dirname(userSettings), { recursive: true });
    fs.writeFileSync(
      userSettings,
      JSON.stringify({ codexAppServerUse: { computerUse: { enabled: true } } }),
    );
    const pi = {
      getActiveTools: () => [],
      registerTool() {},
      registerCommand() {},
      on(event: string, handler: typeof resourcesDiscover) {
        if (event === 'resources_discover') resourcesDiscover = handler;
      },
      setActiveTools() {},
    };

    piCodexAppServerUseExtension(pi as any, {
      checkAppServerControlSocket: async () => ({
        ok: false,
        socketPath: '/tmp/missing.sock',
        error: 'connect ENOENT /tmp/missing.sock',
      }),
    });
    const result = await resourcesDiscover?.(
      { cwd: path.join(root, 'project') },
      {
        ...makeSessionContext(root),
        hasUI: false,
      },
    );

    expect(result).toEqual({ skillPaths: [] });
  });
});
