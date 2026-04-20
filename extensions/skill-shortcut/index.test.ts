import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AutocompleteProvider } from '@mariozechner/pi-tui';

import skillShortcut, {
  createSkillShortcutBehavior,
  extractDollarPrefix,
  transformSkillShortcutInput,
} from './index';
import { clearEditorBehaviors, getEditorBehaviors } from '../shared/editor-behaviors';
import safeEscape from '../safe-escape/safe-escape';

beforeEach(() => {
  clearEditorBehaviors();
  vi.restoreAllMocks();
});

function createAutocompleteOptions() {
  return { signal: new AbortController().signal };
}

function requireWrappedProvider(
  behavior: ReturnType<typeof createSkillShortcutBehavior>,
  fallbackProvider: AutocompleteProvider,
): AutocompleteProvider {
  const provider = behavior.wrapAutocompleteProvider?.(fallbackProvider);
  expect(provider).toBeDefined();
  return provider as AutocompleteProvider;
}

function createExtensionHarness() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
  const setEditorComponent = vi.fn();

  const pi = {
    on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
      handlers.set(event, handler);
    },
    getCommands() {
      return [
        {
          source: 'skill',
          name: 'skill:agent-browser',
          description: 'Open browser tooling',
        },
      ];
    },
  };

  const ctx = {
    ui: {
      setEditorComponent,
    },
  };

  return {
    pi,
    ctx,
    handlers,
    setEditorComponent,
  };
}

describe('skill-shortcut helpers', () => {
  test('extracts a $ token at start of line or after whitespace', () => {
    expect(extractDollarPrefix('$aut')).toBe('$aut');
    expect(extractDollarPrefix('hello $aut')).toBe('$aut');
    expect(extractDollarPrefix('hello($aut')).toBeNull();
  });

  test('transforms only known skill tokens into /skill commands', () => {
    expect(transformSkillShortcutInput('Use $agent-browser now', ['agent-browser'])).toBe(
      'Use /skill:agent-browser now',
    );
    expect(transformSkillShortcutInput('Use $missing now', ['agent-browser'])).toBe(
      'Use $missing now',
    );
  });

  test('preserves surrounding whitespace when transforming known skill tokens', () => {
    expect(transformSkillShortcutInput('  use $agent-browser now  ', ['agent-browser'])).toBe(
      '  use /skill:agent-browser now  ',
    );
  });
});

describe('afterHandleInput', () => {
  test('requests autocomplete when cursor is inside a $ token', () => {
    const tryTriggerAutocomplete = vi.fn();
    const behavior = createSkillShortcutBehavior(() => [
      { name: 'agent-browser', description: 'Open browser tooling' },
    ]);

    behavior.afterHandleInput?.(
      't',
      {
        state: { lines: ['$aut'], cursorLine: 0, cursorCol: 4 },
        isShowingAutocomplete: () => false,
        tryTriggerAutocomplete,
      },
      { wasShowingAutocomplete: false },
    );

    expect(tryTriggerAutocomplete).toHaveBeenCalled();
  });

  test('does not trigger when autocomplete was already showing', () => {
    const tryTriggerAutocomplete = vi.fn();
    const behavior = createSkillShortcutBehavior(() => [
      { name: 'agent-browser', description: 'Open browser tooling' },
    ]);

    behavior.afterHandleInput?.(
      't',
      {
        state: { lines: ['$aut'], cursorLine: 0, cursorCol: 4 },
        isShowingAutocomplete: () => true,
        tryTriggerAutocomplete,
      },
      { wasShowingAutocomplete: true },
    );

    expect(tryTriggerAutocomplete).not.toHaveBeenCalled();
  });

  test('ignores non-printable input like escape', () => {
    const tryTriggerAutocomplete = vi.fn();
    const behavior = createSkillShortcutBehavior(() => [
      { name: 'agent-browser', description: 'Open browser tooling' },
    ]);

    behavior.afterHandleInput?.(
      '\x1b',
      {
        state: { lines: ['$aut'], cursorLine: 0, cursorCol: 4 },
        isShowingAutocomplete: () => false,
        tryTriggerAutocomplete,
      },
      { wasShowingAutocomplete: false },
    );

    expect(tryTriggerAutocomplete).not.toHaveBeenCalled();
  });

  test.each(['$Foo', '$name.'])('ignores invalid potential skill tokens like %s', (token) => {
    const tryTriggerAutocomplete = vi.fn();
    const behavior = createSkillShortcutBehavior(() => [
      { name: 'agent-browser', description: 'Open browser tooling' },
    ]);

    behavior.afterHandleInput?.(
      't',
      {
        state: { lines: [`Use ${token}`], cursorLine: 0, cursorCol: `Use ${token}`.length },
        isShowingAutocomplete: () => false,
        tryTriggerAutocomplete,
      },
      { wasShowingAutocomplete: false },
    );

    expect(tryTriggerAutocomplete).not.toHaveBeenCalled();
  });
});

