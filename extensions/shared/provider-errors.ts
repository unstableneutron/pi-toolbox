import { isReplaySafeOpenAIResponsesTransportFailure } from './openai-responses-retry';

export type RetryableProviderErrorReason =
  | 'deploymentMissing'
  | 'encryptedContentVerification'
  | 'nativeCompactionCreatedBy'
  | 'openAIResponsesTransportErrorBeforeOutput'
  | 'providerServerError';

export function classifyRetryableProviderError(
  errorMessage: string | undefined,
): RetryableProviderErrorReason | undefined {
  if (!errorMessage) return undefined;

  const text = errorMessage.toLowerCase();

  if (text.includes('api deployment for this resource does not exist')) {
    return 'deploymentMissing';
  }

  if (text.includes('encrypted content') && text.includes('could not be verified')) {
    return 'encryptedContentVerification';
  }

  if (text.includes('unknown parameter') && text.includes('created_by')) {
    return 'nativeCompactionCreatedBy';
  }

  if (
    text.includes('currently experiencing high demand') &&
    text.includes('peak load') &&
    text.includes('provisioned throughput')
  ) {
    return 'providerServerError';
  }

  if (text.includes('server had an error processing your request')) {
    return 'providerServerError';
  }

  if (text.includes('model produced invalid content')) {
    return 'providerServerError';
  }

  if (text.includes('unknown error (no error details in response)')) {
    return 'providerServerError';
  }

  if (text.includes('no tool call found for function call output with call_id')) {
    return 'providerServerError';
  }

  if (
    text.includes('number of toolresult blocks') &&
    text.includes('exceeds the number of tooluse blocks')
  ) {
    return 'providerServerError';
  }

  return undefined;
}

export function requiresSessionRepairForRetryableProviderError(
  reason: RetryableProviderErrorReason | undefined,
): boolean {
  return reason === 'encryptedContentVerification' || reason === 'nativeCompactionCreatedBy';
}

export function classifyRetryableAssistantProviderError(
  message: { errorMessage?: string } | undefined,
): RetryableProviderErrorReason | undefined {
  return (
    classifyRetryableProviderError(message?.errorMessage) ??
    (isReplaySafeOpenAIResponsesTransportFailure(message)
      ? 'openAIResponsesTransportErrorBeforeOutput'
      : undefined)
  );
}
