import { describe, expect, test } from 'vitest';

import {
  analyzeResponsesReasoningSignature,
  createResponsesReplayState,
  encodeResponsesTextSignatureV1,
  isEncryptedResponsesReasoningSignature,
  noteResponsesReasoningForReplay,
  responsesDependentItemId,
  responsesFunctionCallInput,
  responsesTextSignatureItemId,
  responsesTextSignaturePhase,
} from './openai-responses-replay';

describe('shared OpenAI Responses replay helpers', () => {
  test('parses replayable and encrypted reasoning signatures', () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' };
    const signature = JSON.stringify(reasoning);
    const state = createResponsesReplayState();

    expect(noteResponsesReasoningForReplay(state, signature)).toEqual(reasoning);
    expect(isEncryptedResponsesReasoningSignature(signature)).toBe(true);
    expect(analyzeResponsesReasoningSignature(signature)).toEqual({
      kind: 'replayable-reasoning',
      item: reasoning,
      id: 'rs_1',
      encrypted: true,
    });
  });

  test('tracks unreplayable reasoning so dependent provider item ids are omitted', () => {
    const state = createResponsesReplayState();

    expect(noteResponsesReasoningForReplay(state, undefined)).toBeUndefined();
    expect(state.hasUnreplayableReasoningBeforeItem).toBe(true);
    expect(responsesDependentItemId(state, 'msg_requires_missing_reasoning')).toBeUndefined();

    expect(
      responsesFunctionCallInput(
        {
          id: 'call_missing_reasoning|fc_requires_missing_reasoning',
          name: 'read',
          arguments: { path: 'README.md' },
        },
        { includeItemId: !state.hasUnreplayableReasoningBeforeItem },
      ),
    ).toEqual({
      type: 'function_call',
      call_id: 'call_missing_reasoning',
      name: 'read',
      arguments: JSON.stringify({ path: 'README.md' }),
    });
  });

  test('preserves dependent ids before unreplayable reasoning is encountered', () => {
    const state = createResponsesReplayState();
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [] };

    expect(noteResponsesReasoningForReplay(state, JSON.stringify(reasoning))).toEqual(reasoning);
    expect(state.hasUnreplayableReasoningBeforeItem).toBe(false);
    expect(responsesDependentItemId(state, 'msg_1')).toBe('msg_1');
    expect(
      responsesFunctionCallInput(
        { id: 'call_1|fc_1', name: 'read', arguments: { path: 'a.ts' } },
        { includeItemId: !state.hasUnreplayableReasoningBeforeItem },
      ),
    ).toMatchObject({ id: 'fc_1', call_id: 'call_1' });
  });

  test('round-trips Responses text signatures with optional phase', () => {
    const signature = encodeResponsesTextSignatureV1('msg_1', 'commentary');

    expect(responsesTextSignatureItemId(signature)).toBe('msg_1');
    expect(responsesTextSignaturePhase(signature)).toBe('commentary');
    expect(responsesTextSignatureItemId('legacy_msg')).toBe('legacy_msg');
  });
});
