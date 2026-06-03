import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import piComputerUseExtension from './src/extension';

function makeSessionContext(root: string) {
  return {
    cwd: path.join(root, 'project'),
    sessionManager: {
      getSessionFile: () => path.join(root, 'sessions/session.jsonl'),
    },
  };
}

describe('pi-codex-computer-use extension commands', () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-extension-'));
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

    piComputerUseExtension(pi as any);

    expect(commands.has('codex-computer-use')).toBe(false);
    expect(commands.has('codex-computer-use-enable')).toBe(false);
    expect(commands.has('codex-computer-use-disable')).toBe(false);
    expect(commands.has('codex-computer-use-doctor')).toBe(true);
    expect(commands.has('codex-computer-use-status')).toBe(false);
    expect(commands.has('computer-use')).toBe(false);
  });

  test('registers enable alias while disabled', async () => {
    const commands = new Map<string, unknown>();
    let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const pi = {
      getActiveTools: () => [],
      registerTool() {},
      registerCommand(name: string, command: unknown) {
        commands.set(name, command);
      },
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
        if (event === 'session_start') sessionStart = handler;
      },
      setActiveTools() {},
    };

    piComputerUseExtension(pi as any);
    await sessionStart?.({ type: 'session_start' }, makeSessionContext(root));

    expect(commands.has('codex-computer-use-enable')).toBe(true);
    expect(commands.has('codex-computer-use-disable')).toBe(false);
  });

  test('registers disable alias while enabled', async () => {
    const commands = new Map<string, unknown>();
    let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const projectSettings = path.join(root, 'project/.pi/settings.json');
    fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
    fs.writeFileSync(projectSettings, JSON.stringify({ codexComputerUse: { enabled: true } }));
    const pi = {
      getActiveTools: () => [],
      registerTool() {},
      registerCommand(name: string, command: unknown) {
        commands.set(name, command);
      },
      on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
        if (event === 'session_start') sessionStart = handler;
      },
      setActiveTools() {},
    };

    piComputerUseExtension(pi as any);
    await sessionStart?.({ type: 'session_start' }, makeSessionContext(root));

    expect(commands.has('codex-computer-use-enable')).toBe(false);
    expect(commands.has('codex-computer-use-disable')).toBe(true);
  });
});
