import { describe, expect, test, vi } from 'vitest';

import loopExtension from './index';

function createHarness() {
  const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const appendEntry = vi.fn();
  const sendMessage = vi.fn();
  const pi = {
    appendEntry,
    on: vi.fn((event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(event, handler);
    }),
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command.handler);
    },
    registerTool: vi.fn(),
    sendMessage,
  };

  loopExtension(pi as any);
  return { appendEntry, commands, handlers, sendMessage };
}

function createPrintCtx() {
  return {
    hasPendingMessages: () => false,
    hasUI: false,
    mode: 'print',
    model: undefined,
    sessionManager: { getEntries: () => [] },
  };
}

describe('loop command mode guards', () => {
  test('returns without opening the selector outside TUI mode', async () => {
    const { appendEntry, commands, sendMessage } = createHarness();

    await expect(commands.get('loop')?.('', createPrintCtx())).resolves.toBeUndefined();

    expect(appendEntry).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('runs preset loops outside TUI mode without touching UI', async () => {
    const { appendEntry, commands, sendMessage } = createHarness();

    await expect(commands.get('loop')?.('tests', createPrintCtx())).resolves.toBeUndefined();

    expect(appendEntry).toHaveBeenCalledWith(
      'loop-state',
      expect.objectContaining({ active: true, mode: 'tests' }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Run all tests') }),
      { deliverAs: 'followUp', triggerTurn: true },
    );
  });

  test('does not provide custom compaction while loop is active', async () => {
    const { commands, handlers } = createHarness();
    await expect(commands.get('loop')?.('tests', createPrintCtx())).resolves.toBeUndefined();

    const compactionCtx = {
      ...createPrintCtx(),
      model: { provider: 'openai-codex', id: 'gpt-5.5' },
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: false })),
      },
    };

    await expect(
      handlers.get('session_before_compact')?.(
        {
          customInstructions: undefined,
          preparation: {},
          signal: new AbortController().signal,
        },
        compactionCtx,
      ),
    ).resolves.toBeUndefined();
    expect(compactionCtx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
  });
});
