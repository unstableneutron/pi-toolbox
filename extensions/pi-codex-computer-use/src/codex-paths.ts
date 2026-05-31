import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CODEX_APP = '/Applications/Codex.app';
export const DEFAULT_CODEX_EXECUTABLE = path.join(DEFAULT_CODEX_APP, 'Contents/Resources/codex');

export interface CodexComputerUsePathOptions {
  codexApp?: string;
  codexExecutable?: string;
  codexHome?: string;
}

export interface CodexBrowserClientScripts {
  iab?: string;
  chrome?: string;
}

export interface CodexComputerUsePaths {
  codexApp: string;
  codexExecutable: string;
  codexHome: string;
  stableComputerUseApp: string;
  stableComputerUseClient: string;
  browserClientScripts: CodexBrowserClientScripts;
}

export interface ResolveCodexPluginScriptOptions {
  codexApp: string;
  codexHome: string;
  plugin: string;
  scriptRelativePath: string;
}

const PLUGIN_DIRECTORY_COLLATOR = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function listDirectories(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function resolveCodexPluginScript({
  codexApp,
  codexHome,
  plugin,
  scriptRelativePath,
}: ResolveCodexPluginScriptOptions): string | undefined {
  const cacheRoot = path.join(codexHome, 'plugins/cache/openai-bundled', plugin);
  const latestCandidate = path.join(cacheRoot, 'latest', scriptRelativePath);
  if (isFile(latestCandidate)) {
    return latestCandidate;
  }

  const versionedCandidates = listDirectories(cacheRoot)
    .filter((name) => name !== 'latest')
    .sort((left, right) => PLUGIN_DIRECTORY_COLLATOR.compare(right, left))
    .map((name) => path.join(cacheRoot, name, scriptRelativePath));

  for (const candidate of versionedCandidates) {
    if (isFile(candidate)) {
      return candidate;
    }
  }

  const bundledCandidate = path.join(
    codexApp,
    'Contents/Resources/plugins/openai-bundled/plugins',
    plugin,
    scriptRelativePath,
  );
  return isFile(bundledCandidate) ? bundledCandidate : undefined;
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
    browserClientScripts: {
      iab: resolveCodexPluginScript({
        codexApp,
        codexHome,
        plugin: 'browser',
        scriptRelativePath: 'scripts/browser-client.mjs',
      }),
      chrome: resolveCodexPluginScript({
        codexApp,
        codexHome,
        plugin: 'chrome',
        scriptRelativePath: 'scripts/browser-client.mjs',
      }),
    },
  };
}
