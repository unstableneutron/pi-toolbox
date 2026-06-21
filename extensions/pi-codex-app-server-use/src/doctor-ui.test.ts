import { describe, expect, test, vi } from 'vitest';

import type { CodexComputerUseDoctorReport } from './doctor';
import { DoctorReportView } from './doctor-ui';

const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

const report: CodexComputerUseDoctorReport = {
  hasFixableIssues: true,
  text: [
    'Codex Computer Use doctor',
    '',
    'Permissions:',
    '✓ Screen Recording granted for Codex Computer Use.app',
    '✗ Display appears asleep or not capture-ready',
  ].join('\n'),
  fixableIssues: [
    {
      caffeinateSeconds: 600,
      id: 'display-asleep',
      instructions: 'Start caffeinate.',
      title: 'Display appears asleep or not capture-ready',
    },
  ],
};

describe('DoctorReportView', () => {
  test('renders the report, re-check action, fix actions, and close action', () => {
    const view = new DoctorReportView(report, theme as any, vi.fn());

    const text = view.render(90).join('\n');

    expect(text).toContain('Codex Computer Use Doctor');
    expect(text).toContain('Screen Recording granted');
    expect(text).toContain('Display appears asleep');
    expect(text).toContain('Re-check');
    expect(text).toContain('Start 10-minute caffeinate guard');
    expect(text).toContain('Close');
  });

  test('uses a simple list layout without boxed borders', () => {
    const view = new DoctorReportView(report, theme as any, vi.fn());

    const text = view.render(90).join('\n');

    expect(text).not.toContain('╭');
    expect(text).not.toContain('╰');
    expect(text).not.toContain('│');
    expect(text).not.toContain('├');
  });

  test('renders simple horizontal top and bottom borders', () => {
    const view = new DoctorReportView(report, theme as any, vi.fn());

    const lines = view.render(30);

    expect(lines[0]).toBe('─'.repeat(30));
    expect(lines.at(-1)).toBe('─'.repeat(30));
  });

  test('uses the full available terminal width', () => {
    const wideReport: CodexComputerUseDoctorReport = {
      hasFixableIssues: false,
      text: ['Codex Computer Use doctor', '', `✓ ${'wide '.repeat(24)}end`].join('\n'),
      fixableIssues: [],
    };
    const view = new DoctorReportView(wideReport, theme as any, vi.fn());

    const text = view.render(140).join('\n');

    expect(view.render(140)[0]).toBe('─'.repeat(140));
    expect(text).toContain('end');
  });

  test('returns recheck by default when enter is pressed', () => {
    const done = vi.fn();
    const view = new DoctorReportView(report, theme as any, done);

    view.handleInput('\r');

    expect(done).toHaveBeenCalledWith('recheck');
  });

  test('selects the fix action after moving down once', () => {
    const done = vi.fn();
    const view = new DoctorReportView(report, theme as any, done);

    view.handleInput('\x1b[B');
    view.handleInput('\r');

    expect(done).toHaveBeenCalledWith('display-asleep');
  });

  test('renders all report lines without internal scrolling', () => {
    const longReport: CodexComputerUseDoctorReport = {
      hasFixableIssues: false,
      text: [
        'Codex Computer Use doctor',
        '',
        ...Array.from({ length: 30 }, (_value, index) => `Report line ${index}`),
      ].join('\n'),
      fixableIssues: [],
    };
    const view = new DoctorReportView(longReport, theme as any, vi.fn());

    expect(view.render(90).join('\n')).toContain('Report line 0');
    expect(view.render(90).join('\n')).toContain('Report line 8');
    expect(view.render(90).join('\n')).toContain('Report line 29');

    view.handleInput('\x1b[6~');

    expect(view.render(90).join('\n')).toContain('Report line 0');
    expect(view.render(90).join('\n')).toContain('Report line 29');

    view.handleInput('\x1b[5~');

    expect(view.render(90).join('\n')).toContain('Report line 0');
    expect(view.render(90).join('\n')).toContain('Report line 29');
  });
});
