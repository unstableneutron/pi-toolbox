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
      isRetryableResponsesErrorFrame({
        type: 'error',
        status: 408,
        error: {
          type: 'invalid_request_error',
          message: 'stream closed before response.completed',
        },
      }),
    ).toBe(true);
    expect(
      previousResponseNotFoundMessage({
        type: 'error',
        error: { code: 'previous_response_not_found', message: 'previous response missing' },
      }),
    ).toBe('previous response missing');
    const xaiPreviousResponseError = {
      type: 'error',
      status: 500,
      error: {
        type: 'api_error',
        message:
          'gRPC error: Response with id=25a6b917-9417-9fa4-a21a-1e097d64a96b-xai-13 not found',
      },
    };
    expect(previousResponseNotFoundMessage(xaiPreviousResponseError)).toContain(
      '25a6b917-9417-9fa4-a21a-1e097d64a96b-xai-13',
    );
    expect(
      previousResponseNotFoundMessage(
        xaiPreviousResponseError,
        '25a6b917-9417-9fa4-a21a-1e097d64a96b-xai-13',
      ),
    ).toContain('25a6b917-9417-9fa4-a21a-1e097d64a96b-xai-13');
    expect(
      previousResponseNotFoundMessage(xaiPreviousResponseError, 'different-response-id'),
    ).toBeUndefined();
    expect(
      previousResponseNotFoundMessage({
        type: 'error',
        error: { message: 'The response body was not found in the cache.' },
      }),
    ).toBeUndefined();
    expect(previousResponseNotFoundMessage({ type: 'response.created' })).toBeUndefined();
    expect(responsesErrorFrameMessage({ type: 'error', message: 'boom' })).toBe('boom');
    expect(responsesErrorFrameMessage({ type: 'error', error: { code: 'server_error' } })).toBe(
      JSON.stringify({ type: 'error', error: { code: 'server_error' } }),
    );
  });
});
