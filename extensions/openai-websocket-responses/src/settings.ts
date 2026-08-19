import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

export type RequestProfile = 'auto' | 'azure' | 'codex' | 'generic';
export type ResponsesTransportPolicy = 'auto' | 'sse' | 'websocket';

export interface OpenAIWebSocketResponsesSettings {
  patch: {
    enabled: boolean;
    apis: string[];
    providers: string[];
    providerModels: string[];
    excludeProviderModels: string[];
    transportByProviderModel: Record<string, ResponsesTransportPolicy>;
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
    transportByProviderModel: {},
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

function transportPolicyMap(
  value: unknown,
  fallback: Record<string, ResponsesTransportPolicy>,
): Record<string, ResponsesTransportPolicy> {
  if (!isRecord(value)) return { ...fallback };
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, ResponsesTransportPolicy] =>
        entry[1] === 'auto' || entry[1] === 'sse' || entry[1] === 'websocket',
    ),
  );
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

function readSettingsKey(root: Record<string, unknown>): unknown {
  return root.openaiWebsocketResponses ?? root.openaiWebSocketResponses;
}

function parseSettingsJson(source: string): Record<string, unknown> | undefined {
  const parsed = JSON.parse(stripJsonComments(source)) as unknown;
  return isRecord(parsed) ? parsed : undefined;
}

function parseSettingsYaml(source: string): Record<string, unknown> | undefined {
  const parsed = parseSimpleYamlObject(source);
  return isRecord(parsed) ? parsed : undefined;
}

function parseScalarYamlValue(raw: string): unknown {
  const value = raw.trim();
  if (!value) return {};
  if ('true' === value) return true;
  if ('false' === value) return false;
  if ('null' === value || '~' === value) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const quoted = value.match(/^(['"])(.*)\1$/);
  return quoted?.[2] ?? value;
}

function parseSimpleYamlObject(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [
    { indent: -1, value: root },
  ];
  const pendingArrayByIndent = new Map<number, { parent: Record<string, unknown>; key: string }>();

  for (const rawLine of source.replace(/\r\n?/g, '\n').split('\n')) {
    const withoutComment = rawLine.replace(/\s+#.*$/, '');
    if (!withoutComment.trim() || withoutComment.trim() === '---') continue;
    const indent = withoutComment.match(/^ */)?.[0].length ?? 0;
    const line = withoutComment.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();
    const parent = stack[stack.length - 1]!.value;

    if (line.startsWith('- ')) {
      const pending = pendingArrayByIndent.get(indent);
      if (!pending) continue;
      const existing = pending.parent[pending.key];
      const array = Array.isArray(existing) ? existing : [];
      array.push(parseScalarYamlValue(line.slice(2)));
      pending.parent[pending.key] = array;
      continue;
    }

    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    const rest = line.slice(separatorIndex + 1).trim();
    if (!rest) {
      const value: Record<string, unknown> = {};
      parent[key] = value;
      pendingArrayByIndent.set(indent + 2, { parent, key });
      stack.push({ indent, value });
      continue;
    }
    parent[key] = parseScalarYamlValue(rest);
  }

  return root;
}

function ompProfileFromArgv(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--profile') return argv[index + 1];
    if (arg?.startsWith('--profile=')) return arg.slice('--profile='.length);
  }
  return undefined;
}

function ompAgentDir(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): string {
  if (env.PI_CODING_AGENT_DIR) return env.PI_CODING_AGENT_DIR;
  const profile = env.OMP_PROFILE ?? ompProfileFromArgv(argv);
  if (profile) return join(home, '.omp', 'profiles', profile, 'agent');
  return join(home, '.omp', 'agent');
}

export function defaultOpenAIWebSocketResponsesOmpConfigPaths(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): string[] {
  const agentDir = ompAgentDir(home, env, argv);
  return [join(agentDir, 'config.yml'), join(agentDir, 'config.yaml')];
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
      transportByProviderModel: transportPolicyMap(
        patch.transportByProviderModel,
        DEFAULT_SETTINGS.patch.transportByProviderModel,
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
    const parsed = parseSettingsJson(readFileSync(settingsPath, 'utf8'));
    return normalizeSettings(parsed ? readSettingsKey(parsed) : undefined);
  } catch {
    return normalizeSettings(undefined);
  }
}

export function readOpenAIWebSocketResponsesPrimeSettings(
  cwd = process.cwd(),
): OpenAIWebSocketResponsesSettings {
  const paths = [
    join(getAgentDir(), 'settings.json'),
    join(cwd, '.prime', 'agent', 'settings.json'),
  ];
  let settings = normalizeSettings(undefined);

  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const parsed = parseSettingsJson(readFileSync(path, 'utf8'));
      const sourceSettings = parsed ? readSettingsKey(parsed) : undefined;
      if (sourceSettings !== undefined) settings = normalizeSettings(sourceSettings);
    } catch {
      // A malformed lower-priority settings file must not disable settings from
      // the user agent directory.
    }
  }

  return settings;
}

export function readOpenAIWebSocketResponsesOmpSettings(
  configPaths: string | string[] = defaultOpenAIWebSocketResponsesOmpConfigPaths(),
): OpenAIWebSocketResponsesSettings {
  const paths = Array.isArray(configPaths) ? configPaths : [configPaths];
  for (const configPath of paths) {
    if (!existsSync(configPath)) continue;
    try {
      const parsed = parseSettingsYaml(readFileSync(configPath, 'utf8'));
      if (!parsed) continue;
      const settings = readSettingsKey(parsed);
      if (settings !== undefined) return normalizeSettings(settings);
    } catch {
      return normalizeSettings(undefined);
    }
  }
  return normalizeSettings(undefined);
}
