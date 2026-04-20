import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

describe('extensions directory layout', () => {
  test('does not contain top-level Vitest files that Pi will try to load as extensions', () => {
    const entries = readdirSync(new URL('../extensions/', import.meta.url), {
      withFileTypes: true,
    });

    const topLevelTestFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
      .map((entry) => join('extensions', entry.name));

    expect(topLevelTestFiles).toEqual([]);
  });
});
