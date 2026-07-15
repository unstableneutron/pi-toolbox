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
  { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT 5.5 Codex' },
  { provider: 'openai', id: 'gpt-5.4-nomoderation', name: 'GPT 5.4 no moderation' },
  { provider: 'openai', id: 'gpt-5.5-nomoderation', name: 'GPT 5.5 no moderation' },
  { provider: 'anthropic', id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
  { provider: 'anthropic', id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
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
    expect(parseEditorShortcutText('$model:facade\n$thinking:high\nDo the work')).toEqual({
      directives: [
        { command: 'model', value: 'facade' },
        { command: 'thinking', value: 'high' },
      ],
      promptText: 'Do the work',
    });
  });

  test('parses inline directives and removes them from prompt text', () => {
    expect(parseEditorShortcutText('Please explain\n$model:sonnet')).toEqual({
      directives: [{ command: 'model', value: 'sonnet' }],
      promptText: 'Please explain',
    });

    expect(parseEditorShortcutText('Please $thinking:high explain this')).toEqual({
      directives: [{ command: 'thinking', value: 'high' }],
      promptText: 'Please explain this',
    });

    expect(parseEditorShortcutText('Please $fast:on explain this')).toEqual({
      directives: [{ command: 'fast', value: 'on' }],
      promptText: 'Please explain this',
    });

    expect(parseEditorShortcutText('Please $fast explain this')).toEqual({
      directives: [{ command: 'fast', value: 'toggle' }],
      promptText: 'Please explain this',
    });
  });

  test('does not accept $reasoning as a thinking alias', () => {
    expect(parseEditorShortcutText('$reasoning:xhigh')).toBeNull();
  });

  test('does not treat arbitrary words after $thinking as directives', () => {
    expect(parseEditorShortcutText('$thinking and then explain')).toBeNull();
    expect(parseEditorShortcutText('Please $thinking and then explain')).toBeNull();
    expect(parseEditorShortcutText('Please $thinking:and then explain')).toBeNull();
  });
});

