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

export async function answerComputerUseElicitation(
  params: McpElicitationRequestParams,
  ctx: ElicitationContext,
): Promise<McpElicitationResponse> {
  if (params.serverName !== undefined && params.serverName !== 'computer-use') {
    return { action: 'decline', content: null, _meta: null };
  }

  if (!ctx.hasUI || !ctx.ui) {
    return { action: 'decline', content: null, _meta: null };
  }

  const message = params.message || 'Allow Codex to use this app?';
  const ok = await ctx.ui.confirm(
    'Allow Computer Use?',
    `${message}\n\nThis grants Codex Computer Use access to operate the named local app through the Codex native CUA service for this request.`,
  );

  return ok
    ? { action: 'accept', content: {}, _meta: { persist: 'always' } }
    : { action: 'decline', content: null, _meta: null };
}
