import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  __resetQuoteTierCacheForTests,
  hasFormatterConfig,
  hasQuoteTierExtension,
  isQuoteTierEligibleForFile,
  normalizeForQuoteTier,
  validateAndTranslateQuoteTier,
} from './quote-tier';

describe('hasQuoteTierExtension', () => {
  test('accepts the JS/TS family', () => {
    for (const p of [
      'a.js',
      'a.jsx',
      'a.ts',
      'a.tsx',
      'a.mjs',
      'a.cjs',
      'a.mts',
      'a.cts',
      '/abs/path/deep/x.ts',
      'UPPER.TS',
    ]) {
      expect(hasQuoteTierExtension(p)).toBe(true);
    }
  });

  test('rejects everything else', () => {
    for (const p of [
      'a.md',
      'a.json',
      'a.yml',
      'a.py',
      'a.go',
      'a.rs',
      'Dockerfile',
      'README',
      '.prettierrc',
    ]) {
      expect(hasQuoteTierExtension(p)).toBe(false);
    }
  });
});

describe('hasFormatterConfig', () => {
  let workdir: string;

  beforeEach(async () => {
    __resetQuoteTierCacheForTests();
    workdir = await mkdtemp(join(tmpdir(), 'quote-tier-'));
  });
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  test('returns false when no config is present and walk hits a repo sentinel', async () => {
    // .git sentinel at the root of our temp dir — walk should stop here.
    await mkdir(join(workdir, '.git'));
    expect(hasFormatterConfig(workdir)).toBe(false);
  });

  test('returns true when .oxfmtrc.json is at cwd', async () => {
    await writeFile(join(workdir, '.oxfmtrc.json'), '{}');
    expect(hasFormatterConfig(workdir)).toBe(true);
  });

  test('returns true when .prettierrc is at an ancestor up to repo sentinel', async () => {
    await mkdir(join(workdir, '.git'));
    await writeFile(join(workdir, '.prettierrc'), '{}');
    const nested = join(workdir, 'packages', 'foo', 'src');
    await mkdir(nested, { recursive: true });
    expect(hasFormatterConfig(nested)).toBe(true);
  });

  test('returns true for biome.json at ancestor', async () => {
    await mkdir(join(workdir, '.git'));
    await writeFile(join(workdir, 'biome.json'), '{}');
    const nested = join(workdir, 'a', 'b');
    await mkdir(nested, { recursive: true });
    expect(hasFormatterConfig(nested)).toBe(true);
  });

  test('stops at repo sentinel even if a config exists above it', async () => {
    // Config lives at workdir, but a nested dir has its own .git.
    // Walk must stop at the nested .git and not find the config above.
    await writeFile(join(workdir, '.oxfmtrc.json'), '{}');
    const nested = join(workdir, 'vendored-repo');
    await mkdir(nested);
    await mkdir(join(nested, '.git'));
    expect(hasFormatterConfig(nested)).toBe(false);
  });

  test('caches per-directory so repeated lookups short-circuit', async () => {
    await mkdir(join(workdir, '.git'));
    expect(hasFormatterConfig(workdir)).toBe(false);
    // Adding a config after the cache has been populated must NOT
    // retroactively flip the cached result — that is the documented
    // behavior; it keeps the tier safely off for stale caches.
    await writeFile(join(workdir, '.oxfmtrc.json'), '{}');
    expect(hasFormatterConfig(workdir)).toBe(false);
    __resetQuoteTierCacheForTests();
    expect(hasFormatterConfig(workdir)).toBe(true);
  });
});

describe('isQuoteTierEligibleForFile', () => {
  let workdir: string;

  beforeEach(async () => {
    __resetQuoteTierCacheForTests();
    workdir = await mkdtemp(join(tmpdir(), 'quote-tier-elig-'));
    await mkdir(join(workdir, '.git'));
  });
  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  test('requires both ext allowlist AND formatter config', async () => {
    expect(isQuoteTierEligibleForFile('foo.ts', workdir)).toBe(false);
    await writeFile(join(workdir, '.oxfmtrc.json'), '{}');
    __resetQuoteTierCacheForTests();
    expect(isQuoteTierEligibleForFile('foo.ts', workdir)).toBe(true);
    expect(isQuoteTierEligibleForFile('foo.md', workdir)).toBe(false);
    expect(isQuoteTierEligibleForFile('foo', workdir)).toBe(false);
  });
});

describe('normalizeForQuoteTier', () => {
  test('collapses quote style and whitespace', () => {
    expect(normalizeForQuoteTier("  import x from 'y';  ")).toBe(
      normalizeForQuoteTier('import x from "y";'),
    );
  });

  test('preserves escape backslashes, so escape-bearing lines differ', () => {
    // "it's" vs 'it\'s' — the latter has an extra backslash that
    // does not exist in the former, so they must not collapse.
    const withBackslash = String.raw`const s = 'it\'s';`;
    const withoutBackslash = `const s = "it's";`;
    expect(normalizeForQuoteTier(withBackslash)).not.toBe(normalizeForQuoteTier(withoutBackslash));
  });

  test('does not collapse backticks with quotes', () => {
    expect(normalizeForQuoteTier('`foo`')).not.toBe(normalizeForQuoteTier("'foo'"));
    expect(normalizeForQuoteTier('`foo`')).not.toBe(normalizeForQuoteTier('"foo"'));
  });

  test('handles smart quotes via base normalization', () => {
    // \u2018/\u2019 → ', then → sentinel
    expect(normalizeForQuoteTier('\u2018foo\u2019')).toBe(normalizeForQuoteTier("'foo'"));
    expect(normalizeForQuoteTier('\u2018foo\u2019')).toBe(normalizeForQuoteTier('"foo"'));
  });

  test('does not collapse different identifiers that happen to be quote-equivalent', () => {
    expect(normalizeForQuoteTier("a 'x' b")).not.toBe(normalizeForQuoteTier("a 'y' b"));
  });
});

