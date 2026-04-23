import { CustomEditor, type ExtensionAPI } from '@mariozechner/pi-coding-agent';

/**
 * Composable editor input-hook bridge.
 *
 * Extensions that need to intercept or observe raw editor keystrokes
 * register an {@link EditorBehavior}. The bridge patches
 * `CustomEditor.prototype.handleInput` once globally so hooks run for every
 * editor instance regardless of which extension constructs it, and exposes
 * `ComposedEditor` for callers that prefer an explicit subclass.
 *
 * Historically this module also stacked autocomplete providers by patching
 * `Editor.prototype.setAutocompleteProvider`. That path was removed once
 * pi-coding-agent 0.69.0 shipped `ctx.ui.addAutocompleteProvider`, which
 * already composes providers natively. Input interception still has no
 * official composable API, so this bridge remains.
 */

const EDITOR_BEHAVIOR_BRIDGE_SYMBOL = Symbol.for('pi.editor-behavior-bridge');
const BYPASS_INPUT_BEHAVIORS_SYMBOL = Symbol.for('pi.editor-behavior-bridge.bypass-input');

export type EditorLike = {
  state?: {
    lines?: readonly string[];
    cursorLine?: number;
    cursorCol?: number;
  };
};

export type EditorBehavior = {
  id: string;
  priority?: number;
  beforeHandleInput?(data: string, editor: EditorLike): boolean;
  afterHandleInput?(
    data: string,
    editor: EditorLike,
    meta: { wasShowingAutocomplete: boolean },
  ): void;
};

type EditorWithBypassFlag = CustomEditor & {
  [BYPASS_INPUT_BEHAVIORS_SYMBOL]?: boolean;
};

type EditorBehaviorBridge = {
  registeredBehaviors: Map<string, { order: number; behavior: EditorBehavior }>;
  nextBehaviorOrder: number;
  globalEditorBehaviorPatchesInstalled: boolean;
};

function getEditorBehaviorBridge(): EditorBehaviorBridge {
  const globalScope = globalThis as typeof globalThis & {
    [EDITOR_BEHAVIOR_BRIDGE_SYMBOL]?: EditorBehaviorBridge;
  };

  if (!globalScope[EDITOR_BEHAVIOR_BRIDGE_SYMBOL]) {
    globalScope[EDITOR_BEHAVIOR_BRIDGE_SYMBOL] = {
      registeredBehaviors: new Map<string, { order: number; behavior: EditorBehavior }>(),
      nextBehaviorOrder: 0,
      globalEditorBehaviorPatchesInstalled: false,
    };
  }

  return globalScope[EDITOR_BEHAVIOR_BRIDGE_SYMBOL]!;
}

export function registerEditorBehavior(behavior: EditorBehavior): () => void {
  const bridge = getEditorBehaviorBridge();
  const existing = bridge.registeredBehaviors.get(behavior.id);
  bridge.registeredBehaviors.set(behavior.id, {
    order: existing?.order ?? bridge.nextBehaviorOrder++,
    behavior,
  });

  return () => {
    const current = bridge.registeredBehaviors.get(behavior.id);
    if (!current || current.behavior !== behavior) return;
    bridge.registeredBehaviors.delete(behavior.id);
  };
}

export function getEditorBehaviors(): EditorBehavior[] {
  return [...getEditorBehaviorBridge().registeredBehaviors.values()]
    .sort(
      (a, b) => (a.behavior.priority ?? 100) - (b.behavior.priority ?? 100) || a.order - b.order,
    )
    .map((entry) => entry.behavior);
}

export function clearEditorBehaviors(): void {
  const bridge = getEditorBehaviorBridge();
  bridge.registeredBehaviors.clear();
  bridge.nextBehaviorOrder = 0;
}

export function installGlobalEditorBehaviorPatches(): void {
  const bridge = getEditorBehaviorBridge();
  if (bridge.globalEditorBehaviorPatchesInstalled) return;
  bridge.globalEditorBehaviorPatchesInstalled = true;

  // oxlint-disable-next-line typescript-eslint/unbound-method
  const originalHandleInput = CustomEditor.prototype.handleInput;
  CustomEditor.prototype.handleInput = function (data: string): void {
    if (
      (this as EditorWithBypassFlag)[BYPASS_INPUT_BEHAVIORS_SYMBOL] ||
      getEditorBehaviors().length === 0
    ) {
      originalHandleInput.call(this, data);
      return;
    }

    const editor = this as unknown as EditorLike;
    const behaviors = getEditorBehaviors();

    for (const behavior of behaviors) {
      if (behavior.beforeHandleInput?.(data, editor)) {
        return;
      }
    }

    const wasShowingAutocomplete = this.isShowingAutocomplete();
    originalHandleInput.call(this, data);

    for (const behavior of behaviors) {
      behavior.afterHandleInput?.(data, editor, { wasShowingAutocomplete });
    }
  };
}

export function registerExtensionEditorBehavior(
  pi: Pick<ExtensionAPI, 'on'>,
  behavior: EditorBehavior,
): () => void {
  installGlobalEditorBehaviorPatches();

  let unregister = registerEditorBehavior(behavior);
  let disposed = false;

  pi.on('session_shutdown', () => {
    if (disposed) return;
    disposed = true;
    unregister();
  });

  return () => {
    if (disposed) return;
    disposed = true;
    unregister();
  };
}

export class ComposedEditor extends CustomEditor {
  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    private behaviors: EditorBehavior[],
  ) {
    super(tui, theme, keybindings);
  }

  override handleInput(data: string): void {
    const editor = this as unknown as EditorLike;

    for (const behavior of this.behaviors) {
      if (behavior.beforeHandleInput?.(data, editor)) {
        return;
      }
    }

    const wasShowingAutocomplete = this.isShowingAutocomplete();
    const editorWithBypass = this as EditorWithBypassFlag;
    editorWithBypass[BYPASS_INPUT_BEHAVIORS_SYMBOL] = true;
    try {
      super.handleInput(data);
    } finally {
      delete editorWithBypass[BYPASS_INPUT_BEHAVIORS_SYMBOL];
    }

    for (const behavior of this.behaviors) {
      behavior.afterHandleInput?.(data, editor, { wasShowingAutocomplete });
    }
  }
}
