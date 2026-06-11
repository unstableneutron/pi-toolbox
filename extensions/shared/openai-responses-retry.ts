import { hasUserVisibleAssistantOutput } from './assistant-message-state';

const WEBSOCKET_TRANSPORT_DIAGNOSTIC_TYPE = 'openai_websocket_transport';

const REPLAY_SAFE_RESPONSE_EVENT_TYPES = new Set([
  'error',
  'response.cancelled',
  'response.cancelling',
  'response.completed',
  'response.created',
  'response.done',
  'response.failed',
  'response.in_progress',
  'response.incomplete',
  'response.queued',
  'response.rate_limits.updated',
]);

const REPLAY_UNSAFE_RESPONSE_EVENT_TYPES = new Set([
  'response.audio.delta',
  'response.audio.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.file_search_call.completed',
  'response.file_search_call.in_progress',
  'response.file_search_call.searching',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.output_item.added',
  'response.output_item.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.reasoning_text.delta',
  'response.reasoning_text.done',
  'response.refusal.delta',
  'response.refusal.done',
  'response.web_search_call.completed',
  'response.web_search_call.in_progress',
  'response.web_search_call.searching',
]);

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && 'object' === typeof value ? (value as Record<string, any>) : undefined;
}

function responseOutputItems(response: unknown): Record<string, any>[] {
  const output = asRecord(response)?.output;
  return (Array.isArray(output) ? output : []).filter(
    (item): item is Record<string, any> => 'object' === typeof item && item !== null,
  );
}

function responseHasReplayUnsafeOutput(response: unknown): boolean {
  return responseOutputItems(response).some((item) => {
    return item.type === 'message' || item.type === 'function_call';
  });
}

export function isReplayUnsafeResponsesEvent(event: unknown): boolean {
  const candidate = asRecord(event);
  const type = candidate?.type;
  if ('string' !== typeof type) return true;
  if (REPLAY_UNSAFE_RESPONSE_EVENT_TYPES.has(type)) return true;
  if (responseHasReplayUnsafeOutput(candidate?.response)) return true;
  if (REPLAY_SAFE_RESPONSE_EVENT_TYPES.has(type)) return false;
  return type.startsWith('response.');
}

export function shouldRetryResponsesTransportErrorBeforeOutput(input: {
  attempt: number;
  maxRetries: number;
  responseId?: string;
  replayUnsafeEventSeen: boolean;
  aborted?: boolean;
}): boolean {
  return Boolean(
    input.responseId &&
    !input.replayUnsafeEventSeen &&
    input.attempt < input.maxRetries &&
    !input.aborted,
  );
}

export function isReplaySafeOpenAIResponsesTransportDiagnosticDetails(details: unknown): boolean {
  const candidate = asRecord(details);
  return Boolean(
    candidate?.finalTransport === 'websocket' &&
    candidate.outcome === 'transport_error' &&
    candidate.replayUnsafeEventSeen === false &&
    candidate.firstReplayUnsafeEventType === undefined &&
    candidate.retryable !== false,
  );
}

export function isReplaySafeOpenAIResponsesTransportFailure(message: unknown): boolean {
  const candidate = asRecord(message);
  if (
    candidate?.role !== 'assistant' ||
    candidate.stopReason !== 'error' ||
    hasUserVisibleAssistantOutput(candidate.content)
  ) {
    return false;
  }

  const diagnostics = Array.isArray(candidate.diagnostics) ? candidate.diagnostics : [];
  return diagnostics.some((diagnostic) => {
    const record = asRecord(diagnostic);
    return (
      record?.type === WEBSOCKET_TRANSPORT_DIAGNOSTIC_TYPE &&
      isReplaySafeOpenAIResponsesTransportDiagnosticDetails(record.details)
    );
  });
}