describe('validateAndTranslateQuoteTier', () => {
  test('translates a pure single→double swap in REPLACE', () => {
    const out = validateAndTranslateQuoteTier({
      searchLines: ["import x from 'y';"],
      fileRegion: ['import x from "y";'],
      replaceLines: ["import x from 'y.new';"],
    });
    expect(out).toBeDefined();
    expect(out!.direction).toBe('\'->"');
    expect(out!.replaceLines).toEqual(['import x from "y.new";']);
  });

  test('translates a pure double→single swap in REPLACE', () => {
    const out = validateAndTranslateQuoteTier({
      searchLines: ['import x from "y";'],
      fileRegion: ["import x from 'y';"],
      replaceLines: ['import x from "y.new";'],
    });
    expect(out).toBeDefined();
    expect(out!.direction).toBe('"->\'');
    expect(out!.replaceLines).toEqual(["import x from 'y.new';"]);
  });

  test('symmetric swap preserves mixed-quote REPLACE', () => {
    // REPLACE intentionally contains both kinds; swap is symmetric
    // so the relationship is preserved in the output.
    const out = validateAndTranslateQuoteTier({
      searchLines: ["const a = 'x';"],
      fileRegion: ['const a = "x";'],
      replaceLines: [`const a = 'x' + "y";`],
    });
    expect(out).toBeDefined();
    // Every `'` in REPLACE becomes `"`, every `"` becomes `'`.
    expect(out!.replaceLines).toEqual([`const a = "x" + 'y';`]);
  });

  test('refuses when SEARCH contains a backtick', () => {
    const out = validateAndTranslateQuoteTier({
      searchLines: ["const a = `'x'`;"],
      fileRegion: ['const a = `"x"`;'],
      replaceLines: ["const a = 'y';"],
    });
    expect(out).toBeUndefined();
  });

  test('refuses when file region contains a backtick', () => {
    const out = validateAndTranslateQuoteTier({
      searchLines: ["const a = 'x';"],
      fileRegion: ['const a = `"x"`;'],
      replaceLines: ["const a = 'y';"],
    });
    expect(out).toBeUndefined();
  });

  test('refuses when REPLACE contains a backtick', () => {
    const out = validateAndTranslateQuoteTier({
      searchLines: ["const a = 'x';"],
      fileRegion: ['const a = "x";'],
      replaceLines: ['const a = `y`;'],
    });
    expect(out).toBeUndefined();
  });

  test('refuses when SEARCH contains an escaped quote', () => {
    const out = validateAndTranslateQuoteTier({
      searchLines: [String.raw`const a = 'it\'s';`],
      fileRegion: [`const a = "it's";`],
      replaceLines: [`const a = 'x';`],
    });
    expect(out).toBeUndefined();
  });

  test('refuses when file region contains an escaped quote', () => {
    const out = validateAndTranslateQuoteTier({
      searchLines: [`const a = 'x';`],
      fileRegion: [String.raw`const a = "\"x\"";`],
      replaceLines: [`const a = 'y';`],
    });
    expect(out).toBeUndefined();
  });

  test('refuses when REPLACE contains an escaped quote', () => {
    const out = validateAndTranslateQuoteTier({
      searchLines: [`const a = 'x';`],
      fileRegion: [`const a = "x";`],
      replaceLines: [String.raw`const a = 'it\'s';`],
    });
    expect(out).toBeUndefined();
  });

  test('refuses when SEARCH side is not monomorphic', () => {
    const out = validateAndTranslateQuoteTier({
      searchLines: [`const a = 'x' + "y";`],
      fileRegion: [`const a = "x" + 'y';`],
      replaceLines: [`const a = 'z';`],
    });
    expect(out).toBeUndefined();
  });

  test('refuses when file region is not monomorphic', () => {
    const out = validateAndTranslateQuoteTier({
      searchLines: [`const a = 'x';`],
      fileRegion: [`const a = "x" + 'y';`],
      replaceLines: [`const a = 'z';`],
    });
    expect(out).toBeUndefined();
  });

  test('refuses when both sides are empty or have no quotes', () => {
    // No quotes means nothing to disambiguate. The standard tiers
    // would have matched anyway; quote tier refusing here is correct.
    const out = validateAndTranslateQuoteTier({
      searchLines: ['const a = 1;'],
      fileRegion: ['const a = 1;'],
      replaceLines: ['const a = 2;'],
    });
    expect(out).toBeUndefined();
  });
});
