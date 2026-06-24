import type { Api, Model } from '@earendil-works/pi-ai/compat';

import type { OpenAIWebSocketResponsesSettings, RequestProfile } from './settings.ts';

export type ResolvedRequestProfile = Exclude<RequestProfile, 'auto'>;

function headerKeys(headers: Record<string, string> | undefined): string[] {
  return Object.keys(headers ?? {}).map((key) => key.toLowerCase());
}

function parsedBaseUrl(model: Pick<Model<Api>, 'baseUrl'>): URL | undefined {
  if (!model.baseUrl) return undefined;
  try {
    return new URL(model.baseUrl);
  } catch {
    return undefined;
  }
}

function hasAzureHeaders(model: Pick<Model<Api>, 'headers'>): boolean {
  return headerKeys(model.headers).some((key) => key.startsWith('x-azure-'));
}

function hasAzureQuery(settings: OpenAIWebSocketResponsesSettings | undefined, url?: URL): boolean {
  return !!settings?.request.queryParams['api-version'] || !!url?.searchParams.has('api-version');
}

function codexUrlSignal(url: URL | undefined): boolean {
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  return host === 'chatgpt.com' || path.includes('/backend-api') || path.includes('/codex');
}

function azureUrlSignal(url: URL | undefined): boolean {
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  return host.endsWith('.openai.azure.com') || path.includes('azure_openai');
}

export function resolveRequestProfile(
  model: Pick<Model<Api>, 'api' | 'provider' | 'id' | 'baseUrl' | 'headers'>,
  settings?: OpenAIWebSocketResponsesSettings,
): ResolvedRequestProfile {
  const configured = settings?.request.profile ?? 'auto';
  if (configured !== 'auto') return configured;

  const api = model.api.toLowerCase();
  const provider = model.provider.toLowerCase();
  if (api === 'openai-codex-responses' || provider === 'openai-codex') return 'codex';
  if (api === 'azure-openai-responses' || provider === 'azure-openai-responses') return 'azure';

  const url = parsedBaseUrl(model);
  if (codexUrlSignal(url)) return 'codex';
  if (azureUrlSignal(url) || hasAzureQuery(settings, url) || hasAzureHeaders(model)) return 'azure';
  return 'generic';
}
