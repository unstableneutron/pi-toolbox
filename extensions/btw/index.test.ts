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

  test('registers explicit surface commands', () => {
    const { commands } = createHarness();
    expect([...commands.keys()].sort()).toEqual([
      'btw',
      'btw-inline',
      'btw-overlay',
      'btw-pane',
      'btw-popup',
    ]);
  });

  test('default popup falls back to the Pi overlay outside Herdr', async () => {
    const previous = { ...process.env };
    try {
      process.env.PI_CODING_AGENT_DIR = `/tmp/btw-index-test-${process.pid}`;
      delete process.env.HERDR_ENV;
      delete process.env.HERDR_SOCKET_PATH;
      delete process.env.HERDR_PANE_ID;
      delete process.env.KITTY_WINDOW_ID;
      delete process.env.GHOSTTY_RESOURCES_DIR;
      delete process.env.TERM_PROGRAM;

      const { commands } = createHarness();
      const custom = vi.fn(async () => undefined);
      const notify = vi.fn();

      await commands.get('btw')?.('quick question', {
        cwd: '/tmp',
        getSystemPrompt: () => '',
        hasUI: true,
        isIdle: () => true,
        mode: 'tui',
        model: undefined,
        sessionManager: { getBranch: () => [] },
        ui: { custom, notify },
        waitForIdle: vi.fn(),
      });

      expect(custom).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith('No active model selected.', 'error');
    } finally {
      process.env = previous;
    }
  });

  test('btw-pane returns outside TUI mode', async () => {
    const { commands } = createHarness();
    await commands.get('btw-pane')?.('quick question', {
      hasUI: true,
      mode: 'rpc',
      cwd: '/tmp',
    });
  });
});
