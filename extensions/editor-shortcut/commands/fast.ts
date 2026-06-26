import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai/compat';
import { modelRef, normalizeModelRef } from './model';

export const FAST_MODE_SERVICE_TIER = 'priority';

export const PRIORITY_CAPABLE_MODEL_REFS = [
  'openai-codex/gpt-5.3-codex-spark',
  'openai-codex/gpt-5.5',
  'openai-codex/gpt-5.6-sol',
  'openai-codex/gpt-5.6-terra',
  'openai-codex/gpt-5.6-luna',
  'openai/gpt-5.5',
] as const;

export type FastModeState = {
  enabled: boolean;
};

export type FastModeAction = 'toggle' | 'on' | 'off';

type RequestPayload = Record<string, unknown>;

export function createFastModeState(): FastModeState {
  return { enabled: false };
}

export function isPriorityCapableModel(model: Model<Api> | undefined): boolean {
  if (!model) return false;
  const ref = normalizeModelRef(modelRef(model));
  return PRIORITY_CAPABLE_MODEL_REFS.some((candidate) => normalizeModelRef(candidate) === ref);
}

export function getNextFastModeAction(enabled: boolean): 'on' | 'off' {
  return enabled ? 'off' : 'on';
}

export function getNextFastModeDirective(enabled: boolean): string {
  return `fast:${getNextFastModeAction(enabled)}`;
}

export function parseFastModeAction(value: string | undefined): FastModeAction | null {
  if (!value) return 'toggle';
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 'toggle';
  if (normalized === 'on' || normalized === 'true' || normalized === '1') return 'on';
  if (normalized === 'off' || normalized === 'false' || normalized === '0') return 'off';
  return null;
}

export function registerFastCommand(pi: ExtensionAPI, state: FastModeState): void {
  pi.registerCommand('fast', {
    description: 'Toggle priority fast mode for supported OpenAI models',
    getArgumentCompletions(argumentPrefix) {
      const items = ['on', 'off'].map((value) => ({ value, label: value }));
      const filtered = items.filter((item) => item.value.startsWith(argumentPrefix));
      return filtered.length > 0 ? filtered : null;
    },
    async handler(args, ctx) {
      applyFastCommand(args, ctx, state);
    },
  });
}

export function applyFastCommand(
  args: string,
  ctx: ExtensionCommandContext,
  state: FastModeState,
): void {
  const action = parseFastModeAction(args);

  if (!action) {
    ctx.ui.notify('Usage: /fast [on|off]', 'warning');
    return;
  }

  applyFastAction(action, ctx, state);
}

export function applyFastDirective(
  value: string,
  ctx: ExtensionContext,
  state: FastModeState,
): boolean {
  const action = parseFastModeAction(value === 'toggle' ? undefined : value);

  if (!action) {
    ctx.ui.notify('Usage: /fast[:on|:off]', 'warning');
    return false;
  }

  return applyFastAction(action, ctx, state);
}

function applyFastAction(
  action: FastModeAction,
  ctx: ExtensionContext,
  state: FastModeState,
): boolean {
  const supported = isPriorityCapableModel(ctx.model as Model<Api> | undefined);

  if (!supported) {
    state.enabled = false;
    notifyUnsupportedModel(ctx);
    return false;
  }

  if (action === 'on') {
    state.enabled = true;
    notifyFastModeStatus(ctx, state);
    return true;
  }

  if (action === 'off') {
    state.enabled = false;
    notifyFastModeStatus(ctx, state);
    return true;
  }

  state.enabled = !state.enabled;
  notifyFastModeStatus(ctx, state);
  return true;
}

export function disableFastModeForUnsupportedModel(
  model: Model<Api> | undefined,
  state: FastModeState,
): boolean {
  if (!state.enabled || isPriorityCapableModel(model)) return false;
  state.enabled = false;
  return true;
}

export function setFastModeServiceTier(
  payload: unknown,
  ctx: ExtensionContext,
  state: FastModeState,
): RequestPayload | undefined {
  if (!state.enabled || !isPriorityCapableModel(ctx.model as Model<Api> | undefined)) {
    return undefined;
  }
  if (!isRequestPayload(payload)) return undefined;

  return {
    ...payload,
    service_tier: FAST_MODE_SERVICE_TIER,
  };
}

function notifyFastModeStatus(ctx: ExtensionContext, state: FastModeState): void {
  const status = state.enabled ? 'on' : 'off';
  ctx.ui.notify(`Fast mode: ${status}`, 'info');
}

function notifyUnsupportedModel(ctx: ExtensionContext): void {
  ctx.ui.notify('Fast mode unavailable: current model does not support priority', 'warning');
}

function isRequestPayload(payload: unknown): payload is RequestPayload {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload);
}
