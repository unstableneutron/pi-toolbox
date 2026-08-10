import type { FileHandle } from 'node:fs/promises';
import { RobustReadError } from './errors';
import type { PaginatedText, RobustReadConfig } from './types';

interface SelectedLine {
  number: number;
  text: string;
  clamped: boolean;
}

interface CollectorResult {
  lines: SelectedLine[];
  totalLines?: number;
  hasMore: boolean;
  nextOffset?: number;
  truncatedBy?: 'lines' | 'bytes';
}

class LineCollector {
  private readonly offset: number;
  private readonly limit: number;
  private readonly config: RobustReadConfig;
  private readonly lines: SelectedLine[] = [];
  private lineNumber = 1;
  private lineText = '';
  private lineCharacters = 0;
  private lineClamped = false;
  private lineHasContent = false;
  private selectedBytes = 0;
  private pageLineLimitReached = false;
  private stopped = false;
  private hasMore = false;
  private nextOffset?: number;
  private truncatedBy?: 'lines' | 'bytes';

  constructor(offset: number, limit: number, config: RobustReadConfig) {
    this.offset = offset;
    this.limit = Math.min(limit, config.maxLines);
    this.config = config;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  feed(text: string): void {
    for (const character of text) {
      if (this.stopped) return;
      if (this.pageLineLimitReached) {
        this.hasMore = true;
        this.nextOffset = this.lineNumber;
        this.truncatedBy = 'lines';
        this.stopped = true;
        return;
      }

      if (character === '\n') {
        this.finishLine();
        continue;
      }

      this.lineHasContent = true;
      this.lineCharacters += 1;
      if (this.lineCharacters <= this.config.maxLineCharacters) {
        this.lineText += character;
      } else {
        this.lineClamped = true;
      }
    }
  }

  finish(): CollectorResult {
    if (!this.stopped && this.lineHasContent) this.finishLine();
    return {
      lines: this.lines,
      totalLines: this.stopped ? undefined : this.lineNumber - 1,
      hasMore: this.hasMore,
      nextOffset: this.nextOffset,
      truncatedBy: this.truncatedBy,
    };
  }

  private finishLine(): void {
    let output = this.lineText.endsWith('\r') ? this.lineText.slice(0, -1) : this.lineText;
    if (this.lineClamped) {
      const marker = `… [clamped at ${this.config.maxLineCharacters.toLocaleString('en-US')} characters]`;
      const prefixCharacters = Math.max(
        0,
        this.config.maxLineCharacters - Array.from(marker).length,
      );
      output = Array.from(output).slice(0, prefixCharacters).join('') + marker;
    }

    if (this.lineNumber >= this.offset) {
      const separatorBytes = this.lines.length === 0 ? 0 : 1;
      const outputBytes = Buffer.byteLength(output, 'utf8') + separatorBytes;
      if (
        this.lines.length > 0 &&
        this.selectedBytes + outputBytes > this.config.maxResponseBytes
      ) {
        this.hasMore = true;
        this.nextOffset = this.lineNumber;
        this.truncatedBy = 'bytes';
        this.stopped = true;
        return;
      }

      this.lines.push({ number: this.lineNumber, text: output, clamped: this.lineClamped });
      this.selectedBytes += outputBytes;
      if (this.lines.length >= this.limit) this.pageLineLimitReached = true;
    }

    this.lineNumber += 1;
    this.lineText = '';
    this.lineCharacters = 0;
    this.lineClamped = false;
    this.lineHasContent = false;
  }
}

function validatePagination(
  offset: number | undefined,
  limit: number | undefined,
): {
  offset: number;
  limit: number;
} {
  const resolvedOffset = offset ?? 1;
  const resolvedLimit = limit ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(resolvedOffset) || resolvedOffset < 1) {
    throw new Error('offset must be a positive 1-indexed integer');
  }
  if (!Number.isSafeInteger(resolvedLimit) || resolvedLimit < 1) {
    throw new Error('limit must be a positive integer');
  }
  return { offset: resolvedOffset, limit: resolvedLimit };
}

