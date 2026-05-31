import { describe, expect, test } from 'vitest';

import { COMPUTER_USE_TOOL_SPECS, toPiToolResult } from './tools';

describe('COMPUTER_USE_TOOL_SPECS', () => {
  test('maps prefixed Pi tools to every native Codex Computer Use tool', () => {
    expect(COMPUTER_USE_TOOL_SPECS.map((tool) => [tool.piName, tool.codexTool])).toEqual([
      ['computer_use_list_apps', 'list_apps'],
      ['computer_use_get_app_state', 'get_app_state'],
      ['computer_use_click', 'click'],
      ['computer_use_scroll', 'scroll'],
      ['computer_use_drag', 'drag'],
      ['computer_use_press_key', 'press_key'],
      ['computer_use_type_text', 'type_text'],
      ['computer_use_set_value', 'set_value'],
      ['computer_use_select_text', 'select_text'],
      ['computer_use_secondary_action', 'perform_secondary_action'],
    ]);
  });
});

describe('toPiToolResult', () => {
  test('preserves Codex MCP content and records routing details', () => {
    const result = toPiToolResult({
      threadId: 'thread-1',
      piName: 'computer_use_get_app_state',
      codexTool: 'get_app_state',
      rawResult: { content: [{ type: 'text', text: 'Computer Use state' }] },
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'Computer Use state' }],
      details: {
        codexTool: 'get_app_state',
        piTool: 'computer_use_get_app_state',
        server: 'computer-use',
        threadId: 'thread-1',
        rawResult: { content: [{ type: 'text', text: 'Computer Use state' }] },
      },
    });
  });
});
