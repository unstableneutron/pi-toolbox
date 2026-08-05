import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  ExecutorAuth,
  ExecutorEndpoint,
  ExecutorEndpointPreference,
  ExecutorEndpointSource,
  JsonObject,
  JsonValue,
} from './types';

const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_YIELD_AFTER_MS = 20 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 12 * 1024;
const DEFAULT_MAX_OUTPUT_LINES = 300;
const DEFAULT_BASIC_USERNAME = 'executor';
const DEFAULT_LOCAL_MCP_URL = 'http://127.0.0.1:4789/mcp';
const ENDPOINT_PREFERENCES = new Set<ExecutorEndpointPreference>([
  'auto',
  'environment',
  'config',
  'profile',
  'local',
]);

interface FileConfig {
  mcpUrl?: string;
  serverProfile?: string;
  endpointSource?: ExecutorEndpointPreference;
  token?: string;
  username?: string;
  password?: string;
  requestTimeoutMs?: number;
  yieldAfterMs?: number;
  maxOutputBytes?: number;
  maxOutputLines?: number;
  allowInsecureHttp?: boolean;
}

interface ServerManifest {
  connection: {
    kind: 'http';
    origin: string;
    auth?: ExecutorAuth;
  };
}

interface ExecutorServerProfile {
  name: string;
  connection: {
    kind: string;
    origin: string;
    auth?: {
      kind?: string;
      accessToken?: string;
      expiresAt?: number;
      token?: string;
      username?: string;
      password?: string;
    };
  };
}

