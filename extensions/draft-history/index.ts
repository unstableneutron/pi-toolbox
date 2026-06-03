import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey } from '@earendil-works/pi-tui';

import { registerExtensionEditorBehavior, type EditorBehavior } from '../shared/editor-behaviors';

const CANDIDATE_KEYS = [Key.ctrl('c'), Key.ctrl('u'), Key.ctrl('k')];
const MIN_WORDS = 2;
const MIN_NON_WHITESPACE_CHARS = 8;
const STATUS_KEY = 'draft-history';
const SAVED_STATUS_MS = 4000;

type DraftHistoryEditor = {
  getText?: () => string;
  getExpandedText?: () => string;
  addToHistory?: (text: string) => void;
};

export function isCandidateDraftHistoryInput(data: string): boolean {
  return CANDIDATE_KEYS.some((key) => matchesKey(data, key));
}

export function isMeaningfulDraftHistoryText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const words = trimmed.split(/\s+/).filter(Boolean);
  const nonWhitespaceChars = trimmed.replace(/\s/g, '').length;
  return words.length >= MIN_WORDS && nonWhitespaceChars >= MIN_NON_WHITESPACE_CHARS;
}

function readEditorText(editor: DraftHistoryEditor): string | undefined {
  return editor.getExpandedText?.() ?? editor.getText?.();
}

type DraftHistoryBehaviorOptions = {
  onDraftSaved?: (text: string) => void;
};

export function createDraftHistoryBehavior(
  options: DraftHistoryBehaviorOptions = {},
): EditorBehavior {
  const pendingTextByEditor = new WeakMap<object, string>();

  return {
    id: 'draft-history',
    priority: 50,
    beforeHandleInput(data, editor) {
      if (!isCandidateDraftHistoryInput(data)) return false;

      try {
        const draftEditor = editor as DraftHistoryEditor;
        const text = readEditorText(draftEditor);
        if (typeof text === 'string' && isMeaningfulDraftHistoryText(text)) {
          pendingTextByEditor.set(editor, text);
        } else {
          pendingTextByEditor.delete(editor);
        }
      } catch {
        pendingTextByEditor.delete(editor);
      }

      return false;
    },
    afterHandleInput(data, editor) {
      if (!isCandidateDraftHistoryInput(data)) return;

      const before = pendingTextByEditor.get(editor);
      if (before === undefined) return;
      pendingTextByEditor.delete(editor);

      try {
        const draftEditor = editor as DraftHistoryEditor;
        const after = readEditorText(draftEditor);
        if (typeof after !== 'string' || after.trim() !== '') return;

        const restored = before.trim();
        if (restored !== after.trim()) {
          draftEditor.addToHistory?.(restored);
          options.onDraftSaved?.(restored);
        }
      } catch {
        // Do not interfere with normal editor behavior if history capture fails.
      }
    },
  };
}

export default function draftHistory(pi: ExtensionAPI) {
  let currentCtx: ExtensionContext | undefined;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;

  function clearStatusTimer() {
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = undefined;
    }
  }

  function setTemporaryStatus(message: string, timeoutMs: number) {
    if (!currentCtx?.hasUI) return;

    clearStatusTimer();
    currentCtx.ui.setStatus(STATUS_KEY, message);
    statusTimer = setTimeout(() => {
      statusTimer = undefined;
      currentCtx?.ui.setStatus(STATUS_KEY, undefined);
    }, timeoutMs);
  }

  registerExtensionEditorBehavior(
    pi,
    createDraftHistoryBehavior({
      onDraftSaved: () =>
        setTemporaryStatus('Saved cleared draft. Press ↑ to restore it.', SAVED_STATUS_MS),
    }),
  );

  pi.on('session_start', (_event, ctx) => {
    currentCtx = ctx;
  });

  pi.on('session_shutdown', () => {
    clearStatusTimer();
    currentCtx?.ui.setStatus(STATUS_KEY, undefined);
    currentCtx = undefined;
  });
}
