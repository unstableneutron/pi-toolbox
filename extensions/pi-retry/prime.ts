import { createPiRetryExtension } from './index';
import { setRetrySettingsSource } from './settings';

setRetrySettingsSource('prime');

export default createPiRetryExtension({
  // Prime Agent already owns provider retry/backoff and does not expose its
  // private AgentSession retry helpers. Keep this adapter on public events,
  // commands, context filtering, messages, and session APIs.
  installAgentSessionPatch: false,
  // Prime documents startup and explicit resume/reload reasons. New and forked
  // sessions do not need a retryable-leaf prompt.
  shouldPromptOnSessionStart: (event) =>
    event.reason === 'startup' || event.reason === 'resume' || event.reason === 'reload',
});
