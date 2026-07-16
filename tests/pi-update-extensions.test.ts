import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyAmasterPiComputerUseAnalyzeScreenshotPatch,
  applyPiCodingAgentResolverPatch,
  applyPiCodingAgentTranscriptCachePatch,
  applyPiContinuousLearningPatch,
  applyPiHerdrPromptGuidancePatch,
  applyPiAiBedrockApiKeyBearerPatch,
  applyPiAiOpenAICodexAuthHeaderPatch,
  applyPiMermaidPatch,
  applyPiSubagentsApplyPatchToolPatch,
  buildPiAiBedrockApiKeyBearerReplacement,
  buildPiAiOpenAICodexAccountIdReplacement,
  buildPiAiOpenAICodexHeaderReplacement,
  buildPiHerdrPromptGuidanceReplacement,
  buildPiCodingAgentResolverReplacement,
  buildPiCodingAgentTranscriptCacheInsertion,
  buildPiApproveBuildsCommand,
  buildPiSelfUpdateCommand,
  compareVersions,
  detectPiInstallPackageManagerFromPath,
  detectPiInstallPackageManagerFromPaths,
  findInstalledNpmPackagePath,
  findPiCodingAgentRootFromExecutable,
  formatPackageManagerCommand,
  getPackageManagerCommandCandidates,
  getPnpmWorkspaceOverrideChanges,
  isPiCodingAgentResolverPatchApplied,
  isPiCodingAgentTranscriptCachePatchApplied,
  isPiContinuousLearningPatchApplied,
  isPiHerdrPromptGuidancePatchApplied,
  isPiAiBedrockApiKeyBearerPatchApplied,
  isPiAiOpenAICodexAuthHeaderPatchApplied,
  isAmasterPiComputerUseAnalyzeScreenshotPatchApplied,
  isPiMermaidPatchApplied,
  isPiSubagentsApplyPatchToolPatchApplied,
  parsePiListOutput,
  parseCliArgs,
  readConfiguredNpmCommand,
  resolvePackageManagerCommand,
  runPiUpdate,
  writePnpmWorkspaceOverrides,
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

describe('pnpm workspace override sync', () => {
  it('updates existing Pi overrides without adding absent ones', () => {
    const workspacePath = join(makeTempDir('pnpm-workspace-'), 'pnpm-workspace.yaml');
    writeFileSync(
      workspacePath,
      [
        'overrides:',
        "  '@earendil-works/pi-ai': 0.80.2",
        "  '@earendil-works/pi-coding-agent': 0.80.2",
        '',
      ].join('\n'),
    );
    const desired = {
      '@earendil-works/pi-agent-core': '0.80.7',
      '@earendil-works/pi-ai': '0.80.7',
      '@earendil-works/pi-coding-agent': '0.80.7',
    };

    const changes = getPnpmWorkspaceOverrideChanges(workspacePath, desired);
    expect(changes).toEqual([
      {
        kind: 'bump',
        name: '@earendil-works/pi-ai',
        from: '0.80.2',
        to: '0.80.7',
      },
      {
        kind: 'bump',
        name: '@earendil-works/pi-coding-agent',
        from: '0.80.2',
        to: '0.80.7',
      },
    ]);

    writePnpmWorkspaceOverrides(workspacePath, changes);
    const updated = readFileSync(workspacePath, 'utf8');
    expect(updated).toContain("'@earendil-works/pi-ai': 0.80.7");
    expect(updated).toContain("'@earendil-works/pi-coding-agent': 0.80.7");
    expect(updated).not.toContain('@earendil-works/pi-agent-core');
  });
});

describe('pi self-update package manager detection', () => {
  it('detects aube-installed pi from the virtual store path', () => {
    expect(
      detectPiInstallPackageManagerFromPath(
        '/Users/me/.cache/aube/virtual-store/@earendil-works+pi-coding-agent@0.79.10-hash/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
      ),
    ).toBe('aube');
  });

  it('resolves the coding-agent package used by the active pi shim', () => {
    const packageRoot = makeTempDir('active-pi-package-');
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '9.9.9' }),
    );
    writeFileSync(join(packageRoot, 'dist', 'cli.js'), 'export {};\n');
    const shimPath = join(makeTempDir('active-pi-shim-'), 'pi');
    writeFileSync(
      shimPath,
      `#!/bin/sh\n# cmd-shim-target=${join(packageRoot, 'dist', 'cli.js')}\n`,
    );

    expect(findPiCodingAgentRootFromExecutable({ piPath: shimPath })).toBe(
      realpathSync(packageRoot),
    );
  });

  it('checks later PATH entries when a shell wrapper appears first', () => {
    expect(
      detectPiInstallPackageManagerFromPaths([
        '/Users/me/.dotfiles/bin/pi',
        '/Users/me/.cache/aube/virtual-store/@earendil-works+pi-coding-agent@0.79.10-hash/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
      ]),
    ).toBe('aube');
  });
  it('builds an aube global update command for pi', () => {
    expect(buildPiSelfUpdateCommand('aube')).toEqual({
      packageManager: 'aube',
      command: 'aube',
      args: ['add', '-g', '@earendil-works/pi-coding-agent@latest'],
    });
  });

  it('maps --approve to aube global approve-builds', () => {
    expect(parseCliArgs(['--approve']).approve).toBe(true);
    expect(buildPiApproveBuildsCommand('aube')).toEqual({
      command: 'aube',
      args: ['approve-builds', '-g', '--all'],
    });
    expect(buildPiApproveBuildsCommand('npm')).toBeUndefined();
  });

  it('runs package-manager self-update before pi extension update', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const logs: string[] = [];

    await runPiUpdate({
      piPath:
        '/Users/me/.cache/aube/virtual-store/@earendil-works+pi-coding-agent@0.79.10-hash/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
      execFile: ((command: string, args: string[]) => {
        calls.push({ command, args });
        return '';
      }) as typeof import('node:child_process').execFileSync,
      log: (message) => logs.push(message),
    });

    expect(calls).toEqual([
      {
        command: 'aube',
        args: ['add', '-g', '@earendil-works/pi-coding-agent@latest'],
      },
      { command: 'pi', args: ['update', '--extensions'] },
    ]);
    expect(logs).toEqual([
      'Ran: aube add -g @earendil-works/pi-coding-agent@latest',
      'Ran: pi update --extensions',
    ]);
  });

  it('runs aube approve-builds when --approve is requested', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const logs: string[] = [];

    await runPiUpdate({
      approve: true,
      piPath:
        '/Users/me/.cache/aube/virtual-store/@earendil-works+pi-coding-agent@0.79.10-hash/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
      execFile: ((command: string, args: string[]) => {
        calls.push({ command, args });
        return '';
      }) as typeof import('node:child_process').execFileSync,
      log: (message) => logs.push(message),
    });

    expect(calls).toEqual([
      {
        command: 'aube',
        args: ['add', '-g', '@earendil-works/pi-coding-agent@latest'],
      },
      { command: 'aube', args: ['approve-builds', '-g', '--all'] },
      { command: 'pi', args: ['update', '--extensions'] },
    ]);
    expect(logs).toContain('Ran: aube approve-builds -g --all');
  });
});

