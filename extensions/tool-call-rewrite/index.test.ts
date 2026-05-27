import { describe, expect, test, vi } from 'vitest';

import {
  createToolCallRewriteState,
  dedupeAssistantToolCalls,
  default as registerToolCallRewrite,
  recordToolCall,
  stableJson,
} from './index';

describe('stableJson', () => {
  test('canonicalizes object key order before signature comparison', () => {
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } })).toBe(stableJson({ a: { c: 3, d: 4 }, b: 2 }));
  });
});

describe('recordToolCall', () => {
  test('blocks exact duplicate calls within one assistant scope', () => {
    const state = createToolCallRewriteState({ maxSeen: 128 });
    const input = { command: 'jj new', timeout: 30 };

    expect(recordToolCall(state, 'assistant-1', 'bash', input)).toMatchObject({
      duplicate: false,
    });
    expect(recordToolCall(state, 'assistant-1', 'bash', input)).toMatchObject({
      duplicate: true,
    });
  });

  test('allows the same call again in a later assistant scope', () => {
    const state = createToolCallRewriteState({ maxSeen: 128 });
    const input = { command: 'jj new', timeout: 30 };

    recordToolCall(state, 'assistant-1', 'bash', input);

    expect(recordToolCall(state, 'assistant-2', 'bash', input)).toMatchObject({
      duplicate: false,
      scopeChanged: true,
    });
  });

  test('keeps memory bounded by evicting old signatures', () => {
    const state = createToolCallRewriteState({ maxSeen: 2 });

    recordToolCall(state, 'assistant-1', 'bash', { command: 'one' });
    recordToolCall(state, 'assistant-1', 'bash', { command: 'two' });
    recordToolCall(state, 'assistant-1', 'bash', { command: 'three' });

    expect(state.order).toHaveLength(2);
    expect(recordToolCall(state, 'assistant-1', 'bash', { command: 'one' })).toMatchObject({
      duplicate: false,
    });
  });
});

describe('dedupeAssistantToolCalls', () => {
  test('removes duplicate top-level tool calls from the same assistant message', () => {
    const message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I’ll inspect.' },
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'read',
          arguments: { path: 'a.ts', offset: 1, limit: 20 },
        },
        {
          type: 'toolCall',
          id: 'call-2',
          name: 'read',
          arguments: { limit: 20, offset: 1, path: 'a.ts' },
        },
        {
          type: 'toolCall',
          id: 'call-3',
          name: 'read',
          arguments: { path: 'b.ts', offset: 1, limit: 20 },
        },
      ],
    } as any;

    const result = dedupeAssistantToolCalls(message);

    expect(result.changed).toBe(true);
    expect(result.message.content.map((part: any) => part.id).filter(Boolean)).toEqual([
      'call-1',
      'call-3',
    ]);
  });

  test('removes duplicate nested multi_tool_use.parallel tool_uses', () => {
    const message = {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call-wrapper',
          name: 'multi_tool_use.parallel',
          arguments: {
            tool_uses: [
              {
                recipient_name: 'functions.read',
                parameters: { path: 'a.ts', offset: 1, limit: 20 },
              },
              {
                recipient_name: 'functions.read',
                parameters: { limit: 20, offset: 1, path: 'a.ts' },
              },
              {
                recipient_name: 'functions.read',
                parameters: { path: 'b.ts', offset: 1, limit: 20 },
              },
            ],
          },
        },
      ],
    } as any;

    const result = dedupeAssistantToolCalls(message);

    expect(result.changed).toBe(true);
    expect(result.message.content).toHaveLength(1);
    expect(result.message.content[0].arguments.tool_uses).toEqual([
      { recipient_name: 'functions.read', parameters: { path: 'a.ts', offset: 1, limit: 20 } },
      { recipient_name: 'functions.read', parameters: { path: 'b.ts', offset: 1, limit: 20 } },
    ]);
  });
});

