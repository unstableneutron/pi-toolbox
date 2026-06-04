import { describe, expect, test } from 'vitest';

import {
  hasAssistantToolCall,
  hasUserVisibleAssistantOutput,
  isSkippableEmptyFailedAssistantArtifact,
} from './assistant-message-state';

describe('shared assistant message state helpers', () => {
  test('detects visible assistant output from text and tool calls', () => {
    expect(hasUserVisibleAssistantOutput([{ type: 'text', text: '  ' }])).toBe(false);
    expect(hasUserVisibleAssistantOutput([{ type: 'text', text: 'hello' }])).toBe(true);
    expect(hasUserVisibleAssistantOutput([{ type: 'toolCall', id: 'call_1' }])).toBe(true);
    expect(hasAssistantToolCall([{ type: 'toolCall', id: 'call_1' }])).toBe(true);
  });

  test('detects skippable failed artifacts only when usage is empty recursively', () => {
    expect(
      isSkippableEmptyFailedAssistantArtifact({
        role: 'assistant',
        stopReason: 'error',
        content: [],
        usage: { input: 0, output: 0 },
      }),
    ).toBe(true);
    expect(
      isSkippableEmptyFailedAssistantArtifact({
        role: 'assistant',
        stopReason: 'error',
        content: [],
        usage: { input: 0, nested: { total: 1 } },
      }),
    ).toBe(false);
  });
});
