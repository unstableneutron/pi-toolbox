import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyPiCodexGoalPostCompactionUserFollowupPatch,
  applyPiCodingAgentResolverPatch,
  applyPiContinuousLearningPatch,
  applyPiMermaidPatch,
  applyPiSubagentsApplyPatchToolPatch,
  applyPiSubagentsIntercomDetachPatch,
  buildPiCodingAgentResolverReplacement,
  compareVersions,
  findInstalledNpmPackagePath,
  formatPackageManagerCommand,
  getPackageManagerCommandCandidates,
  isPiCodexGoalPostCompactionUserFollowupPatchApplied,
  isPiCodingAgentResolverPatchApplied,
  isPiContinuousLearningPatchApplied,
  isPiMermaidPatchApplied,
  isPiSubagentsApplyPatchToolPatchApplied,
  isPiSubagentsIntercomDetachPatchApplied,
  parsePiListOutput,
  readConfiguredNpmCommand,
  resolvePackageManagerCommand,
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

describe('findInstalledNpmPackagePath', () => {
  it('matches version-qualified npm extension sources from pi list', () => {
    expect(
      findInstalledNpmPackagePath(
        [
          { source: 'npm:pi-codex-goal@0.1.21', installedPath: '/tmp/pi-codex-goal' },
          { source: 'npm:pi-subagents', installedPath: '/tmp/pi-subagents' },
        ],
        'pi-codex-goal',
      ),
    ).toBe('/tmp/pi-codex-goal');
  });
});

describe('compareVersions', () => {
  it('orders semver-like strings correctly', () => {
    expect(compareVersions('0.12.2', '0.12.2')).toBe(0);
    expect(compareVersions('0.12.3', '0.12.2')).toBeGreaterThan(0);
    expect(compareVersions('0.11.9', '0.12.2')).toBeLessThan(0);
  });
});

describe('package manager command resolution', () => {
  it('uses npmCommand from pi settings before other package managers', () => {
    const dir = makeTempDir('pi-settings-');
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({ npmCommand: ['mise', 'exec', 'node@22', '--', 'npm'] }),
    );

    expect(readConfiguredNpmCommand({ settingsPath })).toEqual([
      'mise',
      'exec',
      'node@22',
      '--',
      'npm',
    ]);
    expect(
      getPackageManagerCommandCandidates({
        settingsPath,
        isCommandAvailable: () => true,
      }).slice(0, 2),
    ).toEqual([
      { command: 'mise', args: ['exec', 'node@22', '--', 'npm'], source: 'settings' },
      { command: 'aube', args: [], source: 'aube' },
    ]);
  });

  it('prefers aube over pnpm when settings do not configure npmCommand', () => {
    const dir = makeTempDir('pi-settings-');
    const settingsPath = join(dir, 'missing-settings.json');

    expect(
      resolvePackageManagerCommand({
        settingsPath,
        isCommandAvailable: (command) => command === 'aube',
      }),
    ).toEqual({ command: 'aube', args: [], source: 'aube' });
  });

  it('falls back to pnpm when settings are unset and aube is unavailable', () => {
    const dir = makeTempDir('pi-settings-');
    const settingsPath = join(dir, 'missing-settings.json');

    expect(
      resolvePackageManagerCommand({
        settingsPath,
        isCommandAvailable: () => false,
      }),
    ).toEqual({ command: 'pnpm', args: [], source: 'pnpm' });
  });

  it('deduplicates aube when settings already point at aube', () => {
    const dir = makeTempDir('pi-settings-');
    const settingsPath = join(dir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ npmCommand: ['aube'] }));

    expect(
      getPackageManagerCommandCandidates({
        settingsPath,
        isCommandAvailable: (command) => command === 'aube',
      }),
    ).toEqual([
      { command: 'aube', args: [], source: 'settings' },
      { command: 'pnpm', args: [], source: 'pnpm' },
    ]);
  });

  it('formats wrapper commands for display', () => {
    expect(
      formatPackageManagerCommand(
        { command: 'mise', args: ['exec', 'node@22', '--', 'npm'], source: 'settings' },
        ['install', '@scope/pkg name'],
      ),
    ).toBe('mise exec node@22 -- npm install "@scope/pkg name"');
  });
});

