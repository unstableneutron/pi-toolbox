import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export type EditorShortcutDirective =
  | { command: 'model'; value: string }
  | { command: 'thinking'; value: string }
  | { command: 'fast'; value: string };

export type ParsedEditorShortcut = {
  directives: EditorShortcutDirective[];
  promptText: string;
};

export type DirectiveToken = {
  directive: EditorShortcutDirective;
  start: number;
  end: number;
};

export type SubmitResult =
  | { action: 'continue' }
  | { action: 'handled' }
  | { action: 'restore'; text: string }
  | { action: 'submit'; text: string };

export type EditorFactory = NonNullable<ReturnType<ExtensionContext['ui']['getEditorComponent']>>;

export const EDITOR_SHORTCUT_WRAPPED_FACTORY = Symbol.for(
  'pi-toolbox.editor-shortcut.wrapped-factory',
);
export const EDITOR_SHORTCUT_BASE_FACTORY = Symbol.for(
  'pi-toolbox.editor-shortcut.base-factory',
);

export type WrappedEditorFactory = EditorFactory & {
  [EDITOR_SHORTCUT_WRAPPED_FACTORY]?: true;
  [EDITOR_SHORTCUT_BASE_FACTORY]?: EditorFactory | undefined;
};
