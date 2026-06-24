import { describe, expect, test, vi } from 'vitest';

const { completeMock } = vi.hoisted(() => ({
  completeMock: vi.fn(),
}));

vi.mock('@earendil-works/pi-ai/compat', async () => {
  const actual = await vi.importActual<typeof import('@earendil-works/pi-ai/compat')>(
    '@earendil-works/pi-ai/compat',
  );
  return {
    ...actual,
    complete: completeMock,
  };
});

vi.mock('@earendil-works/pi-coding-agent', async () => {
  const actual = await vi.importActual<typeof import('@earendil-works/pi-coding-agent')>(
    '@earendil-works/pi-coding-agent',
  );

  class MockBorderedLoader {
    readonly signal = new AbortController().signal;
    onAbort?: () => void;
  }

  return {
    ...actual,
    BorderedLoader: MockBorderedLoader,
  };
});

import handoffExtension from './index';

function createHarness() {
  const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
  const pi = {
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command.handler);
    },
  };

  handoffExtension(pi as any);
  return { commands };
}

describe('handoff', () => {
  test('returns without touching UI outside TUI mode', async () => {
    const { commands } = createHarness();

    await expect(
      commands.get('handoff')?.('continue elsewhere', { mode: 'print', hasUI: false }),
    ).resolves.toBeUndefined();
  });

  test('generates handoff prompt from compacted session context', async () => {
    completeMock.mockResolvedValue({
      stopReason: 'stop',
      content: [{ type: 'text', text: 'generated handoff prompt' }],
    });

    const { commands } = createHarness();
    const setEditorText = vi.fn();
    const notify = vi.fn();

    const entries = [
      {
        id: 'old-user',
        parentId: null,
        timestamp: '2026-05-04T00:00:00.000Z',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'raw old user content' }] },
      },
      {
        id: 'old-assistant',
        parentId: 'old-user',
        timestamp: '2026-05-04T00:00:01.000Z',
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'raw old assistant content' }],
        },
      },
      {
        id: 'kept-user',
        parentId: 'old-assistant',
        timestamp: '2026-05-04T00:00:02.000Z',
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'recent kept content' }] },
      },
      {
        id: 'compact',
        parentId: 'kept-user',
        timestamp: '2026-05-04T00:00:03.000Z',
        type: 'compaction',
        summary: 'compacted old summary',
        firstKeptEntryId: 'kept-user',
        tokensBefore: 123,
      },
      {
        id: 'new-assistant',
        parentId: 'compact',
        timestamp: '2026-05-04T00:00:04.000Z',
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'new post-compaction content' }],
        },
      },
    ];

    const ctx = {
      hasUI: true,
      mode: 'tui',
      model: { provider: 'anthropic', id: 'claude-haiku-4-5' },
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: 'key', headers: {} }),
      },
      sessionManager: {
        getEntries: () => entries,
        getLeafId: () => 'new-assistant',
        getSessionFile: () => '/tmp/session.jsonl',
      },
      ui: {
        notify,
        custom: async (factory: any) =>
          new Promise((resolve) => {
            factory({}, {}, {}, resolve);
          }),
        editor: vi.fn().mockResolvedValue('edited handoff prompt'),
        setEditorText,
      },
      newSession: vi.fn(async (options) => {
        await options.withSession({ ui: { setEditorText, notify } });
        return { cancelled: false };
      }),
    };

    await commands.get('handoff')?.('continue elsewhere', ctx);

    const prompt = completeMock.mock.calls[0]?.[1].messages[0].content[0].text as string;
    expect(prompt).toContain('compacted old summary');
    expect(prompt).toContain('recent kept content');
    expect(prompt).toContain('new post-compaction content');
    expect(prompt).not.toContain('raw old user content');
    expect(prompt).not.toContain('raw old assistant content');
    expect(setEditorText).toHaveBeenCalledWith('edited handoff prompt');
  });
});
