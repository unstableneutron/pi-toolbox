import { afterEach, describe, expect, test, vi } from 'vitest';

import executeCommandExtension from './index';

type Handler = (event: any, ctx?: any) => Promise<void> | void;

function createHarness() {
  const handlers = new Map<string, Handler>();
  let tool: any;
  const emit = vi.fn();
  const pi = {
    events: { emit },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerTool(definition: any) {
      tool = definition;
    },
  } as any;

  executeCommandExtension(pi);

  return { emit, handlers, tool };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('execute-command extension', () => {
  test('does not emit a queued /answer after session shutdown', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const ctx = { hasUI: true };

    await harness.tool.execute('tool-1', { command: '/answer' }, undefined, undefined, ctx);
    await harness.handlers.get('agent_end')?.({ type: 'agent_end' }, ctx);
    await harness.handlers.get('session_shutdown')?.(
      { type: 'session_shutdown', reason: 'resume' },
      ctx,
    );

    vi.advanceTimersByTime(100);

    expect(harness.emit).not.toHaveBeenCalled();
  });
});
