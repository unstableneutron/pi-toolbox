import type { Api, Model } from '@earendil-works/pi-ai';

import type { OpenAIWebSocketResponsesSettings } from './settings.ts';

function appendPathSegment(pathname: string, segment: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  if (trimmed.endsWith(`/${segment}`)) return trimmed;
  return `${trimmed}/${segment}`;
}

function headerValue(model: Model<Api>, name: string): string | undefined {
  const headers = model.headers ?? {};
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return String(value);
  }
  return undefined;
}

function templateValue(model: Model<Api>, expression: string): string | undefined {
  if (expression === 'model.id') return model.id;
  if (expression === 'model.name') return model.name;
  if (expression === 'model.provider') return model.provider;
  if (expression.startsWith('headers.'))
    return headerValue(model, expression.slice('headers.'.length));
  return undefined;
}

function resolveQueryParamTemplate(model: Model<Api>, value: string): string | undefined {
  let unresolved = false;
  const resolved = value.replace(/\$\{([^}]+)\}/g, (_match, expression: string) => {
    const replacement = templateValue(model, expression.trim());
    if (replacement === undefined) {
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
): URL {
  for (const [key, value] of Object.entries(settings.request.queryParams)) {
    const resolved = resolveQueryParamTemplate(model, value);
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
): string {
  const url = applySettingsQueryParams(resolveResponsesBaseUrl(model), model, settings);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  return url.toString();
}

export function resolveRetrieveResponseUrl(
  model: Model<Api>,
  settings: OpenAIWebSocketResponsesSettings,
  responseId: string,
): string {
  const url = applySettingsQueryParams(resolveResponsesBaseUrl(model), model, settings);
  url.pathname = appendPathSegment(url.pathname, encodeURIComponent(responseId));
  return url.toString();
}