describe('autocomplete wrapper', () => {
  test('returns skill suggestions for $ prefixes before delegating', async () => {
    const behavior = createSkillShortcutBehavior(() => [
      { name: 'agent-browser', description: 'Open browser tooling' },
      { name: 'systematic-debugging', description: 'Debug rigorously' },
    ]);

    const fallbackProvider = {
      getSuggestions: vi.fn(async () => null),
      applyCompletion(lines: string[]) {
        return { lines, cursorLine: 0, cursorCol: 0 };
      },
    };

    const provider = requireWrappedProvider(behavior, fallbackProvider);
    const result = await provider.getSuggestions(
      ['Use $agent'],
      0,
      'Use $agent'.length,
      createAutocompleteOptions(),
    );

    expect(result?.prefix).toBe('$agent');
    expect(result?.items.map((item) => item.value)).toContain('agent-browser');
    expect(fallbackProvider.getSuggestions).not.toHaveBeenCalled();
  });

  test('delegates getSuggestions for non-$ prefixes', async () => {
    const delegated = { items: [{ value: 'fallback', label: 'fallback' }], prefix: 'agent' };
    const behavior = createSkillShortcutBehavior(() => [{ name: 'agent-browser' }]);
    const fallbackProvider = {
      getSuggestions: vi.fn(async () => delegated),
      applyCompletion(lines: string[]) {
        return { lines, cursorLine: 0, cursorCol: 0 };
      },
    };

    const provider = requireWrappedProvider(behavior, fallbackProvider);
    const result = await provider.getSuggestions(
      ['Use agent'],
      0,
      'Use agent'.length,
      createAutocompleteOptions(),
    );

    expect(result).toBe(delegated);
    expect(fallbackProvider.getSuggestions).toHaveBeenCalledTimes(1);
  });

  test('delegates applyCompletion for non-$ prefixes', () => {
    const delegated = { lines: ['Use fallback'], cursorLine: 0, cursorCol: 12 };
    const behavior = createSkillShortcutBehavior(() => [{ name: 'agent-browser' }]);
    const fallbackProvider = {
      getSuggestions: vi.fn(async () => null),
      applyCompletion: vi.fn(() => delegated),
    };

    const provider = requireWrappedProvider(behavior, fallbackProvider);
    const item = { value: 'fallback', label: 'fallback' };
    const result = provider.applyCompletion(['Use agent'], 0, 'Use agent'.length, item, 'agent');

    expect(result).toBe(delegated);
    expect(fallbackProvider.applyCompletion).toHaveBeenCalledWith(
      ['Use agent'],
      0,
      'Use agent'.length,
      item,
      'agent',
    );
  });

  test('$ applyCompletion preserves text after the cursor', () => {
    const behavior = createSkillShortcutBehavior(() => [{ name: 'agent-browser' }]);
    const fallbackProvider = {
      getSuggestions: vi.fn(async () => null),
      applyCompletion(lines: string[]) {
        return { lines, cursorLine: 0, cursorCol: 0 };
      },
    };

    const provider = requireWrappedProvider(behavior, fallbackProvider);
    const result = provider.applyCompletion(
      ['Use $ag now'],
      0,
      'Use $ag'.length,
      { value: 'agent-browser', label: 'agent-browser' },
      '$ag',
    );

    expect(result.lines).toEqual(['Use $agent-browser now']);
    expect(result.cursorCol).toBe('Use $agent-browser'.length);
  });

  test.each(['$Foo', '$name.'])(
    'invalid tokens like %s do not trigger suggestions',
    async (token) => {
      const delegated = { items: [{ value: 'fallback', label: 'fallback' }], prefix: token };
      const behavior = createSkillShortcutBehavior(() => [{ name: 'agent-browser' }]);
      const fallbackProvider = {
        getSuggestions: vi.fn(async () => delegated),
        applyCompletion(lines: string[]) {
          return { lines, cursorLine: 0, cursorCol: 0 };
        },
      };

      const provider = requireWrappedProvider(behavior, fallbackProvider);
      const result = await provider.getSuggestions(
        [`Use ${token}`],
        0,
        `Use ${token}`.length,
        createAutocompleteOptions(),
      );

      expect(result).toBe(delegated);
      expect(fallbackProvider.getSuggestions).toHaveBeenCalledTimes(1);
    },
  );

  test('delegates applyCompletion for invalid $ prefixes', () => {
    const delegated = { lines: ['Use delegated'], cursorLine: 0, cursorCol: 13 };
    const behavior = createSkillShortcutBehavior(() => [{ name: 'agent-browser' }]);
    const fallbackProvider = {
      getSuggestions: vi.fn(async () => null),
      applyCompletion: vi.fn(() => delegated),
    };

    const provider = requireWrappedProvider(behavior, fallbackProvider);
    const item = { value: 'fallback', label: 'fallback' };
    const result = provider.applyCompletion(['Use $Foo'], 0, 'Use $Foo'.length, item, '$Foo');

    expect(result).toBe(delegated);
    expect(fallbackProvider.applyCompletion).toHaveBeenCalledWith(
      ['Use $Foo'],
      0,
      'Use $Foo'.length,
      item,
      '$Foo',
    );
  });
});

