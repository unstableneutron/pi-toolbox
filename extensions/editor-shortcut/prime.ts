import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { createEditorShortcutExtension } from './index';

function isPrimeTuiContext(ctx: ExtensionContext): boolean {
  // Prime's public ExtensionContext intentionally has no `mode` discriminator.
  // Its interactive TUI is the only public UI surface that provides both editor
  // component methods. RPC has UI but does not provide an editor component.
  const ui = ctx.ui as { getEditorComponent?: unknown; setEditorComponent?: unknown };
  return (
    ctx.hasUI &&
    typeof ui.getEditorComponent === 'function' &&
    typeof ui.setEditorComponent === 'function'
  );
}

function isPrimeFastModeEligible(ctx: ExtensionContext | undefined): boolean {
  return !!ctx && isPrimeTuiContext(ctx) && process.env.PI_SUBAGENT_CHILD !== '1';
}

// Prime Agent retains the public editor, autocomplete, input, model, and
// provider-request APIs used by the shared implementation. Only the old
// Pi-specific `ctx.mode` check needs this structural adapter.
export default createEditorShortcutExtension({
  isTui: isPrimeTuiContext,
  isFastModeEligible: isPrimeFastModeEligible,
});
