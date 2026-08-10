import { describe, expect, test } from 'vitest';
import { DEFAULT_ROBUST_READ_CONFIG } from './config';
import { renderNotebook, stripTerminalNoise } from './notebook';

function notebook(cells: unknown[], metadata: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ cells, metadata, nbformat: 4, nbformat_minor: 5 }), 'utf8');
}

describe('native notebook rendering', () => {
  test('renders Markdown/code, cleans terminal output, and reports omitted assets', () => {
    const rendered = renderNotebook(
      notebook(
        [
          {
            cell_type: 'markdown',
            source: ['# Analysis\n', 'Readable text'],
            attachments: { chart: { 'image/png': 'AAAA' } },
          },
          {
            cell_type: 'code',
            execution_count: 7,
            source: ['print("ok")'],
            outputs: [
              { output_type: 'stream', text: '\u001b[31m10%\r100%\u001b[0m\nfinished' },
              {
                output_type: 'display_data',
                data: {
                  'image/png': 'A'.repeat(100_000),
                  'application/vnd.jupyter.widget-view+json': { model_id: 'secret' },
                  'text/plain': '<Figure size 640x480>',
                },
              },
              {
                output_type: 'display_data',
                data: { 'text/plain': 'z'.repeat(20_000) },
              },
            ],
          },
        ],
        { language_info: { name: 'python\n```injection' } },
      ),
      'analysis.ipynb',
      { ...DEFAULT_ROBUST_READ_CONFIG, notebookOutputMaxCharacters: 1_000 },
    );

    expect(rendered.markdown).toContain('# Analysis');
    expect(rendered.markdown).toContain('```python');
    expect(rendered.markdown).toContain('Code cell 2 [7]');
    expect(rendered.markdown).toContain('100%\nfinished');
    expect(rendered.markdown).not.toContain('10%');
    expect(rendered.markdown).not.toContain('\u001b');
    expect(rendered.markdown).not.toContain('A'.repeat(100));
    expect(rendered.markdown).not.toContain('z'.repeat(100));
    expect(rendered.markdown).toContain('Omitted notebook content');
    expect(rendered.omissions.join('\n')).toContain('image/png');
    expect(rendered.omissions.join('\n')).toContain('widget');
    expect(rendered.omissions.join('\n')).toContain('oversized textual output omitted');
  });

  test('widens code fences around backticks in source', () => {
    const rendered = renderNotebook(
      notebook([{ cell_type: 'code', source: 'value = "````"', outputs: [] }]),
      'fences.ipynb',
      DEFAULT_ROBUST_READ_CONFIG,
    );
    expect(rendered.markdown).toContain('`````\n');
  });

  test('widens output fences around untrusted backticks', () => {
    const rendered = renderNotebook(
      notebook([
        {
          cell_type: 'code',
          source: 'display(value)',
          outputs: [{ output_type: 'display_data', data: { 'text/plain': '````' } }],
        },
      ]),
      'output-fences.ipynb',
      DEFAULT_ROBUST_READ_CONFIG,
    );
    expect(rendered.markdown).toContain('`````text\n````\n`````');
  });

  test('renders compact errors after stripping ANSI', () => {
    const rendered = renderNotebook(
      notebook([
        {
          cell_type: 'code',
          source: 'raise ValueError()',
          outputs: [
            {
              output_type: 'error',
              ename: 'ValueError',
              evalue: 'bad',
              traceback: Array.from(
                { length: 20 },
                (_, index) => `\u001b[31mframe ${index}\u001b[0m`,
              ),
            },
          ],
        },
      ]),
      'error.ipynb',
      DEFAULT_ROBUST_READ_CONFIG,
    );
    expect(rendered.markdown).toContain('ValueError: bad');
    expect(rendered.markdown).not.toContain('frame 0');
    expect(rendered.markdown).toContain('frame 19');
    expect(rendered.markdown).not.toContain('\u001b');
  });

  test('rejects malformed JSON, legacy notebooks, invalid cells, and invalid UTF-8', () => {
    expect(() => renderNotebook(Buffer.from('{'), 'bad.ipynb', DEFAULT_ROBUST_READ_CONFIG)).toThrow(
      'invalid JSON',
    );
    expect(() =>
      renderNotebook(
        Buffer.from(JSON.stringify({ cells: [], metadata: {}, nbformat: 3 })),
        'old.ipynb',
        DEFAULT_ROBUST_READ_CONFIG,
      ),
    ).toThrow('nbformat 4');
    expect(() =>
      renderNotebook(
        notebook([{ cell_type: 'code', source: ['ok', { nope: true }] }]),
        'cell.ipynb',
        DEFAULT_ROBUST_READ_CONFIG,
      ),
    ).toThrow('must be text');
    expect(() =>
      renderNotebook(Buffer.from([0xff, 0xfe, 0xfd]), 'binary.ipynb', DEFAULT_ROBUST_READ_CONFIG),
    ).toThrow('not valid UTF-8');
  });

  test('strips CSI, OSC, bell, and carriage-return progress noise', () => {
    expect(stripTerminalNoise('\u001b]0;title\u0007\u001b[32m25%\r100%\u001b[0m\u0007')).toBe(
      '100%',
    );
    expect(stripTerminalNoise('100%|██████████| 10/10 [00:01<00:00]\nfinished')).toBe('finished');
    expect(stripTerminalNoise('[======>] 75%\nfinished')).toBe('finished');
  });
});
