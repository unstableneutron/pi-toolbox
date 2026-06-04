import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type RequestProfile = 'auto' | 'azure' | 'codex' | 'generic';

export interface OpenAIWebSocketResponsesSettings {
  patch: {
    enabled: boolean;
    apis: string[];
    providers: string[];
    providerModels: string[];
    excludeProviderModels: string[];
  };
  request: {
    profile: RequestProfile;
    queryParams: Record<string, string>;
    queryParamsByProvider: Record<string, Record<string, string>>;
    queryParamsByProviderModel: Record<string, Record<string, string>>;
    storeByProviderModel: Record<string, boolean>;
  };
  websocket: {
    retries: number;
    connectTimeoutMs: number;
    firstEventTimeoutMs: number;
    idleTimeoutMs: number;
  };
  diagnostics: {
    successTimingFields: boolean;
    successTimelineSampleRate: number;
    successTimelineSlowStartThresholdMs: number;
  };
  debug: {
    enabled: boolean;
    logFile: string | undefined;
  };
  recovery: {
    enabled: boolean;
    pollIntervalMs: number;
    timeoutMs: number;
    notFoundGraceMs: number;
    emitSyntheticDeltas: boolean;
  };
  trace: {
    enabled: boolean;
  };
}

const DEFAULT_SETTINGS: OpenAIWebSocketResponsesSettings = {
  patch: {
    enabled: true,
    apis: ['openai-responses', 'openai-codex-responses'],
    providers: ['openai', 'openai-codex'],
    providerModels: [],
    excludeProviderModels: [],
  },
  request: {
    profile: 'auto',
    queryParams: {},
    queryParamsByProvider: {},
    queryParamsByProviderModel: {},
    storeByProviderModel: {},
  },
  websocket: { retries: 2, connectTimeoutMs: 15000, firstEventTimeoutMs: 60000, idleTimeoutMs: 0 },
  diagnostics: {
    successTimingFields: true,
    successTimelineSampleRate: 0.05,
    successTimelineSlowStartThresholdMs: 30000,
  },
  debug: { enabled: false, logFile: undefined },
  recovery: {
    enabled: true,
    pollIntervalMs: 1000,
    timeoutMs: 30000,
    notFoundGraceMs: 5000,
    emitSyntheticDeltas: true,
  },
  trace: { enabled: true },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const result = value.filter((item): item is string => typeof item === 'string');
  return result.length > 0 || value.length === 0 ? result : [...fallback];
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sampleRate(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(1, value);
}

function stripJsonComments(source: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    const next = source[index + 1];

    if (inLineComment) {
      if (char === '\n' || char === '\r') {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index++;
      } else if (char === '\n' || char === '\r') {
        result += char;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      index++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      index++;
      continue;
    }
    result += char;
  }

  return result;
}

function requestProfile(value: unknown): RequestProfile {
  return value === 'azure' || value === 'codex' || value === 'generic' ? value : 'auto';
}

function queryParams(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string | number | boolean] => {
        const item = entry[1];
        return typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean';
      })
      .map(([key, value]) => [key, String(value)]),
  );
}

function queryParamsMap(value: unknown): Record<string, Record<string, string>> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      .map(([key, item]) => [key, queryParams(item)]),
  );
}

function booleanMap(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
    ),
  );
}

