import { describe, expect, test } from 'vitest';

import {
  type PatchSummaryRow,
  renderApplyPatchRows,
  renderApplyPatchRowsAtWidth,
} from './apply-patch-summary';

const theme = {
  bold: (text: string) => text,
  fg: (_role: string, text: string) => text,
};

const rows: PatchSummaryRow[] = [
  {
    kind: 'edit',
    path: 'extensions/shared/apply-patch-summary.ts',
    addedLines: 4,
    removedLines: 1,
    modifiedBytes: 42,
    renameOnly: false,
    state: 'applied',
  },
];

describe('apply-patch summary render cache', () => {
  test('exposes uncached row rendering for already-cached parents', () => {
    expect(renderApplyPatchRowsAtWidth(rows, theme, 80)).toEqual(
      renderApplyPatchRows(rows, theme).render(80),
    );
  });

  test('reuses the cached line array at the same width', () => {
    const component = renderApplyPatchRows(rows, theme);
    const first = component.render(80);

    expect(component.render(80)).toBe(first);
  });

  test('replaces the single cache entry when the width changes', () => {
    const component = renderApplyPatchRows(rows, theme);
    const wide = component.render(80);
    const narrow = component.render(24);

    expect(narrow).not.toBe(wide);
    expect(component.render(24)).toBe(narrow);
    expect(component.render(80)).not.toBe(wide);
  });

  test('recomputes stable output after invalidation', () => {
    const component = renderApplyPatchRows(rows, theme);
    const cached = component.render(80);

    component.invalidate();
    const refreshed = component.render(80);

    expect(refreshed).not.toBe(cached);
    expect(refreshed).toEqual(cached);
    expect(component.render(80)).toBe(refreshed);
  });
});
