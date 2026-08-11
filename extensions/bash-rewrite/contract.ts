import type { createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';

import type { RewriteDecision, RewriteTool } from './bash-rewrite';

export const BASH_REWRITE_COLLECT_PROVIDERS_EVENT = 'bash-rewrite:collect-providers';
export const BASH_REWRITE_API_VERSION = 1;

/**
 * Recognizers and target names are closed for contract version 1.
 *
 * A provider can implement a known target without importing the active host,
 * but adding a new target requires a reviewed recognizer and contract change.
 * This keeps shell parsing and safety policy in one place.
 */
export const BASH_REWRITE_TARGET_POLICY = 'closed-v1' as const;

/** Higher priority wins for the same target; equal priority sorts by provider id. */
export const BASH_REWRITE_PROVIDER_PRIORITY_RULE = 'higher-priority-then-provider-id' as const;

export type BashRewriteCollectProvidersEvent = typeof BASH_REWRITE_COLLECT_PROVIDERS_EVENT;
export type BashRewriteApiVersion = typeof BASH_REWRITE_API_VERSION;

type BashTool = ReturnType<typeof createBashToolDefinition>;
type BashExecuteParams = Parameters<BashTool['execute']>;

export interface BashRewriteExecuteResult {
  content: Awaited<ReturnType<BashTool['execute']>>['content'];
  details?: unknown;
  isError?: boolean;
}

export interface BashRewriteExecuteRuntime {
  toolCallId: string;
  originalCommand: string;
  signal: AbortSignal | undefined;
  onUpdate: BashExecuteParams[3];
  ctx: BashExecuteParams[4];
}

export interface BashRewriteRenderRuntime {
  cwd?: string;
  isPartial?: boolean;
  executionStarted?: boolean;
  argsComplete?: boolean;
  state?: unknown;
  invalidate?: () => void;
}

export interface BashRewriteTheme {
  fg: (...args: any[]) => string;
  bold: (text: string) => string;
}

export interface BashRewriteProvider {
  id: string;
  priority?: number;
  tools: RewriteTool[];
  fallbackOnExecuteError?: boolean;
  execute(
    decision: RewriteDecision,
    runtime: BashRewriteExecuteRuntime,
  ): Promise<BashRewriteExecuteResult>;
  renderPreview?(
    decision: RewriteDecision,
    theme: BashRewriteTheme,
    runtime: BashRewriteRenderRuntime,
  ): Component | null;
  renderResult?(
    result: unknown,
    options: unknown,
    theme: BashRewriteTheme,
    context: unknown,
  ): Component | null;
}

export interface BashRewriteProviderCollectorPayload {
  apiVersion: BashRewriteApiVersion;
  register(provider: BashRewriteProvider): void;
}

export interface BashRewriteRouteDetails {
  [key: string]: unknown;
  routedVia: `bash-to-${RewriteTool}`;
  rewriteProviderId: string;
  rewriteRecognizer: string;
  rewriteFromCommand: string;
  rewriteToParams: Record<string, unknown>;
  rewriteCall: string;
  rewriteCwd?: string;
}