describe('pi-mermaid patching', () => {
  const FIXTURE_CONTENT = [
    'import type { ExtensionAPI, ExtensionContext, MessageRenderer, SessionEntry } from "@mariozechner/pi-coding-agent";',
    'import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";',
    'import { Box, Spacer, Text, type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";',
    'import { createHash } from "node:crypto";',
    'import { renderMermaidAscii } from "beautiful-mermaid";',
    '',
    'function renderAsciiVariant(block: string, diagramHash: string, preset: AsciiPreset): AsciiVariant {',
    '\tconst cacheKey = getAsciiCacheKey(diagramHash, preset.key);',
    '\tconst cached = getCachedVariant(cacheKey);',
    '\tif (cached) return cached;',
    '',
    '\tconst ascii = renderMermaidAscii(block, {',
    '\t\tpaddingX: preset.paddingX,',
    '\t\tboxBorderPadding: preset.boxBorderPadding,',
    '\t\tcolorMode: "none",',
    '\t}).trimEnd();',
    '\treturn { presetKey: preset.key, ascii, lineCount: 1, maxLineWidth: 1 };',
    '}',
    '',
    'async function processBlock() {',
    '\tconst variants: AsciiVariant[] = [];',
    '\tfor (const preset of ASCII_PRESETS) {',
    '\t\ttry {',
    '\t\t\tvariants.push(renderAsciiVariant(block, diagramHash, preset));',
    '\t\t} catch (error) {',
    '\t\t\tconsole.error(error);',
    '\t\t}',
    '\t}',
    '}',
    '',
  ].join('\n');

  function setupFakePackage(version: string, indexContent = FIXTURE_CONTENT): string {
    const packageRoot = makeTempDir('pi-mermaid-');
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'pi-mermaid', version }, null, 2),
    );
    writeFileSync(join(packageRoot, 'index.ts'), indexContent);
    return packageRoot;
  }

  it('reports unpatched fixture as not yet patched', () => {
    const packageRoot = setupFakePackage('0.3.0');
    expect(isPiMermaidPatchApplied(packageRoot)).toBe(false);
  });

  it('patches imports and lazy-loads beautiful-mermaid through dynamic import', async () => {
    const packageRoot = setupFakePackage('0.3.0');
    const result = await applyPiMermaidPatch({ packageRoot });

    expect(result).toMatchObject({
      status: 'applied',
      packageRoot,
      version: '0.3.0',
    });
    expect(result.patchPath).toBe(join(packageRoot, 'index.ts'));

    const patched = readFileSync(join(packageRoot, 'index.ts'), 'utf8');
    expect(patched).toContain('@earendil-works/pi-coding-agent');
    expect(patched).toContain('@earendil-works/pi-tui');
    expect(patched).not.toContain('@mariozechner/pi-coding-agent');
    expect(patched).not.toContain('@mariozechner/pi-tui');
    expect(patched).toContain('__pi_update_extensions:pi-mermaid-earendil-dynamic-import__');
    expect(patched).toContain('import("beautiful-mermaid").then((mod) => mod.renderMermaidAscii)');
    expect(patched).toContain('async function renderAsciiVariant');
    expect(patched).toContain('const renderMermaidAscii = await getRenderMermaidAscii();');
    expect(patched).toContain(
      'variants.push(await renderAsciiVariant(block, diagramHash, preset));',
    );
    expect(isPiMermaidPatchApplied(packageRoot)).toBe(true);
  });

  it('is idempotent after patching', async () => {
    const packageRoot = setupFakePackage('0.3.0');
    await applyPiMermaidPatch({ packageRoot });
    const second = await applyPiMermaidPatch({ packageRoot });

    expect(second).toMatchObject({
      status: 'already-applied',
      packageRoot,
      version: '0.3.0',
    });
  });

  it('supports dry-run without mutating the extension', async () => {
    const packageRoot = setupFakePackage('0.3.0');
    const indexPath = join(packageRoot, 'index.ts');
    const original = readFileSync(indexPath, 'utf8');

    const result = await applyPiMermaidPatch({ packageRoot, dryRun: true });
    expect(result).toMatchObject({
      status: 'would-apply',
      packageRoot,
      version: '0.3.0',
    });
    expect(readFileSync(indexPath, 'utf8')).toBe(original);
    expect(isPiMermaidPatchApplied(packageRoot)).toBe(false);
  });

  it('treats the pre-existing manual patch as applied', () => {
    const packageRoot = setupFakePackage(
      '0.3.0',
      FIXTURE_CONTENT.replaceAll('@mariozechner/', '@earendil-works/')
        .replace(
          'import { renderMermaidAscii } from "beautiful-mermaid";\n',
          'type RenderMermaidAscii = typeof import("beautiful-mermaid")["renderMermaidAscii"];\nlet renderMermaidAsciiPromise: Promise<RenderMermaidAscii> | null = null;\n\nasync function getRenderMermaidAscii(): Promise<RenderMermaidAscii> {\n\tif (!renderMermaidAsciiPromise) {\n\t\trenderMermaidAsciiPromise = import("beautiful-mermaid").then((mod) => mod.renderMermaidAscii);\n\t}\n\treturn renderMermaidAsciiPromise;\n}\n',
        )
        .replace('function renderAsciiVariant', 'async function renderAsciiVariant')
        .replace(
          '\tconst ascii = renderMermaidAscii(block, {',
          '\tconst renderMermaidAscii = await getRenderMermaidAscii();\n\tconst ascii = renderMermaidAscii(block, {',
        )
        .replace(
          'variants.push(renderAsciiVariant(block, diagramHash, preset));',
          'variants.push(await renderAsciiVariant(block, diagramHash, preset));',
        ),
    );

    expect(isPiMermaidPatchApplied(packageRoot)).toBe(true);
  });

  it('throws a descriptive error when the target text is missing', async () => {
    const packageRoot = setupFakePackage('1.0.0', 'export default function extension() {}\n');
    await expect(applyPiMermaidPatch({ packageRoot })).rejects.toThrow(
      /target text for pi-mermaid patch not found/i,
    );
  });
});

