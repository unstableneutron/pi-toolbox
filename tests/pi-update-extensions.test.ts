import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyPiCodingAgentResolverPatch,
  buildPiCodingAgentResolverReplacement,
  compareVersions,
  isPiCodingAgentResolverPatchApplied,
  parsePiListOutput,
} from '../scripts/pi-update-extensions.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup for tests
    }
  }
});

describe('parsePiListOutput', () => {
  it('parses package sources and installed roots from `pi list` output', () => {
    const output = [
      'Installed extensions:',
      '  npm:@aliou/pi-guardrails',
      '    /abs/path/to/@aliou/pi-guardrails',
      '  npm:pi-rtk-optimizer (filtered)',
      '    /abs/path/to/pi-rtk-optimizer',
      '  https://github.com/example/repo',
      '    /abs/path/to/repo',
    ].join('\n');

    expect(parsePiListOutput(output)).toEqual([
      { source: 'npm:@aliou/pi-guardrails', installedPath: '/abs/path/to/@aliou/pi-guardrails' },
      { source: 'npm:pi-rtk-optimizer', installedPath: '/abs/path/to/pi-rtk-optimizer' },
      { source: 'https://github.com/example/repo', installedPath: '/abs/path/to/repo' },
    ]);
  });
});

describe('compareVersions', () => {
  it('orders semver-like strings correctly', () => {
    expect(compareVersions('0.12.2', '0.12.2')).toBe(0);
    expect(compareVersions('0.12.3', '0.12.2')).toBeGreaterThan(0);
    expect(compareVersions('0.11.9', '0.12.2')).toBeLessThan(0);
  });
});

describe('pi-coding-agent resolver patching', () => {
  const FIXTURE_CONTENT = [
    'export function resolveCliModel(options) {',
    '    const { cliProvider, cliModel, modelRegistry } = options;',
    '    if (!cliModel) { return { model: undefined }; }',
    '    // Important: use *all* models here, not just models with pre-configured auth.',
    '    // This allows "--api-key" to be used for first-time setup.',
    '    const availableModels = modelRegistry.getAll();',
    '    return availableModels;',
    '}',
    '',
  ].join('\n');

  function setupFakePackage(version: string, resolverContent = FIXTURE_CONTENT): string {
    const packageRoot = makeTempDir('pi-coding-agent-');
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@mariozechner/pi-coding-agent', version }, null, 2),
    );
    mkdirSync(join(packageRoot, 'dist', 'core'), { recursive: true });
    writeFileSync(join(packageRoot, 'dist', 'core', 'model-resolver.js'), resolverContent);
    return packageRoot;
  }

  it('reports unpatched fixture as not yet patched', () => {
    const packageRoot = setupFakePackage('0.67.6');
    expect(isPiCodingAgentResolverPatchApplied(packageRoot)).toBe(false);
  });

  it('applies the resolver patch and marks it as applied', async () => {
    const packageRoot = setupFakePackage('0.67.6');
    const result = await applyPiCodingAgentResolverPatch({ packageRoot });

    expect(result).toMatchObject({
      status: 'applied',
      packageRoot,
      version: '0.67.6',
    });
    expect(result.patchPath).toBe(join(packageRoot, 'dist', 'core', 'model-resolver.js'));

    const patched = readFileSync(join(packageRoot, 'dist', 'core', 'model-resolver.js'), 'utf8');
    expect(patched).toContain('let availableModels = modelRegistry.getAvailable();');
    expect(patched).toContain('availableModels = modelRegistry.getAll();');
    expect(patched).not.toMatch(/^    const availableModels = modelRegistry\.getAll\(\);$/m);
    expect(isPiCodingAgentResolverPatchApplied(packageRoot)).toBe(true);
  });

  it('is idempotent: re-applying detects the marker and reports already-applied', async () => {
    const packageRoot = setupFakePackage('0.67.6');
    await applyPiCodingAgentResolverPatch({ packageRoot });
    const second = await applyPiCodingAgentResolverPatch({ packageRoot });

    expect(second).toMatchObject({
      status: 'already-applied',
      packageRoot,
      version: '0.67.6',
    });
  });

  it('supports dry-run without mutating the file', async () => {
    const packageRoot = setupFakePackage('0.67.6');
    const resolverPath = join(packageRoot, 'dist', 'core', 'model-resolver.js');
    const original = readFileSync(resolverPath, 'utf8');

    const result = await applyPiCodingAgentResolverPatch({ packageRoot, dryRun: true });
    expect(result).toMatchObject({
      status: 'would-apply',
      packageRoot,
      version: '0.67.6',
    });
    expect(readFileSync(resolverPath, 'utf8')).toBe(original);
    expect(isPiCodingAgentResolverPatchApplied(packageRoot)).toBe(false);
  });

  it('throws a descriptive error when the target line is missing', async () => {
    const packageRoot = setupFakePackage(
      '1.0.0',
      'export function resolveCliModel() { /* upstream rewrote this */ }\n',
    );
    await expect(applyPiCodingAgentResolverPatch({ packageRoot })).rejects.toThrow(
      /target line for resolver patch not found/i,
    );
  });

  it('builds a replacement containing both the marker and both branches', () => {
    const replacement = buildPiCodingAgentResolverReplacement();
    expect(replacement).toContain('__pi_update_extensions:model-resolver-uses-available__');
    expect(replacement).toContain('modelRegistry.getAvailable()');
    expect(replacement).toContain('modelRegistry.getAll()');
  });
});
