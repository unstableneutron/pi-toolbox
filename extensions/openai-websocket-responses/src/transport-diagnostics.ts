import {
  appendAssistantMessageDiagnostic,
  extractDiagnosticError,
  type AssistantMessage,
  type AssistantMessageDiagnostic,
} from '@earendil-works/pi-ai';

import { shortHash } from './debug.ts';
import type { ContinuationDecision } from './continuation-cache.ts';
import type { OpenAIWebSocketResponsesSettings } from './settings.ts';

const TRANSPORT_DIAGNOSTIC_TYPE = 'openai_websocket_transport';

const MAX_TIMELINE_EVENTS = 20;
const SENSITIVE_QUERY_PARAM =
  /(?:api[-_]?key|authorization|auth|bearer|token|secret|signature|sig|password|credential)/i;
const SIGNIFICANT_EVENT_TYPES = new Set([
  'empty_response_failed_full_fallback',
  'previous_response_not_found_fallback',
  'retrieve_recovery_done',
  'retrieve_recovery_error',
  'retrieve_recovery_start',
  'sse_fallback',
  'transport_error',
  'ws_cache_stale',
  'ws_close',
  'ws_connect_error',
  'ws_error',
  'ws_retry',
  'ws_send_error',
]);

let nextRequestId = 0;

interface TransportTimelineEvent extends Record<string, unknown> {
  type: string;
  tMs: number;
}

interface TransportDiagnosticsInit {
  configuredTransport?: string;
  requestId?: string;
  requestBytes?: number;
  url?: string;
  previousResponseId?: string;
  logicalTraceId?: string;
}

export interface TransportDiagnosticFields {
  attempts?: number;
  configuredTransport?: string;
  cacheStatus?: string;
  connectionId?: string;
  eventCount?: number;
  fallbackTransport?: string;
  finalResponseId?: string;
  finalTransport?: string;
  outcome?: string;
  previousResponseId?: string;
  requestBytes?: number;
  responseIdSeen?: boolean;
  continuation?: ContinuationDecision;
  fallback?: 'previous_response_not_found' | 'empty_response_failed_without_details';
  fullInputItems?: number;
  sentInputItems?: number;
  fullBytes?: number;
  firstEventMs?: number;
  responseCreatedMs?: number;
  lastEventMs?: number;
  completedMs?: number;
  firstReplayUnsafeEventType?: string;
  replayUnsafeEventSeen?: boolean;
  url?: string;
  websocketResponseId?: string;
  logicalTraceId?: string;
  traceparent?: string;
  traceId?: string;
  spanId?: string;
  connectionTraceparent?: string;
  connectionTraceId?: string;
  connectionSpanId?: string;
}

export interface TransportDiagnosticsCollector {
  readonly requestId: string;
  hasEvent(type: string): boolean;
  isSignificant(): boolean;
  record(
    type: string,
    details?: Record<string, unknown>,
    options?: { significant?: boolean },
  ): void;
  set(fields: TransportDiagnosticFields): void;
  getFields(): TransportDiagnosticFields;
  toDiagnostic(options?: AttachTransportDiagnosticOptions): AssistantMessageDiagnostic | undefined;
}

export interface AttachTransportDiagnosticOptions extends TransportDiagnosticFields {
  error?: unknown;
  includeTimeline?: boolean;
  includeTimingFields?: boolean;
}

interface MergeTransportDiagnosticOptions extends TransportDiagnosticFields {
  error?: unknown;
  timelineEvent?: Omit<TransportTimelineEvent, 'tMs'> & { tMs?: number };
}