function responseNotices(
  result: CollectorResult,
  offset: number,
  invalidUtf8: boolean,
  maxLineCharacters: number,
): string[] {
  const notices: string[] = [];
  const clampedLines = result.lines.filter((line) => line.clamped).map((line) => line.number);
  if (invalidUtf8) notices.push('[Invalid UTF-8 bytes were replaced with U+FFFD.]');
  if (clampedLines.length > 0) {
    notices.push(
      `[Clamped ${clampedLines.length === 1 ? 'line' : 'lines'} ${clampedLines.join(', ')} to ${maxLineCharacters.toLocaleString('en-US')} characters.]`,
    );
  }
  if (result.hasMore && result.nextOffset !== undefined) {
    const first = result.lines[0]?.number ?? offset;
    const last = result.lines.at(-1)?.number;
    const range = last === undefined ? `No lines fit` : `Showing lines ${first}-${last}`;
    notices.push(`${range}. Use offset=${result.nextOffset} to continue.`);
  }
  return notices;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function formatResult(
  collected: CollectorResult,
  offset: number,
  invalidUtf8: boolean,
  config: RobustReadConfig,
  sourceBytesRead?: number,
): PaginatedText {
  const mutable: CollectorResult = { ...collected, lines: [...collected.lines] };

  const build = (): string => {
    const body = mutable.lines.map((line) => line.text).join('\n');
    let notices = responseNotices(mutable, offset, invalidUtf8, config.maxLineCharacters);
    if (mutable.lines.length === 0 && mutable.totalLines === 0) {
      notices = ['[File is empty.]', ...notices];
    } else if (mutable.lines.length === 0 && mutable.totalLines !== undefined) {
      const relation = offset === mutable.totalLines + 1 ? 'at' : 'beyond';
      notices = [
        `[Offset ${offset} is ${relation} end of file (${mutable.totalLines} lines). No content returned.]`,
        ...notices,
      ];
    } else if (!body) {
      const first = mutable.lines[0]?.number ?? offset;
      const last = mutable.lines.at(-1)?.number ?? first;
      notices = [
        first === last ? `[Line ${first} is empty.]` : `[Lines ${first}-${last} are empty.]`,
        ...notices,
      ];
    }
    return body && notices.length > 0
      ? `${body}\n\n${notices.join('\n')}`
      : body || notices.join('\n');
  };

  let text = build();
  while (Buffer.byteLength(text, 'utf8') > config.maxResponseBytes && mutable.lines.length > 1) {
    const removed = mutable.lines.pop();
    if (!removed) break;
    mutable.hasMore = true;
    mutable.nextOffset = removed.number;
    mutable.truncatedBy = 'bytes';
    text = build();
  }

  if (Buffer.byteLength(text, 'utf8') > config.maxResponseBytes && mutable.lines.length === 1) {
    const line = mutable.lines[0];
    const marker = '… [response-byte limit]';
    line.text =
      truncateUtf8(line.text, Math.max(0, config.maxResponseBytes - marker.length - 192)) + marker;
    line.clamped = true;
    mutable.hasMore = true;
    mutable.nextOffset = line.number + 1;
    mutable.truncatedBy = 'bytes';
    text = build();
  }

  if (Buffer.byteLength(text, 'utf8') > config.maxResponseBytes) {
    text = truncateUtf8(text, config.maxResponseBytes);
  }

  return {
    text,
    startLine: mutable.lines[0]?.number ?? offset,
    endLine: mutable.lines.at(-1)?.number,
    nextOffset: mutable.nextOffset,
    totalLines: mutable.totalLines,
    hasMore: mutable.hasMore,
    truncatedBy: mutable.truncatedBy,
    clampedLines: mutable.lines.filter((line) => line.clamped).map((line) => line.number),
    invalidUtf8,
    responseBytes: Buffer.byteLength(text, 'utf8'),
    sourceBytesRead,
  };
}

export async function paginateUtf8File(
  handle: FileHandle,
  options: { offset?: number; limit?: number; signal?: AbortSignal },
  config: RobustReadConfig,
): Promise<PaginatedText> {
  const pagination = validatePagination(options.offset, options.limit);
  const collector = new LineCollector(pagination.offset, pagination.limit, config);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let validator: TextDecoder | null = new TextDecoder('utf-8', { fatal: true });
  let invalidUtf8 = false;
  let position = 0;
  const buffer = Buffer.allocUnsafe(config.streamChunkBytes);

  while (!collector.isStopped) {
    if (options.signal?.aborted) throw new RobustReadError('aborted', 'Operation aborted');
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    const bytes = buffer.subarray(0, bytesRead);
    if (validator) {
      try {
        validator.decode(bytes, { stream: true });
      } catch {
        invalidUtf8 = true;
        validator = null;
      }
    }
    collector.feed(decoder.decode(bytes, { stream: true }));
  }

  if (!collector.isStopped) {
    collector.feed(decoder.decode());
    if (validator) {
      try {
        validator.decode();
      } catch {
        invalidUtf8 = true;
      }
    }
  }

  return formatResult(collector.finish(), pagination.offset, invalidUtf8, config, position);
}

export function paginateString(
  text: string,
  options: { offset?: number; limit?: number },
  config: RobustReadConfig,
): PaginatedText {
  const pagination = validatePagination(options.offset, options.limit);
  const collector = new LineCollector(pagination.offset, pagination.limit, config);
  const chunkCharacters = Math.max(256, Math.floor(config.streamChunkBytes / 2));
  for (let index = 0; index < text.length && !collector.isStopped; index += chunkCharacters) {
    collector.feed(text.slice(index, index + chunkCharacters));
  }
  return formatResult(collector.finish(), pagination.offset, false, config);
}
