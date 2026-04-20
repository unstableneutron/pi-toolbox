import { beforeEach, describe, expect, test, vi } from 'vitest';
import { CustomEditor } from '@mariozechner/pi-coding-agent';
import type { AutocompleteProvider } from '@mariozechner/pi-tui';

import {
  clearEditorBehaviors,
  composeAutocompleteProvider,
  getEditorBehaviors,
  installGlobalEditorBehaviorPatches,
  readEditorSnapshot,
  registerEditorBehavior,
  registerExtensionEditorBehavior,
  ComposedEditor,
} from './editor-behaviors';

type EditorBehaviorsModule = typeof import('./editor-behaviors');

beforeEach(() => {
  installGlobalEditorBehaviorPatches();
  clearEditorBehaviors();
  vi.restoreAllMocks();
});

function createEditor(behaviors = getEditorBehaviors()) {
  return new ComposedEditor(
    {} as any,
    { borderColor: (value: string) => value, selectList: {} as any } as any,
    { matches: () => false } as any,
    behaviors,
  );
}

async function importFreshEditorBehaviorsModule(): Promise<EditorBehaviorsModule> {
  vi.resetModules();
  return import('./editor-behaviors') as Promise<EditorBehaviorsModule>;
}

describe('editor behavior registry', () => {
  test('sorts by ascending priority and preserves insertion order for ties', () => {
    registerEditorBehavior({ id: 'late', priority: 20 });
    registerEditorBehavior({ id: 'early', priority: 10 });
    registerEditorBehavior({ id: 'same-priority-a', priority: 10 });

    expect(getEditorBehaviors().map((behavior) => behavior.id)).toEqual([
      'early',
      'same-priority-a',
      'late',
    ]);
  });

  test('re-registering the same id replaces behavior instead of duplicating it', () => {
    registerEditorBehavior({ id: 'safe-escape', priority: 10 });
    registerEditorBehavior({ id: 'safe-escape', priority: 5 });

    expect(getEditorBehaviors()).toHaveLength(1);
    expect(getEditorBehaviors()[0]?.priority).toBe(5);
  });

  test('unregister removes only the behavior from that registration', () => {
    const unregisterLate = registerEditorBehavior({ id: 'late', priority: 20 });
    const unregisterEarly = registerEditorBehavior({ id: 'early', priority: 10 });

    unregisterLate();

    expect(getEditorBehaviors().map((behavior) => behavior.id)).toEqual(['early']);

    unregisterEarly();

    expect(getEditorBehaviors()).toEqual([]);
  });
});

test('wraps autocomplete providers in behavior order', async () => {
  const calls: string[] = [];
  const baseProvider: AutocompleteProvider = {
    async getSuggestions() {
      calls.push('base');
      return { items: [], prefix: '' };
    },
    applyCompletion(lines: string[]) {
      return { lines, cursorLine: 0, cursorCol: 0 };
    },
  };

  registerEditorBehavior({
    id: 'a',
    priority: 10,
    wrapAutocompleteProvider(provider) {
      return {
        ...provider,
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          calls.push('a-before');
          return provider.getSuggestions(lines, cursorLine, cursorCol, options);
        },
      };
    },
  });

  registerEditorBehavior({
    id: 'b',
    priority: 20,
    wrapAutocompleteProvider(provider) {
      return {
        ...provider,
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          calls.push('b-before');
          return provider.getSuggestions(lines, cursorLine, cursorCol, options);
        },
      };
    },
  });

  const wrapped = composeAutocompleteProvider(baseProvider, getEditorBehaviors());
  await wrapped.getSuggestions([''], 0, 0, { signal: new AbortController().signal });

  expect(calls).toEqual(['b-before', 'a-before', 'base']);
});

