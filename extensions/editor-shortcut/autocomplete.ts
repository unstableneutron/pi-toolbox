import type { Api, Model } from '@earendil-works/pi-ai/compat';
import type { AutocompleteItem, AutocompleteProvider } from '@earendil-works/pi-tui';
import { fuzzyFilter } from '@earendil-works/pi-tui';

import { getNextFastModeAction, getNextFastModeDirective } from './commands/fast';
import { createModelCompletionItems, uniqueAutocompleteItems } from './commands/model';
import { THINKING_LEVELS } from './commands/thinking';

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
  fastModeEnabled: boolean,
  fastModeSupported: boolean,
  models: Model<Api>[],
  delegated: Awaited<ReturnType<AutocompleteProvider['getSuggestions']>>,
): Awaited<ReturnType<AutocompleteProvider['getSuggestions']>> {
  const fastModeDirective = getNextFastModeDirective(fastModeEnabled);
  const commandItems: AutocompleteItem[] = [
    { value: 'model:', label: 'model:', description: 'Set model for this prompt' },
    ...createModelCompletionItems(models).map((item) => ({
      ...item,
      value: `model:${item.value}`,
      label: `model:${item.label}`,
    })),
    { value: 'thinking:', label: 'thinking:', description: 'Set thinking level for this prompt' },
    ...THINKING_LEVELS.map((level) => ({
      value: `thinking:${level}`,
      label: `thinking:${level}`,
      description: `Set thinking level to ${level}`,
    })),
    { value: 'skill:', label: 'skill:', description: 'Invoke a skill for this prompt' },
    ...(fastModeSupported
      ? [
    {
      value: fastModeDirective,
      label: fastModeDirective,
      description: `Turn fast mode ${getNextFastModeAction(fastModeEnabled)}`,
    },
        ]
      : []),
  ];

  const customItems = filterCommandItems(commandItems, commandPrefix);

  if (customItems.length === 0) return delegated;

  const delegatedItems = (delegated?.items ?? []).filter((item) => {
    return commandPrefix.length === 0 || item.value !== 'model';
  });

  return {
    prefix: `$${commandPrefix}`,
    items: uniqueAutocompleteItems([...customItems, ...delegatedItems]),
  };
}

function filterCommandItems(items: AutocompleteItem[], commandPrefix: string): AutocompleteItem[] {
  if (!commandPrefix) return items;
  return filterAutocompleteItems(items, commandPrefix);
}

function getShortcutDirectiveContext(
  textBeforeCursor: string,
):
  | { kind: 'command'; commandPrefix: string }
  | {
      kind: 'argument';
      command: 'model' | 'thinking' | 'fast';
      argumentPrefix: string;
    }
  | null {
  const commandMatch = textBeforeCursor.match(/(?:^|\s)\$([a-z-]*)$/i);
  if (commandMatch) {
    return { kind: 'command', commandPrefix: commandMatch[1] ?? '' };
  }

  const argumentMatch = textBeforeCursor.match(/(?:^|\s)\$(model|thinking|fast):(\S*)$/i);
  if (!argumentMatch) return null;

  return {
    kind: 'argument',
    command: argumentMatch[1]!.toLowerCase() as 'model' | 'thinking' | 'fast',
    argumentPrefix: argumentMatch[2] ?? '',
  };
}

export function createEditorShortcutAutocompleteProvider(
  current: AutocompleteProvider,
  getModels: () => Model<Api>[],
  getFastModeEnabled: () => boolean = () => false,
  getFastModeSupported: () => boolean = () => true,
): AutocompleteProvider {
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), '/', '$'])],

    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const textBeforeCursor = (lines[cursorLine] ?? '').slice(0, cursorCol);
      const context = getShortcutDirectiveContext(textBeforeCursor);

      if (!context) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      if (context.kind === 'command') {
        const delegated = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        return getDirectiveCommandSuggestions(
          context.commandPrefix,
          getFastModeEnabled(),
          getFastModeSupported(),
          getModels(),
          delegated,
        );
      }

      if (context.command === 'fast') {
        if (!getFastModeSupported()) return null;
        const values = [getNextFastModeAction(getFastModeEnabled())];
        const items = filterAutocompleteItems(
          values.map((value) => ({ value, label: value })),
          context.argumentPrefix,
        );
        return items.length === 0 ? null : { items, prefix: context.argumentPrefix };
      }

      if (context.command === 'thinking') {
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
      if (prefix.startsWith('$')) {
        const line = lines[cursorLine] ?? '';
        const before = line.slice(0, cursorCol - prefix.length);
        const after = line.slice(cursorCol);
        const separator = item.value.endsWith(':') ? '' : ' ';

        return {
          lines: [
            ...lines.slice(0, cursorLine),
            `${before}$${item.value}${separator}${after}`,
            ...lines.slice(cursorLine + 1),
          ],
          cursorLine,
          cursorCol: before.length + item.value.length + 1 + separator.length,
        };
      }

      const textBeforeCursor = (lines[cursorLine] ?? '').slice(0, cursorCol);
      const context = getShortcutDirectiveContext(textBeforeCursor);
      if (context?.kind !== 'argument') {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
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
