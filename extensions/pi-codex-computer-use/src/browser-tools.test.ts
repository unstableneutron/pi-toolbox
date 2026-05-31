import { describe, expect, test } from 'vitest';

import {
  BROWSER_TOOL_SPECS,
  buildCodexBrowserEvalScript,
  buildCodexBrowserListScript,
  buildNodeReplJsArguments,
  toCodexBrowserToolResult,
} from './browser-tools';

describe('browser script builders', () => {
  test('builds an IAB list script without creating a tab', () => {
    const script = buildCodexBrowserListScript({
      backend: 'iab',
      browserClientPath: '/tmp/browser/scripts/browser-client.mjs',
    });

    expect(script).toContain('await import("/tmp/browser/scripts/browser-client.mjs")');
    expect(script).toContain('agent.browsers.get("iab")');
    expect(script).toContain('await browser.tabs.list()');
    expect(script).toContain('await browser.tabs.selected().catch(() => undefined)');
    expect(script).toContain('nodeRepl.write(JSON.stringify(__piBrowserResult, null, 2));');
    expect(script).not.toContain('await browser.tabs.new()');
  });

  test('builds a Chrome list script against the extension backend', () => {
    const script = buildCodexBrowserListScript({
      backend: 'chrome',
      browserClientPath: '/tmp/chrome/scripts/browser-client.mjs',
    });

    expect(script).toContain('agent.browsers.get("extension")');
  });

  test('builds an eval script with agent, browser, tab, and nodeRepl bindings', () => {
    const script = buildCodexBrowserEvalScript({
      backend: 'iab',
      browserClientPath: '/tmp/browser/scripts/browser-client.mjs',
      script: 'await tab.goto("https://example.com");\nreturn { title: await tab.title() };',
    });

    expect(script).toContain('agent.browsers.get("iab")');
    expect(script).toContain('await browser.tabs.new()');
    expect(script).toContain('async ({ agent, browser, tab, nodeRepl }) => {');
    expect(script).toContain('await tab.goto("https://example.com");');
    expect(script).toContain('nodeRepl.write(JSON.stringify(__piBrowserEvalResult, null, 2));');
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
});
