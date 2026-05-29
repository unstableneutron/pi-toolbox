import type { Api, Model } from '@earendil-works/pi-ai';

import { resolveRequestProfile, type ResolvedRequestProfile } from './profile.ts';
import type { OpenAIWebSocketResponsesSettings } from './settings.ts';

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';

function appendPathSegment(pathname: string, segment: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  if (trimmed.endsWith(`/${segment}`)) return trimmed;
  return `${trimmed}/${segment}`;
}

type HeaderTemplateSource = Headers | Record<string, string> | undefined;

function headerSourceValue(headers: HeaderTemplateSource, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function')
    return (headers as Headers).get(name) ?? undefined;

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return String(value);
  }
  return undefined;
}

function headerValue(
  model: Model<Api>,
  name: string,
  runtimeHeaders?: HeaderTemplateSource,
): string | undefined {
  return headerSourceValue(runtimeHeaders, name) ?? headerSourceValue(model.headers, name);
}

function templateValue(
  model: Model<Api>,
  expression: string,
  runtimeHeaders?: HeaderTemplateSource,
): string | undefined {
  if (expression === 'model.id') return model.id;
  if (expression === 'model.name') return model.name;
  if (expression === 'model.provider') return model.provider;
  if (expression.startsWith('headers.'))
    return headerValue(model, expression.slice('headers.'.length), runtimeHeaders);
  return undefined;
}

function resolveQueryParamTemplate(
  model: Model<Api>,
  key: string,
  value: string,
  runtimeHeaders?: HeaderTemplateSource,
): string | undefined {
  let unresolved = false;
  const resolved = value.replace(/\$\{([^}]+)\}/g, (_match, expression: string) => {
    const trimmedExpression = expression.trim();
    const replacement = templateValue(model, trimmedExpression, runtimeHeaders);
    if (replacement === undefined) {
      if (trimmedExpression.startsWith('headers.')) {
        throw new Error(
          `Missing header "${trimmedExpression.slice('headers.'.length)}" referenced by query param "${key}"`,
        );
      }
      unresolved = true;
      return '';
    }
    return replacement;
  });
  return unresolved ? undefined : resolved;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchesGlob(value: string, pattern: string): boolean {
  return globToRegExp(pattern).test(value);
}

function queryParamsForModel(
  settings: OpenAIWebSocketResponsesSettings,
  model: Model<Api>,
): Record<string, string> {
  const providerModel = `${model.provider}/${model.id}`;
  return {
    ...settings.request.queryParams,
    ...settings.request.queryParamsByProvider[model.provider],
    ...Object.assign(
      {},
      ...Object.entries(settings.request.queryParamsByProviderModel)
        .filter(([pattern]) => matchesGlob(providerModel, pattern))
        .map(([, queryParams]) => queryParams),
    ),
  };
}

function applySettingsQueryParams(
  url: URL,
  model: Model<Api>,
  settings: OpenAIWebSocketResponsesSettings,
  runtimeHeaders: HeaderTemplateSource,
): URL {
  for (const [key, value] of Object.entries(queryParamsForModel(settings, model))) {
    const resolved = resolveQueryParamTemplate(model, key, value, runtimeHeaders);
    if (resolved !== undefined) url.searchParams.set(key, resolved);
  }
  return url;
}

function appendCodexResponsesPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  if (trimmed.endsWith('/codex/responses')) return trimmed;
  if (trimmed.endsWith('/codex')) return `${trimmed}/responses`;
  return `${trimmed}/codex/responses`;
}

export function resolveResponsesBaseUrl(
  model: Model<Api>,
  profile: ResolvedRequestProfile = resolveRequestProfile(model),
): URL {
  if (profile === 'codex') {
    const url = new URL(model.baseUrl?.trim() || DEFAULT_CODEX_BASE_URL);
    url.pathname = appendCodexResponsesPath(url.pathname);
    return url;
  }
  if (!model.baseUrl) throw new Error('model.baseUrl is required for openai-websocket-responses');
  const url = new URL(model.baseUrl);
  url.pathname = appendPathSegment(url.pathname, 'responses');
  return url;
}

export function resolveWebSocketResponsesUrl(
  model: Model<Api>,
  settings: OpenAIWebSocketResponsesSettings,
  runtimeHeaders?: HeaderTemplateSource,
  profile: ResolvedRequestProfile = resolveRequestProfile(model, settings),
): string {
  const url = applySettingsQueryParams(
    resolveResponsesBaseUrl(model, profile),
    model,
    settings,
    runtimeHeaders,
  );
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  return url.toString();
}

export function resolveRetrieveResponseUrl(
  model: Model<Api>,
  settings: OpenAIWebSocketResponsesSettings,
  responseId: string,
  runtimeHeaders?: HeaderTemplateSource,
  profile: ResolvedRequestProfile = resolveRequestProfile(model, settings),
): string {
  const url = applySettingsQueryParams(
    resolveResponsesBaseUrl(model, profile),
    model,
    settings,
    runtimeHeaders,
  );
  url.pathname = appendPathSegment(url.pathname, encodeURIComponent(responseId));
  return url.toString();
}
