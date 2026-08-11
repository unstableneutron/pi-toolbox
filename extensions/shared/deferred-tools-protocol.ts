import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export const DEFERRED_TOOLS_PROTOCOL_VERSION = 1 as const;
export const DEFERRED_TOOL_SEARCH_PROVIDER_EVENT = 'pi-deferred-tools:search-provider';
export const DEFERRED_TOOL_POLICY_EVENT = 'pi-deferred-tools:policy';

export interface DeferredToolProviderItem {
  name?: string;
  path?: string;
  kind: string;
  summary: string;
  state?: string;
}

export interface DeferredToolProviderResult {
  provider: string;
  items: DeferredToolProviderItem[];
  nextCursor?: string;
}

export interface DeferredToolSearchProviderRequest {
  version: typeof DEFERRED_TOOLS_PROTOCOL_VERSION;
  query: string;
  limit: number;
  cursor?: string;
  signal?: AbortSignal;
  context: ExtensionContext;
  /** Providers must append their promise before their event handler returns. */
  pending: Array<Promise<DeferredToolProviderResult>>;
}

export interface DeferredToolPolicyRequest {
  version: typeof DEFERRED_TOOLS_PROTOCOL_VERSION;
  deferredNames: Set<string>;
  handled: boolean;
}
