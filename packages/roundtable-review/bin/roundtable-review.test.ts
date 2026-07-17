import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const cliPath = fileURLToPath(new URL('./roundtable-review.js', import.meta.url));

describe('roundtable-review Pi SDK integration', () => {
  test('uses ModelRuntime for model preflight', () => {
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        '--models',
        'missing/reviewer',
        '--synth-model',
        'missing/synthesizer',
        '--no-diff',
        '--no-extensions',
        '--no-skills',
        'SDK migration smoke test',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, PI_OFFLINE: '1' },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Model preflight failed');
    expect(result.stderr).not.toContain("Cannot read properties of undefined (reading 'create')");
  });
});
