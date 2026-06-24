import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createEditorShortcutAutocompleteProvider } from './autocomplete';
import { createWrappedEditorFactory } from './editor';
import {
  createFastModeState,
  disableFastModeForUnsupportedModel,
  isPriorityCapableModel,
  registerFastCommand,
  setFastModeServiceTier,
} from './commands/fast';
import { getModelCandidates, resolveEditorShortcutModel } from './commands/model';
import { parseEditorShortcutText } from './parser';
import { applyDirectives, processEditorShortcutSubmission } from './processor';
import { hasTui } from '../shared/ui-mode';

export { createEditorShortcutAutocompleteProvider } from './autocomplete';
export { resolveEditorShortcutModel } from './commands/model';
export { parseEditorShortcutText } from './parser';
export { processEditorShortcutSubmission } from './processor';

export default function editorShortcut(pi: ExtensionAPI) {
  const fastMode = createFastModeState();

  registerFastCommand(pi, fastMode);

  pi.on('before_provider_request', (event, ctx) => {
    return setFastModeServiceTier(event.payload, ctx, fastMode);
  });

  pi.on('model_select', (event, ctx) => {
    if (disableFastModeForUnsupportedModel(event.model, fastMode)) {
      ctx.ui.notify('Fast mode: off (current model does not support priority)', 'warning');
    }
  });

  pi.on('session_start', (_event, ctx) => {
    if (!hasTui(ctx)) return;

    ctx.ui.addAutocompleteProvider((current) =>
      createEditorShortcutAutocompleteProvider(
        current,
        () => getModelCandidates(ctx),
        () => fastMode.enabled,
        () => isPriorityCapableModel(ctx.model as any),
      ),
    );

    const previousFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent(createWrappedEditorFactory(previousFactory, pi, ctx, fastMode));
  });

  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension') {
      return { action: 'continue' as const };
    }

    const parsed = parseEditorShortcutText(event.text);
    if (!parsed) return { action: 'continue' as const };

    const success = await applyDirectives(parsed, pi, ctx, fastMode);
    if (!success || !parsed.promptText) return { action: 'handled' as const };

    return { action: 'transform' as const, text: parsed.promptText };
  });
}
