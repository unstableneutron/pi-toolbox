import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { getCodexComputerUseSkillPaths } from './plugin-skills';

describe('getCodexComputerUseSkillPaths', () => {
  test('exposes the overlay skill and installed Codex Computer Use skill only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plugin-skills-'));
    const codexHome = path.join(root, 'codex-home');
    const extensionRoot = path.join(root, 'extension');
    writeSkill(path.join(extensionRoot, 'skills/codex-computer-use'));
    writeSkill(
      path.join(codexHome, 'plugins/cache/openai-bundled/computer-use/1.0.799/skills/computer-use'),
    );
    writeSkill(
      path.join(
        codexHome,
        'plugins/cache/openai-bundled/browser/26.527.31326/skills/control-in-app-browser',
      ),
    );
    writeSkill(
      path.join(codexHome, 'plugins/cache/openai-bundled/chrome/5.0.0/skills/control-chrome'),
    );

    expect(
      getCodexComputerUseSkillPaths({
        codexApp: path.join(root, 'Codex.app'),
        codexHome,
        extensionRoot,
      }),
    ).toEqual([
      path.join(extensionRoot, 'skills/codex-computer-use'),
      path.join(codexHome, 'plugins/cache/openai-bundled/computer-use/1.0.799/skills/computer-use'),
    ]);
  });

  test('falls back to the Codex.app bundled Computer Use skill when cache is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bundled-skills-'));
    const codexApp = path.join(root, 'Codex.app');
    const extensionRoot = path.join(root, 'extension');
    writeSkill(path.join(extensionRoot, 'skills/codex-computer-use'));
    writeSkill(
      path.join(
        codexApp,
        'Contents/Resources/plugins/openai-bundled/plugins/computer-use/skills/computer-use',
      ),
    );

    expect(
      getCodexComputerUseSkillPaths({
        codexApp,
        codexHome: path.join(root, 'codex-home'),
        extensionRoot,
      }),
    ).toEqual([
      path.join(extensionRoot, 'skills/codex-computer-use'),
      path.join(
        codexApp,
        'Contents/Resources/plugins/openai-bundled/plugins/computer-use/skills/computer-use',
      ),
    ]);
  });
});

function writeSkill(skillPath: string): void {
  fs.mkdirSync(skillPath, { recursive: true });
  fs.writeFileSync(
    path.join(skillPath, 'SKILL.md'),
    '---\nname: example\ndescription: Example skill\n---\n',
  );
}
