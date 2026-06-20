import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { complete } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('@earendil-works/pi-ai', () => ({
  complete: vi.fn(),
}));

vi.mock('@earendil-works/pi-coding-agent', async () => {
  const actual = await vi.importActual<typeof import('@earendil-works/pi-coding-agent')>(
    '@earendil-works/pi-coding-agent',
  );

  class MockBorderedLoader {
    readonly signal = new AbortController().signal;
    onAbort?: () => void;

    constructor(_tui: unknown, _theme: unknown, _message: string) {}
  }

  return {
    ...actual,
    BorderedLoader: MockBorderedLoader,
  };
});

import {
  buildLaunchWrapperArgs,
  createForkedSession,
  detectTerminal,
  generateHandoffPrompt,
  getLauncherScriptPath,
  getNearestSplitSourceEntryId,
  getUserMessagesForForking,
  piNativeSplitExtension as registerPiNativeSplit,
} from './index';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function getRegisteredHandler(registerCommand: ReturnType<typeof vi.fn>, name: string) {
  const call = registerCommand.mock.calls.find(([commandName]) => commandName === name);
  if (!call) {
    throw new Error(`Missing registered command: ${name}`);
  }

  return call[1].handler as (args: string, ctx: any) => Promise<void>;
}

function extractPromptFilePath(command: string): string | undefined {
  return command.match(/\/[^'\n]*pi-native-split-[^'\n]*\/prompt\.txt/)?.[0];
}

function extractSessionFilePath(command: string): string | undefined {
  return command.match(/\/[^'\n]*\.jsonl/)?.[0];
}

function extractMarkerFilePath(command: string): string | undefined {
  return command.match(/\/[^'\n]*pi-native-split-marker-[^'\n]*\/marker\.json/)?.[0];
}

function createCommandHarness(execResult: { code: number; stdout?: string; stderr?: string }) {
  const registerCommand = vi.fn();
  const eventHandlers = new Map<string, Function[]>();
  const appendEntry = vi.fn();
  const setLabel = vi.fn();
  const exec = vi.fn().mockResolvedValue(execResult);
  const pi = {
    appendEntry,
    exec,
    on: vi.fn((eventName: string, handler: Function) => {
      const handlers = eventHandlers.get(eventName) ?? [];
      handlers.push(handler);
      eventHandlers.set(eventName, handlers);
    }),
    setLabel,
    registerCommand: vi.fn(
      (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
        registerCommand(name, options);
      },
    ),
  } as any;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-split-'));
  const realSessionManager = SessionManager.create(tempDir, path.join(tempDir, 'sessions'));
  const firstUserId = realSessionManager.appendMessage({
    role: 'user',
    content: 'Initial request',
    timestamp: Date.now(),
  } as any);
  const assistantId = realSessionManager.appendMessage({
    role: 'assistant',
    content: 'Previous response',
    timestamp: Date.now(),
  } as any);
  const userId = realSessionManager.appendMessage({
    role: 'user',
    content: 'Investigate split fork',
    timestamp: Date.now(),
  } as any);
  const sessionFile = realSessionManager.getSessionFile()!;
  const entries = realSessionManager.getEntries();
  const assistantEntry = entries.find((entry) => entry.id === assistantId)!;
  const userEntry = entries.find((entry) => entry.id === userId)!;

  const notify = vi.fn();
  const custom = vi.fn().mockResolvedValue(userId);
  const editor = vi.fn().mockResolvedValue('Edited handoff prompt');

  const ctx = {
    cwd: tempDir,
    hasUI: true,
    mode: 'tui',
    isIdle: () => true,
    model: { provider: 'openai', id: 'gpt-5', api: 'openai-responses' },
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: 'test-key', headers: {} }),
    },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getEntries: () => realSessionManager.getEntries(),
      getEntry: (id: string) => realSessionManager.getEntry(id),
      getHeader: () => realSessionManager.getHeader(),
      getLabel: (id: string) => realSessionManager.getLabel(id),
      getLeafId: () => realSessionManager.getLeafId(),
      getSessionDir: () => path.dirname(sessionFile),
      getSessionId: () => realSessionManager.getSessionId(),
      getBranch: () => realSessionManager.getBranch(),
    },
    ui: { custom, editor, notify },
  } as any;

  return {
    appendEntry,
    assistantEntry,
    ctx,
    custom,
    editor,
    eventHandlers,
    exec,
    firstUserId,
    notify,
    pi,
    realSessionManager,
    registerCommand,
    sessionFile,
    setLabel,
    tempDir,
    userEntry,
  };
}

function createMinimalCommandHarness(env: NodeJS.ProcessEnv = { TERM_PROGRAM: 'ghostty' } as any) {
  const registerCommand = vi.fn();
  const pi = {
    appendEntry: vi.fn(),
    exec: vi.fn(),
    on: vi.fn(),
    setLabel: vi.fn(),
    registerCommand: vi.fn(
      (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
        registerCommand(name, options);
      },
    ),
  } as any;

  return { pi, registerCommand, env };
}

