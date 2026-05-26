import { createHash } from 'node:crypto';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export type ToolCallRewriteOptions = {
  maxSeen?: number;
};

export type ToolCallRewriteState = {
  currentScopeId?: string;
  fallbackTurn: number;
  maxSeen: number;
  seen: Set<string>;
  order: string[];
};

export type ToolCallRecordResult = {
  duplicate: boolean;
  scopeChanged: boolean;
  signature: string;
};

const DEFAULT_MAX_SEEN = 128;

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

export function createToolCallRewriteState(
  options: ToolCallRewriteOptions = {},
): ToolCallRewriteState {
  return {
    fallbackTurn: 0,
    maxSeen: Math.max(1, options.maxSeen ?? DEFAULT_MAX_SEEN),
    seen: new Set<string>(),
    order: [],
  };
}

export function clearToolCallRewriteScope(state: ToolCallRewriteState, scopeId?: string) {
  state.currentScopeId = scopeId;
  state.seen.clear();
  state.order = [];
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

  pi.on('agent_end', async (_event, ctx) => {
    clearToolCallRewriteScope(state);
    setStatus(ctx, undefined);
  });

  pi.on('session_start', async () => {
    state.fallbackTurn = 0;
    clearToolCallRewriteScope(state);
  });

  pi.on('tool_call', async (event, ctx) => {
    const scopeId = getToolCallScopeId(state, ctx);
    const record = recordToolCall(state, scopeId, event.toolName, event.input);
    if (!record.duplicate) return;

    const reason = `Blocked duplicate tool call: ${event.toolName} with identical arguments already appeared in this assistant response.`;
    setStatus(ctx, reason);
    return { block: true, reason };
  });
}
