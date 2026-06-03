import { describe, expect, test, vi } from 'vitest';

import {
  createDraftHistoryBehavior,
  isCandidateDraftHistoryInput,
  isMeaningfulDraftHistoryText,
} from './index';

function createEditor(initialText: string) {
  let text = initialText;
  return {
    editor: {
      state: { lines: [initialText], cursorLine: 0, cursorCol: initialText.length },
      getText: vi.fn(() => text),
      addToHistory: vi.fn(),
    },
    setText: (next: string) => {
      text = next;
    },
  };
}

describe('draft-history helpers', () => {
  test('requires at least two words and ten non-whitespace characters', () => {
    expect(isMeaningfulDraftHistoryText('review the latest diff')).toBe(true);
    expect(isMeaningfulDraftHistoryText('singlewordonly')).toBe(false);
    expect(isMeaningfulDraftHistoryText('ok no')).toBe(false);
    expect(isMeaningfulDraftHistoryText('   ')).toBe(false);
  });

  test('recognizes the v1 clear and line-delete inputs', () => {
    expect(isCandidateDraftHistoryInput('\x03')).toBe(true);
    expect(isCandidateDraftHistoryInput('\x15')).toBe(true);
    expect(isCandidateDraftHistoryInput('\x0b')).toBe(true);
    expect(isCandidateDraftHistoryInput('a')).toBe(false);
    expect(isCandidateDraftHistoryInput('\x1b[A')).toBe(false);
  });
});

describe('draft-history behavior', () => {
  test('adds meaningful fully cleared text to normal editor history', () => {
    const behavior = createDraftHistoryBehavior();
    const harness = createEditor('please review this diff');

    expect(behavior.beforeHandleInput?.('\x03', harness.editor)).toBe(false);
    harness.setText('');
    behavior.afterHandleInput?.('\x03', harness.editor, { wasShowingAutocomplete: false });

    expect(harness.editor.addToHistory).toHaveBeenCalledWith('please review this diff');
  });

  test('does not save when candidate deletion leaves editor non-empty', () => {
    const behavior = createDraftHistoryBehavior();
    const harness = createEditor('please review this diff');

    behavior.beforeHandleInput?.('\x15', harness.editor);
    harness.setText('diff');
    behavior.afterHandleInput?.('\x15', harness.editor, { wasShowingAutocomplete: false });

    expect(harness.editor.addToHistory).not.toHaveBeenCalled();
  });

  test('does not save trivial fully cleared text', () => {
    const behavior = createDraftHistoryBehavior();
    const harness = createEditor('ok no');

    behavior.beforeHandleInput?.('\x03', harness.editor);
    harness.setText('');
    behavior.afterHandleInput?.('\x03', harness.editor, { wasShowingAutocomplete: false });

    expect(harness.editor.addToHistory).not.toHaveBeenCalled();
  });

  test('ignores non-candidate keys without reading editor text', () => {
    const behavior = createDraftHistoryBehavior();
    const editor = {
      state: { lines: [''], cursorLine: 0, cursorCol: 0 },
      getText: vi.fn(() => {
        throw new Error('should not read');
      }),
      addToHistory: vi.fn(),
    };

    expect(behavior.beforeHandleInput?.('a', editor)).toBe(false);
    behavior.afterHandleInput?.('a', editor, { wasShowingAutocomplete: false });

    expect(editor.getText).not.toHaveBeenCalled();
    expect(editor.addToHistory).not.toHaveBeenCalled();
  });
});