describe('pi-continuous-learning patching', () => {
  const INDEX_CONTENT = [
    'import { loadSkills } from "@mariozechner/pi-coding-agent";',
    'export default function extension() { return loadSkills; }',
    '',
  ].join('\n');

  const FACT_TOOLS_CONTENT = [
    'import { StringEnum } from "@mariozechner/pi-ai";',
    'export const schema = StringEnum(["instinct"]);',
    '',
  ].join('\n');

  const ANALYZE_CONTENT = [
    'import { AuthStorage } from "@mariozechner/pi-coding-agent";',
    'export async function analyze() {',
    '  const { loadSkills } = await import("@mariozechner/pi-coding-agent");',
    '  return { AuthStorage, loadSkills };',
    '}',
    '',
  ].join('\n');

  const ANALYZE_MODEL_CONTENT = [
    'import { getModel } from "@mariozechner/pi-ai";',
    'export const model = getModel;',
    '',
  ].join('\n');

  function setupFakePackage(version: string, patched = false): string {
    const packageRoot = makeTempDir('pi-continuous-learning-');
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'pi-continuous-learning', version }, null, 2),
    );
    mkdirSync(join(packageRoot, 'dist', 'cli'), { recursive: true });
    const transform = (content: string) =>
      patched ? content.replaceAll('@mariozechner/', '@earendil-works/') : content;
    writeFileSync(join(packageRoot, 'dist', 'index.js'), transform(INDEX_CONTENT));
    writeFileSync(join(packageRoot, 'dist', 'fact-tools.js'), transform(FACT_TOOLS_CONTENT));
    writeFileSync(join(packageRoot, 'dist', 'cli', 'analyze.js'), transform(ANALYZE_CONTENT));
    writeFileSync(
      join(packageRoot, 'dist', 'cli', 'analyze-model.js'),
      transform(ANALYZE_MODEL_CONTENT),
    );
    return packageRoot;
  }

  it('reports unpatched fixture as not yet patched', () => {
    const packageRoot = setupFakePackage('0.14.0');
    expect(isPiContinuousLearningPatchApplied(packageRoot)).toBe(false);
  });

  it('patches old pi namespace imports in compiled runtime JavaScript', async () => {
    const packageRoot = setupFakePackage('0.14.0');
    const result = await applyPiContinuousLearningPatch({ packageRoot });

    expect(result).toMatchObject({
      status: 'applied',
      packageRoot,
      version: '0.14.0',
    });
    expect(result.patchPath).toBe(join(packageRoot, 'dist'));

    for (const relativePath of [
      'dist/index.js',
      'dist/fact-tools.js',
      'dist/cli/analyze.js',
      'dist/cli/analyze-model.js',
    ]) {
      const patched = readFileSync(join(packageRoot, relativePath), 'utf8');
      expect(patched).not.toContain('@mariozechner/');
      expect(patched).toContain('@earendil-works/');
    }
    expect(isPiContinuousLearningPatchApplied(packageRoot)).toBe(true);
  });

  it('is idempotent after patching', async () => {
    const packageRoot = setupFakePackage('0.14.0');
    await applyPiContinuousLearningPatch({ packageRoot });
    const second = await applyPiContinuousLearningPatch({ packageRoot });

    expect(second).toMatchObject({
      status: 'already-applied',
      packageRoot,
      version: '0.14.0',
    });
  });

  it('supports dry-run without mutating compiled files', async () => {
    const packageRoot = setupFakePackage('0.14.0');
    const analyzePath = join(packageRoot, 'dist', 'cli', 'analyze.js');
    const original = readFileSync(analyzePath, 'utf8');

    const result = await applyPiContinuousLearningPatch({ packageRoot, dryRun: true });
    expect(result).toMatchObject({
      status: 'would-apply',
      packageRoot,
      version: '0.14.0',
    });
    expect(readFileSync(analyzePath, 'utf8')).toBe(original);
    expect(isPiContinuousLearningPatchApplied(packageRoot)).toBe(false);
  });

  it('treats a pre-existing manual namespace patch as applied', () => {
    const packageRoot = setupFakePackage('0.14.0', true);
    expect(isPiContinuousLearningPatchApplied(packageRoot)).toBe(true);
  });

  it('throws a descriptive error when dist is missing', async () => {
    const packageRoot = makeTempDir('pi-continuous-learning-');
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'pi-continuous-learning', version: '1.0.0' }, null, 2),
    );

    await expect(applyPiContinuousLearningPatch({ packageRoot })).rejects.toThrow(
      /compiled dist directory not found/i,
    );
  });
});

