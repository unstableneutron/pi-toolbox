import { describe, expect, test } from 'vitest';

import { parseSseJson } from './sse';

async function collect(response: Response): Promise<unknown[]> {
  const items: unknown[] = [];
  for await (const item of parseSseJson(response)) {
    items.push(item);
  }
  return items;
}

describe('parseSseJson', () => {
  test('parses unterminated final event', async () => {
    const response = new Response('data: {"type":"done","value":1}', {
      headers: { 'content-type': 'text/event-stream' },
    });

    await expect(collect(response)).resolves.toEqual([{ type: 'done', value: 1 }]);
  });

  test('parses CRLF-delimited events', async () => {
    const response = new Response('data: {"type":"one"}\r\n\r\ndata: {"type":"two"}\r\n\r\n', {
      headers: { 'content-type': 'text/event-stream' },
    });

    await expect(collect(response)).resolves.toEqual([{ type: 'one' }, { type: 'two' }]);
  });
});
