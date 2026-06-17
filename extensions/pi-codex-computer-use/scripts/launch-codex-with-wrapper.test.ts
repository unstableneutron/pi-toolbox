import path from 'node:path';

import { describe, expect, test } from 'vitest';

describe('launch-codex-with-wrapper planning', () => {
  test('builds an open command with wrapper env and requires Codex.app to be stopped by default', async () => {
    const { buildLaunchPlan } = await import('./launch-codex-with-wrapper.mjs');

    const plan = buildLaunchPlan([], {
      cwd: '/repo',
      env: { HOME: '/Users/tester' },
      now: new Date('2026-06-05T01:02:03.004Z'),
      scriptPath: '/repo/extensions/pi-codex-computer-use/scripts/launch-codex-with-wrapper.mjs',
    });

    expect(plan.requireStopped).toBe(true);
    expect(plan.socketPath).toBe('/Users/tester/.codex/pi-codex-desktop/app-server-live.sock');
    expect(plan.logPath).toBe(
      path.join(
        '/repo',
        'scratch/codex-browser-appserver/launch-20260605T010203004Z/app-server.jsonl',
      ),
    );
    expect(plan.command).toEqual('/usr/bin/open');
    expect(plan.args).toContain('-n');
    expect(plan.args).toContain('-g');
    expect(plan.args).toContain('-a');
    expect(plan.args).toContain('Codex');
    expect(plan.env).toMatchObject({
      CODEX_CLI_PATH:
        '/repo/extensions/pi-codex-computer-use/scripts/codex-desktop-app-server-wrapper.mjs',
      PI_CODEX_DESKTOP_REAL_CODEX: '/Applications/Codex.app/Contents/Resources/codex',
      PI_CODEX_DESKTOP_APP_SERVER_SOCKET:
        '/Users/tester/.codex/pi-codex-desktop/app-server-live.sock',
      PI_CODEX_DESKTOP_APP_SERVER_LOG: path.join(
        '/repo',
        'scratch/codex-browser-appserver/launch-20260605T010203004Z/app-server.jsonl',
      ),
      PI_CODEX_DESKTOP_CONNECT_TIMEOUT_MS: '20000',
    });
  });

  test('adds Brave browser env and Brave defaults when --browser brave is selected', async () => {
    const { buildLaunchPlan } = await import('./launch-codex-with-wrapper.mjs');

    const plan = buildLaunchPlan(['--browser', 'brave'], {
      cwd: '/repo',
      env: { HOME: '/Users/tester' },
      now: new Date('2026-06-05T01:02:03.004Z'),
      scriptPath: '/repo/extensions/pi-codex-computer-use/scripts/launch-codex-with-wrapper.mjs',
    });

    expect(plan.env).toMatchObject({
      BROWSER_USE_AVAILABLE_BACKENDS: 'chrome',
      CODEX_CHROME_BROWSER: 'brave',
      CODEX_CHROME_USER_DATA_DIR:
        '/Users/tester/Library/Application Support/BraveSoftware/Brave-Browser',
      CODEX_CHROME_NATIVE_HOST_MANIFEST_PATH:
        '/Users/tester/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.openai.codexextension.json',
      NODE_REPL_UNTRUSTED_ENV_ALLOWLIST:
        'BROWSER_USE_AVAILABLE_BACKENDS,CODEX_CHROME_BROWSER,CODEX_CHROME_USER_DATA_DIR,CODEX_CHROME_NATIVE_HOST_MANIFEST_PATH',
    });
  });

  test('supports explicit socket, log, and allow-running overrides', async () => {
    const { buildLaunchPlan } = await import('./launch-codex-with-wrapper.mjs');

    const plan = buildLaunchPlan(
      ['--allow-running', '--socket', '/tmp/codex.sock', '--log', '/tmp/codex.jsonl'],
      {
        cwd: '/repo',
        env: { HOME: '/Users/tester' },
        now: new Date('2026-06-05T01:02:03.004Z'),
        scriptPath: '/repo/extensions/pi-codex-computer-use/scripts/launch-codex-with-wrapper.mjs',
      },
    );

    expect(plan.requireStopped).toBe(false);
    expect(plan.socketPath).toBe('/tmp/codex.sock');
    expect(plan.logPath).toBe('/tmp/codex.jsonl');
    expect(plan.env.PI_CODEX_DESKTOP_APP_SERVER_SOCKET).toBe('/tmp/codex.sock');
    expect(plan.env.PI_CODEX_DESKTOP_APP_SERVER_LOG).toBe('/tmp/codex.jsonl');
  });

  test('rejects unknown browsers and unsupported arguments', async () => {
    const { buildLaunchPlan } = await import('./launch-codex-with-wrapper.mjs');
    const context = {
      cwd: '/repo',
      env: { HOME: '/Users/tester' },
      now: new Date('2026-06-05T01:02:03.004Z'),
      scriptPath: '/repo/extensions/pi-codex-computer-use/scripts/launch-codex-with-wrapper.mjs',
    };

    expect(() => buildLaunchPlan(['--browser', 'safari'], context)).toThrow('Unsupported browser');
    expect(() => buildLaunchPlan(['--wat'], context)).toThrow('Unsupported argument');
  });
});
