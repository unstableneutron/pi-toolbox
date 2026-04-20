import { describe, expect, test } from 'vitest';

import { compactName, isRollingSessionSummary, sanitizeBulletList } from './contracts';

describe('smart-sessions contracts helpers', () => {
  test('compactName strips punctuation and limits words', () => {
    expect(compactName('"Fix:" notify-sidecar fallback!!!', 3)).toBe('Fix notify sidecar');
  });

  test('sanitizeBulletList removes empty and markdown-prefixed items', () => {
    expect(sanitizeBulletList(['- First item', '  ', '* Second item'])).toEqual([
      'First item',
      'Second item',
    ]);
  });

  test('isRollingSessionSummary rejects malformed sidecar payloads', () => {
    expect(
      isRollingSessionSummary({
        shortTitle: 'x',
        longTitle: 'y',
        shortSummary: 'z',
        summaryBullets: [],
        timelineItems: [],
        rewriteCount: 0,
        conversationHash: 'hash',
        generatedAt: 'now',
      }),
    ).toBe(false);
  });
});
