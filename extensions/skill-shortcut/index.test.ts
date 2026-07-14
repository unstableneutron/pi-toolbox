import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AutocompleteProvider } from '@earendil-works/pi-tui';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import skillShortcut, {
  createSkillAutocompleteProvider,
  extractDollarPrefix,
  installConsecutiveSkillBlockPromptPatch,
  splitConsecutiveSkillBlocksInPromptMessages,
  splitLeadingSkillBlocks,
  transformSkillShortcutInput,
} from './index';
import { clearEditorBehaviors, getEditorBehaviors } from '../shared/editor-behaviors';
import safeEscape from '../safe-escape/safe-escape';

beforeEach(() => {
  clearEditorBehaviors();
  vi.restoreAllMocks();
});

function createAutocompleteOptions() {
  return { signal: new AbortController().signal };
}

function createExtensionHarness() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
  const addAutocompleteProvider = vi.fn();
  const setEditorComponent = vi.fn();
  const sendUserMessage = vi.fn();

  const pi = {
    on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
      handlers.set(event, handler);
    },
    getCommands() {
      return [
        {
          source: 'skill',
          name: 'skill:agent-browser',
          description: 'Open browser tooling',
        },
      ];
    },
    sendUserMessage,
  };

  const ctx = {
    hasUI: true,
    mode: 'tui',
    ui: {
      addAutocompleteProvider,
      setEditorComponent,
    },
  };

  return {
    pi,
    ctx,
    handlers,
    addAutocompleteProvider,
    setEditorComponent,
    sendUserMessage,
  };
}

function createSkillFile(name: string, body: string) {
  const dir = mkdtempSync(join(tmpdir(), `skill-shortcut-${name}-`));
  const path = join(dir, 'SKILL.md');
  writeFileSync(path, `---\nname: ${name}\ndescription: Test skill\n---\n\n${body}\n`, 'utf8');
  return {
    dir,
    path,
    cleanup: () => rmSync(dir, { force: true, recursive: true }),
  };
}

function skillBlock(name: string, body = `# ${name}`) {
  return `<skill name="${name}" location="/tmp/${name}/SKILL.md">\nReferences are relative to /tmp/${name}.\n\n${body}\n</skill>`;
}

describe('skill-shortcut helpers', () => {
  test('extracts a $ token at start of line or after whitespace', () => {
    expect(extractDollarPrefix('$aut')).toBe('$aut');
    expect(extractDollarPrefix('hello $aut')).toBe('$aut');
    expect(extractDollarPrefix('hello($aut')).toBeNull();
  });

  test('transforms only known skill tokens into /skill commands', () => {
    expect(transformSkillShortcutInput('Use $agent-browser now', ['agent-browser'])).toBe(
      'Use /skill:agent-browser now',
    );
    expect(transformSkillShortcutInput('Use $skill:agent-browser now', ['agent-browser'])).toBe(
      'Use /skill:agent-browser now',
    );
    expect(transformSkillShortcutInput('Use $missing now', ['agent-browser'])).toBe(
      'Use $missing now',
    );
  });

  test('preserves surrounding whitespace when transforming known skill tokens', () => {
    expect(transformSkillShortcutInput('  use $agent-browser now  ', ['agent-browser'])).toBe(
      '  use /skill:agent-browser now  ',
    );
  });

  test('parses consecutive leading skill blocks and trailing user text', () => {
    const first = skillBlock('agent-browser');
    const second = skillBlock('systematic-debugging');

    expect(splitLeadingSkillBlocks(`${first}\n\n${second}\n\nDebug this`)).toEqual({
      skillBlocks: [first, second],
      userText: 'Debug this',
    });
  });

  test('splits a user prompt with consecutive skill blocks into native user messages', () => {
    const first = skillBlock('agent-browser');
    const second = skillBlock('systematic-debugging');
    const image = { type: 'image' as const, data: 'abc', mimeType: 'image/png' };

    const result = splitConsecutiveSkillBlocksInPromptMessages([
      {
        role: 'user',
        content: [{ type: 'text', text: `${first}\n\n${second}\n\nDebug this` }, image],
        timestamp: 123,
      },
    ] as any);

    expect(result).toEqual([
      { role: 'user', content: [{ type: 'text', text: first }], timestamp: 123 },
      { role: 'user', content: [{ type: 'text', text: second }], timestamp: 123 },
      { role: 'user', content: [{ type: 'text', text: 'Debug this' }, image], timestamp: 123 },
    ]);
  });

  test('does not split single skill blocks so native /skill rendering stays unchanged', () => {
    const first = skillBlock('agent-browser');
    const messages = [
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: `${first}\n\nDebug this` }],
      },
    ];

    expect(splitConsecutiveSkillBlocksInPromptMessages(messages as any)).toBe(messages);
  });

  test('runtime prompt patch splits once and is idempotent', async () => {
    const first = skillBlock('agent-browser');
    const second = skillBlock('systematic-debugging');
    const calls: any[] = [];

    class FakeAgentSession {
      async _runAgentPrompt(messages: any) {
        calls.push(messages);
      }
    }

    installConsecutiveSkillBlockPromptPatch(FakeAgentSession as any);
    installConsecutiveSkillBlockPromptPatch(FakeAgentSession as any);

    await (new FakeAgentSession() as any)._runAgentPrompt([
      {
        role: 'user',
        content: [{ type: 'text', text: `${first}\n\n${second}\n\nDebug this` }],
      },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      { role: 'user', content: [{ type: 'text', text: first }] },
      { role: 'user', content: [{ type: 'text', text: second }] },
      { role: 'user', content: [{ type: 'text', text: 'Debug this' }] },
    ]);
  });
});

