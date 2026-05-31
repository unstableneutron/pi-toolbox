import { describe, expect, test } from 'vitest';

import { getCodexComputerUsePaths } from './codex-paths';

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
});
