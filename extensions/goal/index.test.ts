import { describe, expect, test, vi } from 'vitest';

import goalExtension from './index';

type Handler = (event: any, ctx: any) => any;

function createHarness() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: Handler }>();
  const tools = new Map<string, { execute: Handler }>();
  const sentMessages: Array<{ message: any; options: any }> = [];
  const entries: any[] = [];
  const notifications: Array<{ message: string; type: string }> = [];

  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    }),
    sendMessage: vi.fn((message: any, options: any) => {
      sentMessages.push({ message, options });
    }),
    appendEntry: vi.fn((customType: string, data: any) => {
      entries.push({ type: 'custom', customType, data });
    }),
    registerCommand: vi.fn((name: string, command: { handler: Handler }) => {
      commands.set(name, command);
    }),
    registerTool: vi.fn((tool: { name: string; execute: Handler }) => {
      tools.set(tool.name, tool);
    }),
  };

  const ctx = {
    hasUI: true,
    ui: {
      theme: { fg: (_kind: string, text: string) => text },
      setStatus: vi.fn(),
      notify: vi.fn((message: string, type: string) => notifications.push({ message, type })),
      confirm: vi.fn(async () => true),
    },
    sessionManager: {
      getBranch: vi.fn(() => entries),
      getSessionId: vi.fn(() => 'session-1'),
    },
    hasPendingMessages: vi.fn(() => false),
    isIdle: vi.fn(() => true),
  };

  goalExtension(pi as any);

  async function emit(event: string, payload: any = {}) {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload, ctx);
    }
  }

  return { commands, ctx, emit, notifications, pi, sentMessages, tools };
}

const contextOverflowAssistant = {
  role: 'assistant',
  content: [],
  stopReason: 'error',
  errorMessage:
    '{"type":"error","error":{"code":"context_length_exceeded","message":"Your input exceeds the context window of this model."}}',
  usage: { input: 0, output: 0, total: 0 },
};

const usefulAssistant = {
  role: 'assistant',
  content: [{ type: 'text', text: 'Recovered.' }],
  stopReason: 'stop',
  usage: { input: 10, output: 5, total: 15 },
};

describe('goal continuation recovery', () => {
  test('suspends auto-continuation after an empty assistant context overflow error', async () => {
    const h = createHarness();

    await h.commands.get('goal')!.handler('ship the thing', h.ctx);
    expect(
      h.sentMessages.filter((item) => item.message.customType === 'goal-continuation'),
    ).toHaveLength(1);

    await h.emit('agent_start');
    await h.emit('agent_end', { messages: [contextOverflowAssistant] });

    expect(
      h.sentMessages.filter((item) => item.message.customType === 'goal-continuation'),
    ).toHaveLength(1);
    expect(h.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: 'goal-ui', display: true }),
      { triggerTurn: false },
    );
    expect(h.sentMessages.at(-1)!.message.customType).toBe('goal-ui');
  });

  test('resumes a suspended goal continuation after successful compaction', async () => {
    const h = createHarness();

    await h.commands.get('goal')!.handler('ship the thing', h.ctx);
    await h.emit('agent_start');
    await h.emit('agent_end', { messages: [contextOverflowAssistant] });

    await h.emit('session_compact', { compactionEntry: { id: 'compact-1' } });

    expect(
      h.sentMessages.filter((item) => item.message.customType === 'goal-continuation'),
    ).toHaveLength(2);
  });

  test('resumes a suspended goal after a useful assistant response', async () => {
    const h = createHarness();

    await h.commands.get('goal')!.handler('ship the thing', h.ctx);
    await h.emit('agent_start');
    await h.emit('agent_end', { messages: [contextOverflowAssistant] });
    await h.emit('agent_start');
    await h.emit('agent_end', { messages: [usefulAssistant] });

    expect(
      h.sentMessages.filter((item) => item.message.customType === 'goal-continuation'),
    ).toHaveLength(2);
  });
});
