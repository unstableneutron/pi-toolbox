import { CustomEditor, type ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Editor, type AutocompleteProvider } from '@mariozechner/pi-tui';

const EDITOR_BEHAVIOR_BRIDGE_SYMBOL = Symbol.for('pi.editor-behavior-bridge');
const WRAPPED_PROVIDER_VERSION_SYMBOL = Symbol.for('pi.editor-behavior-bridge.wrapped-provider');
const BYPASS_INPUT_BEHAVIORS_SYMBOL = Symbol.for('pi.editor-behavior-bridge.bypass-input');

export type EditorLike = {
  state?: {
    lines?: readonly string[];
    cursorLine?: number;
    cursorCol?: number;
  };
  isShowingAutocomplete?: () => boolean;
  tryTriggerAutocomplete?: () => void;
};

export type EditorSnapshot = {
  lines: readonly string[];
  cursorLine: number;
  cursorCol: number;
  isShowingAutocomplete: boolean;
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
  wrapAutocompleteProvider?(provider: AutocompleteProvider): AutocompleteProvider;
};

type WrappedAutocompleteProvider = AutocompleteProvider & {
  [WRAPPED_PROVIDER_VERSION_SYMBOL]?: number;
};

type EditorWithBypassFlag = CustomEditor & {
  [BYPASS_INPUT_BEHAVIORS_SYMBOL]?: boolean;
};

type EditorBehaviorBridge = {
  registeredBehaviors: Map<string, { order: number; behavior: EditorBehavior }>;
  nextBehaviorOrder: number;
  behaviorVersion: number;
  globalEditorBehaviorPatchesInstalled: boolean;
  wrappedProviders: WeakMap<
    AutocompleteProvider,
    { version: number; provider: AutocompleteProvider }
  >;
};

function getEditorBehaviorBridge(): EditorBehaviorBridge {
  const globalScope = globalThis as typeof globalThis & {
    [EDITOR_BEHAVIOR_BRIDGE_SYMBOL]?: EditorBehaviorBridge;
  };

  if (!globalScope[EDITOR_BEHAVIOR_BRIDGE_SYMBOL]) {
    globalScope[EDITOR_BEHAVIOR_BRIDGE_SYMBOL] = {
      registeredBehaviors: new Map<string, { order: number; behavior: EditorBehavior }>(),
      nextBehaviorOrder: 0,
      behaviorVersion: 0,
      globalEditorBehaviorPatchesInstalled: false,
      wrappedProviders: new WeakMap<
        AutocompleteProvider,
        { version: number; provider: AutocompleteProvider }
      >(),
    };
  }

  return globalScope[EDITOR_BEHAVIOR_BRIDGE_SYMBOL]!;
}

function bumpBehaviorVersion(): void {
  getEditorBehaviorBridge().behaviorVersion += 1;
}

function markWrappedAutocompleteProvider(
  provider: AutocompleteProvider,
  version: number,
): AutocompleteProvider {
  (provider as WrappedAutocompleteProvider)[WRAPPED_PROVIDER_VERSION_SYMBOL] = version;
  return provider;
}

function isWrappedAutocompleteProviderCurrent(provider: AutocompleteProvider): boolean {
  return (
    (provider as WrappedAutocompleteProvider)[WRAPPED_PROVIDER_VERSION_SYMBOL] ===
    getEditorBehaviorBridge().behaviorVersion
  );
}

function getWrappedAutocompleteProvider(provider: AutocompleteProvider): AutocompleteProvider {
  if (getEditorBehaviors().length === 0) return provider;
  if (isWrappedAutocompleteProviderCurrent(provider)) return provider;

  const bridge = getEditorBehaviorBridge();

  const cached = bridge.wrappedProviders.get(provider);
  if (cached?.version === bridge.behaviorVersion) return cached.provider;

  const wrapped = markWrappedAutocompleteProvider(
    composeAutocompleteProvider(provider, getEditorBehaviors()),
    bridge.behaviorVersion,
  );
  bridge.wrappedProviders.set(provider, { version: bridge.behaviorVersion, provider: wrapped });
  return wrapped;
}

export function registerEditorBehavior(behavior: EditorBehavior): () => void {
  const bridge = getEditorBehaviorBridge();
  const existing = bridge.registeredBehaviors.get(behavior.id);
  bridge.registeredBehaviors.set(behavior.id, {
    order: existing?.order ?? bridge.nextBehaviorOrder++,
    behavior,
  });
  bumpBehaviorVersion();

  return () => {
    const current = bridge.registeredBehaviors.get(behavior.id);
    if (!current || current.behavior !== behavior) return;
    bridge.registeredBehaviors.delete(behavior.id);
    bumpBehaviorVersion();
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
  bumpBehaviorVersion();
}

export function installGlobalEditorBehaviorPatches(): void {
  const bridge = getEditorBehaviorBridge();
  if (bridge.globalEditorBehaviorPatchesInstalled) return;
  bridge.globalEditorBehaviorPatchesInstalled = true;

  // oxlint-disable-next-line typescript-eslint/unbound-method
  const originalSetAutocompleteProvider = Editor.prototype.setAutocompleteProvider;
  Editor.prototype.setAutocompleteProvider = function (provider: AutocompleteProvider): void {
    const nextProvider = getWrappedAutocompleteProvider(provider);
    originalSetAutocompleteProvider.call(this, nextProvider);
  };

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

export function readEditorSnapshot(editor: EditorLike | null | undefined): EditorSnapshot | null {
  if (!editor?.state?.lines) return null;
  return {
    lines: editor.state.lines.slice(),
    cursorLine: editor.state.cursorLine ?? 0,
    cursorCol: editor.state.cursorCol ?? 0,
    isShowingAutocomplete: Boolean(editor.isShowingAutocomplete?.()),
  };
}

export function requestEditorAutocomplete(editor: EditorLike | null | undefined): void {
  editor?.tryTriggerAutocomplete?.();
}

export function composeAutocompleteProvider(
  provider: AutocompleteProvider,
  behaviors: EditorBehavior[],
): AutocompleteProvider {
  return markWrappedAutocompleteProvider(
    behaviors.reduce(
      (current, behavior) => behavior.wrapAutocompleteProvider?.(current) ?? current,
      provider,
    ),
    getEditorBehaviorBridge().behaviorVersion,
  );
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

  override setAutocompleteProvider(provider: AutocompleteProvider) {
    super.setAutocompleteProvider(composeAutocompleteProvider(provider, this.behaviors));
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
