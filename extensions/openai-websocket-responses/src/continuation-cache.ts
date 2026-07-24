import type { ResponsesBody } from './body.ts';

export interface ContinuationState {
  lastRequestBody: ResponsesBody;
  lastResponseId: string;
  lastResponseItems: unknown[];
}

export type ContinuationDecision =
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

function itemRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function responseItemType(value: unknown): string | undefined {
  const record = itemRecord(value);
  return typeof record?.type === 'string' ? record.type : undefined;
}

function responseItemRole(value: unknown): string | undefined {
  const record = itemRecord(value);
  return typeof record?.role === 'string' ? record.role : undefined;
}

function responseItemCallId(value: unknown): string | undefined {
  const record = itemRecord(value);
  return typeof record?.call_id === 'string' && record.call_id.trim() ? record.call_id : undefined;
}

function pendingToolCalls(
  items: unknown[],
): Array<{ callId: string; outputType: 'function_call_output' | 'custom_tool_call_output' }> {
  const seen = new Set<string>();
  const calls: Array<{
    callId: string;
    outputType: 'function_call_output' | 'custom_tool_call_output';
  }> = [];
  for (const item of items) {
    const itemType = responseItemType(item);
    if (itemType !== 'function_call' && itemType !== 'custom_tool_call') continue;
    const callId = responseItemCallId(item);
    if (!callId || seen.has(callId)) continue;
    seen.add(callId);
    calls.push({
      callId,
      outputType:
        itemType === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output',
    });
  }
  return calls;
}

function buildCompleteToolOutputDelta(
  continuation: ContinuationState,
  body: ResponsesBody,
): unknown[] | undefined {
  const pendingCalls = pendingToolCalls(continuation.lastResponseItems);
  if (pendingCalls.length === 0) return undefined;

  const previousInput = continuation.lastRequestBody.input ?? [];
  const currentInput = body.input ?? [];
  if (!responseInputsEqual(currentInput.slice(0, previousInput.length), previousInput)) {
    return undefined;
  }

  const pendingByCallId = new Map(
    pendingCalls.map(({ callId, outputType }) => [callId, outputType] as const),
  );
  const outputsByCallId = new Map<string, unknown>();
  for (const item of currentInput.slice(previousInput.length)) {
    const itemType = responseItemType(item);
    const callId = responseItemCallId(item);
    const expectedOutputType = callId ? pendingByCallId.get(callId) : undefined;

    if (itemType === 'function_call_output' || itemType === 'custom_tool_call_output') {
      if (!callId || itemType !== expectedOutputType || outputsByCallId.has(callId)) {
        return undefined;
      }
      outputsByCallId.set(callId, item);
      continue;
    }

    if (responseItemRole(item) === 'user') return undefined;
  }

  if (outputsByCallId.size !== pendingCalls.length) return undefined;
  return pendingCalls.map(({ callId }) => outputsByCallId.get(callId));
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
  let delta: unknown[] | undefined;
  if (responseInputsEqual((body.input ?? []).slice(0, baseline.length), baseline)) {
    delta = (body.input ?? []).slice(baseline.length);
  } else {
    delta = buildCompleteToolOutputDelta(continuation, body);
    if (!delta) return { body, decision: 'input_prefix_mismatch' };
  }
  if (!continuation.lastResponseId) return { body, decision: 'missing_previous_response_id' };
  return {
    decision: 'delta',
    body: {
      ...body,
      previous_response_id: continuation.lastResponseId,
      input: delta,
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
