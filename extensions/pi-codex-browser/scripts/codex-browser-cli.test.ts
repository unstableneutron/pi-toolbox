import { describe, expect, test } from 'vitest';

describe('codex-browser CLI parser', () => {
  test('parses global json flag before the command', async () => {
    const { parseArgv } = await import('./codex-browser.mjs');

    expect(parseArgv(['--json', 'chrome_tabs_list', '--limit', '5'])).toEqual({
      command: 'chrome_tabs_list',
      json: true,
      options: {
        limit: 5,
      },
    });
  });

  test('parses raw method and JSON params', async () => {
    const { parseArgv } = await import('./codex-browser.mjs');

    expect(parseArgv(['raw', 'getUserTabs', '--params-json', '{"limit":2}'])).toEqual({
      command: 'raw',
      json: false,
      options: {
        method: 'getUserTabs',
        params: { limit: 2 },
      },
    });
  });

  test('rejects unknown commands', async () => {
    const { parseArgv } = await import('./codex-browser.mjs');

    expect(() => parseArgv(['unknown'])).toThrow('Unknown command: unknown');
  });
});
