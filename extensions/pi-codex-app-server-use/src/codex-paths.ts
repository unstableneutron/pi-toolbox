import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CODEX_APP = '/Applications/Codex.app';

export interface CodexComputerUsePathOptions {
  codexApp?: string;
  codexExecutable?: string;
  codexHome?: string;
}

interface CodexBrowserClientScripts {
  iab?: string;
  chrome?: string;
}

interface CodexComputerUsePaths {
  codexApp: string;
  codexExecutable: string;
  codexHome: string;
  stableComputerUseApp: string;
  stableComputerUseClient: string;
  browserClientScripts: CodexBrowserClientScripts;
}

interface ResolveCodexPluginScriptOptions {
  codexApp: string;
  codexHome: string;
  plugin: string;
  scriptRelativePath: string;
}

interface ResolveCodexPluginPathOptions {
  codexApp: string;
  codexHome: string;
  plugin: string;
  relativePath: string;
  type: 'directory' | 'file';
}

const PLUGIN_DIRECTORY_COLLATOR = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});

function pathHasType(filePath: string, type: 'directory' | 'file'): boolean {
  try {
    const stats = fs.statSync(filePath);
    return type === 'directory' ? stats.isDirectory() : stats.isFile();
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

export function resolveCodexPluginPath({
  codexApp,
  codexHome,
  plugin,
  relativePath,
  type,
}: ResolveCodexPluginPathOptions): string | undefined {
  const marketplaceCandidate = path.join(
    codexHome,
    '.tmp/bundled-marketplaces/openai-bundled/plugins',
    plugin,
    relativePath,
  );
  if (pathHasType(marketplaceCandidate, type)) {
    return marketplaceCandidate;
  }

  const cacheRoot = path.join(codexHome, 'plugins/cache/openai-bundled', plugin);
  const latestCandidate = path.join(cacheRoot, 'latest', relativePath);
  if (pathHasType(latestCandidate, type)) {
    return latestCandidate;
  }

  const versionedCandidates = listDirectories(cacheRoot)
    .filter((name) => name !== 'latest')
    .sort((left, right) => PLUGIN_DIRECTORY_COLLATOR.compare(right, left))
    .map((name) => path.join(cacheRoot, name, relativePath));

  for (const candidate of versionedCandidates) {
    if (pathHasType(candidate, type)) {
      return candidate;
    }
  }

  const bundledCandidate = path.join(
    codexApp,
    'Contents/Resources/plugins/openai-bundled/plugins',
    plugin,
    relativePath,
  );
  return pathHasType(bundledCandidate, type) ? bundledCandidate : undefined;
}

export function resolveCodexPluginScript({
  codexApp,
  codexHome,
  plugin,
  scriptRelativePath,
}: ResolveCodexPluginScriptOptions): string | undefined {
  return resolveCodexPluginPath({
    codexApp,
    codexHome,
    plugin,
    relativePath: scriptRelativePath,
    type: 'file',
  });
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
