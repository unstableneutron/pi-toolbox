import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { AutocompleteProvider, EditorComponent } from '@earendil-works/pi-tui';

import type { FastModeState } from './commands/fast';
import { processEditorShortcutSubmission } from './processor';
import {
  EDITOR_SHORTCUT_BASE_FACTORY,
  EDITOR_SHORTCUT_WRAPPED_FACTORY,
  type EditorFactory,
  type SubmitResult,
  type WrappedEditorFactory,
} from './types';

type CustomEditorSurface = EditorComponent & {
  actionHandlers?: Map<string, () => void>;
  onAction?: (action: string, handler: () => void) => void;
  onEscape?: () => void;
  onCtrlD?: () => void;
  onPasteImage?: () => void;
  onExtensionShortcut?: (data: string) => boolean;
  wantsKeyRelease?: boolean;
};

class EditorShortcutWrappedEditor implements EditorComponent {
  private downstreamSubmit?: (text: string) => void;

  constructor(
    private readonly base: EditorComponent,
    private readonly processSubmission: (text: string) => Promise<SubmitResult>,
  ) {
    this.base.onSubmit = (text) => {
      void this.handleSubmit(text);
    };
  }

  get actionHandlers() {
    return (this.base as CustomEditorSurface).actionHandlers;
  }

  get onEscape() {
    return (this.base as CustomEditorSurface).onEscape;
  }
  set onEscape(value: (() => void) | undefined) {
    (this.base as CustomEditorSurface).onEscape = value;
  }

  get onCtrlD() {
    return (this.base as CustomEditorSurface).onCtrlD;
  }
  set onCtrlD(value: (() => void) | undefined) {
    (this.base as CustomEditorSurface).onCtrlD = value;
  }

  get onPasteImage() {
    return (this.base as CustomEditorSurface).onPasteImage;
  }
  set onPasteImage(value: (() => void) | undefined) {
    (this.base as CustomEditorSurface).onPasteImage = value;
  }

  get onExtensionShortcut() {
    return (this.base as CustomEditorSurface).onExtensionShortcut;
  }
  set onExtensionShortcut(value: ((data: string) => boolean) | undefined) {
    (this.base as CustomEditorSurface).onExtensionShortcut = value;
  }

  get wantsKeyRelease() {
    return (this.base as CustomEditorSurface).wantsKeyRelease;
  }
  set wantsKeyRelease(value: boolean | undefined) {
    (this.base as CustomEditorSurface).wantsKeyRelease = value;
  }

  get borderColor() {
    return this.base.borderColor;
  }
  set borderColor(value: ((str: string) => string) | undefined) {
    this.base.borderColor = value;
  }

  get onSubmit() {
    return this.downstreamSubmit;
  }
  set onSubmit(value: ((text: string) => void) | undefined) {
    this.downstreamSubmit = value;
  }

  get onChange() {
    return this.base.onChange;
  }
  set onChange(value: ((text: string) => void) | undefined) {
    this.base.onChange = value;
  }

  onAction(action: string, handler: () => void): void {
    (this.base as CustomEditorSurface).onAction?.(action, handler);
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

  handleInput(data: string): void {
    this.base.handleInput(data);
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

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.base.setAutocompleteProvider?.(provider);
  }

  setPaddingX(padding: number): void {
    this.base.setPaddingX?.(padding);
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.base.setAutocompleteMaxVisible?.(maxVisible);
  }

  private async handleSubmit(text: string): Promise<void> {
    const result = await this.processSubmission(text);

    if (result.action === 'continue') {
      this.downstreamSubmit?.(text);
      return;
    }

    if (result.action === 'submit') {
      this.downstreamSubmit?.(result.text);
      return;
    }

    if (result.action === 'restore') {
      this.base.setText(result.text);
    }
  }
}

export function createWrappedEditorFactory(
  previousFactory: EditorFactory | undefined,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  fastMode?: FastModeState,
): WrappedEditorFactory {
  const previousWrappedFactory = previousFactory as WrappedEditorFactory | undefined;
  const baseFactory = previousWrappedFactory?.[EDITOR_SHORTCUT_BASE_FACTORY] ?? previousFactory;
  const factory = ((tui, theme, keybindings) => {
    const base =
      baseFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
    return new EditorShortcutWrappedEditor(base, (text) =>
      processEditorShortcutSubmission(text, pi, ctx, fastMode),
    );
  }) as WrappedEditorFactory;

  factory[EDITOR_SHORTCUT_WRAPPED_FACTORY] = true;
  factory[EDITOR_SHORTCUT_BASE_FACTORY] = baseFactory;
  return factory;
}
