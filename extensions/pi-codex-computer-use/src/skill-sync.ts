import path from 'node:path';

export interface CodexSkillCopy {
  plugin: string;
  skill: string;
  destination: string;
}

export const CODEX_SKILL_COPIES: CodexSkillCopy[] = [
  {
    plugin: 'computer-use',
    skill: 'computer-use',
    destination: 'computer-use',
  },
  {
    plugin: 'browser',
    skill: 'control-in-app-browser',
    destination: 'control-in-app-browser',
  },
  {
    plugin: 'chrome',
    skill: 'control-chrome',
    destination: 'control-chrome',
  },
];

export function getCodexSkillSourceRoot(codexApp: string, plugin: string): string {
  return path.join(codexApp, 'Contents/Resources/plugins/openai-bundled/plugins', plugin, 'skills');
}
