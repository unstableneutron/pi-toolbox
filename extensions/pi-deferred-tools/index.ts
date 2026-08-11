import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

import {
  DEFERRED_TOOL_NAMES,
  findDeferredToolGroups,
  INITIAL_ACTIVE_TOOL_NAMES,
  type DeferredToolGroupMatch,
} from './catalog';
import {
  DEFERRED_TOOL_POLICY_EVENT,
  DEFERRED_TOOL_SEARCH_PROVIDER_EVENT,
  DEFERRED_TOOLS_PROTOCOL_VERSION,
  type DeferredToolPolicyRequest,
  type DeferredToolProviderResult,
  type DeferredToolSearchProviderRequest,
} from '../shared/deferred-tools-protocol';

const SEARCH_TOOL_NAME = 'search_tools';
const GOAL_TOOL_NAMES = ['get_goal', 'create_goal', 'update_goal'] as const;
const GOAL_TOOL_NAME_SET = new Set<string>(GOAL_TOOL_NAMES);
const GOAL_ENTRY_TYPE = 'pi-codex-goal';
const LOOP_TOOL_NAME = 'signal_loop_success';
const LOOP_ENTRY_TYPE = 'loop-state';

type SearchScope = 'auto' | 'pi' | 'executor' | 'all';

interface GoalEntryData {
  kind?: unknown;
  goal?: { status?: unknown };
}

function addTools(pi: ExtensionAPI, names: Iterable<string>): string[] {
  const available = new Set(pi.getAllTools().map((tool) => tool.name));
  const active = pi.getActiveTools();
  const activeSet = new Set(active);
  const added = [...names].filter((name) => available.has(name) && !activeSet.has(name));
  if (added.length > 0) pi.setActiveTools([...active, ...added]);
  return added.filter((name) => pi.getActiveTools().includes(name));
}

function activeGoalInBranch(ctx: ExtensionContext): boolean {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== 'custom' || entry.customType !== GOAL_ENTRY_TYPE) continue;
    const data = entry.data as GoalEntryData | undefined;
    if (data?.kind === 'clear') return false;
    if (data?.kind !== 'set') continue;
    return data.goal?.status !== 'complete';
  }
  return false;
}

function activeLoopInSession(ctx: ExtensionContext): boolean {
  const entries = ctx.sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== 'custom' || entry.customType !== LOOP_ENTRY_TYPE) continue;
    return (entry.data as { active?: unknown } | undefined)?.active === true;
  }
  return false;
}

function initialActiveTools(pi: ExtensionAPI, ctx: ExtensionContext): string[] {
  const keepGoalTools = activeGoalInBranch(ctx);
  const keepLoopTool = activeLoopInSession(ctx);
  return pi
    .getActiveTools()
    .filter(
      (name) =>
        !DEFERRED_TOOL_NAMES.has(name) ||
        INITIAL_ACTIVE_TOOL_NAMES.has(name) ||
        (keepGoalTools && GOAL_TOOL_NAME_SET.has(name)) ||
        (keepLoopTool && name === LOOP_TOOL_NAME),
    );
}

function localResult(match: DeferredToolGroupMatch) {
  return {
    group: match.group.id,
    kind: 'pi-group',
    summary: match.group.summary,
    tools: match.availableTools,
    activeTools: match.activeTools,
  };
}

function providerShouldRun(scope: SearchScope, localMatches: DeferredToolGroupMatch[]): boolean {
  if (scope === 'pi') return false;
  if (scope === 'executor' || scope === 'all') return true;
  return !localMatches.some((match) => match.direct);
}

function isProviderResult(value: unknown): value is DeferredToolProviderResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<DeferredToolProviderResult>;
  return (
    typeof result.provider === 'string' &&
    Array.isArray(result.items) &&
    result.items.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof item.kind === 'string' &&
        typeof item.summary === 'string' &&
        (item.name === undefined || typeof item.name === 'string') &&
        (item.path === undefined || typeof item.path === 'string') &&
        (item.state === undefined || typeof item.state === 'string'),
    ) &&
    (result.nextCursor === undefined || typeof result.nextCursor === 'string')
  );
}

function providerOutput(result: DeferredToolProviderResult) {
  return {
    provider: result.provider,
    items: result.items,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  };
}

