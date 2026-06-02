import { describe, expect, test } from 'vitest';

import {
  BROWSER_TOOL_SPECS,
  buildCodexBrowserEvalScript,
  buildCodexBrowserListScript,
  buildNodeReplJsArguments,
  registerCodexBrowserTools,
  toCodexBrowserToolResult,
} from './browser-tools';

describe('browser script builders', () => {
  test('builds an IAB list script without creating a tab', () => {
    const script = buildCodexBrowserListScript({
      backend: 'iab',
      browserClientPath: '/tmp/browser/scripts/browser-client.mjs',
    });

    expect(script).toContain('await import("/tmp/browser/scripts/browser-client.mjs")');
    expect(script).toContain('globalThis.__piCodexGetBrowser(');
    expect(script).toContain('"iab",');
    expect(script).toContain('await browser.tabs.list()');
    expect(script).toContain('await browser.tabs.selected().catch(() => undefined)');
    expect(script).toContain('__piNodeRepl.write(JSON.stringify(__piBrowserResult, null, 2));');
    expect(script).not.toContain('await browser.tabs.new()');
  });

  test('builds a Chrome list script against the extension backend', () => {
    const script = buildCodexBrowserListScript({
      backend: 'chrome',
      browserClientPath: '/tmp/chrome/scripts/browser-client.mjs',
    });

    expect(script).toContain('globalThis.__piCodexGetBrowser(');
    expect(script).toContain('"chrome",');
    expect(script).toContain('"extension",');
  });

  test('filters bundled browser runtime telemetry and display noise from node_repl output', () => {
    const script = buildCodexBrowserListScript({
      backend: 'chrome',
      browserClientPath: '/tmp/chrome/scripts/browser-client.mjs',
    });

    expect(script).toContain('globalThis.__piCodexOriginalConsole');
    expect(script).toContain('globalThis.__piCodexOriginalProcessWrites');
    expect(script).toContain('process.stderr.write');
    expect(script).toContain('__piCodexIsBrowserRuntimeNoise');
    expect(script).toContain('IAB_DISCOVERY');
    expect(script).toContain('[Statsig]');
    expect(script).toContain('oaistatsig.com');
    expect(script).toContain('selectedBrowser');
    expect(script).toContain('<<<pi-codex-browser-result:start>>>');
    expect(script).toContain('<<<pi-codex-browser-result:end>>>');
    expect(script).toContain('Object.defineProperty(__piNodeRepl, "write"');
  });

  test('explains how to recover when the requested browser backend is unavailable', () => {
    const script = buildCodexBrowserEvalScript({
      backend: 'chrome',
      browserClientPath: '/tmp/chrome/scripts/browser-client.mjs',
      script: 'return await tab.title();',
    });

    expect(script).toContain('globalThis.__piCodexGetBrowser = async');
    expect(script).toContain('await agent.browsers.list()');
    expect(script).toContain('No Codex chrome browser backend is available.');
    expect(script).toContain('Open the Codex Chrome Extension side panel');
  });

  test('does not redeclare helper identifiers when node_repl evaluates scripts repeatedly', () => {
    const script = buildCodexBrowserListScript({
      backend: 'iab',
      browserClientPath: '/tmp/browser/scripts/browser-client.mjs',
    });

    expect(script).not.toContain('async function __piCodexGetBrowser');
    expect(script).toContain('if (!globalThis.__piCodexGetBrowser)');
  });

  test('builds an eval script with agent, browser, tab, and nodeRepl bindings', () => {
    const script = buildCodexBrowserEvalScript({
      backend: 'iab',
      browserClientPath: '/tmp/browser/scripts/browser-client.mjs',
      script: 'await tab.goto("https://example.com");\nreturn { title: await tab.title() };',
    });

    expect(script).toContain('globalThis.__piCodexGetBrowser(');
    expect(script).toContain('"iab",');
    expect(script).toContain('await browser.tabs.new()');
    expect(script).toContain('async ({ agent, browser, tab, nodeRepl }) => {');
    expect(script).toContain('await tab.goto("https://example.com");');
    expect(script).toContain('__piNodeRepl.write(JSON.stringify(__piBrowserEvalResult, null, 2));');
  });
});

describe('buildNodeReplJsArguments', () => {
  test('adds node_repl timeout_ms to JavaScript calls', () => {
    expect(buildNodeReplJsArguments('nodeRepl.write("ok")', 120_000)).toEqual({
      code: 'nodeRepl.write("ok")',
      timeout_ms: 120_000,
    });
  });
});

describe('BROWSER_TOOL_SPECS', () => {
  test('exposes the two-tool Codex browser surface', () => {
    expect(BROWSER_TOOL_SPECS.map((tool) => tool.piName)).toEqual([
      'codex_browser_list',
      'codex_browser_eval',
    ]);
  });
});

describe('toCodexBrowserToolResult', () => {
  test('preserves Codex MCP content and records node_repl routing details', () => {
    const result = toCodexBrowserToolResult({
      threadId: 'thread-1',
      piName: 'codex_browser_eval',
      rawResult: { content: [{ type: 'text', text: 'snapshot' }] },
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'snapshot' }],
      details: {
        codexTool: 'js',
        piTool: 'codex_browser_eval',
        server: 'node_repl',
        threadId: 'thread-1',
        rawResult: { content: [{ type: 'text', text: 'snapshot' }] },
      },
    });
  });

  test('returns only delimited browser output when node_repl also captures runtime noise', () => {
    const result = toCodexBrowserToolResult({
      threadId: 'thread-1',
      piName: 'codex_browser_eval',
      rawResult: {
        content: [
          {
            type: 'text',
            text:
              'IAB_DISCOVERY no session-owned iab browser\n' +
              '<<<pi-codex-browser-result:start>>>\n' +
              '{"title":"Example Domain"}\n' +
              '<<<pi-codex-browser-result:end>>>\n' +
              ' ERROR  [Statsig] A networking error occurred at oaistatsig.com',
          },
          { type: 'image', data: 'base64' },
        ],
      },
    });

    expect(result.content).toEqual([
      { type: 'text', text: '{"title":"Example Domain"}' },
      { type: 'image', data: 'base64' },
    ]);
  });
});

describe('registerCodexBrowserTools', () => {
  test('routes Chrome backend node_repl calls through the Chrome browser bridge with abort signal', async () => {
    const registered: any[] = [];
    const calls: any[] = [];
    const controller = new AbortController();
    const session = {
      async callBrowserMcpTool(
        _ctx: unknown,
        backend: string,
        input: unknown,
        signal: AbortSignal,
      ) {
        calls.push({ backend, input, signal });
        return {
          threadId: 'chrome-thread',
          rawResult: { content: [{ type: 'text', text: 'chrome result' }] },
        };
      },
      async callMcpTool() {
        throw new Error('default app-server bridge should not be used for chrome backend');
      },
    };
    registerCodexBrowserTools(
      { registerTool: (tool: any) => registered.push(tool) },
      session as any,
    );

    const listTool = registered.find((tool) => tool.name === 'codex_browser_list');
    const result = await listTool.execute(
      'tool-call-1',
      { backend: 'chrome' },
      controller.signal,
      undefined,
      {
        cwd: '/tmp/project',
      },
    );

    expect(result.content).toEqual([{ type: 'text', text: 'chrome result' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].backend).toBe('chrome');
    expect(calls[0].input).toMatchObject({ server: 'node_repl', tool: 'js' });
    expect(calls[0].signal).toBe(controller.signal);
  });
});