describe('resolveEditorShortcutModel', () => {
  test('does not resolve hardcoded shorthand aliases', () => {
    expect(resolveEditorShortcutModel('sonnet', models, undefined)).toEqual({
      error: expect.stringContaining('Ambiguous model "sonnet"'),
    });
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
  test('preserves native slash-command autocomplete triggers', () => {
    const current = createDelegatingProvider();
    current.triggerCharacters = ['@'];
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    expect(provider.triggerCharacters).toEqual(['@', '/', '$']);
  });

  test('adds matching $thinking shortcut suggestions before delegated items', async () => {
    const delegated = { items: [{ value: 'thinking-skill', label: 'thinking-skill' }], prefix: '$thi' };
    const current = createDelegatingProvider(delegated);
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    const result = await provider.getSuggestions(
      ['Please $thi'],
      0,
      'Please $thi'.length,
      createAutocompleteOptions(),
    );

    const values = result?.items.map((item) => item.value) ?? [];
    expect(values.slice(0, 7)).toEqual([
      'thinking:',
      'thinking:off',
      'thinking:minimal',
      'thinking:low',
      'thinking:medium',
      'thinking:high',
      'thinking:xhigh',
    ]);
    expect(values).toContain('thinking-skill');
    expect(current.getSuggestions).toHaveBeenCalledTimes(1);
  });

  test('prefers canonical $model: over delegated model items when completing $mod', async () => {
    const delegated = { items: [{ value: 'model', label: 'model' }], prefix: '$mod' };
    const current = createDelegatingProvider(delegated);
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    const result = await provider.getSuggestions(
      ['Please $mod'],
      0,
      'Please $mod'.length,
      createAutocompleteOptions(),
    );

    expect(result?.items[0]?.value).toBe('model:');
    expect(result?.items.map((item) => item.value)).not.toContain('model');
  });

  test('handles leading $model shortcut suggestions', async () => {
    const delegated = { items: [{ value: 'model-skill', label: 'model-skill' }], prefix: '$mod' };
    const current = createDelegatingProvider(delegated);
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    const result = await provider.getSuggestions(
      ['$mod'],
      0,
      '$mod'.length,
      createAutocompleteOptions(),
    );

    const values = result?.items.map((item) => item.value) ?? [];
    expect(values[0]).toBe('model:');
    expect(values).toContain('model:facade/global.anthropic.claude-sonnet-4-6');
    expect(values).toContain('model-skill');
  });

  test('suggests precomputed thinking shortcuts from top-level fuzzy input', async () => {
    const current = createDelegatingProvider();
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    const result = await provider.getSuggestions(
      ['$xh'],
      0,
      '$xh'.length,
      createAutocompleteOptions(),
    );

    expect(result?.prefix).toBe('$xh');
    expect(result?.items.map((item) => item.value)).toContain('thinking:xhigh');
  });

  test('suggests precomputed model shortcuts from top-level fuzzy input', async () => {
    const current = createDelegatingProvider();
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    const result = await provider.getSuggestions(
      ['$fa'],
      0,
      '$fa'.length,
      createAutocompleteOptions(),
    );

    expect(result?.prefix).toBe('$fa');
    expect(result?.items.map((item) => item.value)).toContain(
      'model:facade/global.anthropic.claude-sonnet-4-6',
    );
  });

  test('prefers $skill: over delegated skill-looking suggestions', async () => {
    const delegated = { items: [{ value: 'skill-browser', label: 'skill-browser' }], prefix: '$ski' };
    const current = createDelegatingProvider(delegated);
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    const result = await provider.getSuggestions(
      ['$ski'],
      0,
      '$ski'.length,
      createAutocompleteOptions(),
    );

    const values = result?.items.map((item) => item.value) ?? [];
    expect(values[0]).toBe('skill:');
    expect(values).toContain('skill-browser');
  });

  test('adds $thinking suggestions at whitespace-delimited inline shortcut tokens', async () => {
    const current = createDelegatingProvider();
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    const result = await provider.getSuggestions(
      ['Please $think'],
      0,
      'Please $think'.length,
      createAutocompleteOptions(),
    );

    expect(result?.prefix).toBe('$think');
    expect(result?.items.map((item) => item.value)).toContain('thinking:');
  });

  test('returns thinking level suggestions for leading $thinking arguments', async () => {
    const delegated = { items: [{ value: 'native-thinking', label: 'native-thinking' }], prefix: '$thinking:h' };
    const current = createDelegatingProvider(delegated);
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    const result = await provider.getSuggestions(
      ['$thinking:h'],
      0,
      '$thinking:h'.length,
      createAutocompleteOptions(),
    );

    expect(result?.prefix).toBe('h');
    expect(result?.items.map((item) => item.value)).toEqual(expect.arrayContaining(['high']));
    expect(current.getSuggestions).not.toHaveBeenCalled();
  });

  test('returns thinking level suggestions for inline $thinking arguments', async () => {
    const current = createDelegatingProvider();
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    const result = await provider.getSuggestions(
      ['Please $thinking:h'],
      0,
      'Please $thinking:h'.length,
      createAutocompleteOptions(),
    );

    expect(result?.prefix).toBe('h');
    expect(result?.items.map((item) => item.value)).toEqual(expect.arrayContaining(['high']));
  });

  test('returns provider/model suggestions for $model arguments without aliases', async () => {
    const current = createDelegatingProvider();
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    const result = await provider.getSuggestions(
      ['Please $model:fa'],
      0,
      'Please $model:fa'.length,
      createAutocompleteOptions(),
    );

    expect(result?.prefix).toBe('fa');
    expect(result?.items.map((item) => item.value)).toContain(
      'facade/global.anthropic.claude-sonnet-4-6',
    );
    expect(result?.items.map((item) => item.value)).not.toContain('sonnet');
  });

  test('sorts matching model suggestions newest first', async () => {
    const current = createDelegatingProvider();
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    const nomod = await provider.getSuggestions(
      ['$model:nomod'],
      0,
      '$model:nomod'.length,
      createAutocompleteOptions(),
    );
    expect(nomod?.items.map((item) => item.value).slice(0, 2)).toEqual([
      'openai/gpt-5.5-nomoderation',
      'openai/gpt-5.4-nomoderation',
    ]);

    const opus = await provider.getSuggestions(
      ['$model:claude-opus'],
      0,
      '$model:claude-opus'.length,
      createAutocompleteOptions(),
    );
    expect(opus?.items.map((item) => item.value).slice(0, 2)).toEqual([
      'anthropic/claude-opus-4-8',
      'anthropic/claude-opus-4-5',
    ]);
  });

  test('suggests only the next fast mode state at leading shortcut commands', async () => {
    const current = createDelegatingProvider();
    const provider = createEditorShortcutAutocompleteProvider(current, () => models, () => false);

    const result = await provider.getSuggestions(
      ['$fa'],
      0,
      '$fa'.length,
      createAutocompleteOptions(),
    );

    expect(result?.items.map((item) => item.value)).toContain('fast:on');
    expect(result?.items.map((item) => item.value)).not.toContain('fast:off');
    expect(result?.items.map((item) => item.value)).not.toContain('thinking:');
  });

  test('suggests explicit fast off shortcut completion when fast mode is enabled', async () => {
    const current = createDelegatingProvider();
    const provider = createEditorShortcutAutocompleteProvider(current, () => models, () => true);

    const result = await provider.getSuggestions(
      ['Please $fast'],
      0,
      'Please $fast'.length,
      createAutocompleteOptions(),
    );

    expect(result?.items.map((item) => item.value)).toContain('fast:off');
    expect(result?.items.map((item) => item.value)).not.toContain('fast:on');
  });

  test('does not suggest fast shortcuts when the current model is unsupported', async () => {
    const current = createDelegatingProvider();
    const provider = createEditorShortcutAutocompleteProvider(
      current,
      () => models,
      () => false,
      () => false,
    );

    const result = await provider.getSuggestions(
      ['$fast'],
      0,
      '$fast'.length,
      createAutocompleteOptions(),
    );

    expect(result?.items.map((item) => item.value) ?? []).not.toContain('fast:on');
    expect(result?.items.map((item) => item.value) ?? []).not.toContain('fast:off');
  });

  test('applies shortcut command and argument completions inline', () => {
    const current = createDelegatingProvider();
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);

    expect(
      provider.applyCompletion(
        ['$xh'],
        0,
        '$xh'.length,
        { value: 'thinking:xhigh', label: 'thinking:xhigh' },
        '$xh',
      ),
    ).toMatchObject({ lines: ['$thinking:xhigh '], cursorCol: '$thinking:xhigh '.length });

    expect(
      provider.applyCompletion(
        ['$thi'],
        0,
        '$thi'.length,
        { value: 'thinking:', label: 'thinking:' },
        '$thi',
      ),
    ).toMatchObject({ lines: ['$thinking:'], cursorCol: '$thinking:'.length });

    expect(
      provider.applyCompletion(
        ['Please $think'],
        0,
        'Please $think'.length,
        { value: 'thinking:', label: 'thinking:' },
        '$think',
      ),
    ).toMatchObject({ lines: ['Please $thinking:'], cursorCol: 'Please $thinking:'.length });

    expect(
      provider.applyCompletion(
        ['$thinking:h now'],
        0,
        '$thinking:h'.length,
        { value: 'high', label: 'high' },
        'h',
      ),
    ).toMatchObject({ lines: ['$thinking:high now'], cursorCol: '$thinking:high'.length });

    expect(
      provider.applyCompletion(
        ['$fa'],
        0,
        '$fa'.length,
        { value: 'fast:on', label: 'fast:on' },
        '$fa',
      ),
    ).toMatchObject({ lines: ['$fast:on '], cursorCol: '$fast:on '.length });
  });

  test('delegates native slash command completions unchanged', () => {
    const delegated = { lines: ['/model '], cursorLine: 0, cursorCol: '/model '.length };
    const current = createDelegatingProvider();
    current.applyCompletion.mockReturnValue(delegated);
    const provider = createEditorShortcutAutocompleteProvider(current, () => models);
    const item = { value: 'model', label: 'model' };

    const result = provider.applyCompletion(['/mo'], 0, '/mo'.length, item, '/mo');

    expect(result).toBe(delegated);
    expect(current.applyCompletion).toHaveBeenCalledWith(['/mo'], 0, '/mo'.length, item, '/mo');
  });
});

describe('editorShortcut extension', () => {
  test('registers only /fast as a slash command', () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    expect(harness.registerCommand).toHaveBeenCalledTimes(1);
    expect(harness.registerCommand).toHaveBeenCalledWith('fast', expect.any(Object));
  });

  test('/fast toggles priority service tier for hardcoded supported models', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    const fastCommand = harness.registerCommand.mock.calls[0]?.[1];
    await fastCommand.handler('', { ...harness.ctx, model: models[4] });

    const result = await harness.handlers.get('before_provider_request')?.(
      { type: 'before_provider_request', payload: { model: 'gpt-5.5' } },
      { ...harness.ctx, model: models[4] },
    );

    expect(result).toEqual({ model: 'gpt-5.5', service_tier: 'priority' });
  });

  test.each(['gpt-5.3-codex-spark', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    '/fast supports openai-codex/%s',
    async (modelId) => {
      const harness = createHarness();
      editorShortcut(harness.pi as any);
      const model = { provider: 'openai-codex', id: modelId, name: modelId };

      const fastCommand = harness.registerCommand.mock.calls[0]?.[1];
      await fastCommand.handler('on', { ...harness.ctx, model });

      const result = await harness.handlers.get('before_provider_request')?.(
        { type: 'before_provider_request', payload: { model: modelId } },
        { ...harness.ctx, model },
      );

      expect(result).toEqual({ model: modelId, service_tier: 'priority' });
    },
  );

  test('/fast cannot be enabled for unsupported models', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    const fastCommand = harness.registerCommand.mock.calls[0]?.[1];
    await fastCommand.handler('', { ...harness.ctx, model: models[1] });

    const result = await harness.handlers.get('before_provider_request')?.(
      { type: 'before_provider_request', payload: { model: 'gpt-5.5' } },
      { ...harness.ctx, model: models[4] },
    );

    expect(result).toBeUndefined();
    expect(harness.notify).toHaveBeenCalledWith(
      'Fast mode unavailable: current model does not support priority',
      'warning',
    );
  });

  test('/fast is disabled when switching to an unsupported model', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    const fastCommand = harness.registerCommand.mock.calls[0]?.[1];
    await fastCommand.handler('', { ...harness.ctx, model: models[4] });

    await harness.handlers.get('model_select')?.(
      { type: 'model_select', model: models[1], previousModel: models[4], source: 'set' },
      harness.ctx,
    );

    const result = await harness.handlers.get('before_provider_request')?.(
      { type: 'before_provider_request', payload: { model: 'gpt-5.5' } },
      { ...harness.ctx, model: models[4] },
    );

    expect(result).toBeUndefined();
    expect(harness.notify).toHaveBeenCalledWith(
      'Fast mode: off (current model does not support priority)',
      'warning',
    );
  });

  test('input handler applies inline fast directives', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    const result = await harness.handlers.get('input')?.(
      { text: 'Please $fast:on do the work', source: 'interactive' },
      { ...harness.ctx, model: models[4] },
    );

    const payload = await harness.handlers.get('before_provider_request')?.(
      { type: 'before_provider_request', payload: { model: 'gpt-5.5' } },
      { ...harness.ctx, model: models[4] },
    );

    expect(result).toEqual({ action: 'transform', text: 'Please do the work' });
    expect(payload).toEqual({ model: 'gpt-5.5', service_tier: 'priority' });
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
      { text: '$model:facade\n$thinking:high\nDo the work', source: 'interactive' },
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
      { text: 'Please $thinking:high do the work', source: 'interactive' },
      harness.ctx,
    );

    expect(result).toEqual({ action: 'transform', text: 'Please do the work' });
    expect(harness.setThinkingLevel).toHaveBeenCalledWith('high');
  });

  test('input handler treats command-only shortcuts as handled', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    const result = await harness.handlers.get('input')?.(
      { text: '$thinking:low', source: 'interactive' },
      harness.ctx,
    );

    expect(result).toEqual({ action: 'handled' });
    expect(harness.setThinkingLevel).toHaveBeenCalledWith('low');
  });

  test('input handler ignores extension-originated messages', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    const result = await harness.handlers.get('input')?.(
      { text: '$thinking:low', source: 'extension' },
      harness.ctx,
    );

    expect(result).toEqual({ action: 'continue' });
    expect(harness.setThinkingLevel).not.toHaveBeenCalled();
  });

  test('submission processor can set model and forward trailing prompt text', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    const result = await processEditorShortcutSubmission(
      '$model:facade\nDo the work',
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

  test('input handler lets native slash commands continue unchanged', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    const result = await harness.handlers.get('input')?.(
      { text: '/help', source: 'interactive' },
      harness.ctx,
    );

    expect(result).toEqual({ action: 'continue' });
  });

  test('submission processor handles resolvable command-only model shortcuts', async () => {
    const harness = createHarness();
    editorShortcut(harness.pi as any);

    const result = await processEditorShortcutSubmission(
      '$model:facade',
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
      { text: '$thinking and then do the work', source: 'interactive' },
      harness.ctx,
    );

    expect(result).toEqual({ action: 'continue' });
    expect(harness.setThinkingLevel).not.toHaveBeenCalled();
    expect(harness.notify).not.toHaveBeenCalled();
  });
});
