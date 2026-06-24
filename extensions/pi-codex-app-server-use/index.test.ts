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
    vi.useRealTimers();
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
    expect(commands.has('ps')).toBe(true);
    expect(commands.has('codex-computer-use-enable')).toBe(false);
    expect(commands.has('codex-computer-use-disable')).toBe(false);
    expect(commands.has('computer-use')).toBe(false);
  });

  test('/ps reports when no AppServer exec sessions are running', async () => {
    const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
    const notifications: Array<[string, string]> = [];
    const pi = {
      getActiveTools: () => [],
      registerTool() {},
      registerCommand(
        name: string,
        command: { handler: (args: string, ctx: any) => Promise<void> },
      ) {
        commands.set(name, command);
      },
      on() {},
      setActiveTools() {},
    };

    registerExtensionWithHealthyAppServer(pi as any);
    await commands.get('ps')?.handler('', {
      hasUI: true,
      ui: { notify: (message: string, level: string) => notifications.push([message, level]) },
    });

    expect(notifications).toEqual([['No AppServer exec sessions are running.', 'info']]);
  });

  test('registers exec renderers before session_start for reload history rendering', () => {
    const tools = new Map<string, { renderCall?: unknown; renderResult?: unknown }>();
    const pi = {
      getActiveTools: () => [],
      registerTool(tool: { name: string; renderCall?: unknown; renderResult?: unknown }) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      on() {},
      setActiveTools() {},
    };

    registerExtensionWithHealthyAppServer(pi as any);

    expect(typeof tools.get('exec_command')?.renderCall).toBe('function');
    expect(typeof tools.get('exec_command')?.renderResult).toBe('function');
    expect(typeof tools.get('write_stdin')?.renderCall).toBe('function');
    expect(typeof tools.get('write_stdin')?.renderResult).toBe('function');
    expect(tools.has('apply_patch')).toBe(false);
  });

  test('strips pure exec command echo text before persisting assistant tool calls', async () => {
    let messageEnd:
      | ((event: { message: unknown }) => Promise<{ message: any } | undefined>)
      | undefined;
    const pi = {
      getActiveTools: () => [],
      registerTool() {},
      registerCommand() {},
      on(event: string, handler: typeof messageEnd) {
        if (event === 'message_end') messageEnd = handler;
      },
      setActiveTools() {},
    };
    const command =
      "sed -n '1,120p' ~/.claude/agents/commit-message-generator.md ~/.claude/agents/gather-git-diff-context.md";

    registerExtensionWithHealthyAppServer(pi as any);
    const result = await messageEnd?.({
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: `\`${command}\`` },
          { type: 'toolCall', name: 'exec_command', arguments: { cmd: command } },
        ],
      },
    });

    expect(result?.message.content).toEqual([
      { type: 'toolCall', name: 'exec_command', arguments: { cmd: command } },
    ]);
  });

  test('preserves non-echo assistant text before exec tool calls', async () => {
    let messageEnd:
      | ((event: { message: unknown }) => Promise<{ message: any } | undefined>)
      | undefined;
    const pi = {
      getActiveTools: () => [],
      registerTool() {},
      registerCommand() {},
      on(event: string, handler: typeof messageEnd) {
        if (event === 'message_end') messageEnd = handler;
      },
      setActiveTools() {},
    };

    registerExtensionWithHealthyAppServer(pi as any);
    const result = await messageEnd?.({
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I’ll inspect the agent definitions.' },
          { type: 'toolCall', name: 'exec_command', arguments: { cmd: 'sed -n 1,2p a b' } },
        ],
      },
    });

    expect(result).toBeUndefined();
  });

  test('keeps optional tools inactive by default while registering exec renderers', async () => {
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
    expect(tools).toEqual(['exec_command', 'write_stdin']);
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
    expect(tools).toEqual(['exec_command', 'write_stdin']);

    await sessionStart?.({ type: 'session_start' }, makeSessionContext(root));

    expect(tools).toEqual([
      'exec_command',
      'write_stdin',
      'computer_list_apps',
      'computer_get_app_state',
      'computer_click',
      'computer_drag',
      'computer_press_key',
      'computer_type_text',
      'computer_scroll',
      'computer_select_text',
      'computer_set_value',
      'computer_perform_secondary_action',
      'codex_browser_list',
      'codex_browser_eval',
    ]);
    expect(activeTools).toEqual([
      'computer_list_apps',
      'computer_get_app_state',
      'computer_click',
      'computer_drag',
      'computer_press_key',
      'computer_type_text',
      'computer_scroll',
      'computer_select_text',
      'computer_set_value',
      'computer_perform_secondary_action',
      'codex_browser_list',
      'codex_browser_eval',
    ]);
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

  test('flashes Codex AppServer status briefly instead of leaving it pinned', async () => {
    vi.useFakeTimers();
    let activeTools = ['read', 'bash'];
    let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const projectSettings = path.join(root, 'project/.pi/settings.json');
    fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
    fs.writeFileSync(
      projectSettings,
      JSON.stringify({ codexAppServerUse: { exec: { enabled: true, models: 'all' } } }),
    );
    const statusCalls: Array<[string, string | undefined]> = [];
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
        hasUI: true,
        model: { provider: 'openai', api: 'openai-responses', id: 'gpt-5.5' },
        ui: {
          setStatus: (key: string, text: string | undefined) => statusCalls.push([key, text]),
        },
      },
    );

    expect(statusCalls).toEqual([['codex-app-server-use', 'Codex AppServer exec:on computer:off']]);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(statusCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(statusCalls).toEqual([
      ['codex-app-server-use', 'Codex AppServer exec:on computer:off'],
      ['codex-app-server-use', undefined],
    ]);
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

    expect(tools).toEqual(['exec_command', 'write_stdin']);
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

  test('suppresses Computer Use skills when Computer Use is disabled', async () => {
    let resourcesDiscover:
      | ((event: unknown, ctx: unknown) => Promise<{ skillPaths: string[] } | undefined>)
      | undefined;
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
      checkAppServerControlSocket: async () => {
        throw new Error('health check should not run when Computer Use is disabled');
      },
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
