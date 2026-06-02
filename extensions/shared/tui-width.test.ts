import { describe, expect, test } from 'vitest';

import {
  chooseOptionalSuffix,
  clampRenderedLineToWidth,
  clampRenderedLinesToWidth,
  normalizeWidth,
  type WidthMeasurementOps,
} from './tui-width';

const plainOps: WidthMeasurementOps = {
  measure: (text) => text.length,
  truncate: (text, maxWidth) => text.slice(0, Math.max(0, maxWidth)),
};

describe('shared TUI width helpers', () => {
  test('normalizes invalid and fractional widths', () => {
    expect(normalizeWidth(undefined)).toBe(0);
    expect(normalizeWidth(Number.NaN)).toBe(0);
    expect(normalizeWidth(-2)).toBe(0);
    expect(normalizeWidth(12.8)).toBe(12);
  });

  test('clamps rendered lines with caller-provided measurement operations', () => {
    expect(clampRenderedLineToWidth('abcdef', 4, plainOps)).toBe('abcd');
    expect(clampRenderedLinesToWidth(['abcdef', 'xy'], 3, plainOps)).toEqual(['abc', 'xy']);
  });

  test('keeps the first optional suffix when it leaves enough primary budget', () => {
    expect(
      chooseOptionalSuffix({
        width: 60,
        fixedWidth: 'read '.length + ':10-20'.length,
        suffixes: [' (ctrl+o to expand)', ''],
        minPrimaryWidth: 24,
      }),
    ).toEqual({ suffix: ' (ctrl+o to expand)', primaryBudget: 30 });
  });

  test('drops optional suffixes before they starve the primary content', () => {
    expect(
      chooseOptionalSuffix({
        width: 54,
        fixedWidth: 'read '.length + ':2508-2557'.length,
        suffixes: [' (ctrl+o to expand)', ''],
        minPrimaryWidth: 24,
      }),
    ).toEqual({ suffix: '', primaryBudget: 39 });
  });

  test('falls back to the final suffix and at least one primary column on tiny widths', () => {
    expect(
      chooseOptionalSuffix({
        width: 5,
        fixedWidth: 8,
        suffixes: [' long', ''],
        minPrimaryWidth: 24,
      }),
    ).toEqual({ suffix: '', primaryBudget: 1 });
  });
});
