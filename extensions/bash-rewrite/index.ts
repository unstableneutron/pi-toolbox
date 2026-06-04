import type { Component } from '@earendil-works/pi-tui';
import { Text } from '@earendil-works/pi-tui';
import {
  createBashToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

import {
  tryRewriteBashWithOptions,
  type RewriteDecision,
  type RewriteResult,
  type RewriteTool,
} from './bash-rewrite';
import { TOOL_REWRITE_ARROW } from '../shared/rewrite-label';

export const BASH_REWRITE_COLLECT_PROVIDERS_EVENT = 'bash-rewrite:collect-providers';
export const BASH_REWRITE_API_VERSION = 1;

const BUILTIN_TOOL_TIMEOUT_MS = 10_000;
const PASS_THROUGH_EXPENSIVE_TIMEOUT_MS = 60_000;
const EXPENSIVE_BASH_TOKENS: ReadonlySet<string> = new Set([
  'grep',
  'rg',
  'egrep',
  'fgrep',
  'find',
  'fd',
  'fdfind',
  'ag',
  'ack',
  'tree',
]);
const EXPENSIVE_BASH_TOKEN_PATTERN = new RegExp(
  `\\b(?:${[...EXPENSIVE_BASH_TOKENS].join('|')})\\b`,
);

type ToolContentEntry = { type: 'text'; text: string } | { type: string; [key: string]: unknown };
type BashTool = ReturnType<typeof createBashToolDefinition>;
type BashExecuteParams = Parameters<BashTool['execute']>;
type BashExecuteResult = Awaited<ReturnType<BashTool['execute']>>;

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

export interface BashRewriteProvider {
  id: string;
  priority?: number;
  tools: RewriteTool[];
  fallbackOnExecuteError?: boolean;
  execute(
    decision: RewriteDecision,
    runtime: BashRewriteExecuteRuntime,
  ): Promise<BashExecuteResult>;
  renderPreview?(
    decision: RewriteDecision,
    theme: { fg: (...args: any[]) => string; bold?: (text: string) => string },
    runtime: BashRewriteRenderRuntime,
  ): Component | null;
  renderResult?(
    result: unknown,
    options: unknown,
    theme: { fg: (...args: any[]) => string; bold?: (text: string) => string },
    context: unknown,
  ): Component | null;
}

interface ProviderCollectorPayload {
  apiVersion: number;
  register(provider: BashRewriteProvider): void;
}

function withBuiltinToolTimeout(
  signal: AbortSignal | undefined,
  timeoutMs = BUILTIN_TOOL_TIMEOUT_MS,
) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export function bashCommandContainsExpensiveTool(command: string): boolean {
  return EXPENSIVE_BASH_TOKEN_PATTERN.test(command);
}

function capPassThroughBashSignal(
  command: string,
  signal: AbortSignal | undefined,
  timeoutMs: number = PASS_THROUGH_EXPENSIVE_TIMEOUT_MS,
): { signal: AbortSignal; warning: string } | null {
  if (!bashCommandContainsExpensiveTool(command)) return null;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const seconds = Math.round(timeoutMs / 1000);
  return { signal: combined, warning: `(${seconds}s timeout)` };
}

function prependNoticeToContent(
  result: { content: ReadonlyArray<unknown>; details?: unknown },
  notice: string,
  extraDetails: Record<string, unknown>,
): BashExecuteResult {
  const entries = result.content as ReadonlyArray<ToolContentEntry>;
  const first = entries[0];
  const updatedContent: ToolContentEntry[] =
    first && first.type === 'text'
      ? [
          { type: 'text' as const, text: `${notice}\n\n${(first as { text: string }).text}` },
          ...entries.slice(1),
        ]
      : [{ type: 'text' as const, text: notice }, ...entries];

  return {
    content: updatedContent as BashExecuteResult['content'],
    details: {
      ...(result.details && typeof result.details === 'object' ? result.details : {}),
      ...extraDetails,
    } as BashExecuteResult['details'],
  };
}

function prependBashNotice(result: BashExecuteResult, notice: string): BashExecuteResult {
  return prependNoticeToContent(result, notice, { rewriteNoticeOnly: true });
}

function mergeRewriteDetails(
  result: BashExecuteResult,
  extraDetails: Record<string, unknown>,
): BashExecuteResult {
  return {
    ...result,
    details: {
      ...(result.details as Record<string, unknown> | undefined),
      ...extraDetails,
    } as BashExecuteResult['details'],
  };
}

function collectExternalProviders(pi: ExtensionAPI): BashRewriteProvider[] {
  const providers = new Map<string, BashRewriteProvider>();
  const payload: ProviderCollectorPayload = {
    apiVersion: BASH_REWRITE_API_VERSION,
    register(provider) {
      if (!provider || !provider.id || provider.tools.length === 0) return;
      providers.set(provider.id, provider);
    },
  };
  pi.events.emit(BASH_REWRITE_COLLECT_PROVIDERS_EVENT, payload);
  return [...providers.values()].sort((a, b) => {
    const priority = (b.priority ?? 0) - (a.priority ?? 0);
    return priority !== 0 ? priority : a.id.localeCompare(b.id);
  });
}

function getActiveToolSet(pi: ExtensionAPI): Set<string> | null {
  try {
    const active = pi.getActiveTools?.();
    return Array.isArray(active) ? new Set(active) : null;
  } catch {
    return null;
  }
}

function isToolActive(activeTools: Set<string> | null, toolName: string): boolean {
  return activeTools === null || activeTools.has(toolName);
}

function createBuiltinProviders(activeTools: Set<string> | null): BashRewriteProvider[] {
  const providers: BashRewriteProvider[] = [];
  if (isToolActive(activeTools, 'read')) {
    providers.push({
      id: 'bash-rewrite.builtin-read',
      priority: 0,
      tools: ['read'],
      async execute(decision, runtime) {
        const readTool = createReadToolDefinition(runtime.ctx.cwd);
        return readTool.execute(
          runtime.toolCallId,
          decision.params as { path: string; offset?: number; limit?: number },
          withBuiltinToolTimeout(runtime.signal),
          runtime.onUpdate,
          runtime.ctx,
        );
      },
      renderResult(result, options, theme, context) {
        const params = getRewriteToParams(result);
        if (!params) return null;
        const readTool = createReadToolDefinition(
          (context as { cwd?: string } | undefined)?.cwd ?? process.cwd(),
        );
        return (
          readTool.renderResult?.(
            result as never,
            options as never,
            theme as never,
            { ...(context as Record<string, unknown> | undefined), args: params } as never,
          ) ?? null
        );
      },
    });
  }
  if (isToolActive(activeTools, 'ls')) {
    providers.push({
      id: 'bash-rewrite.builtin-ls',
      priority: 0,
      tools: ['ls'],
      async execute(decision, runtime) {
        const lsTool = createLsToolDefinition(runtime.ctx.cwd);
        return lsTool.execute(
          runtime.toolCallId,
          decision.params as { path?: string; limit?: number },
          withBuiltinToolTimeout(runtime.signal),
          runtime.onUpdate,
          runtime.ctx,
        );
      },
      renderResult(result, options, theme, context) {
        const params = getRewriteToParams(result);
        if (!params) return null;
        const lsTool = createLsToolDefinition(
          (context as { cwd?: string } | undefined)?.cwd ?? process.cwd(),
        );
        return (
          lsTool.renderResult?.(
            result as never,
            options as never,
            theme as never,
            { ...(context as Record<string, unknown> | undefined), args: params } as never,
          ) ?? null
        );
      },
    });
  }
  return providers;
}

function getProviders(pi: ExtensionAPI): BashRewriteProvider[] {
  const activeTools = getActiveToolSet(pi);
  const all = [...collectExternalProviders(pi), ...createBuiltinProviders(activeTools)];
  return all.filter((provider) => provider.tools.some((tool) => isToolActive(activeTools, tool)));
}

function enabledRewriteTools(providers: BashRewriteProvider[]): Set<string> {
  return new Set(providers.flatMap((provider) => provider.tools));
}

function findProviderForDecision(
  providers: BashRewriteProvider[],
  decision: RewriteDecision,
): BashRewriteProvider | null {
  return providers.find((provider) => provider.tools.includes(decision.tool)) ?? null;
}

function extractBashCommand(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const command = (args as { command?: unknown }).command;
  return typeof command === 'string' ? command : null;
}

function getRewriteToParams(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return null;
  const params = (details as { rewriteToParams?: unknown }).rewriteToParams;
  return params && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : null;
}

function renderParamsForSignature(params: Record<string, unknown>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) =>
        `${key}=${typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)}`,
    )
    .join(', ');
}

