import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  ExecutorAuth,
  ExecutorEndpoint,
  ExecutorEndpointSource,
  JsonObject,
  JsonValue,
} from './types';

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_BASIC_USERNAME = 'executor';

interface FileConfig {
  url?: string;
  token?: string;
  username?: string;
  password?: string;
  requestTimeoutMs?: number;
  allowInsecureHttp?: boolean;
}

interface ServerManifest {
  connection: {
    kind: 'http';
    origin: string;
    auth?: ExecutorAuth;
  };
}

interface LoadedConfig {
  config: FileConfig;
  source: ExecutorEndpointSource;
  sourcePath: string;
}

export interface ResolveExecutorEndpointOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  readTextFile?: (path: string) => Promise<string>;
  allowProjectConfig?: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function optionalTimeout(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1000) {
    throw new Error(`${field} must be an integer of at least 1000 milliseconds`);
  }
  return value as number;
}

function parseFileConfig(raw: string, path: string): FileConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(parsed)) throw new Error(`${path} must contain a JSON object`);

  return {
    url: optionalString(parsed.url, `${path}#url`),
    token: optionalString(parsed.token, `${path}#token`),
    username: optionalString(parsed.username, `${path}#username`),
    password: optionalString(parsed.password, `${path}#password`),
    requestTimeoutMs: optionalTimeout(parsed.requestTimeoutMs, `${path}#requestTimeoutMs`),
    allowInsecureHttp: optionalBoolean(parsed.allowInsecureHttp, `${path}#allowInsecureHttp`),
  };
}

async function readOptionalConfig(
  path: string,
  source: ExecutorEndpointSource,
  readTextFile: (path: string) => Promise<string>,
): Promise<LoadedConfig | undefined> {
  try {
    return { config: parseFileConfig(await readTextFile(path), path), source, sourcePath: path };
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseEnvBoolean(value: string | undefined, field: string): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  throw new Error(`${field} must be true, false, 1, or 0`);
}

function parseEnvTimeout(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return optionalTimeout(Number(value), 'PI_EXECUTOR_REQUEST_TIMEOUT_MS');
}

function envConfig(env: NodeJS.ProcessEnv): FileConfig {
  return {
    url: optionalString(env.PI_EXECUTOR_URL, 'PI_EXECUTOR_URL'),
    token: optionalString(env.PI_EXECUTOR_TOKEN, 'PI_EXECUTOR_TOKEN'),
    username: optionalString(env.PI_EXECUTOR_USERNAME, 'PI_EXECUTOR_USERNAME'),
    password: optionalString(env.PI_EXECUTOR_PASSWORD, 'PI_EXECUTOR_PASSWORD'),
    requestTimeoutMs: parseEnvTimeout(env.PI_EXECUTOR_REQUEST_TIMEOUT_MS),
    allowInsecureHttp: parseEnvBoolean(
      env.PI_EXECUTOR_ALLOW_INSECURE_HTTP,
      'PI_EXECUTOR_ALLOW_INSECURE_HTTP',
    ),
  };
}

function mergeConfig(base: FileConfig, override: FileConfig): FileConfig {
  const endpointChanged = override.url !== undefined && override.url !== base.url;
  const authChanged =
    override.token !== undefined ||
    override.username !== undefined ||
    override.password !== undefined;
  const inheritedAuth =
    endpointChanged || authChanged
      ? { token: undefined, username: undefined, password: undefined }
      : { token: base.token, username: base.username, password: base.password };

  return {
    url: override.url ?? base.url,
    token: override.token ?? inheritedAuth.token,
    username: override.username ?? inheritedAuth.username,
    password: override.password ?? inheritedAuth.password,
    requestTimeoutMs: override.requestTimeoutMs ?? base.requestTimeoutMs,
    allowInsecureHttp: override.allowInsecureHttp ?? base.allowInsecureHttp,
  };
}

function authFromConfig(config: FileConfig): ExecutorAuth | undefined {
  if (config.token && config.password) {
    throw new Error('Configure either bearer token auth or basic password auth, not both');
  }
  if (config.token) return { kind: 'bearer', token: config.token };
  if (config.password) {
    return {
      kind: 'basic',
      username: config.username ?? DEFAULT_BASIC_USERNAME,
      password: config.password,
    };
  }
  if (config.username) throw new Error('PI Executor basic auth requires a password');
  return undefined;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function normalizeBaseUrl(raw: string, allowInsecureHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid Executor URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Executor URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('Do not put Executor credentials in the URL; use token/password settings');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && !allowInsecureHttp) {
    throw new Error(
      'Refusing to send Executor credentials over non-loopback HTTP. Use HTTPS or set allowInsecureHttp.',
    );
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

function parseManifestAuth(value: unknown, path: string): ExecutorAuth | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`${path}#connection.auth must be an object`);
  if (value.kind === 'bearer') {
    return { kind: 'bearer', token: optionalString(value.token, `${path}#connection.auth.token`)! };
  }
  if (value.kind === 'basic') {
    return {
      kind: 'basic',
      username: optionalString(value.username, `${path}#connection.auth.username`)!,
      password: optionalString(value.password, `${path}#connection.auth.password`)!,
    };
  }
  throw new Error(`${path} has an unsupported Executor auth kind`);
}

function parseServerManifest(raw: string, path: string): ServerManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(parsed) || !isObject(parsed.connection)) {
    throw new Error(`${path} is not an Executor server manifest`);
  }
  const kind = parsed.connection.kind;
  if (kind !== 'http') throw new Error(`${path} does not describe an HTTP Executor server`);
  return {
    connection: {
      kind,
      origin: optionalString(parsed.connection.origin, `${path}#connection.origin`)!,
      auth: parseManifestAuth(parsed.connection.auth, path),
    },
  };
}

