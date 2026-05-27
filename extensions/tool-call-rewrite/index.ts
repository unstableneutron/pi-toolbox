import { createHash } from 'node:crypto';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export type ToolCallRewriteOptions = {
  maxSeen?: number;
};

export type RecentToolCall = {
  signature: string;
  toolCallId: string;
  toolName: string;
};

export type PendingNoopToolResult = RecentToolCall & {
  fromToolCallId: string;
  reason: 'adjacent-duplicate';
};

export type ToolCallRewriteState = {
  currentScopeId?: string;
  fallbackTurn: number;
  maxSeen: number;
  seen: Set<string>;
  order: string[];
  activeToolCalls: Map<string, RecentToolCall>;
  assistantToolCallCounts: Map<string, number>;
  lastCompletedToolCall?: RecentToolCall;
  pendingNoopToolResults: Map<string, PendingNoopToolResult>;
};

export type ToolCallRecordResult = {
  duplicate: boolean;
  scopeChanged: boolean;
  signature: string;
};

const DEFAULT_MAX_SEEN = 128;
const ADJACENT_DUPLICATE_REASON = 'Deduped: identical tool call already ran immediately before.';

export function stableJson(value: unknown): string {
  if (value === null) return 'null';

  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    return JSON.stringify(value);
  }
  if (valueType === 'undefined') return 'undefined';
  if (valueType === 'bigint') return 'bigint';
  if (valueType === 'symbol') return 'symbol';
  if (valueType === 'function') return 'function';

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }

  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(objectValue[key])}`).join(',')}}`;
}

