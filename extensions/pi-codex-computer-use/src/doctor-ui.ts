import type { Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth } from '@earendil-works/pi-tui';

import type { CodexComputerUseDoctorReport, DoctorFixableIssue } from './doctor';

export type DoctorViewAction = string;

interface DoctorActionItem {
  description: string;
  label: string;
  value: DoctorViewAction;
}

function formatDuration(seconds: number): string {
  if (seconds % 60 === 0) return `${seconds / 60}-minute`;
  return `${seconds}-second`;
}

function labelForIssue(issue: DoctorFixableIssue): string {
  if (issue.caffeinateSeconds !== undefined) {
    return `Start ${formatDuration(issue.caffeinateSeconds)} caffeinate guard`;
  }
  if (issue.id === 'screen-recording-missing') return 'Open Screen Recording settings';
  if (issue.id === 'accessibility-missing') return 'Open Accessibility settings';
  return issue.title;
}

function colorStatusLine(theme: Theme, line: string): string {
  if (line.startsWith('✓')) return theme.fg('success', line);
  if (line.startsWith('✗')) return theme.fg('error', line);
  if (line.startsWith('⚠')) return theme.fg('warning', line);
  if (line.startsWith('•')) return theme.fg('muted', line);
  if (line.endsWith(':')) return theme.fg('accent', theme.bold(line));
  return line;
}

export class DoctorReportView {
  private selectedIndex = 0;
  private readonly actions: DoctorActionItem[];

  constructor(
    private readonly report: CodexComputerUseDoctorReport,
    private readonly theme: Theme,
    private readonly done: (action: DoctorViewAction) => void,
  ) {
    this.actions = [
      { value: 'recheck', label: 'Re-check', description: 'Run the doctor checks again' },
      ...report.fixableIssues.map((issue) => ({
        value: issue.id,
        label: labelForIssue(issue),
        description: issue.instructions,
      })),
      { value: 'close', label: 'Close', description: 'Dismiss this doctor panel' },
    ];
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.done('close');
      return;
    }
    if (matchesKey(data, 'up')) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, 'down')) {
      this.selectedIndex = Math.min(this.actions.length - 1, this.selectedIndex + 1);
      return;
    }
    if (matchesKey(data, 'enter') || data === '\r' || data === '\n') {
      this.done(this.actions[this.selectedIndex]!.value);
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const contentWidth = Math.max(1, width);
    const lines: string[] = [];
    const reportLines = this.reportLines;

    lines.push(this.borderLine(contentWidth));
    lines.push(
      this.line(
        this.theme.fg('accent', this.theme.bold('Codex Computer Use Doctor')),
        contentWidth,
      ),
    );
    lines.push(this.line(this.theme.fg('dim', '↑↓ choose • enter run • esc close'), contentWidth));
    lines.push('');

    for (const rawLine of reportLines) {
      const styled = colorStatusLine(this.theme, rawLine);
      lines.push(this.line(styled, contentWidth));
    }

    lines.push('');
    lines.push(this.line(this.theme.fg('accent', this.theme.bold('Actions')), contentWidth));
    for (const [index, action] of this.actions.entries()) {
      const selected = index === this.selectedIndex;
      const prefix = selected ? this.theme.fg('accent', '› ') : '  ';
      const label = selected
        ? this.theme.fg('accent', this.theme.bold(action.label))
        : action.label;
      lines.push(this.line(`${prefix}${label}`, contentWidth));
      if (selected && action.description) {
        lines.push(this.line(this.theme.fg('muted', `  ${action.description}`), contentWidth));
      }
    }

    lines.push(this.borderLine(contentWidth));
    return lines;
  }

  private borderLine(width: number): string {
    return this.theme.fg('accent', '─'.repeat(width));
  }

  private line(content: string, width: number): string {
    return truncateToWidth(content, width, '…');
  }

  private get reportLines(): string[] {
    return this.report.text.split('\n').slice(2);
  }
}
