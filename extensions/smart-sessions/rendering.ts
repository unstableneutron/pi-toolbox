import { wrapTextWithAnsi } from '@mariozechner/pi-tui';

import type { RollingSessionSummary } from './contracts';

export function formatRollingSummaryMarkdown(summary: RollingSessionSummary): string {
  const summaryLines = summary.summaryBullets.map((line) => `- ${line}`).join('\n');
  const timelineLines = summary.timelineItems.map((line) => `- ${line}`).join('\n');

  return [
    `# Session Summary: ${summary.longTitle}`,
    '',
    '## Summary',
    summaryLines,
    '',
    '## Timeline',
    timelineLines,
  ].join('\n');
}

export function formatInlineRollingSummary(
  summary: RollingSessionSummary,
  width: number,
): string[] {
  const separator = '─'.repeat(Math.max(1, width));
  const contentWidth = Math.max(10, width);
  const titleLines = wrapTextWithAnsi(`# Session Summary: ${summary.longTitle}`, contentWidth);
  const summaryLines = wrapTextWithAnsi(summary.shortSummary, contentWidth);
  const hintLines = wrapTextWithAnsi('Run /summarize for full details', contentWidth);

  return [separator, ...titleLines, ...summaryLines, ...hintLines, separator];
}
