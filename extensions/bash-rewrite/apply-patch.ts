export type ToolAvailability =
  | Iterable<string | { name?: unknown }>
  | ((toolName: string) => boolean);

export interface BashRewriteDecision<ToolName extends string = string> {
  tool: ToolName;
  params: Record<string, unknown>;
  recognizer: string;
}

export interface BashRewriteResult<ToolName extends string = string> {
  decision: BashRewriteDecision<ToolName>;
  notice: string;
}

export interface ApplyPatchCliBashRewriteOptions {
  availableTools?: ToolAvailability;
}

const APPLY_PATCH_TOOL_NAME = 'apply_patch';
const HEREDOC_HEADER_PATTERN =
  /^\s*apply_patch\s+(<<-?)\s*(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\2|\\?([A-Za-z_][A-Za-z0-9_]*))[ \t]*\r?\n/;

function isApplyPatchAvailable(availableTools: ToolAvailability | undefined): boolean {
  if (!availableTools) return true;
  if (typeof availableTools === 'function') return availableTools(APPLY_PATCH_TOOL_NAME);

  for (const tool of availableTools) {
    if (typeof tool === 'string') {
      if (tool === APPLY_PATCH_TOOL_NAME) return true;
      continue;
    }
    if (tool.name === APPLY_PATCH_TOOL_NAME) return true;
  }
  return false;
}

function stripLeadingTabs(value: string): string {
  return value.replace(/^\t+/gm, '');
}

function extractHereDocBody(input: string, delimiter: string, stripTabs: boolean): string | null {
  let offset = 0;

  while (offset <= input.length) {
    const newlineIndex = input.indexOf('\n', offset);
    const lineEnd = newlineIndex === -1 ? input.length : newlineIndex + 1;
    const rawLine = input.slice(offset, lineEnd);
    const lineWithoutNewline = rawLine.endsWith('\n')
      ? rawLine.slice(0, -1).replace(/\r$/, '')
      : rawLine.replace(/\r$/, '');
    const candidate = stripTabs ? lineWithoutNewline.replace(/^\t+/, '') : lineWithoutNewline;

    if (candidate === delimiter) {
      const rest = input.slice(lineEnd);
      if (rest.trim().length > 0) return null;
      const body = input.slice(0, offset);
      return stripTabs ? stripLeadingTabs(body) : body;
    }

    if (newlineIndex === -1) break;
    offset = lineEnd;
  }

  return null;
}

function countLines(value: string): number {
  if (value.length === 0) return 0;
  const matches = value.match(/\r?\n/g);
  return matches?.length ?? 1;
}

function formatNotice(patch: string): string {
  const lineCount = countLines(patch);
  const byteCount = Buffer.byteLength(patch, 'utf8');
  const lineLabel = lineCount === 1 ? 'line' : 'lines';
  const byteLabel = byteCount === 1 ? 'byte' : 'bytes';
  return `apply_patch CLI → apply_patch(patch=${lineCount} ${lineLabel}, ${byteCount} ${byteLabel})`;
}

export function tryRewriteApplyPatchCliBash(
  command: string,
  options: ApplyPatchCliBashRewriteOptions = {},
): BashRewriteResult<'apply_patch'> | null {
  if (!isApplyPatchAvailable(options.availableTools)) return null;

  const header = HEREDOC_HEADER_PATTERN.exec(command);
  if (!header) return null;

  const redirectOperator = header[1]!;
  const delimiter = header[3] ?? header[4];
  if (!delimiter) return null;

  const body = extractHereDocBody(
    command.slice(header[0].length),
    delimiter,
    redirectOperator === '<<-',
  );
  if (body === null) return null;

  return {
    decision: {
      tool: APPLY_PATCH_TOOL_NAME,
      params: { patch: body },
      recognizer: 'apply-patch-heredoc',
    },
    notice: formatNotice(body),
  };
}
