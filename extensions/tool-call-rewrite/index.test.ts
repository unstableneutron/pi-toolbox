import { describe, expect, test, vi } from 'vitest';

import {
  createToolCallRewriteState,
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

  test('turns same-response duplicate tool_call events into no-op results', async () => {
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
    const messageEnd = handlers.get('message_end');
    expect(toolCall).toBeDefined();
    expect(messageEnd).toBeDefined();

    await toolCall!(event, ctx);
    const blocked = await toolCall!({ ...event, toolCallId: 'call-2' }, ctx);

    expect(blocked).toEqual({
      block: true,
      reason: 'Deduped: duplicate tool call skipped.',
    });

    const rewritten = await messageEnd!(
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'call-2',
          toolName: 'bash',
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
      toolName: 'bash',
      content: [
        {
          type: 'text',
          text: 'Deduped: duplicate tool call skipped.',
        },
      ],
      details: {
        existing: true,
        toolCallRewrite: {
          deduped: true,
          matchingToolCallId: 'call-1',
          reason: 'same-response-duplicate',
        },
      },
      isError: true,
    });
  });

  test('does not remove same-message duplicate tool calls at message_end', async () => {
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

    expect(result).toBeUndefined();
  });

  test('does not prune or rewrite duplicate multi_tool_use.parallel entries', async () => {
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
    const input = {
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
    };

    registerToolCallRewrite(pi, { maxSeen: 128 });
    const toolCall = handlers.get('tool_call');
    const messageEnd = handlers.get('message_end');
    expect(toolCall).toBeDefined();
    expect(messageEnd).toBeDefined();

    await expect(
      toolCall!(
        {
          toolName: 'multi_tool_use.parallel',
          toolCallId: 'call-wrapper',
          input,
        },
        ctx,
      ),
    ).resolves.toBeUndefined();
    expect(input.tool_uses).toEqual([
      { recipient_name: 'functions.read', parameters: { path: 'a.ts', offset: 1, limit: 20 } },
      { recipient_name: 'functions.read', parameters: { limit: 20, offset: 1, path: 'a.ts' } },
      { recipient_name: 'functions.read', parameters: { path: 'b.ts', offset: 1, limit: 20 } },
    ]);

    await expect(
      messageEnd!(
        {
          type: 'message_end',
          message: {
            role: 'toolResult',
            toolCallId: 'call-wrapper',
            toolName: 'multi_tool_use.parallel',
            content: [{ type: 'text', text: 'parallel results' }],
            details: { existing: true },
            isError: false,
          },
        },
        ctx,
      ),
    ).resolves.toBeUndefined();
  });

  test('dedupes cacheable calls from previous tool-call groups across model continuation turns', async () => {
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
    const turnStart = handlers.get('turn_start');
    const turnEnd = handlers.get('turn_end');
    expect(toolCall).toBeDefined();
    expect(messageEnd).toBeDefined();
    expect(turnStart).toBeDefined();
    expect(turnEnd).toBeDefined();

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

    await turnEnd!({ type: 'turn_end' }, ctx);
    await turnStart!({ type: 'turn_start' }, ctx);

    ctx.sessionManager.getLeafId = () => 'assistant-2';
    await messageEnd!(
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'call-a-again', name: 'read', arguments: { path: 'a.ts' } },
          ],
        },
      },
      ctx,
    );

    await expect(
      toolCall!({ toolName: 'read', toolCallId: 'call-a-again', input: { path: 'a.ts' } }, ctx),
    ).resolves.toEqual({
      block: true,
      reason: 'Deduped: duplicate tool call skipped.',
    });

    const rewritten = await messageEnd!(
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'call-a-again',
          toolName: 'read',
          content: [{ type: 'text', text: 'Tool execution was blocked' }],
          isError: true,
        },
      },
      ctx,
    );

    expect(rewritten.message).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-a-again',
      toolName: 'read',
      content: [
        {
          type: 'text',
          text: 'Deduped: duplicate tool call skipped.',
        },
      ],
      details: {
        toolCallRewrite: {
          deduped: true,
          matchingToolCallId: 'call-a',
          reason: 'same-turn-duplicate',
        },
      },
      isError: true,
    });
  });

  test('does not dedupe non-cacheable tools across assistant groups', async () => {
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
      { toolName: 'bash', toolCallId: 'call-1', input: { command: 'npm test' } },
      ctx,
    );
    await messageEnd!(
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'passed' }],
          isError: false,
        },
      },
      ctx,
    );

    ctx.sessionManager.getLeafId = () => 'assistant-2';
    await expect(
      toolCall!({ toolName: 'bash', toolCallId: 'call-2', input: { command: 'npm test' } }, ctx),
    ).resolves.toBeUndefined();
  });

  test('clears same-turn cache after a non-cacheable tool result', async () => {
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

    await toolCall!({ toolName: 'read', toolCallId: 'read-1', input: { path: 'a.ts' } }, ctx);
    await messageEnd!(
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'read-1',
          toolName: 'read',
          content: [{ type: 'text', text: 'before' }],
          isError: false,
        },
      },
      ctx,
    );

    ctx.sessionManager.getLeafId = () => 'assistant-2';
    await toolCall!(
      { toolName: 'bash', toolCallId: 'bash-1', input: { command: 'touch a.ts' } },
      ctx,
    );
    await messageEnd!(
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'bash-1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'mutated' }],
          isError: false,
        },
      },
      ctx,
    );

    ctx.sessionManager.getLeafId = () => 'assistant-3';
    await expect(
      toolCall!({ toolName: 'read', toolCallId: 'read-2', input: { path: 'a.ts' } }, ctx),
    ).resolves.toBeUndefined();
  });

  test('turns an adjacent cacheable duplicate into a same-turn no-op result', async () => {
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
      reason: 'Deduped: duplicate tool call skipped.',
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
          text: 'Deduped: duplicate tool call skipped.',
        },
      ],
      details: {
        existing: true,
        toolCallRewrite: {
          deduped: true,
          matchingToolCallId: 'call-1',
          reason: 'same-turn-duplicate',
        },
      },
      isError: true,
    });
  });
});