async function resolveConfiguredEndpoint(
  cwd: string,
  env: NodeJS.ProcessEnv,
  homeDir: string,
  readTextFile: (path: string) => Promise<string>,
  allowProjectConfig: boolean,
): Promise<ExecutorEndpoint | undefined> {
  const explicitPath = optionalString(env.PI_EXECUTOR_CONFIG, 'PI_EXECUTOR_CONFIG');
  const globalPath = join(homeDir, '.pi', 'agent', 'pi-executor.json');
  const projectPath = join(resolve(cwd), '.pi', 'pi-executor.json');

  let loaded: LoadedConfig | undefined;
  if (explicitPath) {
    const resolvedPath = isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath);
    loaded = await readOptionalConfig(resolvedPath, 'explicit-config', readTextFile);
    if (!loaded) throw new Error(`PI_EXECUTOR_CONFIG does not exist: ${resolvedPath}`);
  } else {
    const global = await readOptionalConfig(globalPath, 'user-config', readTextFile);
    const project = allowProjectConfig
      ? await readOptionalConfig(projectPath, 'project-config', readTextFile)
      : undefined;
    if (global && project) {
      loaded = {
        config: mergeConfig(global.config, project.config),
        source: 'project-config',
        sourcePath: project.sourcePath,
      };
    } else {
      loaded = project ?? global;
    }
  }

  const fromEnv = envConfig(env);
  const config = mergeConfig(loaded?.config ?? {}, fromEnv);
  if (!config.url) return undefined;
  const environmentOverrides = Object.values(fromEnv).some((value) => value !== undefined);

  return {
    baseUrl: normalizeBaseUrl(config.url, config.allowInsecureHttp ?? false),
    auth: authFromConfig(config),
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    source: environmentOverrides ? 'environment' : (loaded?.source ?? 'environment'),
    sourcePath: environmentOverrides ? undefined : loaded?.sourcePath,
  };
}

export async function resolveExecutorEndpoint(
  cwd: string,
  options: ResolveExecutorEndpointOptions = {},
): Promise<ExecutorEndpoint> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const readTextFile = options.readTextFile ?? ((path) => readFile(path, 'utf8'));
  const configured = await resolveConfiguredEndpoint(
    cwd,
    env,
    homeDir,
    readTextFile,
    options.allowProjectConfig ?? true,
  );
  if (configured) return configured;

  const dataDir = resolve(env.EXECUTOR_DATA_DIR ?? join(homeDir, '.executor'));
  const manifestPath = join(dataDir, 'server-control', 'server.json');
  let raw: string;
  try {
    raw = await readTextFile(manifestPath);
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') {
      throw new Error(
        `No Executor endpoint configured and no running-daemon manifest found at ${manifestPath}`,
      );
    }
    throw error;
  }
  const manifest = parseServerManifest(raw, manifestPath);
  const timeout = mergeConfig({}, envConfig(env)).requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return {
    baseUrl: normalizeBaseUrl(manifest.connection.origin, false),
    auth: manifest.connection.auth,
    requestTimeoutMs: timeout,
    source: 'daemon-manifest',
    sourcePath: manifestPath,
  };
}

export function endpointAuthorizationHeader(auth: ExecutorAuth | undefined): string | undefined {
  if (!auth) return undefined;
  if (auth.kind === 'bearer') return `Bearer ${auth.token}`;
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`;
}

export function cloneJsonObject(value: object): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

export function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}