function nextLocalRequestId(): string {
  nextRequestId += 1;
  return `owsr_${Date.now().toString(36)}_${nextRequestId.toString(36)}`;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

function diagnosticFields(value: Record<string, unknown>): Record<string, unknown> {
  const {
    error: _error,
    timelineEvent: _timelineEvent,
    includeTimeline: _includeTimeline,
    includeTimingFields: _includeTimingFields,
    ...fields
  } = value;
  return withoutUndefined(fields);
}

function isTimingEvent(type: string): boolean {
  return (
    type === 'first_event' ||
    type === 'response_created' ||
    type === 'response_id' ||
    type === 'response_completed' ||
    type === 'response_terminal'
  );
}

function removeTimingFields(fields: TransportDiagnosticFields): TransportDiagnosticFields {
  const {
    firstEventMs: _firstEventMs,
    responseCreatedMs: _responseCreatedMs,
    lastEventMs: _lastEventMs,
    completedMs: _completedMs,
    ...rest
  } = fields;
  return rest;
}

function sanitizeUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_QUERY_PARAM.test(key)) url.searchParams.set(key, 'REDACTED');
    }
    return url.toString();
  } catch {
    return rawUrl.replace(/\/\/[^/@]+@/, '//');
  }
}

function cloneTimeline(value: unknown): TransportTimelineEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is TransportTimelineEvent => {
    return typeof item === 'object' && item !== null && typeof (item as any).type === 'string';
  });
}

function appendTimelineEvent(
  timeline: TransportTimelineEvent[],
  event: Omit<TransportTimelineEvent, 'tMs'> & { tMs?: number },
): TransportTimelineEvent[] {
  const last = timeline.at(-1);
  const tMs =
    typeof event.tMs === 'number' ? event.tMs : ((last?.tMs as number | undefined) ?? 0) + 1;
  const next = [...timeline, { ...event, tMs } as TransportTimelineEvent];
  return next.slice(-MAX_TIMELINE_EVENTS);
}

export function createTransportDiagnostics(
  init: TransportDiagnosticsInit = {},
  now: () => number = () => Date.now(),
): TransportDiagnosticsCollector {
  const startedAt = now();
  const requestId = init.requestId ?? nextLocalRequestId();
  const rawUrl = init.url;
  const sanitizedUrl = sanitizeUrl(rawUrl);
  const fields: TransportDiagnosticFields = {
    configuredTransport: init.configuredTransport,
    previousResponseId: init.previousResponseId,
    requestBytes: init.requestBytes,
    url: sanitizedUrl,
    logicalTraceId: init.logicalTraceId,
  };
  const eventTypes = new Set<string>();
  let significant = false;
  let timeline: TransportTimelineEvent[] = [];

  return {
    requestId,

    hasEvent(type) {
      return eventTypes.has(type);
    },

    isSignificant() {
      return significant;
    },

    record(type, details = {}, options = {}) {
      eventTypes.add(type);
      const tMs = Math.max(0, now() - startedAt);
      timeline = appendTimelineEvent(timeline, {
        type,
        tMs,
        ...withoutUndefined(details),
      });
      if (options.significant ?? SIGNIFICANT_EVENT_TYPES.has(type)) significant = true;
      if (type === 'first_event' && fields.firstEventMs === undefined) fields.firstEventMs = tMs;
      if (type === 'response_created' && fields.responseCreatedMs === undefined)
        fields.responseCreatedMs = tMs;
      if (type === 'response_completed' || type === 'response_terminal') fields.completedMs = tMs;
      if (isTimingEvent(type)) fields.lastEventMs = tMs;
      if (typeof details.responseId === 'string') fields.websocketResponseId = details.responseId;
      if (typeof details.eventCount === 'number') fields.eventCount = details.eventCount;
      if (typeof details.attempt === 'number')
        fields.attempts = Math.max(fields.attempts ?? 0, details.attempt + 1);
      if (typeof details.connectionId === 'string') fields.connectionId = details.connectionId;
      if (typeof details.cacheStatus === 'string') fields.cacheStatus = details.cacheStatus;
      if (typeof details.logicalTraceId === 'string')
        fields.logicalTraceId = details.logicalTraceId;
      if (typeof details.traceparent === 'string') fields.traceparent = details.traceparent;
      if (typeof details.traceId === 'string') fields.traceId = details.traceId;
      if (typeof details.spanId === 'string') fields.spanId = details.spanId;
      if (typeof details.connectionTraceparent === 'string')
        fields.connectionTraceparent = details.connectionTraceparent;
      if (typeof details.connectionTraceId === 'string')
        fields.connectionTraceId = details.connectionTraceId;
      if (typeof details.connectionSpanId === 'string')
        fields.connectionSpanId = details.connectionSpanId;
    },

    set(nextFields) {
      Object.assign(fields, withoutUndefined(nextFields as Record<string, unknown>));
    },

    getFields() {
      return { ...fields };
    },

    toDiagnostic(options = {}) {
      const mergedFields = { ...fields, ...diagnosticFields(options as Record<string, unknown>) };
      const merged =
        options.includeTimingFields === false ? removeTimingFields(mergedFields) : mergedFields;
      const hasTraceContext =
        typeof merged.logicalTraceId === 'string' ||
        typeof merged.traceparent === 'string' ||
        typeof merged.connectionTraceparent === 'string';
      if (!significant && !hasTraceContext && !options.includeTimeline) return undefined;
      const details = withoutUndefined({
        ...merged,
        requestId,
        responseIdSeen: merged.responseIdSeen ?? typeof merged.websocketResponseId === 'string',
        url: sanitizedUrl,
        urlHash: shortHash(sanitizedUrl),
        timeline: significant || options.includeTimeline ? timeline : undefined,
      });
      const diagnostic: AssistantMessageDiagnostic = {
        type: TRANSPORT_DIAGNOSTIC_TYPE,
        timestamp: Date.now(),
        details,
      };
      if ('error' in options && options.error !== undefined)
        diagnostic.error = extractDiagnosticError(options.error);
      return diagnostic;
    },
  };
}

