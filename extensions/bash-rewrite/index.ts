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
} from './bash-rewrite';
import {
  BASH_REWRITE_API_VERSION,
  BASH_REWRITE_COLLECT_PROVIDERS_EVENT,
  type BashRewriteExecuteResult,
  type BashRewriteProvider,
  type BashRewriteProviderCollectorPayload,
  type BashRewriteRouteDetails,
  type BashRewriteTheme,
} from './contract';
import { TOOL_REWRITE_ARROW } from '../shared/rewrite-label';

export {
  BASH_REWRITE_API_VERSION,
  BASH_REWRITE_COLLECT_PROVIDERS_EVENT,
  BASH_REWRITE_PROVIDER_PRIORITY_RULE,
  BASH_REWRITE_TARGET_POLICY,
} from './contract';
export type {
  BashRewriteApiVersion,
  BashRewriteCollectProvidersEvent,
  BashRewriteExecuteResult,
  BashRewriteExecuteRuntime,
  BashRewriteProvider,
  BashRewriteProviderCollectorPayload,
  BashRewriteRenderRuntime,
  BashRewriteRouteDetails,
  BashRewriteTheme,
} from './contract';

const BUILTIN_TOOL_TIMEOUT_MS = 10_000;
const PASS_THROUGH_EXPENSIVE_TIMEOUT_MS = 60_000;
const BUILTIN_READ_PROVIDER_ID = 'bash-rewrite.builtin-read';
const BUILTIN_LS_PROVIDER_ID = 'bash-rewrite.builtin-ls';
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
type ReadTool = ReturnType<typeof createReadToolDefinition>;
type LsTool = ReturnType<typeof createLsToolDefinition>;
type BashExecuteResult = Awaited<ReturnType<BashTool['execute']>>;

interface CachedTool<TTool> {
  cwd: string;
  tool: TTool;
}

interface BuiltinResultRenderCache {
  read?: CachedTool<ReadTool>;
  ls?: CachedTool<LsTool>;
}

interface ActiveToolSnapshot {
  tools: Set<string>;
  key: string;
  reliable: boolean;
}

interface ProviderSnapshot extends ActiveToolSnapshot {
  externalProviders: BashRewriteProvider[];
  providers: BashRewriteProvider[];
  providerKey: string;
}

interface ProviderSnapshotCache {
  snapshot?: ProviderSnapshot;
  revision: number;
}

interface PreviewResolution {
  rewrite: RewriteResult | null;
  provider: BashRewriteProvider | null;
}

interface PreviewResolutionCache {
  entries: Map<string, PreviewResolution>;
}

const EXTERNAL_REWRITE_TOOLS = ['fff_grep', 'fff_find_files', 'apply_patch'] as const;
const PREVIEW_RESOLUTION_CACHE_LIMIT = 64;

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
  result: BashRewriteExecuteResult,
  extraDetails: Record<string, unknown>,
): BashExecuteResult {
  return {
    content: result.content,
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
    details: {
      ...(result.details && typeof result.details === 'object' ? result.details : {}),
      ...extraDetails,
    } as BashExecuteResult['details'],
  };
}

