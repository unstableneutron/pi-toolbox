import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import bashRewriteSubagentBundle, { BASH_REWRITE_SUBAGENT_REQUIRED_TOOLS } from './index';

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(PACKAGE_DIR, '../..');

function createHarness(activeTools = [...BASH_REWRITE_SUBAGENT_REQUIRED_TOOLS]) {
  const tools: any[] = [];
  const handlers = new Map<string, Function[]>();
  const eventHandlers = new Map<string, Function[]>();
  const pi = {
    registerTool(tool: any) {
      tools.push(tool);
    },
    on(event: string, handler: Function) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    getActiveTools() {
      return activeTools;
    },
    getAllTools() {
      return tools;
    },
    setActiveTools() {},
    events: {
      on(event: string, handler: Function) {
        eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
        return () => {};
      },
      emit(event: string, payload: unknown) {
        for (const handler of eventHandlers.get(event) ?? []) handler(payload);
      },
    },
  } as any;
  bashRewriteSubagentBundle(pi);
  return { tools, handlers, eventHandlers, pi };
}

describe('bash-rewrite subagent bundle', () => {
  test('registers one bash host plus standalone provider tools', () => {
    const { tools } = createHarness();
    const names = tools.map((tool) => tool.name);

    expect(names.filter((name) => name === 'bash')).toHaveLength(1);
    expect(names).toEqual(
      expect.arrayContaining([
        'fff_grep',
        'fff_find_files',
        'read',
        'grep',
        'find',
        'edit',
        'apply_patch',
        'bash',
      ]),
    );
  });

  test('collects both external providers through the versioned contract', () => {
    const { pi } = createHarness();
    const providers: any[] = [];

    pi.events.emit('bash-rewrite:collect-providers', {
      apiVersion: 1,
      register(provider: any) {
        providers.push(provider);
      },
    });

    expect(providers.map((provider) => provider.id).sort((a, b) => a.localeCompare(b))).toEqual([
      'multi-edit.apply-patch',
      'pi-fff-search',
    ]);
  });

  test('stays outside ambient toolbox extension discovery', () => {
    const rootManifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    const bundleManifest = JSON.parse(readFileSync(resolve(PACKAGE_DIR, 'package.json'), 'utf8'));

    expect(relative(REPO_ROOT, PACKAGE_DIR)).toBe('packages/bash-rewrite-subagent');
    expect(rootManifest.pi.extensions).toEqual(['./extensions']);
    expect(bundleManifest.pi).toBeUndefined();
  });

  test('does not treat deliberately restricted targets as a configuration error', async () => {
    const { handlers } = createHarness(['bash', 'read', 'ls', 'apply_patch']);
    const beforeHandlers = handlers.get('before_agent_start') ?? [];
    const bashHostHandler = beforeHandlers.at(-1)!;
    const result = await bashHostHandler({ systemPrompt: 'BASE' }, {});

    expect(result).toBeUndefined();
  });
});
