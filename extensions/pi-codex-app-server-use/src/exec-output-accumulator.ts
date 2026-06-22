import { randomBytes } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_MAX_LINES,
  truncateTail,
  type TruncationResult,
} from '@earendil-works/pi-coding-agent';

export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;

export interface ExecOutputSnapshot {
  output: string;
  original_token_count?: number | undefined;
  truncation?: TruncationResult | undefined;
  full_output_path?: string | undefined;
}

export interface ExecOutputAccumulatorOptions {
  fileStem?: string | undefined;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function maxBytesForOutputTokens(maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS): number {
  return Math.max(256, maxOutputTokens * 4);
}

function sanitizeFileStem(value: string | undefined): string {
  const sanitized = (value ?? 'output')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return sanitized || 'output';
}

function defaultTempFilePath(fileStem: string | undefined): string {
  return path.join(
    friendlyTempDir(),
    `${sanitizeFileStem(fileStem)}-${randomBytes(4).toString('hex')}.log`,
  );
}

function friendlyTempDir(): string {
  const baseDir = process.platform === 'darwin' && existsSync('/tmp') ? '/tmp' : tmpdir();
  const dir = path.join(baseDir, 'pi-codex-app-server-use');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best effort: an existing directory may not be chmod-able on every platform.
  }
  return dir;
}

export class ExecOutputAccumulator {
  private readonly maxRollingBytes = Math.max(maxBytesForOutputTokens() * 2, 1);
  private readonly fileStem: string | undefined;
  private rawChunks: string[] = [];
  private tailText = '';
  private tailBytes = 0;
  private tailStartChars = 0;
  private totalChars = 0;
  private totalBytes = 0;
  private completedLines = 0;
  private hasOpenLine = false;
  private tempFilePath: string | undefined;
  private tempFileStream: WriteStream | undefined;

  constructor(options: ExecOutputAccumulatorOptions = {}) {
    this.fileStem = options.fileStem;
  }

  append(text: string): void {
    if (!text) return;
    this.totalChars += text.length;
    this.totalBytes += byteLength(text);
    this.appendLineStats(text);
    this.tailText += text;
    this.tailBytes += byteLength(text);
    if (this.tailBytes > this.maxRollingBytes * 2) this.trimTail();

    if (this.tempFileStream || this.shouldUseTempFile()) {
      this.ensureTempFile();
      this.tempFileStream?.write(text);
    } else {
      this.rawChunks.push(text);
    }
  }

  cursor(): number {
    return this.totalChars;
  }

  bufferedChars(): number {
    return this.tailText.length;
  }

  snapshotSince(cursor: number, maxOutputTokens?: number): ExecOutputSnapshot {
    const safeCursor = Math.max(0, Math.min(cursor, this.totalChars));
    const availableStart = Math.max(safeCursor, this.tailStartChars);
    const availableText = this.tailText.slice(availableStart - this.tailStartChars);
    const originalTokenCount = Math.ceil((this.totalChars - safeCursor) / 4);
    if (availableText.length === 0) {
      return {
        output: '',
        ...(originalTokenCount > 0 ? { original_token_count: originalTokenCount } : {}),
        ...(this.tempFilePath ? { full_output_path: this.tempFilePath } : {}),
      };
    }

    const maxBytes = maxBytesForOutputTokens(maxOutputTokens);
    const truncation = truncateTail(availableText, { maxLines: DEFAULT_MAX_LINES, maxBytes });
    if (safeCursor < this.tailStartChars) {
      truncation.truncated = true;
      truncation.truncatedBy ??= 'bytes';
      truncation.totalBytes = Math.max(truncation.totalBytes, this.totalBytes);
      truncation.totalLines = Math.max(truncation.totalLines, this.totalLines());
    }

    return {
      output: truncation.content,
      original_token_count: originalTokenCount,
      ...(truncation.truncated ? { truncation } : {}),
      ...(this.tempFilePath ? { full_output_path: this.tempFilePath } : {}),
    };
  }

  async closeTempFile(): Promise<void> {
    if (!this.tempFileStream) return;
    const stream = this.tempFileStream;
    this.tempFileStream = undefined;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        stream.off('finish', onFinish);
        reject(error);
      };
      const onFinish = () => {
        stream.off('error', onError);
        resolve();
      };
      stream.once('error', onError);
      stream.once('finish', onFinish);
      stream.end();
    });
  }

  dispose(): void {
    this.tempFileStream?.end();
    this.tempFileStream = undefined;
  }

  private appendLineStats(text: string): void {
    const newlines = text.match(/\n/g)?.length ?? 0;
    if (newlines === 0) {
      this.hasOpenLine = true;
      return;
    }
    this.completedLines += newlines;
    this.hasOpenLine = !text.endsWith('\n');
  }

  private totalLines(): number {
    return this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  private shouldUseTempFile(): boolean {
    return this.totalBytes > maxBytesForOutputTokens() || this.totalLines() > DEFAULT_MAX_LINES;
  }

  private ensureTempFile(): void {
    if (this.tempFilePath) return;
    this.tempFilePath = defaultTempFilePath(this.fileStem);
    this.tempFileStream = createWriteStream(this.tempFilePath, { flags: 'wx', mode: 0o600 });
    for (const chunk of this.rawChunks) this.tempFileStream.write(chunk);
    this.rawChunks = [];
  }

  private trimTail(): void {
    const buffer = Buffer.from(this.tailText, 'utf8');
    if (buffer.length <= this.maxRollingBytes) {
      this.tailBytes = buffer.length;
      return;
    }
    let start = buffer.length - this.maxRollingBytes;
    while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
    let trimmed = buffer.subarray(start).toString('utf8');
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline >= 0) trimmed = trimmed.slice(firstNewline + 1);
    this.tailStartChars += this.tailText.length - trimmed.length;
    this.tailText = trimmed;
    this.tailBytes = byteLength(trimmed);
  }
}
