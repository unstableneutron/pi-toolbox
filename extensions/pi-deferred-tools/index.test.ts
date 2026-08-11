import { describe, expect, test, vi } from 'vitest';

import deferredToolsExtension from './index';
import {
  DEFERRED_TOOL_POLICY_EVENT,
  DEFERRED_TOOL_SEARCH_PROVIDER_EVENT,
  DEFERRED_TOOLS_PROTOCOL_VERSION,
  type DeferredToolPolicyRequest,
} from '../shared/deferred-tools-protocol';

interface TestTool {
  name: string;
  description: string;
  execute?: (...args: any[]) => Promise<any>;
}

function createHarness(toolNames: string[]) {
  const tools = new Map<string, TestTool>(
    toolNames.map((name) => [name, { name, description: `${name} capability` }]),
  );
  let active = [...toolNames];
  const eventHandlers = new Map<string, Array<(value: unknown) => void>>();
  const lifecycleHandlers = new Map<string, (event: any, ctx: any) => unknown>();
  const pi = {
    registerTool(tool: TestTool) {
      tools.set(tool.name, tool);
      if (!active.includes(tool.name)) active.push(tool.name);
    },
    getAllTools() {
      return [...tools.values()].map((tool) => ({
        ...tool,
        parameters: {},
        sourceInfo: {
          path: `<test:${tool.name}>`,
          source: 'test',
          scope: 'temporary',
          origin: 'top-level',
        },
      }));
    },
    getActiveTools() {
      return [...active];
    },
    setActiveTools(names: string[]) {
      active = [...names];
    },
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      lifecycleHandlers.set(event, handler);
    },
    events: {
      emit(channel: string, value: unknown) {
        for (const handler of eventHandlers.get(channel) ?? []) handler(value);
      },
      on(channel: string, handler: (value: unknown) => void) {
        eventHandlers.set(channel, [...(eventHandlers.get(channel) ?? []), handler]);
        return () => {};
      },
    },
  };
  deferredToolsExtension(pi as never);
  return { pi, tools, lifecycleHandlers };
}

function context(entries: unknown[] = []) {
  return {
    cwd: '/repo',
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
    },
  };
}

async function applyInitialPolicy(
  harness: ReturnType<typeof createHarness>,
  entries: unknown[] = [],
) {
  await harness.lifecycleHandlers.get('session_start')?.({}, context(entries));
}

const representativeTools = [
  'exec_command',
  'apply_patch',
  'fff_grep',
  'fff_find_files',
  'web_search',
  'subagent',
  'subagent_wait',
  'todo',
  'multi_tool_use.parallel',
  'herdr_layout',
  'herdr_pane',
  'herdr_agent',
  'memory_add',
  'memory_replace',
  'memory_remove',
  'get_goal',
  'create_goal',
  'update_goal',
  'signal_loop_success',
  'unknown_new_tool',
];

