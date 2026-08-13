import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';

import loopExtension from './index';

function createHarness() {
  const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const appendEntry = vi.fn();
  const sendMessage = vi.fn();
  let activeTools: string[] = [];
  const setActiveTools = vi.fn((names: string[]) => {
    activeTools = names;
  });
  const pi = {
    appendEntry,
    on: vi.fn((event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(event, handler);
    }),
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command.handler);
    },
    registerTool: vi.fn(),
    getActiveTools: () => activeTools,
    setActiveTools,
    sendMessage,
  };

  loopExtension(pi as any);
  return {
    appendEntry,
    commands,
    handlers,
    sendMessage,
    registerTool: pi.registerTool,
    setActiveTools,
  };
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

describe('loop model selection config', () => {
  test('uses GPT-5.6 Luna without a Haiku fallback', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    expect(source).toContain("{ provider: 'openai-codex', id: 'gpt-5.6-luna' }");
    expect(source).toContain("{ provider: 'openai', id: 'gpt-5.6-luna' }");
    expect(source).not.toMatch(/haiku/i);
  });
});

describe('loop command mode guards', () => {
  test('registers a strict-preferred loop success tool', () => {
    const { registerTool } = createHarness();
    const tool = registerTool.mock.calls[0]?.[0];

    expect(tool.parameters.additionalProperties).toBe(false);
    expect(tool.constrainedSampling).toEqual({ type: 'json_schema', strict: 'prefer' });
    expect(tool.promptSnippet).toBeUndefined();
  });

  test('returns without opening the selector outside TUI mode', async () => {
    const { appendEntry, commands, sendMessage } = createHarness();

    await expect(commands.get('loop')?.('', createPrintCtx())).resolves.toBeUndefined();

    expect(appendEntry).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('runs preset loops outside TUI mode and enables the success tool', async () => {
    const { appendEntry, commands, sendMessage, setActiveTools } = createHarness();

    await expect(commands.get('loop')?.('tests', createPrintCtx())).resolves.toBeUndefined();

    expect(appendEntry).toHaveBeenCalledWith(
      'loop-state',
      expect.objectContaining({ active: true, mode: 'tests' }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Run all tests') }),
      { deliverAs: 'followUp', triggerTurn: true },
    );
    expect(setActiveTools).toHaveBeenCalledWith(['signal_loop_success']);
  });

  test('restores loop control after tree navigation to an active loop branch', async () => {
    const { handlers, setActiveTools } = createHarness();
    const ctx = {
      ...createPrintCtx(),
      sessionManager: {
        getEntries: () => [
          {
            type: 'custom',
            customType: 'loop-state',
            data: { active: true, mode: 'tests', summary: 'tests pass' },
          },
        ],
      },
    };

    await handlers.get('session_tree')?.({ type: 'session_tree' }, ctx);

    expect(setActiveTools).toHaveBeenCalledWith(['signal_loop_success']);
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
