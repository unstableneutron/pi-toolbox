import { beforeEach, describe, expect, test, vi } from 'vitest';

import { clearEditorBehaviors, getEditorBehaviors } from '../shared/editor-behaviors';
import safeEscape, {
  type GuardConfig,
  type SafeEscapeBehaviorHooks,
  classifyStreamingMessage,
  clearExpiredEscPresses,
  createSafeEscapeBehavior,
  decideBusyState,
  formatWarningBar,
  formatWarningTextLine,
  isPlainEscapeInput,
  recordEscPress,
  reduceGuardEvent,
} from './safe-escape';

const config: GuardConfig = {
  warningTimeoutMs: 2000,
  escBypassCount: 3,
  escBypassWindowMs: 1200,
  escDebounceMs: 75,
  busyStaleResetMs: 5000,
};

beforeEach(() => {
  clearEditorBehaviors();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function withInteractiveTTY(run: () => Promise<void>) {
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

  try {
    await run();
  } finally {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalStdinIsTTY,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalStdoutIsTTY,
      configurable: true,
    });
  }
}

function createExtensionHarness() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
  const commands = new Map<string, (args: any, ctx: any) => Promise<void> | void>();
  const appendedEntries: Array<{ customType: string; data: Record<string, unknown> }> = [];
  const registerCommand = vi.fn(
    (name: string, command: { handler: (args: any, ctx: any) => Promise<void> | void }) => {
      commands.set(name, command.handler);
    },
  );
  let terminalInputHandler:
    | ((data: string) => { consume?: boolean; data?: string } | undefined)
    | undefined;

  const pi = {
    on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
      const existing = handlers.get(event);
      handlers.set(event, async (eventArg: any, ctx: any) => {
        await existing?.(eventArg, ctx);
        await handler(eventArg, ctx);
      });
    },
    appendEntry(customType: string, data: Record<string, unknown>) {
      appendedEntries.push({ customType, data });
    },
    registerCommand,
  };

  return {
    pi,
    handlers,
    commands,
    appendedEntries,
    registerCommand,
    setTerminalInputHandler(
      handler?: (data: string) => { consume?: boolean; data?: string } | undefined,
    ) {
      terminalInputHandler = handler;
    },
    getTerminalInputHandler() {
      return terminalInputHandler;
    },
  };
}

function getSafeEscapeBehavior() {
  const behavior = getEditorBehaviors().find((candidate) => candidate.id === 'safe-escape');
  expect(behavior).toBeDefined();
  return behavior!;
}

function createEditorLike() {
  return {
    state: { lines: [''], cursorLine: 0, cursorCol: 0 },
    isShowingAutocomplete: () => false,
    tryTriggerAutocomplete: vi.fn(),
  };
}

function createBehaviorHarness(overrides: Partial<SafeEscapeBehaviorHooks> = {}) {
  let timestamps = overrides.getTimestamps?.() ?? [];
  const hooks: SafeEscapeBehaviorHooks = {
    isBusy: () => false,
    isWarningVisible: () => false,
    getTimestamps: () => timestamps,
    setTimestamps: vi.fn((next: number[]) => {
      timestamps = next;
    }),
    onBusyEscape: vi.fn(),
    onWarningEscape: vi.fn(() => true),
    onWarningDismiss: vi.fn(),
    config,
    ...overrides,
  };

  return {
    hooks,
    behavior: createSafeEscapeBehavior(hooks),
    editor: createEditorLike(),
    getTimestamps: () => timestamps,
  };
}

describe('recordEscPress', () => {
  test('requires three presses inside the bypass window', () => {
    let presses: number[] = [];

    let result = recordEscPress(presses, 1000, config);
    presses = result.timestamps;
    expect(result.triggerInterrupt).toBe(false);

    result = recordEscPress(presses, 1300, config);
    presses = result.timestamps;
    expect(result.triggerInterrupt).toBe(false);

    result = recordEscPress(presses, 1800, config);
    expect(result.triggerInterrupt).toBe(true);
  });

  test('slow Esc presses do not form bypass sequence', () => {
    let presses: number[] = [];
    presses = recordEscPress(presses, 1000, config).timestamps;
    presses = recordEscPress(presses, 2500, config).timestamps;
    const result = recordEscPress(presses, 4000, config);
    expect(result.triggerInterrupt).toBe(false);
  });

  test('debounces near-duplicate presses', () => {
    let presses: number[] = [];
    presses = recordEscPress(presses, 1000, config).timestamps;
    const result = recordEscPress(presses, 1040, config);
    expect(result.timestamps).toEqual([1000]);
    expect(result.triggerInterrupt).toBe(false);
  });

  test('clearExpiredEscPresses drops timestamps outside the bypass window', () => {
    expect(clearExpiredEscPresses([1000, 1300, 2500], 3000, config)).toEqual([2500]);
  });
});

