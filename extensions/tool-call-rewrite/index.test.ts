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
});
