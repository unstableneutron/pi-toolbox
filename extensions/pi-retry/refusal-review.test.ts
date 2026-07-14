import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@earendil-works/pi-ai/compat', () => ({
  completeSimple: vi.fn(),
}));

import { completeSimple } from '@earendil-works/pi-ai/compat';

import {
  buildRefusalStatus,
  buildReviewTranscript,
  extractAssistantText,
  findPreferredModel,
  inferModelFamily,
  isLikelyPrematureAbandonmentText,
  isLikelyRefusalText,
  parseReviewResponse,
  pickReviewModels,
  requestRefusalRewrite,
} from './refusal-review';

const AVAILABLE_MODELS = [
  { provider: 'gust', id: 'claude-opus-4-6', api: 'anthropic-messages', reasoning: true },
  { provider: 'gust', id: 'gpt-5.4', api: 'openai-responses', reasoning: true },
  { provider: 'gust', id: 'gemini-3.1-pro-preview', api: 'google-generative-ai', reasoning: true },
] as const;

beforeEach(() => {
  vi.mocked(completeSimple).mockReset();
});

describe('extractAssistantText', () => {
  test('joins text blocks from the final assistant message', () => {
    expect(
      extractAssistantText({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'skip me' },
          { type: 'text', text: "I'm sorry," },
          { type: 'text', text: 'but I cannot assist with that request.' },
        ],
      } as any),
    ).toBe("I'm sorry,\nbut I cannot assist with that request.");
  });
});

describe('isLikelyRefusalText', () => {
  test('matches broad canned refusal phrases', () => {
    expect(isLikelyRefusalText("I'm sorry, but I cannot assist with that request.")).toBe(true);
    expect(isLikelyRefusalText('I must decline that request.')).toBe(true);
  });

  test('does not match mixed substantive answers with a refusal tail', () => {
    expect(
      isLikelyRefusalText(
        [
          'Done. I traced the ExampleService snapshot path end-to-end and validated it against retry/backoff behavior.',
          "I'm sorry, but I cannot assist with that request.",
        ].join('\n\n'),
      ),
    ).toBe(false);
  });

  test('does not match ordinary completion text', () => {
    expect(isLikelyRefusalText('Here is the implementation plan you asked for.')).toBe(false);
  });
});

describe('isLikelyPrematureAbandonmentText', () => {
  test('matches terse give-up responses observed in tool-backed sessions', () => {
    expect(isLikelyPrematureAbandonmentText('I’m sorry, but I couldn’t complete the port.')).toBe(
      true,
    );
    expect(isLikelyPrematureAbandonmentText('Sorry, I wasn’t able to complete this.')).toBe(true);
    expect(isLikelyPrematureAbandonmentText('I’m sorry, but I couldn’t finish this work.')).toBe(
      true,
    );
    expect(
      isLikelyPrematureAbandonmentText(
        'I’m sorry, but I couldn’t complete the observer and multi-window work.',
      ),
    ).toBe(true);
  });

  test('does not match responses that identify a concrete blocker', () => {
    expect(
      isLikelyPrematureAbandonmentText(
        'I couldn’t complete the deployment because the required credentials are unavailable.',
      ),
    ).toBe(false);
    expect(
      isLikelyPrematureAbandonmentText(
        'I was not able to finish: the test command failed with a permission error.',
      ),
    ).toBe(false);
  });

  test('does not match qualified completion summaries or long explanations', () => {
    expect(
      isLikelyPrematureAbandonmentText(
        'I could not complete optional cleanup, but the requested implementation is done and tests passed.',
      ),
    ).toBe(false);
    expect(
      isLikelyPrematureAbandonmentText(
        `I couldn't complete ${'the remaining investigation '.repeat(45)}`,
      ),
    ).toBe(false);
  });
});

describe('inferModelFamily', () => {
  test('classifies gpt, claude, and gemini model ids', () => {
    expect(
      inferModelFamily({ provider: 'gust', id: 'gpt-5.4', api: 'openai-responses' } as any),
    ).toBe('openai');
    expect(
      inferModelFamily({
        provider: 'gust',
        id: 'claude-opus-4-6',
        api: 'anthropic-messages',
      } as any),
    ).toBe('claude');
    expect(
      inferModelFamily({
        provider: 'gust',
        id: 'gemini-3.1-pro-preview',
        api: 'google-generative-ai',
      } as any),
    ).toBe('gemini');
  });
});