export function normalizeSettings(raw: unknown): OpenAIWebSocketResponsesSettings {
  const root = isRecord(raw) ? raw : {};
  const patch = isRecord(root.patch) ? root.patch : {};
  const request = isRecord(root.request) ? root.request : {};
  const websocket = isRecord(root.websocket) ? root.websocket : {};
  const diagnostics = isRecord(root.diagnostics) ? root.diagnostics : {};
  const debug = isRecord(root.debug) ? root.debug : {};
  const recovery = isRecord(root.recovery) ? root.recovery : {};
  const trace = isRecord(root.trace) ? root.trace : {};

  return {
    patch: {
      enabled: booleanValue(patch.enabled, DEFAULT_SETTINGS.patch.enabled),
      apis: stringArray(patch.apis, DEFAULT_SETTINGS.patch.apis),
      providers: stringArray(patch.providers, DEFAULT_SETTINGS.patch.providers),
      providerModels: stringArray(patch.providerModels, DEFAULT_SETTINGS.patch.providerModels),
      excludeProviderModels: stringArray(
        patch.excludeProviderModels,
        DEFAULT_SETTINGS.patch.excludeProviderModels,
      ),
    },
    request: {
      profile: requestProfile(request.profile),
      queryParams: queryParams(request.queryParams),
      queryParamsByProvider: queryParamsMap(request.queryParamsByProvider),
      queryParamsByProviderModel: queryParamsMap(request.queryParamsByProviderModel),
      storeByProviderModel: booleanMap(request.storeByProviderModel),
    },
    websocket: {
      retries: nonNegativeNumber(websocket.retries, DEFAULT_SETTINGS.websocket.retries),
      connectTimeoutMs: nonNegativeNumber(
        websocket.connectTimeoutMs,
        DEFAULT_SETTINGS.websocket.connectTimeoutMs,
      ),
      firstEventTimeoutMs: nonNegativeNumber(
        websocket.firstEventTimeoutMs,
        DEFAULT_SETTINGS.websocket.firstEventTimeoutMs,
      ),
      idleTimeoutMs: nonNegativeNumber(
        websocket.idleTimeoutMs,
        DEFAULT_SETTINGS.websocket.idleTimeoutMs,
      ),
    },
    diagnostics: {
      successTimingFields: booleanValue(
        diagnostics.successTimingFields,
        DEFAULT_SETTINGS.diagnostics.successTimingFields,
      ),
      successTimelineSampleRate: sampleRate(
        diagnostics.successTimelineSampleRate,
        DEFAULT_SETTINGS.diagnostics.successTimelineSampleRate,
      ),
      successTimelineSlowStartThresholdMs: nonNegativeNumber(
        diagnostics.successTimelineSlowStartThresholdMs,
        DEFAULT_SETTINGS.diagnostics.successTimelineSlowStartThresholdMs,
      ),
    },
    debug: {
      enabled: booleanValue(debug.enabled, DEFAULT_SETTINGS.debug.enabled),
      logFile:
        typeof debug.logFile === 'string' && debug.logFile.length > 0 ? debug.logFile : undefined,
    },
    recovery: {
      enabled: booleanValue(recovery.enabled, DEFAULT_SETTINGS.recovery.enabled),
      pollIntervalMs: nonNegativeNumber(
        recovery.pollIntervalMs,
        DEFAULT_SETTINGS.recovery.pollIntervalMs,
      ),
      timeoutMs: nonNegativeNumber(recovery.timeoutMs, DEFAULT_SETTINGS.recovery.timeoutMs),
      notFoundGraceMs: nonNegativeNumber(
        recovery.notFoundGraceMs,
        DEFAULT_SETTINGS.recovery.notFoundGraceMs,
      ),
      emitSyntheticDeltas: booleanValue(
        recovery.emitSyntheticDeltas,
        DEFAULT_SETTINGS.recovery.emitSyntheticDeltas,
      ),
    },
    trace: {
      enabled: booleanValue(trace.enabled, DEFAULT_SETTINGS.trace.enabled),
    },
  };
}

export function readOpenAIWebSocketResponsesSettings(
  settingsPath = join(homedir(), '.pi', 'agent', 'settings.json'),
): OpenAIWebSocketResponsesSettings {
  if (!existsSync(settingsPath)) return normalizeSettings(undefined);
  try {
    const parsed = JSON.parse(stripJsonComments(readFileSync(settingsPath, 'utf8'))) as Record<
      string,
      unknown
    >;
    return normalizeSettings(parsed.openaiWebsocketResponses ?? parsed.openaiWebSocketResponses);
  } catch {
    return normalizeSettings(undefined);
  }
}
