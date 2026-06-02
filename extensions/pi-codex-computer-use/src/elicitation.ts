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
  env?: Record<string, string | undefined>;
  hasUI: boolean;
  ui?: {
    confirm(title: string, message: string): Promise<boolean>;
  };
};

const COMPUTER_USE_SERVER = 'computer-use';
const NODE_REPL_SERVER = 'node_repl';
const SUPPORTED_ELICITATION_SERVERS = new Set([COMPUTER_USE_SERVER, NODE_REPL_SERVER]);
const ACCEPT_RESPONSE: McpElicitationResponse = {
  action: 'accept',
  content: {},
  _meta: { persist: 'always' },
};
const DISABLE_AUTO_APPROVE_VALUES = new Set(['0', 'false', 'no', 'off', 'none', 'disabled']);

function getAutoApproveSetting(env: Record<string, string | undefined>): string | undefined {
  return env.PI_CODEX_COMPUTER_USE_AUTO_APPROVE ?? env.PI_CODEX_COMPUTER_PUSE_AUTO_APPROVE;
}

function normalizeAutoApproveToken(token: string): string | undefined {
  const normalized = token.trim().toLowerCase().replaceAll('-', '_');
  if (normalized.length === 0) return undefined;
  if (normalized === 'all' || DISABLE_AUTO_APPROVE_VALUES.has(normalized)) return normalized;
  if (normalized === 'computer' || normalized === 'computer_use' || normalized === 'cua') {
    return COMPUTER_USE_SERVER;
  }
  if (normalized === 'node' || normalized === 'node_repl' || normalized === 'browser') {
    return NODE_REPL_SERVER;
  }
  return token.trim().toLowerCase();
}

function shouldAutoApprove(
  serverName: string | undefined,
  env: Record<string, string | undefined>,
): boolean {
  const rawSetting = getAutoApproveSetting(env);
  if (rawSetting === undefined || rawSetting.trim().length === 0) return true;

  const tokens = rawSetting
    .split(/[\s,]+/)
    .map(normalizeAutoApproveToken)
    .filter((token): token is string => token !== undefined);

  if (tokens.some((token) => DISABLE_AUTO_APPROVE_VALUES.has(token))) return false;
  if (tokens.includes('all')) return true;
  if (!serverName) return false;
  return tokens.includes(serverName);
}

export async function answerComputerUseElicitation(
  params: McpElicitationRequestParams,
  ctx: ElicitationContext,
): Promise<McpElicitationResponse> {
  if (params.serverName !== undefined && !SUPPORTED_ELICITATION_SERVERS.has(params.serverName)) {
    return { action: 'decline', content: null, _meta: null };
  }

  if (shouldAutoApprove(params.serverName, ctx.env ?? process.env)) {
    return ACCEPT_RESPONSE;
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

  return ok ? ACCEPT_RESPONSE : { action: 'decline', content: null, _meta: null };
}
