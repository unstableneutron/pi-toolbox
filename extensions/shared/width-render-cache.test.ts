import { describe, expect, test, vi } from 'vitest';

import { WidthRenderCache } from './width-render-cache';

describe('WidthRenderCache', () => {
  test('reuses one same-width line array', () => {
    const cache = new WidthRenderCache();
    const compute = vi.fn(() => ['wide']);

    const first = cache.render(80, compute);

    expect(cache.render(80, compute)).toBe(first);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  test('retains only the latest width', () => {
    const cache = new WidthRenderCache();
    const compute = vi.fn(() => [`render:${compute.mock.calls.length}`]);
    const wide = cache.render(80, compute);
    const narrow = cache.render(40, compute);

    expect(narrow).not.toBe(wide);
    expect(cache.render(40, compute)).toBe(narrow);
    expect(cache.render(80, compute)).not.toBe(wide);
    expect(compute).toHaveBeenCalledTimes(3);
  });

  test('recomputes after clearing', () => {
    const cache = new WidthRenderCache();
    const compute = vi.fn(() => ['same']);
    const first = cache.render(80, compute);

    cache.clear();

    expect(cache.render(80, compute)).not.toBe(first);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
