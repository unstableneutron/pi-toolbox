import type { ResponsesBody } from './body.ts';

export interface ContinuationState {
  lastRequestBody: ResponsesBody;
  lastResponseId: string;
  lastResponseItems: unknown[];
}

type ContinuationDecision =
  | 'no_continuation'
  | 'body_mismatch'
  | 'input_shorter_than_baseline'
  | 'input_prefix_mismatch'
  | 'missing_previous_response_id'
  | 'delta';

interface SocketCacheKeyParts {
  sessionId: string;
  url: string;
  provider: string;
  modelId: string;
  headersFingerprint: string;
}

const continuations = new Map<string, ContinuationState>();

export function requestBodyForContinuationComparison(body: ResponsesBody): ResponsesBody {
  const {
    input: _input,
    previous_response_id: _previousResponseId,
    reasoning: _reasoning,
    ...rest
  } = body;
  return rest as ResponsesBody;
}

function normalizeInputForComparison(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeInputForComparison);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const normalized = Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, normalizeInputForComparison(item)]),
  );
  if (record.type === 'message' && record.role === 'assistant') delete normalized.id;
  return normalized;
}

function responseInputsEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  return (
    JSON.stringify(normalizeInputForComparison(a ?? [])) ===
    JSON.stringify(normalizeInputForComparison(b ?? []))
  );
}

export function buildContinuationRequestBody(
  continuation: ContinuationState | undefined,
  body: ResponsesBody,
): { body: ResponsesBody; decision: ContinuationDecision } {
  if (!continuation) return { body, decision: 'no_continuation' };
  if (
    JSON.stringify(requestBodyForContinuationComparison(body)) !==
    JSON.stringify(requestBodyForContinuationComparison(continuation.lastRequestBody))
  ) {
    return { body, decision: 'body_mismatch' };
  }
  const baseline = [
    ...(continuation.lastRequestBody.input ?? []),
    ...continuation.lastResponseItems,
  ];
  if ((body.input ?? []).length < baseline.length)
    return { body, decision: 'input_shorter_than_baseline' };
  if (!responseInputsEqual((body.input ?? []).slice(0, baseline.length), baseline)) {
    return { body, decision: 'input_prefix_mismatch' };
  }
  if (!continuation.lastResponseId) return { body, decision: 'missing_previous_response_id' };
  return {
    decision: 'delta',
    body: {
      ...body,
      previous_response_id: continuation.lastResponseId,
      input: (body.input ?? []).slice(baseline.length),
    },
  };
}

export function buildSocketCacheKey(parts: SocketCacheKeyParts): string {
  return [parts.sessionId, parts.url, parts.provider, parts.modelId, parts.headersFingerprint].join(
    '\n',
  );
}

export function headersFingerprint(headers: Headers): string {
  return JSON.stringify(
    [...headers.entries()]
      .filter(([key]) => key.toLowerCase() !== 'traceparent')
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function getContinuation(key: string | undefined): ContinuationState | undefined {
  return key ? continuations.get(key) : undefined;
}

export function setContinuation(key: string | undefined, continuation: ContinuationState): void {
  if (key) continuations.set(key, continuation);
}

export function clearContinuation(key: string | undefined): void {
  if (key) continuations.delete(key);
}

export function clearAllContinuations(): void {
  continuations.clear();
}
