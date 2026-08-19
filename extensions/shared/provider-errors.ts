import { isReplaySafeOpenAIResponsesTransportFailure } from './openai-responses-retry';

export type RetryableProviderErrorReason =
  | 'duplicateResponsesItemId'
  | 'encryptedContentVerification'
  | 'nativeCompactionCreatedBy'
  | 'openAIResponsesTransportErrorBeforeOutput'
  | 'providerServerError';

export type ProviderFailureReason =
  | RetryableProviderErrorReason
  | 'deploymentMissing'
  | 'invalidModel'
  | 'invalidRequest'
  | 'authError'
  | 'rateLimited';

export type ProviderFailureCategory =
  | 'terminal_config_error'
  | 'terminal_auth_error'
  | 'transient_retryable'
  | 'session_repair_retryable';

interface OpenAIResponsesFailureInput {
  status?: number;
  body?: unknown;
  event?: unknown;
  message?: string;
}

interface AssistantProviderErrorLike {
  errorMessage?: string;
  role?: unknown;
  stopReason?: unknown;
  content?: unknown;
  diagnostics?: unknown;
}

export interface ProviderFailureClassification {
  reason: ProviderFailureReason;
  category: ProviderFailureCategory;
  retryable: boolean;
}

function isRetryableProviderErrorReason(
  reason: ProviderFailureReason,
): reason is RetryableProviderErrorReason {
  return (
    reason === 'duplicateResponsesItemId' ||
    reason === 'encryptedContentVerification' ||
    reason === 'nativeCompactionCreatedBy' ||
    reason === 'openAIResponsesTransportErrorBeforeOutput' ||
    reason === 'providerServerError'
  );
}

const MAX_NESTED_FAILURE_DEPTH = 8;
const MAX_NESTED_FAILURE_STRING_LENGTH = 256 * 1024;

function parseNestedFailureJson(value: string): unknown {
  if (value.length > MAX_NESTED_FAILURE_STRING_LENGTH) return undefined;
  const trimmed = value.trim();
  const candidates = [trimmed];
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (0 <= start && start < end) candidates.push(trimmed.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && 'object' === typeof parsed) return parsed;
    } catch {
      // Provider wrappers commonly surround an embedded JSON payload with prose.
    }
  }
  return undefined;
}

function collectFailureText(value: unknown, output: string[] = [], depth = 0): string[] {
  if (typeof value === 'string') {
    output.push(value);
    if (depth < MAX_NESTED_FAILURE_DEPTH) {
      const parsed = parseNestedFailureJson(value);
      if (parsed) collectFailureText(parsed, output, depth + 1);
    }
    return output;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value));
    return output;
  }
  if (!value || typeof value !== 'object' || depth >= MAX_NESTED_FAILURE_DEPTH) return output;
  if (Array.isArray(value)) {
    for (const item of value) collectFailureText(item, output, depth + 1);
    return output;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['type', 'code', 'message', 'param', 'status', 'reason']) {
    collectFailureText(record[key], output, depth + 1);
  }
  collectFailureText(record.error, output, depth + 1);
  collectFailureText(record.response, output, depth + 1);
  collectFailureText(record.incomplete_details, output, depth + 1);
  return output;
}

