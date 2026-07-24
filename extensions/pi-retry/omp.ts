import { createPiRetryExtension } from './index';
import { setRetrySettingsSource } from './settings';

setRetrySettingsSource('omp');

export default createPiRetryExtension({
  // OMP's AgentSession retry and recovery helpers are private class methods, so the
  // Pi prototype patch layer is intentionally disabled. The public extension
  // events still provide terminal-leaf detection, hidden generic Continue dispatch,
  // visible premature-abandonment recovery, context filtering, status updates,
  // manual /retry, and refusal rewrites.
  installAgentSessionPatch: false,
  // OMP's session_start payload does not include Pi's startup/resume/reload
  // reason. Prompting on every session_start is harmless because the prompt is
  // only shown when the current leaf is actually retryable.
  shouldPromptOnSessionStart: () => true,
});
