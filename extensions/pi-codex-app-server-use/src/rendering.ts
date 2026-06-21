import {
  Container,
  Image,
  Spacer,
  Text,
  sliceByColumn,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui';
import { formatSize, type TruncationResult } from '@earendil-works/pi-coding-agent';

import {
  tryRewriteBashReadOperations,
  type BashReadOperation,
} from '../../bash-rewrite/bash-rewrite';
import { renderApplyPatchRows } from '../../shared/apply-patch-summary';
import { shortenDisplayPath, truncatePathLikeToWidth } from '../../shared/paths';
import {
  clampRenderedLineToWidth,
  sanitizeRenderableText,
  type WidthMeasurementOps,
} from '../../shared/tui-width';
import { parsePatchStreaming } from '../../multi-edit/patch';
import type { UnifiedExecResult } from './exec-tools';
import { clampExecYieldTime, effectiveWriteYieldTime, formatYieldLimit } from './yield-time';

interface RenderTheme {
  bold(text: string): string;
  fg(role: string, text: string): string;
}

interface RenderOptions {
  expanded?: boolean | undefined;
  isPartial?: boolean | undefined;
}

interface RenderContext {
  args?: unknown;
  state?: Record<string, unknown> | undefined;
  lastComponent?: Component | undefined;
  expanded?: boolean | undefined;
  isError?: boolean | undefined;
}

const COLLAPSED_EXEC_PREVIEW_LINES = 3;
const EXPANDED_EXEC_HEAD_LINES = 80;
const EXPANDED_EXEC_TAIL_LINES = 80;
const READ_DURATION_NOTICE_SECONDS = 1;
const DISPLAY_TAB = '   ';
const ANSI_CODE_PATTERN = String.raw`(?:\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_])`;
const TRAILING_ANSI_CODES = new RegExp(`${ANSI_CODE_PATTERN}+$`, 'u');
const LEADING_ANSI_CODES = new RegExp(`^${ANSI_CODE_PATTERN}+`, 'u');
const RENDER_WIDTH_OPS: WidthMeasurementOps = {
  measure: visibleWidth,
  truncate: (text, maxWidth) => truncateWithStyledEllipsis(text, maxWidth),
};

type ImageContent = { type: 'image'; data: string; mimeType: string };
type ToolContent = { type: string; text?: string | undefined } | ImageContent;

type ToolResult = {
  content?: ToolContent[];
  details?: unknown;
};

function isImageContent(item: ToolContent): item is ImageContent {
  return (
    item.type === 'image' &&
    'data' in item &&
    typeof item.data === 'string' &&
    'mimeType' in item &&
    typeof item.mimeType === 'string'
  );
}

function isTextContent(item: ToolContent): item is { type: 'text'; text?: string | undefined } {
  return item.type === 'text';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncateOneLine(text: string, maxLength: number): string {
  const oneLine = normalizeToolDisplayText(text).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLength) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeToolDisplayText(text: string): string {
  return sanitizeRenderableText(text).replace(/\r/g, '').replace(/\t/g, DISPLAY_TAB);
}

function clampRenderLine(text: string, width: number): string {
  return clampRenderedLineToWidth(text, width, RENDER_WIDTH_OPS);
}

function clampRenderLines(lines: string[], width: number): string[] {
  return lines.map((line) => clampRenderLine(line, width));
}

function trailingAnsiCodes(text: string): string {
  return TRAILING_ANSI_CODES.exec(text)?.[0] ?? '';
}

function leadingAnsiCodes(text: string): string {
  return LEADING_ANSI_CODES.exec(text)?.[0] ?? '';
}

function truncateWithStyledEllipsis(text: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0 || text.length === 0) return '';
  if (visibleWidth(text) <= maxWidth) return text;

  const ellipsisWidth = visibleWidth(ellipsis);
  const trailingAnsi = trailingAnsiCodes(text);
  if (ellipsisWidth >= maxWidth) {
    return `${leadingAnsiCodes(text)}${sliceByColumn(ellipsis, 0, maxWidth, true)}${trailingAnsi}`;
  }

  const prefix = sliceByColumn(text, 0, maxWidth - ellipsisWidth, true);
  return `${prefix}${ellipsis}${trailingAnsi}`;
}

function compactCommandInput(command: string, headLines = 3, tailLines = 3): string {
  const lines = normalizeToolDisplayText(command).split('\n');
  const linePrefix = (index: number) => `${index === 0 ? '$' : '>'} ${lines[index] || ' '}`;
  if (lines.length <= headLines + tailLines) {
    return lines.map((_line, index) => linePrefix(index)).join('\n');
  }

  const hidden = lines.length - headLines - tailLines;
  const rendered = [
    ...lines.slice(0, headLines).map((_line, index) => linePrefix(index)),
    `... (${hidden} more line${hidden === 1 ? '' : 's'})`,
    ...lines.slice(-tailLines).map((_line, index) => linePrefix(lines.length - tailLines + index)),
  ];
  return rendered.join('\n');
}

function fullCommandInput(command: string): string {
  return normalizeToolDisplayText(command)
    .split('\n')
    .map((line, index) => `${index === 0 ? '$' : '>'} ${line || ' '}`)
    .join('\n');
}

function firstTextContent(result: ToolResult): string {
  return normalizeToolDisplayText(result.content?.find(isTextContent)?.text ?? '');
}

function invalidArgText(theme: RenderTheme): string {
  return theme.fg('error', '<invalid>');
}

function previewOutputLines(
  text: string,
  maxLines = COLLAPSED_EXEC_PREVIEW_LINES,
): { lines: string[]; skipped: number } {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length <= maxLines) return { lines, skipped: 0 };
  return { lines: lines.slice(-maxLines), skipped: lines.length - maxLines };
}

