import { randomBytes } from 'node:crypto';

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceparent: string;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = '00000000000000000000000000000000';
const ZERO_SPAN_ID = '0000000000000000';

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(buffer);
  } else {
    buffer.set(randomBytes(bytes));
  }
  return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomNonZeroHex(bytes: number, zeroValue: string): string {
  let value = randomHex(bytes);
  while (value === zeroValue) value = randomHex(bytes);
  return value;
}

export function parseTraceparent(value: string | undefined): TraceContext | undefined {
  const match = value?.match(TRACEPARENT_RE);
  if (!match) return undefined;
  const traceId = match[1]!;
  const spanId = match[2]!;
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return undefined;
  return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-01` };
}

export function isTraceparent(value: string | undefined): boolean {
  return parseTraceparent(value) !== undefined;
}

export function createTraceContext(parentTraceparent?: string): TraceContext {
  const traceId =
    parseTraceparent(parentTraceparent)?.traceId ?? randomNonZeroHex(16, ZERO_TRACE_ID);
  return createTraceContextForTraceId(traceId);
}

export function createTraceContextForTraceId(traceId: string): TraceContext {
  const normalizedTraceId =
    /^[0-9a-f]{32}$/.test(traceId) && traceId !== ZERO_TRACE_ID
      ? traceId
      : randomNonZeroHex(16, ZERO_TRACE_ID);
  const spanId = randomNonZeroHex(8, ZERO_SPAN_ID);
  return {
    traceId: normalizedTraceId,
    spanId,
    traceparent: `00-${normalizedTraceId}-${spanId}-01`,
  };
}

export function cloneHeadersWithTraceparent(
  headers: Headers,
  trace: TraceContext | undefined,
): Headers {
  if (!trace) return headers;
  const next = new Headers(headers);
  next.set('traceparent', trace.traceparent);
  return next;
}
