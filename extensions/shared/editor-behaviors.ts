import {
  CustomEditor,
  type AppKeybinding,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import type { EditorComponent } from '@earendil-works/pi-tui';

import { hasTui } from './ui-mode';

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
const WRAPPED_EDITOR_FACTORY_SYMBOL = Symbol.for('pi.editor-behavior-bridge.wrapped-factory');
const WRAPPED_EDITOR_COMPONENT_SYMBOL = Symbol.for('pi.editor-behavior-bridge.wrapped-component');

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

type EditorWithBypassFlag = EditorComponent & {
  [BYPASS_INPUT_BEHAVIORS_SYMBOL]?: boolean;
};

type EditorFactory = Parameters<ExtensionAPI['on']>[1] extends (
  event: any,
  ctx: infer Ctx,
) => unknown
  ? Ctx extends { ui: { getEditorComponent(): infer Factory } }
    ? NonNullable<Factory>
    : never
  : never;

type WrappedEditorFactory = EditorFactory & {
  [WRAPPED_EDITOR_FACTORY_SYMBOL]?: boolean;
};

type WrappedEditorComponent = EditorComponent & {
  [WRAPPED_EDITOR_COMPONENT_SYMBOL]?: boolean;
};

type CustomEditorAppKeybindingSurface = EditorComponent & {
  actionHandlers?: Map<AppKeybinding, () => void>;
  onAction?: (action: AppKeybinding, handler: () => void) => void;
  onEscape?: () => void;
  onCtrlD?: () => void;
  onPasteImage?: () => void;
  onExtensionShortcut?: (data: string) => boolean;
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

function readAutocompleteVisible(editor: EditorComponent): boolean {
  const maybeEditor = editor as EditorComponent & { isShowingAutocomplete?: () => boolean };
  return maybeEditor.isShowingAutocomplete?.() ?? false;
}

function withBypassedInputBehaviors<T>(editor: EditorComponent, run: () => T): T {
  const editorWithBypass = editor as EditorWithBypassFlag;
  const previous = editorWithBypass[BYPASS_INPUT_BEHAVIORS_SYMBOL];
  editorWithBypass[BYPASS_INPUT_BEHAVIORS_SYMBOL] = true;
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete editorWithBypass[BYPASS_INPUT_BEHAVIORS_SYMBOL];
    } else {
      editorWithBypass[BYPASS_INPUT_BEHAVIORS_SYMBOL] = previous;
    }
  }
}

class BehaviorWrappedEditor implements WrappedEditorComponent {
  [WRAPPED_EDITOR_COMPONENT_SYMBOL] = true;

  constructor(
    private readonly base: EditorComponent,
    private readonly getBehaviors: () => EditorBehavior[],
  ) {}

  get actionHandlers() {
    return (this.base as CustomEditorAppKeybindingSurface).actionHandlers;
  }

  onAction(action: AppKeybinding, handler: () => void): void {
    const base = this.base as CustomEditorAppKeybindingSurface;
    if (typeof base.onAction === 'function') {
      base.onAction(action, handler);
      return;
    }

    base.actionHandlers?.set(action, handler);
  }

  get onEscape() {
    return (this.base as CustomEditorAppKeybindingSurface).onEscape;
  }

  set onEscape(value: (() => void) | undefined) {
    (this.base as CustomEditorAppKeybindingSurface).onEscape = value;
  }

  get onCtrlD() {
    return (this.base as CustomEditorAppKeybindingSurface).onCtrlD;
  }

  set onCtrlD(value: (() => void) | undefined) {
    (this.base as CustomEditorAppKeybindingSurface).onCtrlD = value;
  }

  get onPasteImage() {
    return (this.base as CustomEditorAppKeybindingSurface).onPasteImage;
  }

  set onPasteImage(value: (() => void) | undefined) {
    (this.base as CustomEditorAppKeybindingSurface).onPasteImage = value;
  }

  get onExtensionShortcut() {
    return (this.base as CustomEditorAppKeybindingSurface).onExtensionShortcut;
  }

  set onExtensionShortcut(value: ((data: string) => boolean) | undefined) {
    (this.base as CustomEditorAppKeybindingSurface).onExtensionShortcut = value;
  }

