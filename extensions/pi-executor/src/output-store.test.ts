import { afterEach, describe, expect, test } from 'vitest';

import { ExecutorOutputStore } from './output-store';

const stores: ExecutorOutputStore[] = [];

function store(): ExecutorOutputStore {
  const output = new ExecutorOutputStore();
  stores.push(output);
  return output;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((output) => output.clear()));
});

describe('ExecutorOutputStore', () => {
  test('returns bounded output inline when it fits', async () => {
    const output = store();
    const prepared = await output.prepare('small result', { maxBytes: 1024, maxLines: 10 });

    expect(prepared).toEqual({ text: 'small result' });
  });

  test('spills large output and supports character pagination', async () => {
    const output = store();
    const source = Array.from({ length: 20 }, (_, index) => `line-${index}`).join('\n');
    const prepared = await output.prepare(source, { maxBytes: 30, maxLines: 3 });

    expect(prepared.outputId).toBeTruthy();
    expect(prepared.fullOutputPath).toBeTruthy();
    expect(prepared.text).toContain('Use executor_read_output');

    const first = (await output.read(prepared.outputId!, 0, 25))!;
    expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(25);
    expect(first.hasMore).toBe(true);
    const second = (await output.read(prepared.outputId!, first.nextOffset, 10_000))!;
    expect(second.hasMore).toBe(false);
    expect(`${first.content}${second.content}`).toBe(source);
  });

  test('keeps UTF-8 boundaries stable across byte pages', async () => {
    const output = store();
    const source = '🙂'.repeat(10);
    const prepared = await output.prepare(source, { maxBytes: 5, maxLines: 10 });
    const chunks: string[] = [];
    let offset = 0;
    while (true) {
      const page = (await output.read(prepared.outputId!, offset, 5))!;
      chunks.push(page.content);
      if (!page.hasMore) break;
      offset = page.nextOffset!;
    }
    expect(chunks.join('')).toBe(source);
  });

  test('removes ANSI control sequences from model-visible output', async () => {
    const output = store();
    const prepared = await output.prepare('\u001b[31mred\u001b[0m', {
      maxBytes: 1024,
      maxLines: 10,
    });

    expect(prepared.text).toBe('red');
  });
});
