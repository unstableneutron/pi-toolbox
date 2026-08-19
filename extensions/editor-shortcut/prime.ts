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

// Prime Agent retains the public editor, autocomplete, input, model, and
// provider-request APIs used by the shared implementation. Two host differences
// need adapting:
//   1. the old Pi-specific `ctx.mode` check becomes a structural TUI probe;
//   2. Prime ships a built-in `/fast` command plus native priority-tier
//      handling (`supportsFastMode`), so registering ours only produced a
//      "conflicts with built-in interactive command" warning and an unreachable
//      handler. Fast mode is therefore left entirely to the host.
export default createEditorShortcutExtension({
  isTui: isPrimeTuiContext,
  fastMode: false,
});
