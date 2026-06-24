import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai/compat';
import type {
  AutocompleteItem,
  AutocompleteProvider,
  EditorComponent,
} from '@earendil-works/pi-tui';
import { fuzzyFilter } from '@earendil-works/pi-tui';

import { hasTui } from '../shared/ui-mode';

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

type EditorShortcutDirective =
  | { command: 'model'; value: string }
  | { command: 'thinking'; value: string };

type ParsedEditorShortcut = {
  directives: EditorShortcutDirective[];
  promptText: string;
};

type DirectiveToken = {
  directive: EditorShortcutDirective;
  start: number;
  end: number;
};

type EditorFactory = NonNullable<ReturnType<ExtensionContext['ui']['getEditorComponent']>>;

type WrappedEditorFactory = EditorFactory & {
  [EDITOR_SHORTCUT_WRAPPED_FACTORY]?: true;
  [EDITOR_SHORTCUT_BASE_FACTORY]?: EditorFactory | undefined;
};

type SubmitResult =
  | { action: 'continue' }
  | { action: 'handled' }
  | { action: 'restore'; text: string }
  | { action: 'submit'; text: string };

type CustomEditorSurface = EditorComponent & {
  actionHandlers?: Map<string, () => void>;
  onAction?: (action: string, handler: () => void) => void;
  onEscape?: () => void;
  onCtrlD?: () => void;
  onPasteImage?: () => void;
  onExtensionShortcut?: (data: string) => boolean;
  wantsKeyRelease?: boolean;
};

const EDITOR_SHORTCUT_WRAPPED_FACTORY = Symbol.for('pi-toolbox.editor-shortcut.wrapped-factory');
const EDITOR_SHORTCUT_BASE_FACTORY = Symbol.for('pi-toolbox.editor-shortcut.base-factory');

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

const MODEL_ALIASES: Record<string, string> = {
  codex: 'openai-codex/gpt-5.5',
  gpt: 'openai/gpt-5.5',
  '55': 'openai/gpt-5.5',
  mini: 'openai/gpt-5.4-mini',
  nano: 'openai/gpt-5.4-nano',
  haiku: 'anthropic/claude-haiku-4-5',
  sonnet: 'anthropic/claude-sonnet-4-6',
  opus: 'anthropic/claude-opus-4-8',
  gemini: 'google/gemini-3.1-pro-preview',
  pro: 'google/gemini-3.1-pro-preview',
  flash: 'google/gemini-3.5-flash',
  'flash-lite': 'google/gemini-3.1-flash-lite-preview',
  lite: 'google/gemini-3.1-flash-lite-preview',
};

function uniqueAutocompleteItems(items: AutocompleteItem[]): AutocompleteItem[] {
  const seen = new Set<string>();
  const unique: AutocompleteItem[] = [];

  for (const item of items) {
    const key = item.value;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  return unique;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel);
}

function parseDirectiveLine(line: string): EditorShortcutDirective | null {
  const match = line.match(/^\/(model|thinking|reasoning):(\S+)$/i);
  if (!match) return null;

  const command = match[1]!.toLowerCase();
  const value = match[2]!.trim();

  if (
    (command === 'thinking' || command === 'reasoning') &&
    !isThinkingLevel(value.toLowerCase())
  ) {
    return null;
  }

  return command === 'model' ? { command: 'model', value } : { command: 'thinking', value };
}

