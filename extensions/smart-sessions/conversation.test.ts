import { describe, expect, test } from 'vitest';

import { buildRollingSummaryInput } from './conversation';

const branch = [
  {
    id: 'entry-1',
    timestamp: '2026-04-15T00:00:01.000Z',
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text: 'Inspect smart sessions' }] },
  },
  {
    id: 'entry-2',
    timestamp: '2026-04-15T00:00:02.000Z',
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at prompts now' }] },
  },
  {
    id: 'entry-3',
    timestamp: '2026-04-15T00:00:03.000Z',
    type: 'message',
    message: { role: 'user', content: [{ type: 'text', text: 'Unify the inference path' }] },
  },
] as any;

describe('buildRollingSummaryInput', () => {
  test('returns only message text after the previous checkpoint entry', () => {
    expect(
      buildRollingSummaryInput(branch, {
        previousCheckpointEntryId: 'entry-2',
      }).freshConversation,
    ).toContain('Unify the inference path');
  });

  test('falls back to a full rebuild when the checkpoint entry is missing', () => {
    const input = buildRollingSummaryInput(branch, {
      previousCheckpointEntryId: 'entry-999',
    });

    expect(input.mode).toBe('rebuild');
    expect(input.freshConversation).toContain('Inspect smart sessions');
  });
});
