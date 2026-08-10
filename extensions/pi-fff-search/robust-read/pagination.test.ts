import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { DEFAULT_ROBUST_READ_CONFIG } from './config';
import { paginateString, paginateUtf8File } from './pagination';

const temporaryDirectories: string[] = [];

async function temporaryFile(name: string, bytes: Uint8Array): Promise<FileHandle> {
  const directory = await mkdtemp(join(tmpdir(), 'robust-read-page-'));
  temporaryDirectories.push(directory);
  const path = join(directory, name);
  await writeFile(path, bytes);
  return open(path, 'r');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('bounded pagination', () => {
  test('returns explicit empty, at-EOF, and beyond-EOF results', () => {
    expect(paginateString('', {}, DEFAULT_ROBUST_READ_CONFIG).text).toBe('[File is empty.]');
    expect(paginateString('one\ntwo', { offset: 3 }, DEFAULT_ROBUST_READ_CONFIG).text).toContain(
      'Offset 3 is at end of file',
    );
    expect(paginateString('one\ntwo', { offset: 9 }, DEFAULT_ROBUST_READ_CONFIG).text).toContain(
      'Offset 9 is beyond end of file',
    );
  });

  test('distinguishes blank source lines from an empty file', () => {
    const result = paginateString('\n', {}, DEFAULT_ROBUST_READ_CONFIG);
    expect(result.text).toContain('[Line 1 is empty.]');
    expect(result.endLine).toBe(1);
    expect(result.totalLines).toBe(1);
  });

  test('keeps exact continuation offsets without overlaps', () => {
    const source = Array.from({ length: 37 }, (_, index) => `line-${index + 1}`).join('\n');
    let offset = 1;
    const seen: number[] = [];
    for (;;) {
      const page = paginateString(source, { offset, limit: 7 }, DEFAULT_ROBUST_READ_CONFIG);
      if (page.endLine !== undefined) {
        for (let line = page.startLine; line <= page.endLine; line += 1) seen.push(line);
      }
      if (!page.hasMore || page.nextOffset === undefined) break;
      expect(page.nextOffset).toBe((page.endLine ?? offset - 1) + 1);
      offset = page.nextOffset;
    }
    expect(seen).toEqual(Array.from({ length: 37 }, (_, index) => index + 1));
  });

  test('clamps a huge single line and keeps the returned response bounded', () => {
    const page = paginateString('x'.repeat(2_000_000), {}, DEFAULT_ROBUST_READ_CONFIG);
    expect(page.clampedLines).toEqual([1]);
    expect(page.text).toContain('clamped at 2,000 characters');
    expect(page.responseBytes).toBeLessThanOrEqual(DEFAULT_ROBUST_READ_CONFIG.maxResponseBytes);
  });

  test('enforces the total response-byte budget and returns a continuation', () => {
    const config = { ...DEFAULT_ROBUST_READ_CONFIG, maxResponseBytes: 512 };
    const page = paginateString('abcdefghij\n'.repeat(2_000), {}, config);
    expect(page.responseBytes).toBeLessThanOrEqual(512);
    expect(page.nextOffset).toBeGreaterThan(1);
    expect(page.text).toContain(`offset=${page.nextOffset}`);
  });

  test('preserves UTF-8 across read boundaries and replaces invalid bytes predictably', async () => {
    const valid = await temporaryFile('valid.txt', Buffer.from('A🙂B\nC', 'utf8'));
    const validPage = await paginateUtf8File(
      valid,
      {},
      {
        ...DEFAULT_ROBUST_READ_CONFIG,
        streamChunkBytes: 2,
      },
    );
    await valid.close();
    expect(validPage.text).toBe('A🙂B\nC');
    expect(validPage.invalidUtf8).toBe(false);

    const invalid = await temporaryFile('invalid.txt', Buffer.from([0x61, 0xc3, 0x28, 0x62]));
    const invalidPage = await paginateUtf8File(
      invalid,
      {},
      {
        ...DEFAULT_ROBUST_READ_CONFIG,
        streamChunkBytes: 2,
      },
    );
    await invalid.close();
    expect(invalidPage.text).toContain('a�(b');
    expect(invalidPage.text).toContain('Invalid UTF-8 bytes were replaced');
    expect(invalidPage.invalidUtf8).toBe(true);
  });

  test('stops reading a virtual large file once one bounded page is known', async () => {
    const totalBytes = 512 * 1024 * 1024;
    let highestPosition = 0;
    const handle = {
      async read(buffer: Buffer, offset: number, length: number, position: number) {
        if (position >= totalBytes) return { bytesRead: 0, buffer };
        const bytesRead = Math.min(length, totalBytes - position);
        for (let index = 0; index < bytesRead; index += 2) {
          buffer[offset + index] = 0x78;
          if (index + 1 < bytesRead) buffer[offset + index + 1] = 0x0a;
        }
        highestPosition = Math.max(highestPosition, position + bytesRead);
        return { bytesRead, buffer };
      },
    } as FileHandle;
    const page = await paginateUtf8File(handle, {}, DEFAULT_ROBUST_READ_CONFIG);
    expect(page.endLine).toBe(DEFAULT_ROBUST_READ_CONFIG.maxLines);
    expect(highestPosition).toBeLessThan(256 * 1024);
    expect(highestPosition).toBeLessThan(totalBytes / 1_000);
  });
});