describe('@amaster.ai/pi-computer-use analyze_screenshot patching', () => {
  const FIXTURE_CONTENT = [
    "import { Type } from 'typebox';",
    "import { loadConfigFromFile, resolveConfig } from './config.js';",
    "import { CuaDriverClient } from './mcp-client.js';",
    "import { createPiVisionCaller } from './vision.js';",
    "const TOOL_PREFIX = 'computer_use_';",
    'function computerUseExtension(pi) {',
    '    function registerVisionTool() {',
    '        const visionConfig = {};',
    '        pi.registerTool({',
    '            name: `${TOOL_PREFIX}analyze_screenshot`,',
    '            label: `${TOOL_PREFIX}analyze_screenshot`,',
    "            description: 'Capture a screenshot using ScreenCaptureKit and analyze it visually using a vision model. Returns analysis for a single window in the requested format (default png).\\n\\n`window_id` is required. Get window ids from `list_windows`.\\n\\nRequires the Screen Recording TCC grant — call `check_permissions` first if unsure.',",
    '            parameters: Type.Object({',
    '                window_id: Type.Number({',
    "                    description: 'Required CGWindowID / kCGWindowNumber to capture.',",
    '                }),',
    '                instruction: Type.Optional(Type.String({',
    '                    description: \'What to identify or analyze visually (e.g., "Find the coordinates of the blue submit button").\'',
    '                })),',
    "                format: Type.Optional(Type.Union([Type.Literal('png'), Type.Literal('jpeg')], {",
    "                    description: 'Image format. Default: png.',",
    '                })),',
    '                quality: Type.Optional(Type.Number({',
    "                    description: 'JPEG quality 1-95; ignored for png.',",
    '                    minimum: 1,',
    '                    maximum: 95,',
    '                })),',
    '            }),',
    '            async execute(_toolCallId, params, _signal, _onUpdate, ctx) {',
    '                const screenshotArgs = { window_id: params.window_id };',
    '                if (params.format)',
    '                    screenshotArgs.format = params.format;',
    '                if (params.quality)',
    '                    screenshotArgs.quality = params.quality;',
    "                const screenshotResult = await client.callTool('screenshot', screenshotArgs);",
    "                const imageContent = screenshotResult.content?.find((c) => c.type === 'image' && c.data);",
    "                console.error('[pi-computer-use analyze_screenshot] screenshot result', JSON.stringify({",
    '                    window_id: params.window_id,',
    '                    isError: screenshotResult.isError,',
    '                    contentTypes: screenshotResult.content?.map((c) => c.type),',
    '                    imageDataLength: imageContent?.data?.length,',
    '                    imageMimeType: imageContent?.mimeType,',
    '                }, null, 2));',
    '                if (!imageContent?.data) {',
    '                    const errorText = screenshotResult.content',
    "                        ?.filter((c) => c.type === 'text' && c.text)",
    '                        .map((c) => c.text)',
    "                        .join('\\n') || 'Failed to capture screenshot.';",
    "                    const formatted = formatToolError('screenshot', errorText, params);",
    '                    return {',
    "                        content: [{ type: 'text', text: formatted ?? errorText }],",
    '                        details: undefined,',
    '                        isError: true,',
    '                    };',
    '                }',
    '                const callVision = createPiVisionCaller(visionConfig, ctx);',
    '                const instruction = params.instruction ??',
    "                    'Describe the full screen: identify all visible windows, UI elements, buttons, text fields, and their positions.';",
    "                const analysis = await callVision(instruction, imageContent.data, imageContent.mimeType ?? 'image/png');",
    "                console.error('[pi-computer-use analyze_screenshot] vision analysis', JSON.stringify({",
    '                    analysisLength: analysis.length,',
    '                    analysisPreview: analysis.slice(0, 200),',
    '                }, null, 2));',
    '                return {',
    "                    content: [{ type: 'text', text: analysis }],",
    '                    details: undefined,',
    '                };',
    '            },',
    '        });',
    '    }',
    '}',
    'function formatToolError(toolName, errorText, params) {',
    '    return undefined;',
    '}',
    '',
  ].join('\n');

  function setupFakePackage(version: string, indexContent = FIXTURE_CONTENT): string {
    const packageRoot = makeTempDir('amaster-pi-computer-use-');
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@amaster.ai/pi-computer-use', version }, null, 2),
    );
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(join(packageRoot, 'dist', 'index.js'), indexContent);
    return packageRoot;
  }

  it('reports unpatched fixture as not yet patched', () => {
    const packageRoot = setupFakePackage('0.1.1');
    expect(isAmasterPiComputerUseAnalyzeScreenshotPatchApplied(packageRoot)).toBe(false);
  });

  it('rewires analyze_screenshot to file input or get_window_state capture', async () => {
    const packageRoot = setupFakePackage('0.1.1');
    const result = await applyAmasterPiComputerUseAnalyzeScreenshotPatch({ packageRoot });

    expect(result).toMatchObject({
      status: 'applied',
      packageRoot,
      version: '0.1.1',
    });
    expect(result.patchPath).toBe(join(packageRoot, 'dist', 'index.js'));

    const patched = readFileSync(join(packageRoot, 'dist', 'index.js'), 'utf8');
    expect(patched).toContain(
      '__pi_update_extensions:amaster-computer-use-analyze-get-window-state__',
    );
    expect(patched).toContain('screenshot_file_path');
    expect(patched).toContain("client.callTool('get_window_state'");
    expect(patched).toContain("capture_mode: 'vision'");
    expect(patched).toContain('readScreenshotFileAsBase64');
    expect(patched).not.toContain("client.callTool('screenshot'");
    expect(isAmasterPiComputerUseAnalyzeScreenshotPatchApplied(packageRoot)).toBe(true);
  });

  it('is idempotent after patching', async () => {
    const packageRoot = setupFakePackage('0.1.1');
    await applyAmasterPiComputerUseAnalyzeScreenshotPatch({ packageRoot });
    const second = await applyAmasterPiComputerUseAnalyzeScreenshotPatch({ packageRoot });

    expect(second).toMatchObject({
      status: 'already-applied',
      packageRoot,
      version: '0.1.1',
    });
  });

  it('supports dry-run without mutating the extension', async () => {
    const packageRoot = setupFakePackage('0.1.1');
    const indexPath = join(packageRoot, 'dist', 'index.js');
    const original = readFileSync(indexPath, 'utf8');

    const result = await applyAmasterPiComputerUseAnalyzeScreenshotPatch({
      packageRoot,
      dryRun: true,
    });
    expect(result).toMatchObject({
      status: 'would-apply',
      packageRoot,
      version: '0.1.1',
    });
    expect(readFileSync(indexPath, 'utf8')).toBe(original);
    expect(isAmasterPiComputerUseAnalyzeScreenshotPatchApplied(packageRoot)).toBe(false);
  });

  it('throws a descriptive error when the target text is missing', async () => {
    const packageRoot = setupFakePackage('1.0.0', 'export default function extension() {}\n');
    await expect(applyAmasterPiComputerUseAnalyzeScreenshotPatch({ packageRoot })).rejects.toThrow(
      /target text for @amaster\.ai\/pi-computer-use analyze_screenshot patch not found/i,
    );
  });
});

