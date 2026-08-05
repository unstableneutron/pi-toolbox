import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { createEditorShortcutAutocompleteProvider } from './autocomplete';
import { createWrappedEditorFactory } from './editor';
import {
  createFastModeState,
  isFastModeEligibleSession,
  isPriorityCapableModel,
  registerFastCommand,
  setFastModeServiceTier,
  syncFastModeForModel,
  updateFastModeIndicator,
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
    if (!isFastModeEligibleSession(ctx)) return;

    const transition = syncFastModeForModel(event.model, fastMode);
    updateFastModeIndicator(ctx, fastMode);
    if (transition === 'on') {
      ctx.ui.notify('Fast mode: on (restored for current model)', 'info');
    } else if (transition === 'off' && !isPriorityCapableModel(event.model)) {
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

    updateFastModeIndicator(ctx, fastMode);
    ctx.ui.addAutocompleteProvider((current) =>
      createEditorShortcutAutocompleteProvider(
        current,
        () => getModelCandidates(ctx),
        () => fastMode.enabled,
        () => isFastModeEligibleSession(ctx) && isPriorityCapableModel(selectedModel as any),
        { ctx, state: pasteState },
        () => (selectedModel ? getSupportedThinkingLevels(selectedModel) : ['off']),
      ),
    );

    const previousFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent(
      createWrappedEditorFactory(
        previousFactory,
        pi,
        ctx,
        isFastModeEligibleSession(ctx) ? fastMode : undefined,
        pasteState,
      ),
    );
  });

  pi.on('input', async (event, ctx) => {
    if (event.source === 'extension') {
      return { action: 'continue' as const };
    }

    const fastModeEligible = isFastModeEligibleSession(ctx);
    const result = await processEditorShortcutSubmission(
      event.text,
      pi,
      ctx,
      fastModeEligible ? fastMode : undefined,
      pasteState,
    );

    if (result.action === 'continue') return { action: 'continue' as const };
    if (result.action === 'submit') return { action: 'transform' as const, text: result.text };

    return { action: 'handled' as const };
  });
}
