import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

import { shortenDisplayPath, truncateDisplayPath, truncateMiddleToWidth } from './paths';
import { WidthRenderCache } from './width-render-cache';

export type PatchSummaryRow =
  | {
      id?: string;
      kind: 'edit' | 'create';
      path: string;
      addedLines: number;
      removedLines: number;
      modifiedBytes: number;
      renameOnly: false;
      state: PatchSummaryRowState;
    }
  | {
      id?: string;
      kind: 'move';
      path: string;
      targetPath: string;
      addedLines: number;
      removedLines: number;
      modifiedBytes: number;
      renameOnly: boolean;
      state: PatchSummaryRowState;
    }
  | {
      id?: string;
      kind: 'delete';
      path: string;
      state: PatchSummaryRowState;
      contentKind?: 'text' | 'binary';
      byteLength?: number;
      lineCount?: number;
    };

export type PatchSummaryRowState =
  | 'streaming'
  | 'streamed'
  | 'staging'
  | 'staged'
  | 'invalidated'
  | 'committing'
  | 'applying'
  | 'applied'
  | 'failed'
  | 'skipped';

interface SummaryTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

function formatCompactBytes(value: number): string {
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)}K`;
  const megabytes = (value / (1024 * 1024)).toFixed(1);
  return `${megabytes.replace(/\.0$/, '')}M`;
}

function formatStateIcon(row: PatchSummaryRow, theme: SummaryTheme): string {
  if (row.state === 'applied') return theme.fg('success', '✓');
  if (row.state === 'staging') return theme.fg('warning', '◌');
  if (row.state === 'staged') return theme.fg('success', '◆');
  if (row.state === 'invalidated') return theme.fg('muted', '◇');
  if (row.state === 'skipped') return theme.fg('muted', '⊘');
  if (row.state === 'committing') return theme.fg('warning', '▶');
  if (row.state === 'applying') return theme.fg('accent', '▶');
  if (row.state === 'failed') return theme.fg('error', '✗');
  return theme.fg('muted', '○');
}

function formatStateSuffix(row: PatchSummaryRow, theme: SummaryTheme): string {
  if (row.state === 'invalidated') return theme.fg('muted', 'restaging');
  if (row.state === 'skipped') return theme.fg('muted', 'skipped');
  return '';
}

function formatAction(row: PatchSummaryRow): string {
  switch (row.kind) {
    case 'create':
      return 'create';
    case 'delete':
      return 'delete';
    case 'move':
      return 'move';
    default:
      return 'edit';
  }
}

const STREAMING_PATH_PLACEHOLDER = '…';

function formatPath(row: PatchSummaryRow, cwd?: string): string {
  if (row.kind === 'move') {
    const source = shortenDisplayPath(row.path, cwd) || STREAMING_PATH_PLACEHOLDER;
    const target = shortenDisplayPath(row.targetPath, cwd) || STREAMING_PATH_PLACEHOLDER;
    return `${source} → ${target}`;
  }
  return shortenDisplayPath(row.path, cwd) || STREAMING_PATH_PLACEHOLDER;
}

function formatRowMetric(row: PatchSummaryRow): string {
  if (row.kind === 'delete') {
    if (row.contentKind === 'binary' && row.byteLength !== undefined) {
      return `binary · ${formatCompactBytes(row.byteLength)}`;
    }
    if (row.contentKind === 'text' && row.byteLength !== undefined && row.lineCount !== undefined) {
      return `text · ${row.lineCount}L · ${formatCompactBytes(row.byteLength)}`;
    }
    return 'meta';
  }

  if (row.kind === 'move' && row.renameOnly) return 'rename';
  if (row.removedLines === 0)
    return `+${row.addedLines}L · ${formatCompactBytes(row.modifiedBytes)}`;
  return `+${row.addedLines}/-${row.removedLines}L · ${formatCompactBytes(row.modifiedBytes)}`;
}

function formatPathToWidth(row: PatchSummaryRow, width: number, cwd?: string): string {
  if (row.kind === 'move') return truncateMiddleToWidth(formatPath(row, cwd), width);
  const path = formatPath(row, cwd);
  if (path === STREAMING_PATH_PLACEHOLDER) return path;
  return truncateDisplayPath(row.path, width, cwd);
}

function renderOperationRow(
  row: PatchSummaryRow,
  theme: SummaryTheme,
  width: number,
  rowsOnly: boolean,
  cwd?: string,
): string[] {
  const actionLabel = formatAction(row).padEnd(6, ' ');
  const actionPrefix = rowsOnly
    ? `${formatStateIcon(row, theme)} ${theme.fg('text', actionLabel)} `
    : theme.fg('toolTitle', theme.bold(`apply_patch: ${formatAction(row)} `));
  const metric = theme.fg('muted', formatRowMetric(row));
  const statusSuffix = formatStateSuffix(row, theme);
  const metricWithStatus = statusSuffix ? `${metric} · ${statusSuffix}` : metric;
  const suffix = `${formatStateIcon(row, theme)} ${metricWithStatus}`;
  const renderedSuffix = rowsOnly ? metricWithStatus : suffix;
  const availablePathWidth = Math.max(
    1,
    width - visibleWidth(actionPrefix) - visibleWidth(renderedSuffix) - 2,
  );
  const path = theme.fg('accent', formatPathToWidth(row, availablePathWidth, cwd));
  const combined = `${actionPrefix}${path}  ${renderedSuffix}`;
  if (width <= 0 || visibleWidth(combined) <= width) return [combined];
  return [
    truncateToWidth(`${actionPrefix}${theme.fg('accent', formatPath(row, cwd))}`, width, '…'),
    truncateToWidth(renderedSuffix, width, '…'),
  ];
}

function renderRows(
  rows: PatchSummaryRow[],
  theme: SummaryTheme,
  width: number,
  includeHeader: boolean,
  cwd?: string,
): string[] {
  const lines: string[] = [];

  if (includeHeader) {
    lines.push(theme.fg('toolTitle', theme.bold(`apply_patch: ${rows.length} operations`)));
  }

  for (const row of rows) {
    const icon = formatStateIcon(row, theme);
    const action = formatAction(row).padEnd(6, ' ');
    const metricBase = theme.fg('muted', formatRowMetric(row));
    const statusSuffix = formatStateSuffix(row, theme);
    const metric = statusSuffix ? `${metricBase} · ${statusSuffix}` : metricBase;
    const prefix = `${icon} ${theme.fg('text', action)} `;
    const availablePathWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(metric) - 2);
    const path = theme.fg('accent', formatPathToWidth(row, availablePathWidth, cwd));
    const line = `${prefix}${path}  ${metric}`;

    lines.push(
      width <= 0 || visibleWidth(line) <= width ? line : truncateToWidth(line, width, '…'),
    );
  }

  return lines;
}

function renderApplyPatchSummaryAtWidth(
  rows: PatchSummaryRow[],
  theme: SummaryTheme,
  width: number,
  includeHeader: boolean,
  cwd?: string,
): string[] {
  return rows.length === 1
    ? renderOperationRow(rows[0]!, theme, width, !includeHeader, cwd)
    : renderRows(rows, theme, width, includeHeader, cwd);
}

export function renderApplyPatchRowsAtWidth(
  rows: PatchSummaryRow[],
  theme: SummaryTheme,
  width: number,
  cwd?: string,
): string[] {
  return renderApplyPatchSummaryAtWidth(rows, theme, width, false, cwd);
}

class ApplyPatchSummaryComponent implements Component {
  private readonly cache = new WidthRenderCache();

  constructor(
    private rows: PatchSummaryRow[],
    private theme: SummaryTheme,
    private includeHeader: boolean,
    private cwd: string | undefined,
  ) {}

  render(width: number): string[] {
    return this.cache.render(width, () =>
      renderApplyPatchSummaryAtWidth(this.rows, this.theme, width, this.includeHeader, this.cwd),
    );
  }

  invalidate(): void {
    this.cache.clear();
  }
}

export function renderApplyPatchSummary(
  rows: PatchSummaryRow[],
  theme: SummaryTheme,
  cwd?: string,
): Component {
  return new ApplyPatchSummaryComponent(rows, theme, true, cwd);
}

export function renderApplyPatchRows(
  rows: PatchSummaryRow[],
  theme: SummaryTheme,
  cwd?: string,
): Component {
  return new ApplyPatchSummaryComponent(rows, theme, false, cwd);
}
