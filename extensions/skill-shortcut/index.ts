import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { AutocompleteItem, AutocompleteProvider } from '@mariozechner/pi-tui';
import { fuzzyFilter } from '@mariozechner/pi-tui';

import {
  readEditorSnapshot,
  registerExtensionEditorBehavior,
  requestEditorAutocomplete,
  type EditorBehavior,
} from '../shared/editor-behaviors';

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

export function createSkillShortcutBehavior(
  getSkillCommands: () => SkillCommand[],
): EditorBehavior {
  return {
    id: 'skill-shortcut',
    priority: 50,
    wrapAutocompleteProvider(provider: AutocompleteProvider): AutocompleteProvider {
      return {
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const textBeforeCursor = (lines[cursorLine] || '').slice(0, cursorCol);
          const dollarPrefix = extractDollarPrefix(textBeforeCursor);

          if (dollarPrefix && isPotentialSkillShortcutToken(dollarPrefix)) {
            const query = dollarPrefix.slice(1);
            const items = fuzzyFilter(getSkillCommands(), query, (item) => item.name).map(
              (item) => ({
                value: item.name,
                label: item.name,
                ...(item.description && { description: item.description }),
              }),
            );

            return items.length ? { items, prefix: dollarPrefix } : null;
          }

          return provider.getSuggestions(lines, cursorLine, cursorCol, options);
        },
        applyCompletion(lines, cursorLine, cursorCol, item: AutocompleteItem, prefix) {
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

          return provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },
      };
    },
    afterHandleInput(data, editor, meta) {
      if (meta.wasShowingAutocomplete) return;
      if (data.length !== 1 || data.charCodeAt(0) < 32) return;

      const snapshot = readEditorSnapshot(editor);
      if (!snapshot) return;

      const textBeforeCursor = (snapshot.lines[snapshot.cursorLine] || '').slice(
        0,
        snapshot.cursorCol,
      );
      const dollarPrefix = extractDollarPrefix(textBeforeCursor);
      if (dollarPrefix && isPotentialSkillShortcutToken(dollarPrefix)) {
        requestEditorAutocomplete(editor);
      }
    },
  };
}

export default function skillShortcut(pi: ExtensionAPI) {
  const skillCommands: SkillCommand[] = [];
  const skillNames: string[] = [];

  registerExtensionEditorBehavior(
    pi,
    createSkillShortcutBehavior(() => skillCommands),
  );

  pi.on('session_start', () => {
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
  });

  pi.on('input', (event) => {
    const transformed = transformSkillShortcutInput(event.text, skillNames);
    return transformed === event.text
      ? { action: 'continue' as const }
      : { action: 'transform' as const, text: transformed };
  });
}
