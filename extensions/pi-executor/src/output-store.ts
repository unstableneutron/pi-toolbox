import { randomUUID } from 'node:crypto';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ExecutorOutputLimits {
  maxBytes: number;
  maxLines: number;
}

export interface ExecutorOutputPage {
  outputId: string;
  content: string;
  offset: number;
  nextOffset?: number;
  totalBytes: number;
  hasMore: boolean;
}

export interface StoredExecutorOutput {
  text: string;
  outputId?: string;
  fullOutputPath?: string;
  page?: Omit<ExecutorOutputPage, 'content'>;
}

interface OutputRecord {
  id: string;
  totalBytes: number;
  directory: string;
  path: string;
}

const MAX_STORED_OUTPUTS = 20;
const ANSI_ESCAPE = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, 'g');

function sanitizeText(text: string): string {
  return text.replace(ANSI_ESCAPE, '').replaceAll('\u0000', '');
}

function completeUtf8Prefix(buffer: Buffer): Buffer {
  if (buffer.length === 0) return buffer;
  let lead = buffer.length - 1;
  while (lead >= 0 && (buffer[lead]! & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return Buffer.alloc(0);
  const first = buffer[lead]!;
  const expected = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
  return buffer.length - lead < expected ? buffer.subarray(0, lead) : buffer;
}

function capLines(buffer: Buffer, maximum: number): Buffer {
  let lines = 1;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    lines += 1;
    if (lines > maximum) return buffer.subarray(0, index);
  }
  return buffer;
}

export class ExecutorOutputStore {
  readonly #outputs = new Map<string, OutputRecord>();

  async prepare(text: string, limits: ExecutorOutputLimits): Promise<StoredExecutorOutput> {
    const sanitized = sanitizeText(text);
    const source = Buffer.from(sanitized);
    const bounded = capLines(
      completeUtf8Prefix(source.subarray(0, Math.min(source.length, limits.maxBytes))),
      limits.maxLines,
    );
    const preview = bounded.toString('utf8');
    if (bounded.length === source.length) return { text: preview };

    const id = randomUUID();
    const directory = await mkdtemp(join(tmpdir(), 'pi-executor-'));
    const path = join(directory, 'output.txt');
    await writeFile(path, sanitized, { encoding: 'utf8', mode: 0o600 });
    const totalBytes = source.length;
    this.#outputs.set(id, { id, totalBytes, directory, path });
    await this.#evict();
    const offset = bounded.length;
    const page = {
      outputId: id,
      offset: 0,
      nextOffset: offset,
      totalBytes,
      hasMore: true,
    };
    return {
      text: `${preview}\n\n[Output truncated. outputId=${id}; nextOffset=${offset}; totalBytes=${totalBytes}. Use executor_read_output to continue.]`,
      outputId: id,
      fullOutputPath: path,
      page,
    };
  }

  async read(outputId: string, offset = 0, limit = 8_000): Promise<ExecutorOutputPage | undefined> {
    const record = this.#outputs.get(outputId);
    if (!record) return undefined;
    const safeOffset = Math.min(offset, record.totalBytes);
    const handle = await open(record.path, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(limit, record.totalBytes - safeOffset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, safeOffset);
      const complete = completeUtf8Prefix(buffer.subarray(0, bytesRead));
      const bounded = capLines(complete, 300);
      const content = bounded.toString('utf8');
      const nextOffset = safeOffset + bounded.length;
      const hasMore = nextOffset < record.totalBytes;
      return {
        outputId,
        content,
        offset: safeOffset,
        ...(hasMore ? { nextOffset } : {}),
        totalBytes: record.totalBytes,
        hasMore,
      };
    } finally {
      await handle.close();
    }
  }

  async clear(): Promise<void> {
    const records = [...this.#outputs.values()];
    this.#outputs.clear();
    await Promise.all(
      records.map((record) => rm(record.directory, { recursive: true, force: true })),
    );
  }

  async #evict(): Promise<void> {
    while (this.#outputs.size > MAX_STORED_OUTPUTS) {
      const oldest = this.#outputs.values().next().value as OutputRecord | undefined;
      if (!oldest) return;
      this.#outputs.delete(oldest.id);
      await rm(oldest.directory, { recursive: true, force: true });
    }
  }
}
