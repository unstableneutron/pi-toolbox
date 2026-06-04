import { describe, expect, test } from 'vitest';

import {
  classifyRetryableProviderError,
  requiresSessionRepairForRetryableProviderError,
} from './provider-errors';

describe('shared provider error classification', () => {
  test('classifies retryable provider error strings with stable reasons', () => {
    expect(
      classifyRetryableProviderError(
        '404 The API deployment for this resource does not exist. Please try again later.',
      ),
    ).toBe('deploymentMissing');

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
    expect(requiresSessionRepairForRetryableProviderError('deploymentMissing')).toBe(false);
    expect(requiresSessionRepairForRetryableProviderError(undefined)).toBe(false);
  });
});