describe('ComposedEditor', () => {
  test('beforeHandleInput hooks can consume the key before super.handleInput', () => {
    const calls: string[] = [];
    const superHandleInput = vi
      .spyOn(CustomEditor.prototype, 'handleInput')
      .mockImplementation(function (this: CustomEditor, data: string) {
        calls.push(`super:${data}`);
      });

    const editor = createEditor([
      {
        id: 'consume-escape',
        beforeHandleInput(data) {
          calls.push(`before:${data}`);
          return true;
        },
        afterHandleInput() {
          calls.push('after');
        },
      },
    ]);

    editor.handleInput('x');

    expect(calls).toEqual(['before:x']);
    expect(superHandleInput).not.toHaveBeenCalled();
  });

  test('afterHandleInput hooks run after super.handleInput and receive { wasShowingAutocomplete }', () => {
    const calls: string[] = [];
    vi.spyOn(CustomEditor.prototype, 'handleInput').mockImplementation(function (
      this: CustomEditor,
      data: string,
    ) {
      calls.push(`super:${data}`);
    });
    vi.spyOn(CustomEditor.prototype, 'isShowingAutocomplete').mockReturnValue(true);

    const editor = createEditor([
      {
        id: 'after-hook',
        afterHandleInput(_data, _editor, meta) {
          calls.push(`after:${meta.wasShowingAutocomplete}`);
        },
      },
    ]);

    editor.handleInput('y');

    expect(calls).toEqual(['super:y', 'after:true']);
  });

  test('setAutocompleteProvider composes wrappers through registered behaviors', async () => {
    const calls: string[] = [];
    const editor = createEditor([
      {
        id: 'a',
        priority: 10,
        wrapAutocompleteProvider(provider) {
          return {
            ...provider,
            async getSuggestions(lines, cursorLine, cursorCol, options) {
              calls.push('a-before');
              return provider.getSuggestions(lines, cursorLine, cursorCol, options);
            },
          };
        },
      },
      {
        id: 'b',
        priority: 20,
        wrapAutocompleteProvider(provider) {
          return {
            ...provider,
            async getSuggestions(lines, cursorLine, cursorCol, options) {
              calls.push('b-before');
              return provider.getSuggestions(lines, cursorLine, cursorCol, options);
            },
          };
        },
      },
    ]);

    const setAutocompleteProvider = vi
      .spyOn(CustomEditor.prototype, 'setAutocompleteProvider')
      .mockImplementation(function (this: CustomEditor, provider) {
        void this;
        void provider;
      });

    const baseProvider: AutocompleteProvider = {
      async getSuggestions() {
        calls.push('base');
        return { items: [], prefix: '' };
      },
      applyCompletion(lines: string[]) {
        return { lines, cursorLine: 0, cursorCol: 0 };
      },
    };

    editor.setAutocompleteProvider(baseProvider as any);

    expect(setAutocompleteProvider).toHaveBeenCalledTimes(1);

    const composedProvider = setAutocompleteProvider.mock.calls[0]?.[0] as AutocompleteProvider;
    await composedProvider.getSuggestions([''], 0, 0, { signal: new AbortController().signal });

    expect(calls).toEqual(['b-before', 'a-before', 'base']);
  });
});

