import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CODEX_APP = '/Applications/Codex.app';
export const DEFAULT_CODEX_EXECUTABLE = path.join(DEFAULT_CODEX_APP, 'Contents/Resources/codex');

export interface CodexComputerUsePathOptions {
  codexApp?: string;
  codexExecutable?: string;
  codexHome?: string;
}

export interface CodexComputerUsePaths {
  codexApp: string;
  codexExecutable: string;
  codexHome: string;
  stableComputerUseApp: string;
  stableComputerUseClient: string;
}

export function getCodexComputerUsePaths(
  options: CodexComputerUsePathOptions = {},
): CodexComputerUsePaths {
  const codexApp = options.codexApp ?? process.env.PI_COMPUTER_USE_CODEX_APP ?? DEFAULT_CODEX_APP;
  const codexExecutable =
    options.codexExecutable ??
    process.env.PI_COMPUTER_USE_CODEX_EXECUTABLE ??
    path.join(codexApp, 'Contents/Resources/codex');
  const codexHome =
    options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const stableComputerUseApp = path.join(codexHome, 'computer-use/Codex Computer Use.app');

  return {
    codexApp,
    codexExecutable,
    codexHome,
    stableComputerUseApp,
    stableComputerUseClient: path.join(
      stableComputerUseApp,
      'Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient',
    ),
  };
}
