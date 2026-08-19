import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { createEditorShortcutAutocompleteProvider } from './autocomplete';
import { createWrappedEditorFactory } from './editor';
import {
  createFastModeState,
  type FastModeEligibility,
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

export type EditorShortcutOptions = {
  isTui?: (ctx: ExtensionContext) => boolean;
  isFastModeEligible?: FastModeEligibility;
  /**
   * Set to `false` when the host already ships its own fast-mode command, so
   * this extension neither registers `/fast` nor touches `service_tier`.
   */
  fastMode?: boolean;
};

export function createEditorShortcutExtension(options: EditorShortcutOptions = {}) {
  const isTui =
    options.isTui ??
    ((ctx: ExtensionContext) => hasTui(ctx as ExtensionContext & { mode: string }));
  const fastModeEnabled = options.fastMode ?? true;
  const isFastModeEligible: FastModeEligibility = fastModeEnabled
    ? (options.isFastModeEligible ?? isFastModeEligibleSession)
    : () => false;

  return function editorShortcut(pi: ExtensionAPI) {
    const fastMode = createFastModeState();
    const pasteState = createPasteShortcutState();
    let selectedModel: Model<Api> | undefined;

    if (fastModeEnabled) registerFastCommand(pi, fastMode, isFastModeEligible);

    pi.on('before_provider_request', (event, ctx) => {
      return setFastModeServiceTier(event.payload, ctx, fastMode, isFastModeEligible);
    });

    pi.on('model_select', (event, ctx) => {
      selectedModel = event.model;
      if (!isFastModeEligible(ctx)) return;

      const transition = syncFastModeForModel(event.model, fastMode);
      updateFastModeIndicator(ctx, fastMode, isFastModeEligible);
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

      if (!isTui(ctx)) return;

      updateFastModeIndicator(ctx, fastMode, isFastModeEligible);
      ctx.ui.addAutocompleteProvider((current) =>
        createEditorShortcutAutocompleteProvider(
          current,
          () => getModelCandidates(ctx),
          () => fastMode.enabled,
          () => isFastModeEligible(ctx) && isPriorityCapableModel(selectedModel as any),
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
          isFastModeEligible(ctx) ? fastMode : undefined,
          pasteState,
          isFastModeEligible,
        ),
      );
    });

    pi.on('input', async (event, ctx) => {
      if (event.source === 'extension') {
        return { action: 'continue' as const };
      }

      const result = await processEditorShortcutSubmission(
        event.text,
        pi,
        ctx,
        isFastModeEligible(ctx) ? fastMode : undefined,
        pasteState,
        isFastModeEligible,
      );

      if (result.action === 'continue') return { action: 'continue' as const };
      if (result.action === 'submit') return { action: 'transform' as const, text: result.text };

      return { action: 'handled' as const };
    });
  };
}

export default createEditorShortcutExtension();
