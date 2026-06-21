import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type CodexComputerUsePathOptions,
  getCodexComputerUsePaths,
  resolveCodexPluginPath,
} from './codex-paths';

interface CodexPluginSkill {
  plugin: string;
  skill: string;
}

interface CodexComputerUseSkillPathOptions extends CodexComputerUsePathOptions {
  extensionRoot?: string;
}

const CODEX_COMPUTER_USE_PLUGIN_SKILLS: CodexPluginSkill[] = [
  { plugin: 'computer-use', skill: 'computer-use' },
];

function defaultExtensionRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

export function getCodexComputerUseSkillPaths(
  options: CodexComputerUseSkillPathOptions = {},
): string[] {
  const paths = getCodexComputerUsePaths(options);
  const extensionRoot = options.extensionRoot ?? defaultExtensionRoot();
  const skillPaths = [path.join(extensionRoot, 'skills/codex-computer-use')];

  for (const { plugin, skill } of CODEX_COMPUTER_USE_PLUGIN_SKILLS) {
    const pluginSkillPath = resolveCodexPluginPath({
      codexApp: paths.codexApp,
      codexHome: paths.codexHome,
      plugin,
      relativePath: `skills/${skill}`,
      type: 'directory',
    });
    if (pluginSkillPath) {
      skillPaths.push(pluginSkillPath);
    }
  }

  return skillPaths;
}
