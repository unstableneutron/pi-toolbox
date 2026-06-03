import { beforeEach, describe, expect, test, vi } from 'vitest';

import { clearEditorBehaviors, getEditorBehaviors } from '../shared/editor-behaviors';

import draftHistory, {
  createDraftHistoryBehavior,
  isCandidateDraftHistoryInput,
  isMeaningfulDraftHistoryText,
} from './index';

beforeEach(() => {
  clearEditorBehaviors();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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
  test('requires at least two words and eight non-whitespace characters', () => {
    expect(isMeaningfulDraftHistoryText('some words')).toBe(true);
    expect(isMeaningfulDraftHistoryText('review the latest diff')).toBe(true);
    expect(isMeaningfulDraftHistoryText('singlewordonly')).toBe(false);
    expect(isMeaningfulDraftHistoryText('ok no')).toBe(false);
    expect(isMeaningfulDraftHistoryText('   ')).toBe(false);
  });

  test('recognizes raw and CSI-u encoded v1 clear and line-delete inputs', () => {
    expect(isCandidateDraftHistoryInput('\x03')).toBe(true);
    expect(isCandidateDraftHistoryInput('\x15')).toBe(true);
    expect(isCandidateDraftHistoryInput('\x0b')).toBe(true);
    expect(isCandidateDraftHistoryInput('\x1b[99;5u')).toBe(true);
    expect(isCandidateDraftHistoryInput('\x1b[117;5u')).toBe(true);
    expect(isCandidateDraftHistoryInput('\x1b[107;5u')).toBe(true);
    expect(isCandidateDraftHistoryInput('a')).toBe(false);
    expect(isCandidateDraftHistoryInput('\x1b[A')).toBe(false);
  });
});

function createExtensionHarness() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
      const existing = handlers.get(event);
      handlers.set(event, async (eventArg: any, ctx: any) => {
        await existing?.(eventArg, ctx);
        await handler(eventArg, ctx);
      });
    },
  };

  return { pi, handlers };
}

describe('draft-history behavior', () => {
  test('adds meaningful fully cleared text to normal editor history and reports the save', () => {
    const onDraftSaved = vi.fn();
    const behavior = createDraftHistoryBehavior({ onDraftSaved });
    const harness = createEditor('please review this diff');

    expect(behavior.beforeHandleInput?.('\x03', harness.editor)).toBe(false);
    harness.setText('');
    behavior.afterHandleInput?.('\x03', harness.editor, { wasShowingAutocomplete: false });

    expect(harness.editor.addToHistory).toHaveBeenCalledWith('please review this diff');
    expect(onDraftSaved).toHaveBeenCalledWith('please review this diff');
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

describe('draft-history extension', () => {
  test('only shows a friendly temporary status when a draft is saved', async () => {
    vi.useFakeTimers();
    const { pi, handlers } = createExtensionHarness();
    const setStatus = vi.fn();

    draftHistory(pi as any);
    await handlers.get('session_start')?.(
      { type: 'session_start', reason: 'startup' },
      {
        hasUI: true,
        ui: {
          getEditorComponent: () => undefined,
          setEditorComponent: vi.fn(),
          setStatus,
        },
      },
    );

    expect(setStatus).not.toHaveBeenCalled();

    const behavior = getEditorBehaviors().find((candidate) => candidate.id === 'draft-history');
    expect(behavior).toBeDefined();
    const harness = createEditor('some words');
    behavior!.beforeHandleInput?.('\x03', harness.editor);
    harness.setText('');
    behavior!.afterHandleInput?.('\x03', harness.editor, { wasShowingAutocomplete: false });

    expect(setStatus).toHaveBeenCalledWith(
      'draft-history',
      'Saved cleared draft. Press ↑ to restore it.',
    );

    vi.advanceTimersByTime(4000);

    expect(setStatus).toHaveBeenLastCalledWith('draft-history', undefined);
  });
});
