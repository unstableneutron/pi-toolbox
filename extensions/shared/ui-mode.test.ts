import { describe, expect, test } from 'vitest';

import { hasTui } from './ui-mode';

describe('hasTui', () => {
  test('is true only for explicit TUI contexts with UI access', () => {
    expect(hasTui({ mode: 'tui', hasUI: true })).toBe(true);
    expect(hasTui({ mode: 'tui', hasUI: false })).toBe(false);
    expect(hasTui({ mode: 'rpc', hasUI: true })).toBe(false);
    expect(hasTui({ mode: 'json', hasUI: true })).toBe(false);
    expect(hasTui({ mode: 'print', hasUI: true })).toBe(false);
    expect(hasTui(undefined)).toBe(false);
  });
});
