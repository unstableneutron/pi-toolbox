import { describe, expect, test } from 'vitest';

import { COMPUTER_USE_TOOL_SPECS, registerComputerUseTools, toPiToolResult } from './tools';

describe('COMPUTER_USE_TOOL_SPECS', () => {
  test('exposes one Pi tool for each native Codex Computer Use tool', () => {
    expect(COMPUTER_USE_TOOL_SPECS.map((tool) => [tool.piName, tool.codexTool])).toEqual([
      ['computer_list_apps', 'list_apps'],
      ['computer_get_app_state', 'get_app_state'],
      ['computer_click', 'click'],
      ['computer_drag', 'drag'],
      ['computer_press_key', 'press_key'],
      ['computer_type_text', 'type_text'],
      ['computer_scroll', 'scroll'],
      ['computer_select_text', 'select_text'],
      ['computer_set_value', 'set_value'],
      ['computer_perform_secondary_action', 'perform_secondary_action'],
    ]);
  });

  test('uses native-shaped required fields for action tools', () => {
    const scroll = COMPUTER_USE_TOOL_SPECS.find((tool) => tool.piName === 'computer_scroll');
    const selectText = COMPUTER_USE_TOOL_SPECS.find(
      (tool) => tool.piName === 'computer_select_text',
    );

    expect(scroll?.parameters.required).toEqual(['app', 'element_index', 'direction']);
    expect(selectText?.parameters.required).toEqual(['app', 'element_index', 'text']);
  });
});

describe('registerComputerUseTools', () => {
  test('passes the agent abort signal to every Computer Use session call', async () => {
    const registered: any[] = [];
    const calls: any[] = [];
    const controller = new AbortController();
    const session = {
      async callTool(_ctx: unknown, codexTool: string, args: unknown, signal: AbortSignal) {
        calls.push({ codexTool, args, signal });
        return {
          threadId: 'thread-1',
          rawResult: { content: [{ type: 'text', text: 'ok' }] },
        };
      },
    };

    registerComputerUseTools(
      { registerTool: (tool: any) => registered.push(tool) },
      session as any,
    );

    const listTool = registered.find((tool) => tool.name === 'computer_list_apps');
    await listTool.execute('tool-call-1', {}, controller.signal, undefined, {
      cwd: '/tmp/project',
    });

    expect(calls).toEqual([
      {
        codexTool: 'list_apps',
        args: {},
        signal: controller.signal,
      },
    ]);
  });

  test('routes native-shaped Pi action tools directly to matching Codex MCP tools', async () => {
    const registered: any[] = [];
    const calls: any[] = [];
    const session = {
      async callTool(_ctx: unknown, codexTool: string, args: unknown) {
        calls.push({ codexTool, args });
        return {
          threadId: 'thread-1',
          rawResult: { content: [{ type: 'text', text: 'clicked' }] },
        };
      },
    };

    registerComputerUseTools(
      { registerTool: (tool: any) => registered.push(tool) },
      session as any,
    );

    const clickTool = registered.find((tool) => tool.name === 'computer_click');
    const result = await clickTool.execute(
      'tool-call-1',
      { app: 'Finder', element_index: '10', click_count: 2 },
      undefined,
      undefined,
      { cwd: '/tmp/project' },
    );

    expect(calls).toEqual([
      { codexTool: 'click', args: { app: 'Finder', element_index: '10', click_count: 2 } },
    ]);
    expect(result.details).toMatchObject({ codexTool: 'click', piTool: 'computer_click' });
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
