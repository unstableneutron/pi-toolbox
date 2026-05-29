import type { Api, Model } from '@earendil-works/pi-ai';

import type { OpenAIWebSocketResponsesSettings } from './settings.ts';

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

function applySettingsQueryParams(
  url: URL,
  model: Model<Api>,
  settings: OpenAIWebSocketResponsesSettings,
  runtimeHeaders?: HeaderTemplateSource,
): URL {
  for (const [key, value] of Object.entries(settings.request.queryParams)) {
    const resolved = resolveQueryParamTemplate(model, key, value, runtimeHeaders);
    if (resolved !== undefined) url.searchParams.set(key, resolved);
  }
  return url;
}

export function resolveResponsesBaseUrl(model: Model<Api>): URL {
  if (!model.baseUrl) throw new Error('model.baseUrl is required for openai-websocket-responses');
  const url = new URL(model.baseUrl);
  url.pathname = appendPathSegment(url.pathname, 'responses');
  return url;
}

export function resolveWebSocketResponsesUrl(
  model: Model<Api>,
  settings: OpenAIWebSocketResponsesSettings,
  runtimeHeaders?: HeaderTemplateSource,
): string {
  const url = applySettingsQueryParams(
    resolveResponsesBaseUrl(model),
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
): string {
  const url = applySettingsQueryParams(
    resolveResponsesBaseUrl(model),
    model,
    settings,
    runtimeHeaders,
  );
  url.pathname = appendPathSegment(url.pathname, encodeURIComponent(responseId));
  return url.toString();
}
