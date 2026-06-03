import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { registerExtensionEditorBehavior, type EditorBehavior } from '../shared/editor-behaviors';

const CANDIDATE_INPUTS = new Set(['\x03', '\x15', '\x0b']);
const MIN_WORDS = 2;
const MIN_NON_WHITESPACE_CHARS = 10;

type DraftHistoryEditor = {
  getText?: () => string;
  getExpandedText?: () => string;
  addToHistory?: (text: string) => void;
};

export function isCandidateDraftHistoryInput(data: string): boolean {
  return CANDIDATE_INPUTS.has(data);
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

export function createDraftHistoryBehavior(): EditorBehavior {
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
        }
      } catch {
        // Do not interfere with normal editor behavior if history capture fails.
      }
    },
  };
}

export default function draftHistory(pi: ExtensionAPI) {
  registerExtensionEditorBehavior(pi, createDraftHistoryBehavior());
}