export default function deferredToolsExtension(pi: ExtensionAPI): void {
  pi.events.on(DEFERRED_TOOL_POLICY_EVENT, (value) => {
    if (!value || typeof value !== 'object') return;
    const request = value as Partial<DeferredToolPolicyRequest>;
    if (
      request.version !== DEFERRED_TOOLS_PROTOCOL_VERSION ||
      !(request.deferredNames instanceof Set)
    ) {
      return;
    }
    for (const name of DEFERRED_TOOL_NAMES) {
      if (!INITIAL_ACTIVE_TOOL_NAMES.has(name)) request.deferredNames.add(name);
    }
    request.handled = true;
  });

  pi.registerTool({
    name: SEARCH_TOOL_NAME,
    label: 'Search Tools',
    description:
      'Search registered but deferred Pi tools and connected capability providers, then enable the matching Pi tools additively. Use scope="executor" for connected integrations. Executor native matches become ordinary Pi tools; integration paths stay behind executor_describe_tool and executor_execute.',
    promptSnippet: 'Search for and add tools when the active tools cannot perform the task',
    promptGuidelines: [
      'If a task or instruction names a tool that is not active, call search_tools with that tool name or capability. Use scope="executor" for connected integrations.',
    ],
    parameters: Type.Object(
      {
        query: Type.String({
          description: 'Short tool name, capability, or task query.',
          minLength: 1,
        }),
        scope: Type.Optional(
          StringEnum(['auto', 'pi', 'executor', 'all'] as const, {
            description: 'Search scope. auto uses Executor only when no direct Pi group matches.',
          }),
        ),
        limit: Type.Optional(
          Type.Integer({
            description: 'Maximum local groups and provider items. Defaults to 5.',
            minimum: 1,
            maximum: 10,
          }),
        ),
        cursor: Type.Optional(
          Type.String({ description: 'Opaque provider cursor returned by a prior search.' }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const scope = (params.scope ?? 'auto') as SearchScope;
      const limit = params.limit ?? 5;
      const activeBefore = new Set(pi.getActiveTools());
      const localMatches =
        scope === 'executor'
          ? []
          : findDeferredToolGroups(pi.getAllTools(), activeBefore, params.query, limit);

      const pending: Array<Promise<DeferredToolProviderResult>> = [];
      if (scope !== 'pi' && (params.cursor || providerShouldRun(scope, localMatches))) {
        const request: DeferredToolSearchProviderRequest = {
          version: DEFERRED_TOOLS_PROTOCOL_VERSION,
          query: params.query,
          limit,
          cursor: params.cursor,
          signal,
          context: ctx,
          pending,
        };
        pi.events.emit(DEFERRED_TOOL_SEARCH_PROVIDER_EVENT, request);
      }

      const localNames = localMatches.flatMap((match) => match.availableTools);
      addTools(pi, localNames);

      const settled = await Promise.allSettled(pending);
      const providers: DeferredToolProviderResult[] = [];
      const providerErrors: string[] = [];
      for (const result of settled) {
        if (result.status === 'fulfilled' && isProviderResult(result.value)) {
          providers.push(result.value);
        } else if (result.status === 'fulfilled') {
          providerErrors.push('A deferred-tool provider returned an invalid result');
        } else {
          providerErrors.push(
            result.reason instanceof Error ? result.reason.message : String(result.reason),
          );
        }
      }

      const activeAfter = pi.getActiveTools();
      const added = activeAfter.filter((name) => !activeBefore.has(name));
      const output = {
        version: 1,
        query: params.query,
        ...(params.cursor ? { cursor: params.cursor } : {}),
        added,
        local: localMatches.map(localResult),
        providers: providers.map(providerOutput),
        ...(providerErrors.length > 0 ? { providerErrors } : {}),
      };
      const found =
        localMatches.length > 0 || providers.some((provider) => provider.items.length > 0);
      return {
        content: [
          {
            type: 'text',
            text: found
              ? JSON.stringify(output)
              : `No deferred tools found for: ${params.query}${providerErrors.length > 0 ? `\n${providerErrors.join('\n')}` : ''}`,
          },
        ],
        details: output,
      };
    },
  });

  pi.on('session_start', (_event, ctx) => {
    const next = initialActiveTools(pi, ctx);
    if (next.length !== pi.getActiveTools().length) pi.setActiveTools(next);
  });

  pi.on('session_tree', (_event, ctx) => {
    if (activeGoalInBranch(ctx)) addTools(pi, GOAL_TOOL_NAMES);
  });
}
