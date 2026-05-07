import { beforeEach, describe, expect, test, vi } from 'vitest';
import { CustomEditor } from '@earendil-works/pi-coding-agent';

import {
  clearEditorBehaviors,
  getEditorBehaviors,
  installGlobalEditorBehaviorPatches,
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

  test('wrapped default editor preserves CustomEditor app keybindings', async () => {
    const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
        handlers.set(event, handler);
      },
    };
    const copiedAppClear = vi.fn();
    const setEditorComponent = vi.fn();
    const keybindings = {
      matches: (data: string, action: string) => data === '\x03' && action === 'app.clear',
    };

    registerExtensionEditorBehavior(pi as any, { id: 'managed-behavior' });

    await handlers.get('session_start')?.(
      { type: 'session_start' },
      {
        hasUI: true,
        ui: {
          getEditorComponent: () => undefined,
          setEditorComponent,
        },
      },
    );

    const factory = setEditorComponent.mock.calls[0]?.[0];
    expect(factory).toBeTypeOf('function');
    const editor = factory(
      {} as any,
      { borderColor: (value: string) => value, selectList: {} as any } as any,
      keybindings,
    );

    // Mirrors pi-coding-agent's setCustomEditorComponent behavior: it only copies
    // app handlers when the custom editor exposes CustomEditor's actionHandlers map.
    expect('actionHandlers' in editor).toBe(true);
    expect(editor.actionHandlers).toBeInstanceOf(Map);
    editor.actionHandlers.set('app.clear', copiedAppClear);

    editor.handleInput('\x03');

    expect(copiedAppClear).toHaveBeenCalledTimes(1);
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