describe('message classification and busy precedence', () => {
  test('assistant classification ignores user and toolResult', () => {
    expect(classifyStreamingMessage('assistant')).toBe(true);
    expect(classifyStreamingMessage('user')).toBe(false);
    expect(classifyStreamingMessage('toolResult')).toBe(false);
  });

  test('busy precedence prefers hard busy and ambiguous cases guard', () => {
    expect(
      decideBusyState({
        activeToolCount: 1,
        assistantStreaming: false,
        hasPendingMessages: false,
        isIdle: true,
        lastActivityAt: 0,
        now: 10000,
        config,
      }),
    ).toBe('busy');

    expect(
      decideBusyState({
        activeToolCount: 0,
        assistantStreaming: false,
        hasPendingMessages: null,
        isIdle: null,
        lastActivityAt: 9800,
        now: 10000,
        config,
      }),
    ).toBe('busy');
  });

  test('soft busy beats idle ambiguity but explicit idle clears when no hard busy remains', () => {
    expect(
      decideBusyState({
        activeToolCount: 0,
        assistantStreaming: false,
        hasPendingMessages: true,
        isIdle: true,
        lastActivityAt: 0,
        now: 1000,
        config,
      }),
    ).toBe('busy');

    expect(
      decideBusyState({
        activeToolCount: 0,
        assistantStreaming: false,
        hasPendingMessages: false,
        isIdle: true,
        lastActivityAt: 0,
        now: 1000,
        config,
      }),
    ).toBe('idle');
  });

  test('stale recovery returns idle after quiet period', () => {
    expect(
      decideBusyState({
        activeToolCount: 0,
        assistantStreaming: false,
        hasPendingMessages: null,
        isIdle: null,
        lastActivityAt: 0,
        now: 6000,
        config,
      }),
    ).toBe('idle');
  });
});

describe('guard reducer', () => {
  test('dismiss preserves timestamps but timeout clears them', () => {
    const state = { warningVisible: true, timestamps: [1000, 1500] };
    expect(reduceGuardEvent(state as any, { type: 'dismiss' }).timestamps).toEqual([1000, 1500]);
    expect(reduceGuardEvent(state as any, { type: 'timeout' }).timestamps).toEqual([]);
  });

  test('confirm clears timestamps', () => {
    const state = { warningVisible: true, timestamps: [1000, 1500] };
    expect(reduceGuardEvent(state as any, { type: 'confirm' })).toEqual({
      warningVisible: false,
      timestamps: [],
    });
  });

  test('hard reset covers busy-end and session transition semantics', () => {
    const state = { warningVisible: true, timestamps: [1000, 1500] };
    expect(reduceGuardEvent(state as any, { type: 'hard-reset' })).toEqual({
      warningVisible: false,
      timestamps: [],
    });
  });
});

describe('createSafeEscapeBehavior', () => {
  test('returns the registered safe-escape behavior metadata', () => {
    const { behavior } = createBehaviorHarness();
    expect(behavior.id).toBe('safe-escape');
    expect(behavior.priority).toBe(10);
  });

  test('idle ESC falls through without consuming the key', () => {
    const { behavior, hooks, editor } = createBehaviorHarness({
      isBusy: () => false,
      isWarningVisible: () => false,
    });

    const consumed = behavior.beforeHandleInput?.('\x1b', editor);

    expect(consumed).toBe(false);
    expect(hooks.setTimestamps).not.toHaveBeenCalled();
    expect(hooks.onBusyEscape).not.toHaveBeenCalled();
    expect(hooks.onWarningDismiss).not.toHaveBeenCalled();
    expect(hooks.onWarningEscape).not.toHaveBeenCalled();
  });

  test('busy ESC consumes the key and opens warning flow', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { behavior, hooks, editor, getTimestamps } = createBehaviorHarness({
      isBusy: () => true,
      isWarningVisible: () => false,
    });

    const consumed = behavior.beforeHandleInput?.('\x1b', editor);

    expect(consumed).toBe(true);
    expect(hooks.setTimestamps).toHaveBeenCalledWith([1000]);
    expect(getTimestamps()).toEqual([1000]);
    expect(hooks.onBusyEscape).toHaveBeenCalledTimes(1);
    expect(hooks.onWarningDismiss).not.toHaveBeenCalled();
  });

  test('non-ESC input dismisses warning and falls through when warning is visible', () => {
    const { behavior, hooks, editor } = createBehaviorHarness({
      isWarningVisible: () => true,
    });

    const consumed = behavior.beforeHandleInput?.('a', editor);

    expect(consumed).toBe(false);
    expect(hooks.onWarningDismiss).toHaveBeenCalledTimes(1);
    expect(hooks.onWarningEscape).not.toHaveBeenCalled();
    expect(hooks.onBusyEscape).not.toHaveBeenCalled();
  });

  test('kitty Escape release is ignored without dismissing the warning', () => {
    const { behavior, hooks, editor } = createBehaviorHarness({
      isWarningVisible: () => true,
    });

    const consumed = behavior.beforeHandleInput?.('\x1b[27;1:3u', editor);

    expect(consumed).toBe(true);
    expect(hooks.onWarningDismiss).not.toHaveBeenCalled();
    expect(hooks.onWarningEscape).not.toHaveBeenCalled();
    expect(hooks.onBusyEscape).not.toHaveBeenCalled();
  });
});

