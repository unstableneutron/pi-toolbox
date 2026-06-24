import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
} from '@earendil-works/pi-ai/compat';

import {
  appendRecoveredFunctionCalls,
  appendRecoveredReasoningItems,
  appendSyntheticTextDelta,
  applyCompletedResponse,
  ensureTextBlock,
  extractResponseOutputText,
  isFinalizedTextBlock,
  responseMessageTextSignature,
} from './responses-adapter.ts';
import type { ResolvedRequestProfile } from './profile.ts';
import type { OpenAIWebSocketResponsesSettings } from './settings.ts';
import { resolveRetrieveResponseUrl } from './urls.ts';

interface RetrieveRecoveryResult {
  response: Record<string, any>;
  recoveredText: string;
  emittedSyntheticDeltas: number;
  polls: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(new Error('Request was aborted'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isTerminalStatus(status: string | undefined): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'incomplete'
  );
}

function responseErrorMessage(response: Record<string, any>): string {
  return response.error?.message || response.incomplete_details?.reason || JSON.stringify(response);
}

export async function recoverResponseByRetrieve(request: {
  model: Model<Api>;
  settings: OpenAIWebSocketResponsesSettings;
  responseId: string;
  headers: Headers;
  emittedText: string;
  output: AssistantMessage;
  stream: AssistantMessageEventStream;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  profile?: ResolvedRequestProfile;
}): Promise<RetrieveRecoveryResult> {
  const fetchImpl = request.fetchImpl ?? fetch;
  const startedAt = Date.now();
  const deadline = startedAt + request.settings.recovery.timeoutMs;
  let emittedText = request.emittedText;
  let emittedSyntheticDeltas = 0;
  let lastError: string | undefined;
  let polls = 0;
  const url = resolveRetrieveResponseUrl(
    request.model,
    request.settings,
    request.responseId,
    request.headers,
    request.profile,
  );

  while (Date.now() <= deadline) {
    if (request.signal?.aborted) throw new Error('Request was aborted');
    polls++;
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: request.headers,
      signal: request.signal,
    });
    if (response.status === 404) {
      lastError = `Response ${request.responseId} was not found`;
      if (Date.now() - startedAt > request.settings.recovery.notFoundGraceMs)
        throw new Error(lastError);
      await sleep(request.settings.recovery.pollIntervalMs, request.signal);
      continue;
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Retrieve recovery failed with HTTP ${response.status}: ${body.slice(0, 1000)}`,
      );
    }

    const snapshot = (await response.json()) as Record<string, any>;
    const snapshotText = extractResponseOutputText(snapshot);
    if (snapshotText && !snapshotText.startsWith(emittedText)) {
      throw new Error('Retrieve recovery diverged from already emitted text');
    }

    const status = typeof snapshot.status === 'string' ? snapshot.status : undefined;
    if (status === 'completed') {
      appendRecoveredReasoningItems(snapshot, request.output, request.stream);
      if (snapshotText && request.settings.recovery.emitSyntheticDeltas) {
        const delta = snapshotText.slice(emittedText.length);
        if (delta) {
          appendSyntheticTextDelta(request.output, request.stream, delta);
          emittedText = snapshotText;
          emittedSyntheticDeltas++;
        }
      }
      appendRecoveredFunctionCalls(snapshot, request.output, request.stream);
      if (snapshotText || request.output.content.some((block) => block.type === 'text')) {
        const { index, block } = ensureTextBlock(request.output, request.stream);
        const alreadyFinalized = isFinalizedTextBlock(block);
        if (snapshotText && block.text !== snapshotText) block.text = snapshotText;
        block.textSignature ??= responseMessageTextSignature(snapshot);
        if (!alreadyFinalized) {
          request.stream.push({
            type: 'text_end',
            contentIndex: index,
            content: block.text,
            partial: request.output,
          });
        }
      }
      applyCompletedResponse(request.output, request.model, {
        ...snapshot,
        id: snapshot.id ?? request.responseId,
      });
      return { response: snapshot, recoveredText: snapshotText, emittedSyntheticDeltas, polls };
    }
    if (snapshotText && request.settings.recovery.emitSyntheticDeltas) {
      const delta = snapshotText.slice(emittedText.length);
      if (delta) {
        appendSyntheticTextDelta(request.output, request.stream, delta);
        emittedText = snapshotText;
        emittedSyntheticDeltas++;
      }
    }
    if (isTerminalStatus(status)) throw new Error(responseErrorMessage(snapshot));

    await sleep(request.settings.recovery.pollIntervalMs, request.signal);
  }

  throw new Error(
    lastError ?? `Retrieve recovery timed out after ${request.settings.recovery.timeoutMs}ms`,
  );
}
