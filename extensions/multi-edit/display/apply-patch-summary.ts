import type { Component } from '@mariozechner/pi-tui';
import { truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';

import type { PatchPreviewRow } from '../patch';
import { shortenDisplayPath } from '../render-utils';

interface SummaryTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

function formatCompactBytes(value: number): string {
  if (value < 1024) {
    return `${value}B`;
  }
  if (value < 1024 * 1024) {
    return `${Math.round(value / 1024)}K`;
  }
  const megabytes = (value / (1024 * 1024)).toFixed(1);
  return `${megabytes.replace(/\.0$/, '')}M`;
}

function formatStateIcon(row: PatchPreviewRow, theme: SummaryTheme): string {
  if (row.state === 'applied') return theme.fg('success', '✓');
  if (row.state === 'staging') return theme.fg('warning', '◌');
  if (row.state === 'staged') return theme.fg('success', '◆');
  if (row.state === 'invalidated') return theme.fg('muted', '◇');
  if (row.state === 'committing') return theme.fg('warning', '▶');
  if (row.state === 'applying') return theme.fg('accent', '▶');
  if (row.state === 'failed') return theme.fg('error', '✗');
  return theme.fg('muted', '○');
}

function formatStateSuffix(row: PatchPreviewRow, theme: SummaryTheme): string {
  if (row.state === 'invalidated') {
    return theme.fg('muted', 'restaging');
  }
  return '';
}

function formatAction(row: PatchPreviewRow): string {
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

// Shown while a streaming op row exists but the path hasn't been
// typed yet. Keeps the row anchored so the user sees structure even
// before the model commits to a filename.
const STREAMING_PATH_PLACEHOLDER = '…';

function formatPath(row: PatchPreviewRow, cwd?: string): string {
  if (row.kind === 'move') {
    const source = shortenDisplayPath(row.path, cwd) || STREAMING_PATH_PLACEHOLDER;
    const target = shortenDisplayPath(row.targetPath, cwd) || STREAMING_PATH_PLACEHOLDER;
    return `${source} → ${target}`;
  }
  return shortenDisplayPath(row.path, cwd) || STREAMING_PATH_PLACEHOLDER;
}

function takeSuffixToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }
  if (visibleWidth(text) <= maxWidth) {
    return text;
  }

  const chars = Array.from(text);
  let suffix = '';
  for (let index = chars.length - 1; index >= 0; index--) {
    const next = `${chars[index]}${suffix}`;
    if (visibleWidth(next) > maxWidth) {
      break;
    }
    suffix = next;
  }
  return suffix;
}

function takePrefixToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }
  if (visibleWidth(text) <= maxWidth) {
    return text;
  }

  const chars = Array.from(text);
  let prefix = '';
  for (const char of chars) {
    const next = `${prefix}${char}`;
    if (visibleWidth(next) > maxWidth) {
      break;
    }
    prefix = next;
  }
  return prefix;
}

function truncateMiddleToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }
  if (visibleWidth(text) <= maxWidth) {
    return text;
  }
  if (maxWidth <= 3) {
    return '.'.repeat(maxWidth);
  }

  const ellipsis = '...';
  const remainingWidth = maxWidth - visibleWidth(ellipsis);
  const suffixWidth = Math.max(1, Math.floor(remainingWidth / 2));
  const prefixWidth = Math.max(1, remainingWidth - suffixWidth);
  let prefix = takePrefixToWidth(text, prefixWidth);
  let suffix = takeSuffixToWidth(text, suffixWidth);

  while (visibleWidth(`${prefix}${ellipsis}${suffix}`) > maxWidth && suffix.length > 0) {
    suffix = takeSuffixToWidth(suffix, Math.max(0, visibleWidth(suffix) - 1));
  }
  while (visibleWidth(`${prefix}${ellipsis}${suffix}`) > maxWidth && prefix.length > 0) {
    prefix = takePrefixToWidth(prefix, Math.max(0, visibleWidth(prefix) - 1));
  }

  return `${prefix}${ellipsis}${suffix}`;
}

function formatRowMetric(row: PatchPreviewRow): string {
  if (row.kind === 'delete') {
    if (row.contentKind === 'binary' && row.byteLength !== undefined) {
      return `binary · ${formatCompactBytes(row.byteLength)}`;
    }
    if (row.contentKind === 'text' && row.byteLength !== undefined && row.lineCount !== undefined) {
      return `text · ${row.lineCount}L · ${formatCompactBytes(row.byteLength)}`;
    }
    return 'meta';
  }

  if (row.kind === 'move' && row.renameOnly) {
    return 'rename';
  }

  if (row.removedLines === 0) {
    return `+${row.addedLines}L · ${formatCompactBytes(row.modifiedBytes)}`;
  }

  return `+${row.addedLines}/-${row.removedLines}L · ${formatCompactBytes(row.modifiedBytes)}`;
}

function renderOperationRow(
  row: PatchPreviewRow,
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
  const path = theme.fg('accent', truncateMiddleToWidth(formatPath(row, cwd), availablePathWidth));
  const combined = `${actionPrefix}${path}  ${renderedSuffix}`;
  if (width <= 0 || visibleWidth(combined) <= width) {
    return [combined];
  }
  return [
    truncateToWidth(`${actionPrefix}${theme.fg('accent', formatPath(row, cwd))}`, width, '…'),
    truncateToWidth(renderedSuffix, width, '…'),
  ];
}

function renderRows(
  rows: PatchPreviewRow[],
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
    const minPathWidth = 8;
    const maxPathWidth = Math.max(
      minPathWidth,
      width - visibleWidth(prefix) - visibleWidth(metric) - 2,
    );

    let availablePathWidth = maxPathWidth;
    let line = '';
    while (availablePathWidth >= minPathWidth) {
      const path = theme.fg(
        'accent',
        truncateMiddleToWidth(formatPath(row, cwd), availablePathWidth),
      );
      line = `${prefix}${path}  ${metric}`;
      if (width <= 0 || visibleWidth(line) <= width) {
        break;
      }
      availablePathWidth--;
    }

    lines.push(line);
  }

  return lines;
}

class ApplyPatchSummaryComponent implements Component {
  constructor(
    private rows: PatchPreviewRow[],
    private theme: SummaryTheme,
    private includeHeader: boolean,
    private cwd: string | undefined,
  ) {}

  render(width: number): string[] {
    if (this.rows.length === 1) {
      return renderOperationRow(this.rows[0]!, this.theme, width, !this.includeHeader, this.cwd);
    }
    return renderRows(this.rows, this.theme, width, this.includeHeader, this.cwd);
  }

  invalidate(): void {}
}

export function renderApplyPatchSummary(
  rows: PatchPreviewRow[],
  theme: SummaryTheme,
  cwd?: string,
): Component {
  return new ApplyPatchSummaryComponent(rows, theme, true, cwd);
}

export function renderApplyPatchRows(
  rows: PatchPreviewRow[],
  theme: SummaryTheme,
  cwd?: string,
): Component {
  return new ApplyPatchSummaryComponent(rows, theme, false, cwd);
}