interface ExecutorServerProfiles {
  defaultProfile?: string;
  profiles: ExecutorServerProfile[];
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
  now?: () => number;
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

function blankEnvironmentValue(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function optionalEndpointPreference(
  value: unknown,
  field: string,
): ExecutorEndpointPreference | undefined {
  const preference = optionalString(value, field);
  if (preference === undefined) return undefined;
  if (!ENDPOINT_PREFERENCES.has(preference as ExecutorEndpointPreference)) {
    throw new Error(`${field} must be auto, environment, config, profile, or local`);
  }
  return preference as ExecutorEndpointPreference;
}

function optionalInteger(value: unknown, field: string, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${field} must be an integer of at least ${minimum}`);
  }
  return value as number;
}

function optionalTimeout(value: unknown, field: string): number | undefined {
  return optionalInteger(value, field, 1000);
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
    mcpUrl: optionalString(parsed.mcpUrl, `${path}#mcpUrl`),
    serverProfile: optionalString(parsed.serverProfile, `${path}#serverProfile`),
    endpointSource: optionalEndpointPreference(parsed.endpointSource, `${path}#endpointSource`),
    token: optionalString(parsed.token, `${path}#token`),
    username: optionalString(parsed.username, `${path}#username`),
    password: optionalString(parsed.password, `${path}#password`),
    requestTimeoutMs: optionalTimeout(parsed.requestTimeoutMs, `${path}#requestTimeoutMs`),
    yieldAfterMs: optionalTimeout(parsed.yieldAfterMs, `${path}#yieldAfterMs`),
    maxOutputBytes: optionalInteger(parsed.maxOutputBytes, `${path}#maxOutputBytes`, 1024),
    maxOutputLines: optionalInteger(parsed.maxOutputLines, `${path}#maxOutputLines`, 10),
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

function parseEnvInteger(
  value: string | undefined,
  field: string,
  minimum: number,
): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return optionalInteger(Number(value), field, minimum);
}

function parseEnvTimeout(value: string | undefined): number | undefined {
  return parseEnvInteger(value, 'PI_EXECUTOR_REQUEST_TIMEOUT_MS', 1000);
}

function envConfig(env: NodeJS.ProcessEnv): FileConfig {
  const tokenValue =
    blankEnvironmentValue(env.PI_EXECUTOR_TOKEN) ??
    blankEnvironmentValue(env.EXECUTOR_API_KEY) ??
    blankEnvironmentValue(env.EXECUTOR_AUTH_TOKEN);
  const tokenField = env.PI_EXECUTOR_TOKEN
    ? 'PI_EXECUTOR_TOKEN'
    : env.EXECUTOR_API_KEY
      ? 'EXECUTOR_API_KEY'
      : 'EXECUTOR_AUTH_TOKEN';
  return {
    mcpUrl: optionalString(blankEnvironmentValue(env.PI_EXECUTOR_MCP_URL), 'PI_EXECUTOR_MCP_URL'),
    serverProfile: optionalString(
      blankEnvironmentValue(env.PI_EXECUTOR_SERVER),
      'PI_EXECUTOR_SERVER',
    ),
    endpointSource: optionalEndpointPreference(
      blankEnvironmentValue(env.PI_EXECUTOR_ENDPOINT_SOURCE),
      'PI_EXECUTOR_ENDPOINT_SOURCE',
    ),
    token: optionalString(tokenValue, tokenField),
    username: optionalString(
      blankEnvironmentValue(env.PI_EXECUTOR_USERNAME),
      'PI_EXECUTOR_USERNAME',
    ),
    password: optionalString(
      blankEnvironmentValue(env.PI_EXECUTOR_PASSWORD),
      'PI_EXECUTOR_PASSWORD',
    ),
    requestTimeoutMs: parseEnvTimeout(env.PI_EXECUTOR_REQUEST_TIMEOUT_MS),
    yieldAfterMs: parseEnvInteger(
      env.PI_EXECUTOR_YIELD_AFTER_MS,
      'PI_EXECUTOR_YIELD_AFTER_MS',
      1000,
    ),
    maxOutputBytes: parseEnvInteger(
      env.PI_EXECUTOR_MAX_OUTPUT_BYTES,
      'PI_EXECUTOR_MAX_OUTPUT_BYTES',
      1024,
    ),
    maxOutputLines: parseEnvInteger(
      env.PI_EXECUTOR_MAX_OUTPUT_LINES,
      'PI_EXECUTOR_MAX_OUTPUT_LINES',
      10,
    ),
    allowInsecureHttp: parseEnvBoolean(
      env.PI_EXECUTOR_ALLOW_INSECURE_HTTP,
      'PI_EXECUTOR_ALLOW_INSECURE_HTTP',
    ),
  };
}

function mergeConfig(base: FileConfig, override: FileConfig): FileConfig {
  const endpointChanged =
    (override.mcpUrl !== undefined && override.mcpUrl !== base.mcpUrl) ||
    (override.serverProfile !== undefined && override.serverProfile !== base.serverProfile);
  const authChanged =
    override.token !== undefined ||
    override.username !== undefined ||
    override.password !== undefined;
  const inheritedAuth =
    endpointChanged || authChanged
      ? { token: undefined, username: undefined, password: undefined }
      : { token: base.token, username: base.username, password: base.password };

  return {
    mcpUrl: override.mcpUrl ?? base.mcpUrl,
    serverProfile: override.serverProfile ?? base.serverProfile,
    endpointSource: override.endpointSource ?? base.endpointSource,
    token: override.token ?? inheritedAuth.token,
    username: override.username ?? inheritedAuth.username,
    password: override.password ?? inheritedAuth.password,
    requestTimeoutMs: override.requestTimeoutMs ?? base.requestTimeoutMs,
    yieldAfterMs: override.yieldAfterMs ?? base.yieldAfterMs,
    maxOutputBytes: override.maxOutputBytes ?? base.maxOutputBytes,
    maxOutputLines: override.maxOutputLines ?? base.maxOutputLines,
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

function normalizeMcpUrl(raw: string, allowInsecureHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid Executor MCP URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Executor MCP URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('Do not put Executor credentials in the URL; use token/password settings');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && !allowInsecureHttp) {
    throw new Error(
      'Refusing to send Executor credentials over non-loopback HTTP. Use HTTPS or set allowInsecureHttp.',
    );
  }
  url.hash = '';
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/mcp';
  else url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

function mcpUrlFromOrigin(origin: string, allowInsecureHttp: boolean): string {
  const url = new URL(origin);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/mcp`;
  return normalizeMcpUrl(url.toString(), allowInsecureHttp);
}

function sameServer(left: string, right: string): boolean {
  const leftUrl = new URL(left);
  const rightUrl = new URL(right);
  const sameHost =
    leftUrl.hostname === rightUrl.hostname ||
    (isLoopbackHost(leftUrl.hostname) && isLoopbackHost(rightUrl.hostname));
  return sameHost && leftUrl.protocol === rightUrl.protocol && leftUrl.port === rightUrl.port;
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

function parseServerProfiles(raw: string, path: string): ExecutorServerProfiles {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(parsed) || !Array.isArray(parsed.profiles)) {
    throw new Error(`${path} is not an Executor server profile file`);
  }
  const profiles = parsed.profiles.map((value, index): ExecutorServerProfile => {
    if (!isObject(value) || !isObject(value.connection)) {
      throw new Error(`${path}#profiles[${index}] is invalid`);
    }
    const authValue = value.connection.auth;
    const auth = isObject(authValue)
      ? {
          kind: typeof authValue.kind === 'string' ? authValue.kind : undefined,
          accessToken:
            typeof authValue.accessToken === 'string' ? authValue.accessToken : undefined,
          expiresAt: typeof authValue.expiresAt === 'number' ? authValue.expiresAt : undefined,
          token: typeof authValue.token === 'string' ? authValue.token : undefined,
          username: typeof authValue.username === 'string' ? authValue.username : undefined,
          password: typeof authValue.password === 'string' ? authValue.password : undefined,
        }
      : undefined;
    return {
      name: optionalString(value.name, `${path}#profiles[${index}].name`)!,
      connection: {
        kind: optionalString(value.connection.kind, `${path}#profiles[${index}].connection.kind`)!,
        origin: optionalString(
          value.connection.origin,
          `${path}#profiles[${index}].connection.origin`,
        )!,
        ...(auth ? { auth } : {}),
      },
    };
  });
  return {
    defaultProfile: optionalString(parsed.defaultProfile, `${path}#defaultProfile`),
    profiles,
  };
}

function profileAuth(
  profile: ExecutorServerProfile,
  path: string,
  now: number,
): { auth?: ExecutorAuth; expiresAt?: number } {
  const auth = profile.connection.auth;
  if (!auth) return {};
  if (auth.kind === 'oauth') {
    const token = optionalString(auth.accessToken, `${path}#${profile.name}.auth.accessToken`);
    if (!token) throw new Error(`Executor profile ${profile.name} is not logged in`);
    const expiresAt = auth.expiresAt
      ? auth.expiresAt < 1_000_000_000_000
        ? auth.expiresAt * 1000
        : auth.expiresAt
      : undefined;
    if (expiresAt !== undefined && expiresAt <= now) {
      throw new Error(
        `Executor profile ${profile.name} login expired. Run: executor login --server ${profile.name}`,
      );
    }
    return { auth: { kind: 'bearer', token }, ...(expiresAt ? { expiresAt } : {}) };
  }
  if (auth.kind === 'bearer') {
    return {
      auth: {
        kind: 'bearer',
        token: optionalString(auth.token, `${path}#${profile.name}.auth.token`)!,
      },
    };
  }
  if (auth.kind === 'basic') {
    return {
      auth: {
        kind: 'basic',
        username: optionalString(auth.username, `${path}#${profile.name}.auth.username`)!,
        password: optionalString(auth.password, `${path}#${profile.name}.auth.password`)!,
      },
    };
  }
  throw new Error(
    `Executor profile ${profile.name} uses unsupported auth: ${auth.kind ?? 'unknown'}`,
  );
}

async function loadPiConfig(
  cwd: string,
  env: NodeJS.ProcessEnv,
  homeDir: string,
  readTextFile: (path: string) => Promise<string>,
  allowProjectConfig: boolean,
): Promise<LoadedConfig | undefined> {
  const explicitPath = optionalString(
    blankEnvironmentValue(env.PI_EXECUTOR_CONFIG),
    'PI_EXECUTOR_CONFIG',
  );
  const globalPath = join(homeDir, '.pi', 'agent', 'pi-executor.json');
  const projectPath = join(resolve(cwd), '.pi', 'pi-executor.json');
  if (explicitPath) {
    const resolvedPath = isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath);
    const loaded = await readOptionalConfig(resolvedPath, 'explicit-config', readTextFile);
    if (!loaded) throw new Error(`PI_EXECUTOR_CONFIG does not exist: ${resolvedPath}`);
    return loaded;
  }

