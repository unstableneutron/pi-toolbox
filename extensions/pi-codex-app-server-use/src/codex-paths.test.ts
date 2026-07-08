import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { getCodexComputerUsePaths, resolveCodexPluginScript } from './codex-paths';

describe('getCodexComputerUsePaths', () => {
  test('uses Codex defaults under the supplied home directory', () => {
    const paths = getCodexComputerUsePaths({
      codexHome: '/tmp/example-codex-home',
      codexExecutable: '/Applications/Codex.app/Contents/Resources/codex',
    });

    expect(paths.codexExecutable).toBe('/Applications/Codex.app/Contents/Resources/codex');
    expect(paths.codexHome).toBe('/tmp/example-codex-home');
    expect(paths.stableComputerUseApp).toBe(
      '/tmp/example-codex-home/computer-use/Codex Computer Use.app',
    );
    expect(paths.stableComputerUseClient).toBe(
      '/tmp/example-codex-home/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient',
    );
  });

  test('resolves browser-client scripts for IAB and Chrome', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-paths-'));
    writeFile(
      path.join(
        root,
        'codex-home/plugins/cache/openai-bundled/browser/26.527.31326/scripts/browser-client.mjs',
      ),
    );
    writeFile(
      path.join(
        root,
        'codex-home/plugins/cache/openai-bundled/chrome/5.0.0/scripts/browser-client.mjs',
      ),
    );

    const paths = getCodexComputerUsePaths({
      codexApp: path.join(root, 'Codex.app'),
      codexHome: path.join(root, 'codex-home'),
    });

    expect(paths.browserClientScripts.iab).toBe(
      path.join(
        root,
        'codex-home/plugins/cache/openai-bundled/browser/26.527.31326/scripts/browser-client.mjs',
      ),
    );
    expect(paths.browserClientScripts.chrome).toBe(
      path.join(
        root,
        'codex-home/plugins/cache/openai-bundled/chrome/5.0.0/scripts/browser-client.mjs',
      ),
    );
  });
});

describe('resolveCodexPluginScript', () => {
  test('prefers the trusted bundled marketplace temp path over plugin cache copies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plugin-marketplace-'));
    const marketplaceClient = path.join(
      root,
      'codex-home/.tmp/bundled-marketplaces/openai-bundled/plugins/chrome/scripts/browser-client.mjs',
    );
    writeFile(marketplaceClient);
    writeFile(
      path.join(
        root,
        'codex-home/plugins/cache/openai-bundled/chrome/latest/scripts/browser-client.mjs',
      ),
    );

    expect(
      resolveCodexPluginScript({
        codexApp: path.join(root, 'Codex.app'),
        codexHome: path.join(root, 'codex-home'),
        plugin: 'chrome',
        scriptRelativePath: 'scripts/browser-client.mjs',
      }),
    ).toBe(marketplaceClient);
  });

  test('prefers the latest cache alias over versioned plugin directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plugin-latest-'));
    const latestClient = path.join(
      root,
      'codex-home/plugins/cache/openai-bundled/browser/latest/scripts/browser-client.mjs',
    );
    writeFile(latestClient);
    writeFile(
      path.join(
        root,
        'codex-home/plugins/cache/openai-bundled/browser/999.0.0/scripts/browser-client.mjs',
      ),
    );

    expect(
      resolveCodexPluginScript({
        codexApp: path.join(root, 'Codex.app'),
        codexHome: path.join(root, 'codex-home'),
        plugin: 'browser',
        scriptRelativePath: 'scripts/browser-client.mjs',
      }),
    ).toBe(latestClient);
  });

  test('chooses the highest version-like cached plugin directory when no latest alias exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plugin-version-'));
    const newestClient = path.join(
      root,
      'codex-home/plugins/cache/openai-bundled/browser/26.527.31326/scripts/browser-client.mjs',
    );
    writeFile(
      path.join(
        root,
        'codex-home/plugins/cache/openai-bundled/browser/26.527.9/scripts/browser-client.mjs',
      ),
    );
    writeFile(newestClient);
    writeFile(
      path.join(
        root,
        'codex-home/plugins/cache/openai-bundled/browser/2.0.0/scripts/browser-client.mjs',
      ),
    );

    expect(
      resolveCodexPluginScript({
        codexApp: path.join(root, 'Codex.app'),
        codexHome: path.join(root, 'codex-home'),
        plugin: 'browser',
        scriptRelativePath: 'scripts/browser-client.mjs',
      }),
    ).toBe(newestClient);
  });

  test('falls back to the installed Codex.app bundled plugin script', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plugin-app-'));
    const bundledClient = path.join(
      root,
      'Codex.app/Contents/Resources/plugins/openai-bundled/plugins/browser/scripts/browser-client.mjs',
    );
    writeFile(bundledClient);

    expect(
      resolveCodexPluginScript({
        codexApp: path.join(root, 'Codex.app'),
        codexHome: path.join(root, 'codex-home'),
        plugin: 'browser',
        scriptRelativePath: 'scripts/browser-client.mjs',
      }),
    ).toBe(bundledClient);
  });
});

function writeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'export {};\n');
}
