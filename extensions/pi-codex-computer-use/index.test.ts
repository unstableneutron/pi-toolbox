import { describe, expect, test } from 'vitest';

import piComputerUseExtension, { parseStatusCommandOptions } from './index';

describe('parseStatusCommandOptions', () => {
  test('detects verbose mode from command args', () => {
    expect(parseStatusCommandOptions(['verbose'])).toEqual({ verbose: true });
    expect(parseStatusCommandOptions(['--verbose'])).toEqual({ verbose: true });
    expect(parseStatusCommandOptions('verbose')).toEqual({ verbose: true });
    expect(parseStatusCommandOptions([])).toEqual({ verbose: false });
  });
});

describe('pi-codex-computer-use extension commands', () => {
  test('registers the diagnostic status slash command', () => {
    const commands = new Map<string, unknown>();
    const pi = {
      registerTool() {},
      registerCommand(name: string, command: unknown) {
        commands.set(name, command);
      },
      on() {},
    };

    piComputerUseExtension(pi as any);

    expect(commands.has('codex-computer-use-status')).toBe(true);
    expect(commands.has('computer-use')).toBe(false);
  });
});
