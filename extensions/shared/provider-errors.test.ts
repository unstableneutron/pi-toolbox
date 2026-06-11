import { describe, expect, test } from 'vitest';

import {
  classifyOpenAIResponsesFailure,
  classifyRetryableAssistantProviderError,
  classifyRetryableProviderError,
  isNonRetryableAssistantProviderError,
  requiresSessionRepairForRetryableProviderError,
} from './provider-errors';

describe('shared provider error classification', () => {
  test('classifies deployment lookup failures as terminal configuration errors', () => {
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

    expect(
      classifyOpenAIResponsesFailure({
        status: 404,
        body: {
          error: {
            type: 'not_found_error',
            code: 'not_found',
            message:
              'Failed to find an active deployment in region: swedencentral for Azure resource bucket: PROTOTYPE',
          },
        },
      }),
    ).toMatchObject({
      reason: 'deploymentMissing',
      retryable: false,
      category: 'terminal_config_error',
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
  });

  test('identifies retryable reasons that require session repair before retry', () => {
    expect(requiresSessionRepairForRetryableProviderError('encryptedContentVerification')).toBe(
      true,
    );
    expect(requiresSessionRepairForRetryableProviderError('nativeCompactionCreatedBy')).toBe(true);
    expect(requiresSessionRepairForRetryableProviderError('providerServerError')).toBe(false);
    expect(requiresSessionRepairForRetryableProviderError(undefined)).toBe(false);
  });
});
