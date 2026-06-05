import { describe, expect, test } from 'vitest';

import { hasTui } from './ui-mode';

describe('hasTui', () => {
  test('is true only for real TUI mode', () => {
    expect(hasTui({ mode: 'tui' })).toBe(true);
    expect(hasTui({ mode: 'tui', hasUI: false })).toBe(false);
    expect(hasTui({ mode: 'rpc' })).toBe(false);
    expect(hasTui({ mode: 'json' })).toBe(false);
    expect(hasTui({ mode: 'print' })).toBe(false);
  });
});
