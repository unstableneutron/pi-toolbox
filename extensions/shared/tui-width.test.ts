import { describe, expect, test } from 'vitest';

import {
  DEFAULT_EXPAND_HINT_SUFFIXES,
  chooseOptionalSuffix,
  clampRenderedLineToWidth,
  clampRenderedLinesToWidth,
  normalizeWidth,
  sanitizeRenderableLine,
  stripTerminalControlSequences,
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

  test('strips terminal control sequences for renderable tool text', () => {
    expect(stripTerminalControlSequences('a\u001b[31mb\u001b[0mc\u001b]0;title\u0007d')).toBe(
      'abcd',
    );
    expect(stripTerminalControlSequences('a\u009b31mb\u009b0mc\u009d0;title\u009cd')).toBe('abcd');
    expect(stripTerminalControlSequences('a\u009bK')).toBe('a');
    expect(stripTerminalControlSequences('a\u009bK', { preserveCsi: true })).toBe('a\u001b[K');
    expect(stripTerminalControlSequences('a\u001bPprivate\u001b\\b')).toBe('ab');
    expect(stripTerminalControlSequences('a\u0090private\u009cb')).toBe('ab');
    expect(sanitizeRenderableLine('a\u0000b\r\nc')).toBe('ab c');
    expect(sanitizeRenderableLine('bad\ufffdbytes')).toBe('badbytes');
    expect(sanitizeRenderableLine('bad\ud800surrogate')).toBe('badsurrogate');
    expect(sanitizeRenderableLine('a\u202ebidi\u2060word\ufeffbom')).toBe('abidiwordbom');
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

  test('prefers shorter expand hints when they preserve the preferred primary width', () => {
    expect(
      chooseOptionalSuffix({
        width: 51,
        fixedWidth: '[skill] '.length,
        suffixes: DEFAULT_EXPAND_HINT_SUFFIXES,
        minPrimaryWidth: 24,
        preferredPrimaryWidth: 'verification-before-completion'.length,
      }),
    ).toEqual({ suffix: ' (ctrl+o)', primaryBudget: 34 });
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