describe('input parsing and warning rendering helpers', () => {
  test('composite escape-prefixed sequences do not count as plain Esc', () => {
    expect(isPlainEscapeInput('\x1b')).toBe(true);
    expect(isPlainEscapeInput('\x1b[A')).toBe(false);
    expect(isPlainEscapeInput('\x1b\r')).toBe(false);
  });

  test('terminal-encoded Escape still counts as Escape input', () => {
    expect(isPlainEscapeInput('\x1b[27;1;27~')).toBe(true);
    expect(isPlainEscapeInput('\x1b[27u')).toBe(true);
    expect(isPlainEscapeInput('\x1b[27;1u')).toBe(true);
  });

  test('kitty Escape release events do not count as plain Esc input', () => {
    expect(isPlainEscapeInput('\x1b[27;1:3u')).toBe(false);
    expect(isPlainEscapeInput('\x1b[27;1:2u')).toBe(false);
  });

  test('warning text line uses uppercase ESC and includes countdown', () => {
    expect(formatWarningTextLine('auto-dismisses in 2.9s', 120)).toBe(
      '⚠ Busy — press ESC ESC quickly to interrupt (auto-dismisses in 2.9s)',
    );
  });

  test('warning text line falls back to compact copy on narrow widths', () => {
    expect(formatWarningTextLine('2.9s', 34)).toBe('⚠ Busy — ESC ESC to interrupt (2.9s)');
  });

  test('warning bar shrinks from right to left', () => {
    expect(formatWarningBar(10, 1)).toBe('██████████');
    expect(formatWarningBar(10, 0.5)).toBe('█████░░░░░');
    expect(formatWarningBar(10, 0.1)).toBe('█░░░░░░░░░');
  });
});

describe('safeEscape extension registration', () => {
  test('registers a safe-escape behavior in the shared registry', () => {
    const { pi } = createExtensionHarness();

    safeEscape(pi as any);

    expect(getEditorBehaviors().map((behavior) => behavior.id)).toContain('safe-escape');
    expect(getSafeEscapeBehavior().priority).toBe(10);
  });

  test('session_start wraps the current editor component when the new API is available', async () => {
    await withInteractiveTTY(async () => {
      const { pi, handlers } = createExtensionHarness();
      const setEditorComponent = vi.fn();
      const getEditorComponent = vi.fn(() => undefined);

      safeEscape(pi as any);

      const ctx = {
        hasUI: true,
        isIdle: () => true,
        hasPendingMessages: () => false,
        abort: vi.fn(),
        ui: {
          notify: vi.fn(),
          setWidget: vi.fn(),
          setStatus: vi.fn(),
          setEditorComponent,
          getEditorComponent,
        },
      };

      await handlers.get('session_start')?.({}, ctx);

      expect(getEditorComponent).toHaveBeenCalledTimes(1);
      expect(setEditorComponent).toHaveBeenCalledWith(expect.any(Function));
    });
  });
});

