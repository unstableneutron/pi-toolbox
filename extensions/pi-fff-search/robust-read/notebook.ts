import { basename } from 'node:path';
import { RobustReadError } from './errors';
import type { RobustReadConfig } from './types';

interface NotebookRenderResult {
  markdown: string;
  omissions: string[];
}

function stringSource(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value.join('');
  }
  throw new RobustReadError('malformed', `Malformed notebook: ${label} must be text.`);
}

function isProgressNoise(line: string): boolean {
  return (
    /^\s*\d{1,3}%\|[^|]*\|\s*\d+\/\d+\s*(?:\[[^\]]*\])?\s*$/u.test(line) ||
    /^\s*\[[=.#>\-\s]+\]\s*\d{1,3}%\s*$/u.test(line)
  );
}

export function stripTerminalNoise(input: string): string {
  let clean = '';
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code === 0x1b) {
      const next = input.charCodeAt(index + 1);
      if (next === 0x5b) {
        index += 2;
        while (index < input.length) {
          const final = input.charCodeAt(index);
          if (final >= 0x40 && final <= 0x7e) break;
          index += 1;
        }
        continue;
      }
      if (next === 0x5d) {
        index += 2;
        while (index < input.length) {
          if (input.charCodeAt(index) === 0x07 || input.charCodeAt(index) === 0x9c) break;
          if (input.charCodeAt(index) === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
      if (next >= 0x20 && next <= 0x2f) {
        index += 2;
        while (
          index < input.length &&
          input.charCodeAt(index) >= 0x20 &&
          input.charCodeAt(index) <= 0x2f
        ) {
          index += 1;
        }
      } else {
        index += 1;
      }
      continue;
    }
    if (code === 0x9b) {
      index += 1;
      while (index < input.length) {
        const final = input.charCodeAt(index);
        if (final >= 0x40 && final <= 0x7e) break;
        index += 1;
      }
      continue;
    }
    if (code === 0x07 || code === 0x9c) continue;
    clean += input[index];
  }

  return clean
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => {
      const frames = line.split('\r').filter((frame) => frame.length > 0);
      return frames.at(-1) ?? '';
    })
    .filter((line) => !isProgressNoise(line))
    .join('\n');
}

function fenceFor(source: string): string {
  let longest = 0;
  for (const match of source.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function notebookLanguage(notebook: Record<string, unknown>): string {
  const metadata = notebook.metadata;
  if (!metadata || typeof metadata !== 'object') return '';
  const record = metadata as Record<string, unknown>;
  const languageInfo = record.language_info;
  const kernelspec = record.kernelspec;
  const candidate =
    languageInfo && typeof languageInfo === 'object'
      ? (languageInfo as Record<string, unknown>).name
      : kernelspec && typeof kernelspec === 'object'
        ? (kernelspec as Record<string, unknown>).language
        : undefined;
  if (typeof candidate !== 'string') return '';
  return candidate.match(/[A-Za-z0-9_+.-]+/u)?.[0] ?? '';
}

function boundedOutputText(
  value: unknown,
  label: string,
  config: RobustReadConfig,
  omissions: string[],
  arraySeparator = '',
): string | null {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (Array.isArray(value)) {
    text = value.filter((entry) => typeof entry === 'string').join(arraySeparator);
  } else return null;

  if (Array.from(text).length > config.notebookOutputMaxCharacters) {
    omissions.push(`${label}: oversized textual output omitted`);
    return null;
  }
  return stripTerminalNoise(text);
}

function renderOutput(
  output: unknown,
  cellNumber: number,
  outputNumber: number,
  config: RobustReadConfig,
  omissions: string[],
): string | null {
  if (!output || typeof output !== 'object') return null;
  const record = output as Record<string, unknown>;
  const label = `cell ${cellNumber} output ${outputNumber}`;
  if (record.output_type === 'stream') {
    return boundedOutputText(record.text, label, config, omissions);
  }
  if (record.output_type === 'error') {
    const name = typeof record.ename === 'string' ? stripTerminalNoise(record.ename) : 'Error';
    const value = typeof record.evalue === 'string' ? stripTerminalNoise(record.evalue) : '';
    const traceback = boundedOutputText(record.traceback, label, config, omissions, '\n');
    const compactTrace = traceback?.split('\n').filter(Boolean).slice(-8).join('\n');
    return [`${name}${value ? `: ${value}` : ''}`, compactTrace].filter(Boolean).join('\n');
  }
  if (record.output_type !== 'display_data' && record.output_type !== 'execute_result') return null;

  const data = record.data;
  if (!data || typeof data !== 'object') return null;
  const mime = data as Record<string, unknown>;
  const omittedKinds = Object.keys(mime).filter(
    (kind) =>
      kind.startsWith('image/') ||
      kind.includes('jupyter.widget') ||
      kind === 'application/javascript' ||
      kind === 'text/html' ||
      kind === 'image/svg+xml',
  );
  if (omittedKinds.length > 0) omissions.push(`${label}: omitted ${omittedKinds.join(', ')}`);

  for (const kind of ['text/markdown', 'text/latex', 'text/plain']) {
    if (kind in mime) return boundedOutputText(mime[kind], label, config, omissions);
  }
  if (Object.keys(mime).length > 0 && omittedKinds.length === 0) {
    omissions.push(`${label}: unsupported payload omitted (${Object.keys(mime).join(', ')})`);
  }
  return null;
}

export function renderNotebook(
  bytes: Buffer,
  sourcePath: string,
  config: RobustReadConfig,
): NotebookRenderResult {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new RobustReadError('malformed', 'Malformed notebook: input is not valid UTF-8.', {
      cause: error,
      requestedPath: sourcePath,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.replace(/^\ufeff/u, ''));
  } catch (error) {
    throw new RobustReadError('malformed', 'Malformed notebook: invalid JSON.', {
      cause: error,
      requestedPath: sourcePath,
    });
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new RobustReadError('malformed', 'Malformed notebook: root must be an object.');
  }
  const notebook = parsed as Record<string, unknown>;
  if (!Number.isInteger(notebook.nbformat) || Number(notebook.nbformat) < 4) {
    throw new RobustReadError(
      'unsupported',
      'Unsupported notebook: nbformat 4 or newer is required.',
    );
  }
  if (!Array.isArray(notebook.cells)) {
    throw new RobustReadError('malformed', 'Malformed notebook: cells must be an array.');
  }

  const language = notebookLanguage(notebook);
  const omissions: string[] = [];
  const rendered: string[] = [`# Notebook: ${basename(sourcePath)}`];
  notebook.cells.forEach((cell, index) => {
    if (!cell || typeof cell !== 'object') {
      throw new RobustReadError(
        'malformed',
        `Malformed notebook: cell ${index + 1} is unreadable.`,
      );
    }
    const record = cell as Record<string, unknown>;
    const source = stringSource(record.source, `cell ${index + 1} source`);
    if (record.attachments && typeof record.attachments === 'object') {
      const count = Object.keys(record.attachments).length;
      if (count > 0) omissions.push(`cell ${index + 1}: ${count} Markdown attachment(s) omitted`);
    }

    if (record.cell_type === 'markdown') {
      rendered.push(source);
      return;
    }

    const fence = fenceFor(source);
    const execution = Number.isInteger(record.execution_count)
      ? ` [${String(record.execution_count)}]`
      : '';
    const cellType = typeof record.cell_type === 'string' ? record.cell_type : 'unknown';
    rendered.push(`## ${cellType === 'code' ? 'Code' : cellType} cell ${index + 1}${execution}`);
    rendered.push(`${fence}${cellType === 'code' ? language : 'text'}\n${source}\n${fence}`);

    if (Array.isArray(record.outputs)) {
      const outputs = record.outputs
        .map((output, outputIndex) =>
          renderOutput(output, index + 1, outputIndex + 1, config, omissions),
        )
        .filter((output): output is string => Boolean(output));
      if (outputs.length > 0) {
        rendered.push(
          `### Output\n\n${outputs
            .map((output) => {
              const outputFence = fenceFor(output);
              return `${outputFence}text\n${output}\n${outputFence}`;
            })
            .join('\n\n')}`,
        );
      }
    }
  });

  if (omissions.length > 0) {
    rendered.push(
      `## Omitted notebook content\n\n${omissions.map((entry) => `- ${entry}`).join('\n')}`,
    );
  }
  return { markdown: rendered.join('\n\n'), omissions };
}