  get wantsKeyRelease() {
    return this.base.wantsKeyRelease;
  }

  set wantsKeyRelease(value: boolean | undefined) {
    this.base.wantsKeyRelease = value;
  }

  get borderColor() {
    return this.base.borderColor;
  }

  set borderColor(value: ((str: string) => string) | undefined) {
    this.base.borderColor = value;
  }

  get onSubmit() {
    return this.base.onSubmit;
  }

  set onSubmit(value: ((text: string) => void) | undefined) {
    this.base.onSubmit = value;
  }

  get onChange() {
    return this.base.onChange;
  }

  set onChange(value: ((text: string) => void) | undefined) {
    this.base.onChange = value;
  }

  render(width: number): string[] {
    return this.base.render(width);
  }

  invalidate(): void {
    this.base.invalidate();
  }

  getText(): string {
    return this.base.getText();
  }

  setText(text: string): void {
    this.base.setText(text);
  }

  addToHistory(text: string): void {
    this.base.addToHistory?.(text);
  }

  insertTextAtCursor(text: string): void {
    this.base.insertTextAtCursor?.(text);
  }

  getExpandedText(): string {
    return this.base.getExpandedText?.() ?? this.base.getText();
  }

  setAutocompleteProvider(
    provider: Parameters<NonNullable<EditorComponent['setAutocompleteProvider']>>[0],
  ): void {
    this.base.setAutocompleteProvider?.(provider);
  }

  setPaddingX(padding: number): void {
    this.base.setPaddingX?.(padding);
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.base.setAutocompleteMaxVisible?.(maxVisible);
  }

  handleInput(data: string): void {
    if ((this.base as EditorWithBypassFlag)[BYPASS_INPUT_BEHAVIORS_SYMBOL]) {
      this.base.handleInput(data);
      return;
    }

    const editor = this.base as unknown as EditorLike;
    const behaviors = this.getBehaviors();

    for (const behavior of behaviors) {
      if (behavior.beforeHandleInput?.(data, editor)) {
        return;
      }
    }

    const wasShowingAutocomplete = readAutocompleteVisible(this.base);
    withBypassedInputBehaviors(this.base, () => this.base.handleInput(data));

    for (const behavior of behaviors) {
      behavior.afterHandleInput?.(data, editor, { wasShowingAutocomplete });
    }
  }
}

function wrapEditorComponent(
  editor: EditorComponent,
  getBehaviors: () => EditorBehavior[],
): EditorComponent {
  if ((editor as WrappedEditorComponent)[WRAPPED_EDITOR_COMPONENT_SYMBOL]) return editor;
  return new BehaviorWrappedEditor(editor, getBehaviors);
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
  let restoreEditorComponent: (() => void) | undefined;

  pi.on('session_start', (_event, ctx) => {
    if (disposed || !hasTui(ctx) || typeof ctx.ui.getEditorComponent !== 'function') return;

    const previous = ctx.ui.getEditorComponent();
    if ((previous as WrappedEditorFactory | undefined)?.[WRAPPED_EDITOR_FACTORY_SYMBOL]) return;

    const wrappedFactory: WrappedEditorFactory = ((tui, theme, keybindings) => {
      const base = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      return wrapEditorComponent(base, getEditorBehaviors);
    }) as WrappedEditorFactory;
    wrappedFactory[WRAPPED_EDITOR_FACTORY_SYMBOL] = true;

    ctx.ui.setEditorComponent(wrappedFactory);
    restoreEditorComponent = () => {
      if (ctx.ui.getEditorComponent() === wrappedFactory) {
        ctx.ui.setEditorComponent(previous);
      }
    };
  });

  pi.on('session_shutdown', () => {
    if (disposed) return;
    disposed = true;
    restoreEditorComponent?.();
    unregister();
  });

  return () => {
    if (disposed) return;
    disposed = true;
    restoreEditorComponent?.();
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
    if ((this as unknown as EditorWithBypassFlag)[BYPASS_INPUT_BEHAVIORS_SYMBOL]) {
      super.handleInput(data);
      return;
    }

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