describe('createSkillAutocompleteProvider', () => {
  function createDelegatingProvider(
    suggestions: Awaited<ReturnType<AutocompleteProvider['getSuggestions']>> = null,
  ): AutocompleteProvider & {
    getSuggestions: ReturnType<typeof vi.fn>;
    applyCompletion: ReturnType<typeof vi.fn>;
  } {
    return {
      getSuggestions: vi.fn(async () => suggestions),
      applyCompletion: vi.fn((lines: string[]) => ({ lines, cursorLine: 0, cursorCol: 0 })),
    };
  }

  test('returns skill suggestions for $ prefixes instead of delegating', async () => {
    const current = createDelegatingProvider();
    const provider = createSkillAutocompleteProvider(current, () => [
      { name: 'agent-browser', description: 'Open browser tooling' },
      { name: 'systematic-debugging', description: 'Debug rigorously' },
    ]);

    const result = await provider.getSuggestions(
      ['Use $agent'],
      0,
      'Use $agent'.length,
      createAutocompleteOptions(),
    );

    expect(result?.prefix).toBe('$agent');
    expect(result?.items.map((item) => item.value)).toContain('skill:agent-browser');
    expect(current.getSuggestions).toHaveBeenCalledTimes(1);
  });

  test('merges upstream shortcut suggestions before skill suggestions', async () => {
    const delegated = {
      items: [{ value: 'thinking:medium', label: 'thinking:medium' }],
      prefix: '$med',
    };
    const current = createDelegatingProvider(delegated);
    const provider = createSkillAutocompleteProvider(current, () => [
      { name: 'medical-review', description: 'Review medical text' },
    ]);

    const result = await provider.getSuggestions(
      ['$med'],
      0,
      '$med'.length,
      createAutocompleteOptions(),
    );

    expect(result?.prefix).toBe('$med');
    expect(result?.items.map((item) => item.value)).toEqual([
      'thinking:medium',
      'skill:medical-review',
    ]);
  });

  test('returns skill suggestions for $skill: prefixes', async () => {
    const current = createDelegatingProvider();
    const provider = createSkillAutocompleteProvider(current, () => [
      { name: 'agent-browser', description: 'Open browser tooling' },
      { name: 'systematic-debugging', description: 'Debug rigorously' },
    ]);

    const result = await provider.getSuggestions(
      ['Use $skill:agent'],
      0,
      'Use $skill:agent'.length,
      createAutocompleteOptions(),
    );

    expect(result?.prefix).toBe('$skill:agent');
    expect(result?.items.map((item) => item.value)).toContain('skill:agent-browser');
    expect(current.getSuggestions).toHaveBeenCalledTimes(1);
  });

  test('splits abbreviated $skill command prefixes from skill-name filters', async () => {
    const current = createDelegatingProvider();
    const provider = createSkillAutocompleteProvider(current, () => [
      { name: 'agent-browser', description: 'Open browser tooling' },
      { name: 'systematic-debugging', description: 'Debug rigorously' },
    ]);

    const result = await provider.getSuggestions(
      ['$s:a'],
      0,
      '$s:a'.length,
      createAutocompleteOptions(),
    );

    expect(result?.prefix).toBe('$s:a');
    expect(result?.items.map((item) => item.value)).toContain('skill:agent-browser');
    expect(result?.items.map((item) => item.value)).not.toContain('skill:systematic-debugging');
  });

  test('delegates getSuggestions for non-$ prefixes', async () => {
    const delegated = { items: [{ value: 'fallback', label: 'fallback' }], prefix: 'agent' };
    const current = createDelegatingProvider(delegated);
    const provider = createSkillAutocompleteProvider(current, () => [{ name: 'agent-browser' }]);

    const result = await provider.getSuggestions(
      ['Use agent'],
      0,
      'Use agent'.length,
      createAutocompleteOptions(),
    );

    expect(result).toBe(delegated);
    expect(current.getSuggestions).toHaveBeenCalledTimes(1);
  });

  test('delegates when $ token has no fuzzy matches so the built-in provider can try', async () => {
    const delegated = { items: [{ value: 'other', label: 'other' }], prefix: '$nope' };
    const current = createDelegatingProvider(delegated);
    const provider = createSkillAutocompleteProvider(current, () => [{ name: 'agent-browser' }]);

    const result = await provider.getSuggestions(
      ['Use $nope'],
      0,
      'Use $nope'.length,
      createAutocompleteOptions(),
    );

    expect(result).toBe(delegated);
    expect(current.getSuggestions).toHaveBeenCalledTimes(1);
  });

  test('delegates applyCompletion for non-$ prefixes', () => {
    const delegated = { lines: ['Use fallback'], cursorLine: 0, cursorCol: 12 };
    const current = {
      getSuggestions: vi.fn(async () => null),
      applyCompletion: vi.fn(() => delegated),
    } satisfies AutocompleteProvider & { applyCompletion: ReturnType<typeof vi.fn> };
    const provider = createSkillAutocompleteProvider(current, () => [{ name: 'agent-browser' }]);

    const item = { value: 'fallback', label: 'fallback' };
    const result = provider.applyCompletion(['Use agent'], 0, 'Use agent'.length, item, 'agent');

    expect(result).toBe(delegated);
    expect(current.applyCompletion).toHaveBeenCalledWith(
      ['Use agent'],
      0,
      'Use agent'.length,
      item,
      'agent',
    );
  });

  test('$ applyCompletion preserves text after the cursor', () => {
    const current = createDelegatingProvider();
    const provider = createSkillAutocompleteProvider(current, () => [{ name: 'agent-browser' }]);

    const result = provider.applyCompletion(
      ['Use $ag now'],
      0,
      'Use $ag'.length,
      { value: 'skill:agent-browser', label: 'agent-browser' },
      '$ag',
    );

    expect(result.lines).toEqual(['Use $skill:agent-browser now']);
    expect(result.cursorCol).toBe('Use $skill:agent-browser'.length);
  });

  test('$skill applyCompletion preserves text after the cursor', () => {
    const current = createDelegatingProvider();
    const provider = createSkillAutocompleteProvider(current, () => [{ name: 'agent-browser' }]);

    const result = provider.applyCompletion(
      ['Use $skill:ag now'],
      0,
      'Use $skill:ag'.length,
      { value: 'skill:agent-browser', label: 'agent-browser' },
      '$skill:ag',
    );

    expect(result.lines).toEqual(['Use $skill:agent-browser now']);
    expect(result.cursorCol).toBe('Use $skill:agent-browser'.length);
  });

  test.each(['$Foo', '$name.'])(
    'invalid tokens like %s do not trigger suggestions',
    async (token) => {
      const delegated = { items: [{ value: 'fallback', label: 'fallback' }], prefix: token };
      const current = createDelegatingProvider(delegated);
      const provider = createSkillAutocompleteProvider(current, () => [{ name: 'agent-browser' }]);

      const result = await provider.getSuggestions(
        [`Use ${token}`],
        0,
        `Use ${token}`.length,
        createAutocompleteOptions(),
      );

      expect(result).toBe(delegated);
      expect(current.getSuggestions).toHaveBeenCalledTimes(1);
    },
  );

  test('delegates applyCompletion for invalid $ prefixes', () => {
    const delegated = { lines: ['Use delegated'], cursorLine: 0, cursorCol: 13 };
    const current = {
      getSuggestions: vi.fn(async () => null),
      applyCompletion: vi.fn(() => delegated),
    } satisfies AutocompleteProvider & { applyCompletion: ReturnType<typeof vi.fn> };
    const provider = createSkillAutocompleteProvider(current, () => [{ name: 'agent-browser' }]);

    const item = { value: 'fallback', label: 'fallback' };
    const result = provider.applyCompletion(['Use $Foo'], 0, 'Use $Foo'.length, item, '$Foo');

    expect(result).toBe(delegated);
    expect(current.applyCompletion).toHaveBeenCalledWith(
      ['Use $Foo'],
      0,
      'Use $Foo'.length,
      item,
      '$Foo',
    );
  });

  test('shouldTriggerFileCompletion delegates to current provider', () => {
    const shouldTrigger = vi.fn(() => false);
    const current: AutocompleteProvider = {
      async getSuggestions() {
        return null;
      },
      applyCompletion(lines) {
        return { lines, cursorLine: 0, cursorCol: 0 };
      },
      shouldTriggerFileCompletion: shouldTrigger,
    };
    const provider = createSkillAutocompleteProvider(current, () => []);

    expect(provider.shouldTriggerFileCompletion?.([''], 0, 0)).toBe(false);
    expect(shouldTrigger).toHaveBeenCalledWith([''], 0, 0);
  });
});