function outputLines(text: string): string[] {
  const fallback = text || '(no output)';
  const lines = fallback.split('\n');
  while (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

function hasMeaningfulOutput(output: string): boolean {
  return output.trim().length > 0;
}

function formatDuration(seconds: number | undefined): string | undefined {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? `${seconds.toFixed(1)}s`
    : undefined;
}

function formatTokenCount(tokens: number | undefined): string | undefined {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return undefined;
  if (tokens < 1000) return `${tokens} token${tokens === 1 ? '' : 's'}`;
  return `${(tokens / 1000).toFixed(1)}k tokens`;
}

function textCell(title: string, detail: string | undefined, theme: RenderTheme): Text {
  let text = `${theme.fg('dim', '•')} ${theme.bold(title)}`;
  if (detail?.trim()) text += `\n${theme.fg('dim', '  └ ')}${theme.fg('accent', detail.trim())}`;
  return new Text(text, 0, 0);
}

function empty(): Container {
  return new Container();
}

function execDetails(value: unknown): UnifiedExecResult | undefined {
  const record = asRecord(value);
  if (typeof record.output !== 'string') return undefined;
  if (typeof record.wall_time_seconds !== 'number') return undefined;
  return record as unknown as UnifiedExecResult;
}

function formatOutputTruncationNotice(truncation: TruncationResult): string {
  if (truncation.truncatedBy === 'lines') {
    return `[Output truncated: showing last ${truncation.outputLines} of ${truncation.totalLines} lines. Rerun with a narrower command or line range to inspect more.]`;
  }
  return `[Output truncated: showing ${truncation.outputLines} lines from the end (${formatSize(truncation.maxBytes)} limit). Rerun with a narrower command or line range to inspect more.]`;
}

function execSessionId(details: UnifiedExecResult | undefined): number | undefined {
  return details?.exec_session_id ?? details?.session_id;
}

function formatExecStatus(
  details: UnifiedExecResult | undefined,
  running: boolean,
  isPartial: boolean | undefined,
  hasOutput: boolean,
): string | undefined {
  const duration = formatDuration(details?.wall_time_seconds);
  if (!duration) return undefined;
  const id = execSessionId(details);
  const prefix = id !== undefined ? `Exec #${id}` : undefined;
  if (running) {
    const suffix = !hasOutput && !isPartial ? ' · no output yet' : '';
    if (prefix)
      return `${prefix} ${isPartial ? 'elapsed' : 'still running after'} ${duration}${suffix}`;
    return `${isPartial ? 'Elapsed' : 'Still running after'} ${duration}${suffix}`;
  }
  const suffix = hasOutput ? '' : ' · no output';
  const tokenSuffix = formatTokenCount(details?.original_token_count);
  const tokenText = tokenSuffix ? ` · ${tokenSuffix}` : '';
  if (details?.exit_code !== undefined && prefix) {
    return `${prefix} exited ${details.exit_code} · Took ${duration}${suffix}${tokenText}`;
  }
  return `Took ${duration}${suffix}${tokenText}`;
}

function stripExecStatusPrefix(status: string, id: number | undefined): string {
  return id === undefined ? status : status.replace(new RegExp(`^Exec #${id}\\s+`), '');
}

function inlineExecStatus(status: string): string {
  if (status.startsWith('Exec #')) return `exec #${status.slice('Exec #'.length)}`;
  return status.charAt(0).toLowerCase() + status.slice(1);
}

function extractEmbeddedExecStatus(text: string): { output: string; status: string } | null {
  const trimmed = text.trimEnd();
  const separatorIndex = trimmed.lastIndexOf('\n\n');
  if (separatorIndex < 0) return null;
  const status = trimmed.slice(separatorIndex + 2).trim();
  if (!/^Exec #\d+ exited \d+ · Took .+$/.test(status)) return null;
  return { output: trimmed.slice(0, separatorIndex), status };
}

function expandedOutputLines(output: string, theme: RenderTheme): string[] {
  const lines = outputLines(output);
  const maxLines = EXPANDED_EXEC_HEAD_LINES + EXPANDED_EXEC_TAIL_LINES;
  if (lines.length <= maxLines) return lines;

  const omitted = lines.length - maxLines;
  return [
    ...lines.slice(0, EXPANDED_EXEC_HEAD_LINES),
    theme.fg(
      'muted',
      `... (${omitted} middle lines omitted; rerun with a narrower command to inspect)`,
    ),
    ...lines.slice(-EXPANDED_EXEC_TAIL_LINES),
  ];
}

class ExecResultComponent implements Component {
  constructor(
    private lines: string[],
    private expanded: boolean,
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (this.expanded) {
      const lines = this.lines.flatMap((line) =>
        visibleWidth(line) <= safeWidth ? [line] : wrapTextWithAnsi(line, safeWidth),
      );
      return clampRenderLines(lines, safeWidth);
    }
    return clampRenderLines(
      this.lines.map((line) => truncateWithStyledEllipsis(line, safeWidth)),
      safeWidth,
    );
  }

  invalidate(): void {}
}

class ExecCommandCallComponent implements Component {
  private inlineStatus: string | undefined;
  private fallbackStatus: string | undefined;

  constructor(
    private commandText: string,
    private yieldLimit: string | undefined,
    private theme: RenderTheme,
  ) {}

  setInlineStatus(inlineStatusText: string, fallbackStatusText: string): void {
    this.inlineStatus = inlineStatusText;
    this.fallbackStatus = fallbackStatusText;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const title = (text: string) => this.theme.fg('toolTitle', this.theme.bold(text));
    const originalSuffix = this.yieldLimit ? this.theme.fg('muted', ` (${this.yieldLimit})`) : '';

    if (!this.commandText.includes('\n')) {
      if (this.inlineStatus) {
        const inline = title(this.commandText) + this.theme.fg('muted', ` (${this.inlineStatus})`);
        if (visibleWidth(inline) <= safeWidth) return clampRenderLines([inline], safeWidth);
      }
      return [
        title(this.commandText) + originalSuffix,
        ...(this.fallbackStatus ? [this.theme.fg('muted', this.fallbackStatus)] : []),
      ].map((line) => clampRenderLine(line, safeWidth));
    }

    const lines = this.commandText.split('\n').map((line) => title(line));
    if (this.fallbackStatus) lines.push(this.theme.fg('muted', this.fallbackStatus));
    return clampRenderLines(lines, safeWidth);
  }

  invalidate(): void {}
}

function tryExecReadOperations(command: string | undefined, cwd?: string) {
  if (!command) return null;
  try {
    return tryRewriteBashReadOperations(command, cwd ?? process.cwd());
  } catch {
    return null;
  }
}

function formatReadPathAndMetric(
  operation: BashReadOperation,
  cwd: string | undefined,
): { path: string; metric: string } {
  const path = shortenDisplayPath(operation.path, cwd);
  if (operation.offset === undefined || operation.limit === undefined) {
    return { path, metric: 'read' };
  }
  const range =
    operation.limit === 1
      ? `${operation.offset}`
      : `${operation.offset}-${operation.offset + operation.limit - 1}`;
  return { path: `${path}:${range}`, metric: `${operation.limit}L` };
}

class ExecReadOperationsComponent implements Component {
  private tokenCount: string | undefined;

  constructor(
    private operations: BashReadOperation[],
    private theme: RenderTheme,
    private cwd: string | undefined,
  ) {}

  setTokenCount(tokenCount: string): void {
    this.tokenCount = tokenCount;
  }

  render(width: number): string[] {
    const count = this.operations.length;
    if (count === 1)
      return clampRenderLines([this.renderOperation(this.operations[0]!, width, false)], width);

    const metric = `${count} operations${this.tokenCount ? ` · ${this.tokenCount}` : ''}`;
    const lines = [
      `${this.theme.fg('toolTitle', this.theme.bold('exec'))} ${this.theme.fg('muted', metric)}`,
    ];

    for (const operation of this.operations) {
      lines.push(this.renderOperation(operation, width, true));
    }

    return clampRenderLines(lines, width);
  }

  private renderOperation(operation: BashReadOperation, width: number, bullet: boolean): string {
    const prefix = bullet
      ? `${this.theme.fg('success', '✓')} ${this.theme.fg('text', 'read'.padEnd(6, ' '))} `
      : this.theme.fg('toolTitle', this.theme.bold('read '));
    const { path, metric } = formatReadPathAndMetric(operation, this.cwd);
    const suffixMetric = `${metric}${!bullet && this.tokenCount ? ` · ${this.tokenCount}` : ''}`;
    const suffix = this.theme.fg('muted', ` · ${suffixMetric}`);
    const pathWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
    const renderedPath = this.theme.fg('accent', truncatePathLikeToWidth(path, pathWidth));
    return `${prefix}${renderedPath}${suffix}`;
  }

  invalidate(): void {}
}

class ApplyPatchCallComponent implements Component {
  private tokenCount: string | undefined;
  private applied = false;

  constructor(
    private rows: ReturnType<typeof parsePatchStreaming>['operations'],
    private theme: RenderTheme,
  ) {}

  setTokenCount(tokenCount: string): void {
    this.tokenCount = tokenCount;
  }

  markApplied(): void {
    this.applied = true;
  }

  render(width: number): string[] {
    const count = this.rows.length;
    const metric = `${count} operation${count === 1 ? '' : 's'}${this.tokenCount ? ` · ${this.tokenCount}` : ''}`;
    return clampRenderLines(
      [
        `${this.theme.fg('toolTitle', this.theme.bold('apply_patch'))} ${this.theme.fg('muted', metric)}`,
        ...renderApplyPatchRows(
          this.applied
            ? this.rows.map((row) => ({ ...row, state: 'applied' as const }))
            : this.rows,
          this.theme,
        ).render(width),
      ],
      width,
    );
  }

  invalidate(): void {}
}

export function renderExecCommandCall(
  args: unknown,
  theme: RenderTheme,
  context?: RenderContext,
): Component {
  const record = asRecord(args);
  const command = 'cmd' in record ? stringValue(record.cmd) : stringValue(record.command);
  const commandDisplay =
    command === undefined ? invalidArgText(theme) : command || theme.fg('toolOutput', '...');
  const requestedYield = numberValue(record.yield_time_ms);
  const yieldLimit =
    requestedYield === undefined
      ? undefined
      : formatYieldLimit(clampExecYieldTime(requestedYield, undefined, record.tty === true));
  const cwd =
    stringValue(record.workdir) ?? stringValue(record.cwd) ?? stringValue(record.working_directory);
  const readOperations = tryExecReadOperations(command, cwd);
  if (!context?.expanded && readOperations) {
    const component = new ExecReadOperationsComponent(
      readOperations.operations,
      theme,
      readOperations.cwd ?? cwd,
    );
    if (context?.state) context.state.execReadOperationsComponent = component;
    return component;
  }
  const compact =
    command === undefined
      ? commandDisplay
      : context?.expanded
        ? fullCommandInput(commandDisplay)
        : compactCommandInput(commandDisplay);
  const component = new ExecCommandCallComponent(compact, yieldLimit, theme);
  if (context?.state) {
    context.state.execCommandCallComponent = component;
  }
  return component;
}

export function renderExecCommandResult(
  result: ToolResult,
  options: RenderOptions,
  theme: RenderTheme,
  context?: RenderContext,
): Component {
  const details = execDetails(result.details);
  const embedded = details ? null : extractEmbeddedExecStatus(firstTextContent(result));
  const output = normalizeToolDisplayText(
    details?.output ?? embedded?.output ?? firstTextContent(result),
  );
  const running = details?.session_id !== undefined && details.exit_code === undefined;
  const readOperations = tryExecReadOperations(details?.command);
  const hasOutput = hasMeaningfulOutput(output);

  if (!options.expanded) {
    if (!options.isPartial && !running && details?.exit_code === 0 && readOperations) {
      const tokenCount = formatTokenCount(details.original_token_count);
      const readOperationsComponent = context?.state?.execReadOperationsComponent;
      if (tokenCount && readOperationsComponent instanceof ExecReadOperationsComponent) {
        readOperationsComponent.setTokenCount(tokenCount);
      }
      const duration = formatDuration(details.wall_time_seconds);
      if (duration && details.wall_time_seconds >= READ_DURATION_NOTICE_SECONDS) {
        return new Text(theme.fg('muted', `Took ${duration}`), 0, 0);
      }
      return empty();
    }
    const status =
      embedded?.status ?? formatExecStatus(details, running, options.isPartial, hasOutput);
    if (!hasOutput) {
      const argsRecord = asRecord(context?.args);
      const writeSessionId = numberValue(argsRecord.session_id);
      const writeCallText = context?.state?.writeStdinCallText;
      const writeCallBase = context?.state?.writeStdinCallBase;
      if (
        writeSessionId !== undefined &&
        writeCallText instanceof Text &&
        typeof writeCallBase === 'string' &&
        status
      ) {
        writeCallText.setText(
          theme.fg('toolTitle', theme.bold(writeCallBase)) +
            theme.fg('muted', ` (${stripExecStatusPrefix(status, writeSessionId)})`),
        );
        return empty();
      }
      const execCallComponent = context?.state?.execCommandCallComponent;
      const hasExecCommandArgs =
        stringValue(argsRecord.cmd) !== undefined || stringValue(argsRecord.command) !== undefined;
      if (hasExecCommandArgs && execCallComponent instanceof ExecCommandCallComponent && status) {
        execCallComponent.setInlineStatus(inlineExecStatus(status), status);
        return empty();
      }
      const lines = [
        ...(details?.truncation?.truncated
          ? [theme.fg('warning', formatOutputTruncationNotice(details.truncation))]
          : []),
        ...(status ? [theme.fg('muted', status)] : []),
      ];
      return new ExecResultComponent(lines, false);
    }
    const { lines, skipped } = previewOutputLines(output || '(no output)');
    const rendered = lines.map((line) => theme.fg('toolOutput', line));
    const prefix =
      skipped > 0 ? [theme.fg('muted', `... (${skipped} earlier lines, Ctrl+O to expand)`)] : [];
    const leadingSeparator = [''];
    const truncation = details?.truncation?.truncated
      ? theme.fg('warning', formatOutputTruncationNotice(details.truncation))
      : undefined;
    return new ExecResultComponent(
      [
        ...leadingSeparator,
        ...prefix,
        ...rendered,
        ...(truncation ? [truncation] : []),
        ...(status ? ['', theme.fg('muted', status)] : []),
      ],
      false,
    );
  }

  const lines = expandedOutputLines(output, theme);
  if (details?.truncation?.truncated) lines.push(formatOutputTruncationNotice(details.truncation));
  const status = formatExecStatus(details, running, options.isPartial, hasOutput);
  if (status) lines.push(status);
  else if (details?.exit_code !== undefined) lines.push(`Exit code: ${details.exit_code}`);
  return new ExecResultComponent(
    lines.map((line) => theme.fg('dim', line)),
    true,
  );
}

export function renderWriteStdinCall(
  args: unknown,
  theme: RenderTheme,
  context?: RenderContext,
): Text {
  const record = asRecord(args);
  const sessionId = numberValue(record.session_id);
  const chars = stringValue(record.chars);
  const isEmptyPoll = !chars;
  const action = chars ? `send ${chars.length} char${chars.length === 1 ? '' : 's'}` : 'poll';
  const yieldLimit = formatYieldLimit(
    effectiveWriteYieldTime(numberValue(record.yield_time_ms), isEmptyPoll),
  );
  const base = `exec #${sessionId ?? '?'} ${action}`;
  const text = new Text(
    theme.fg('toolTitle', theme.bold(base)) + theme.fg('muted', ` (${yieldLimit})`),
    0,
    0,
  );
  if (context?.state) {
    context.state.writeStdinCallText = text;
    context.state.writeStdinCallBase = base;
  }
  return text;
}

export function renderApplyPatchCall(
  args: unknown,
  theme: RenderTheme,
  context?: RenderContext,
): Component {
  const record = asRecord(args);
  const patch =
    stringValue(record.input) ?? stringValue(record.patch) ?? stringValue(record.patchText) ?? '';
  try {
    const rows = parsePatchStreaming(patch).operations;
    if (rows.length > 0) {
      const component = new ApplyPatchCallComponent(rows, theme);
      if (context?.state) context.state.applyPatchCallComponent = component;
      return component;
    }
  } catch {
    // Fall back to a tiny summary for incomplete or malformed patch text.
  }
  return textCell('Applied patch', truncateOneLine(patch, 100), theme);
}

export function renderApplyPatchResult(
  result: ToolResult,
  options: RenderOptions,
  theme: RenderTheme,
  context?: RenderContext,
): Text | Container {
  const text = firstTextContent(result);
  const failed = /failed|partial/i.test(text);
  if (!failed && !options.expanded && !options.isPartial) {
    const tokenCount = formatTokenCount(numberValue(asRecord(result.details).original_token_count));
    const component = context?.state?.applyPatchCallComponent;
    if (component instanceof ApplyPatchCallComponent) {
      component.markApplied();
      if (tokenCount) component.setTokenCount(tokenCount);
    }
    return empty();
  }
  if (options.isPartial) return textCell('Patching', undefined, theme);
  return new Text(theme.fg(failed ? 'warning' : 'dim', truncateOneLine(text, 180)), 0, 0);
}

export function renderViewImageCall(args: unknown, theme: RenderTheme): Text {
  const record = asRecord(args);
  const imagePath =
    stringValue(record.path) ?? stringValue(record.file_path) ?? stringValue(record.image_path);
  return textCell('Viewed Image', imagePath, theme);
}

export function renderViewImageResult(
  result: ToolResult,
  options: RenderOptions,
  theme: RenderTheme,
): Text | Container {
  if (options.isPartial) return textCell('Loading image', undefined, theme);
  const images = result.content?.filter(isImageContent) ?? [];
  if (images.length === 0) return empty();

  const box = new Container();
  box.addChild(
    textCell('Image loaded', `${images.length} image${images.length === 1 ? '' : 's'}`, theme),
  );
  for (const image of images) {
    box.addChild(new Spacer(1));
    box.addChild(
      new Image(
        image.data,
        image.mimeType,
        { fallbackColor: (value) => theme.fg('dim', value) },
        { maxWidthCells: options.expanded ? 120 : 60 },
      ),
    );
  }
  return box;
}

export function renderComputerToolCall(piName: string, args: unknown, theme: RenderTheme): Text {
  const record = asRecord(args);
  const app = stringValue(record.app);
  const element = stringValue(record.element_index);
  const titleByTool: Record<string, string> = {
    computer_list_apps: 'Listed apps',
    computer_get_app_state: 'Inspected app',
    computer_click: 'Clicked',
    computer_drag: 'Dragged',
    computer_press_key: 'Pressed key',
    computer_type_text: 'Typed text',
    computer_scroll: 'Scrolled',
    computer_select_text: 'Selected text',
    computer_set_value: 'Set value',
    computer_perform_secondary_action: 'Performed secondary action',
  };
  const detailParts = [app, element ? `#${element}` : undefined];
  if (piName === 'computer_press_key') detailParts.push(stringValue(record.key));
  if (piName === 'computer_scroll') detailParts.push(stringValue(record.direction));
  if (piName === 'computer_click' && !element) {
    const x = numberValue(record.x);
    const y = numberValue(record.y);
    if (x !== undefined && y !== undefined) detailParts.push(`(${x}, ${y})`);
  }
  return textCell(titleByTool[piName] ?? piName, detailParts.filter(Boolean).join(' · '), theme);
}

export function renderComputerToolResult(
  result: ToolResult,
  options: RenderOptions,
  theme: RenderTheme,
): Text | Container {
  if (options.isPartial) return textCell('Computer Use', 'working', theme);
  const text = firstTextContent(result);
  if (!options.expanded)
    return text ? textCell('Computer Use result', truncateOneLine(text, 120), theme) : empty();
  return new Text(theme.fg('dim', text || '(no output)'), 0, 0);
}
