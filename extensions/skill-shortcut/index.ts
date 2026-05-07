import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem, AutocompleteProvider } from '@earendil-works/pi-tui';
import { fuzzyFilter } from '@earendil-works/pi-tui';

type SkillCommand = {
  name: string;
  description?: string;
};

const DELIMITERS = new Set([' ', '\t', '\n']);

function isPotentialSkillShortcutToken(token: string): boolean {
  return /^\$(?:|[a-z0-9][-a-z0-9]*)$/.test(token);
}

export function extractDollarPrefix(textBeforeCursor: string): string | null {
  for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
    if (DELIMITERS.has(textBeforeCursor[i]!)) {
      const token = textBeforeCursor.slice(i + 1);
      return token.startsWith('$') ? token : null;
    }
  }

  return textBeforeCursor.startsWith('$') ? textBeforeCursor : null;
}

export function transformSkillShortcutInput(text: string, skillNames: string[]): string {
  return text.replace(/(?:^|(?<=\s))\$([a-z0-9][-a-z0-9]*)/g, (match, name: string) => {
    return skillNames.includes(name) ? `/skill:${name}` : match;
  });
}

/**
 * Build an autocomplete provider that layers `$skill-name` suggestions on top
 * of the built-in slash/path provider. Delegates to `current` whenever the
 * cursor is not inside a valid `$…` token.
 */
export function createSkillAutocompleteProvider(
  current: AutocompleteProvider,
  getSkillCommands: () => SkillCommand[],
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const textBeforeCursor = (lines[cursorLine] || '').slice(0, cursorCol);
      const dollarPrefix = extractDollarPrefix(textBeforeCursor);

      if (!dollarPrefix || !isPotentialSkillShortcutToken(dollarPrefix)) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const query = dollarPrefix.slice(1);
      const items: AutocompleteItem[] = fuzzyFilter(
        getSkillCommands(),
        query,
        (item) => item.name,
      ).map((item) => ({
        value: item.name,
        label: item.name,
        ...(item.description && { description: item.description }),
      }));

      if (items.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return { items, prefix: dollarPrefix };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (prefix.startsWith('$') && isPotentialSkillShortcutToken(prefix)) {
        const line = lines[cursorLine] || '';
        const before = line.slice(0, cursorCol - prefix.length);
        const after = line.slice(cursorCol);
        const separator =
          after.startsWith(' ') || after.startsWith('\t') || after.startsWith('\n') ? '' : ' ';

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

      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

export default function skillShortcut(pi: ExtensionAPI) {
  const skillCommands: SkillCommand[] = [];
  const skillNames: string[] = [];

  function refreshSkillList(): void {
    const commands = pi.getCommands();
    skillCommands.splice(
      0,
      skillCommands.length,
      ...commands
        .filter((command) => command.source === 'skill')
        .map((command) => ({
          name: command.name.replace(/^skill:/, ''),
          description: command.description,
        })),
    );
    skillNames.splice(0, skillNames.length, ...skillCommands.map((command) => command.name));
  }

  pi.on('session_start', (_event, ctx) => {
    refreshSkillList();
    ctx.ui.addAutocompleteProvider((current) =>
      createSkillAutocompleteProvider(current, () => skillCommands),
    );
  });

  pi.on('input', (event) => {
    const transformed = transformSkillShortcutInput(event.text, skillNames);
    return transformed === event.text
      ? { action: 'continue' as const }
      : { action: 'transform' as const, text: transformed };
  });
}
