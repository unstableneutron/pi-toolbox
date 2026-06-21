import { describe, expect, test } from 'vitest';

import { COMPUTER_USE_TOOL_SPECS, registerComputerUseTools, toPiToolResult } from './tools';

describe('COMPUTER_USE_TOOL_SPECS', () => {
  test('exposes two observation tools and one native action dispatcher', () => {
    expect(COMPUTER_USE_TOOL_SPECS.map((tool) => [tool.piName, tool.codexTool])).toEqual([
      ['computer_list_apps', 'list_apps'],
      ['computer_get_app_state', 'get_app_state'],
      ['computer_action', undefined],
    ]);
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
