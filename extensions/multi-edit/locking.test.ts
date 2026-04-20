import { describe, expect, test } from 'vitest';

import { withFilesMutationQueue } from './locking';

describe('withFilesMutationQueue', () => {
  test('serializes overlapping file sets in sorted canonical order', async () => {
    const events: string[] = [];
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const first = withFilesMutationQueue(['b.ts', 'a.ts'], async () => {
      events.push('first:start');
      await wait(30);
      events.push('first:end');
    });

    const second = withFilesMutationQueue(['a.ts'], async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });
});
