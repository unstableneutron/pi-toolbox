import { AgentSession, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AutocompleteItem, AutocompleteProvider } from '@earendil-works/pi-tui';
import { fuzzyFilter } from '@earendil-works/pi-tui';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

type SkillCommand = {
  name: string;
  description?: string;
  filePath?: string;
  baseDir?: string;
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

const SKILL_COMMAND_PATTERN = /(?:^|(?<=\s))\/skill:([a-z0-9][-a-z0-9]*)\b/g;
const SKILL_BLOCK_PATTERN =
  /<skill name="[^"]+" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n|$)/gy;
const PROMPT_SPLITTER_PATCHED = Symbol.for('pi-toolbox.skill-shortcut.prompt-splitter-patched');

type PatchableAgentSessionConstructor = {
  prototype: {
    [PROMPT_SPLITTER_PATCHED]?: true;
    _runAgentPrompt?: (messages: AgentMessage | AgentMessage[]) => Promise<void>;
  };
};

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

function formatSkillBlock(skill: Required<Pick<SkillCommand, 'baseDir' | 'filePath' | 'name'>>) {
  const content = readFileSync(skill.filePath, 'utf8');
  const body = stripFrontmatter(content);
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

export function splitLeadingSkillBlocks(text: string): {
  skillBlocks: string[];
  userText: string;
} | null {
  SKILL_BLOCK_PATTERN.lastIndex = 0;
  const skillBlocks: string[] = [];
  let index = 0;

  while (true) {
    SKILL_BLOCK_PATTERN.lastIndex = index;
    const match = SKILL_BLOCK_PATTERN.exec(text);
    if (!match || match.index !== index) break;

    skillBlocks.push(match[0].replace(/\n\n$/, ''));
    index = SKILL_BLOCK_PATTERN.lastIndex;
  }

  if (skillBlocks.length === 0) {
    return null;
  }

  return { skillBlocks, userText: text.slice(index).trim() };
}

function splitConsecutiveSkillBlocksInMessage(message: AgentMessage): AgentMessage[] {
  if (message.role !== 'user') return [message];

  if (typeof message.content === 'string') {
    const split = splitLeadingSkillBlocks(message.content);
    if (!split || split.skillBlocks.length < 2) return [message];

    const skillMessages: AgentMessage[] = split.skillBlocks.map((skillBlock) => ({
      role: 'user',
      content: [{ type: 'text', text: skillBlock }],
      timestamp: message.timestamp,
    }));

    return split.userText
      ? [
          ...skillMessages,
          {
            role: 'user',
            content: [{ type: 'text', text: split.userText }],
            timestamp: message.timestamp,
          },
        ]
      : skillMessages;
  }

  const [firstContent, ...remainingContent] = message.content;
  if (firstContent?.type !== 'text') return [message];

  const split = splitLeadingSkillBlocks(firstContent.text);
  if (!split || split.skillBlocks.length < 2) return [message];

  const timestamp = message.timestamp;
  const skillMessages: AgentMessage[] = split.skillBlocks.map((skillBlock) => ({
    role: 'user',
    content: [{ type: 'text', text: skillBlock }],
    timestamp,
  }));
  const trailingContent = [
    ...(split.userText ? [{ type: 'text' as const, text: split.userText }] : []),
    ...remainingContent,
  ];

  return trailingContent.length > 0
    ? [...skillMessages, { role: 'user', content: trailingContent, timestamp }]
    : skillMessages;
}

export function splitConsecutiveSkillBlocksInPromptMessages<
  T extends AgentMessage | AgentMessage[],
>(messages: T): T | AgentMessage[] {
  if (!Array.isArray(messages)) {
    const split = splitConsecutiveSkillBlocksInMessage(messages);
    return split.length === 1 ? messages : split;
  }

  let changed = false;
  const splitMessages = messages.flatMap((message) => {
    const split = splitConsecutiveSkillBlocksInMessage(message);
    changed ||= split.length !== 1 || split[0] !== message;
    return split;
  });

  return changed ? splitMessages : messages;
}

export function installConsecutiveSkillBlockPromptPatch(
  agentSessionConstructor: PatchableAgentSessionConstructor = AgentSession as unknown as PatchableAgentSessionConstructor,
): void {
  const prototype = agentSessionConstructor.prototype;
  if (prototype[PROMPT_SPLITTER_PATCHED]) return;
  const originalRunAgentPrompt = prototype._runAgentPrompt;
  if (typeof originalRunAgentPrompt !== 'function') return;

  Object.defineProperty(prototype, PROMPT_SPLITTER_PATCHED, { value: true });
  prototype._runAgentPrompt = function patchedRunAgentPrompt(
    this: unknown,
    messages: AgentMessage | AgentMessage[],
  ) {
    return originalRunAgentPrompt.call(this, splitConsecutiveSkillBlocksInPromptMessages(messages));
  };
}

function expandSkillCommandMentions(text: string, skillCommands: SkillCommand[]): string | null {
  const skillsByName = new Map(
    skillCommands
      .filter((skill) => skill.filePath)
      .map((skill) => [
        skill.name,
        {
          ...skill,
          baseDir: skill.baseDir ?? dirname(skill.filePath!),
          filePath: skill.filePath!,
        },
      ]),
  );
  const skillBlocks: string[] = [];
  const seenSkillNames = new Set<string>();

  const userText = text.replace(SKILL_COMMAND_PATTERN, (match, name: string) => {
    const skill = skillsByName.get(name);
    if (!skill) {
      return match;
    }

    if (!seenSkillNames.has(name)) {
      seenSkillNames.add(name);
      skillBlocks.push(formatSkillBlock(skill));
    }
    return `[skill:${name}]`;
  });

  if (skillBlocks.length === 0) {
    return null;
  }

  return [...skillBlocks, userText.trim()].filter(Boolean).join('\n\n');
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
  installConsecutiveSkillBlockPromptPatch();

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
          filePath: command.sourceInfo?.path,
          baseDir: command.sourceInfo?.baseDir,
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
    if (event.source === 'extension') {
      return { action: 'continue' as const };
    }

    const transformed = transformSkillShortcutInput(event.text, skillNames);

    const expanded = expandSkillCommandMentions(transformed, skillCommands);
    if (expanded) {
      pi.sendUserMessage(
        event.images?.length
          ? [{ type: 'text' as const, text: expanded }, ...event.images]
          : expanded,
        event.streamingBehavior ? { deliverAs: event.streamingBehavior } : undefined,
      );
      return { action: 'handled' as const };
    }

    return transformed === event.text
      ? { action: 'continue' as const }
      : { action: 'transform' as const, text: transformed };
  });
}