describe('tool-call-rewrite extension', () => {
  test('repairs fff and edit tool-call aliases before execution', async () => {
    const handlers = new Map<string, Function>();
    const pi = {
      on: vi.fn((name: string, handler: Function) => {
        handlers.set(name, handler);
      }),
    } as any;
    const ctx = {
      sessionManager: {
        getLeafId: () => 'assistant-1',
      },
      ui: {
        setStatus: vi.fn(),
      },
    } as any;

    registerToolCallRewrite(pi, { maxSeen: 128 });
    const toolCall = handlers.get('tool_call');
    expect(toolCall).toBeDefined();

    const grepEvent = {
      toolName: 'fff_grep',
      toolCallId: 'call-1',
      input: { query: 'createRouter', path: 'src', caseSensitive: false },
    };
    await toolCall!(grepEvent, ctx);
    expect(grepEvent.input).toEqual({
      patterns: ['createRouter'],
      literal: true,
      within: 'src',
      case_sensitive: false,
    });

    const editEvent = {
      toolName: 'edit',
      toolCallId: 'call-2',
      input: { filePath: 'src/app.ts', old_string: 'foo', new_string: 'bar' },
    };
    await toolCall!(editEvent, ctx);
    expect(editEvent.input).toEqual({ path: 'src/app.ts', oldText: 'foo', newText: 'bar' });
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      'tool-call-rewrite',
      expect.stringContaining('Rewrote tool input'),
    );
  });

  test('blocks duplicate tool_call events using the current session leaf as scope', async () => {
    const handlers = new Map<string, Function>();
    const pi = {
      on: vi.fn((name: string, handler: Function) => {
        handlers.set(name, handler);
      }),
    } as any;
    const ctx = {
      sessionManager: {
        getLeafId: () => 'assistant-1',
      },
      ui: {
        setStatus: vi.fn(),
      },
    } as any;
    const event = {
      toolName: 'bash',
      toolCallId: 'call-1',
      input: { command: 'jj new', timeout: 30 },
    };

    registerToolCallRewrite(pi, { maxSeen: 128 });
    const toolCall = handlers.get('tool_call');
    expect(toolCall).toBeDefined();

    await toolCall!(event, ctx);
    const blocked = await toolCall!({ ...event, toolCallId: 'call-2' }, ctx);

    expect(blocked).toEqual({
      block: true,
      reason:
        'Blocked duplicate tool call: bash with identical arguments already appeared in this assistant response.',
    });
  });

  test('rewrites same-message duplicate tool calls before execution', async () => {
    const handlers = new Map<string, Function>();
    const pi = {
      on: vi.fn((name: string, handler: Function) => {
        handlers.set(name, handler);
      }),
    } as any;
    const ctx = {
      sessionManager: {
        getLeafId: () => 'assistant-1',
      },
      ui: {
        setStatus: vi.fn(),
      },
    } as any;

    registerToolCallRewrite(pi, { maxSeen: 128 });
    const messageEnd = handlers.get('message_end');
    expect(messageEnd).toBeDefined();

    const result = await messageEnd!(
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: 'a.ts' } },
          ],
        },
      },
      ctx,
    );

    expect(result.message.content).toEqual([
      { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.ts' } },
    ]);
  });

  test('does not no-op calls from a previous multi-call batch unless they are strictly adjacent', async () => {
    const handlers = new Map<string, Function>();
    const pi = {
      on: vi.fn((name: string, handler: Function) => {
        handlers.set(name, handler);
      }),
    } as any;
    const ctx = {
      sessionManager: {
        getLeafId: () => 'assistant-1',
      },
      ui: {
        setStatus: vi.fn(),
      },
    } as any;

    registerToolCallRewrite(pi, { maxSeen: 128 });
    const toolCall = handlers.get('tool_call');
    const messageEnd = handlers.get('message_end');
    expect(toolCall).toBeDefined();
    expect(messageEnd).toBeDefined();

    await messageEnd!(
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-a', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'toolCall', id: 'call-b', name: 'read', arguments: { path: 'b.ts' } },
            { type: 'toolCall', id: 'call-c', name: 'read', arguments: { path: 'c.ts' } },
          ],
        },
      },
      ctx,
    );
    await toolCall!({ toolName: 'read', toolCallId: 'call-a', input: { path: 'a.ts' } }, ctx);
    await toolCall!({ toolName: 'read', toolCallId: 'call-b', input: { path: 'b.ts' } }, ctx);
    await toolCall!({ toolName: 'read', toolCallId: 'call-c', input: { path: 'c.ts' } }, ctx);
    for (const [toolCallId, path] of [
      ['call-a', 'a.ts'],
      ['call-b', 'b.ts'],
      ['call-c', 'c.ts'],
    ]) {
      await messageEnd!(
        {
          type: 'message_end',
          message: {
            role: 'toolResult',
            toolCallId,
            toolName: 'read',
            content: [{ type: 'text', text: path }],
            isError: false,
          },
        },
        ctx,
      );
    }

    ctx.sessionManager.getLeafId = () => 'assistant-2';
    await messageEnd!(
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-a-again', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'toolCall', id: 'call-b-again', name: 'read', arguments: { path: 'b.ts' } },
          ],
        },
      },
      ctx,
    );

    await expect(
      toolCall!({ toolName: 'read', toolCallId: 'call-a-again', input: { path: 'a.ts' } }, ctx),
    ).resolves.toBeUndefined();
    await expect(
      toolCall!({ toolName: 'read', toolCallId: 'call-b-again', input: { path: 'b.ts' } }, ctx),
    ).resolves.toBeUndefined();
  });

  test('turns an adjacent duplicate tool call into a compact successful no-op result', async () => {
    const handlers = new Map<string, Function>();
    const pi = {
      on: vi.fn((name: string, handler: Function) => {
        handlers.set(name, handler);
      }),
    } as any;
    const ctx = {
      sessionManager: {
        getLeafId: () => 'assistant-1',
      },
      ui: {
        setStatus: vi.fn(),
      },
    } as any;

    registerToolCallRewrite(pi, { maxSeen: 128 });
    const toolCall = handlers.get('tool_call');
    const messageEnd = handlers.get('message_end');
    expect(toolCall).toBeDefined();
    expect(messageEnd).toBeDefined();

    await toolCall!(
      { toolName: 'read', toolCallId: 'call-1', input: { path: 'a.ts', offset: 1, limit: 20 } },
      ctx,
    );
    await messageEnd!(
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read',
          content: [{ type: 'text', text: 'file contents' }],
          isError: false,
        },
      },
      ctx,
    );

    ctx.sessionManager.getLeafId = () => 'assistant-2';
    const blocked = await toolCall!(
      { toolName: 'read', toolCallId: 'call-2', input: { limit: 20, offset: 1, path: 'a.ts' } },
      ctx,
    );
    expect(blocked).toEqual({
      block: true,
      reason: 'Deduped: identical tool call already ran immediately before.',
    });

    const rewritten = await messageEnd!(
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'call-2',
          toolName: 'read',
          content: [{ type: 'text', text: 'Tool execution was blocked' }],
          details: { existing: true },
          isError: true,
        },
      },
      ctx,
    );

    expect(rewritten.message).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-2',
      toolName: 'read',
      content: [
        {
          type: 'text',
          text: 'Deduped: identical tool call already ran immediately before.',
        },
      ],
      details: {
        existing: true,
        toolCallRewrite: {
          deduped: true,
          fromToolCallId: 'call-1',
          reason: 'adjacent-duplicate',
        },
      },
      isError: false,
    });
  });
});
