import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export type ThinkingLevel = ModelThinkingLevel;

export const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ModelThinkingLevel[];

function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel);
}

export function parseThinkingLevel(value: string): ThinkingLevel | null {
  const level = value.toLowerCase();
  return isThinkingLevel(level) ? level : null;
}

export function applyThinkingDirective(
  value: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): boolean {
  const level = parseThinkingLevel(value);
  if (!level) {
    ctx.ui.notify(`Usage: /thinking ${THINKING_LEVELS.join('|')}`, 'warning');
    return false;
  }
  pi.setThinkingLevel(level);
  ctx.ui.notify(`Thinking: ${level}`, 'info');
  return true;
}
