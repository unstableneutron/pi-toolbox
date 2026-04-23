import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AutocompleteProvider } from '@mariozechner/pi-tui';

import skillShortcut, {
  createSkillAutocompleteProvider,
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

function createExtensionHarness() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
  const addAutocompleteProvider = vi.fn();
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
      addAutocompleteProvider,
      setEditorComponent,
    },
  };

  return {
    pi,
    ctx,
    handlers,
    addAutocompleteProvider,
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

describe('createSkillAutocompleteProvider', () => {
  function createDelegatingProvider(
    suggestions: Awaited<ReturnType<AutocompleteProvider['getSuggestions']>> = null,
  ): AutocompleteProvider & {
    getSuggestions: ReturnType<typeof vi.fn>;
    applyCompletion: ReturnType<typeof vi.fn>;
  } {
    return {
      getSuggestions: vi.fn(async () => suggestions),
      applyCompletion: vi.fn((lines: string[]) => ({ lines, cursorLine: 0, cursorCol: 0 })),
    };
  }

  test('returns skill suggestions for $ prefixes instead of delegating', async () => {
    const current = createDelegatingProvider();
    const provider = createSkillAutocompleteProvider(current, () => [
      { name: 'agent-browser', description: 'Open browser tooling' },
      { name: 'systematic-debugging', description: 'Debug rigorously' },
    ]);

    const result = await provider.getSuggestions(
      ['Use $agent'],
      0,
      'Use $agent'.length,
      createAutocompleteOptions(),
    );

    expect(result?.prefix).toBe('$agent');
    expect(result?.items.map((item) => item.value)).toContain('agent-browser');
    expect(current.getSuggestions).not.toHaveBeenCalled();
  });

  test('delegates getSuggestions for non-$ prefixes', async () => {
    const delegated = { items: [{ value: 'fallback', label: 'fallback' }], prefix: 'agent' };
    const current = createDelegatingProvider(delegated);
    const provider = createSkillAutocompleteProvider(current, () => [{ name: 'agent-browser' }]);

    const result = await provider.getSuggestions(
      ['Use agent'],
      0,
      'Use agent'.length,
      createAutocompleteOptions(),
    );

    expect(result).toBe(delegated);
    expect(current.getSuggestions).toHaveBeenCalledTimes(1);
  });

  test('delegates when $ token has no fuzzy matches so the built-in provider can try', async () => {
    const delegated = { items: [{ value: 'other', label: 'other' }], prefix: '$nope' };
    const current = createDelegatingProvider(delegated);
    const provider = createSkillAutocompleteProvider(current, () => [{ name: 'agent-browser' }]);

    const result = await provider.getSuggestions(
      ['Use $nope'],
      0,
      'Use $nope'.length,
      createAutocompleteOptions(),
    );

    expect(result).toBe(delegated);
    expect(current.getSuggestions).toHaveBeenCalledTimes(1);
  });

  test('delegates applyCompletion for non-$ prefixes', () => {
    const delegated = { lines: ['Use fallback'], cursorLine: 0, cursorCol: 12 };
    const current = {
      getSuggestions: vi.fn(async () => null),
      applyCompletion: vi.fn(() => delegated),
    } satisfies AutocompleteProvider & { applyCompletion: ReturnType<typeof vi.fn> };
    const provider = createSkillAutocompleteProvider(current, () => [{ name: 'agent-browser' }]);

    const item = { value: 'fallback', label: 'fallback' };
    const result = provider.applyCompletion(['Use agent'], 0, 'Use agent'.length, item, 'agent');

    expect(result).toBe(delegated);
    expect(current.applyCompletion).toHaveBeenCalledWith(
      ['Use agent'],
      0,
      'Use agent'.length,
      item,
      'agent',
    );
  });

  test('$ applyCompletion preserves text after the cursor', () => {
    const current = createDelegatingProvider();
    const provider = createSkillAutocompleteProvider(current, () => [{ name: 'agent-browser' }]);

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
      const current = createDelegatingProvider(delegated);
      const provider = createSkillAutocompleteProvider(current, () => [{ name: 'agent-browser' }]);

      const result = await provider.getSuggestions(
        [`Use ${token}`],
        0,
        `Use ${token}`.length,
        createAutocompleteOptions(),
      );

      expect(result).toBe(delegated);
      expect(current.getSuggestions).toHaveBeenCalledTimes(1);
    },
  );

  test('delegates applyCompletion for invalid $ prefixes', () => {
    const delegated = { lines: ['Use delegated'], cursorLine: 0, cursorCol: 13 };
    const current = {
      getSuggestions: vi.fn(async () => null),
      applyCompletion: vi.fn(() => delegated),
    } satisfies AutocompleteProvider & { applyCompletion: ReturnType<typeof vi.fn> };
    const provider = createSkillAutocompleteProvider(current, () => [{ name: 'agent-browser' }]);

    const item = { value: 'fallback', label: 'fallback' };
    const result = provider.applyCompletion(['Use $Foo'], 0, 'Use $Foo'.length, item, '$Foo');

    expect(result).toBe(delegated);
    expect(current.applyCompletion).toHaveBeenCalledWith(
      ['Use $Foo'],
      0,
      'Use $Foo'.length,
      item,
      '$Foo',
    );
  });

  test('shouldTriggerFileCompletion delegates to current provider', () => {
    const shouldTrigger = vi.fn(() => false);
    const current: AutocompleteProvider = {
      async getSuggestions() {
        return null;
      },
      applyCompletion(lines) {
        return { lines, cursorLine: 0, cursorCol: 0 };
      },
      shouldTriggerFileCompletion: shouldTrigger,
    };
    const provider = createSkillAutocompleteProvider(current, () => []);

    expect(provider.shouldTriggerFileCompletion?.([''], 0, 0)).toBe(false);
    expect(shouldTrigger).toHaveBeenCalledWith([''], 0, 0);
  });
});

describe('extension registration', () => {
  test('session_start installs exactly one autocomplete provider', async () => {
    const harness = createExtensionHarness();

    skillShortcut(harness.pi as any);
    await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);

    expect(harness.addAutocompleteProvider).toHaveBeenCalledTimes(1);
  });

  test('session_start does not install a custom editor component', async () => {
    const harness = createExtensionHarness();

    skillShortcut(harness.pi as any);
    await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);

    expect(harness.setEditorComponent).not.toHaveBeenCalled();
  });

  test('skill-shortcut no longer registers anything in the editor-behavior bridge', async () => {
    const harness = createExtensionHarness();

    skillShortcut(harness.pi as any);
    await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);

    expect(getEditorBehaviors()).toEqual([]);
  });

  test('safe-escape remains the only editor-behavior registrar after both load', async () => {
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

    expect(getEditorBehaviors().map((behavior) => behavior.id)).toEqual(['safe-escape']);
  });

  test('wired provider returns skill suggestions when session_start runs', async () => {
    const harness = createExtensionHarness();
    skillShortcut(harness.pi as any);
    await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);

    const builder = harness.addAutocompleteProvider.mock.calls[0]?.[0] as (
      current: AutocompleteProvider,
    ) => AutocompleteProvider;
    expect(builder).toBeTypeOf('function');

    const current: AutocompleteProvider = {
      async getSuggestions() {
        return null;
      },
      applyCompletion(lines) {
        return { lines, cursorLine: 0, cursorCol: 0 };
      },
    };
    const provider = builder(current);

    const result = await provider.getSuggestions(
      ['$agent'],
      0,
      '$agent'.length,
      createAutocompleteOptions(),
    );

    expect(result?.items.map((item) => item.value)).toEqual(['agent-browser']);
  });

  test('input handler transforms only loaded skill shortcuts', async () => {
    const harness = createExtensionHarness();

    skillShortcut(harness.pi as any);
    await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);

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
