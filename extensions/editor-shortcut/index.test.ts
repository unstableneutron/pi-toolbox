import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AutocompleteProvider } from '@earendil-works/pi-tui';

import editorShortcut, {
  createEditorShortcutAutocompleteProvider,
  parseEditorShortcutText,
  processEditorShortcutSubmission,
  resolveEditorShortcutModel,
} from './index';

const models = [
  { provider: 'openai', id: 'gpt-5.5', name: 'GPT 5.5' },
  { provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { provider: 'facade', id: 'global.anthropic.claude-sonnet-4-6', name: 'claude-sonnet-4-6' },
  { provider: 'facade', id: 'global.anthropic.claude-haiku-4-5', name: 'claude-haiku-4-5' },
] as any[];

beforeEach(() => {
  vi.restoreAllMocks();
});

function createHarness() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const registerCommand = vi.fn();
  const notify = vi.fn();
  const setModel = vi.fn(async () => true);
  const setThinkingLevel = vi.fn();
  const sendUserMessage = vi.fn();
  const addAutocompleteProvider = vi.fn();
  const setEditorComponent = vi.fn();
  const getEditorComponent = vi.fn(() => undefined);

  const pi = {
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand,
    setModel,
    setThinkingLevel,
    sendUserMessage,
  };

  const ctx = {
    model: models[1],
    hasUI: true,
    mode: 'tui',
    modelRegistry: {
      getAll: vi.fn(() => models),
      getAvailable: vi.fn(() => models),
    },
    ui: {
      notify,
      addAutocompleteProvider,
      setEditorComponent,
      getEditorComponent,
    },
  };

  return {
    pi,
    ctx,
    handlers,
    registerCommand,
    notify,
    setModel,
    setThinkingLevel,
    sendUserMessage,
    addAutocompleteProvider,
    setEditorComponent,
    getEditorComponent,
  };
}

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

function createAutocompleteOptions() {
  return { signal: new AbortController().signal };
}

describe('parseEditorShortcutText', () => {
  test('parses leading model and thinking directives before prompt text', () => {
    expect(parseEditorShortcutText('/model:facade\n/thinking:high\nDo the work')).toEqual({
      directives: [
        { command: 'model', value: 'facade' },
        { command: 'thinking', value: 'high' },
      ],
      promptText: 'Do the work',
    });
  });

  test('parses inline directives and removes them from prompt text', () => {
    expect(parseEditorShortcutText('Please explain\n/model:sonnet')).toEqual({
      directives: [{ command: 'model', value: 'sonnet' }],
      promptText: 'Please explain',
    });

    expect(parseEditorShortcutText('Please /thinking:high explain this')).toEqual({
      directives: [{ command: 'thinking', value: 'high' }],
      promptText: 'Please explain this',
    });
  });

  test('accepts /reasoning as a thinking alias', () => {
    expect(parseEditorShortcutText('/reasoning:xhigh')?.directives).toEqual([
      { command: 'thinking', value: 'xhigh' },
    ]);
  });

  test('does not treat arbitrary words after /thinking as directives', () => {
    expect(parseEditorShortcutText('/thinking and then explain')).toBeNull();
    expect(parseEditorShortcutText('Please /thinking and then explain')).toBeNull();
    expect(parseEditorShortcutText('Please /thinking:and then explain')).toBeNull();
  });
});

describe('resolveEditorShortcutModel', () => {
  test('resolves configured shorthand aliases', () => {
    expect(resolveEditorShortcutModel('sonnet', models, undefined)).toBe(models[1]);
  });

  test('resolves provider-only query to same current model on that provider', () => {
    expect(resolveEditorShortcutModel('facade', models, models[1])).toBe(models[2]);
  });

  test('reports ambiguous provider-only query without a current-model match', () => {
    expect(resolveEditorShortcutModel('facade', models, undefined)).toEqual({
      error: expect.stringContaining('Ambiguous model "facade"'),
    });
  });
});