export function shouldIncludeSuccessTimeline(
  settings: OpenAIWebSocketResponsesSettings,
  fields: Pick<TransportDiagnosticFields, 'firstEventMs' | 'responseCreatedMs'>,
  random = Math.random,
): boolean {
  const slowStartMs = fields.responseCreatedMs ?? fields.firstEventMs;
  const thresholdMs = settings.diagnostics.successTimelineSlowStartThresholdMs;
  if (thresholdMs > 0 && typeof slowStartMs === 'number' && slowStartMs >= thresholdMs) return true;
  const sampleRate = settings.diagnostics.successTimelineSampleRate;
  return sampleRate > 0 && random() < sampleRate;
}

export function attachTransportDiagnostic(
  message: AssistantMessage,
  collector: TransportDiagnosticsCollector | undefined,
  options: AttachTransportDiagnosticOptions = {},
): boolean {
  const diagnostic = collector?.toDiagnostic(options);
  if (!diagnostic) return false;
  appendAssistantMessageDiagnostic(message, diagnostic);
  return true;
}

export function extractTransportDiagnostics(message: {
  diagnostics?: AssistantMessageDiagnostic[];
}): AssistantMessageDiagnostic[] {
  return (message.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.type === TRANSPORT_DIAGNOSTIC_TYPE,
  );
}

export function mergeTransportDiagnostics(
  message: AssistantMessage,
  diagnostics: AssistantMessageDiagnostic[],
  options: MergeTransportDiagnosticOptions = {},
): boolean {
  let mergedAny = false;
  for (const diagnostic of diagnostics) {
    const timeline = cloneTimeline(diagnostic.details?.timeline);
    const nextTimeline = options.timelineEvent
      ? appendTimelineEvent(timeline, options.timelineEvent)
      : timeline;
    const nextDiagnostic: AssistantMessageDiagnostic = {
      ...diagnostic,
      timestamp: Date.now(),
      details: withoutUndefined({
        ...diagnostic.details,
        ...diagnosticFields(options as Record<string, unknown>),
        timeline: nextTimeline,
      }),
    };
    if (options.error !== undefined) nextDiagnostic.error = extractDiagnosticError(options.error);
    appendAssistantMessageDiagnostic(message, nextDiagnostic);
    mergedAny = true;
  }
  return mergedAny;
}
