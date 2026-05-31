import { describe, expect, test } from 'vitest';

import { CODEX_SKILL_COPIES, getCodexSkillSourceRoot } from './skill-sync';

describe('Codex skill sync manifest', () => {
  test('copies Computer Use, IAB, and Chrome skills from Codex bundled plugins', () => {
    expect(CODEX_SKILL_COPIES).toEqual([
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
    ]);
  });

  test('resolves the installed Codex.app bundled skill root', () => {
    expect(getCodexSkillSourceRoot('/Applications/Codex.app', 'browser')).toBe(
      '/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/browser/skills',
    );
  });
});