describe('pickReviewModels', () => {
  test('maps openai-based models to opus then gemini', () => {
    expect(
      pickReviewModels(
        { provider: 'gust', id: 'gpt-5.4', api: 'openai-responses' } as any,
        AVAILABLE_MODELS as any,
      ).map((model) => model.id),
    ).toEqual(['claude-opus-4-6', 'gemini-3.1-pro-preview']);
  });

  test('maps claude-based models to gpt then gemini', () => {
    expect(
      pickReviewModels(
        { provider: 'gust', id: 'claude-sonnet-4-6', api: 'anthropic-messages' } as any,
        AVAILABLE_MODELS as any,
      ).map((model) => model.id),
    ).toEqual(['gpt-5.4', 'gemini-3.1-pro-preview']);
  });

  test('fuzzy-matches gemini-3.1-pro to available preview variants', () => {
    expect(findPreferredModel('gemini-3.1-pro', AVAILABLE_MODELS as any)).toMatchObject({
      id: 'gemini-3.1-pro-preview',
    });
  });

  test('preserves the configured fallback order even when a fallback matches the active model id', () => {
    expect(
      pickReviewModels(
        { provider: 'gust', id: 'gemini-3.1-pro-preview', api: 'google-generative-ai' } as any,
        AVAILABLE_MODELS as any,
      ).map((model) => model.id),
    ).toEqual(['gpt-5.4', 'gemini-3.1-pro-preview']);
  });
});

describe('buildRefusalStatus', () => {
  test('formats model-specific review text', () => {
    expect(buildRefusalStatus('claude-opus-4-6', 'review')).toBe(
      '↻ Refusal detected; asking claude-opus-4-6 for review...',
    );
  });
});

describe('parseReviewResponse', () => {
  test('extracts reason and rewrite from strict response format', () => {
    expect(
      parseReviewResponse(
        [
          'REASON: The original ask likely looked like direct operational execution.',
          'REWRITE:',
          'Please review the request, explain the likely safety concern, and propose a safe implementation approach.',
        ].join('\n'),
      ),
    ).toEqual({
      reason: 'The original ask likely looked like direct operational execution.',
      rewrite:
        'Please review the request, explain the likely safety concern, and propose a safe implementation approach.',
    });
  });

  test('returns undefined for malformed responses', () => {
    expect(parseReviewResponse('No labels here')).toBeUndefined();
  });
});

describe('buildReviewTranscript', () => {
  test('builds a deterministic transcript with user and refusal blocks', () => {
    expect(
      buildReviewTranscript({
        userText: 'Original ask',
        refusalText: "I'm sorry, but I cannot assist with that request.",
      }),
    ).toBe(
      [
        '<user>',
        'Original ask',
        '</user>',
        '<refusal>',
        "I'm sorry, but I cannot assist with that request.",
        '</refusal>',
      ].join('\n'),
    );
  });
});

describe('requestRefusalRewrite', () => {
  test('calls the selected review model with reasoning high and parses the result', async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      stopReason: 'stop',
      content: [
        {
          type: 'text',
          text: [
            'REASON: The refusal was likely triggered by direct execution framing.',
            'REWRITE:',
            'Please analyze the request, explain the likely block, and suggest a safe next step.',
          ].join('\n'),
        },
      ],
    } as any);

    const result = await requestRefusalRewrite({
      model: { provider: 'gust', id: 'gpt-5.4', api: 'openai-responses' } as any,
      apiKey: 'test-key',
      headers: { 'x-test': '1' },
      transcriptText: '<user>original ask</user>',
    });

    expect(result).toEqual({
      reason: 'The refusal was likely triggered by direct execution framing.',
      rewrite:
        'Please analyze the request, explain the likely block, and suggest a safe next step.',
    });

    expect(completeSimple).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gpt-5.4' }),
      expect.objectContaining({
        systemPrompt: expect.stringContaining('Return exactly this format'),
      }),
      expect.objectContaining({ apiKey: 'test-key', reasoning: 'high', maxTokens: 512 }),
    );
  });

  test('treats error stop reasons as failed sub-calls even when the text looks parseable', async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      stopReason: 'error',
      errorMessage: "Cannot read properties of undefined (reading 'input')",
      content: [
        {
          type: 'text',
          text: [
            'REASON: The fallback model produced a usable review.',
            'REWRITE:',
            'Please analyze the request and suggest a safe next step.',
          ].join('\n'),
        },
      ],
    } as any);

    const result = await requestRefusalRewrite({
      model: { provider: 'gust', id: 'gemini-3.1-pro-preview', api: 'google-generative-ai' } as any,
      apiKey: 'test-key',
      transcriptText: '<user>original ask</user>',
    });

    expect(result).toBeUndefined();
  });
});
