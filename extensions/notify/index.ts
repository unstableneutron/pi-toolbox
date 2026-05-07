/**
 * Desktop Notification Extension
 *
 * Sends a native desktop notification when the agent finishes and is waiting for input.
 * Uses OSC 777 escape sequence - no external dependencies.
 *
 * Supported terminals: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * Not supported: Kitty (uses OSC 99), Terminal.app, Windows Terminal, Alacritty
 */

import type { ExtensionAPI, SessionEntry } from '@earendil-works/pi-coding-agent';
import { homedir } from 'node:os';

import { compactName as compactSmartSessionName } from '../smart-sessions/contracts';
import { buildConversationSnapshot } from '../smart-sessions/conversation';
import { readRollingSummarySidecar } from '../smart-sessions/sidecar';

type TextPart = { type: 'text'; text: string };
type AssistantLike = { role?: string; stopReason?: string };
type AskUserArgs = { question?: unknown };
type SessionManagerLike = {
  getSessionId?: () => string;
  getBranch?: () => SessionEntry[];
  getCwd?: () => string;
};
type NotifyContext =
  | { signal?: AbortSignal; sessionManager?: SessionManagerLike; hasUI?: boolean }
  | undefined;
type InputEventLike = { source?: string };
type TurnStartEventLike = { timestamp?: number };

const NOTIFICATION_DELAY_MS = 10_000;
const ESC = '\u001B';
const BEL = '\u0007';
const OSC_SEQUENCE_PATTERN = new RegExp(`${ESC}\\].*?(?:${BEL}|${ESC}\\\\)`, 'gs');
const SMART_SESSIONS_WINDOW_ENTRY_TYPE = 'smart-sessions/window-name';
const SMART_SESSIONS_SUMMARY_CACHE_ENTRY_TYPE = 'smart-sessions/summary-cache';
const WINDOW_NAME_MAX_WORDS = 4;
const MAX_TITLE_CHARS = 'π ~/w/r/example-monorepo-repo/foo/bar'.length;

/**
 * Send a desktop notification via OSC 777 escape sequence.
 */
const notifyOsc777 = (title: string, body: string): void => {
  // OSC 777 format: ESC ] 777 ; notify ; title ; body BEL
  process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
};

const notifyOsc99 = (identifier: string, title: string, body: string): boolean => {
  if (!process.env.KITTY_WINDOW_ID) {
    return false;
  }

  process.stdout.write(`\x1b]99;i=${identifier}:o=unfocused:d=0;${title}\x07`);
  process.stdout.write(`\x1b]99;i=${identifier}:o=unfocused:p=body;${body}\x07`);
  return true;
};

const clearNotifyOsc99 = (identifier: string): boolean => {
  if (!process.env.KITTY_WINDOW_ID) {
    return false;
  }

  process.stdout.write(`\x1b]99;i=${identifier}:p=close;\x07`);
  return true;
};

const isTextPart = (part: unknown): part is TextPart =>
  Boolean(
    part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part,
  );

const extractLastAssistantText = (
  messages: Array<{ role?: string; content?: unknown }>,
): string | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'assistant') {
      continue;
    }

    const content = message.content;
    if (typeof content === 'string') {
      return content.trim() || null;
    }

    if (Array.isArray(content)) {
      const text = content
        .filter(isTextPart)
        .map((part) => part.text)
        .join('\n')
        .trim();
      return text || null;
    }

    return null;
  }

  return null;
};

const findLastAssistantMessage = (
  messages: Array<{ role?: string }>,
): AssistantLike | undefined => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'assistant') {
      return message as AssistantLike;
    }
  }
  return undefined;
};

const extractAskUserQuestion = (args: unknown): string | null => {
  if (!args || typeof args !== 'object' || !('question' in args)) {
    return null;
  }

  const { question } = args as AskUserArgs;
  return typeof question === 'string' && question.trim() ? question : null;
};

const stripOscSequences = (text: string): string => text.replace(OSC_SEQUENCE_PATTERN, '');

