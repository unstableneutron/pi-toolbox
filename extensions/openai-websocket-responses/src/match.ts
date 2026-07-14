import type { Model } from '@earendil-works/pi-ai/compat';

import type { OpenAIWebSocketResponsesSettings, ResponsesTransportPolicy } from './settings.ts';

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function configuredTransportPolicy(
  providerModel: string,
  settings: OpenAIWebSocketResponsesSettings,
): ResponsesTransportPolicy | undefined {
  let result: ResponsesTransportPolicy | undefined;
  for (const [pattern, policy] of Object.entries(settings.patch.transportByProviderModel)) {
    if (globToRegExp(pattern).test(providerModel)) result = policy;
  }
  return result;
}

export function resolveModelTransportPolicy(
  model: Pick<Model<any>, 'provider' | 'id'>,
  settings: OpenAIWebSocketResponsesSettings,
): ResponsesTransportPolicy {
  return configuredTransportPolicy(`${model.provider}/${model.id}`, settings) ?? 'auto';
}

export function shouldPatchModel(
  model: Pick<Model<any>, 'api' | 'provider' | 'id'>,
  settings: OpenAIWebSocketResponsesSettings,
): boolean {
  if (!settings.patch.enabled) return false;
  if (!matchesAny(model.api, settings.patch.apis)) return false;

  const providerModel = `${model.provider}/${model.id}`;
  if (matchesAny(providerModel, settings.patch.excludeProviderModels)) return false;

  return (
    matchesAny(model.provider, settings.patch.providers) ||
    matchesAny(providerModel, settings.patch.providerModels) ||
    configuredTransportPolicy(providerModel, settings) !== undefined
  );
}