describe('pi-herdr prompt guidance patching', () => {
  const TARGET_GUIDELINE =
    '\t\t\t"Use friendly aliases such as `server`, `reviewer`, or `tests` for panes created by pane_split, tab_create, or workspace_create.",';
  const BASH_ROUTING_GUIDELINE =
    'When Herdr is explicitly requested, use `bash` for quick one-shot commands and `herdr` for work that needs a real pane: prompts, user input, sudo, persistent cwd/env, logs, sentinels, or follow-up commands.';
  const SUDO_SENTINEL_GUIDELINE =
    'For sudo/user-input flows: split a fresh pane down (`pane_split`, `direction: "down"`), set `focus: true` only when the user must type now, verify readiness, run `sudo -v` with `SUDO_READY:<id>`, keep dependent commands in that pane (sudo auth is per pane/TTY), end with `TASK_DONE:<id>`, `watch` both exact sentinels, read final output, then `stop` one-off panes.';
  const FIXTURE_CONTENT = [
    'export default function extension(pi) {',
    '\tpi.registerTool({',
    '\t\tname: "herdr",',
    '\t\tpromptGuidelines: [',
    '\t\t\t"Use `herdr` only when the user explicitly mentions Herdr or asks to inspect or control Herdr contexts. Do not invoke it merely because background work or delegation might help.",',
    '\t\t\t"When the user asks to use Herdr, default to a sibling pane in the current tab and cwd. Create another tab, workspace, or cwd only when the user requests that topology.",',
    '\t\t\t"Preserve the current UI focus by default. Set focus only when the user explicitly asks to switch context.",',
    '\t\t\t"Use `herdr` run to submit a command or agent prompt because text and Enter are sent atomically. Use `herdr` send only for literal text or key injection without command submission semantics.",',
    '\t\t\t"Use `herdr` watch for normal command output and `herdr` wait_agent only for recognized coding agents.",',
    '\t\t\t"Treat both `idle` and `done` as completed agent states when inspecting status. `done` means the completed result is unseen; `idle` means it is seen.",',
    '\t\t\t"Use `recent-unwrapped` for logs and transcripts, and `detection` only when agent-detection evidence is needed.",',
    '\t\t\t"Pane actions target friendly aliases or opaque pane ids, never tab ids. Read ids from Herdr responses instead of constructing them.",',
    '\t\t\t"When pane_split omits direction, the `herdr` tool chooses right or down from the source pane geometry.",',
    TARGET_GUIDELINE,
    '\t\t],',
    '\t});',
    '}',
    '',
  ].join('\n');

  function setupFakePackage(version: string, indexContent = FIXTURE_CONTENT): string {
    const packageRoot = makeTempDir('pi-herdr-');
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@ogulcancelik/pi-herdr', version }, null, 2),
    );
    writeFileSync(join(packageRoot, 'index.ts'), indexContent);
    return packageRoot;
  }

  it('reports the current upstream fixture as not yet patched', () => {
    const packageRoot = setupFakePackage('0.3.0');
    expect(isPiHerdrPromptGuidancePatchApplied(packageRoot)).toBe(false);
  });

  it('adds scoped bash/herdr routing and sudo sentinel guidance', async () => {
    const packageRoot = setupFakePackage('0.3.0');
    const result = await applyPiHerdrPromptGuidancePatch({ packageRoot });

    expect(result).toMatchObject({
      status: 'applied',
      packageRoot,
      version: '0.3.0',
    });
    expect(result.patchPath).toBe(join(packageRoot, 'index.ts'));

    const patched = readFileSync(join(packageRoot, 'index.ts'), 'utf8');
    expect(patched).toContain('__pi_update_extensions:pi-herdr-prompt-guidance__');
    expect(patched).toContain('Use `herdr` only when the user explicitly mentions Herdr');
    expect(patched).toContain(JSON.stringify(BASH_ROUTING_GUIDELINE));
    expect(patched).toContain(JSON.stringify(SUDO_SENTINEL_GUIDELINE));
    expect(patched).toContain('split a fresh pane down');
    expect(patched).toContain('`SUDO_READY:<id>`');
    expect(patched).toContain('`TASK_DONE:<id>`');
    expect(patched).toContain('`watch` both exact sentinels');
    expect(patched).toContain('read final output, then `stop` one-off panes');
    expect(patched).not.toContain('interactive_shell');
    expect(isPiHerdrPromptGuidancePatchApplied(packageRoot)).toBe(true);
  });

  it('recognizes markerless semantic guidance as already applied', async () => {
    const semanticContent = FIXTURE_CONTENT.replace(
      TARGET_GUIDELINE,
      [
        TARGET_GUIDELINE,
        `\t\t\t${JSON.stringify(BASH_ROUTING_GUIDELINE)},`,
        `\t\t\t${JSON.stringify(SUDO_SENTINEL_GUIDELINE)},`,
      ].join('\n'),
    );
    const packageRoot = setupFakePackage('0.3.0', semanticContent);

    expect(isPiHerdrPromptGuidancePatchApplied(packageRoot)).toBe(true);
    await expect(applyPiHerdrPromptGuidancePatch({ packageRoot })).resolves.toMatchObject({
      status: 'already-applied',
      packageRoot,
      version: '0.3.0',
    });
  });

  it('is idempotent after patching', async () => {
    const packageRoot = setupFakePackage('0.3.0');
    await applyPiHerdrPromptGuidancePatch({ packageRoot });
    const second = await applyPiHerdrPromptGuidancePatch({ packageRoot });

    expect(second).toMatchObject({
      status: 'already-applied',
      packageRoot,
      version: '0.3.0',
    });
  });

  it('supports dry-run without mutating pi-herdr', async () => {
    const packageRoot = setupFakePackage('0.3.0');
    const indexPath = join(packageRoot, 'index.ts');
    const original = readFileSync(indexPath, 'utf8');

    const result = await applyPiHerdrPromptGuidancePatch({ packageRoot, dryRun: true });
    expect(result).toMatchObject({
      status: 'would-apply',
      packageRoot,
      version: '0.3.0',
    });
    expect(readFileSync(indexPath, 'utf8')).toBe(original);
    expect(isPiHerdrPromptGuidancePatchApplied(packageRoot)).toBe(false);
  });

  it('throws a descriptive error when upstream guidance changed', async () => {
    const packageRoot = setupFakePackage('1.0.0', 'export default function extension() {}\n');
    await expect(applyPiHerdrPromptGuidancePatch({ packageRoot })).rejects.toThrow(
      /target text for pi-herdr prompt guidance patch not found/i,
    );
  });

  it('builds scoped guidance without mentioning unavailable interactive shell', () => {
    const replacement = buildPiHerdrPromptGuidanceReplacement();
    expect(replacement).toContain('__pi_update_extensions:pi-herdr-prompt-guidance__');
    expect(replacement).toContain(BASH_ROUTING_GUIDELINE);
    expect(replacement).toContain('`watch` both exact sentinels');
    expect(replacement).not.toContain('interactive_shell');
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
  const CURRENT_UPSTREAM_CONTENT = [
    'export function resolveCliModel(options) {',
    '    const { cliModel, modelRuntime } = options;',
    '    const availableModels = [...modelRuntime.getModels()];',
    '    const model = availableModels[0];',
    '    const rawExactMatches = availableModels.slice(1);',
    '    if (rawExactMatches.length > 0 && !modelRuntime.hasConfiguredAuth(model.provider)) {',
    '            const authenticatedRawMatches = rawExactMatches.filter((m) => modelRuntime.hasConfiguredAuth(m.provider));',
    '                if (authenticatedRawMatches.length === 1) {',
    '            return { model: authenticatedRawMatches[0] };',
    '        }',
    '    }',
    '    return { model };',
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

  it('recognizes the current upstream authenticated disambiguation', async () => {
    const packageRoot = setupFakePackage('0.80.8', CURRENT_UPSTREAM_CONTENT);

    expect(isPiCodingAgentResolverPatchApplied(packageRoot)).toBe(true);
    await expect(applyPiCodingAgentResolverPatch({ packageRoot })).resolves.toMatchObject({
      status: 'already-applied',
      packageRoot,
      version: '0.80.8',
    });
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

describe('pi-coding-agent transcript cache patching', () => {
  const FIXTURE_CONTENT = [
    'class Container {',
    '    children = [];',
    '    addChild(component) { this.children.push(component); }',
    '    removeChild(component) { this.children = this.children.filter((child) => child !== component); }',
    '    clear() { this.children = []; }',
    '    invalidate() { for (const child of this.children) child.invalidate(); }',
    '    render(width) { return this.children.flatMap((child) => child.render(width)); }',
    '}',
    'class ExpandableText {}',
    'class ToolExecutionComponent {}',
    'class AssistantMessageComponent {}',
    'class UserMessageComponent {}',
    'function isExpandable(component) { return typeof component.setExpanded === "function"; }',
    'function isCustomSessionEntry(item) {',
    '    return "type" in item && item.type === "custom";',
    '}',
    'export class InteractiveMode {',
    '    constructor() {',
    '        this.streamingComponent = undefined;',
    '        this.bashComponent = undefined;',
    '        this.pendingTools = new Map();',
    '        this.loadedResourcesContainer = new Container();',
    '        this.ui = { requestRender() {} };',
    '        this.chatContainer = new Container();',
    '    }',
    '    setHiddenThinkingLabel(label) {',
    '        if (this.streamingComponent) {',
    '            this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);',
    '        }',
    '        this.ui.requestRender();',
    '    }',
    '    setToolsExpanded(expanded) {',
    '        for (const container of [this.loadedResourcesContainer, this.chatContainer]) {',
    '            for (const child of container.children) {',
    '                if (isExpandable(child)) {',
    '                    child.setExpanded(expanded);',
    '                }',
    '            }',
    '        }',
    '        this.ui.requestRender();',
    '    }',
    '    settingsHandlers() {',
    '        return {',
    '                onShowImagesChange: (enabled) => {',
    '                    this.settingsManager.setShowImages(enabled);',
    '                    for (const child of this.chatContainer.children) {',
    '                        if (child instanceof ToolExecutionComponent) {',
    '                            child.setShowImages(enabled);',
    '                        }',
    '                    }',
    '                },',
    '                onImageWidthCellsChange: (width) => {',
    '                    this.settingsManager.setImageWidthCells(width);',
    '                    for (const child of this.chatContainer.children) {',
    '                        if (child instanceof ToolExecutionComponent) {',
    '                            child.setImageWidthCells(width);',
    '                        }',
    '                    }',
    '                },',
    '                onOutputPadChange: (padding) => {',
    '                    this.settingsManager.setOutputPad(padding);',
    '                    this.outputPad = padding;',
    '                    if (this.streamingComponent || this.session.isStreaming) {',
    '                        for (const child of this.chatContainer.children) {',
    '                            if (child instanceof AssistantMessageComponent || child instanceof UserMessageComponent) {',
    '                                child.setOutputPad(padding);',
    '                            }',
    '                        }',
    '                        if (this.streamingComponent) {',
    '                            this.streamingComponent.setOutputPad(padding);',
    '                        }',
    '                        this.ui.requestRender();',
    '                        return;',
    '                    }',
    '                    this.rebuildChatFromMessages();',
    '                },',
    '        };',
    '    }',
    '}',
    '',
  ].join('\n');

  function setupFakePackage(version: string, interactiveMode = FIXTURE_CONTENT): string {
    const packageRoot = makeTempDir('pi-coding-agent-transcript-');
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }, null, 2),
    );
    mkdirSync(join(packageRoot, 'dist', 'modes', 'interactive'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'dist', 'modes', 'interactive', 'interactive-mode.js'),
      interactiveMode,
    );
    return packageRoot;
  }

  it('applies a version-guarded transcript prefix cache', async () => {
    const packageRoot = setupFakePackage('0.80.7');
    expect(isPiCodingAgentTranscriptCachePatchApplied(packageRoot)).toBe(false);

    const result = await applyPiCodingAgentTranscriptCachePatch({ packageRoot });
    const patched = readFileSync(
      join(packageRoot, 'dist', 'modes', 'interactive', 'interactive-mode.js'),
      'utf8',
    );

    expect(result).toMatchObject({ status: 'applied', packageRoot, version: '0.80.7' });
    expect(patched).toContain('__pi_update_extensions:transcript-prefix-cache-v2__');
    expect(patched).toContain('class TranscriptContainer extends Container');
    expect(patched).toContain('TRANSCRIPT_LIVE_TAIL_COMPONENTS = 64');
    expect(patched).toContain('PI_TRANSCRIPT_CACHE_DISABLED === "1"');
    expect(patched).toContain('...this.pendingTools.values()');
    expect(patched).toContain('getDynamicChildren');
    expect(patched.match(/invalidateRenderCache\?\.\(\)/g)).toHaveLength(5);
    expect(isPiCodingAgentTranscriptCachePatchApplied(packageRoot)).toBe(true);
  });

  it('keeps pending components live after they move beyond the fixed tail', async () => {
    const packageRoot = setupFakePackage('0.80.7');
    const result = await applyPiCodingAgentTranscriptCachePatch({ packageRoot });
    if (!result.patchPath) throw new Error('Expected transcript patch path');
    const module = (await import(`${pathToFileURL(result.patchPath).href}?${Date.now()}`)) as {
      InteractiveMode: new () => {
        chatContainer: {
          addChild(component: unknown): void;
          render(width: number): string[];
          invalidate(): void;
        };
        pendingTools: Map<string, unknown>;
      };
    };
    const mode = new module.InteractiveMode();
    let firstText = 'initial';
    const first = {
      render: vi.fn(() => [firstText]),
      invalidate: vi.fn(),
    };
    mode.chatContainer.addChild(first);
    for (let index = 1; index < 70; index++) {
      mode.chatContainer.addChild({
        render: vi.fn(() => [`child:${index}`]),
        invalidate: vi.fn(),
      });
    }

    expect(mode.chatContainer.render(80)[0]).toBe('initial');
    expect(first.render).toHaveBeenCalledTimes(1);

    firstText = 'running';
    mode.pendingTools.set('old-tool', first);
    expect(mode.chatContainer.render(80)[0]).toBe('running');
    expect(first.render).toHaveBeenCalledTimes(2);

    firstText = 'complete';
    mode.pendingTools.delete('old-tool');
    expect(mode.chatContainer.render(80)[0]).toBe('complete');
    expect(first.render).toHaveBeenCalledTimes(3);
    mode.chatContainer.render(80);
    expect(first.render).toHaveBeenCalledTimes(3);
  });

  it('rebuilds the prefix after parent invalidation such as a theme change', async () => {
    const packageRoot = setupFakePackage('0.80.7');
    const result = await applyPiCodingAgentTranscriptCachePatch({ packageRoot });
    if (!result.patchPath) throw new Error('Expected transcript patch path');
    const module = (await import(
      `${pathToFileURL(result.patchPath).href}?theme=${Date.now()}`
    )) as {
      InteractiveMode: new () => {
        chatContainer: {
          addChild(component: unknown): void;
          render(width: number): string[];
          invalidate(): void;
        };
      };
    };
    const mode = new module.InteractiveMode();
    let themedText = 'dark';
    const first = {
      render: vi.fn(() => [themedText]),
      invalidate: vi.fn(),
    };
    mode.chatContainer.addChild(first);
    for (let index = 1; index < 70; index++) {
      mode.chatContainer.addChild({
        render: vi.fn(() => [`child:${index}`]),
        invalidate: vi.fn(),
      });
    }

    expect(mode.chatContainer.render(80)[0]).toBe('dark');
    themedText = 'light';
    mode.chatContainer.invalidate();

    expect(mode.chatContainer.render(80)[0]).toBe('light');
    expect(first.invalidate).toHaveBeenCalledTimes(1);
  });

  it('is idempotent after patching', async () => {
    const packageRoot = setupFakePackage('0.80.7');
    await applyPiCodingAgentTranscriptCachePatch({ packageRoot });

    await expect(applyPiCodingAgentTranscriptCachePatch({ packageRoot })).resolves.toMatchObject({
      status: 'already-applied',
      packageRoot,
      version: '0.80.7',
    });
  });

  it('supports dry-run without mutating interactive mode', async () => {
    const packageRoot = setupFakePackage('0.80.7');
    const interactiveModePath = join(
      packageRoot,
      'dist',
      'modes',
      'interactive',
      'interactive-mode.js',
    );

    await expect(
      applyPiCodingAgentTranscriptCachePatch({ packageRoot, dryRun: true }),
    ).resolves.toMatchObject({ status: 'would-apply', packageRoot, version: '0.80.7' });
    expect(readFileSync(interactiveModePath, 'utf8')).toBe(FIXTURE_CONTENT);
  });

  it('fails closed when upstream interactive mode changes', async () => {
    const packageRoot = setupFakePackage('0.81.0', 'export class InteractiveMode {}\n');

    await expect(applyPiCodingAgentTranscriptCachePatch({ packageRoot })).rejects.toThrow(
      /transcript cache target not found/i,
    );
  });

  it('builds a bounded prefix cache with a dynamic live boundary', () => {
    const insertion = buildPiCodingAgentTranscriptCacheInsertion();
    expect(insertion).toContain('cachedPrefixChildren = []');
    expect(insertion).toContain('cachedPrefixLines = []');
    expect(insertion).toContain('TRANSCRIPT_LIVE_TAIL_COMPONENTS');
    expect(insertion).toContain('getDynamicChildren');
    expect(insertion).toContain('prefixEnd = Math.min(prefixEnd, index)');
    expect(insertion).not.toContain('new Map');
  });
});

describe('pi-ai Bedrock apiKey bearer patching', () => {
  const FIXTURE_CONTENT = [
    'export const streamBedrock = (model, context, options = {}) => {',
    '    const config = {};',
    '        // Resolve bearer token for Bedrock API key auth.',
    '        const bearerToken = options.bearerToken || process.env.AWS_BEARER_TOKEN_BEDROCK || undefined;',
    '        const useBearerToken = bearerToken !== undefined && process.env.AWS_BEDROCK_SKIP_AUTH !== "1";',
    '    return config;',
    '};',
    '',
  ].join('\n');

  const PROVIDER_ENV_FIXTURE_CONTENT = [
    'export const streamBedrock = (model, context, options = {}) => {',
    '    const config = {};',
    '        // Resolve bearer token for Bedrock API key auth.',
    '        const skipAuth = getProviderEnvValue("AWS_BEDROCK_SKIP_AUTH", options.env) === "1";',
    '        const bearerToken = options.bearerToken || getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options.env) || undefined;',
    '        const useBearerToken = bearerToken !== undefined && !skipAuth;',
    '    return config;',
    '};',
    '',
  ].join('\n');

  const UPSTREAM_API_KEY_FIXTURE_CONTENT = [
    'export const streamBedrock = (model, context, options = {}) => {',
    '    const config = {};',
    '        const bearerToken =',
    '            options.bearerToken ||',
    '            options.apiKey ||',
    '            getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options.env) ||',
    '            undefined;',
    '    return config;',
    '};',
    '',
  ].join('\n');

  function setupFakePackage(version: string, bedrockContent = FIXTURE_CONTENT): string {
    const packageRoot = makeTempDir('pi-ai-');
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@earendil-works/pi-ai', version }, null, 2),
    );
    mkdirSync(join(packageRoot, 'dist', 'providers'), { recursive: true });
    writeFileSync(join(packageRoot, 'dist', 'providers', 'amazon-bedrock.js'), bedrockContent);
    return packageRoot;
  }

  it('reports unpatched fixture as not yet patched', () => {
    const packageRoot = setupFakePackage('0.78.1');
    expect(isPiAiBedrockApiKeyBearerPatchApplied(packageRoot)).toBe(false);
  });

  it('applies the Bedrock apiKey bearer patch and marks it as applied', async () => {
    const packageRoot = setupFakePackage('0.78.1');
    const result = await applyPiAiBedrockApiKeyBearerPatch({ packageRoot });

    expect(result).toMatchObject({
      status: 'applied',
      packageRoot,
      version: '0.78.1',
    });
    expect(result.patchPath).toBe(join(packageRoot, 'dist', 'providers', 'amazon-bedrock.js'));

    const patched = readFileSync(
      join(packageRoot, 'dist', 'providers', 'amazon-bedrock.js'),
      'utf8',
    );
    expect(patched).toContain('__pi_update_extensions:bedrock-api-key-as-bearer__');
    expect(patched).toContain('options.apiKey');
    expect(patched).toContain('["facade", "facade-full"].includes(model.provider)');
    expect(patched).toContain('envBearerToken');
    expect(patched).toContain('getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options.env)');
    expect(patched).toContain('process.env.AWS_BEARER_TOKEN_BEDROCK');
    expect(patched).not.toContain(
      'const bearerToken = options.bearerToken || process.env.AWS_BEARER_TOKEN_BEDROCK || undefined;',
    );
    expect(isPiAiBedrockApiKeyBearerPatchApplied(packageRoot)).toBe(true);
  });

  it('applies the Bedrock apiKey bearer patch to provider-env-helper upstream builds', async () => {
    const packageRoot = setupFakePackage('0.79.5', PROVIDER_ENV_FIXTURE_CONTENT);
    const result = await applyPiAiBedrockApiKeyBearerPatch({ packageRoot });

    expect(result).toMatchObject({
      status: 'applied',
      packageRoot,
      version: '0.79.5',
    });

    const patched = readFileSync(
      join(packageRoot, 'dist', 'providers', 'amazon-bedrock.js'),
      'utf8',
    );
    expect(patched).toContain('__pi_update_extensions:bedrock-api-key-as-bearer__');
    expect(patched).toContain('envBearerToken');
    expect(patched).toContain('options.apiKey');
    expect(patched).not.toContain(
      'const bearerToken = options.bearerToken || getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options.env) || undefined;',
    );
    expect(isPiAiBedrockApiKeyBearerPatchApplied(packageRoot)).toBe(true);
  });

  it('recognizes the upstream apiKey bearer implementation', async () => {
    const packageRoot = setupFakePackage('0.80.7', UPSTREAM_API_KEY_FIXTURE_CONTENT);

    expect(isPiAiBedrockApiKeyBearerPatchApplied(packageRoot)).toBe(true);
    await expect(applyPiAiBedrockApiKeyBearerPatch({ packageRoot })).resolves.toMatchObject({
      status: 'already-applied',
      packageRoot,
      version: '0.80.7',
    });
  });

  it('is idempotent after patching', async () => {
    const packageRoot = setupFakePackage('0.78.1');
    await applyPiAiBedrockApiKeyBearerPatch({ packageRoot });
    const second = await applyPiAiBedrockApiKeyBearerPatch({ packageRoot });

    expect(second).toMatchObject({
      status: 'already-applied',
      packageRoot,
      version: '0.78.1',
    });
  });

  it('supports dry-run without mutating the file', async () => {
    const packageRoot = setupFakePackage('0.78.1');
    const bedrockPath = join(packageRoot, 'dist', 'providers', 'amazon-bedrock.js');
    const original = readFileSync(bedrockPath, 'utf8');

    const result = await applyPiAiBedrockApiKeyBearerPatch({ packageRoot, dryRun: true });
    expect(result).toMatchObject({
      status: 'would-apply',
      packageRoot,
      version: '0.78.1',
    });
    expect(readFileSync(bedrockPath, 'utf8')).toBe(original);
    expect(isPiAiBedrockApiKeyBearerPatchApplied(packageRoot)).toBe(false);
  });

  it('throws a descriptive error when the target line is missing', async () => {
    const packageRoot = setupFakePackage(
      '1.0.0',
      'export function streamBedrock() { /* upstream rewrote auth setup */ }\n',
    );
    await expect(applyPiAiBedrockApiKeyBearerPatch({ packageRoot })).rejects.toThrow(
      /target line for Bedrock apiKey bearer patch not found/i,
    );
  });

  it('builds a replacement containing the marker and fallback order', () => {
    const replacement = buildPiAiBedrockApiKeyBearerReplacement();
    expect(replacement).toContain('__pi_update_extensions:bedrock-api-key-as-bearer__');
    expect(replacement).toContain('options.bearerToken');
    expect(replacement).toContain('options.apiKey');
    expect(replacement).toContain('getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options.env)');
    expect(replacement).toContain('process.env.AWS_BEARER_TOKEN_BEDROCK');
  });
});

describe('pi-ai OpenAI Codex authHeader patching', () => {
  const FIXTURE_CONTENT = [
    'export const streamOpenAICodexResponses = (model, context, options) => {',
    '    const apiKey = options?.apiKey;',
    '            const accountId = extractAccountId(apiKey);',
    '    const sseHeaders = buildSSEHeaders(model.headers, options?.headers, accountId, apiKey, options?.sessionId);',
    '    return sseHeaders;',
    '};',
    'function buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token) {',
    '    const headers = new Headers(initHeaders);',
    '    for (const [key, value] of Object.entries(additionalHeaders || {})) {',
    '        headers.set(key, value);',
    '    }',
    '    headers.set("Authorization", `Bearer ${token}`);',
    '    headers.set("chatgpt-account-id", accountId);',
    '    headers.set("originator", "pi");',
    '    const userAgent = _os ? `pi (${_os.platform()} ${_os.release()}; ${_os.arch()})` : "pi (browser)";',
    '    headers.set("User-Agent", userAgent);',
    '    return headers;',
    '}',
    '',
  ].join('\n');

  function setupFakePackage(version: string, codexContent = FIXTURE_CONTENT): string {
    const packageRoot = makeTempDir('pi-ai-codex-');
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: '@earendil-works/pi-ai', version }, null, 2),
    );
    mkdirSync(join(packageRoot, 'dist', 'providers'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'dist', 'providers', 'openai-codex-responses.js'),
      codexContent,
    );
    return packageRoot;
  }

  it('reports unpatched fixture as not yet patched', () => {
    const packageRoot = setupFakePackage('0.78.1');
    expect(isPiAiOpenAICodexAuthHeaderPatchApplied(packageRoot)).toBe(false);
  });

  it('applies the Codex authHeader patch and marks it as applied', async () => {
    const packageRoot = setupFakePackage('0.78.1');
    const result = await applyPiAiOpenAICodexAuthHeaderPatch({ packageRoot });

    expect(result).toMatchObject({
      status: 'applied',
      packageRoot,
      version: '0.78.1',
    });
    expect(result.patchPath).toBe(
      join(packageRoot, 'dist', 'providers', 'openai-codex-responses.js'),
    );

    const patched = readFileSync(
      join(packageRoot, 'dist', 'providers', 'openai-codex-responses.js'),
      'utf8',
    );
    expect(patched).toContain('__pi_update_extensions:openai-codex-auth-header__');
    expect(patched).toContain('hasCodexCallerAuthorizationHeader(model.headers, options?.headers)');
    expect(patched).toContain('? undefined');
    expect(patched).toContain(': extractAccountId(apiKey)');
    expect(patched).toContain('if (!headers.has("Authorization"))');
    expect(patched).toContain('if (accountId)');
    expect(isPiAiOpenAICodexAuthHeaderPatchApplied(packageRoot)).toBe(true);
  });

  it('is idempotent after patching', async () => {
    const packageRoot = setupFakePackage('0.78.1');
    await applyPiAiOpenAICodexAuthHeaderPatch({ packageRoot });
    const second = await applyPiAiOpenAICodexAuthHeaderPatch({ packageRoot });

    expect(second).toMatchObject({
      status: 'already-applied',
      packageRoot,
      version: '0.78.1',
    });
  });

  it('supports dry-run without mutating the file', async () => {
    const packageRoot = setupFakePackage('0.78.1');
    const codexPath = join(packageRoot, 'dist', 'providers', 'openai-codex-responses.js');
    const original = readFileSync(codexPath, 'utf8');

    const result = await applyPiAiOpenAICodexAuthHeaderPatch({ packageRoot, dryRun: true });
    expect(result).toMatchObject({
      status: 'would-apply',
      packageRoot,
      version: '0.78.1',
    });
    expect(readFileSync(codexPath, 'utf8')).toBe(original);
    expect(isPiAiOpenAICodexAuthHeaderPatchApplied(packageRoot)).toBe(false);
  });

  it('throws a descriptive error when target text is missing', async () => {
    const packageRoot = setupFakePackage(
      '1.0.0',
      'export function streamOpenAICodexResponses() { /* upstream rewrote auth setup */ }\n',
    );
    await expect(applyPiAiOpenAICodexAuthHeaderPatch({ packageRoot })).rejects.toThrow(
      /target text for OpenAI Codex authHeader patch not found/i,
    );
  });

  it('builds replacements containing the marker and auth-header behavior', () => {
    expect(buildPiAiOpenAICodexAccountIdReplacement()).toContain(
      'hasCodexCallerAuthorizationHeader',
    );
    const headerReplacement = buildPiAiOpenAICodexHeaderReplacement();
    expect(headerReplacement).toContain('__pi_update_extensions:openai-codex-auth-header__');
    expect(headerReplacement).toContain('headers.has("Authorization")');
    expect(headerReplacement).toContain('headers.set("chatgpt-account-id", accountId)');
  });
});
