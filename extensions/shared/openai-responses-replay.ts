import { createHash } from 'node:crypto';

type ResponsesInputItem = Record<string, any>;

const OPENAI_RESPONSES_ITEM_ID_MAX_LENGTH = 64;
const OPENAI_RESPONSES_ITEM_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function stableShortResponsesItemId(id: string, prefix: string): string {
  if (
    Array.from(id).length <= OPENAI_RESPONSES_ITEM_ID_MAX_LENGTH &&
    OPENAI_RESPONSES_ITEM_ID_PATTERN.test(id)
  ) {
    return id;
  }
  return `${prefix}_${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
}

interface ResponsesReplayState {
  hasUnreplayableReasoningBeforeItem: boolean;
}

interface ResponsesToolCallLike {
  id: string;
  name: string;
  arguments: unknown;
}

type ReasoningSignatureAnalysis =
  | { kind: 'missing' }
  | { kind: 'invalid-json' }
  | { kind: 'non-reasoning-json' }
  | { kind: 'replayable-reasoning'; item: ResponsesInputItem; id?: string; encrypted: boolean };

export function createResponsesReplayState(): ResponsesReplayState {
  return { hasUnreplayableReasoningBeforeItem: false };
}

export function sanitizeResponsesText(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  );
}

export function analyzeResponsesReasoningSignature(
  signature: string | undefined,
): ReasoningSignatureAnalysis {
  if (!signature) return { kind: 'missing' };
  try {
    const parsed = JSON.parse(signature) as ResponsesInputItem;
    if (!parsed || parsed.type !== 'reasoning') return { kind: 'non-reasoning-json' };
    return {
      kind: 'replayable-reasoning',
      item: parsed,
      id: typeof parsed.id === 'string' ? parsed.id : undefined,
      encrypted:
        typeof parsed.encrypted_content === 'string' && parsed.encrypted_content.length > 0,
    };
  } catch {
    return { kind: 'invalid-json' };
  }
}

function parseReplayableResponsesReasoningItem(
  signature: string | undefined,
): ResponsesInputItem | undefined {
  const analysis = analyzeResponsesReasoningSignature(signature);
  return analysis.kind === 'replayable-reasoning' ? analysis.item : undefined;
}

export function isEncryptedResponsesReasoningSignature(signature: string | undefined): boolean {
  const analysis = analyzeResponsesReasoningSignature(signature);
  return analysis.kind === 'replayable-reasoning' && analysis.encrypted;
}

export function noteResponsesReasoningForReplay(
  state: ResponsesReplayState,
  signature: string | undefined,
): ResponsesInputItem | undefined {
  const item = parseReplayableResponsesReasoningItem(signature);
  if (item) return item;
  state.hasUnreplayableReasoningBeforeItem = true;
  return undefined;
}

export function responsesDependentItemId(
  state: Pick<ResponsesReplayState, 'hasUnreplayableReasoningBeforeItem'>,
  id: string | undefined,
): string | undefined {
  return state.hasUnreplayableReasoningBeforeItem || !id
    ? undefined
    : stableShortResponsesItemId(id, 'msg_pi_sig');
}

export function splitResponsesToolCallId(id: string): { callId: string; itemId?: string } {
  const [callId, itemId] = id.split('|');
  return { callId: stableShortResponsesItemId(callId || id, 'call_pi_sig'), itemId };
}

export function responsesFunctionCallInput(
  block: ResponsesToolCallLike,
  options: { includeItemId?: boolean } = {},
): ResponsesInputItem {
  const { callId, itemId } = splitResponsesToolCallId(block.id);
  return {
    type: 'function_call',
    ...(options.includeItemId === false || !itemId
      ? {}
      : { id: stableShortResponsesItemId(itemId, 'fc_pi_sig') }),
    call_id: callId,
    name: block.name,
    arguments: JSON.stringify(block.arguments),
  };
}

export function encodeResponsesTextSignatureV1(id: string, phase?: string): string {
  return JSON.stringify({ v: 1, id, ...(phase ? { phase } : {}) });
}

function parseResponsesTextSignature(
  signature: string | undefined,
): { id: string; phase?: string } | undefined {
  if (!signature) return undefined;
  if (signature.startsWith('{')) {
    try {
      const parsed = JSON.parse(signature) as { v?: number; id?: unknown; phase?: unknown };
      if (parsed.v === 1 && typeof parsed.id === 'string') {
        const id = stableShortResponsesItemId(parsed.id, 'msg_pi_sig');
        return typeof parsed.phase === 'string' ? { id, phase: parsed.phase } : { id };
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function responsesTextSignatureItemId(signature: string | undefined): string | undefined {
  return parseResponsesTextSignature(signature)?.id;
}

export function responsesTextSignaturePhase(signature: string | undefined): string | undefined {
  return parseResponsesTextSignature(signature)?.phase;
}
