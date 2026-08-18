import { describe, expect, test } from 'vitest';

import {
  classifyOpenAIResponsesFailure,
  classifyRetryableAssistantProviderError,
  classifyRetryableProviderError,
  extractDuplicateResponsesItemId,
  isNonRetryableAssistantProviderError,
  requiresSessionRepairForRetryableProviderError,
} from './provider-errors';

describe('shared provider error classification', () => {
  test('classifies missing configured deployments as terminal configuration errors', () => {
    expect(
      classifyOpenAIResponsesFailure({
        status: 404,
        body: {
          error: {
            type: 'invalid_request_error',
            code: 'DeploymentNotFound',
            message:
              'The API deployment for this resource does not exist. If you created the deployment within the last 5 minutes, please wait a moment and try again.',
          },
        },
      }),
    ).toMatchObject({
      reason: 'deploymentMissing',
      retryable: false,
      category: 'terminal_config_error',
    });
  });

  test('classifies unavailable active resource-bucket deployments as transient', () => {
    expect(
      classifyOpenAIResponsesFailure({
        status: 404,
        body: {
          error: {
            type: 'not_found_error',
            code: 'not_found',
            message:
              'Failed to find an active deployment in region: eastus2 for Azure resource bucket: EXAMPLE_BUCKET',
          },
        },
      }),
    ).toMatchObject({
      reason: 'providerServerError',
      retryable: true,
      category: 'transient_retryable',
    });
  });

  test('does not expose deployment-missing errors as retryable provider errors', () => {
    expect(
      classifyRetryableProviderError(
        '404 The API deployment for this resource does not exist. Please try again later.',
      ),
    ).toBeUndefined();
  });

  test('does not classify terminal websocket diagnostics as retryable assistant errors', () => {
    const message = {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Unexpected server response: 500 (deploymentMissing)',
      diagnostics: [
        {
          type: 'openai_websocket_transport',
          details: {
            finalTransport: 'websocket',
            outcome: 'transport_error',
            replayUnsafeEventSeen: false,
            firstReplayUnsafeEventType: undefined,
            failureReason: 'deploymentMissing',
            failureCategory: 'terminal_config_error',
            retryable: false,
          },
        },
      ],
    };

    expect(classifyRetryableAssistantProviderError(message)).toBeUndefined();
    expect(isNonRetryableAssistantProviderError(message)).toBe(true);
  });

  test('classifies malformed Responses input item ids as terminal request errors', () => {
    const errorMessage = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message:
          "[ApiIdParam] [input[33].id] [string_above_max_length] Invalid 'input[33].id': string too long. Expected a string with maximum length 64, but got a string with length 428 instead.",
      },
      status: 400,
    });
    const message = {
      role: 'assistant',
      stopReason: 'error',
      errorMessage,
      diagnostics: [
        {
          type: 'openai_websocket_transport',
          details: {
            finalTransport: 'websocket',
            outcome: 'transport_error',
            replayUnsafeEventSeen: false,
          },
        },
      ],
    };

    expect(classifyOpenAIResponsesFailure({ message: errorMessage })).toMatchObject({
      reason: 'invalidRequest',
      retryable: false,
      category: 'terminal_config_error',
    });
    expect(classifyRetryableAssistantProviderError(message)).toBeUndefined();
    expect(isNonRetryableAssistantProviderError(message)).toBe(true);
  });

  test('classifies context length exceeded as a terminal request error', () => {
    const event = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        message: "This model's maximum context length was exceeded. Please reduce your input.",
        param: 'input',
      },
    };
    const errorMessage = JSON.stringify(event);
    const message = {
      role: 'assistant',
      stopReason: 'error',
      errorMessage,
      diagnostics: [
        {
          type: 'openai_websocket_transport',
          details: {
            finalTransport: 'websocket',
            outcome: 'transport_error',
            failureReason: 'invalidRequest',
            failureCategory: 'terminal_config_error',
            retryable: false,
          },
        },
      ],
    };

    expect(classifyOpenAIResponsesFailure({ event })).toMatchObject({
      reason: 'invalidRequest',
      retryable: false,
      category: 'terminal_config_error',
    });
    expect(classifyOpenAIResponsesFailure({ message: errorMessage })).toMatchObject({
      reason: 'invalidRequest',
      retryable: false,
      category: 'terminal_config_error',
    });
    expect(classifyRetryableAssistantProviderError(message)).toBeUndefined();
    expect(isNonRetryableAssistantProviderError(message)).toBe(true);
  });

  test.each([
    'model_context_window_exceeded: the request is too large for the model context window.',
    'prompt too long; exceeded max context length 131072 tokens.',
    "This model's maximum context length was exceeded. Please reduce your input.",
    'context window exceeded while preparing the request.',
  ])('classifies context-overflow alias as terminal request error: %s', (errorMessage) => {
    const message = {
      role: 'assistant',
      stopReason: 'error',
      errorMessage,
    };

    expect(classifyOpenAIResponsesFailure({ message: errorMessage })).toMatchObject({
      reason: 'invalidRequest',
      retryable: false,
      category: 'terminal_config_error',
    });
    expect(classifyRetryableProviderError(errorMessage)).toBeUndefined();
    expect(classifyRetryableAssistantProviderError(message)).toBeUndefined();
    expect(isNonRetryableAssistantProviderError(message)).toBe(true);
  });

  test('unwraps nested gateway errors and prioritizes duplicate-item repair over outer 500s', () => {
    const inner = JSON.stringify({
      error: {
        code: 'validation_error',
        message:
          'Duplicate item found with id msg_6f97352f33075e8b997c8f1659a40e09. Remove duplicate items from your input and try again.',
        type: 'invalid_request_error',
      },
    });
    const outer = JSON.stringify({
      error: {
        message: `litellm.APIConnectionError: Bedrock_mantleException - ${inner}. Received Model Group=gpt-5.6-sol`,
        code: '500',
      },
    });
    const errorMessage = `OpenAI Responses SSE HTTP 500: ${outer}`;

    expect(extractDuplicateResponsesItemId(errorMessage)).toBe(
      'msg_6f97352f33075e8b997c8f1659a40e09',
    );
    expect(classifyOpenAIResponsesFailure({ status: 500, message: errorMessage })).toEqual({
      reason: 'duplicateResponsesItemId',
      category: 'session_repair_retryable',
      retryable: true,
    });
    expect(classifyRetryableProviderError(errorMessage)).toBe('duplicateResponsesItemId');
  });

  test('classifies retryable provider error strings with stable reasons', () => {
    expect(
      classifyRetryableProviderError(
        '{"error":{"code":"invalid_encrypted_content","message":"The encrypted content for item rs_123 could not be verified."}}',
      ),
    ).toBe('encryptedContentVerification');

    expect(
      classifyRetryableProviderError("400 Bad Request: Unknown parameter: 'input[26].created_by'."),
    ).toBe('nativeCompactionCreatedBy');

    expect(
      classifyRetryableProviderError(
        '400 No tool call found for function call output with call_id call_123.',
      ),
    ).toBe('providerServerError');

    expect(classifyRetryableProviderError('The server had an error processing your request.')).toBe(
      'providerServerError',
    );

    expect(
      classifyRetryableProviderError(
        'The server had an error while processing your request. Sorry about that!',
      ),
    ).toBe('providerServerError');

    expect(classifyRetryableProviderError('Error: The model produced invalid content.')).toBe(
      'providerServerError',
    );

    expect(classifyRetryableProviderError('Unknown error (no error details in response)')).toBe(
      'providerServerError',
    );

    expect(
      classifyRetryableProviderError(
        'The number of toolResult blocks at messages.198.content exceeds the number of toolUse blocks of previous turn.',
      ),
    ).toBe('providerServerError');

    expect(
      classifyRetryableProviderError(
        'The system is currently experiencing high demand during peak load. For improved capacity reliability, consider switching to Provisioned Throughput.',
      ),
    ).toBe('providerServerError');

    expect(
      classifyRetryableProviderError(
        '{"type":"error","status":408,"error":{"message":"stream closed before response.completed","type":"invalid_request_error"}}',
      ),
    ).toBe('providerServerError');
    expect(
      classifyOpenAIResponsesFailure({
        status: 408,
        event: {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'stream closed before response.completed',
          },
        },
      }),
    ).toMatchObject({
      reason: 'providerServerError',
      retryable: true,
      category: 'transient_retryable',
    });
  });

  test('identifies retryable reasons that require session repair before retry', () => {
    expect(requiresSessionRepairForRetryableProviderError('duplicateResponsesItemId')).toBe(true);
    expect(requiresSessionRepairForRetryableProviderError('encryptedContentVerification')).toBe(
      true,
    );
    expect(requiresSessionRepairForRetryableProviderError('nativeCompactionCreatedBy')).toBe(true);
    expect(requiresSessionRepairForRetryableProviderError('providerServerError')).toBe(false);
    expect(requiresSessionRepairForRetryableProviderError(undefined)).toBe(false);
  });
});