describe('pi-subagents intercom detach patching', () => {
  const FIXTURE_CONTENT = [
    'function runSingleAttempt(options) {',
    '		let detached = false;',
    '		let intercomStarted = false;',
    '		let assistantError: string | undefined;',
    '',
    '	const processLine = (line) => {',
    '			let evt: { type?: string; message?: Message; toolName?: string; args?: unknown };',
    '			try {',
    '				evt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown };',
    '			} catch {',
    '				return;',
    '			}',
    '',
    '			if (evt.type === "tool_execution_start") {',
    '				const toolArgs = evt.args && typeof evt.args === "object" && !Array.isArray(evt.args)',
    '					? evt.args as Record<string, unknown>',
    '					: {};',
    '				if (options.allowIntercomDetach && (evt.toolName === "intercom" || evt.toolName === "contact_supervisor")) {',
    '					intercomStarted = true;',
    '				}',
    '			}',
    '',
    '			if (evt.type === "tool_result_end" && evt.message) {',
    '				result.messages.push(evt.message);',
    '			}',
    '	};',
    '}',
    '',
  ].join('\n');

  function setupFakePackage(version: string, executionContent = FIXTURE_CONTENT): string {
    const packageRoot = makeTempDir('pi-subagents-');
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'pi-subagents', version }, null, 2),
    );
    mkdirSync(join(packageRoot, 'src', 'runs', 'foreground'), { recursive: true });
    writeFileSync(join(packageRoot, 'src', 'runs', 'foreground', 'execution.ts'), executionContent);
    return packageRoot;
  }

  it('reports unpatched fixture as not yet patched', () => {
    const packageRoot = setupFakePackage('0.27.0');
    expect(isPiSubagentsIntercomDetachPatchApplied(packageRoot)).toBe(false);
  });

  it('patches foreground sync runs to detach after blocking supervisor asks are sent', async () => {
    const packageRoot = setupFakePackage('0.27.0');
    const result = await applyPiSubagentsIntercomDetachPatch({ packageRoot });

    expect(result).toMatchObject({
      status: 'applied',
      packageRoot,
      version: '0.27.0',
    });
    expect(result.patchPath).toBe(join(packageRoot, 'src', 'runs', 'foreground', 'execution.ts'));

    const patched = readFileSync(
      join(packageRoot, 'src', 'runs', 'foreground', 'execution.ts'),
      'utf8',
    );
    expect(patched).toContain('__pi_update_extensions:pi-subagents-blocking-intercom-detach__');
    expect(patched).toContain('let blockingIntercomStarted = false;');
    expect(patched).toContain('evt.customType === "intercom_sent"');
    expect(patched).toContain('toolArgs.reason !== "progress_update"');
    expect(patched).toContain('blockingIntercomStarted = false;');
    expect(isPiSubagentsIntercomDetachPatchApplied(packageRoot)).toBe(true);
  });

  it('is idempotent after patching', async () => {
    const packageRoot = setupFakePackage('0.27.0');
    await applyPiSubagentsIntercomDetachPatch({ packageRoot });
    const second = await applyPiSubagentsIntercomDetachPatch({ packageRoot });

    expect(second).toMatchObject({
      status: 'already-applied',
      packageRoot,
      version: '0.27.0',
    });
  });

  it('supports dry-run without mutating the file', async () => {
    const packageRoot = setupFakePackage('0.27.0');
    const executionPath = join(packageRoot, 'src', 'runs', 'foreground', 'execution.ts');
    const original = readFileSync(executionPath, 'utf8');

    const result = await applyPiSubagentsIntercomDetachPatch({ packageRoot, dryRun: true });
    expect(result).toMatchObject({
      status: 'would-apply',
      packageRoot,
      version: '0.27.0',
    });
    expect(readFileSync(executionPath, 'utf8')).toBe(original);
    expect(isPiSubagentsIntercomDetachPatchApplied(packageRoot)).toBe(false);
  });

  it('throws a descriptive error when the target text is missing', async () => {
    const packageRoot = setupFakePackage('1.0.0', 'export function changedUpstream() {}\n');
    await expect(applyPiSubagentsIntercomDetachPatch({ packageRoot })).rejects.toThrow(
      /target text for pi-subagents intercom detach patch not found/i,
    );
  });
});

