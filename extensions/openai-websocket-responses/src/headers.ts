import type { Api, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';

import { headersFingerprint } from './continuation-cache.ts';
import { shortHash } from './debug.ts';
import { resolveRequestProfile, type ResolvedRequestProfile } from './profile.ts';

const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const OPENAI_BETA_RESPONSES_WEBSOCKETS = 'responses_websockets=2026-02-06';
const AUTH_DIAGNOSTIC_HEADER =
  /^(?:authorization|proxy-authorization|x-api-key|api-key|chatgpt-account-id|cookie)$/i;

interface RuntimeOsModule {
  platform(): string;
  release(): string;
  arch(): string;
}

type RuntimeProcess = {
  versions?: { node?: string; bun?: string };
  getBuiltinModule?: (specifier: string) => RuntimeOsModule | undefined;
};

type OpenAIWebSocketResponsesHeaderOptions = SimpleStreamOptions & { sessionId?: string };

function createRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `openai_websocket_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function runtimeOs(): RuntimeOsModule | undefined {
  const runtimeProcess = (globalThis as typeof globalThis & { process?: RuntimeProcess }).process;
  if (!runtimeProcess?.versions?.node && !runtimeProcess?.versions?.bun) return undefined;
  return runtimeProcess.getBuiltinModule?.('node:os') ?? runtimeProcess.getBuiltinModule?.('os');
}

function codexUserAgent(): string {
  const os = runtimeOs();
  return os ? `pi (${os.platform()} ${os.release()}; ${os.arch()})` : 'pi (browser)';
}

function decodeBase64Json(segment: string): Record<string, any> | undefined {
  try {
    const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, any>;
  } catch {
    return undefined;
  }
}

function extractAccountId(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const payload = decodeBase64Json(parts[1] ?? '');
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
}

function bearerToken(
  headers: Headers,
  options?: OpenAIWebSocketResponsesHeaderOptions,
): string | undefined {
  if (options?.apiKey) return options.apiKey;
  const authorization = headers.get('authorization');
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  return match?.[1];
}

function applyCodexBaseHeaders(
  headers: Headers,
  options?: OpenAIWebSocketResponsesHeaderOptions,
): void {
  const token = bearerToken(headers, options);
  if (token) headers.set('authorization', `Bearer ${token}`);
  const accountId = extractAccountId(token) ?? headers.get('chatgpt-account-id');
  if (accountId) headers.set('chatgpt-account-id', accountId);
  headers.set('originator', 'pi');
  headers.set('user-agent', codexUserAgent());
}

export function buildRequestHeaders(
  model: Model<Api>,
  options?: OpenAIWebSocketResponsesHeaderOptions,
  profile: ResolvedRequestProfile = resolveRequestProfile(model),
): Headers {
  const headers = new Headers(model.headers ?? {});
  for (const [key, value] of Object.entries(options?.headers ?? {})) {
    headers.set(key, value);
  }
  if (!headers.has('authorization') && options?.apiKey) {
    headers.set('authorization', `Bearer ${options.apiKey}`);
  }
  if (profile === 'codex') applyCodexBaseHeaders(headers, options);
  return headers;
}

export function buildWebSocketHeaders(
  model: Model<Api>,
  options?: OpenAIWebSocketResponsesHeaderOptions,
  profile: ResolvedRequestProfile = resolveRequestProfile(model),
): Headers {
  const headers = buildRequestHeaders(model, options, profile);
  headers.delete('accept');
  headers.delete('content-type');
  if (profile === 'codex') {
    const requestId = options?.sessionId || headers.get('x-client-request-id') || createRequestId();
    headers.delete('openai-beta');
    headers.set('openai-beta', OPENAI_BETA_RESPONSES_WEBSOCKETS);
    headers.set('x-client-request-id', requestId);
    headers.set('session-id', requestId);
  }
  return headers;
}

export interface HeadersDiagnosticFields {
  headersHash: string;
  authHeaders?: string[];
  authHeadersHash?: string;
}

export function headersDiagnosticFields(headers: Headers): HeadersDiagnosticFields {
  const entries = [...headers.entries()].sort(([a], [b]) => a.localeCompare(b));
  const authEntries = entries.filter(([key]) => AUTH_DIAGNOSTIC_HEADER.test(key));
  return {
    headersHash: shortHash(headersFingerprint(headers)) ?? '',
    authHeaders: authEntries.length > 0 ? authEntries.map(([key]) => key.toLowerCase()) : undefined,
    authHeadersHash: authEntries.length > 0 ? shortHash(JSON.stringify(authEntries)) : undefined,
  };
}
