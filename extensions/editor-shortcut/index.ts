import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';
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
import { getModelCandidates } from './commands/model';
import {
  createPasteShortcutState,
  expandPastePlaceholdersInMessages,
  restorePasteExpansions,
} from './commands/paste';
import { processEditorShortcutSubmission } from './processor';
import { hasTui } from '../shared/ui-mode';

export { createEditorShortcutAutocompleteProvider } from './autocomplete';
export { resolveEditorShortcutModel } from './commands/model';
export { createPasteShortcutState } from './commands/paste';
export { parseEditorShortcutText } from './parser';
export { processEditorShortcutSubmission } from './processor';

export default function editorShortcut(pi: ExtensionAPI) {
  const fastMode = createFastModeState();
  const pasteState = createPasteShortcutState();
  let selectedModel: Model<Api> | undefined;

  registerFastCommand(pi, fastMode);

  pi.on('before_provider_request', (event, ctx) => {
    return setFastModeServiceTier(event.payload, ctx, fastMode);
  });

  pi.on('model_select', (event, ctx) => {
    selectedModel = event.model;
    if (disableFastModeForUnsupportedModel(event.model, fastMode)) {
      ctx.ui.notify('Fast mode: off (current model does not support priority)', 'warning');
    }
  });

  pi.on('context', (event) => {
    const messages = expandPastePlaceholdersInMessages(event.messages, pasteState);
    return messages ? { messages } : undefined;
  });

  pi.on('session_start', (_event, ctx) => {
    selectedModel = ctx.model;
    restorePasteExpansions(ctx, pasteState);

    if (!hasTui(ctx)) return;

    ctx.ui.addAutocompleteProvider((current) =>
      createEditorShortcutAutocompleteProvider(
        current,
        () => getModelCandidates(ctx),
        () => fastMode.enabled,
        () => isPriorityCapableModel(selectedModel as any),
        { ctx, state: pasteState },
        () => (selectedModel ? getSupportedThinkingLevels(selectedModel) : ['off']),
      ),
    );

    const previousFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent(
      createWrappedEditorFactory(previousFactory, pi, ctx, fastMode, pasteState),
    );
  });

  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension') {
      return { action: 'continue' as const };
    }

    const result = await processEditorShortcutSubmission(event.text, pi, ctx, fastMode, pasteState);

    if (result.action === 'continue') return { action: 'continue' as const };
    if (result.action === 'submit') return { action: 'transform' as const, text: result.text };

    return { action: 'handled' as const };
  });
}
