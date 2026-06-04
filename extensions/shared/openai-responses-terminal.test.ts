import { describe, expect, test } from 'vitest';

import {
  TerminalResponseError,
  isRetryableEmptyResponseFailure,
  isRetryableResponsesErrorFrame,
  previousResponseNotFoundMessage,
  responsesErrorFrameMessage,
} from './openai-responses-terminal';

describe('shared OpenAI Responses terminal/error helpers', () => {
  test('classifies detail-less response.failed with only reasoning output as retryable', () => {
    const error = new TerminalResponseError('response.failed', {
      id: 'resp_failed',
      status: 'failed',
      error: null,
      incomplete_details: null,
      output: [{ type: 'reasoning', id: 'rs_failed', summary: [] }],
    });

    expect(error.hasDetails).toBe(false);
    expect(error.hasActionableOutput).toBe(false);
    expect(isRetryableEmptyResponseFailure(error)).toBe(true);
  });

  test('does not classify failed responses with messages or details as empty retryable', () => {
    expect(
      isRetryableEmptyResponseFailure(
        new TerminalResponseError('response.failed', {
          status: 'failed',
          output: [{ type: 'message', id: 'msg_1', content: [] }],
        }),
      ),
    ).toBe(false);

    expect(
      isRetryableEmptyResponseFailure(
        new TerminalResponseError('response.failed', {
          status: 'failed',
          error: { message: 'bad request' },
          output: [{ type: 'reasoning', id: 'rs_1', summary: [] }],
        }),
      ),
    ).toBe(false);
  });

  test('classifies retryable Responses error frames and previous-response misses', () => {
    expect(
      isRetryableResponsesErrorFrame({
        type: 'error',
        status: 500,
        error: { message: 'internal server error' },
      }),
    ).toBe(true);
    expect(
      isRetryableResponsesErrorFrame({
        type: 'error',
        error: { message: 'unexpected EOF after response.created' },
      }),
    ).toBe(true);
    expect(
      previousResponseNotFoundMessage({
        type: 'error',
        error: { code: 'previous_response_not_found', message: 'previous response missing' },
      }),
    ).toBe('previous response missing');
    expect(previousResponseNotFoundMessage({ type: 'response.created' })).toBeUndefined();
    expect(responsesErrorFrameMessage({ type: 'error', message: 'boom' })).toBe('boom');
    expect(responsesErrorFrameMessage({ type: 'error', error: { code: 'server_error' } })).toBe(
      JSON.stringify({ type: 'error', error: { code: 'server_error' } }),
    );
  });
});