describe('global editor behavior patches', () => {
  test('share the same behavior bridge across isolated module copies', async () => {
    const primary = await importFreshEditorBehaviorsModule();
    const secondary = await importFreshEditorBehaviorsModule();

    primary.installGlobalEditorBehaviorPatches();
    primary.clearEditorBehaviors();

    primary.registerEditorBehavior({ id: 'from-primary', priority: 20 });
    secondary.registerEditorBehavior({ id: 'from-secondary', priority: 10 });

    expect(primary.getEditorBehaviors().map((behavior) => behavior.id)).toEqual([
      'from-secondary',
      'from-primary',
    ]);
    expect(secondary.getEditorBehaviors().map((behavior: { id: string }) => behavior.id)).toEqual([
      'from-secondary',
      'from-primary',
    ]);
  });

  test('can unregister behaviors across isolated module copies', async () => {
    const primary = await importFreshEditorBehaviorsModule();
    const secondary = await importFreshEditorBehaviorsModule();

    primary.installGlobalEditorBehaviorPatches();
    primary.clearEditorBehaviors();

    const unregisterPrimary = primary.registerEditorBehavior({ id: 'from-primary' });
    secondary.registerEditorBehavior({ id: 'from-secondary' });

    unregisterPrimary();

    expect(primary.getEditorBehaviors().map((behavior) => behavior.id)).toEqual(['from-secondary']);
    expect(secondary.getEditorBehaviors().map((behavior: { id: string }) => behavior.id)).toEqual([
      'from-secondary',
    ]);
  });

  test('avoid double-running hooks for ComposedEditor from another module copy', async () => {
    const primary = await importFreshEditorBehaviorsModule();
    const secondary = await importFreshEditorBehaviorsModule();

    primary.installGlobalEditorBehaviorPatches();
    primary.clearEditorBehaviors();

    const calls: string[] = [];
    secondary.registerEditorBehavior({
      id: 'cross-copy-hooks',
      beforeHandleInput(data: string) {
        calls.push(`before:${data}`);
        return false;
      },
      afterHandleInput(data: string) {
        calls.push(`after:${data}`);
      },
    });

    const editor = new secondary.ComposedEditor(
      {} as any,
      { borderColor: (value: string) => value, selectList: {} as any } as any,
      { matches: () => false } as any,
      secondary.getEditorBehaviors(),
    );

    editor.handleInput('x');

    expect(calls).toEqual(['before:x', 'after:x']);
  });

  test('avoid double-wrapping autocomplete for ComposedEditor from another module copy', async () => {
    const primary = await importFreshEditorBehaviorsModule();
    const secondary = await importFreshEditorBehaviorsModule();

    primary.installGlobalEditorBehaviorPatches();
    primary.clearEditorBehaviors();

    const calls: string[] = [];
    secondary.registerEditorBehavior({
      id: 'cross-copy-autocomplete',
      wrapAutocompleteProvider(provider: AutocompleteProvider) {
        return {
          ...provider,
          async getSuggestions(lines, cursorLine, cursorCol, options) {
            calls.push('behavior');
            return provider.getSuggestions(lines, cursorLine, cursorCol, options);
          },
        };
      },
    });

    const editor = new secondary.ComposedEditor(
      {} as any,
      { borderColor: (value: string) => value, selectList: {} as any } as any,
      { matches: () => false } as any,
      secondary.getEditorBehaviors(),
    );

    editor.setAutocompleteProvider({
      async getSuggestions() {
        calls.push('base');
        return { items: [], prefix: '' };
      },
      applyCompletion(lines: string[]) {
        return { lines, cursorLine: 0, cursorCol: 0 };
      },
    });

    await (editor as any).autocompleteProvider.getSuggestions([''], 0, 0, {
      signal: new AbortController().signal,
    });

    expect(calls).toEqual(['behavior', 'base']);
  });

  test('wrap autocomplete providers for plain CustomEditor instances', async () => {
    const calls: string[] = [];

    registerEditorBehavior({
      id: 'behavior-wrapper',
      wrapAutocompleteProvider(provider) {
        return {
          ...provider,
          async getSuggestions(lines, cursorLine, cursorCol, options) {
            calls.push('behavior');
            return provider.getSuggestions(lines, cursorLine, cursorCol, options);
          },
        };
      },
    });

    const editor = new CustomEditor(
      {} as any,
      { borderColor: (value: string) => value, selectList: {} as any } as any,
      { matches: () => false } as any,
    );

    const provider: AutocompleteProvider = {
      async getSuggestions() {
        calls.push('base');
        return { items: [], prefix: '' };
      },
      applyCompletion(lines: string[]) {
        return { lines, cursorLine: 0, cursorCol: 0 };
      },
    };

    editor.setAutocompleteProvider(provider);
    await (editor as any).autocompleteProvider.getSuggestions([''], 0, 0, {
      signal: new AbortController().signal,
    });

    expect(calls).toEqual(['behavior', 'base']);
  });

  test('compose around editor-owned provider wrappers like FffEditor', async () => {
    const calls: string[] = [];

    registerEditorBehavior({
      id: 'behavior-wrapper',
      wrapAutocompleteProvider(provider) {
        return {
          ...provider,
          async getSuggestions(lines, cursorLine, cursorCol, options) {
            calls.push('behavior');
            return provider.getSuggestions(lines, cursorLine, cursorCol, options);
          },
        };
      },
    });

    class ProviderWrappingEditor extends CustomEditor {
      override setAutocompleteProvider(provider: AutocompleteProvider) {
        super.setAutocompleteProvider({
          ...provider,
          async getSuggestions(lines, cursorLine, cursorCol, options) {
            calls.push('editor');
            return provider.getSuggestions(lines, cursorLine, cursorCol, options);
          },
        });
      }
    }

    const editor = new ProviderWrappingEditor(
      {} as any,
      { borderColor: (value: string) => value, selectList: {} as any } as any,
      { matches: () => false } as any,
    );

    const provider: AutocompleteProvider = {
      async getSuggestions() {
        calls.push('base');
        return { items: [], prefix: '' };
      },
      applyCompletion(lines: string[]) {
        return { lines, cursorLine: 0, cursorCol: 0 };
      },
    };

    editor.setAutocompleteProvider(provider);
    await (editor as any).autocompleteProvider.getSuggestions([''], 0, 0, {
      signal: new AbortController().signal,
    });

    expect(calls).toEqual(['behavior', 'editor', 'base']);
  });

  test('run input behaviors for plain CustomEditor instances', () => {
    const calls: string[] = [];

    registerEditorBehavior({
      id: 'input-hooks',
      beforeHandleInput(data) {
        calls.push(`before:${data}`);
        return false;
      },
      afterHandleInput(_data, _editor, meta) {
        calls.push(`after:${meta.wasShowingAutocomplete}`);
      },
    });

    const editor = new CustomEditor(
      {} as any,
      { borderColor: (value: string) => value, selectList: {} as any } as any,
      { matches: () => false } as any,
    );

    editor.handleInput('x');

    expect(calls).toEqual(['before:x', 'after:false']);
    expect(editor.getText()).toBe('x');
  });

  test('registerExtensionEditorBehavior unregisters on session shutdown', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
        handlers.set(event, handler);
      },
    };

    registerExtensionEditorBehavior(pi as any, { id: 'managed-behavior' });

    expect(getEditorBehaviors().map((behavior) => behavior.id)).toEqual(['managed-behavior']);

    await handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, {});

    expect(getEditorBehaviors()).toEqual([]);
  });
});

test('reads cursor snapshot from a duck-typed editor instance', () => {
  const lines = ['$sk'];
  const snapshot = readEditorSnapshot({
    state: { lines, cursorLine: 0, cursorCol: 3 },
    isShowingAutocomplete: () => false,
  });

  expect(snapshot).toEqual({
    lines: ['$sk'],
    cursorLine: 0,
    cursorCol: 3,
    isShowingAutocomplete: false,
  });
  expect(snapshot?.lines).not.toBe(lines);

  lines[0] = 'mutated';
  expect(snapshot?.lines).toEqual(['$sk']);
});