function collectExternalProviders(pi: ExtensionAPI): BashRewriteProvider[] {
  const providers = new Map<string, BashRewriteProvider>();
  const payload: BashRewriteProviderCollectorPayload = {
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

function getActiveToolSnapshot(pi: ExtensionAPI): ActiveToolSnapshot {
  try {
    const active = pi.getActiveTools?.();
    if (Array.isArray(active)) {
      const tools = new Set(active);
      return { tools, key: `reliable:${[...tools].sort().join('\u0000')}`, reliable: true };
    }
  } catch {
    // A missing or failed active-tool API must fail closed.
  }
  return { tools: new Set(), key: 'unavailable', reliable: false };
}

function isToolActive(activeTools: Set<string>, toolName: string): boolean {
  return activeTools.has(toolName);
}

function createBuiltinProviders(activeTools: Set<string>): BashRewriteProvider[] {
  const providers: BashRewriteProvider[] = [];
  if (isToolActive(activeTools, 'read')) {
    providers.push({
      id: BUILTIN_READ_PROVIDER_ID,
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
      id: BUILTIN_LS_PROVIDER_ID,
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

function getProviderSnapshot(pi: ExtensionAPI, cache: ProviderSnapshotCache): ProviderSnapshot {
  const active = getActiveToolSnapshot(pi);
  if (cache.snapshot?.key === active.key) return cache.snapshot;

  const externalProviders = collectExternalProviders(pi);
  const all = [...externalProviders, ...createBuiltinProviders(active.tools)];
  const providers = all.filter((provider) =>
    provider.tools.some((tool) => isToolActive(active.tools, tool)),
  );
  cache.revision += 1;
  const providerKey = `${cache.revision}:${providers
    .map(
      (provider) =>
        `${provider.id}:${provider.priority ?? 0}:${[...provider.tools].sort().join(',')}`,
    )
    .join('|')}`;
  const snapshot = { ...active, externalProviders, providers, providerKey };
  cache.snapshot = snapshot;
  return snapshot;
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

function renderGenericPreview(decision: RewriteDecision, theme: BashRewriteTheme): Component {
  const title = theme.fg('dim', `bash${TOOL_REWRITE_ARROW}`);
  const tool = theme.fg('toolTitle', theme.bold(decision.tool));
  return new Text(`${title}${tool}(${renderParamsForSignature(decision.params)})`, 0, 0);
}

function getRenderCwd(context: unknown): string {
  const cwd = (context as { cwd?: unknown } | undefined)?.cwd;
  return typeof cwd === 'string' ? cwd : process.cwd();
}

function getCachedReadRenderTool(cache: BuiltinResultRenderCache, cwd: string): ReadTool {
  if (!cache.read || cache.read.cwd !== cwd) {
    cache.read = { cwd, tool: createReadToolDefinition(cwd) };
  }
  return cache.read.tool;
}

function getCachedLsRenderTool(cache: BuiltinResultRenderCache, cwd: string): LsTool {
  if (!cache.ls || cache.ls.cwd !== cwd) {
    cache.ls = { cwd, tool: createLsToolDefinition(cwd) };
  }
  return cache.ls.tool;
}

function renderBuiltinRewriteResult(
  pi: ExtensionAPI,
  details: Record<string, unknown>,
  result: unknown,
  options: unknown,
  theme: { fg: (...args: any[]) => string; bold?: (text: string) => string },
  context: Record<string, unknown>,
  cache: BuiltinResultRenderCache,
): Component | null | undefined {
  const providerId = details.rewriteProviderId;
  let tool: 'read' | 'ls' | null = null;
  if (providerId === BUILTIN_READ_PROVIDER_ID) tool = 'read';
  else if (providerId === BUILTIN_LS_PROVIDER_ID) tool = 'ls';
  else return undefined;

  const activeTools = getActiveToolSnapshot(pi).tools;
  if (!isToolActive(activeTools, tool)) return null;

  const cwd = getRenderCwd(context);
  if (tool === 'read') {
    return (
      getCachedReadRenderTool(cache, cwd).renderResult?.(
        result as never,
        options as never,
        theme as never,
        context as never,
      ) ?? null
    );
  }
  return (
    getCachedLsRenderTool(cache, cwd).renderResult?.(
      result as never,
      options as never,
      theme as never,
      context as never,
    ) ?? null
  );
}

function routeDetails(args: {
  decision: RewriteDecision;
  provider: BashRewriteProvider;
  originalCommand: string;
  notice: string;
  cwd?: string;
}): BashRewriteRouteDetails {
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

function providerDiagnostic(snapshot: ProviderSnapshot): string | null {
  if (!snapshot.reliable) {
    return 'Bash rewrite diagnostics: the active-tool list is unavailable, so structured rewrites are disabled and matching commands run as Bash.';
  }
  if (!snapshot.tools.has('bash')) return null;

  const supported = new Set(snapshot.externalProviders.flatMap((provider) => provider.tools));
  const missing = EXTERNAL_REWRITE_TOOLS.filter(
    (tool) => snapshot.tools.has(tool) && !supported.has(tool),
  ).sort();
  const messages: string[] = [];
  if (snapshot.externalProviders.length === 0) {
    messages.push('no external providers are registered');
  }
  if (missing.length > 0) {
    messages.push(`no provider is registered for active target(s): ${missing.join(', ')}`);
  }
  return messages.length > 0
    ? `Bash rewrite diagnostics: ${messages.join('; ')}. Matching commands run as Bash; this notice does not activate tools.`
    : null;
}

function renderBashRewritePreview(
  pi: ExtensionAPI,
  args: unknown,
  theme: BashRewriteTheme,
  context: unknown,
  providerCache: ProviderSnapshotCache,
  previewCache: PreviewResolutionCache,
): Component | null {
  const command = extractBashCommand(args);
  if (!command) return null;
  const renderContext =
    context && typeof context === 'object' ? (context as Record<string, unknown>) : {};
  const cwd = typeof renderContext.cwd === 'string' ? renderContext.cwd : undefined;
  const snapshot = getProviderSnapshot(pi, providerCache);
  const cacheKey = `${snapshot.key}\u0000${snapshot.providerKey}\u0000${cwd ?? process.cwd()}\u0000${command}`;
  let resolution = previewCache.entries.get(cacheKey);
  if (resolution) {
    previewCache.entries.delete(cacheKey);
    previewCache.entries.set(cacheKey, resolution);
  } else {
    const rewrite = tryRewriteBashWithOptions(command, cwd ?? process.cwd(), {
      enabledTools: enabledRewriteTools(snapshot.providers),
    });
    const provider = rewrite?.decision
      ? findProviderForDecision(snapshot.providers, rewrite.decision)
      : null;
    resolution = { rewrite, provider };
    previewCache.entries.set(cacheKey, resolution);
    if (previewCache.entries.size > PREVIEW_RESOLUTION_CACHE_LIMIT) {
      const oldestKey = previewCache.entries.keys().next().value;
      if (oldestKey !== undefined) previewCache.entries.delete(oldestKey);
    }
  }
  const { rewrite, provider } = resolution;
  if (!rewrite?.decision || !provider) return null;
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
  theme: BashRewriteTheme,
  context: unknown,
  builtinResultRenderCache: BuiltinResultRenderCache,
  providerCache: ProviderSnapshotCache,
): Component | null {
  if (!result || typeof result !== 'object') return null;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== 'object') return null;
  const providerId = (details as { rewriteProviderId?: unknown }).rewriteProviderId;
  const routedVia = (details as { routedVia?: unknown }).routedVia;
  if (typeof providerId !== 'string' && typeof routedVia !== 'string') return null;
  const rewriteCwd = (details as { rewriteCwd?: unknown }).rewriteCwd;
  const rewriteToParams = (details as { rewriteToParams?: unknown }).rewriteToParams;
  const renderContext = {
    ...(context as Record<string, unknown> | undefined),
    ...(typeof rewriteCwd === 'string' ? { cwd: rewriteCwd } : {}),
    ...(rewriteToParams && typeof rewriteToParams === 'object' && !Array.isArray(rewriteToParams)
      ? { args: rewriteToParams }
      : {}),
  };
  const builtinResult = renderBuiltinRewriteResult(
    pi,
    details as Record<string, unknown>,
    result,
    options,
    theme,
    renderContext,
    builtinResultRenderCache,
  );
  if (builtinResult !== undefined) return builtinResult;

  const providers = getProviderSnapshot(pi, providerCache).providers;
  const provider =
    typeof providerId === 'string'
      ? providers.find((candidate) => candidate.id === providerId)
      : providers.find((candidate) =>
          candidate.tools.some((tool) => routedVia === `bash-to-${tool}`),
        );
  return provider?.renderResult?.(result, options, theme, renderContext) ?? null;
}

export default function bashRewriteExtension(pi: ExtensionAPI) {
  const bashTemplate = createBashToolDefinition(process.cwd());
  const builtinResultRenderCache: BuiltinResultRenderCache = {};
  const providerCache: ProviderSnapshotCache = { revision: 0 };
  const previewCache: PreviewResolutionCache = { entries: new Map() };
  let providerDiagnosticEmitted = false;

  pi.on?.('session_start', async () => {
    providerCache.snapshot = undefined;
    providerCache.revision = 0;
    previewCache.entries.clear();
    providerDiagnosticEmitted = false;
  });

  pi.on?.('before_agent_start', async (event) => {
    providerCache.snapshot = undefined;
    previewCache.entries.clear();
    if (providerDiagnosticEmitted) return undefined;
    const diagnostic = providerDiagnostic(getProviderSnapshot(pi, providerCache));
    if (!diagnostic) return undefined;
    providerDiagnosticEmitted = true;
    return { systemPrompt: `${event.systemPrompt}\n\n${diagnostic}` };
  });

  pi.registerTool({
    ...bashTemplate,
    renderCall(args, theme, context) {
      return (
        renderBashRewritePreview(pi, args, theme, context, providerCache, previewCache) ??
        bashTemplate.renderCall!(args, theme, context)
      );
    },
    renderResult(result, options, theme, context) {
      return (
        renderBashRewriteResult(
          pi,
          result,
          options,
          theme,
          context,
          builtinResultRenderCache,
          providerCache,
        ) ?? bashTemplate.renderResult!(result as never, options, theme, context)
      );
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const builtInBash = createBashToolDefinition(ctx.cwd);
      const command = extractBashCommand(params);
      if (!command) return builtInBash.execute(toolCallId, params, signal, onUpdate, ctx);

      const providers = getProviderSnapshot(pi, providerCache).providers;
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
      if (!provider) {
        const cap = capPassThroughBashSignal(command, signal);
        const result = await builtInBash.execute(
          toolCallId,
          params,
          cap?.signal ?? signal,
          onUpdate,
          ctx,
        );
        return cap ? prependBashNotice(result, cap.warning) : result;
      }
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
        const cap = capPassThroughBashSignal(command, signal);
        const result = await builtInBash.execute(
          toolCallId,
          params,
          cap?.signal ?? signal,
          onUpdate,
          ctx,
        );
        return cap ? prependBashNotice(result, cap.warning) : result;
      }
    },
  });
}