  const global = await readOptionalConfig(globalPath, 'user-config', readTextFile);
  const project = allowProjectConfig
    ? await readOptionalConfig(projectPath, 'project-config', readTextFile)
    : undefined;
  if (global && project) {
    return {
      config: mergeConfig(global.config, project.config),
      source: 'project-config',
      sourcePath: project.sourcePath,
    };
  }
  return project ?? global;
}

function runtimeSettings(
  config: FileConfig,
): Pick<
  ExecutorEndpoint,
  'requestTimeoutMs' | 'yieldAfterMs' | 'maxOutputBytes' | 'maxOutputLines'
> {
  return {
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    yieldAfterMs: config.yieldAfterMs ?? DEFAULT_YIELD_AFTER_MS,
    maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    maxOutputLines: config.maxOutputLines ?? DEFAULT_MAX_OUTPUT_LINES,
  };
}

function withoutEndpointSelection(config: FileConfig): FileConfig {
  return { ...config, mcpUrl: undefined, serverProfile: undefined, endpointSource: undefined };
}

async function readOptionalText(
  path: string,
  readTextFile: (path: string) => Promise<string>,
): Promise<string | undefined> {
  try {
    return await readTextFile(path);
  } catch (error) {
    if (isObject(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function directEndpoint(
  mcpUrl: string,
  config: FileConfig,
  source: ExecutorEndpointSource,
  sourcePath?: string,
): ExecutorEndpoint {
  return {
    mcpUrl: normalizeMcpUrl(mcpUrl, config.allowInsecureHttp ?? false),
    auth: authFromConfig(config),
    ...runtimeSettings(config),
    source,
    ...(sourcePath ? { sourcePath } : {}),
  };
}

export async function resolveExecutorEndpoint(
  cwd: string,
  options: ResolveExecutorEndpointOptions = {},
): Promise<ExecutorEndpoint> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const readTextFile = options.readTextFile ?? ((path) => readFile(path, 'utf8'));
  const loaded = await loadPiConfig(
    cwd,
    env,
    homeDir,
    readTextFile,
    options.allowProjectConfig ?? true,
  );
  const fromEnv = envConfig(env);
  const commonSettings = mergeConfig(loaded?.config ?? {}, withoutEndpointSelection(fromEnv));
  const merged = mergeConfig(loaded?.config ?? {}, fromEnv);
  const preference = fromEnv.endpointSource ?? loaded?.config.endpointSource ?? 'auto';
  const dataDir = resolve(env.EXECUTOR_DATA_DIR ?? join(homeDir, '.executor'));
  const profilesPath = join(dataDir, 'server-connections.json');
  const manifestPath = join(dataDir, 'server-control', 'server.json');

  const environmentEndpoint = (): ExecutorEndpoint | undefined => {
    if (!fromEnv.mcpUrl) return undefined;
    return directEndpoint(fromEnv.mcpUrl, merged, 'environment');
  };

  const configuredEndpoint = (): ExecutorEndpoint | undefined => {
    if (!loaded?.config.mcpUrl) return undefined;
    const settings = mergeConfig(loaded.config, withoutEndpointSelection(fromEnv));
    return directEndpoint(loaded.config.mcpUrl, settings, loaded.source, loaded.sourcePath);
  };

  const localEndpoint = async (): Promise<ExecutorEndpoint> => {
    const raw = await readOptionalText(manifestPath, readTextFile);
    const envAuth = authFromConfig(withoutEndpointSelection(fromEnv));
    if (!raw) {
      return {
        mcpUrl: DEFAULT_LOCAL_MCP_URL,
        auth: envAuth,
        ...runtimeSettings(commonSettings),
        source: 'localhost-default',
      };
    }
    const manifest = parseServerManifest(raw, manifestPath);
    return {
      mcpUrl: mcpUrlFromOrigin(manifest.connection.origin, false),
      auth: envAuth ?? manifest.connection.auth,
      ...runtimeSettings(commonSettings),
      source: 'daemon-manifest',
      sourcePath: manifestPath,
    };
  };

  let cachedProfiles: ExecutorServerProfiles | undefined;
  const loadProfiles = async (required: boolean): Promise<ExecutorServerProfiles | undefined> => {
    if (cachedProfiles) return cachedProfiles;
    const raw = await readOptionalText(profilesPath, readTextFile);
    if (!raw) {
      if (required) throw new Error(`Executor server profiles not found at ${profilesPath}`);
      return undefined;
    }
    cachedProfiles = parseServerProfiles(raw, profilesPath);
    return cachedProfiles;
  };

  const profileEndpoint = async (
    requestedName: string | undefined,
    required: boolean,
  ): Promise<ExecutorEndpoint | undefined> => {
    const profiles = await loadProfiles(required);
    if (!profiles) return undefined;
    const name = requestedName ?? profiles.defaultProfile;
    if (!name) {
      if (required) throw new Error(`No default Executor server profile in ${profilesPath}`);
      return undefined;
    }
    const profile = profiles.profiles.find((candidate) => candidate.name === name);
    if (!profile) throw new Error(`Executor server profile not found: ${name}`);
    if (profile.connection.kind !== 'http' && profile.connection.kind !== 'desktop-sidecar') {
      throw new Error(`Executor server profile ${name} is not an HTTP server`);
    }
    const envAuth = authFromConfig(withoutEndpointSelection(fromEnv));
    const stored = envAuth ? {} : profileAuth(profile, profilesPath, (options.now ?? Date.now)());
    let localManifestAuth: ExecutorAuth | undefined;
    if (!envAuth && !stored.auth && isLoopbackHost(new URL(profile.connection.origin).hostname)) {
      const raw = await readOptionalText(manifestPath, readTextFile);
      if (raw) {
        const manifest = parseServerManifest(raw, manifestPath);
        if (sameServer(profile.connection.origin, manifest.connection.origin)) {
          localManifestAuth = manifest.connection.auth;
        }
      }
    }
    return {
      mcpUrl: mcpUrlFromOrigin(
        profile.connection.origin,
        commonSettings.allowInsecureHttp ?? false,
      ),
      auth: envAuth ?? stored.auth ?? localManifestAuth,
      ...runtimeSettings(commonSettings),
      source: 'executor-profile',
      sourcePath: profilesPath,
      profileName: profile.name,
      ...(stored.expiresAt ? { authExpiresAt: stored.expiresAt } : {}),
    };
  };

  if (preference === 'environment') {
    const endpoint = environmentEndpoint();
    if (!endpoint)
      throw new Error('PI_EXECUTOR_ENDPOINT_SOURCE=environment requires PI_EXECUTOR_MCP_URL');
    return endpoint;
  }
  if (preference === 'config') {
    const endpoint = configuredEndpoint();
    if (!endpoint)
      throw new Error('PI_EXECUTOR_ENDPOINT_SOURCE=config requires mcpUrl in Pi Executor config');
    return endpoint;
  }
  if (preference === 'profile') {
    return (await profileEndpoint(fromEnv.serverProfile ?? loaded?.config.serverProfile, true))!;
  }
  if (preference === 'local') return localEndpoint();

  const endpointFromEnvironment = environmentEndpoint();
  if (endpointFromEnvironment) return endpointFromEnvironment;
  if (fromEnv.serverProfile) return (await profileEndpoint(fromEnv.serverProfile, true))!;
  const endpointFromConfig = configuredEndpoint();
  if (endpointFromConfig) return endpointFromConfig;
  if (loaded?.config.serverProfile) {
    return (await profileEndpoint(loaded.config.serverProfile, true))!;
  }
  return (await profileEndpoint(undefined, false)) ?? localEndpoint();
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
