import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { applyFastDirective, type FastModeState } from './commands/fast';
import { applyModelDirective } from './commands/model';
import { applyThinkingDirective } from './commands/thinking';
import { parseEditorShortcutText } from './parser';
import type { EditorShortcutDirective, ParsedEditorShortcut, SubmitResult } from './types';

async function applyDirective(
  directive: EditorShortcutDirective,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  fastMode?: FastModeState,
): Promise<boolean> {
  if (directive.command === 'thinking') {
    return applyThinkingDirective(directive.value, pi, ctx);
  }

  if (directive.command === 'fast') {
    return applyFastDirective(directive.value, ctx, fastMode ?? { enabled: false });
  }

  return applyModelDirective(directive.value, pi, ctx);
}

export async function applyDirectives(
  parsed: ParsedEditorShortcut,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  fastMode?: FastModeState,
): Promise<boolean> {
  for (const directive of parsed.directives) {
    if (!(await applyDirective(directive, pi, ctx, fastMode))) return false;
  }
  return true;
}

export async function processEditorShortcutSubmission(
  text: string,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  fastMode?: FastModeState,
): Promise<SubmitResult> {
  const parsed = parseEditorShortcutText(text);
  if (!parsed) return { action: 'continue' };

  if (!(await applyDirectives(parsed, pi, ctx, fastMode))) return { action: 'restore', text };

  return parsed.promptText ? { action: 'submit', text: parsed.promptText } : { action: 'handled' };
}
