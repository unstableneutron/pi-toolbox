import type { Api, Model } from '@earendil-works/pi-ai';

import type { OpenAIWebSocketResponsesSettings } from './settings.ts';

function appendPathSegment(pathname: string, segment: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  if (trimmed.endsWith(`/${segment}`)) return trimmed;
  return `${trimmed}/${segment}`;
}

function applySettingsQueryParams(url: URL, settings: OpenAIWebSocketResponsesSettings): URL {
  for (const [key, value] of Object.entries(settings.request.queryParams)) {
    url.searchParams.set(key, value);
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
  const url = applySettingsQueryParams(resolveResponsesBaseUrl(model), settings);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  return url.toString();
}

export function resolveRetrieveResponseUrl(
  model: Model<Api>,
  settings: OpenAIWebSocketResponsesSettings,
  responseId: string,
): string {
  const url = applySettingsQueryParams(resolveResponsesBaseUrl(model), settings);
  url.pathname = appendPathSegment(url.pathname, encodeURIComponent(responseId));
  return url.toString();
}
