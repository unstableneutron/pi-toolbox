import {
  appendAssistantMessageDiagnostic,
  extractDiagnosticError,
  type AssistantMessage,
  type AssistantMessageDiagnostic,
} from '@earendil-works/pi-ai';

import { shortHash } from './debug.ts';

const TRANSPORT_DIAGNOSTIC_TYPE = 'openai_websocket_transport';

const MAX_TIMELINE_EVENTS = 20;
const SENSITIVE_QUERY_PARAM =
  /(?:api[-_]?key|authorization|auth|bearer|token|secret|signature|sig|password|credential)/i;
const SIGNIFICANT_EVENT_TYPES = new Set([
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
  url?: string;
  websocketResponseId?: string;
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
  toDiagnostic(options?: AttachTransportDiagnosticOptions): AssistantMessageDiagnostic | undefined;
}

export interface AttachTransportDiagnosticOptions extends TransportDiagnosticFields {
  error?: unknown;
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
  const { error: _error, timelineEvent: _timelineEvent, ...fields } = value;
  return withoutUndefined(fields);
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
      timeline = appendTimelineEvent(timeline, {
        type,
        tMs: Math.max(0, now() - startedAt),
        ...withoutUndefined(details),
      });
      if (options.significant ?? SIGNIFICANT_EVENT_TYPES.has(type)) significant = true;
      if (typeof details.responseId === 'string') fields.websocketResponseId = details.responseId;
      if (typeof details.eventCount === 'number') fields.eventCount = details.eventCount;
      if (typeof details.attempt === 'number')
        fields.attempts = Math.max(fields.attempts ?? 0, details.attempt + 1);
      if (typeof details.connectionId === 'string') fields.connectionId = details.connectionId;
      if (typeof details.cacheStatus === 'string') fields.cacheStatus = details.cacheStatus;
    },

    set(nextFields) {
      Object.assign(fields, withoutUndefined(nextFields as Record<string, unknown>));
    },

    toDiagnostic(options = {}) {
      if (!significant) return undefined;
      const merged = { ...fields, ...diagnosticFields(options as Record<string, unknown>) };
      const details = withoutUndefined({
        ...merged,
        requestId,
        responseIdSeen: merged.responseIdSeen ?? typeof merged.websocketResponseId === 'string',
        url: sanitizedUrl,
        urlHash: shortHash(sanitizedUrl),
        timeline,
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
