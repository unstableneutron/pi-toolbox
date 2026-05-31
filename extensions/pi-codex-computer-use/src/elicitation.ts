export interface McpElicitationRequestParams {
  serverName?: string;
  message?: string;
  requestedSchema?: unknown;
}

export interface McpElicitationResponse {
  action: 'accept' | 'decline' | 'cancel';
  content: Record<string, never> | null;
  _meta: Record<string, unknown> | null;
}

type ElicitationContext = {
  hasUI: boolean;
  ui?: {
    confirm(title: string, message: string): Promise<boolean>;
  };
};

const COMPUTER_USE_SERVER = 'computer-use';
const NODE_REPL_SERVER = 'node_repl';
const SUPPORTED_ELICITATION_SERVERS = new Set([COMPUTER_USE_SERVER, NODE_REPL_SERVER]);

export async function answerComputerUseElicitation(
  params: McpElicitationRequestParams,
  ctx: ElicitationContext,
): Promise<McpElicitationResponse> {
  if (params.serverName !== undefined && !SUPPORTED_ELICITATION_SERVERS.has(params.serverName)) {
    return { action: 'decline', content: null, _meta: null };
  }

  if (!ctx.hasUI || !ctx.ui) {
    return { action: 'decline', content: null, _meta: null };
  }

  const isNodeRepl = params.serverName === NODE_REPL_SERVER;
  const message = params.message || 'Allow Codex to use this app?';
  const ok = await ctx.ui.confirm(
    isNodeRepl ? 'Allow Codex Browser Use?' : 'Allow Computer Use?',
    isNodeRepl
      ? `${message}\n\nThis grants Codex browser/runtime access through the Codex native Node REPL bridge for this request.`
      : `${message}\n\nThis grants Codex Computer Use access to operate the named local app through the Codex native CUA service for this request.`,
  );

  return ok
    ? { action: 'accept', content: {}, _meta: { persist: 'always' } }
    : { action: 'decline', content: null, _meta: null };
}