const stripMarkdownNoise = (text: string): string =>
  text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/^[\t ]{0,3}(?:#{1,6}|[-*+])\s+/gm, '')
    .replace(/^[\t ]{0,3}\d+\.\s+/gm, '')
    .replace(/^[\t ]{0,3}>\s?/gm, '')
    .replace(/[|]/g, ' ')
    .replace(/[*~]/g, '')
    .replace(/(?<=\w)[_](?=\w)/g, ' ');

const sanitizeNotificationText = (text: string): string =>
  stripMarkdownNoise(stripOscSequences(text)).replace(/\s+/g, ' ').trim();

const compactWindowName = (value: string, maxWords: number): string | undefined =>
  compactSmartSessionName(sanitizeNotificationText(value), maxWords);

const getSummaryCacheWindowName = (data: unknown): string | undefined => {
  if (!data || typeof data !== 'object') {
    return undefined;
  }

  const summary = (data as { summary?: { windowName?: unknown } }).summary;
  if (!summary || typeof summary !== 'object') {
    return undefined;
  }

  return typeof summary.windowName === 'string'
    ? compactWindowName(summary.windowName, WINDOW_NAME_MAX_WORDS)
    : undefined;
};

const getSmartSessionWindowTitle = (entries: SessionEntry[] | undefined): string | undefined => {
  let cachedWindowName: string | undefined;

  for (let i = (entries?.length ?? 0) - 1; i >= 0; i -= 1) {
    const entry = entries?.[i];
    if (!entry) {
      continue;
    }

    if (entry.type === 'custom' && entry.customType === SMART_SESSIONS_WINDOW_ENTRY_TYPE) {
      const windowName =
        entry.data && typeof entry.data === 'object'
          ? (entry.data as { windowName?: unknown }).windowName
          : undefined;
      if (typeof windowName === 'string') {
        return compactWindowName(windowName, WINDOW_NAME_MAX_WORDS);
      }
    }

    if (
      !cachedWindowName &&
      entry.type === 'custom' &&
      entry.customType === SMART_SESSIONS_SUMMARY_CACHE_ENTRY_TYPE
    ) {
      cachedWindowName = getSummaryCacheWindowName(entry.data);
    }
  }

  return cachedWindowName;
};

const normalizeHomePath = (cwd: string): string => {
  const home = homedir();
  if (cwd === home) {
    return '~';
  }
  if (cwd.startsWith(`${home}/`)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
};

const compressPathSegment = (segment: string): string => {
  if (!segment) {
    return segment;
  }
  if (segment.startsWith('.')) {
    return segment;
  }
  return segment[0] ?? segment;
};

const formatCwdTitle = (cwd: string | undefined): string | undefined => {
  if (!cwd) {
    return undefined;
  }

  const normalized = normalizeHomePath(cwd);
  const prefix = 'π ';
  if (`${prefix}${normalized}`.length <= MAX_TITLE_CHARS) {
    return `${prefix}${normalized}`;
  }

  const parts = normalized.split('/');
  let best = `${prefix}${parts
    .map((part, index) => {
      if (!part || part === '~') {
        return part;
      }
      return index === parts.length - 1 ? part : compressPathSegment(part);
    })
    .join('/')}`;

  const compressibleDepth = parts.filter((part) => part && part !== '~').length;
  if (compressibleDepth <= 3) {
    return best;
  }

  for (let tailCount = 1; tailCount <= parts.length; tailCount += 1) {
    const candidate = parts.map((part, index) => {
      if (!part || part === '~') {
        return part;
      }

      const isInTail = index >= parts.length - tailCount;
      return isInTail ? part : compressPathSegment(part);
    });
    const rendered = `${prefix}${candidate.join('/')}`;
    if (rendered.length > MAX_TITLE_CHARS) {
      break;
    }
    best = rendered;
  }

  return best;
};

const formatNotification = (
  text: string | null,
  options?: { titleHint?: string; cwdTitle?: string },
): { title: string; body: string } => {
  const normalized = text ? sanitizeNotificationText(text) : '';
  const title = options?.titleHint ? `π ${options.titleHint}` : (options?.cwdTitle ?? 'π');
  if (!normalized) {
    return { title, body: 'Ready for input' };
  }

  const maxBody = 200;
  const body = normalized.length > maxBody ? `${normalized.slice(0, maxBody - 1)}…` : normalized;
  return { title, body };
};

const getRollingSummaryNotification = (
  ctx?: NotifyContext,
): { titleHint?: string; shortSummary?: string; blockLegacyTitleFallback?: boolean } => {
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  if (!sessionId) {
    return {};
  }

  const sidecar = readRollingSummarySidecar(sessionId);
  const snapshot = buildConversationSnapshot(ctx?.sessionManager?.getBranch?.() ?? []);
  const current =
    sidecar?.current && snapshot && sidecar.current.conversationHash === snapshot.conversationHash
      ? sidecar.current
      : undefined;
  const hasStaleSidecar = !!sidecar?.current && !current;
  return {
    titleHint: current?.shortTitle,
    shortSummary: current?.shortSummary,
    blockLegacyTitleFallback: hasStaleSidecar,
  };
};

export default function (pi: ExtensionAPI) {
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingAbortCleanup: (() => void) | undefined;
  let lastTurnStart: number | undefined;
  let interactionEpoch = 0;

  const clearPendingNotification = (): void => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }
    pendingAbortCleanup?.();
    pendingAbortCleanup = undefined;
  };

  const clearSentNotification = (ctx?: NotifyContext): void => {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (!sessionId) {
      return;
    }
    clearNotifyOsc99(sessionId);
  };

  const scheduleNotification = (
    notification: { title: string; body: string },
    ctx?: NotifyContext,
  ): void => {
    clearPendingNotification();

    const signal = ctx?.signal;
    if (signal?.aborted) {
      return;
    }

    const onAbort = (): void => {
      clearPendingNotification();
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      pendingAbortCleanup = () => {
        signal.removeEventListener('abort', onAbort);
      };
    }

    const scheduledEpoch = interactionEpoch;

    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      pendingAbortCleanup?.();
      pendingAbortCleanup = undefined;

      if (signal?.aborted || scheduledEpoch !== interactionEpoch) {
        return;
      }

      const identifier = ctx?.sessionManager?.getSessionId?.();
      const sentViaKitty =
        typeof identifier === 'string' && identifier
          ? notifyOsc99(identifier, notification.title, notification.body)
          : false;

      if (!sentViaKitty) {
        notifyOsc777(notification.title, notification.body);
      }
    }, NOTIFICATION_DELAY_MS);
  };

  const buildNotification = (
    text: string | null,
    ctx?: NotifyContext,
    options?: { preferRollingSummary?: boolean },
  ) => {
    const rolling = getRollingSummaryNotification(ctx);
    return formatNotification(
      options?.preferRollingSummary
        ? (rolling.shortSummary ?? text)
        : (text ?? rolling.shortSummary ?? null),
      {
        titleHint: rolling.blockLegacyTitleFallback
          ? rolling.titleHint
          : (rolling.titleHint ?? getSmartSessionWindowTitle(ctx?.sessionManager?.getBranch?.())),
        cwdTitle: formatCwdTitle(ctx?.sessionManager?.getCwd?.()),
      },
    );
  };

  // Notifications are only meaningful when a user is attached to a TUI.
  // In print/RPC mode (e.g. `pi -p ...` used as a subprocess) hasUI is false,
  // and writing OSC escape sequences to stdout would surface spurious
  // notifications in whatever terminal invoked the parent pi.
  const isUIContext = (ctx?: NotifyContext): boolean => ctx?.hasUI === true;

  pi.on('session_start', async (_event, ctx) => {
    if (!isUIContext(ctx)) return;
    lastTurnStart = undefined;
    interactionEpoch += 1;
    clearSentNotification(ctx);
  });

  pi.on('turn_start', async (event: TurnStartEventLike, ctx) => {
    if (!isUIContext(ctx)) return;
    lastTurnStart = typeof event.timestamp === 'number' ? event.timestamp : Date.now();
  });

  pi.on('agent_end', async (event, ctx) => {
    if (!isUIContext(ctx)) return;
    if (lastTurnStart === undefined) {
      return;
    }

    // Skip scheduling when the agent loop terminated on an error or was
    // aborted. For retryable errors the core auto-retry (or pi-retry) will
    // start a fresh agent_start/agent_end cycle whose successful agent_end
    // schedules the real notification. For aborted turns the user is already
    // interacting. For non-retryable terminal errors the TUI surfaces the
    // failure inline, so a spurious "Ready for input" would be misleading.
    const lastAssistant = findLastAssistantMessage(event.messages ?? []);
    if (lastAssistant?.stopReason === 'error' || lastAssistant?.stopReason === 'aborted') {
      return;
    }

    const lastText = extractLastAssistantText(event.messages ?? []);
    scheduleNotification(buildNotification(lastText, ctx, { preferRollingSummary: true }), ctx);
  });

  pi.on('tool_execution_start', async (event, ctx) => {
    if (!isUIContext(ctx)) return;
    if (lastTurnStart === undefined) {
      return;
    }

    if (event.toolName !== 'ask_user') {
      return;
    }

    const question = extractAskUserQuestion(event.args);
    scheduleNotification(buildNotification(question ?? 'Waiting for your input', ctx), ctx);
  });

  pi.on('before_agent_start', async (_event, ctx) => {
    if (!isUIContext(ctx)) return;
    clearPendingNotification();
    clearSentNotification(ctx);
  });

  pi.on('input', async (event: InputEventLike, ctx) => {
    if (!isUIContext(ctx)) return { action: 'continue' as const };
    if (event.source !== 'interactive') {
      return { action: 'continue' as const };
    }

    interactionEpoch += 1;
    clearPendingNotification();
    clearSentNotification(ctx);
    return { action: 'continue' as const };
  });
}