describe('pi-subagents apply_patch agent tool patching', () => {
  function setupFakePackage(
    version: string,
    agents: Record<string, string> = {
      'worker.md': [
        '---',
        'name: worker',
        'tools: read, grep, find, ls, bash, edit, write, contact_supervisor',
        '---',
        '',
      ].join('\n'),
      'planner.md': ['---', 'name: planner', 'tools: read, write, intercom', '---', ''].join('\n'),
      'oracle.md': [
        '---',
        'name: oracle',
        'tools: read, grep, find, ls, bash, intercom',
        '---',
        '',
      ].join('\n'),
      'already-patched.md': [
        '---',
        'name: already-patched',
        'tools: read, write, apply_patch, intercom',
        '---',
        '',
      ].join('\n'),
    },
  ): string {
    const packageRoot = makeTempDir('pi-subagents-');
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'pi-subagents', version }, null, 2),
    );
    mkdirSync(join(packageRoot, 'agents'), { recursive: true });
    for (const [fileName, content] of Object.entries(agents)) {
      writeFileSync(join(packageRoot, 'agents', fileName), content);
    }
    return packageRoot;
  }

  it('reports unpatched editable agent definitions as not yet patched', () => {
    const packageRoot = setupFakePackage('0.27.0');
    expect(isPiSubagentsApplyPatchToolPatchApplied(packageRoot)).toBe(false);
  });

  it('adds apply_patch dynamically to agents with edit or write tools only', async () => {
    const packageRoot = setupFakePackage('0.27.0');
    const result = await applyPiSubagentsApplyPatchToolPatch({ packageRoot });

    expect(result).toMatchObject({
      status: 'applied',
      packageRoot,
      version: '0.27.0',
    });
    expect(result.patchPath).toBe(join(packageRoot, 'agents'));

    expect(readFileSync(join(packageRoot, 'agents', 'worker.md'), 'utf8')).toContain(
      'tools: read, grep, find, ls, bash, edit, write, contact_supervisor, apply_patch',
    );
    expect(readFileSync(join(packageRoot, 'agents', 'planner.md'), 'utf8')).toContain(
      'tools: read, write, intercom, apply_patch',
    );
    expect(readFileSync(join(packageRoot, 'agents', 'oracle.md'), 'utf8')).toContain(
      'tools: read, grep, find, ls, bash, intercom',
    );
    expect(readFileSync(join(packageRoot, 'agents', 'already-patched.md'), 'utf8')).toContain(
      'tools: read, write, apply_patch, intercom',
    );
    expect(isPiSubagentsApplyPatchToolPatchApplied(packageRoot)).toBe(true);
  });

  it('is idempotent after patching all editable agent definitions', async () => {
    const packageRoot = setupFakePackage('0.27.0');
    await applyPiSubagentsApplyPatchToolPatch({ packageRoot });
    const second = await applyPiSubagentsApplyPatchToolPatch({ packageRoot });

    expect(second).toMatchObject({
      status: 'already-applied',
      packageRoot,
      version: '0.27.0',
    });
  });

  it('supports dry-run without mutating agent definitions', async () => {
    const packageRoot = setupFakePackage('0.27.0');
    const workerPath = join(packageRoot, 'agents', 'worker.md');
    const original = readFileSync(workerPath, 'utf8');

    const result = await applyPiSubagentsApplyPatchToolPatch({ packageRoot, dryRun: true });
    expect(result).toMatchObject({
      status: 'would-apply',
      packageRoot,
      version: '0.27.0',
    });
    expect(readFileSync(workerPath, 'utf8')).toBe(original);
    expect(isPiSubagentsApplyPatchToolPatchApplied(packageRoot)).toBe(false);
  });

  it('throws a descriptive error when the agents directory is missing', async () => {
    const packageRoot = makeTempDir('pi-subagents-');
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'pi-subagents', version: '1.0.0' }, null, 2),
    );

    await expect(applyPiSubagentsApplyPatchToolPatch({ packageRoot })).rejects.toThrow(
      /agents directory not found/i,
    );
  });
});