describe('createEditorShortcutAutocompleteProvider', () => {
  test('adds /thinking to slash command suggestions without replacing delegated commands', async () => {
    const delegated = { items: [{ value: 'model', label: 'model' }], prefix: '/thi' };
    const current = createDelegatingProvider(delegated);
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    const result = await provider.getSuggestions(
      ['/thi'],
      0,
      '/thi'.length,
      createAutocompleteOptions(),
    );

    expect(result?.items.map((item) => item.value)).toEqual(
      expect.arrayContaining(['model:', 'thinking:']),
    );
    expect(current.getSuggestions).toHaveBeenCalledTimes(1);
  });

  test('prefers canonical /model: over delegated /model when completing /mod', async () => {
    const delegated = { items: [{ value: 'model', label: 'model' }], prefix: '/mod' };
    const current = createDelegatingProvider(delegated);
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    const result = await provider.getSuggestions(
      ['/mod'],
      0,
      '/mod'.length,
      createAutocompleteOptions(),
    );

    expect(result?.items[0]?.value).toBe('model:');
    expect(result?.items.map((item) => item.value)).not.toContain('model');
  });

  test('adds /thinking suggestions at whitespace-delimited inline slash tokens', async () => {
    const current = createDelegatingProvider();
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    const result = await provider.getSuggestions(
      ['Please /think'],
      0,
      'Please /think'.length,
      createAutocompleteOptions(),
    );

    expect(result?.prefix).toBe('/think');
    expect(result?.items.map((item) => item.value)).toContain('thinking:');
  });

  test('returns thinking level suggestions for /thinking arguments', async () => {
    const current = createDelegatingProvider();
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    const result = await provider.getSuggestions(
      ['/thinking:h'],
      0,
      '/thinking:h'.length,
      createAutocompleteOptions(),
    );

    expect(result?.prefix).toBe('h');
    expect(result?.items.map((item) => item.value)).toEqual(expect.arrayContaining(['high']));
    expect(current.getSuggestions).not.toHaveBeenCalled();
  });

  test('returns thinking level suggestions for inline /thinking arguments', async () => {
    const current = createDelegatingProvider();
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    const result = await provider.getSuggestions(
      ['Please /thinking:h'],
      0,
      'Please /thinking:h'.length,
      createAutocompleteOptions(),
    );

    expect(result?.prefix).toBe('h');
    expect(result?.items.map((item) => item.value)).toEqual(expect.arrayContaining(['high']));
  });

  test('returns provider/model/alias suggestions for /model arguments', async () => {
    const current = createDelegatingProvider();
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    const result = await provider.getSuggestions(
      ['/model:fa'],
      0,
      '/model:fa'.length,
      createAutocompleteOptions(),
    );

    expect(result?.prefix).toBe('fa');
    expect(result?.items.map((item) => item.value)).toContain('facade');
  });

  test('applies slash command and argument completions inline', () => {
    const current = createDelegatingProvider();
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    expect(
      provider.applyCompletion(
        ['/thi'],
        0,
        '/thi'.length,
        { value: 'thinking:', label: 'thinking:' },
        '/thi',
      ),
    ).toMatchObject({ lines: ['/thinking:'], cursorCol: '/thinking:'.length });

    expect(
      provider.applyCompletion(
        ['Please /think'],
        0,
        'Please /think'.length,
        { value: 'thinking:', label: 'thinking:' },
        '/think',
      ),
    ).toMatchObject({ lines: ['Please /thinking:'], cursorCol: 'Please /thinking:'.length });

    expect(
      provider.applyCompletion(
        ['/thinking:h now'],
        0,
        '/thinking:h'.length,
        { value: 'high', label: 'high' },
        'h',
      ),
    ).toMatchObject({ lines: ['/thinking:high now'], cursorCol: '/thinking:high'.length });
  });
});

describe('editorShortcut extension', () => {
  test('does not register /model or /thinking commands', () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    expect(harness.registerCommand).not.toHaveBeenCalled();
  });

  test('session_start installs autocomplete and editor wrappers in TUI mode', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    await harness.handlers.get('session_start')?.({ type: 'session_start' }, harness.ctx);

    expect(harness.addAutocompleteProvider).toHaveBeenCalledTimes(1);
    expect(harness.setEditorComponent).toHaveBeenCalledTimes(1);
  });

  test('session_start skips TUI-only wrappers outside TUI mode', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    await harness.handlers.get('session_start')?.(
      { type: 'session_start' },
      { ...harness.ctx, mode: 'rpc' },
    );

    expect(harness.addAutocompleteProvider).not.toHaveBeenCalled();
    expect(harness.setEditorComponent).not.toHaveBeenCalled();
  });

  test('input handler applies leading directives and sends only prompt text onward', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    const result = await harness.handlers.get('input')?.(
      { text: '/model:facade\n/thinking:high\nDo the work', source: 'interactive' },
      harness.ctx,
    );

    expect(result).toEqual({ action: 'transform', text: 'Do the work' });
    expect(harness.setModel).toHaveBeenCalledWith(models[2]);
    expect(harness.setThinkingLevel).toHaveBeenCalledWith('high');
  });

  test('input handler applies inline directives and removes them from prompt text', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    const result = await harness.handlers.get('input')?.(
      { text: 'Please /thinking:high do the work', source: 'interactive' },
      harness.ctx,
    );

    expect(result).toEqual({ action: 'transform', text: 'Please do the work' });
    expect(harness.setThinkingLevel).toHaveBeenCalledWith('high');
  });

  test('input handler treats command-only shortcuts as handled', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    const result = await harness.handlers.get('input')?.(
      { text: '/thinking:low', source: 'interactive' },
      harness.ctx,
    );

    expect(result).toEqual({ action: 'handled' });
    expect(harness.setThinkingLevel).toHaveBeenCalledWith('low');
  });

  test('input handler ignores extension-originated messages', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    const result = await harness.handlers.get('input')?.(
      { text: '/thinking:low', source: 'extension' },
      harness.ctx,
    );

    expect(result).toEqual({ action: 'continue' });
    expect(harness.setThinkingLevel).not.toHaveBeenCalled();
  });

  test('submission processor can set model and forward trailing prompt text', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    const result = await processEditorShortcutSubmission(
      '/model:facade\nDo the work',
      harness.pi as any,
      harness.ctx as any,
    );

    expect(result).toEqual({ action: 'submit', text: 'Do the work' });
    expect(harness.setModel).toHaveBeenCalledWith(models[2]);
  });

  test('submission processor lets native /model selector handle empty or unknown model commands', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    await expect(
      processEditorShortcutSubmission('/model', harness.pi as any, harness.ctx as any),
    ).resolves.toEqual({ action: 'continue' });
    await expect(
      processEditorShortcutSubmission(
        '/model missing-model',
        harness.pi as any,
        harness.ctx as any,
      ),
    ).resolves.toEqual({ action: 'continue' });

    expect(harness.setModel).not.toHaveBeenCalled();
  });

  test('submission processor handles resolvable command-only model shortcuts', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    const result = await processEditorShortcutSubmission(
      '/model:facade',
      harness.pi as any,
      harness.ctx as any,
    );

    expect(result).toEqual({ action: 'handled' });
    expect(harness.setModel).toHaveBeenCalledWith(models[2]);
  });

  test('invalid thinking-looking prose continues without changing settings', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    const result = await harness.handlers.get('input')?.(
      { text: '/thinking and then do the work', source: 'interactive' },
      harness.ctx,
    );

    expect(result).toEqual({ action: 'continue' });
    expect(harness.setThinkingLevel).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });
});
