import { classifyOpenAIResponsesFailure } from './provider-errors';

function responseOutputItems(response: Record<string, any>): Record<string, any>[] {
  return (Array.isArray(response.output) ? response.output : []).filter(
    (item): item is Record<string, any> => typeof item === 'object' && item !== null,
  );
}

function terminalResponseMessage(response: Record<string, any>): string | undefined {
  const message = response.error?.message || response.incomplete_details?.reason;
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}

function hasTerminalResponseDetails(response: Record<string, any>): boolean {
  return (
    response.error != null ||
    response.incomplete_details != null ||
    response.content_filters != null ||
    response.moderation != null
  );
}

function terminalResponseOutputItems(response: Record<string, any>): number | undefined {
  return Array.isArray(response.output) ? response.output.length : undefined;
}

function hasActionableTerminalOutput(response: Record<string, any>): boolean {
  return responseOutputItems(response).some(
    (item) => item.type === 'message' || item.type === 'function_call',
  );
}

function formatTerminalResponseError(type: string, response: Record<string, any>): string {
  const message = terminalResponseMessage(response);
  if (message) return message;

  const status = typeof response.status === 'string' ? response.status : 'unknown';
  const details = [
    typeof response.id === 'string' ? `response_id=${response.id}` : undefined,
    typeof response.model === 'string' ? `model=${response.model}` : undefined,
    typeof response.previous_response_id === 'string'
      ? `previous_response_id=${response.previous_response_id}`
      : undefined,
  ].filter((detail): detail is string => typeof detail === 'string');
  const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
  return `Responses API returned ${type} with status=${status} without error details${suffix}`;
}

export class TerminalResponseError extends Error {
  readonly eventType: string;
  readonly status: string;
  readonly responseId?: string;
  readonly model?: string;
  readonly previousResponseId?: string;
  readonly hasDetails: boolean;
  readonly outputItems?: number;
  readonly hasActionableOutput: boolean;
  readonly failureReason?: string;
  readonly failureCategory?: string;
  readonly retryable?: boolean;

  constructor(type: string, response: Record<string, any>) {
    super(formatTerminalResponseError(type, response));
    this.name = 'TerminalResponseError';
    this.eventType = type;
    this.status = typeof response.status === 'string' ? response.status : 'unknown';
    this.responseId = typeof response.id === 'string' ? response.id : undefined;
    this.model = typeof response.model === 'string' ? response.model : undefined;
    this.previousResponseId =
      typeof response.previous_response_id === 'string' ? response.previous_response_id : undefined;
    this.hasDetails = hasTerminalResponseDetails(response);
    this.outputItems = terminalResponseOutputItems(response);
    this.hasActionableOutput = hasActionableTerminalOutput(response);
    const classification = classifyOpenAIResponsesFailure({ event: { type, response } });
    this.failureReason = classification?.reason;
    this.failureCategory = classification?.category;
    this.retryable = classification?.retryable;
  }
}

export function isRetryableEmptyResponseFailure(error: unknown): error is TerminalResponseError {
  return (
    error instanceof TerminalResponseError &&
    error.eventType === 'response.failed' &&
    error.status === 'failed' &&
    !error.hasDetails &&
    !error.hasActionableOutput
  );
}

export function previousResponseNotFoundMessage(
  event: Record<string, any>,
  expectedPreviousResponseId?: string,
): string | undefined {
  if (event.type !== 'error') return undefined;
  const error = event.error ?? {};
  const message = responsesErrorFrameMessage(event);
  if (error.code === 'previous_response_not_found') return message;
  if (!/\b(?:previous\s+)?response\s+with\s+id\b[^\r\n]*\bnot\s+found\b/i.test(message)) {
    return undefined;
  }
  return expectedPreviousResponseId && !message.includes(expectedPreviousResponseId)
    ? undefined
    : message;
}

export function responsesErrorFrameMessage(event: Record<string, any>): string {
  const message = event.error?.message ?? event.message;
  return typeof message === 'string' && message.length > 0 ? message : JSON.stringify(event);
}

export function isRetryableResponsesErrorFrame(event: Record<string, any>): boolean {
  if (event.type !== 'error') return false;
  const status = typeof event.status === 'number' ? event.status : event.error?.status;
  const classification = classifyOpenAIResponsesFailure({ status, event });
  if (classification) return classification.retryable;
  if (status === 408 || status === 500 || status === 502 || status === 503 || status === 504)
    return true;

  const text = [event.error?.type, event.error?.code, event.error?.message, event.message]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();
  return (
    text.includes('server_error') ||
    text.includes('internal_server_error') ||
    text.includes('internal server') ||
    text.includes('unexpected eof') ||
    text.includes('abnormal closure') ||
    text.includes('close 1006')
  );
}
