export const PROXIED_PROVIDER_ERROR_CODES = {
  INVALID_SETTINGS: 'PROXIED_PROVIDERS_INVALID_SETTINGS',
  UNSUPPORTED_API: 'PROXIED_PROVIDER_UNSUPPORTED_API',
  INVALID_BASE_URL: 'PROXIED_PROVIDER_INVALID_BASE_URL',
  MISSING_AUTH: 'PROXIED_PROVIDER_MISSING_AUTH',
  UNSUPPORTED_TRANSPORT: 'PROXIED_PROVIDER_UNSUPPORTED_TRANSPORT',
  UPSTREAM_MODEL_REJECTED: 'PROXIED_PROVIDER_UPSTREAM_MODEL_REJECTED',
} as const;

export type ProxiedProviderErrorCode =
  (typeof PROXIED_PROVIDER_ERROR_CODES)[keyof typeof PROXIED_PROVIDER_ERROR_CODES];

export class ProxiedProviderError extends Error {
  constructor(
    readonly code: ProxiedProviderErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProxiedProviderError';
  }
}

type HeaderEntry = { name: string; value: string };

class CaseInsensitiveHeaderMap extends Map<string, HeaderEntry> {
  get(key: string): HeaderEntry | undefined {
    return super.get(key.toLowerCase());
  }

  set(key: string, value: HeaderEntry): this {
    return super.set(key.toLowerCase(), value);
  }

  has(key: string): boolean {
    return super.has(key.toLowerCase());
  }

  delete(key: string): boolean {
    return super.delete(key.toLowerCase());
  }
}

export function buildHeaderMap(
  headers: Record<string, string> | undefined,
): Map<string, HeaderEntry> {
  const map = new CaseInsensitiveHeaderMap();
  for (const [name, value] of Object.entries(headers || {})) {
    map.set(name, { name, value });
  }

  return map;
}

export function mergeResolvedHeaders(
  defaults: Record<string, string> | undefined,
  resolved: Record<string, string> | undefined,
  generated: Record<string, string> | undefined,
): Headers {
  const map = buildHeaderMap(defaults);
  for (const [key, entry] of buildHeaderMap(resolved)) map.set(key, entry);
  for (const [key, entry] of buildHeaderMap(generated)) {
    if (!map.has(key)) map.set(key, entry);
  }

  const headers = new Headers();
  for (const { name, value } of map.values()) headers.set(name, value);
  return headers;
}

export function joinBaseUrlAndPath(baseUrl: string, wrapperPath: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch (error) {
    throw new ProxiedProviderError(
      PROXIED_PROVIDER_ERROR_CODES.INVALID_BASE_URL,
      `Invalid proxied baseUrl: ${baseUrl}`,
      error,
    );
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ProxiedProviderError(
      PROXIED_PROVIDER_ERROR_CODES.INVALID_BASE_URL,
      `Unsupported proxied baseUrl scheme: ${parsed.protocol}`,
    );
  }
  if (parsed.search) {
    throw new ProxiedProviderError(
      PROXIED_PROVIDER_ERROR_CODES.INVALID_BASE_URL,
      `proxied baseUrl must not include query strings: ${baseUrl}`,
    );
  }
  if (parsed.hash) {
    throw new ProxiedProviderError(
      PROXIED_PROVIDER_ERROR_CODES.INVALID_BASE_URL,
      `proxied baseUrl must not include fragments: ${baseUrl}`,
    );
  }
  if (!wrapperPath.startsWith('/')) {
    throw new ProxiedProviderError(
      PROXIED_PROVIDER_ERROR_CODES.INVALID_BASE_URL,
      `wrapperPath must start with '/': ${wrapperPath}`,
    );
  }

  const normalized = parsed.toString().replace(/\/+$/, '');
  return `${normalized}${wrapperPath}`;
}
