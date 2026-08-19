import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

export type RetrySettingsSource = 'pi' | 'omp' | 'prime';

export type CoreRetrySettingsLike = { enabled?: boolean; baseDelayMs: number; maxRetries: number };

const DEFAULT_SETTINGS: CoreRetrySettingsLike = { baseDelayMs: 2000, maxRetries: 3 };

let settingsSource: RetrySettingsSource = 'pi';

export function setRetrySettingsSource(source: RetrySettingsSource): void {
  settingsSource = source;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
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
    } else {
      parent[key] = parseScalarYamlValue(rest);
    }
  }

  return root;
}

function normalizeRetrySettings(raw: unknown): Partial<CoreRetrySettingsLike> {
  if (!isRecord(raw)) return {};
  const result: Partial<CoreRetrySettingsLike> = {};
  if (typeof raw.enabled === 'boolean') result.enabled = raw.enabled;
  if (typeof raw.baseDelayMs === 'number' && Number.isFinite(raw.baseDelayMs)) {
    result.baseDelayMs = raw.baseDelayMs;
  }
  if (typeof raw.maxRetries === 'number' && Number.isFinite(raw.maxRetries)) {
    result.maxRetries = raw.maxRetries;
  }
  return result;
}

function readJsonRetrySettings(path: string): Partial<CoreRetrySettingsLike> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(stripJsonComments(readFileSync(path, 'utf8'))) as unknown;
    return normalizeRetrySettings(isRecord(parsed) ? parsed.retry : undefined);
  } catch {
    return {};
  }
}

function readYamlRetrySettings(path: string): Partial<CoreRetrySettingsLike> {
  if (!existsSync(path)) return {};
  try {
    const parsed = parseSimpleYamlObject(readFileSync(path, 'utf8'));
    return normalizeRetrySettings(parsed.retry);
  } catch {
    return {};
  }
}

function ompAgentDir(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_CODING_AGENT_DIR) return env.PI_CODING_AGENT_DIR;
  if (env.OMP_PROFILE) return join(home, '.omp', 'profiles', env.OMP_PROFILE, 'agent');
  return join(home, '.omp', 'agent');
}

export function readCoreRetrySettings(cwd: string | undefined): CoreRetrySettingsLike {
  const projectDir = cwd ?? process.cwd();
  const settings = { ...DEFAULT_SETTINGS };

  if (settingsSource === 'omp') {
    Object.assign(settings, readYamlRetrySettings(join(ompAgentDir(), 'config.yml')));
    Object.assign(settings, readYamlRetrySettings(join(ompAgentDir(), 'config.yaml')));
    Object.assign(settings, readYamlRetrySettings(join(projectDir, '.omp', 'config.yml')));
    Object.assign(settings, readYamlRetrySettings(join(projectDir, '.omp', 'config.yaml')));
    return settings;
  }

  Object.assign(settings, readJsonRetrySettings(join(getAgentDir(), 'settings.json')));
  Object.assign(
    settings,
    readJsonRetrySettings(
      settingsSource === 'prime'
        ? join(projectDir, '.prime', 'agent', 'settings.json')
        : join(projectDir, '.pi', 'settings.json'),
    ),
  );
  return settings;
}
