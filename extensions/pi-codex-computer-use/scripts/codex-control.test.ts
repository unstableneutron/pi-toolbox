import { describe, expect, test } from 'vitest';

describe('codex-control websocket frames', () => {
  test('round-trips a masked client text frame', async () => {
    const { decodeWebSocketFrames, encodeClientTextFrame } = await import('./codex-control.mjs');

    const encoded = encodeClientTextFrame('{"id":1,"method":"initialize"}');
    const decoded = decodeWebSocketFrames(encoded);

    expect(decoded.rest).toHaveLength(0);
    expect(decoded.frames).toMatchObject([
      {
        opcode: 1,
        text: '{"id":1,"method":"initialize"}',
      },
    ]);
  });

  test('keeps incomplete frame bytes as rest', async () => {
    const { decodeWebSocketFrames, encodeClientTextFrame } = await import('./codex-control.mjs');
    const encoded = encodeClientTextFrame('hello');

    const decoded = decodeWebSocketFrames(encoded.subarray(0, 3));

    expect(decoded.frames).toEqual([]);
    expect(decoded.rest).toEqual(encoded.subarray(0, 3));
  });
});

describe('codex-control MCP output helpers', () => {
  test('extracts text content from MCP tool results', async () => {
    const { getMcpText } = await import('./codex-control.mjs');

    expect(
      getMcpText({
        content: [
          { type: 'text', text: 'first' },
          { type: 'image', data: 'ignored' },
          { type: 'text', text: 'second' },
        ],
      }),
    ).toBe('first\nsecond');
  });
});
