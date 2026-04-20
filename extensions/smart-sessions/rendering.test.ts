import { describe, expect, test } from 'vitest';

import { formatInlineRollingSummary, formatRollingSummaryMarkdown } from './rendering';

const summary = {
  shortTitle: 'Smart summary',
  longTitle: 'Unify smart-sessions rolling summary and notifications',
  shortSummary: 'Need user choice: keep sidecar current previous only',
  summaryBullets: [
    'Blocked: waiting for confirmation on bounded sidecar storage.',
    'In Progress: designing one rolling inference contract.',
  ],
  timelineItems: [
    'Inspected extensions/smart-sessions/index.ts.',
    'Checked extensions/notify/index.ts notification limits.',
  ],
  rewriteCount: 0,
  checkpointEntryId: 'entry-3',
  conversationHash: 'hash-3',
  generatedAt: '2026-04-15T00:30:00.000Z',
};

describe('rolling summary rendering', () => {
  test('uses short summary in the inline widget', () => {
    expect(formatInlineRollingSummary(summary, 80).join('\n')).toContain(
      'Need user choice: keep sidecar current previous only',
    );
  });

  test('renders Summary and Timeline sections in the modal markdown', () => {
    const markdown = formatRollingSummaryMarkdown(summary);
    expect(markdown).toContain(
      '# Session Summary: Unify smart-sessions rolling summary and notifications',
    );
    expect(markdown).toContain('## Summary');
    expect(markdown).toContain('## Timeline');
  });
});
