import { describe, expect, test } from 'vitest';

import { isLikelyQuietCommand } from './render-utils';

describe('display/render-utils', () => {
  test('treats quiet commands with env assignments or wrappers as quiet', () => {
    expect(isLikelyQuietCommand('FOO=1 git add README.md')).toBe(true);
    expect(isLikelyQuietCommand('command git switch main')).toBe(true);
    expect(isLikelyQuietCommand('/usr/bin/env CI=1 git restore --staged demo.ts')).toBe(true);
  });
});