function normalizePromptText(text: string): string {
  return text
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractDirectiveTokens(text: string): DirectiveToken[] {
  const tokens: DirectiveToken[] = [];
  const pattern = /(^|\s)\/(model|thinking|reasoning):(\S+)/gi;

  for (const match of text.matchAll(pattern)) {
    const value = match[3];
    if (!value) continue;

    const command = match[2]!.toLowerCase();
    if (
      (command === 'thinking' || command === 'reasoning') &&
      !isThinkingLevel(value.toLowerCase())
    ) {
      continue;
    }

    const leadingWhitespace = match[1] ?? '';
    const start = match.index! + leadingWhitespace.length;
    const end = match.index! + match[0].length;

    tokens.push({
      directive: command === 'model' ? { command: 'model', value } : { command: 'thinking', value },
      start,
      end,
    });
  }

  return tokens;
}

function removeDirectiveTokens(text: string, tokens: DirectiveToken[]): string {
  let result = '';
  let cursor = 0;

  for (const token of tokens) {
    result += text.slice(cursor, token.start);
    cursor = token.end;
  }

  result += text.slice(cursor);
  return normalizePromptText(result);
}

export function parseEditorShortcutText(text: string): ParsedEditorShortcut | null {
  const normalizedText = text.replace(/\r\n/g, '\n');
  const tokens = extractDirectiveTokens(normalizedText);

  if (tokens.length === 0) {
    const leadingLines = normalizedText.split('\n');
    const directives: EditorShortcutDirective[] = [];
    let index = 0;

    while (index < leadingLines.length && leadingLines[index]!.trim() === '') index++;

    for (; index < leadingLines.length; index++) {
      const line = leadingLines[index]!;
      const directive = parseDirectiveLine(line.trim());
      if (!directive) break;
      directives.push(directive);
    }

    if (directives.length === 0) return null;

    return {
      directives,
      promptText: normalizePromptText(leadingLines.slice(index).join('\n')),
    };
  }

  return {
    directives: tokens.map((token) => token.directive),
    promptText: removeDirectiveTokens(normalizedText, tokens),
  };
}

function normalizeModelRef(value: string): string {
  return value.trim().toLowerCase();
}

function modelRef(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function sameModelName(model: Model<Api>, value: string): boolean {
  const normalized = normalizeModelRef(value);
  return (
    normalizeModelRef(model.id) === normalized ||
    normalizeModelRef(model.name ?? '') === normalized ||
    normalizeModelRef(modelRef(model)) === normalized
  );
}

function rankModelMatch(model: Model<Api>, query: string): number {
  const normalizedQuery = normalizeModelRef(query);
  const id = normalizeModelRef(model.id);
  const name = normalizeModelRef(model.name ?? '');
  const ref = normalizeModelRef(modelRef(model));

  if (id === normalizedQuery || name === normalizedQuery || ref === normalizedQuery) return 1000;
  if (id.startsWith(normalizedQuery) || name.startsWith(normalizedQuery)) return 800;
  if (ref.includes(normalizedQuery)) return 600;
  if (id.includes(normalizedQuery) || name.includes(normalizedQuery)) return 500;
  return 0;
}

function pickBestModel(
  models: Model<Api>[],
  query: string,
): Model<Api> | { ambiguous: Model<Api>[] } | null {
  const ranked = models
    .map((model) => ({ model, score: rankModelMatch(model, query) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.model.id.length - b.model.id.length);

  if (ranked.length === 0) return null;

  const bestScore = ranked[0]!.score;
  const tied = ranked.filter((match) => match.score === bestScore).map((match) => match.model);
  return tied.length === 1 ? tied[0]! : { ambiguous: tied };
}

export function resolveEditorShortcutModel(
  rawQuery: string,
  models: Model<Api>[],
  currentModel?: Model<Api>,
): Model<Api> | { error: string } {
  const query = MODEL_ALIASES[normalizeModelRef(rawQuery)] ?? rawQuery.trim();
  if (!query) return { error: 'Usage: /model <model-or-provider/model>' };

  const slashIndex = query.indexOf('/');
  if (slashIndex !== -1) {
    const provider = query.slice(0, slashIndex).trim();
    const modelQuery = query.slice(slashIndex + 1).trim();
    const providerModels = models.filter(
      (model) => normalizeModelRef(model.provider) === normalizeModelRef(provider),
    );
    const exact = providerModels.find((model) => sameModelName(model, modelQuery));
    if (exact) return exact;

    const best = pickBestModel(providerModels, modelQuery);
    if (!best) return { error: `No model matches ${query}` };
    if ('ambiguous' in best) return { error: formatAmbiguousModels(query, best.ambiguous) };
    return best;
  }

  const exact = models.filter((model) => sameModelName(model, query));
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return { error: formatAmbiguousModels(query, exact) };

  const providerModels = models.filter(
    (model) => normalizeModelRef(model.provider) === normalizeModelRef(query),
  );
  if (providerModels.length === 1) return providerModels[0]!;
  if (providerModels.length > 1 && currentModel) {
    const matchingCurrent = providerModels.find(
      (model) =>
        sameModelName(model, currentModel.id) ||
        (currentModel.name && sameModelName(model, currentModel.name)),
    );
    if (matchingCurrent) return matchingCurrent;
  }
  if (providerModels.length > 1) return { error: formatAmbiguousModels(query, providerModels) };

  const best = pickBestModel(models, query);
  if (!best) return { error: `No model matches ${query}` };
  if ('ambiguous' in best) return { error: formatAmbiguousModels(query, best.ambiguous) };
  return best;
}

function formatAmbiguousModels(query: string, models: Model<Api>[]): string {
  const sample = models.slice(0, 5).map(modelRef).join(', ');
  const suffix = models.length > 5 ? `, +${models.length - 5} more` : '';
  return `Ambiguous model "${query}". Matches: ${sample}${suffix}`;
}

function getModelCandidates(ctx: ExtensionContext): Model<Api>[] {
  const available = ctx.modelRegistry.getAvailable();
  return (available.length > 0 ? available : ctx.modelRegistry.getAll()) as Model<Api>[];
}

function createModelCompletionItems(models: Model<Api>[]): AutocompleteItem[] {
  const modelItems: AutocompleteItem[] = models.map((model) => ({
    value: modelRef(model),
    label: model.id,
    description: model.name ? `${model.provider} — ${model.name}` : model.provider,
  }));

  const providerCounts = new Map<string, number>();
  for (const model of models) {
    providerCounts.set(model.provider, (providerCounts.get(model.provider) ?? 0) + 1);
  }

  const providerItems: AutocompleteItem[] = [...providerCounts.entries()].map(
    ([provider, count]) => ({
      value: provider,
      label: provider,
      description: `${count} model${count === 1 ? '' : 's'} from provider`,
    }),
  );

  const aliasItems: AutocompleteItem[] = Object.entries(MODEL_ALIASES).map(([alias, target]) => ({
    value: alias,
    label: alias,
    description: `alias → ${target}`,
  }));

  return uniqueAutocompleteItems([...providerItems, ...aliasItems, ...modelItems]);
}

function filterAutocompleteItems(items: AutocompleteItem[], query: string): AutocompleteItem[] {
  if (!query) return items;
  return fuzzyFilter(
    items,
    query,
    (item) => `${item.value} ${item.label} ${item.description ?? ''}`,
  );
}

function getDirectiveCommandSuggestions(
  commandPrefix: string,
  delegated: Awaited<ReturnType<AutocompleteProvider['getSuggestions']>>,
): Awaited<ReturnType<AutocompleteProvider['getSuggestions']>> {
  const customItems = filterAutocompleteItems(
    [
      { value: 'model:', label: 'model:', description: 'Set model for this prompt' },
      { value: 'thinking:', label: 'thinking:', description: 'Set thinking level for this prompt' },
      { value: 'reasoning:', label: 'reasoning:', description: 'Alias for /thinking' },
    ],
    commandPrefix,
  );

  if (customItems.length === 0) return delegated;

  const delegatedItems = (delegated?.items ?? []).filter((item) => {
    return commandPrefix.length === 0 || item.value !== 'model';
  });

  return {
    prefix: `/${commandPrefix}`,
    items: uniqueAutocompleteItems([...customItems, ...delegatedItems]),
  };
}

function getSlashDirectiveContext(
  textBeforeCursor: string,
):
  | { kind: 'command'; commandPrefix: string }
  | { kind: 'argument'; command: 'model' | 'thinking' | 'reasoning'; argumentPrefix: string }
  | null {
  const commandMatch = textBeforeCursor.match(/(?:^|\s)\/([a-z-]*)$/i);
  if (commandMatch) {
    return { kind: 'command', commandPrefix: commandMatch[1] ?? '' };
  }

  const argumentMatch = textBeforeCursor.match(/(?:^|\s)\/(model|thinking|reasoning):(\S*)$/i);
  if (!argumentMatch) return null;

  return {
    kind: 'argument',
    command: argumentMatch[1]!.toLowerCase() as 'model' | 'thinking' | 'reasoning',
    argumentPrefix: argumentMatch[2] ?? '',
  };
}

export function createEditorShortcutAutocompleteProvider(
  current: AutocompleteProvider,
  getModels: () => Model<Api>[],
): AutocompleteProvider {
  return {
    triggerCharacters: ['/'],

    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const textBeforeCursor = (lines[cursorLine] ?? '').slice(0, cursorCol);
      const context = getSlashDirectiveContext(textBeforeCursor);

      if (!context) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      if (context.kind === 'command') {
        const delegated = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        return getDirectiveCommandSuggestions(context.commandPrefix, delegated);
      }

      if (context.command === 'thinking' || context.command === 'reasoning') {
        const items = filterAutocompleteItems(
          THINKING_LEVELS.map((level) => ({ value: level, label: level })),
          context.argumentPrefix,
        );
        return items.length === 0 ? null : { items, prefix: context.argumentPrefix };
      }

      const items = filterAutocompleteItems(
        createModelCompletionItems(getModels()),
        context.argumentPrefix,
      );
      return items.length === 0 ? null : { items, prefix: context.argumentPrefix };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (prefix.startsWith('/')) {
        const line = lines[cursorLine] ?? '';
        const before = line.slice(0, cursorCol - prefix.length);
        const after = line.slice(cursorCol);
        const separator = item.value.endsWith(':') ? '' : ' ';

        return {
          lines: [
            ...lines.slice(0, cursorLine),
            `${before}/${item.value}${separator}${after}`,
            ...lines.slice(cursorLine + 1),
          ],
          cursorLine,
          cursorCol: before.length + item.value.length + 1 + separator.length,
        };
      }

      const line = lines[cursorLine] ?? '';
      const before = line.slice(0, cursorCol - prefix.length);
      const after = line.slice(cursorCol);
      const separator =
        after.startsWith(' ') || after.startsWith('\t') || after.startsWith('\n') ? '' : ' ';

      return {
        lines: [
          ...lines.slice(0, cursorLine),
          `${before}${item.value}${separator}${after}`,
          ...lines.slice(cursorLine + 1),
        ],
        cursorLine,
        cursorCol: before.length + item.value.length + separator.length,
      };
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

async function applyDirective(
  directive: EditorShortcutDirective,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<boolean> {
  if (directive.command === 'thinking') {
    const level = directive.value.toLowerCase();
    if (!isThinkingLevel(level)) {
      ctx.ui.notify(`Usage: /thinking ${THINKING_LEVELS.join('|')}`, 'warning');
      return false;
    }
    pi.setThinkingLevel(level);
    ctx.ui.notify(`Thinking: ${level}`, 'info');
    return true;
  }

  const model = resolveEditorShortcutModel(
    directive.value,
    getModelCandidates(ctx),
    ctx.model as Model<Api> | undefined,
  );
  if ('error' in model) {
    ctx.ui.notify(model.error, 'warning');
    return false;
  }

  const success = await pi.setModel(model);
  if (!success) {
    ctx.ui.notify(`No API key for ${modelRef(model)}`, 'warning');
    return false;
  }
  ctx.ui.notify(`Model: ${modelRef(model)}`, 'info');
  return true;
}

async function applyDirectives(
  parsed: ParsedEditorShortcut,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<boolean> {
  for (const directive of parsed.directives) {
    if (!(await applyDirective(directive, pi, ctx))) return false;
  }
  return true;
}

export async function processEditorShortcutSubmission(
  text: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<SubmitResult> {
  const parsed = parseEditorShortcutText(text);
  if (!parsed) return { action: 'continue' };

  if (!(await applyDirectives(parsed, pi, ctx))) return { action: 'restore', text };

  return parsed.promptText ? { action: 'submit', text: parsed.promptText } : { action: 'handled' };
}

class EditorShortcutWrappedEditor implements EditorComponent {
  private downstreamSubmit?: (text: string) => void;

  constructor(
    private readonly base: EditorComponent,
    private readonly processSubmission: (text: string) => Promise<SubmitResult>,
  ) {
    this.base.onSubmit = (text) => {
      void this.handleSubmit(text);
    };
  }

  get actionHandlers() {
    return (this.base as CustomEditorSurface).actionHandlers;
  }

  get onEscape() {
    return (this.base as CustomEditorSurface).onEscape;
  }
  set onEscape(value: (() => void) | undefined) {
    (this.base as CustomEditorSurface).onEscape = value;
  }

  get onCtrlD() {
    return (this.base as CustomEditorSurface).onCtrlD;
  }
  set onCtrlD(value: (() => void) | undefined) {
    (this.base as CustomEditorSurface).onCtrlD = value;
  }

  get onPasteImage() {
    return (this.base as CustomEditorSurface).onPasteImage;
  }
  set onPasteImage(value: (() => void) | undefined) {
    (this.base as CustomEditorSurface).onPasteImage = value;
  }

  get onExtensionShortcut() {
    return (this.base as CustomEditorSurface).onExtensionShortcut;
  }
  set onExtensionShortcut(value: ((data: string) => boolean) | undefined) {
    (this.base as CustomEditorSurface).onExtensionShortcut = value;
  }

  get wantsKeyRelease() {
    return (this.base as CustomEditorSurface).wantsKeyRelease;
  }
  set wantsKeyRelease(value: boolean | undefined) {
    (this.base as CustomEditorSurface).wantsKeyRelease = value;
  }

  get borderColor() {
    return this.base.borderColor;
  }
  set borderColor(value: ((str: string) => string) | undefined) {
    this.base.borderColor = value;
  }

  get onSubmit() {
    return this.downstreamSubmit;
  }
  set onSubmit(value: ((text: string) => void) | undefined) {
    this.downstreamSubmit = value;
  }

  get onChange() {
    return this.base.onChange;
  }
  set onChange(value: ((text: string) => void) | undefined) {
    this.base.onChange = value;
  }

  onAction(action: string, handler: () => void): void {
    (this.base as CustomEditorSurface).onAction?.(action, handler);
  }

  render(width: number): string[] {
    return this.base.render(width);
  }

  invalidate(): void {
    this.base.invalidate();
  }

  getText(): string {
    return this.base.getText();
  }

  setText(text: string): void {
    this.base.setText(text);
  }

  handleInput(data: string): void {
    this.base.handleInput(data);
  }

  addToHistory(text: string): void {
    this.base.addToHistory?.(text);
  }

  insertTextAtCursor(text: string): void {
    this.base.insertTextAtCursor?.(text);
  }

  getExpandedText(): string {
    return this.base.getExpandedText?.() ?? this.base.getText();
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.base.setAutocompleteProvider?.(provider);
  }

  setPaddingX(padding: number): void {
    this.base.setPaddingX?.(padding);
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.base.setAutocompleteMaxVisible?.(maxVisible);
  }

  private async handleSubmit(text: string): Promise<void> {
    const result = await this.processSubmission(text);

    if (result.action === 'continue') {
      this.downstreamSubmit?.(text);
      return;
    }

    if (result.action === 'submit') {
      this.downstreamSubmit?.(result.text);
      return;
    }

    if (result.action === 'restore') {
      this.base.setText(result.text);
    }
  }
}

function createWrappedEditorFactory(
  baseFactory: EditorFactory | undefined,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): WrappedEditorFactory {
  const factory = ((tui, theme, keybindings) => {
    const base =
      baseFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
    return new EditorShortcutWrappedEditor(base, (text) =>
      processEditorShortcutSubmission(text, pi, ctx),
    );
  }) as WrappedEditorFactory;

  factory[EDITOR_SHORTCUT_WRAPPED_FACTORY] = true;
  factory[EDITOR_SHORTCUT_BASE_FACTORY] = baseFactory;
  return factory;
}

export default function editorShortcut(pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    if (!hasTui(ctx)) return;

    ctx.ui.addAutocompleteProvider((current) =>
      createEditorShortcutAutocompleteProvider(current, () => getModelCandidates(ctx)),
    );

    const previousFactory = ctx.ui.getEditorComponent() as WrappedEditorFactory | undefined;
    const baseFactory = previousFactory?.[EDITOR_SHORTCUT_BASE_FACTORY] ?? previousFactory;
    ctx.ui.setEditorComponent(createWrappedEditorFactory(baseFactory, pi, ctx));
  });

  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension') {
      return { action: 'continue' as const };
    }

    const parsed = parseEditorShortcutText(event.text);
    if (!parsed) return { action: 'continue' as const };

    const success = await applyDirectives(parsed, pi, ctx);
    if (!success || !parsed.promptText) return { action: 'handled' as const };

    return { action: 'transform' as const, text: parsed.promptText };
  });
}
