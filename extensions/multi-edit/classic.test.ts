import { describe, expect, test } from 'vitest';

import {
  applyClassicEditsToText,
  detectLineEnding,
  normalizeClassicParams,
  normalizeForFuzzyMatch,
  stripBom,
} from './classic';

describe('normalizeClassicParams', () => {
  test('canonicalizes built-in path + edits[] input', () => {
    const normalized = normalizeClassicParams({
      path: 'src/app.ts',
      edits: [
        { oldText: 'foo', newText: 'bar' },
        { oldText: 'baz', newText: 'qux' },
      ],
    });

    expect(normalized.mode).toBe('classic');
    if (normalized.mode !== 'classic') {
      throw new Error('Expected classic mode');
    }
    expect(normalized.edits).toEqual([
      { path: 'src/app.ts', oldText: 'foo', newText: 'bar' },
      { path: 'src/app.ts', oldText: 'baz', newText: 'qux' },
    ]);
  });

  test('accepts legacy single-edit input', () => {
    const normalized = normalizeClassicParams({
      path: 'src/app.ts',
      oldText: 'foo',
      newText: 'bar',
    });

    expect(normalized.mode).toBe('classic');
    if (normalized.mode !== 'classic') {
      throw new Error('Expected classic mode');
    }
    expect(normalized.edits).toEqual([{ path: 'src/app.ts', oldText: 'foo', newText: 'bar' }]);
  });

  test('accepts legacy multi input with inherited path', () => {
    const normalized = normalizeClassicParams({
      path: 'src/app.ts',
      multi: [
        { oldText: 'foo', newText: 'bar' },
        { oldText: 'baz', newText: 'qux' },
      ],
    });

    expect(normalized.mode).toBe('classic');
    if (normalized.mode !== 'classic') {
      throw new Error('Expected classic mode');
    }
    expect(normalized.edits).toEqual([
      { path: 'src/app.ts', oldText: 'foo', newText: 'bar' },
      { path: 'src/app.ts', oldText: 'baz', newText: 'qux' },
    ]);
  });

  test('accepts patch input as a separate mode', () => {
    expect(normalizeClassicParams({ patch: '*** Begin Patch\n*** End Patch' })).toEqual({
      mode: 'patch',
      patch: '*** Begin Patch\n*** End Patch',
    });
  });

  test('repairs common edit aliases into canonical fields', () => {
    const normalized = normalizeClassicParams({
      filePath: 'src/app.ts',
      old_string: 'foo',
      new_string: 'bar',
    });

    expect(normalized.mode).toBe('classic');
    if (normalized.mode !== 'classic') {
      throw new Error('Expected classic mode');
    }
    expect(normalized.edits).toEqual([{ path: 'src/app.ts', oldText: 'foo', newText: 'bar' }]);
  });

  test('repairs JSON-stringified edit arrays and drops optional null fields', () => {
    const normalized = normalizeClassicParams({
      path: 'src/app.ts',
      edits: '[{"old":"foo","new":"bar","path":null}]',
    });

    expect(normalized.mode).toBe('classic');
    if (normalized.mode !== 'classic') {
      throw new Error('Expected classic mode');
    }
    expect(normalized.edits).toEqual([{ path: 'src/app.ts', oldText: 'foo', newText: 'bar' }]);
  });

  test('repairs bare patch payload strings but rejects ambiguous bare strings', () => {
    expect(normalizeClassicParams('*** Begin Patch\n*** End Patch')).toEqual({
      mode: 'patch',
      patch: '*** Begin Patch\n*** End Patch',
    });
    expect(() => normalizeClassicParams('replace foo with bar')).toThrow('Invalid edit input.');
  });
});

describe('applyClassicEditsToText', () => {
  test('applies canonical edits sequentially with cursor semantics', () => {
    const result = applyClassicEditsToText('foo\nfoo\n', [
      { path: 'src/app.ts', oldText: 'foo', newText: 'alpha' },
      { path: 'src/app.ts', oldText: 'foo', newText: 'beta' },
    ]);

    expect(result.content).toBe('alpha\nbeta\n');
    expect(result.results.map((entry) => entry.message)).toEqual([
      'Edited src/app.ts.',
      'Edited src/app.ts.',
    ]);
  });

  test('skips redundant duplicate edits explicitly', () => {
    const result = applyClassicEditsToText('foo\n', [
      { path: 'src/app.ts', oldText: 'foo', newText: 'bar' },
      { path: 'src/app.ts', oldText: 'foo', newText: 'bar' },
    ]);

    expect(result.content).toBe('bar\n');
    expect(result.results[1]).toMatchObject({
      success: true,
      skipped: true,
      message: 'Skipped redundant edit in src/app.ts (already replaced all occurrences).',
    });
  });

  test('rejects empty oldText', () => {
    expect(() =>
      applyClassicEditsToText('foo\n', [{ path: 'src/app.ts', oldText: '', newText: 'bar' }]),
    ).toThrow('oldText must not be empty in src/app.ts.');
  });

  test('falls back to fuzzy matching for smart quotes and trailing whitespace', () => {
    const result = applyClassicEditsToText('const title = “hello”;   \n', [
      { path: 'src/app.ts', oldText: 'const title = "hello";\n', newText: 'const title = "hi";\n' },
    ]);

    expect(result.content).toBe('const title = "hi";\n');
  });
});

describe('text preservation helpers', () => {
  test('detects CRLF line endings', () => {
    expect(detectLineEnding('a\r\nb\r\n')).toBe('\r\n');
  });

  test('strips UTF-8 BOM before matching', () => {
    expect(stripBom('\uFEFFhello')).toEqual({ bom: '\uFEFF', text: 'hello' });
  });
});

describe('normalizeForFuzzyMatch', () => {
  test('folds curly double quotes to straight double quotes', () => {
    expect(normalizeForFuzzyMatch('say \u201Chi\u201D')).toBe('say "hi"');
  });

  test('folds curly single quotes to straight single quotes', () => {
    expect(normalizeForFuzzyMatch('it\u2019s')).toBe("it's");
  });

  test('folds non-breaking space to regular space', () => {
    expect(normalizeForFuzzyMatch('a\u00A0b')).toBe('a b');
  });

  test('strips zero-width space', () => {
    expect(normalizeForFuzzyMatch('fo\u200Bo')).toBe('foo');
  });

  test('strips zero-width joiner and non-joiner', () => {
    expect(normalizeForFuzzyMatch('a\u200Cb\u200Dc')).toBe('abc');
  });

  test('strips mid-file BOM', () => {
    expect(normalizeForFuzzyMatch('alpha\uFEFFbravo')).toBe('alphabravo');
  });

  test('does NOT collapse tab and space (guards against language-aware creep)', () => {
    // Tabs and spaces carry semantic meaning in Python, Makefiles,
    // and some formatters. Fuzzy matching must preserve the
    // distinction so agents do not accidentally rewrite indent.
    expect(normalizeForFuzzyMatch('a\tb')).not.toBe(normalizeForFuzzyMatch('a b'));
    expect(normalizeForFuzzyMatch('a\tb')).toBe('a\tb');
  });

  test('does NOT collapse multiple spaces to one', () => {
    expect(normalizeForFuzzyMatch('a   b')).toBe('a   b');
  });
});