function renderGenericPreview(
  decision: RewriteDecision,
  theme: { fg: (...args: any[]) => string; bold?: (text: string) => string },
): Component {
  const title = theme.fg('dim', `bash${TOOL_REWRITE_ARROW}`);
  const tool = theme.fg('toolTitle', theme.bold ? theme.bold(decision.tool) : decision.tool);
  return new Text(`${title}${tool}(${renderParamsForSignature(decision.params)})`, 0, 0);
}

function routeDetails(args: {
  decision: RewriteDecision;
  provider: BashRewriteProvider;
  originalCommand: string;
  notice: string;
  cwd?: string;
}): Record<string, unknown> {
  return {
    routedVia: `bash-to-${args.decision.tool}`,
    rewriteProviderId: args.provider.id,
    rewriteRecognizer: args.decision.recognizer,
    rewriteFromCommand: args.originalCommand,
    rewriteToParams: args.decision.params,
    rewriteCall: args.notice,
    ...(args.cwd ? { rewriteCwd: args.cwd } : {}),
  };
}

function renderBashRewritePreview(
  pi: ExtensionAPI,
  args: unknown,
  theme: { fg: (...args: any[]) => string; bold?: (text: string) => string },
  context: unknown,
): Component | null {
  const command = extractBashCommand(args);
  if (!command) return null;
  const renderContext =
    context && typeof context === 'object' ? (context as Record<string, unknown>) : {};
  const cwd = typeof renderContext.cwd === 'string' ? renderContext.cwd : undefined;
  const providers = getProviders(pi);
  const rewrite = tryRewriteBashWithOptions(command, cwd ?? process.cwd(), {
    enabledTools: enabledRewriteTools(providers),
  });
  if (!rewrite?.decision) return null;
  const provider = findProviderForDecision(providers, rewrite.decision);
  if (!provider) return null;
  const effectiveCwd = rewrite.cwd ?? cwd;
  return (
    provider.renderPreview?.(rewrite.decision, theme, {
      ...renderContext,
      cwd: effectiveCwd,
    }) ?? renderGenericPreview(rewrite.decision, theme)
  );
}