function readJsonl(file: string): any[] {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('detectTerminal', () => {
  test('returns ghostty when Ghostty markers are present', () => {
    expect(
      detectTerminal({
        TERM_PROGRAM: 'ghostty',
        GHOSTTY_RESOURCES_DIR: '/Applications/Ghostty.app/Contents/Resources',
      } as NodeJS.ProcessEnv),
    ).toBe('ghostty');
  });

  test('returns kitty when Kitty markers are present', () => {
    expect(
      detectTerminal({
        TERM_PROGRAM: 'kitty',
        KITTY_WINDOW_ID: '12',
      } as NodeJS.ProcessEnv),
    ).toBe('kitty');
  });

  test('returns herdr when running inside a Herdr pane', () => {
    expect(
      detectTerminal({
        HERDR_ENV: '1',
        TERM_PROGRAM: 'iTerm.app',
      } as NodeJS.ProcessEnv),
    ).toBe('herdr');
  });

  test('returns undefined for unsupported terminals', () => {
    expect(detectTerminal({ TERM_PROGRAM: 'iTerm.app' } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe('pi-native-split mode guards', () => {
  test.each(['split-fork', 'split-resume', 'split-handoff', 'split-tree'])(
    '%s returns without touching UI outside TUI mode',
    async (commandName) => {
      const harness = createMinimalCommandHarness();
      await registerPiNativeSplit(harness.pi, harness.env);
      const handler = getRegisteredHandler(harness.registerCommand, commandName);

      await expect(handler('goal', { mode: 'print', hasUI: false })).resolves.toBeUndefined();
    },
  );
});

describe('command registration', () => {
  test('registers split commands when terminal is supported', async () => {
    const pi = { registerCommand: vi.fn() } as any;

    await registerPiNativeSplit(pi, {
      TERM_PROGRAM: 'kitty',
      KITTY_WINDOW_ID: '1',
    } as NodeJS.ProcessEnv);

    expect(pi.registerCommand).toHaveBeenCalledWith(
      'split-fork',
      expect.objectContaining({ handler: expect.any(Function) }),
    );
    expect(pi.registerCommand).toHaveBeenCalledWith(
      'split-resume',
      expect.objectContaining({ handler: expect.any(Function) }),
    );
    expect(pi.registerCommand).toHaveBeenCalledWith(
      'split-handoff',
      expect.objectContaining({ handler: expect.any(Function) }),
    );
    expect(pi.registerCommand).toHaveBeenCalledWith(
      'split-tree',
      expect.objectContaining({ handler: expect.any(Function) }),
    );
  });

  test('registers split commands when running inside Herdr', async () => {
    const pi = { registerCommand: vi.fn() } as any;

    await registerPiNativeSplit(pi, {
      HERDR_ENV: '1',
      TERM_PROGRAM: 'iTerm.app',
    } as NodeJS.ProcessEnv);

    expect(pi.registerCommand).toHaveBeenCalledWith(
      'split-fork',
      expect.objectContaining({ handler: expect.any(Function) }),
    );
    expect(pi.registerCommand).toHaveBeenCalledWith(
      'split-resume',
      expect.objectContaining({ handler: expect.any(Function) }),
    );
    expect(pi.registerCommand).toHaveBeenCalledWith(
      'split-handoff',
      expect.objectContaining({ handler: expect.any(Function) }),
    );
    expect(pi.registerCommand).toHaveBeenCalledWith(
      'split-tree',
      expect.objectContaining({ handler: expect.any(Function) }),
    );
  });

  test('does not register commands when terminal is unsupported', async () => {
    const pi = { registerCommand: vi.fn() } as any;

    await registerPiNativeSplit(pi, { TERM_PROGRAM: 'iTerm.app' } as NodeJS.ProcessEnv);

    expect(pi.registerCommand).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  test('launcher script removes prompt file and temp directory after a successful prompt launch', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-split-success-'));
    const cwd = path.join(rootDir, 'cwd');
    const fakeBin = path.join(rootDir, 'bin');
    const fakePi = path.join(fakeBin, 'pi');

    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(fakePi, '#!/bin/sh\nexit 0\n', 'utf8');
    fs.chmodSync(fakePi, 0o755);

    const launch = buildLaunchWrapperArgs(cwd, '/tmp/fork.jsonl', 'investigate this');

    expect(launch.promptFile).toBeDefined();
    const promptFile = launch.promptFile!;
    const result = spawnSync(
      '/bin/sh',
      [getLauncherScriptPath(), cwd, '/tmp/fork.jsonl', promptFile],
      {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH || ''}` },
      },
    );

    expect(result.status).toBe(0);
    expect(fs.existsSync(promptFile)).toBe(false);
    expect(fs.existsSync(path.dirname(promptFile))).toBe(false);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('launcher script prints a startup failure banner and hands off to an interactive shell', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-split-launch-failure-'));
    const cwd = path.join(rootDir, 'cwd');
    const sessionFile = path.join(rootDir, 'sessions', 'current.jsonl');
    const fakeShell = path.join(rootDir, 'fake-shell.sh');
    const shellArgsFile = path.join(rootDir, 'shell-args.txt');

    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, '', 'utf8');
    fs.writeFileSync(
      fakeShell,
      `#!/bin/sh\nprintf '%s\n' "$*" > "${shellArgsFile}"\nexit 0\n`,
      'utf8',
    );
    fs.chmodSync(fakeShell, 0o755);
    const fakeBin = path.join(rootDir, 'bin');
    const fakePi = path.join(fakeBin, 'pi');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(fakePi, '#!/bin/sh\nexit 7\n', 'utf8');
    fs.chmodSync(fakePi, 0o755);

    const result = spawnSync(
      '/bin/sh',
      [getLauncherScriptPath(), cwd, sessionFile, '__PI_NATIVE_SPLIT_EMPTY__'],
      {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH || ''}`,
          SHELL: fakeShell,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr.toString()).toContain(
      'pi-native-split: pi launch failed with exit code 7',
    );
    expect(result.stderr.toString()).toContain(`cwd: ${cwd}`);
    expect(result.stderr.toString()).toContain(`session: ${sessionFile}`);
    expect(fs.readFileSync(shellArgsFile, 'utf8').trim()).toBe('-i');

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('launcher script passes the startup prompt as a positional pi argument, not --', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-split-argv-'));
    const cwd = path.join(rootDir, 'cwd');
    const fakeBin = path.join(rootDir, 'bin');
    const fakePi = path.join(fakeBin, 'pi');
    const argsFile = path.join(rootDir, 'pi-args.txt');

    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(
      fakePi,
      `#!/bin/sh
printf '%s\n' "$@" > "${argsFile}"
exit 0
`,
      'utf8',
    );
    fs.chmodSync(fakePi, 0o755);

    const launch = buildLaunchWrapperArgs(cwd, '/tmp/fork.jsonl', 'investigate this');
    const result = spawnSync(
      '/bin/sh',
      [
        getLauncherScriptPath(),
        cwd,
        '/tmp/fork.jsonl',
        launch.promptFile!,
        '__PI_NATIVE_SPLIT_EMPTY__',
      ],
      {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH || ''}` },
      },
    );

    expect(result.status).toBe(0);
    expect(fs.readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
      '--session',
      '/tmp/fork.jsonl',
      'investigate this',
    ]);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('buildLaunchWrapperArgs writes prompt text to a temp file for the wrapper', () => {
    const launch = buildLaunchWrapperArgs(
      '/tmp/project',
      '/tmp/session.jsonl',
      'line one\nline two',
    );

    expect(launch.argv.slice(0, 2)).toEqual(['/bin/sh', getLauncherScriptPath()]);
    expect(launch.argv).toEqual([
      '/bin/sh',
      getLauncherScriptPath(),
      '/tmp/project',
      '/tmp/session.jsonl',
      launch.promptFile!,
      '__PI_NATIVE_SPLIT_EMPTY__',
    ]);
    expect(launch.promptFile).toBeDefined();
    expect(fs.readFileSync(launch.promptFile!, 'utf8')).toBe('line one\nline two');

    fs.rmSync(path.dirname(launch.promptFile!), { recursive: true, force: true });
  });

  test('launcher script exports marker seed path for the child pi process', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-split-marker-env-'));
    const cwd = path.join(rootDir, 'cwd');
    const fakeBin = path.join(rootDir, 'bin');
    const fakePi = path.join(fakeBin, 'pi');
    const envFile = path.join(rootDir, 'marker-env.txt');
    const markerFile = path.join(rootDir, 'marker.json');

    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(markerFile, '{}', 'utf8');
    fs.writeFileSync(
      fakePi,
      `#!/bin/sh\nprintf '%s\n' "$PI_NATIVE_SPLIT_MARKER_FILE" > "${envFile}"\nexit 0\n`,
      'utf8',
    );
    fs.chmodSync(fakePi, 0o755);

    const result = spawnSync(
      '/bin/sh',
      [getLauncherScriptPath(), cwd, '/tmp/fork.jsonl', '__PI_NATIVE_SPLIT_EMPTY__', markerFile],
      {
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH || ''}` },
      },
    );

    expect(result.status).toBe(0);
    expect(fs.readFileSync(envFile, 'utf8').trim()).toBe(markerFile);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('child session_start marker records Kitty child environment details', async () => {
    vi.useFakeTimers();
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-split-child-kitty-'));
    const markerFile = path.join(rootDir, 'marker.json');
    const appendEntry = vi.fn();
    const notify = vi.fn();
    const setLabel = vi.fn();
    const eventHandlers = new Map<string, Function[]>();
    const pi = {
      appendEntry,
      on: vi.fn((eventName: string, handler: Function) => {
        const handlers = eventHandlers.get(eventName) ?? [];
        handlers.push(handler);
        eventHandlers.set(eventName, handlers);
      }),
      registerCommand: vi.fn(),
      setLabel,
    } as any;
    const seed = {
      customType: 'pi-native-split.split-fork.child-session',
      data: {
        v: 1,
        id: 'boundary',
        side: 'child',
        kind: 'split-fork',
        at: '2026-06-04T00:00:00.000Z',
        parent: { id: 'parent', file: '/tmp/parent.jsonl', leaf: 'leaf' },
        child: { id: 'child-session', file: '/tmp/child.jsonl' },
        prompt: 'raw',
        native: { terminal: 'kitty', parent: { window: '18' } },
      },
    };
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify(seed), 'utf8');

    await registerPiNativeSplit(pi, {
      TERM_PROGRAM: 'kitty',
      KITTY_WINDOW_ID: '19',
      KITTY_PID: '1817',
      KITTY_LISTEN_ON: 'unix:/tmp/kitty-1817.sock',
      PI_NATIVE_SPLIT_MARKER_FILE: markerFile,
    } as NodeJS.ProcessEnv);

    await eventHandlers.get('session_start')![0]!(
      { type: 'session_start' },
      {
        hasUI: true,
        mode: 'tui',
        sessionManager: {
          getEntry: (id: string) =>
            id === 'leaf'
              ? { id, type: 'message', message: { role: 'user', content: 'source' } }
              : undefined,
          getLabel: () => undefined,
          getLeafId: () => 'marker-entry',
        },
        ui: { notify },
      },
    );

    expect(appendEntry).toHaveBeenCalledWith(
      seed.customType,
      expect.objectContaining({
        native: expect.objectContaining({
          terminal: 'kitty',
          child: expect.objectContaining({
            window: '19',
            pid: '1817',
            listenOn: 'unix:/tmp/kitty-1817.sock',
          }),
        }),
      }),
    );
    expect(setLabel).toHaveBeenCalledWith('leaf', 'split-fork parent ← parent');
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(notify).toHaveBeenCalledWith('⇄ split-fork via kitty\nparent ← parent', 'info');
    expect(fs.existsSync(markerFile)).toBe(false);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('child marker notification is cancelled on session shutdown', async () => {
    vi.useFakeTimers();
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-split-child-shutdown-'));
    const markerFile = path.join(rootDir, 'marker.json');
    const appendEntry = vi.fn();
    const notify = vi.fn();
    const setLabel = vi.fn();
    const eventHandlers = new Map<string, Function[]>();
    const pi = {
      appendEntry,
      on: vi.fn((eventName: string, handler: Function) => {
        const handlers = eventHandlers.get(eventName) ?? [];
        handlers.push(handler);
        eventHandlers.set(eventName, handlers);
      }),
      registerCommand: vi.fn(),
      setLabel,
    } as any;
    const seed = {
      customType: 'pi-native-split.split-fork.child-session',
      data: {
        v: 1,
        id: 'boundary',
        side: 'child',
        kind: 'split-fork',
        at: '2026-06-04T00:00:00.000Z',
        parent: { id: 'parent', file: '/tmp/parent.jsonl', leaf: 'leaf' },
        child: { id: 'child-session', file: '/tmp/child.jsonl' },
        prompt: 'raw',
        native: { terminal: 'kitty', parent: { window: '18' } },
      },
    };
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify(seed), 'utf8');

    await registerPiNativeSplit(pi, {
      TERM_PROGRAM: 'kitty',
      KITTY_WINDOW_ID: '19',
      PI_NATIVE_SPLIT_MARKER_FILE: markerFile,
    } as NodeJS.ProcessEnv);

    const ctx = {
      hasUI: true,
      mode: 'tui',
      sessionManager: {
        getEntry: (id: string) =>
          id === 'leaf'
            ? { id, type: 'message', message: { role: 'user', content: 'source' } }
            : undefined,
        getLabel: () => undefined,
        getLeafId: () => 'marker-entry',
      },
      ui: { notify },
    };

    await eventHandlers.get('session_start')![0]!({ type: 'session_start' }, ctx);
    await eventHandlers.get('session_shutdown')![0]!(
      { type: 'session_shutdown', reason: 'resume' },
      ctx,
    );

    vi.advanceTimersByTime(100);

    expect(notify).not.toHaveBeenCalled();

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('child session_start marker records Herdr child environment details', async () => {
    vi.useFakeTimers();
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-split-child-herdr-'));
    const markerFile = path.join(rootDir, 'marker.json');
    const appendEntry = vi.fn();
    const notify = vi.fn();
    const setLabel = vi.fn();
    const eventHandlers = new Map<string, Function[]>();
    const pi = {
      appendEntry,
      on: vi.fn((eventName: string, handler: Function) => {
        const handlers = eventHandlers.get(eventName) ?? [];
        handlers.push(handler);
        eventHandlers.set(eventName, handlers);
      }),
      registerCommand: vi.fn(),
      setLabel,
    } as any;
    const seed = {
      customType: 'pi-native-split.split-fork.child-session',
      data: {
        v: 1,
        id: 'boundary',
        side: 'child',
        kind: 'split-fork',
        at: '2026-06-04T00:00:00.000Z',
        parent: { id: 'parent', file: '/tmp/parent.jsonl', leaf: 'leaf' },
        child: { id: 'child-session', file: '/tmp/child.jsonl' },
        prompt: 'raw',
        native: { terminal: 'herdr', parent: { pane: 'p_43' } },
      },
    };
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(markerFile, JSON.stringify(seed), 'utf8');

    await registerPiNativeSplit(pi, {
      HERDR_ENV: '1',
      HERDR_PANE_ID: 'p_44',
      HERDR_SOCKET_PATH: '/Users/thinh/.config/herdr/herdr.sock',
      PI_NATIVE_SPLIT_MARKER_FILE: markerFile,
    } as NodeJS.ProcessEnv);

    await eventHandlers.get('session_start')![0]!(
      { type: 'session_start' },
      {
        hasUI: true,
        mode: 'tui',
        sessionManager: {
          getEntry: (id: string) =>
            id === 'leaf'
              ? { id, type: 'message', message: { role: 'user', content: 'source' } }
              : undefined,
          getLabel: () => undefined,
          getLeafId: () => 'marker-entry',
        },
        ui: { notify },
      },
    );

    expect(appendEntry).toHaveBeenCalledWith(
      seed.customType,
      expect.objectContaining({
        native: expect.objectContaining({
          terminal: 'herdr',
          child: expect.objectContaining({
            pane: 'p_44',
            socket: '/Users/thinh/.config/herdr/herdr.sock',
          }),
        }),
      }),
    );
    expect(setLabel).toHaveBeenCalledWith('leaf', 'split-fork parent ← parent');
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(notify).toHaveBeenCalledWith('⇄ split-fork via herdr\nparent ← parent', 'info');
    expect(fs.existsSync(markerFile)).toBe(false);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  test('getUserMessagesForForking matches Pi fork selector semantics', () => {
    const ctx = {
      sessionManager: {
        getEntries: () => [
          { type: 'message', id: 'a', message: { role: 'assistant', content: 'ignore' } },
          { type: 'message', id: 'u1', message: { role: 'user', content: 'First' } },
          {
            type: 'message',
            id: 'u2',
            message: { role: 'user', content: [{ type: 'text', text: 'Second' }] },
          },
        ],
      },
    } as any;

    expect(getUserMessagesForForking(ctx)).toEqual([
      { entryId: 'u1', text: 'First' },
      { entryId: 'u2', text: 'Second' },
    ]);
  });

  test('createForkedSession branches with an isolated manager and leaves the parent unchanged', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-split-helper-'));
    const parent = SessionManager.create(tempDir, path.join(tempDir, 'sessions'));
    parent.appendMessage({ role: 'user', content: 'root', timestamp: Date.now() } as any);
    const assistantId = parent.appendMessage({
      role: 'assistant',
      content: 'answer',
      timestamp: Date.now(),
    } as any);
    const userId = parent.appendMessage({
      role: 'user',
      content: 'next',
      timestamp: Date.now(),
    } as any);
    const parentFile = parent.getSessionFile()!;
    const parentId = parent.getSessionId();
    const entries = parent.getEntries();
    const ctx = {
      cwd: tempDir,
      sessionManager: {
        getEntry: (id: string) => entries.find((entry) => entry.id === id),
        getSessionDir: () => path.dirname(parentFile),
        getSessionFile: () => parentFile,
        getSessionId: () => parentId,
      },
    } as any;

    const forked = createForkedSession(ctx, userId);

    expect(forked).toBeDefined();
    expect(forked).not.toBe(parentFile);
    expect(parent.getSessionFile()).toBe(parentFile);
    expect(parent.getSessionId()).toBe(parentId);
    expect(readJsonl(forked!).map((entry) => entry.id)).toContain(assistantId);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('createForkedSession creates a fresh child session when selecting the root user message', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-split-root-'));
    const parent = SessionManager.create(tempDir, path.join(tempDir, 'sessions'));
    const rootId = parent.appendMessage({
      role: 'user',
      content: 'root',
      timestamp: Date.now(),
    } as any);
    const parentFile = parent.getSessionFile()!;
    const entries = parent.getEntries();
    const ctx = {
      cwd: tempDir,
      sessionManager: {
        getEntry: (id: string) => entries.find((entry) => entry.id === id),
        getLeafId: () => parent.getLeafId(),
        getSessionDir: () => path.dirname(parentFile),
        getSessionFile: () => parentFile,
        getSessionId: () => parent.getSessionId(),
      },
    } as any;

    const child = createForkedSession(ctx, rootId);

    expect(child).toBeDefined();
    expect(child).not.toBe(parentFile);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('getNearestSplitSourceEntryId skips custom and label entries', () => {
    const entries = [
      { id: 'user-root', type: 'message', message: { role: 'user', content: 'root' } },
      {
        id: 'assistant-answer',
        parentId: 'user-root',
        type: 'message',
        message: { role: 'assistant', content: 'answer' },
      },
      {
        id: 'custom-marker',
        parentId: 'assistant-answer',
        type: 'custom',
        customType: 'pi-native-split.split-fork.child',
      },
      { id: 'label-entry', parentId: 'custom-marker', type: 'label', targetId: 'assistant-answer' },
    ];
    const ctx = {
      sessionManager: {
        getEntry: (id: string) => entries.find((entry) => entry.id === id),
        getLeafId: () => 'label-entry',
      },
    } as any;

    expect(getNearestSplitSourceEntryId(ctx)).toBe('assistant-answer');
  });

  test('getNearestSplitSourceEntryId skips tool-only assistant messages', () => {
    const entries = [
      { id: 'user-root', type: 'message', message: { role: 'user', content: 'root' } },
      {
        id: 'tool-only-assistant',
        parentId: 'user-root',
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'bash', id: 'call-1', arguments: {} }],
        },
      },
      {
        id: 'tool-result',
        parentId: 'tool-only-assistant',
        type: 'message',
        message: { role: 'toolResult' },
      },
    ];
    const ctx = {
      sessionManager: {
        getEntry: (id: string) => entries.find((entry) => entry.id === id),
        getLeafId: () => 'tool-result',
      },
    } as any;

    expect(getNearestSplitSourceEntryId(ctx)).toBe('user-root');
  });

  test('createForkedSession returns undefined when the target parent is not in the persisted session', () => {
    const ctx = {
      cwd: '/tmp',
      sessionManager: {
        getEntry: () => ({
          type: 'message',
          id: 'user-1',
          parentId: 'assistant-0',
          message: { role: 'user', content: 'hello' },
        }),
        getSessionDir: () => '/tmp/sessions',
        getSessionFile: () => '/tmp/sessions/current.jsonl',
      },
    } as any;

    expect(createForkedSession(ctx, 'user-1')).toBeUndefined();
  });

  test('generateHandoffPrompt returns generated text from the model response', async () => {
    vi.mocked(complete).mockResolvedValue({
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Generated handoff prompt' }],
    } as any);

    const ctx = createCommandHarness({ code: 0, stdout: '', stderr: '' }).ctx;
    ctx.ui.custom = vi.fn().mockImplementation(async (factory) => {
      const done = vi.fn();
      await factory({} as any, {} as any, {} as any, done);
      return 'Generated handoff prompt';
    });

    await expect(generateHandoffPrompt('continue implementation', ctx)).resolves.toBe(
      'Generated handoff prompt',
    );
  });
});

describe('split commands', () => {
  test('split-fork launches Kitty through the user shell and shared wrapper script', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });

    await registerPiNativeSplit(harness.pi, {
      TERM_PROGRAM: 'kitty',
      KITTY_WINDOW_ID: '1',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-fork');
    await handler('', harness.ctx);

    expect(harness.custom).toHaveBeenCalledTimes(1);

    expect(harness.exec).toHaveBeenCalledWith(
      'kitten',
      expect.arrayContaining([
        '@',
        'new-window',
        '--window-type',
        'os',
        '--cwd',
        harness.ctx.cwd,
        '/bin/zsh',
        '-ilc',
      ]),
    );

    const wrapperCommand = String(harness.exec.mock.calls[0][1].at(-1));
    expect(wrapperCommand).toContain(getLauncherScriptPath());

    const childSessionFile = extractSessionFilePath(wrapperCommand);
    expect(childSessionFile).toBeDefined();
    expect(childSessionFile).not.toBe(harness.sessionFile);
    const markerFile = extractMarkerFilePath(wrapperCommand);
    expect(markerFile).toBeDefined();
    const childMarker = JSON.parse(fs.readFileSync(markerFile!, 'utf8'));
    expect(childMarker.customType).toContain('pi-native-split.split-fork.');
    expect(childMarker.data).toEqual(
      expect.objectContaining({
        v: 1,
        side: 'child',
        kind: 'split-fork',
        parent: expect.objectContaining({
          id: harness.realSessionManager.getSessionId(),
          file: harness.sessionFile,
          leaf: harness.assistantEntry.id,
        }),
        child: expect.objectContaining({ file: childSessionFile }),
        prompt: 'none',
        native: expect.objectContaining({
          terminal: 'kitty',
          parent: expect.objectContaining({ window: '1' }),
        }),
      }),
    );
    expect(harness.appendEntry).toHaveBeenCalledWith(
      childMarker.customType,
      expect.objectContaining({
        id: childMarker.data.id,
        side: 'parent',
        child: expect.objectContaining({ file: childSessionFile }),
      }),
    );
  });

  test('split-fork with a prompt skips the selector, branches from the current leaf, and forwards the prompt', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });

    await registerPiNativeSplit(harness.pi, {
      TERM_PROGRAM: 'kitty',
      KITTY_WINDOW_ID: '1',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-fork');
    await handler("don't stop", harness.ctx);

    expect(harness.custom).not.toHaveBeenCalled();
    expect(harness.realSessionManager.getSessionFile()).toBe(harness.sessionFile);
    expect(harness.realSessionManager.getSessionId()).toBe(
      JSON.parse(fs.readFileSync(harness.sessionFile, 'utf8').split('\n')[0]!).id,
    );

    const wrapperCommand = String(harness.exec.mock.calls[0][1].at(-1));
    const promptFile = extractPromptFilePath(wrapperCommand);
    expect(promptFile).toBeDefined();
    expect(fs.readFileSync(promptFile!, 'utf8')).toBe("don't stop");
    expect(wrapperCommand).not.toContain("don't stop");
    fs.rmSync(path.dirname(promptFile!), { recursive: true, force: true });

    const childSessionFile = extractSessionFilePath(wrapperCommand);
    expect(childSessionFile).toBeDefined();
    const markerFile = extractMarkerFilePath(wrapperCommand);
    expect(markerFile).toBeDefined();
    const childMarker = JSON.parse(fs.readFileSync(markerFile!, 'utf8'));
    expect(childMarker.data).toEqual(
      expect.objectContaining({
        side: 'child',
        kind: 'split-fork',
        parent: expect.objectContaining({ leaf: harness.userEntry.id }),
        prompt: 'raw',
      }),
    );

    expect(harness.notify).toHaveBeenCalledWith(
      `⇄ split-fork via kitty\nchild → ${childMarker.data.child.id}`,
      'info',
    );
    expect(harness.setLabel).toHaveBeenCalledWith(
      harness.userEntry.id,
      `split-fork child → ${childMarker.data.child.id}`,
    );
  });

  test('split-fork with a prompt skips trailing custom entries when choosing the source', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });
    harness.realSessionManager.appendCustomEntry('pi-native-split.previous-marker', {});

    await registerPiNativeSplit(harness.pi, {
      TERM_PROGRAM: 'kitty',
      KITTY_WINDOW_ID: '1',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-fork');
    await handler('continue from meaningful entry', harness.ctx);

    const wrapperCommand = String(harness.exec.mock.calls[0][1].at(-1));
    const markerFile = extractMarkerFilePath(wrapperCommand);
    expect(markerFile).toBeDefined();
    const childMarker = JSON.parse(fs.readFileSync(markerFile!, 'utf8'));

    expect(childMarker.data.parent.leaf).toBe(harness.userEntry.id);
    expect(harness.setLabel).toHaveBeenCalledWith(
      harness.userEntry.id,
      `split-fork child → ${childMarker.data.child.id}`,
    );
  });

  test('split-fork queues the parent marker until agent_end when the parent is busy', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });
    harness.ctx.isIdle = () => false;

    await registerPiNativeSplit(harness.pi, {
      TERM_PROGRAM: 'kitty',
      KITTY_WINDOW_ID: '1',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-fork');
    await handler('continue separately', harness.ctx);

    expect(harness.appendEntry).not.toHaveBeenCalled();
    const agentEndHandlers = harness.eventHandlers.get('agent_end') ?? [];
    expect(agentEndHandlers).toHaveLength(1);

    await agentEndHandlers[0]!({ type: 'agent_end', messages: [] }, harness.ctx);

    expect(harness.appendEntry).toHaveBeenCalledWith(
      expect.stringContaining('pi-native-split.split-fork.'),
      expect.objectContaining({
        side: 'parent',
        kind: 'split-fork',
        prompt: 'raw',
      }),
    );
    expect(harness.setLabel).toHaveBeenCalledWith(
      harness.userEntry.id,
      expect.stringMatching(/^split-fork child → /),
    );
  });

  test('split-fork cleans up prompt temp files when Kitty launch fails', async () => {
    const harness = createCommandHarness({
      code: 1,
      stdout: '',
      stderr: 'kitten: remote control command failed',
    });
    const newSession = vi.fn(() => '/tmp/sessions/direct-child.jsonl');
    vi.spyOn(SessionManager, 'create').mockReturnValue({ newSession } as any);

    await registerPiNativeSplit(harness.pi, {
      TERM_PROGRAM: 'kitty',
      KITTY_WINDOW_ID: '1',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-fork');
    await handler('cleanup me', harness.ctx);

    const wrapperCommand = String(harness.exec.mock.calls[0][1].at(-1));
    const promptFile = extractPromptFilePath(wrapperCommand);
    expect(promptFile).toBeDefined();

    expect(fs.existsSync(promptFile!)).toBe(false);
    expect(fs.existsSync(path.dirname(promptFile!))).toBe(false);
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('Failed to launch kitty:'),
      'error',
    );
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('Retry in a new split/window with: pi --session '),
      'info',
    );
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('Startup prompt/command was not delivered.'),
      'warning',
    );
  });

  test('split-fork turns thrown pre-launch Kitty errors into retryable notifications', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });
    harness.exec.mockRejectedValueOnce(new Error('kitten binary not found'));

    const newSession = vi.fn(() => '/tmp/sessions/direct-child.jsonl');
    vi.spyOn(SessionManager, 'create').mockReturnValue({ newSession } as any);

    await registerPiNativeSplit(harness.pi, {
      TERM_PROGRAM: 'kitty',
      KITTY_WINDOW_ID: '1',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-fork');
    await expect(handler('retry me', harness.ctx)).resolves.toBeUndefined();

    expect(harness.notify).toHaveBeenCalledWith(
      'Failed to launch kitty: pre-launch command failed: kitten binary not found',
      'error',
    );
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('Retry in a new split/window with: pi --session '),
      'info',
    );
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('Startup prompt/command was not delivered.'),
      'warning',
    );
    expect(harness.notify).not.toHaveBeenCalledWith(
      expect.stringContaining('and sent prompt'),
      'info',
    );
  });

  test('split-fork fails early when interactive ui is unavailable', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });
    harness.ctx.hasUI = false;

    await registerPiNativeSplit(harness.pi, {
      TERM_PROGRAM: 'kitty',
      KITTY_WINDOW_ID: '1',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-fork');
    await handler('', harness.ctx);

    expect(harness.exec).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  test('split-fork launches Herdr by splitting the focused pane above Herdr mobile width', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });
    harness.exec.mockReset();
    harness.exec
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          result: {
            type: 'pane_list',
            panes: [
              { pane_id: '1-1', focused: false },
              { pane_id: '1-2', focused: true },
            ],
          },
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ result: { type: 'pane_info', pane: { pane_id: '1-3' } } }),
        stderr: '',
      })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });

    await registerPiNativeSplit(harness.pi, {
      HERDR_ENV: '1',
      COLUMNS: '65',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-fork');
    await handler('', harness.ctx);

    expect(harness.exec).toHaveBeenNthCalledWith(1, 'herdr', ['pane', 'list']);
    expect(harness.exec).toHaveBeenNthCalledWith(2, 'herdr', [
      'pane',
      'split',
      '1-2',
      '--direction',
      'right',
      '--cwd',
      harness.ctx.cwd,
      '--no-focus',
    ]);
    expect(harness.exec).toHaveBeenNthCalledWith(3, 'herdr', [
      'pane',
      'run',
      '1-3',
      expect.stringContaining(getLauncherScriptPath()),
    ]);

    const runCommand = String(harness.exec.mock.calls[2][1][3]);
    const childSessionFile = extractSessionFilePath(runCommand);
    expect(childSessionFile).toBeDefined();
    const markerFile = extractMarkerFilePath(runCommand);
    expect(markerFile).toBeDefined();
    const childMarker = JSON.parse(fs.readFileSync(markerFile!, 'utf8'));
    expect(childMarker.data.native).toEqual(
      expect.objectContaining({
        terminal: 'herdr',
        parent: expect.objectContaining({ pane: '1-2' }),
        child: expect.objectContaining({ pane: '1-3', target: 'pane' }),
      }),
    );
    expect(harness.notify).toHaveBeenCalledWith(
      `⇄ split-fork via herdr\nchild → ${childMarker.data.child.id}`,
      'info',
    );
  });

  test('split-fork launches Herdr in a new tab at Herdr mobile width', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });
    harness.exec.mockReset();
    harness.exec
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          result: {
            type: 'pane_list',
            panes: [
              { pane_id: '1-1', focused: false, workspace_id: 'w-1' },
              { pane_id: '1-2', focused: true, workspace_id: 'w-1' },
            ],
          },
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          result: { type: 'tab_created', root_pane: { pane_id: '1-3' } },
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });

    await registerPiNativeSplit(harness.pi, {
      HERDR_ENV: '1',
      COLUMNS: '64',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-fork');
    await handler('', harness.ctx);

    expect(harness.exec).toHaveBeenNthCalledWith(1, 'herdr', ['pane', 'list']);
    expect(harness.exec).toHaveBeenNthCalledWith(2, 'herdr', [
      'tab',
      'create',
      '--workspace',
      'w-1',
      '--cwd',
      harness.ctx.cwd,
      '--no-focus',
    ]);
    expect(harness.exec).toHaveBeenNthCalledWith(3, 'herdr', [
      'pane',
      'run',
      '1-3',
      expect.stringContaining(getLauncherScriptPath()),
    ]);
    expect(harness.exec).not.toHaveBeenCalledWith(
      'herdr',
      expect.arrayContaining(['pane', 'split']),
    );
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringMatching(/^⇄ split-fork via herdr\nchild → /),
      'info',
    );
  });

  test('split-fork does not create prompt temp files before Herdr tab creation succeeds', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });
    harness.exec.mockReset();
    harness.exec
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          result: {
            type: 'pane_list',
            panes: [{ pane_id: '1-2', focused: true, workspace_id: 'w-1' }],
          },
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'tab create failed' });

    const promptDirs: string[] = [];
    const originalMkdtempSync = fs.mkdtempSync;
    vi.spyOn(fs, 'mkdtempSync').mockImplementation((prefix: string) => {
      const dir = originalMkdtempSync(prefix);
      if (prefix.startsWith(path.join(os.tmpdir(), 'pi-native-split-'))) {
        promptDirs.push(dir);
      }
      return dir;
    });

    await registerPiNativeSplit(harness.pi, {
      HERDR_ENV: '1',
      COLUMNS: '64',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-fork');
    await handler('cleanup me', harness.ctx);

    expect(promptDirs).toHaveLength(0);
    expect(harness.exec).toHaveBeenCalledTimes(2);
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('Failed to launch herdr:'),
      'error',
    );
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('Startup prompt/command was not delivered.'),
      'warning',
    );
  });

  test('split-fork cleans up prompt temp files when Herdr run fails', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });
    harness.exec.mockReset();
    harness.exec
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          result: { type: 'pane_list', panes: [{ pane_id: '1-2', focused: true }] },
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ result: { type: 'pane_info', pane: { pane_id: '1-3' } } }),
        stderr: '',
      })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'pane not found' });

    await registerPiNativeSplit(harness.pi, {
      HERDR_ENV: '1',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-fork');
    await handler('cleanup me', harness.ctx);

    const runCommand = String(harness.exec.mock.calls[2][1][3]);
    const promptFile = extractPromptFilePath(runCommand);
    expect(promptFile).toBeDefined();
    expect(fs.existsSync(promptFile!)).toBe(false);
    expect(fs.existsSync(path.dirname(promptFile!))).toBe(false);
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('Failed to launch herdr:'),
      'error',
    );
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('Startup prompt/command was not delivered.'),
      'warning',
    );
  });

  test('split-resume launches the selected session in Kitty', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });
    harness.custom.mockResolvedValue('/tmp/sessions/resume-target.jsonl');

    await registerPiNativeSplit(harness.pi, {
      TERM_PROGRAM: 'kitty',
      KITTY_WINDOW_ID: '1',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-resume');
    await handler('', harness.ctx);

    const wrapperCommand = String(harness.exec.mock.calls[0][1].at(-1));
    expect(wrapperCommand).toContain(getLauncherScriptPath());
    expect(wrapperCommand).toContain('/tmp/sessions/resume-target.jsonl');
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('Resumed session in new kitty: pi --session '),
      'info',
    );
  });

  test('split-handoff edits the generated prompt and launches a child session', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });
    harness.realSessionManager.appendCustomEntry('pi-native-split.previous-marker', {});
    vi.mocked(complete).mockResolvedValue({
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Generated handoff prompt' }],
    } as any);

    let customCallCount = 0;
    harness.custom.mockImplementation(async () => {
      customCallCount += 1;
      return customCallCount === 1 ? 'Generated handoff prompt' : null;
    });

    await registerPiNativeSplit(harness.pi, {
      TERM_PROGRAM: 'kitty',
      KITTY_WINDOW_ID: '1',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-handoff');
    await handler('continue implementation', harness.ctx);

    expect(harness.editor).toHaveBeenCalledWith('Edit handoff prompt', 'Generated handoff prompt');

    const wrapperCommand = String(harness.exec.mock.calls[0][1].at(-1));
    expect(wrapperCommand).toContain(getLauncherScriptPath());
    const childSessionFile = extractSessionFilePath(wrapperCommand);
    expect(childSessionFile).toBeDefined();
    const promptFile = extractPromptFilePath(wrapperCommand);
    expect(promptFile).toBeDefined();
    expect(fs.readFileSync(promptFile!, 'utf8')).toBe('Edited handoff prompt');
    expect(wrapperCommand).not.toContain('Edited handoff prompt');
    fs.rmSync(path.dirname(promptFile!), { recursive: true, force: true });

    const markerFile = extractMarkerFilePath(wrapperCommand);
    expect(markerFile).toBeDefined();
    const childMarker = JSON.parse(fs.readFileSync(markerFile!, 'utf8'));
    expect(childMarker.data).toEqual(
      expect.objectContaining({
        side: 'child',
        kind: 'split-handoff',
        parent: expect.objectContaining({
          id: harness.realSessionManager.getSessionId(),
          file: harness.sessionFile,
          leaf: harness.userEntry.id,
        }),
        child: expect.objectContaining({ file: childSessionFile }),
        prompt: 'handoff',
      }),
    );

    expect(harness.notify).toHaveBeenCalledWith(
      `⇄ split-handoff via kitty\nchild → ${childMarker.data.child.id}`,
      'info',
    );
    expect(harness.setLabel).toHaveBeenCalledWith(
      harness.userEntry.id,
      `split-handoff child → ${childMarker.data.child.id}`,
    );
  });

  test('split-handoff Ghostty launch uses the wrapper startup command and does not inline prompt text', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });
    vi.mocked(complete).mockResolvedValue({
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Generated handoff prompt' }],
    } as any);

    let customCallCount = 0;
    harness.custom.mockImplementation(async () => {
      customCallCount += 1;
      return customCallCount === 1 ? 'Generated handoff prompt' : null;
    });

    await registerPiNativeSplit(harness.pi, {
      TERM_PROGRAM: 'ghostty',
      GHOSTTY_RESOURCES_DIR: '/Applications/Ghostty.app/Contents/Resources',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-handoff');
    await handler('continue implementation', harness.ctx);

    expect(harness.exec).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining(['-e', expect.stringContaining('tell application "Ghostty"')]),
    );

    const startupInput = String(harness.exec.mock.calls[0][1].at(-1));
    expect(startupInput).toContain('launcher.sh');
    expect(startupInput).not.toContain('Edited handoff prompt');

    const promptFileMatch = startupInput.match(/\/[^'\n]*pi-native-split-[^'\n]*\/prompt\.txt/);
    if (promptFileMatch) {
      fs.rmSync(path.dirname(promptFileMatch[0]), { recursive: true, force: true });
    }
  });

  test('split-tree launches the current session in Kitty and submits /tree', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });

    await registerPiNativeSplit(harness.pi, {
      TERM_PROGRAM: 'kitty',
      KITTY_WINDOW_ID: '1',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-tree');
    await handler('', harness.ctx);

    const wrapperCommand = String(harness.exec.mock.calls[0][1].at(-1));
    expect(wrapperCommand).toContain(getLauncherScriptPath());
    expect(wrapperCommand).toContain(harness.sessionFile);

    const promptFile = extractPromptFilePath(wrapperCommand);
    expect(promptFile).toBeDefined();
    expect(fs.readFileSync(promptFile!, 'utf8')).toBe('/tree');
    fs.rmSync(path.dirname(promptFile!), { recursive: true, force: true });
  });

  test('split-tree Ghostty launch uses wrapper startup input rather than inline /tree', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });

    await registerPiNativeSplit(harness.pi, {
      TERM_PROGRAM: 'ghostty',
      GHOSTTY_RESOURCES_DIR: '/Applications/Ghostty.app/Contents/Resources',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-tree');
    await handler('', harness.ctx);

    expect(harness.exec).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining(['-e', expect.stringContaining('tell application "Ghostty"')]),
    );

    const startupInput = String(harness.exec.mock.calls[0][1].at(-1));
    expect(startupInput).toContain('launcher.sh');
    expect(startupInput).not.toContain('/tree');

    const promptFileMatch = startupInput.match(/\/[^'\n]*pi-native-split-[^'\n]*\/prompt\.txt/);
    if (promptFileMatch) {
      fs.rmSync(path.dirname(promptFileMatch[0]), { recursive: true, force: true });
    }
  });

  test('split-tree fails early when interactive ui is unavailable', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });
    harness.ctx.hasUI = false;

    await registerPiNativeSplit(harness.pi, {
      TERM_PROGRAM: 'kitty',
      KITTY_WINDOW_ID: '1',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-tree');
    await handler('', harness.ctx);

    expect(harness.exec).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });

  test('split-tree fails when there is no persisted current session', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });
    harness.ctx.sessionManager.getSessionFile = () => null;

    await registerPiNativeSplit(harness.pi, {
      TERM_PROGRAM: 'kitty',
      KITTY_WINDOW_ID: '1',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-tree');
    await handler('', harness.ctx);

    expect(harness.exec).not.toHaveBeenCalled();
    expect(harness.notify).toHaveBeenCalledWith('split-tree requires a persisted session', 'error');
  });

  test('split-tree surfaces retry guidance when native launch fails', async () => {
    const harness = createCommandHarness({
      code: 1,
      stdout: '',
      stderr: 'pi-native-split: pi launch failed with exit code 1',
    });

    await registerPiNativeSplit(harness.pi, {
      TERM_PROGRAM: 'kitty',
      KITTY_WINDOW_ID: '1',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-tree');
    await handler('', harness.ctx);

    expect(harness.exec).toHaveBeenCalled();
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('Failed to launch kitty:'),
      'error',
    );
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('Retry in a new split/window with: pi --session '),
      'info',
    );
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('Startup prompt/command was not delivered.'),
      'warning',
    );
    expect(harness.notify).not.toHaveBeenCalledWith(
      expect.stringContaining('Opened kitty split for tree:'),
      'info',
    );
  });

  test('split-tree turns thrown pre-launch Ghostty errors into retryable notifications', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });
    harness.exec.mockRejectedValueOnce(new Error('osascript failed to launch'));

    await registerPiNativeSplit(harness.pi, {
      TERM_PROGRAM: 'ghostty',
      GHOSTTY_RESOURCES_DIR: '/Applications/Ghostty.app/Contents/Resources',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-tree');
    await expect(handler('', harness.ctx)).resolves.toBeUndefined();

    expect(harness.notify).toHaveBeenCalledWith(
      'Failed to launch ghostty: pre-launch command failed: osascript failed to launch',
      'error',
    );
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('Retry in a new split/window with: pi --session '),
      'info',
    );
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('Startup prompt/command was not delivered.'),
      'warning',
    );
  });

  test('split-tree opens the current session in Herdr and submits /tree', async () => {
    const harness = createCommandHarness({ code: 0, stdout: '', stderr: '' });
    harness.exec.mockReset();
    harness.exec
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          result: { type: 'pane_list', panes: [{ pane_id: '1-2', focused: true }] },
        }),
        stderr: '',
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ result: { type: 'pane_info', pane: { pane_id: '1-3' } } }),
        stderr: '',
      })
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });

    await registerPiNativeSplit(harness.pi, {
      HERDR_ENV: '1',
      SHELL: '/bin/zsh',
    } as NodeJS.ProcessEnv);

    const handler = getRegisteredHandler(harness.registerCommand, 'split-tree');
    await handler('', harness.ctx);

    expect(harness.exec).toHaveBeenNthCalledWith(1, 'herdr', ['pane', 'list']);
    expect(harness.exec).toHaveBeenNthCalledWith(2, 'herdr', [
      'pane',
      'split',
      '1-2',
      '--direction',
      'right',
      '--cwd',
      harness.ctx.cwd,
      '--no-focus',
    ]);
    expect(harness.exec).toHaveBeenNthCalledWith(3, 'herdr', [
      'pane',
      'run',
      '1-3',
      expect.stringContaining(getLauncherScriptPath()),
    ]);

    const runCommand = String(harness.exec.mock.calls[2][1][3]);
    const promptFile = extractPromptFilePath(runCommand);
    expect(promptFile).toBeDefined();
    expect(fs.readFileSync(promptFile!, 'utf8')).toBe('/tree');
    fs.rmSync(path.dirname(promptFile!), { recursive: true, force: true });
  });
});