describe('pi-codex-goal post-compaction continuation patching', () => {
  const FIXTURE_CONTENT = [
    'import type {',
    '  ExtensionContext,',
    '  ExtensionHandler,',
    '  SessionBeforeCompactEvent,',
    '  SessionCompactEvent,',
    '  SessionShutdownEvent,',
    '  SessionStartEvent,',
    '  SessionTreeEvent,',
    '} from "@earendil-works/pi-coding-agent";',
    '',
    'import { compactContinuationPrompt } from "./prompts.js";',
    'import { recoveryPhaseBlocksContinuation } from "./recovery-machine.js";',
    'import { isRecoveryPendingAttention, reasonFromRecoveryPendingAttention } from "./recovery.js";',
    'import { applyStaleQueuedWorkEffects, runStaleQueuedWorkPlan } from "./goal-runtime-event-utils.js";',
    'import type { GoalRuntimeSessionHandlerContext } from "./goal-runtime-event-handler-types.js";',
    '',
    'export function createSessionEventHandlers(deps: GoalRuntimeSessionHandlerContext) {',
    '  const {',
    '    pi,',
    '    runtimeState,',
    '    stateController,',
    '    continuation,',
    '    goalAccounting,',
    '    recoveryRuntime,',
    '    status,',
    '    resetErrorRecovery,',
    '  } = deps;',
    '',
    '  return {',
    '    onSessionCompact: (async (_event, ctx) => {',
    '      if (runStaleQueuedWorkPlan(runtimeState.staleQueuedWorkGuard.planSessionCompact(), ctx, deps)) {',
    '        return;',
    '      }',
    '',
    '      stateController.flushGoalPersistence("runtime");',
    '      recoveryRuntime.onSessionCompact();',
    '      status.refreshUi(ctx);',
    '      if (!recoveryPhaseBlocksContinuation(runtimeState.recoveryState.phase)) {',
    '        continuation.maybeContinueAfterCurrentEvent(ctx);',
    '      }',
    '    }) satisfies ExtensionHandler<SessionCompactEvent>,',
    '  };',
    '}',
    '',
  ].join('\n');

  function setupFakePackage(version: string, handlerContent = FIXTURE_CONTENT): string {
    const packageRoot = makeTempDir('pi-codex-goal-');
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'pi-codex-goal', version }, null, 2),
    );
    mkdirSync(join(packageRoot, 'src'), { recursive: true });
    writeFileSync(join(packageRoot, 'src', 'goal-runtime-session-handlers.ts'), handlerContent);
    return packageRoot;
  }

  it('reports unpatched fixture as not yet patched', () => {
    const packageRoot = setupFakePackage('0.1.21');
    expect(isPiCodexGoalPostCompactionUserFollowupPatchApplied(packageRoot)).toBe(false);
  });

  it('queues a user follow-up after host-overflow compaction before hidden continuation gating', async () => {
    const packageRoot = setupFakePackage('0.1.21');
    const result = await applyPiCodexGoalPostCompactionUserFollowupPatch({ packageRoot });

    expect(result).toMatchObject({
      status: 'applied',
      packageRoot,
      version: '0.1.21',
    });
    expect(result.patchPath).toBe(join(packageRoot, 'src', 'goal-runtime-session-handlers.ts'));

    const patched = readFileSync(
      join(packageRoot, 'src', 'goal-runtime-session-handlers.ts'),
      'utf8',
    );
    expect(patched).toContain(
      '__pi_update_extensions:pi-codex-goal-post-compaction-user-followup__',
    );
    expect(patched).toContain('const postCompactionGoal = stateController.getGoal();');
    expect(patched).toContain(
      'runtimeState.recoveryState.phase.kind === "hostOverflowRecoveringNeedsUserStart"',
    );
    expect(patched).toContain(
      'pi.sendUserMessage(compactContinuationPrompt(postCompactionGoal), {',
    );
    expect(patched).toContain('deliverAs: "followUp"');
    expect(patched.indexOf('pi.sendUserMessage')).toBeLessThan(
      patched.indexOf('continuation.maybeContinueAfterCurrentEvent(ctx);'),
    );
    expect(isPiCodexGoalPostCompactionUserFollowupPatchApplied(packageRoot)).toBe(true);
  });

  it('is idempotent after patching', async () => {
    const packageRoot = setupFakePackage('0.1.21');
    await applyPiCodexGoalPostCompactionUserFollowupPatch({ packageRoot });
    const second = await applyPiCodexGoalPostCompactionUserFollowupPatch({ packageRoot });

    expect(second).toMatchObject({
      status: 'already-applied',
      packageRoot,
      version: '0.1.21',
    });
  });

  it('supports dry-run without mutating the extension', async () => {
    const packageRoot = setupFakePackage('0.1.21');
    const handlerPath = join(packageRoot, 'src', 'goal-runtime-session-handlers.ts');
    const original = readFileSync(handlerPath, 'utf8');

    const result = await applyPiCodexGoalPostCompactionUserFollowupPatch({
      packageRoot,
      dryRun: true,
    });
    expect(result).toMatchObject({
      status: 'would-apply',
      packageRoot,
      version: '0.1.21',
    });
    expect(readFileSync(handlerPath, 'utf8')).toBe(original);
    expect(isPiCodexGoalPostCompactionUserFollowupPatchApplied(packageRoot)).toBe(false);
  });

  it('throws a descriptive error when the target text is missing', async () => {
    const packageRoot = setupFakePackage('1.0.0', 'export function changedUpstream() {}\n');
    await expect(applyPiCodexGoalPostCompactionUserFollowupPatch({ packageRoot })).rejects.toThrow(
      /target text for pi-codex-goal post-compaction user follow-up patch not found/i,
    );
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
      JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }, null, 2),
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