export function createToolCallSignature(toolName: string, input: unknown): string {
  return createHash('sha256').update(toolName).update('\0').update(stableJson(input)).digest('hex');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function createParallelToolUseSignature(toolUse: unknown): string {
  if (!isRecord(toolUse)) return createToolCallSignature('unknown', toolUse);
  return createToolCallSignature(stringValue(toolUse.recipient_name), toolUse.parameters);
}

export function createToolCallRewriteState(
  options: ToolCallRewriteOptions = {},
): ToolCallRewriteState {
  return {
    fallbackTurn: 0,
    maxSeen: Math.max(1, options.maxSeen ?? DEFAULT_MAX_SEEN),
    seen: new Set<string>(),
    order: [],
    activeToolCalls: new Map<string, RecentToolCall>(),
    assistantToolCallCounts: new Map<string, number>(),
    pendingNoopToolResults: new Map<string, PendingNoopToolResult>(),
  };
}

export function clearToolCallRewriteScope(state: ToolCallRewriteState, scopeId?: string) {
  state.currentScopeId = scopeId;
  state.seen.clear();
  state.order = [];
}

export function clearToolCallRewriteState(state: ToolCallRewriteState, scopeId?: string) {
  clearToolCallRewriteScope(state, scopeId);
  state.activeToolCalls.clear();
  state.assistantToolCallCounts.clear();
  state.lastCompletedToolCall = undefined;
  state.pendingNoopToolResults.clear();
}

export function recordToolCall(
  state: ToolCallRewriteState,
  scopeId: string,
  toolName: string,
  input: unknown,
): ToolCallRecordResult {
  const scopeChanged = state.currentScopeId !== scopeId;
  if (scopeChanged) {
    clearToolCallRewriteScope(state, scopeId);
  }

  const signature = createToolCallSignature(toolName, input);
  if (state.seen.has(signature)) {
    return { duplicate: true, scopeChanged, signature };
  }

  state.seen.add(signature);
  state.order.push(signature);
  while (state.order.length > state.maxSeen) {
    const oldest = state.order.shift();
    if (oldest) state.seen.delete(oldest);
  }

  return { duplicate: false, scopeChanged, signature };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstAliasValue(input: Record<string, unknown>, aliases: readonly string[]): unknown {
  for (const alias of aliases) {
    const value = input[alias];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function copyAlias(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  canonical: string,
  aliases: readonly string[],
  rules: string[],
): void {
  if (target[canonical] !== undefined && target[canonical] !== null && target[canonical] !== '') {
    return;
  }

  const value = firstAliasValue(source, aliases);
  if (value === undefined) return;
  target[canonical] = value;
  rules.push(`${aliases.join('|')}→${canonical}`);
}

function deleteAliasKeys(target: Record<string, unknown>, aliases: readonly string[]): void {
  for (const alias of aliases) delete target[alias];
}

function tryParseJsonArray(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return value;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function coerceStringArray(value: unknown): unknown {
  const parsed = tryParseJsonArray(value);
  return typeof parsed === 'string' ? [parsed] : parsed;
}

function repairFffGrepInput(input: unknown): { input: unknown; rules: string[] } {
  if (typeof input === 'string') {
    return { input: { patterns: [input], literal: true }, rules: ['root-string→patterns'] };
  }
  if (!isRecord(input)) return { input, rules: [] };

  const rules: string[] = [];
  const repaired = { ...input };
  const patternAliases = ['pattern', 'query', 'search', 'q', 'text'];
  const regexAliases = ['regex', 'expression'];
  copyAlias(repaired, input, 'patterns', patternAliases, rules);
  const regexAlias = firstAliasValue(input, regexAliases);
  if (repaired.patterns === undefined && regexAlias !== undefined) {
    repaired.patterns = regexAlias;
    repaired.literal = false;
    rules.push(`${regexAliases.join('|')}→patterns`);
  }
  if (rules.length > 0 && repaired.literal === undefined) {
    repaired.literal = regexAlias !== undefined ? false : true;
  }
  repaired.patterns = coerceStringArray(repaired.patterns);
  deleteAliasKeys(repaired, [...patternAliases, ...regexAliases]);
  repairCommonSearchInput(input, repaired, rules);
  return { input: repaired, rules };
}

function repairFffFindInput(input: unknown): { input: unknown; rules: string[] } {
  if (typeof input === 'string') {
    return { input: { query: input }, rules: ['root-string→query'] };
  }
  if (!isRecord(input)) return { input, rules: [] };

  const rules: string[] = [];
  const repaired = { ...input };
  const queryAliases = ['pattern', 'search', 'q', 'text'];
  copyAlias(repaired, input, 'query', queryAliases, rules);
  deleteAliasKeys(repaired, queryAliases);
  repairCommonSearchInput(input, repaired, rules);
  return { input: repaired, rules };
}

function repairCommonSearchInput(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  rules: string[],
): void {
  const withinAliases = ['path', 'directory', 'dir', 'folder', 'cwd'];
  const excludeAliases = ['excludePaths', 'exclude', 'excludePath'];
  copyAlias(target, source, 'within', withinAliases, rules);
  copyAlias(target, source, 'exclude_paths', excludeAliases, rules);
  copyAlias(target, source, 'case_sensitive', ['caseSensitive'], rules);
  copyAlias(target, source, 'context_lines', ['contextLines', 'context'], rules);
  copyAlias(target, source, 'output_mode', ['outputMode'], rules);
  target.extensions = coerceStringArray(target.extensions);
  target.exclude_paths = coerceStringArray(target.exclude_paths);
  deleteAliasKeys(target, [
    ...withinAliases,
    ...excludeAliases,
    'caseSensitive',
    'contextLines',
    'context',
    'outputMode',
  ]);
}

function repairEditObject(
  input: Record<string, unknown>,
  rules: string[],
): Record<string, unknown> {
  const repaired = { ...input };
  for (const [key, value] of Object.entries(repaired)) {
    if (value === null || value === undefined) delete repaired[key];
  }
  const pathAliases = [
    'filePath',
    'absolutePath',
    'file_path',
    'filepath',
    'pathname',
    'target_file',
    'targetFile',
  ];
  const oldAliases = [
    'oldValue',
    'old_string',
    'oldString',
    'old',
    'old_str',
    'oldStr',
    'from',
    'search',
  ];
  const newAliases = [
    'newValue',
    'new_string',
    'newString',
    'new',
    'new_str',
    'newStr',
    'to',
    'replace',
  ];
  copyAlias(repaired, input, 'path', pathAliases, rules);
  copyAlias(repaired, input, 'oldText', oldAliases, rules);
  copyAlias(repaired, input, 'newText', newAliases, rules);
  deleteAliasKeys(repaired, [...pathAliases, ...oldAliases, ...newAliases]);
  return repaired;
}

function repairEditInput(input: unknown): { input: unknown; rules: string[] } {
  if (typeof input === 'string' && input.trimStart().startsWith('*** Begin Patch')) {
    return { input: { patch: input }, rules: ['root-string→patch'] };
  }
  if (!isRecord(input)) return { input, rules: [] };

  const rules: string[] = [];
  const repaired = repairEditObject(input, rules);
  repaired.edits = tryParseJsonArray(repaired.edits);
  repaired.multi = tryParseJsonArray(repaired.multi);
  if (Array.isArray(repaired.edits)) {
    repaired.edits = repaired.edits.map((item) =>
      isRecord(item) ? repairEditObject(item, rules) : item,
    );
  }
  if (Array.isArray(repaired.multi)) {
    repaired.multi = repaired.multi.map((item) =>
      isRecord(item) ? repairEditObject(item, rules) : item,
    );
  }
  return { input: repaired, rules };
}

export function repairToolCallInput(
  toolName: string,
  input: unknown,
): { input: unknown; rules: string[]; changed: boolean } {
  const repaired =
    toolName === 'fff_grep'
      ? repairFffGrepInput(input)
      : toolName === 'fff_find_files'
        ? repairFffFindInput(input)
        : toolName === 'edit'
          ? repairEditInput(input)
          : { input, rules: [] };
  return { ...repaired, changed: repaired.rules.length > 0 };
}

function dedupeParallelToolUses(input: unknown): {
  input: unknown;
  changed: boolean;
  removedAll: boolean;
} {
  if (!isRecord(input) || !Array.isArray(input.tool_uses)) {
    return { input, changed: false, removedAll: false };
  }

  const seen = new Set<string>();
  const toolUses = [];
  let changed = false;

  for (const toolUse of input.tool_uses) {
    const signature = createParallelToolUseSignature(toolUse);
    if (seen.has(signature)) {
      changed = true;
      continue;
    }
    seen.add(signature);
    toolUses.push(toolUse);
  }

  if (!changed) return { input, changed: false, removedAll: false };
  return {
    input: { ...input, tool_uses: toolUses },
    changed: true,
    removedAll: toolUses.length === 0,
  };
}

function normalizeToolCallPart(part: Record<string, unknown>): {
  changed: boolean;
  part?: Record<string, unknown>;
} {
  const deduped = dedupeParallelToolUses(part.arguments);
  if (deduped.removedAll) return { changed: true };
  if (!deduped.changed) return { changed: false, part };
  return { changed: true, part: { ...part, arguments: deduped.input } };
}

export function dedupeAssistantToolCalls(message: unknown): { changed: boolean; message: any } {
  if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content)) {
    return { changed: false, message };
  }

  const seen = new Set<string>();
  const content = [];
  let changed = false;

  for (const part of message.content) {
    if (!isRecord(part) || part.type !== 'toolCall') {
      content.push(part);
      continue;
    }

    const normalized = normalizeToolCallPart(part);
    if (!normalized.part) {
      changed = true;
      continue;
    }
    if (normalized.changed) changed = true;

    const signature = createToolCallSignature(
      stringValue(normalized.part.name),
      normalized.part.arguments,
    );
    if (seen.has(signature)) {
      changed = true;
      continue;
    }
    seen.add(signature);
    content.push(normalized.part);
  }

  if (!changed) return { changed: false, message };
  return { changed: true, message: { ...message, content } };
}

function countTopLevelToolCalls(message: unknown): number {
  if (!isRecord(message) || !Array.isArray(message.content)) return 0;
  return message.content.filter((part) => isRecord(part) && part.type === 'toolCall').length;
}

function getToolResultCallId(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const toolCallId = message.toolCallId;
  return typeof toolCallId === 'string' && toolCallId.length > 0 ? toolCallId : undefined;
}

function getToolResultName(message: unknown): string {
  if (!isRecord(message)) return '';
  return typeof message.toolName === 'string' ? message.toolName : '';
}

function mergeNoopDetails(
  details: unknown,
  pending: PendingNoopToolResult,
): Record<string, unknown> {
  const base = isRecord(details) ? details : {};
  return {
    ...base,
    toolCallRewrite: {
      deduped: true,
      fromToolCallId: pending.fromToolCallId,
      reason: pending.reason,
    },
  };
}

function rewriteNoopToolResult(message: unknown, pending: PendingNoopToolResult): any {
  if (!isRecord(message)) return message;
  return {
    ...message,
    content: [{ type: 'text', text: ADJACENT_DUPLICATE_REASON }],
    details: mergeNoopDetails(message.details, pending),
    isError: false,
  };
}

function getLeafScopeId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getLeafId() ?? undefined;
  } catch {
    return undefined;
  }
}

function getToolCallScopeId(state: ToolCallRewriteState, ctx: ExtensionContext): string {
  return getLeafScopeId(ctx) ?? `turn:${state.fallbackTurn}`;
}

function setStatus(ctx: ExtensionContext, message: string | undefined) {
  try {
    ctx.ui.setStatus('tool-call-rewrite', message);
  } catch {
    // Status is best-effort only.
  }
}

export default function toolCallRewrite(pi: ExtensionAPI, options: ToolCallRewriteOptions = {}) {
  const state = createToolCallRewriteState(options);

  pi.on('turn_start', async () => {
    state.fallbackTurn += 1;
    clearToolCallRewriteScope(state);
  });

  pi.on('turn_end', async (_event, ctx) => {
    clearToolCallRewriteScope(state);
    setStatus(ctx, undefined);
  });

  pi.on('agent_start', async () => {
    clearToolCallRewriteState(state);
  });

  pi.on('agent_end', async (_event, ctx) => {
    clearToolCallRewriteState(state);
    setStatus(ctx, undefined);
  });

  pi.on('session_start', async () => {
    state.fallbackTurn = 0;
    clearToolCallRewriteState(state);
  });

  pi.on('message_end', async (event, ctx) => {
    if (event.message.role === 'assistant') {
      const result = dedupeAssistantToolCalls(event.message);
      const scopeId = getToolCallScopeId(state, ctx);
      state.assistantToolCallCounts.set(scopeId, countTopLevelToolCalls(result.message));
      if (!result.changed) return;
      return { message: result.message };
    }

    if (event.message.role !== 'toolResult') return;

    const toolCallId = getToolResultCallId(event.message);
    if (!toolCallId) return;

    const pendingNoop = state.pendingNoopToolResults.get(toolCallId);
    if (pendingNoop) {
      state.pendingNoopToolResults.delete(toolCallId);
      state.lastCompletedToolCall = {
        signature: pendingNoop.signature,
        toolCallId,
        toolName: getToolResultName(event.message) || pendingNoop.toolName,
      };
      return { message: rewriteNoopToolResult(event.message, pendingNoop) };
    }

    const active = state.activeToolCalls.get(toolCallId);
    if (!active) return;
    state.activeToolCalls.delete(toolCallId);
    state.lastCompletedToolCall = active;
  });

  pi.on('tool_call', async (event, ctx) => {
    const repairedInput = repairToolCallInput(event.toolName, event.input);
    if (repairedInput.changed) {
      event.input = repairedInput.input as typeof event.input;
      setStatus(ctx, `Rewrote tool input: ${repairedInput.rules.join(', ')}`);
    }

    const dedupedInput = dedupeParallelToolUses(event.input);
    if (dedupedInput.changed && isRecord(event.input) && isRecord(dedupedInput.input)) {
      (event.input as Record<string, unknown>).tool_uses = dedupedInput.input.tool_uses;
    }

    const scopeId = getToolCallScopeId(state, ctx);
    const signature = createToolCallSignature(event.toolName, event.input);
    const assistantToolCallCount = state.assistantToolCallCounts.get(scopeId);
    const adjacentDuplicate =
      state.lastCompletedToolCall?.signature === signature &&
      (assistantToolCallCount === undefined || assistantToolCallCount === 1);

    if (adjacentDuplicate && state.lastCompletedToolCall) {
      state.pendingNoopToolResults.set(event.toolCallId, {
        signature,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        fromToolCallId: state.lastCompletedToolCall.toolCallId,
        reason: 'adjacent-duplicate',
      });
      setStatus(ctx, ADJACENT_DUPLICATE_REASON);
      return { block: true, reason: ADJACENT_DUPLICATE_REASON };
    }

    const record = recordToolCall(state, scopeId, event.toolName, event.input);
    if (record.duplicate) {
      const reason = `Blocked duplicate tool call: ${event.toolName} with identical arguments already appeared in this assistant response.`;
      setStatus(ctx, reason);
      return { block: true, reason };
    }

    state.lastCompletedToolCall = undefined;
    state.activeToolCalls.set(event.toolCallId, {
      signature: record.signature,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    });
  });
}
