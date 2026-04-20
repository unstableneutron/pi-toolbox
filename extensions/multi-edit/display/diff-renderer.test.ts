import { describe, expect, test } from 'vitest';

import { renderEditDiffResult } from './diff-renderer';

function createTheme() {
  return {
    fg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
    getFgAnsi() {
      return '';
    },
    getBgAnsi() {
      return '';
    },
  };
}

const ANSI_SGR_PATTERN = new RegExp(String.raw`\\u001b\[[0-9;]*m`, 'g');

function stripAnsi(text: string): string {
  return text.replace(ANSI_SGR_PATTERN, '');
}

describe('display/diff-renderer', () => {
  test('counts File: headers as separate files in classic multi-file diffs', () => {
    const component = renderEditDiffResult(
      {
        diff: [
          'File: src/one.ts',
          '-1 oldOne();',
          '+1 newOne();',
          '',
          'File: src/two.ts',
          '-1 oldTwo();',
          '+1 newTwo();',
        ].join('\n'),
      },
      { expanded: true, filePath: 'src/one.ts' },
      {
        diffViewMode: 'unified',
        diffSplitMinWidth: 80,
        diffCollapsedLines: 24,
        diffWordWrap: true,
      } as any,
      createTheme(),
      '',
    );

    const lines = component.render(120).map(stripAnsi);

    expect(lines[0]).toContain('2 files');
  });
});
