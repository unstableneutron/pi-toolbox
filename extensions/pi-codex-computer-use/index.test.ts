import { describe, expect, test } from 'vitest';

import piComputerUseExtension from './index';

describe('pi-codex-computer-use extension commands', () => {
  test('registers the doctor slash command only', () => {
    const commands = new Map<string, unknown>();
    const pi = {
      registerTool() {},
      registerCommand(name: string, command: unknown) {
        commands.set(name, command);
      },
      on() {},
    };

    piComputerUseExtension(pi as any);

    expect(commands.has('codex-computer-use-doctor')).toBe(true);
    expect(commands.has('codex-computer-use-status')).toBe(false);
    expect(commands.has('computer-use')).toBe(false);
  });
});
