import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { registerWebSearchTools } from './index';

/**
 * Add Parallel search and fetch tools without replacing a tool already owned
 * by Prime Agent or another extension. Prime's bundled `websearch` capability
 * is an IPython skill, not a registered `web_search` tool, so both can coexist.
 */
export default function primeWebSearch(pi: ExtensionAPI): void {
  const apiKey = process.env.PARALLEL_API_KEY;
  let registered = false;

  // Prime does not expose getAllTools() until the extension runtime is bound.
  // session_start is the first safe point to inspect ownership and register
  // only the missing Parallel tools.
  pi.on('session_start', async (_event, ctx) => {
    if (registered) return;

    const registeredToolNames = registerWebSearchTools(pi, {
      apiKey,
      includeConstrainedSampling: false,
      preserveExistingTools: true,
    });
    registered = true;

    if (!apiKey && registeredToolNames.length > 0 && ctx.hasUI) {
      ctx.ui.notify('web-search: PARALLEL_API_KEY not set — using free Search MCP', 'info');
    }
  });
}