function renderBashRewriteResult(
  pi: ExtensionAPI,
  result: unknown,
  options: unknown,
  theme: { fg: (...args: any[]) => string; bold?: (text: string) => string },
  context: unknown,
): Component | null {
  if (!result || typeof result !== 'object') return null;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return null;
  const providerId = (details as { rewriteProviderId?: unknown }).rewriteProviderId;
  const routedVia = (details as { routedVia?: unknown }).routedVia;
  if (typeof providerId !== 'string' && typeof routedVia !== 'string') return null;
  const providers = getProviders(pi);
  const provider =
    typeof providerId === 'string'
      ? providers.find((candidate) => candidate.id === providerId)
      : providers.find((candidate) => routedVia === `bash-to-${candidate.tools[0]}`);
  const rewriteCwd = (details as { rewriteCwd?: unknown }).rewriteCwd;
  const rewriteToParams = (details as { rewriteToParams?: unknown }).rewriteToParams;
  const renderContext = {
    ...(context as Record<string, unknown> | undefined),
    ...(typeof rewriteCwd === 'string' ? { cwd: rewriteCwd } : {}),
    ...(rewriteToParams && typeof rewriteToParams === 'object' && !Array.isArray(rewriteToParams)
      ? { args: rewriteToParams }
      : {}),
  };
  return provider?.renderResult?.(result, options, theme, renderContext) ?? null;
}

export default function bashRewriteExtension(pi: ExtensionAPI) {
  const bashTemplate = createBashToolDefinition(process.cwd());

  pi.registerTool({
    ...bashTemplate,
    renderCall(args, theme, context) {
      return (
        renderBashRewritePreview(pi, args, theme, context) ??
        bashTemplate.renderCall!(args, theme, context)
      );
    },
    renderResult(result, options, theme, context) {
      return (
        renderBashRewriteResult(pi, result, options, theme, context) ??
        bashTemplate.renderResult!(result as never, options, theme, context)
      );
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const builtInBash = createBashToolDefinition(ctx.cwd);
      const command = extractBashCommand(params);
      if (!command) return builtInBash.execute(toolCallId, params, signal, onUpdate, ctx);

      const providers = getProviders(pi);
      const rewrite: RewriteResult | null = tryRewriteBashWithOptions(command, ctx.cwd, {
        enabledTools: enabledRewriteTools(providers),
      });

      if (!rewrite) {
        const cap = capPassThroughBashSignal(command, signal);
        if (cap) {
          const result = await builtInBash.execute(toolCallId, params, cap.signal, onUpdate, ctx);
          return prependBashNotice(result, cap.warning);
        }
        return builtInBash.execute(toolCallId, params, signal, onUpdate, ctx);
      }

      if (!rewrite.decision) {
        const cap = capPassThroughBashSignal(command, signal);
        const result = await builtInBash.execute(
          toolCallId,
          params,
          cap?.signal ?? signal,
          onUpdate,
          ctx,
        );
        const noticed = prependBashNotice(result, rewrite.notice);
        return cap ? prependBashNotice(noticed, cap.warning) : noticed;
      }

      const provider = findProviderForDecision(providers, rewrite.decision);
      if (!provider) return builtInBash.execute(toolCallId, params, signal, onUpdate, ctx);
      const providerCtx = rewrite.cwd ? ({ ...ctx, cwd: rewrite.cwd } as typeof ctx) : ctx;

      try {
        const result = await provider.execute(rewrite.decision, {
          toolCallId,
          originalCommand: command,
          signal,
          onUpdate,
          ctx: providerCtx,
        });
        return mergeRewriteDetails(
          result,
          routeDetails({
            decision: rewrite.decision,
            provider,
            originalCommand: command,
            notice: rewrite.notice,
            cwd: rewrite.cwd,
          }),
        );
      } catch (error) {
        if (provider.fallbackOnExecuteError === false) throw error;
        return builtInBash.execute(toolCallId, params, signal, onUpdate, ctx);
      }
    },
  });
}
