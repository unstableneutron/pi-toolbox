import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { Api, Model } from '@earendil-works/pi-ai';
import { modelRef, normalizeModelRef } from './model';

const FAST_MODE_SERVICE_TIER = 'priority';
const FAST_MODE_STATUS_KEY = 'editor-shortcut-fast';

const PRIORITY_CAPABLE_MODEL_REFS = [
  'openai-codex/gpt-5.3-codex-spark',
  'openai-codex/gpt-5.5',
  'openai-codex/gpt-5.6-sol',
  'openai-codex/gpt-5.6-terra',
  'openai-codex/gpt-5.6-luna',
  'openai/gpt-5.5',
] as const;

export type FastModeState = {
  enabled: boolean;
  enabledModelRefs: Set<string>;
};

export type FastModeAction = 'toggle' | 'on' | 'off';

export type FastModeTransition = 'on' | 'off';

type RequestPayload = Record<string, unknown>;

export type FastModeEligibility = (ctx: ExtensionContext | undefined) => boolean;

type PiFastModeContext = ExtensionContext & { mode?: string };

export function createFastModeState(): FastModeState {
  return { enabled: false, enabledModelRefs: new Set() };
}

export function isFastModeEligibleSession(
  ctx: ExtensionContext | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const piContext = ctx as PiFastModeContext | undefined;
  return piContext?.mode === 'tui' && ctx?.hasUI === true && env.PI_SUBAGENT_CHILD !== '1';
}

export function updateFastModeIndicator(
  ctx: ExtensionContext,
  state: FastModeState,
  isEligible: FastModeEligibility = isFastModeEligibleSession,
): void {
  if (!isEligible(ctx)) return;
  ctx.ui.setStatus(FAST_MODE_STATUS_KEY, state.enabled ? '⚡' : undefined);
}

function getPriorityModelRef(model: Model<Api> | undefined): string | undefined {
  if (!model) return undefined;
  const ref = normalizeModelRef(modelRef(model));
  const supported = PRIORITY_CAPABLE_MODEL_REFS.some(
    (candidate) => normalizeModelRef(candidate) === ref,
  );
  return supported ? ref : undefined;
}

export function isPriorityCapableModel(model: Model<Api> | undefined): boolean {
  return getPriorityModelRef(model) !== undefined;
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

export function registerFastCommand(
  pi: ExtensionAPI,
  state: FastModeState,
  isEligible: FastModeEligibility = isFastModeEligibleSession,
): void {
  pi.registerCommand('fast', {
    description: 'Toggle priority fast mode for supported OpenAI models',
    getArgumentCompletions(argumentPrefix) {
      const items = ['on', 'off'].map((value) => ({ value, label: value }));
      const filtered = items.filter((item) => item.value.startsWith(argumentPrefix));
      return filtered.length > 0 ? filtered : null;
    },
    async handler(args, ctx) {
      if (!isEligible(ctx)) return;
      applyFastCommand(args, ctx, state, isEligible);
    },
  });
}

function applyFastCommand(
  args: string,
  ctx: ExtensionCommandContext,
  state: FastModeState,
  isEligible: FastModeEligibility,
): void {
  const action = parseFastModeAction(args);

  if (!action) {
    ctx.ui.notify('Usage: /fast [on|off]', 'warning');
    return;
  }

  applyFastAction(action, ctx, state, isEligible);
}

export function applyFastDirective(
  value: string,
  ctx: ExtensionContext,
  state: FastModeState,
  isEligible: FastModeEligibility = isFastModeEligibleSession,
): boolean {
  if (!isEligible(ctx)) return false;

  const action = parseFastModeAction(value === 'toggle' ? undefined : value);

  if (!action) {
    ctx.ui.notify('Usage: /fast[:on|:off]', 'warning');
    return false;
  }

  return applyFastAction(action, ctx, state, isEligible);
}

function applyFastAction(
  action: FastModeAction,
  ctx: ExtensionContext,
  state: FastModeState,
  isEligible: FastModeEligibility,
): boolean {
  const ref = getPriorityModelRef(ctx.model as Model<Api> | undefined);

  if (!ref) {
    state.enabled = false;
    updateFastModeIndicator(ctx, state, isEligible);
    notifyUnsupportedModel(ctx);
    return false;
  }

  const enabled = action === 'toggle' ? !state.enabled : action === 'on';
  state.enabled = enabled;

  if (enabled) {
    state.enabledModelRefs.add(ref);
  } else {
    state.enabledModelRefs.delete(ref);
  }

  updateFastModeIndicator(ctx, state, isEligible);
  notifyFastModeStatus(ctx, state);
  return true;
}

export function syncFastModeForModel(
  model: Model<Api> | undefined,
  state: FastModeState,
): FastModeTransition | undefined {
  const ref = getPriorityModelRef(model);
  const enabled = ref !== undefined && state.enabledModelRefs.has(ref);
  if (enabled === state.enabled) return undefined;

  state.enabled = enabled;
  return enabled ? 'on' : 'off';
}

export function setFastModeServiceTier(
  payload: unknown,
  ctx: ExtensionContext,
  state: FastModeState,
  isEligible: FastModeEligibility = isFastModeEligibleSession,
): RequestPayload | undefined {
  if (!isEligible(ctx) || !state.enabled) return undefined;

  const ref = getPriorityModelRef(ctx.model as Model<Api> | undefined);
  if (!ref || !state.enabledModelRefs.has(ref) || !isRequestPayload(payload)) return undefined;

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
