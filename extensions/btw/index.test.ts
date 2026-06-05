import { describe, expect, test, vi } from 'vitest';

import btwExtension from './index';

function createHarness() {
  const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
  const appendEntry = vi.fn();
  const pi = {
    appendEntry,
    getThinkingLevel: () => 'off',
    on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command.handler);
    },
  };

  btwExtension(pi as any);
  return { appendEntry, commands, handlers };
}

describe('btw mode guards', () => {
  test('command returns without resetting state or opening overlay outside TUI mode', async () => {
    const { appendEntry, commands } = createHarness();
    const custom = vi.fn();

    await commands.get('btw')?.('', {
      hasUI: true,
      mode: 'rpc',
      sessionManager: { getBranch: () => [] },
      ui: { custom },
    });

    expect(appendEntry).not.toHaveBeenCalled();
    expect(custom).not.toHaveBeenCalled();
  });
});
