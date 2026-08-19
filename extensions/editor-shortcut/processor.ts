import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  applyFastDirective,
  type FastModeEligibility,
  type FastModeState,
  isFastModeEligibleSession,
} from './commands/fast';
import { applyModelDirective } from './commands/model';
import { replacePasteDirectivesInText, type PasteShortcutState } from './commands/paste';
import { applyThinkingDirective } from './commands/thinking';
import { parseEditorShortcutText } from './parser';
import type { EditorShortcutDirective, ParsedEditorShortcut, SubmitResult } from './types';

async function applyDirective(
  directive: EditorShortcutDirective,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  fastMode: FastModeState | undefined,
  isFastModeEligible: FastModeEligibility,
): Promise<boolean> {
  if (directive.command === 'thinking') {
    return applyThinkingDirective(directive.value, pi, ctx);
  }

  if (directive.command === 'fast') {
    return fastMode ? applyFastDirective(directive.value, ctx, fastMode, isFastModeEligible) : true;
  }

  return applyModelDirective(directive.value, pi, ctx);
}

async function applyDirectives(
  parsed: ParsedEditorShortcut,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  fastMode: FastModeState | undefined,
  isFastModeEligible: FastModeEligibility,
): Promise<boolean> {
  for (const directive of parsed.directives) {
    if (!(await applyDirective(directive, pi, ctx, fastMode, isFastModeEligible))) return false;
  }
  return true;
}

export async function processEditorShortcutSubmission(
  text: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  fastMode?: FastModeState,
  pasteState?: PasteShortcutState,
  isFastModeEligible: FastModeEligibility = isFastModeEligibleSession,
): Promise<SubmitResult> {
  const parsed = parseEditorShortcutText(text);
  if (parsed && !(await applyDirectives(parsed, pi, ctx, fastMode, isFastModeEligible))) {
    return { action: 'restore', text };
  }

  // Expand $paste after parsing/applying other directives so parser whitespace
  // normalization never rewrites the pasted payload itself.
  const promptText = parsed ? parsed.promptText : text;
  if (!pasteState) {
    if (!parsed) return { action: 'continue' };
    return parsed.promptText
      ? { action: 'submit', text: parsed.promptText }
      : { action: 'handled' };
  }

  const pasteResult = await replacePasteDirectivesInText(promptText, pi, ctx, pasteState);
  if (pasteResult.found) {
    if (!pasteResult.ok) return { action: 'restore', text };
    return pasteResult.text ? { action: 'submit', text: pasteResult.text } : { action: 'handled' };
  }

  if (!parsed) return { action: 'continue' };

  return parsed.promptText ? { action: 'submit', text: parsed.promptText } : { action: 'handled' };
}