describe('pi-deferred-tools', () => {
  test('removes only reviewed deferred tools before the first model request', async () => {
    const harness = createHarness(representativeTools);

    await applyInitialPolicy(harness);

    expect(harness.pi.getActiveTools()).toEqual(
      expect.arrayContaining([
        'exec_command',
        'apply_patch',
        'fff_grep',
        'fff_find_files',
        'web_search',
        'subagent',
        'todo',
        'multi_tool_use.parallel',
        'unknown_new_tool',
        'search_tools',
      ]),
    );
    for (const name of [
      'herdr_layout',
      'memory_add',
      'get_goal',
      'subagent_wait',
      'signal_loop_success',
    ]) {
      expect(harness.pi.getActiveTools()).not.toContain(name);
    }
  });

  test('reports reviewed deferred names through the owner-policy protocol', () => {
    const harness = createHarness(representativeTools);
    const request: DeferredToolPolicyRequest = {
      version: DEFERRED_TOOLS_PROTOCOL_VERSION,
      deferredNames: new Set(),
      handled: false,
    };

    harness.pi.events.emit(DEFERRED_TOOL_POLICY_EVENT, request);

    expect(request.handled).toBe(true);
    expect(request.deferredNames.size).toBeGreaterThan(0);
    expect(request.deferredNames.has('write_stdin')).toBe(true);
    expect(request.deferredNames.has('view_image')).toBe(true);
    expect(request.deferredNames.has('web_search')).toBe(false);
    expect(request.deferredNames.has('subagent')).toBe(false);
  });

  test('keeps goal tools active when the restored branch has a non-complete goal', async () => {
    const harness = createHarness(representativeTools);
    const entries = [
      {
        type: 'custom',
        customType: 'pi-codex-goal',
        data: { kind: 'set', goal: { status: 'active' } },
      },
    ];

    await applyInitialPolicy(harness, entries);

    expect(harness.pi.getActiveTools()).toEqual(
      expect.arrayContaining(['get_goal', 'create_goal', 'update_goal']),
    );
  });

  test('keeps loop control active when a restored loop is running', async () => {
    const harness = createHarness(representativeTools);
    const entries = [
      {
        type: 'custom',
        customType: 'loop-state',
        data: { active: true, mode: 'tests' },
      },
    ];

    await applyInitialPolicy(harness, entries);

    expect(harness.pi.getActiveTools()).toContain('signal_loop_success');
  });

  test('loads the complete matching Pi group additively', async () => {
    const harness = createHarness(representativeTools);
    await applyInitialPolicy(harness);
    const activeBefore = harness.pi.getActiveTools();
    const search = harness.tools.get('search_tools')!;

    const result = await search.execute?.(
      'search-1',
      { query: 'Herdr terminal pane', scope: 'pi' },
      undefined,
      undefined,
      context(),
    );

    expect(harness.pi.getActiveTools()).toEqual(
      expect.arrayContaining([...activeBefore, 'herdr_layout', 'herdr_pane', 'herdr_agent']),
    );
    expect(result.details.added).toEqual(['herdr_layout', 'herdr_pane', 'herdr_agent']);
  });

  test('queries providers in auto mode only when no direct Pi group matches', async () => {
    const harness = createHarness([...representativeTools, 'executor_execute']);
    await applyInitialPolicy(harness);
    const provider = vi.fn((value: unknown) => {
      const request = value as {
        pending: Array<Promise<unknown>>;
      };
      request.pending.push(
        Promise.resolve({
          provider: 'executor',
          items: [{ path: 'github.issues.list', kind: 'integration', summary: 'List issues.' }],
        }),
      );
    });
    harness.pi.events.on(DEFERRED_TOOL_SEARCH_PROVIDER_EVENT, provider);
    const search = harness.tools.get('search_tools')!;

    await search.execute?.('search-local', { query: 'Herdr' }, undefined, undefined, context());
    expect(provider).not.toHaveBeenCalled();

    const result = await search.execute?.(
      'search-provider',
      { query: 'GitHub issues' },
      undefined,
      undefined,
      context(),
    );
    expect(provider).toHaveBeenCalledOnce();
    expect(result.details.providers).toEqual([
      {
        provider: 'executor',
        items: [{ path: 'github.issues.list', kind: 'integration', summary: 'List issues.' }],
      },
    ]);

    await search.execute?.(
      'search-pi-cursor',
      { query: 'GitHub issues', scope: 'pi', cursor: '1.0.0' },
      undefined,
      undefined,
      context(),
    );
    expect(provider).toHaveBeenCalledOnce();

    await search.execute?.(
      'search-executor',
      { query: 'Herdr', scope: 'executor' },
      undefined,
      undefined,
      context(),
    );
    await search.execute?.(
      'search-all',
      { query: 'Herdr', scope: 'all' },
      undefined,
      undefined,
      context(),
    );
    expect(provider).toHaveBeenCalledTimes(3);
  });

  test('keeps local activation when a provider fails', async () => {
    const harness = createHarness(representativeTools);
    await applyInitialPolicy(harness);
    harness.pi.events.on(DEFERRED_TOOL_SEARCH_PROVIDER_EVENT, (value: unknown) => {
      const request = value as { pending: Array<Promise<unknown>> };
      request.pending.push(Promise.reject(new Error('provider unavailable')));
    });
    const search = harness.tools.get('search_tools')!;

    const result = await search.execute?.(
      'search-provider-failure',
      { query: 'Herdr', scope: 'all' },
      undefined,
      undefined,
      context(),
    );

    expect(result.details.added).toEqual(['herdr_layout', 'herdr_pane', 'herdr_agent']);
    expect(result.details.providerErrors).toEqual(['provider unavailable']);
  });

  test('reports a matching capability that is already active', async () => {
    const harness = createHarness(representativeTools);
    await applyInitialPolicy(harness);
    const search = harness.tools.get('search_tools')!;
    await search.execute?.(
      'search-memory-first',
      { query: 'memory add', scope: 'pi' },
      undefined,
      undefined,
      context(),
    );

    const result = await search.execute?.(
      'search-memory-again',
      { query: 'memory add', scope: 'pi' },
      undefined,
      undefined,
      context(),
    );

    expect(result.content[0].text).not.toContain('No deferred tools found');
    expect(result.details.local[0].activeTools).toEqual([
      'memory_add',
      'memory_replace',
      'memory_remove',
    ]);
  });

  test('keeps all later changes additive', async () => {
    const harness = createHarness(representativeTools);
    await applyInitialPolicy(harness);
    const search = harness.tools.get('search_tools')!;

    await search.execute?.(
      'search-1',
      { query: 'memory add', scope: 'pi' },
      undefined,
      undefined,
      context(),
    );
    const afterFirst = harness.pi.getActiveTools();
    await harness.lifecycleHandlers.get('session_tree')?.({}, context());
    expect(harness.pi.getActiveTools()).toEqual(expect.arrayContaining(afterFirst));

    await search.execute?.(
      'search-2',
      { query: 'Herdr', scope: 'pi' },
      undefined,
      undefined,
      context(),
    );

    expect(harness.pi.getActiveTools()).toEqual(expect.arrayContaining(afterFirst));
  });
});
