import {
  clampRenderedLineToWidth,
  clampRenderedLinesToWidth,
  normalizeWidth,
  type WidthMeasurementOps,
} from '../shared/tui-width';

export { clampRenderedLineToWidth, clampRenderedLinesToWidth, type WidthMeasurementOps };

interface CollapsedDiffHintOptions {
  remainingLines: number;
  hiddenHunks: number;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function buildCollapsedDiffHintText(
  options: CollapsedDiffHintOptions,
  width: number,
  ops: WidthMeasurementOps,
): string {
  const safeWidth = normalizeWidth(width);
  if (safeWidth === 0) {
    return '';
  }

  const remainingText = `${options.remainingLines} more ${pluralize(options.remainingLines, 'diff line')}`;
  const hiddenHunksText =
    options.hiddenHunks > 0
      ? `${options.hiddenHunks} more ${pluralize(options.hiddenHunks, 'hunk')}`
      : undefined;
  const shortRemainingText = `${options.remainingLines} more ${pluralize(options.remainingLines, 'line')}`;
  const shortHiddenHunksText =
    options.hiddenHunks > 0
      ? `${options.hiddenHunks} ${pluralize(options.hiddenHunks, 'hunk')}`
      : undefined;

  const candidates = [
    `… (${[remainingText, hiddenHunksText, 'Ctrl+O to expand'].filter(Boolean).join(' • ')})`,
    `… (${[remainingText, hiddenHunksText].filter(Boolean).join(' • ')})`,
    `… (${[shortRemainingText, shortHiddenHunksText].filter(Boolean).join(' • ')})`,
    options.hiddenHunks > 0
      ? `… (+${options.remainingLines} • +${options.hiddenHunks}h)`
      : `… (+${options.remainingLines})`,
    '…',
  ];

  for (const candidate of candidates) {
    if (ops.measure(candidate) <= safeWidth) {
      return candidate;
    }
  }

  return clampRenderedLineToWidth(candidates[candidates.length - 1] ?? '', safeWidth, ops);
}
