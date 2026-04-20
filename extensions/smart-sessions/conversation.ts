import type { SessionEntry } from '@mariozechner/pi-coding-agent';

export interface ConversationSnapshot {
  conversation: string;
  conversationHash: string;
  messageCount: number;
  lastMessageEntryId: string | null;
  lastMessageTimestamp: string | null;
}

export interface RollingSummaryInput {
  mode: 'incremental' | 'rebuild';
  freshConversation: string;
  freshMessageCount: number;
  checkpointEntryId: string | null;
  snapshot?: ConversationSnapshot;
}

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';

  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        !!part &&
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part,
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function formatMessage(role: 'user' | 'assistant', text: string): string {
  return `<${role}>\n${text}\n</${role}>`;
}

function hashString(value: string): string {
  let hash = 2166136261;

  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

function getMessageEntries(entries: SessionEntry[]): Array<
  SessionEntry & {
    type: 'message';
    message: { role: 'user' | 'assistant'; content: unknown };
  }
> {
  return entries.filter((entry): entry is SessionEntry & { type: 'message'; message: any } => {
    if (entry.type !== 'message') return false;
    const role = entry.message.role;
    if (role !== 'user' && role !== 'assistant') return false;
    return !!extractText(entry.message.content);
  });
}

export function buildConversationSnapshot(
  entries: SessionEntry[],
): ConversationSnapshot | undefined {
  const messageEntries = getMessageEntries(entries);
  if (messageEntries.length === 0) return undefined;

  const conversation = messageEntries
    .map((entry) => formatMessage(entry.message.role, extractText(entry.message.content)))
    .join('\n\n')
    .trim();

  if (!conversation) return undefined;

  const lastEntry = messageEntries.at(-1);
  return {
    conversation,
    conversationHash: hashString(conversation),
    messageCount: messageEntries.length,
    lastMessageEntryId: lastEntry?.id ?? null,
    lastMessageTimestamp: lastEntry?.timestamp ?? null,
  };
}

export function buildRollingSummaryInput(
  entries: SessionEntry[],
  options: { previousCheckpointEntryId?: string },
): RollingSummaryInput {
  const messageEntries = getMessageEntries(entries);
  const snapshot = buildConversationSnapshot(entries);

  if (messageEntries.length === 0) {
    return {
      mode: 'incremental',
      freshConversation: '',
      freshMessageCount: 0,
      checkpointEntryId: null,
      snapshot,
    };
  }

  const checkpointIndex = options.previousCheckpointEntryId
    ? messageEntries.findIndex((entry) => entry.id === options.previousCheckpointEntryId)
    : -1;
  const mode =
    checkpointIndex === -1 && options.previousCheckpointEntryId ? 'rebuild' : 'incremental';
  const freshEntries =
    checkpointIndex === -1 ? messageEntries : messageEntries.slice(checkpointIndex + 1);

  return {
    mode,
    freshConversation: freshEntries
      .map((entry) => formatMessage(entry.message.role, extractText(entry.message.content)))
      .join('\n\n')
      .trim(),
    freshMessageCount: freshEntries.length,
    checkpointEntryId: messageEntries.at(-1)?.id ?? null,
    snapshot,
  };
}