describe('extension registration', () => {
  test('session_start installs exactly one autocomplete provider', async () => {
    const harness = createExtensionHarness();

    skillShortcut(harness.pi as any);
    await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);

    expect(harness.addAutocompleteProvider).toHaveBeenCalledTimes(1);
  });

  test('session_start skips autocomplete outside TUI mode', async () => {
    const harness = createExtensionHarness();

    skillShortcut(harness.pi as any);
    await harness.handlers.get('session_start')?.(
      { type: 'session_start' },
      { ...harness.ctx, mode: 'rpc' },
    );

    expect(harness.addAutocompleteProvider).not.toHaveBeenCalled();
  });

  test('session_start does not install a custom editor component', async () => {
    const harness = createExtensionHarness();

    skillShortcut(harness.pi as any);
    await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);

    expect(harness.setEditorComponent).not.toHaveBeenCalled();
  });

  test('skill-shortcut no longer registers anything in the editor-behavior bridge', async () => {
    const harness = createExtensionHarness();

    skillShortcut(harness.pi as any);
    await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);

    expect(getEditorBehaviors()).toEqual([]);
  });

  test('safe-escape remains the only editor-behavior registrar after both load', async () => {
    clearEditorBehaviors();

    const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
    const pi = {
      on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
        handlers.set(event, handler);
      },
      registerCommand: vi.fn(),
      getCommands() {
        return [
          {
            source: 'skill',
            name: 'skill:agent-browser',
            description: 'Open browser tooling',
          },
        ];
      },
    };

    safeEscape(pi as any);
    skillShortcut(pi as any);

    expect(getEditorBehaviors().map((behavior) => behavior.id)).toEqual(['safe-escape']);
  });

  test('wired provider returns skill suggestions when session_start runs', async () => {
    const harness = createExtensionHarness();
    skillShortcut(harness.pi as any);
    await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);

    const builder = harness.addAutocompleteProvider.mock.calls[0]?.[0] as (
      current: AutocompleteProvider,
    ) => AutocompleteProvider;
    expect(builder).toBeTypeOf('function');

    const current: AutocompleteProvider = {
      async getSuggestions() {
        return null;
      },
      applyCompletion(lines) {
        return { lines, cursorLine: 0, cursorCol: 0 };
      },
    };
    const provider = builder(current);

    const result = await provider.getSuggestions(
      ['$agent'],
      0,
      '$agent'.length,
      createAutocompleteOptions(),
    );

    expect(result?.items.map((item) => item.value)).toEqual(['skill:agent-browser']);
  });

  test('input handler transforms only loaded skill shortcuts', async () => {
    const harness = createExtensionHarness();

    skillShortcut(harness.pi as any);
    await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);

    const inputHandler = harness.handlers.get('input');

    expect(inputHandler?.({ text: 'use $agent-browser now' }, harness.ctx as any)).toEqual({
      action: 'transform',
      text: 'use /skill:agent-browser now',
    });
    expect(inputHandler?.({ text: 'use $missing now' }, harness.ctx as any)).toEqual({
      action: 'continue',
    });
  });

  test('input handler lets native non-skill slash commands continue unchanged', async () => {
    const harness = createExtensionHarness();

    skillShortcut(harness.pi as any);
    await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);

    const inputHandler = harness.handlers.get('input');

    expect(inputHandler?.({ text: '/help' }, harness.ctx as any)).toEqual({
      action: 'continue',
    });
    expect(harness.sendUserMessage).not.toHaveBeenCalled();
  });

  test('input handler handles embedded skill commands by sending expanded skill XML', async () => {
    const skill = createSkillFile('agent-browser', '# Agent Browser\n\nOpen browser tooling.');
    const harness = createExtensionHarness();
    vi.spyOn(harness.pi, 'getCommands').mockReturnValue([
      {
        source: 'skill',
        name: 'skill:agent-browser',
        description: 'Open browser tooling',
        sourceInfo: {
          path: skill.path,
          source: skill.path,
          scope: 'project',
          origin: 'top-level',
          baseDir: skill.dir,
        },
      },
    ] as any);

    try {
      skillShortcut(harness.pi as any);
      await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);

      const inputHandler = harness.handlers.get('input');
      expect(inputHandler?.({ text: 'use /skill:agent-browser now' }, harness.ctx as any)).toEqual({
        action: 'handled',
      });
      expect(harness.sendUserMessage).toHaveBeenCalledWith(
        expect.stringContaining(`<skill name="agent-browser" location="${skill.path}">`),
        undefined,
      );
      expect(harness.sendUserMessage.mock.calls[0]?.[0]).toContain(
        `References are relative to ${skill.dir}.`,
      );
      expect(harness.sendUserMessage.mock.calls[0]?.[0]).toContain('# Agent Browser');
      expect(harness.sendUserMessage.mock.calls[0]?.[0]).toContain('use [skill:agent-browser] now');
    } finally {
      skill.cleanup();
    }
  });

  test('input handler deduplicates repeated skill mentions by name', async () => {
    const skill = createSkillFile('agent-browser', '# Agent Browser\n\nOpen browser tooling.');
    const harness = createExtensionHarness();
    vi.spyOn(harness.pi, 'getCommands').mockReturnValue([
      {
        source: 'skill',
        name: 'skill:agent-browser',
        description: 'Open browser tooling',
        sourceInfo: {
          path: skill.path,
          source: skill.path,
          scope: 'project',
          origin: 'top-level',
          baseDir: skill.dir,
        },
      },
    ] as any);

    try {
      skillShortcut(harness.pi as any);
      await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);

      const inputHandler = harness.handlers.get('input');
      expect(
        inputHandler?.(
          { text: 'use /skill:agent-browser and /skill:agent-browser now' },
          harness.ctx as any,
        ),
      ).toEqual({ action: 'handled' });

      const sent = harness.sendUserMessage.mock.calls[0]?.[0] as string;
      expect(sent.match(/<skill name="agent-browser"/g)).toHaveLength(1);
      expect(sent).toContain('use [skill:agent-browser] and [skill:agent-browser] now');
    } finally {
      skill.cleanup();
    }
  });

  test('input handler ignores extension-originated messages to avoid recursion', async () => {
    const skill = createSkillFile('agent-browser', '# Agent Browser');
    const harness = createExtensionHarness();
    vi.spyOn(harness.pi, 'getCommands').mockReturnValue([
      {
        source: 'skill',
        name: 'skill:agent-browser',
        sourceInfo: {
          path: skill.path,
          source: skill.path,
          scope: 'project',
          origin: 'top-level',
          baseDir: skill.dir,
        },
      },
    ] as any);

    try {
      skillShortcut(harness.pi as any);
      await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);

      const inputHandler = harness.handlers.get('input');
      expect(
        inputHandler?.(
          { text: 'use /skill:agent-browser now', source: 'extension' },
          harness.ctx as any,
        ),
      ).toEqual({ action: 'continue' });
      expect(harness.sendUserMessage).not.toHaveBeenCalled();
    } finally {
      skill.cleanup();
    }
  });
});