describe('extension registration', () => {
  test('skillShortcut registers one skill-shortcut behavior', () => {
    const harness = createExtensionHarness();

    skillShortcut(harness.pi as any);

    expect(getEditorBehaviors()).toHaveLength(1);
    expect(getEditorBehaviors()[0]?.id).toBe('skill-shortcut');
  });

  test('calling skillShortcut twice does not create duplicates in the shared registry', () => {
    const firstHarness = createExtensionHarness();
    const secondHarness = createExtensionHarness();

    skillShortcut(firstHarness.pi as any);
    skillShortcut(secondHarness.pi as any);

    expect(getEditorBehaviors()).toHaveLength(1);
    expect(getEditorBehaviors()[0]?.id).toBe('skill-shortcut');
  });

  test('safe-escape and skill-shortcut register compatible behaviors', () => {
    clearEditorBehaviors();

    const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
        handlers.set(event, handler);
      },
      registerCommand: vi.fn(),
      getCommands() {
        return [
          {
            source: 'skill',
            name: 'skill:agent-browser',
            description: 'Open browser tooling',
          },
        ];
      },
    };

    safeEscape(pi as any);
    skillShortcut(pi as any);

    expect(getEditorBehaviors().map((behavior) => behavior.id)).toEqual([
      'safe-escape',
      'skill-shortcut',
    ]);
  });

  test('safe-escape and skill-shortcut do not compete for editor ownership', async () => {
    clearEditorBehaviors();

    const originalStdinIsTTY = process.stdin.isTTY;
    const originalStdoutIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
    const setEditorComponent = vi.fn();

    try {
      const pi = {
        on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
          handlers.set(`${event}:${handlers.size}`, handler);
        },
        registerCommand: vi.fn(),
        getCommands() {
          return [
            {
              source: 'skill',
              name: 'skill:agent-browser',
              description: 'Open browser tooling',
            },
          ];
        },
      };

      safeEscape(pi as any);
      skillShortcut(pi as any);

      const ctx = {
        hasUI: true,
        isIdle: () => false,
        hasPendingMessages: () => false,
        abort: vi.fn(),
        ui: {
          setWidget: vi.fn(),
          setStatus: vi.fn(),
          notify: vi.fn(),
          setEditorComponent,
        },
      };

      for (const [key, handler] of handlers) {
        if (key.startsWith('session_start')) {
          await handler({ type: 'session_start' }, ctx as any);
        }
      }
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

    expect(setEditorComponent).not.toHaveBeenCalled();
  });

  test('session_start no longer installs a custom editor component', async () => {
    const harness = createExtensionHarness();

    skillShortcut(harness.pi as any);
    await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);

    expect(harness.setEditorComponent).not.toHaveBeenCalled();
  });

  test('input handler transforms only loaded skill shortcuts', async () => {
    const harness = createExtensionHarness();

    skillShortcut(harness.pi as any);
    await harness.handlers.get('session_start')?.({}, harness.ctx as any);

    const inputHandler = harness.handlers.get('input');

    expect(inputHandler?.({ text: 'use $agent-browser now' }, harness.ctx as any)).toEqual({
      action: 'transform',
      text: 'use /skill:agent-browser now',
    });
    expect(inputHandler?.({ text: 'use $missing now' }, harness.ctx as any)).toEqual({
      action: 'continue',
    });
  });
});
