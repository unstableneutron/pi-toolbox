import { describe, expect, test } from 'vitest';

import { COMPUTER_USE_TOOL_SPECS, toPiToolResult } from './tools';

describe('COMPUTER_USE_TOOL_SPECS', () => {
  test('exposes two observation tools and one native action dispatcher', () => {
    expect(COMPUTER_USE_TOOL_SPECS.map((tool) => [tool.piName, tool.codexTool])).toEqual([
      ['computer_list_apps', 'list_apps'],
      ['computer_get_app_state', 'get_app_state'],
      ['computer_action', undefined],
    ]);
  });
});

describe('toPiToolResult', () => {
  test('preserves Codex MCP content and records routing details', () => {
    const result = toPiToolResult({
      threadId: 'thread-1',
      piName: 'computer_get_app_state',
      codexTool: 'get_app_state',
      rawResult: { content: [{ type: 'text', text: 'Computer Use state' }] },
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Computer Use state' }],
      details: {
        codexTool: 'get_app_state',
        piTool: 'computer_get_app_state',
        server: 'computer-use',
        threadId: 'thread-1',
        rawResult: { content: [{ type: 'text', text: 'Computer Use state' }] },
      },
    });
  });
});