function duplicateResponsesItemId(value: unknown): string | undefined {
  for (const text of collectFailureText(value)) {
    const match = /duplicate item found with id\s+([a-z0-9_-]+)/i.exec(text);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function extractDuplicateResponsesItemId(errorMessage: string | undefined): string | undefined {
  return duplicateResponsesItemId(errorMessage);
}

function failureText(input: OpenAIResponsesFailureInput): string {
  return collectFailureText([input.message, input.body, input.event]).join('\n').toLowerCase();
}

function retryable(
  reason: RetryableProviderErrorReason | 'rateLimited',
  category: ProviderFailureCategory = 'transient_retryable',
): ProviderFailureClassification {
  return { reason, category, retryable: true };
}

function terminal(
  reason: Exclude<ProviderFailureReason, RetryableProviderErrorReason | 'rateLimited'>,
  category: Extract<ProviderFailureCategory, 'terminal_config_error' | 'terminal_auth_error'>,
): ProviderFailureClassification {
  return { reason, category, retryable: false };
}

function isContextOverflowFailureText(text: string): boolean {
  return (
    text.includes('context_length_exceeded') ||
    text.includes('model_context_window_exceeded') ||
    text.includes('context_window_exceeded') ||
    text.includes('context window exceeded') ||
    text.includes('context length exceeded') ||
    text.includes('maximum context length') ||
    text.includes('max context length') ||
    text.includes('prompt too long')
  );
}

export function classifyOpenAIResponsesFailure(
  input: OpenAIResponsesFailureInput,
): ProviderFailureClassification | undefined {
  const text = failureText(input);
  const status = input.status;

  if (duplicateResponsesItemId([input.message, input.body, input.event])) {
    return retryable('duplicateResponsesItemId', 'session_repair_retryable');
  }

  if (
    text.includes('failed to find an active deployment') &&
    text.includes('azure resource bucket')
  ) {
    return retryable('providerServerError');
  }

  if (
    text.includes('deploymentnotfound') ||
    text.includes('deploymentmissing') ||
    text.includes('api deployment for this resource does not exist')
  ) {
    return terminal('deploymentMissing', 'terminal_config_error');
  }

  if (text.includes('invalid model name passed') || text.includes('model_not_found')) {
    return terminal('invalidModel', 'terminal_config_error');
  }

  if (isContextOverflowFailureText(text)) {
    return terminal('invalidRequest', 'terminal_config_error');
  }

  if (
    text.includes('invalid_request_error') &&
    text.includes('string_above_max_length') &&
    text.includes('input[') &&
    text.includes('].id')
  ) {
    return terminal('invalidRequest', 'terminal_config_error');
  }

  if (status === 401 || status === 403) return terminal('authError', 'terminal_auth_error');

  if (status === 429 || text.includes('rate limit') || text.includes('too many requests')) {
    return retryable('rateLimited');
  }

  if (
    text.includes('encrypted content') &&
    (text.includes('could not be verified') || text.includes('missing recognized prefix'))
  ) {
    return retryable('encryptedContentVerification', 'session_repair_retryable');
  }

  if (text.includes('.custom.strict') && text.includes('extra inputs are not permitted')) {
    return terminal('invalidRequest', 'terminal_config_error');
  }

  if (text.includes('unknown parameter') && text.includes('created_by')) {
    return retryable('nativeCompactionCreatedBy', 'session_repair_retryable');
  }

  if (
    text.includes('currently experiencing high demand') &&
    text.includes('peak load') &&
    text.includes('provisioned throughput')
  ) {
    return retryable('providerServerError');
  }

  if (
    text.includes('server had an error processing your request') ||
    text.includes('server had an error while processing your request')
  ) {
    return retryable('providerServerError');
  }

  if (text.includes('model produced invalid content')) {
    return retryable('providerServerError');
  }

  if (text.includes('unknown error (no error details in response)')) {
    return retryable('providerServerError');
  }

  if (text.includes('no tool call found for function call output with call_id')) {
    return retryable('providerServerError');
  }

  if (
    text.includes('number of toolresult blocks') &&
    text.includes('exceeds the number of tooluse blocks')
  ) {
    return retryable('providerServerError');
  }

  if (
    status === 408 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    text.includes('server_error') ||
    text.includes('internal_server_error') ||
    text.includes('internal server') ||
    text.includes('stream closed before response.completed') ||
    text.includes('unexpected eof') ||
    text.includes('abnormal closure') ||
    text.includes('close 1006')
  ) {
    return retryable('providerServerError');
  }

  return undefined;
}

function classificationFromOpenAIResponsesTransportDiagnostics(
  message: AssistantProviderErrorLike | undefined,
): ProviderFailureClassification | undefined {
  const diagnostics = Array.isArray(message?.diagnostics) ? message.diagnostics : [];
  for (const diagnostic of diagnostics) {
    if (!diagnostic || typeof diagnostic !== 'object') continue;
    const record = diagnostic as Record<string, unknown>;
    if (record.type !== 'openai_websocket_transport') continue;
    const details = record.details;
    if (!details || typeof details !== 'object') continue;
    const candidate = details as Record<string, unknown>;
    const retryable = candidate.retryable;
    const reason = candidate.failureReason;
    const category = candidate.failureCategory;
    if (
      typeof retryable === 'boolean' &&
      typeof reason === 'string' &&
      typeof category === 'string'
    ) {
      return {
        reason: reason as ProviderFailureReason,
        category: category as ProviderFailureCategory,
        retryable,
      };
    }
  }
  return undefined;
}

function classifyAssistantProviderFailure(
  message: AssistantProviderErrorLike | undefined,
): ProviderFailureClassification | undefined {
  return (
    classificationFromOpenAIResponsesTransportDiagnostics(message) ??
    classifyOpenAIResponsesFailure({ message: message?.errorMessage })
  );
}

export function isNonRetryableAssistantProviderError(
  message: AssistantProviderErrorLike | undefined,
): boolean {
  return classifyAssistantProviderFailure(message)?.retryable === false;
}

export function classifyRetryableProviderError(
  errorMessage: string | undefined,
): RetryableProviderErrorReason | undefined {
  const classification = classifyOpenAIResponsesFailure({ message: errorMessage });
  return classification?.retryable && isRetryableProviderErrorReason(classification.reason)
    ? classification.reason
    : undefined;
}

export function requiresSessionRepairForRetryableProviderError(
  reason: RetryableProviderErrorReason | undefined,
): boolean {
  return (
    reason === 'duplicateResponsesItemId' ||
    reason === 'encryptedContentVerification' ||
    reason === 'nativeCompactionCreatedBy'
  );
}

export function classifyRetryableAssistantProviderError(
  message: AssistantProviderErrorLike | undefined,
): RetryableProviderErrorReason | undefined {
  const classification = classifyAssistantProviderFailure(message);
  if (classification) {
    return classification.retryable && isRetryableProviderErrorReason(classification.reason)
      ? classification.reason
      : undefined;
  }
  return isReplaySafeOpenAIResponsesTransportFailure(message)
    ? 'openAIResponsesTransportErrorBeforeOutput'
    : undefined;
}