describe('safeEscape integration through the registered behavior', () => {
  test('does not register a terminal input listener so focused overlays can handle ESC', async () => {
    await withInteractiveTTY(async () => {
      const harness = createExtensionHarness();
      const { pi, handlers } = harness;
      const onTerminalInput = vi.fn();

      safeEscape(pi as any);

      const ctx = {
        hasUI: true,
        isIdle: () => false,
        hasPendingMessages: () => false,
        abort: vi.fn(),
        ui: {
          notify: vi.fn(),
          setWidget: vi.fn(),
          setStatus: vi.fn(),
          setEditorComponent: vi.fn(),
          onTerminalInput,
        },
      };

      await handlers.get('session_start')?.({ type: 'session_start', reason: 'startup' }, ctx);

      expect(onTerminalInput).not.toHaveBeenCalled();
      expect(harness.getTerminalInputHandler()).toBeUndefined();
    });
  });

  test('does not register deprecated session_switch or session_fork handlers in 0.65+', async () => {
    await withInteractiveTTY(async () => {
      const { pi, handlers } = createExtensionHarness();

      safeEscape(pi as any);

      expect(handlers.has('session_switch')).toBe(false);
      expect(handlers.has('session_fork')).toBe(false);
    });
  });

  test('input event keeps ESC guarded immediately after submit', async () => {
    await withInteractiveTTY(async () => {
      const { pi, handlers } = createExtensionHarness();
      const setWidget = vi.fn();
      let idle = true;

      safeEscape(pi as any);

      const ctx = {
        hasUI: true,
        isIdle: () => idle,
        hasPendingMessages: () => false,
        abort: vi.fn(),
        ui: {
          notify: vi.fn(),
          setWidget,
          setStatus: vi.fn(),
          setEditorComponent: vi.fn(),
        },
      };

      await handlers.get('session_start')?.({ type: 'session_start', reason: 'startup' }, ctx);
      await handlers.get('input')?.(
        { type: 'input', text: 'Yo! Testing.', source: 'interactive' },
        ctx,
      );
      const consumed = getSafeEscapeBehavior().beforeHandleInput?.('\x1b', createEditorLike());

      expect(consumed).toBe(true);
      expect(setWidget).toHaveBeenCalled();
      expect(ctx.abort).not.toHaveBeenCalled();
    });
  });

  test('before_agent_start keeps ESC guarded immediately after submit', async () => {
    await withInteractiveTTY(async () => {
      const { pi, handlers } = createExtensionHarness();
      const setWidget = vi.fn();
      let idle = true;

      safeEscape(pi as any);

      const ctx = {
        hasUI: true,
        isIdle: () => idle,
        hasPendingMessages: () => false,
        abort: vi.fn(),
        ui: {
          notify: vi.fn(),
          setWidget,
          setStatus: vi.fn(),
          setEditorComponent: vi.fn(),
        },
      };

      await handlers.get('session_start')?.({}, ctx);
      await handlers.get('before_agent_start')?.(
        { type: 'before_agent_start', prompt: 'test', systemPrompt: '' },
        ctx,
      );
      const consumed = getSafeEscapeBehavior().beforeHandleInput?.('\x1b', createEditorLike());

      expect(consumed).toBe(true);
      expect(setWidget).toHaveBeenCalled();
      expect(ctx.abort).not.toHaveBeenCalled();
    });
  });

  test('agent_start keeps ESC guarded before assistant streaming begins', async () => {
    await withInteractiveTTY(async () => {
      const { pi, handlers } = createExtensionHarness();
      const setWidget = vi.fn();
      let idle = true;

      safeEscape(pi as any);

      const ctx = {
        hasUI: true,
        isIdle: () => idle,
        hasPendingMessages: () => false,
        abort: vi.fn(),
        ui: {
          notify: vi.fn(),
          setWidget,
          setStatus: vi.fn(),
          setEditorComponent: vi.fn(),
        },
      };

      await handlers.get('session_start')?.({}, ctx);
      await handlers.get('agent_start')?.({}, ctx);
      const consumed = getSafeEscapeBehavior().beforeHandleInput?.('\x1b', createEditorLike());

      expect(consumed).toBe(true);
      expect(setWidget).toHaveBeenCalled();
      expect(ctx.abort).not.toHaveBeenCalled();
    });
  });

  test('warning widget uses warning only for the label and muted/dim tones for the bar', async () => {
    await withInteractiveTTY(async () => {
      const { pi, handlers } = createExtensionHarness();
      const setWidget = vi.fn();

      safeEscape(pi as any);

      const ctx = {
        hasUI: true,
        isIdle: () => false,
        hasPendingMessages: () => false,
        abort: vi.fn(),
        ui: {
          notify: vi.fn(),
          setWidget,
          setStatus: vi.fn(),
          setEditorComponent: vi.fn(),
        },
      };

      await handlers.get('session_start')?.({}, ctx);
      getSafeEscapeBehavior().beforeHandleInput?.('\x1b', createEditorLike());

      const widgetFactory = setWidget.mock.calls.at(-1)?.[1];
      expect(widgetFactory).toBeTypeOf('function');

      const theme = {
        fg(tone: string, text: string) {
          return `<${tone}>${text}</${tone}>`;
        },
      };
      const widget = widgetFactory({}, theme);
      const [line1, line2] = widget.render(120);

      expect(line1).toContain('<warning>⚠ Busy</warning>');
      expect(line1).toContain('<text> — press ESC ESC quickly to interrupt');
      expect(line2).toContain('<muted>');
      expect(line2).toContain('<dim>');
    });
  });

  test('falls back to a status warning when widget setup throws', async () => {
    vi.useFakeTimers();
    await withInteractiveTTY(async () => {
      const { pi, handlers } = createExtensionHarness();
      const setStatus = vi.fn();
      const setWidget = vi.fn((key: string, content: unknown) => {
        if (content !== undefined) throw new Error('widget failed');
      });

      safeEscape(pi as any);

      const ctx = {
        hasUI: true,
        isIdle: () => false,
        hasPendingMessages: () => false,
        abort: vi.fn(),
        ui: {
          notify: vi.fn(),
          setWidget,
          setStatus,
          setEditorComponent: vi.fn(),
        },
      };

      await handlers.get('session_start')?.({}, ctx);
      getSafeEscapeBehavior().beforeHandleInput?.('\x1b', createEditorLike());

      expect(setStatus).toHaveBeenCalledWith(
        'safe-escape',
        expect.stringContaining('ESC ESC to interrupt'),
      );
    });
  });

  test('third ESC aborts only after the first warns and the second only arms', async () => {
    vi.useFakeTimers();
    await withInteractiveTTY(async () => {
      const { pi, handlers } = createExtensionHarness();
      const setWidget = vi.fn();
      const ctx = {
        hasUI: true,
        isIdle: () => false,
        hasPendingMessages: () => false,
        abort: vi.fn(),
        ui: {
          notify: vi.fn(),
          setWidget,
          setStatus: vi.fn(),
          setEditorComponent: vi.fn(),
        },
      };

      safeEscape(pi as any);

      await handlers.get('session_start')?.({}, ctx);
      const behavior = getSafeEscapeBehavior();
      const editor = createEditorLike();

      behavior.beforeHandleInput?.('\x1b', editor);
      setWidget.mockClear();

      vi.advanceTimersByTime(100);
      behavior.beforeHandleInput?.('\x1b', editor);
      expect(ctx.abort).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      behavior.beforeHandleInput?.('\x1b', editor);

      expect(ctx.abort).toHaveBeenCalledTimes(1);
      expect(setWidget).toHaveBeenCalledWith('safe-escape', undefined);
    });
  });

  test('warning times out after the default window', async () => {
    vi.useFakeTimers();
    await withInteractiveTTY(async () => {
      const { pi, handlers } = createExtensionHarness();
      const setWidget = vi.fn();
      const ctx = {
        hasUI: true,
        isIdle: () => false,
        hasPendingMessages: () => false,
        abort: vi.fn(),
        ui: {
          notify: vi.fn(),
          setWidget,
          setStatus: vi.fn(),
          setEditorComponent: vi.fn(),
        },
      };

      safeEscape(pi as any);

      await handlers.get('session_start')?.({}, ctx);
      const behavior = getSafeEscapeBehavior();
      behavior.beforeHandleInput?.('\x1b', createEditorLike());
      setWidget.mockClear();

      vi.advanceTimersByTime(2100);

      expect(setWidget).toHaveBeenCalledWith('safe-escape', undefined);
      expect(ctx.abort).not.toHaveBeenCalled();
    });
  });

  test('busy state clearing during warning tick removes the widget before timeout', async () => {
    vi.useFakeTimers();
    await withInteractiveTTY(async () => {
      const { pi, handlers } = createExtensionHarness();
      let idle = false;
      const setWidget = vi.fn();
      const ctx = {
        hasUI: true,
        isIdle: () => idle,
        hasPendingMessages: () => false,
        abort: vi.fn(),
        ui: {
          notify: vi.fn(),
          setWidget,
          setStatus: vi.fn(),
          setEditorComponent: vi.fn(),
        },
      };

      safeEscape(pi as any);

      await handlers.get('session_start')?.({}, ctx);
      const behavior = getSafeEscapeBehavior();
      behavior.beforeHandleInput?.('\x1b', createEditorLike());
      setWidget.mockClear();

      idle = true;
      vi.advanceTimersByTime(150);

      expect(setWidget).toHaveBeenCalledWith('safe-escape', undefined);
      expect(ctx.abort).not.toHaveBeenCalled();
    });
  });
});
