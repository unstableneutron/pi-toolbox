#!/usr/bin/env bun

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Pi-agent related packages. These are:
 *  - fetched to gitchamber sources after every update (for later inspection)
 *  - pinned in the agent workspace's devDependencies to EXACTLY the same
 *    version the globally installed `pi` CLI uses, via
 *    `syncDevDependenciesWithGlobalPi()`. Keeping a single copy in the dep
 *    tree is required because pi extensions share class identities
 *    (CustomEditor, Editor) across the process boundary.
 */
const GITCHAMBER_PACKAGES = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
] as const;

export const DEFAULT_GITCHAMBER_TIMEOUT_MS = 5 * 60 * 1000;

/** Subset of GITCHAMBER_PACKAGES that must always be pinned in the agent
 * workspace's devDependencies. (Same list today, kept as a separate name
 * for intent clarity.) */
const PI_SIBLING_PACKAGES = GITCHAMBER_PACKAGES;

/** Manual overrides for packages that don't have detectable repo metadata */
const GITCHAMBER_MANUAL_OVERRIDES: Record<string, string> = {
  'pi-boomerang': 'nicobailon/pi-boomerang',
  'pi-intercom': 'nicobailon/pi-intercom',
};

export type UpdateCliArgs = {
  dryRun: boolean;
  help: boolean;
  approve: boolean;
  skipUpdate: boolean;
  skipDepsSync: boolean;
  skipPatch: boolean;
  skipGitchamber: boolean;
  gitchamberTimeoutMs: number;
};

export type DepSyncChange =
  | { kind: 'add'; name: string; to: string }
  | { kind: 'bump'; name: string; from: string; to: string };

export type DepSyncResult = {
  status: 'in-sync' | 'would-update' | 'updated';
  changes: DepSyncChange[];
  piCodingAgentVersion: string;
};

export type GitchamberFetchResult = {
  packageSpec: string;
  version: string;
  status: 'fetched' | 'already-exists' | 'would-fetch' | 'error';
  error?: string;
};

export type ApplyPatchResult = {
  status: 'already-applied' | 'applied' | 'would-apply' | 'skipped';
  packageRoot: string;
  version: string;
  patchPath?: string;
};

export type PackageManagerCommand = {
  command: string;
  args: string[];
  source: 'settings' | 'aube' | 'pnpm';
};

export type PiInstallPackageManager = 'aube' | 'pnpm' | 'npm' | 'yarn' | 'bun' | 'unknown';

export type PiSelfUpdateCommand = {
  packageManager: PiInstallPackageManager;
  command: string;
  args: string[];
};

export type PiApproveBuildsCommand = {
  command: string;
  args: string[];
};

export type InstalledPackage = {
  source: string;
  installedPath: string;
};

export type ResolveExtensionSpecsOptions = {
  cwd?: string;
  piListOutput?: string;
  installedPackages?: InstalledPackage[];
};

// Repo root (this script lives in `<repo>/scripts/`).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function parsePiListOutput(output: string): InstalledPackage[] {
  const packages: InstalledPackage[] = [];
  const lines = output.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trimEnd() ?? '';
    if (!line.startsWith('  ') || line.startsWith('    ')) {
      continue;
    }

    const source = line.trim().replace(/\s+\(filtered\)$/, '');
    const nextLine = lines[index + 1]?.trimEnd() ?? '';
    if (!nextLine.startsWith('    ')) {
      continue;
    }

    packages.push({
      source,
      installedPath: nextLine.trim(),
    });
    index += 1;
  }

  return packages;
}

export function getInstalledPackages(
  options: ResolveExtensionSpecsOptions = {},
): InstalledPackage[] {
  if (options.installedPackages) {
    return options.installedPackages;
  }

  const cwd = options.cwd ?? process.cwd();
  const output = options.piListOutput ?? execFileSync('pi', ['list'], { cwd, encoding: 'utf8' });
  return parsePiListOutput(output);
}

export function compareVersions(left: string, right: string): number {
  const normalize = (value: string) =>
    value
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);

  const leftParts = normalize(left);
  const rightParts = normalize(right);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }

  return 0;
}

// ---------------------------------------------------------------------------
// pi-coding-agent resolver patch
//
// Patches `dist/core/model-resolver.js` in the installed
// @earendil-works/pi-coding-agent so `resolveCliModel` prefers authenticated
// models when matching `--model`, falling back to the full registry only
// when no authenticated models exist (preserving the "--api-key + --model"
// first-time-setup flow).
//
// Why: upstream uses `modelRegistry.getAll()` so fuzzy matching can land on a
// provider the user can't actually call (e.g. amazon-bedrock wins the
// descending-localeCompare tiebreak for bare "claude-opus-4-7" when the user
// has no AWS credentials, producing a confusing "No API key found for
// amazon-bedrock" before the proxied-providers extension ever gets a chance
// to reroute the stream).
//
// Pi 0.84 moved this logic into modelRuntime. Keep a semantic guard so an
// upstream regression is visible, but do not rewrite the installed source.
// ---------------------------------------------------------------------------

const PI_CODING_AGENT_PACKAGE_NAME = '@earendil-works/pi-coding-agent';
const PI_CODING_AGENT_RESOLVER_RELATIVE_PATH = 'dist/core/model-resolver.js';
const PI_CODING_AGENT_RESOLVER_UPSTREAM_SEMANTIC_TARGETS = [
  '    const availableModels = [...modelRuntime.getModels()];',
  '            const authenticatedRawMatches = rawExactMatches.filter((m) => modelRuntime.hasConfiguredAuth(m.provider));',
  '                if (authenticatedRawMatches.length === 1) {',
] as const;

// ---------------------------------------------------------------------------
// pi-coding-agent transcript prefix cache patch
//
// Patches the installed interactive mode at the point where it owns the chat
// container. Completed transcript components are rendered into one bounded,
// width-aware prefix cache while a conservative recent tail stays live. This
// avoids extension-startup monkeypatching and keeps streaming/tool components
// responsive. PI_TRANSCRIPT_CACHE_DISABLED=1 restores the upstream Container.
// ---------------------------------------------------------------------------

const PI_CODING_AGENT_INTERACTIVE_MODE_RELATIVE_PATH = 'dist/modes/interactive/interactive-mode.js';
const PI_CODING_AGENT_TRANSCRIPT_CACHE_PATCH_MARKER =
  '__pi_update_extensions:transcript-prefix-cache-v2__';
const PI_CODING_AGENT_TRANSCRIPT_CACHE_INSERTION_TARGET = 'function isCustomSessionEntry(item) {';
const PI_CODING_AGENT_TRANSCRIPT_CACHE_CONSTRUCTOR_TARGET =
  '        this.chatContainer = new Container();';
const PI_CODING_AGENT_TRANSCRIPT_CACHE_CONSTRUCTOR_REPLACEMENT = [
  '        this.chatContainer = process.env.PI_TRANSCRIPT_CACHE_DISABLED === "1"',
  '            ? new Container()',
  '            : new TranscriptContainer(() => [',
  '                this.streamingComponent,',
  '                this.bashComponent,',
  '                ...this.pendingTools.values(),',
  '            ].filter(Boolean));',
].join('\n');
const PI_CODING_AGENT_TRANSCRIPT_CACHE_HIDDEN_LABEL_TARGET = [
  '        if (this.streamingComponent) {',
  '            this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);',
  '        }',
  '        this.ui.requestRender();',
].join('\n');
const PI_CODING_AGENT_TRANSCRIPT_CACHE_HIDDEN_LABEL_REPLACEMENT = [
  '        if (this.streamingComponent) {',
  '            this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);',
  '        }',
  '        this.chatContainer.invalidateRenderCache?.();',
  '        this.ui.requestRender();',
].join('\n');
// Expansion follow-up text changed in 0.83: requestRender() became showStatus(...).
const PI_CODING_AGENT_TRANSCRIPT_CACHE_EXPANSION_LOOP = [
  '        for (const container of [this.loadedResourcesContainer, this.chatContainer]) {',
  '            for (const child of container.children) {',
  '                if (isExpandable(child)) {',
  '                    child.setExpanded(expanded);',
  '                }',
  '            }',
  '        }',
].join('\n');
const PI_CODING_AGENT_TRANSCRIPT_CACHE_EXPANSION_FOLLOWUPS = [
  '        this.ui.requestRender();',
  '        this.showStatus(`Tool output: ${expanded ? "expanded" : "collapsed"}`);',
] as const;
const PI_CODING_AGENT_TRANSCRIPT_CACHE_EXPANSION_TARGETS =
  PI_CODING_AGENT_TRANSCRIPT_CACHE_EXPANSION_FOLLOWUPS.map(
    (followup) => `${PI_CODING_AGENT_TRANSCRIPT_CACHE_EXPANSION_LOOP}\n${followup}`,
  );
function buildPiCodingAgentTranscriptCacheExpansionReplacement(target: string): string {
  return target.replace(
    PI_CODING_AGENT_TRANSCRIPT_CACHE_EXPANSION_LOOP,
    `${PI_CODING_AGENT_TRANSCRIPT_CACHE_EXPANSION_LOOP}\n        this.chatContainer.invalidateRenderCache?.();`,
  );
}
const PI_CODING_AGENT_TRANSCRIPT_CACHE_SHOW_IMAGES_TARGET = [
  '                onShowImagesChange: (enabled) => {',
  '                    this.settingsManager.setShowImages(enabled);',
  '                    for (const child of this.chatContainer.children) {',
  '                        if (child instanceof ToolExecutionComponent) {',
  '                            child.setShowImages(enabled);',
  '                        }',
  '                    }',
  '                },',
].join('\n');
const PI_CODING_AGENT_TRANSCRIPT_CACHE_SHOW_IMAGES_REPLACEMENT = [
  '                onShowImagesChange: (enabled) => {',
  '                    this.settingsManager.setShowImages(enabled);',
  '                    for (const child of this.chatContainer.children) {',
  '                        if (child instanceof ToolExecutionComponent) {',
  '                            child.setShowImages(enabled);',
  '                        }',
  '                    }',
  '                    this.chatContainer.invalidateRenderCache?.();',
  '                },',
].join('\n');
const PI_CODING_AGENT_TRANSCRIPT_CACHE_IMAGE_WIDTH_TARGET = [
  '                onImageWidthCellsChange: (width) => {',
  '                    this.settingsManager.setImageWidthCells(width);',
  '                    for (const child of this.chatContainer.children) {',
  '                        if (child instanceof ToolExecutionComponent) {',
  '                            child.setImageWidthCells(width);',
  '                        }',
  '                    }',
  '                },',
].join('\n');
const PI_CODING_AGENT_TRANSCRIPT_CACHE_IMAGE_WIDTH_REPLACEMENT = [
  '                onImageWidthCellsChange: (width) => {',
  '                    this.settingsManager.setImageWidthCells(width);',
  '                    for (const child of this.chatContainer.children) {',
  '                        if (child instanceof ToolExecutionComponent) {',
  '                            child.setImageWidthCells(width);',
  '                        }',
  '                    }',
  '                    this.chatContainer.invalidateRenderCache?.();',
  '                },',
].join('\n');
const PI_CODING_AGENT_TRANSCRIPT_CACHE_OUTPUT_PAD_TARGET = [
  '                        if (this.streamingComponent) {',
  '                            this.streamingComponent.setOutputPad(padding);',
  '                        }',
  '                        this.ui.requestRender();',
  '                        return;',
].join('\n');
const PI_CODING_AGENT_TRANSCRIPT_CACHE_OUTPUT_PAD_REPLACEMENT = [
  '                        if (this.streamingComponent) {',
  '                            this.streamingComponent.setOutputPad(padding);',
  '                        }',
  '                        this.chatContainer.invalidateRenderCache?.();',
  '                        this.ui.requestRender();',
  '                        return;',
].join('\n');

export function buildPiCodingAgentTranscriptCacheInsertion(): string {
  return `// ${PI_CODING_AGENT_TRANSCRIPT_CACHE_PATCH_MARKER}
const TRANSCRIPT_LIVE_TAIL_COMPONENTS = 64;
class TranscriptContainer extends Container {
    cachedWidth;
    cachedPrefixChildren = [];
    cachedPrefixLines = [];
    getDynamicChildren;
    constructor(getDynamicChildren = () => []) {
        super();
        this.getDynamicChildren = getDynamicChildren;
    }
    invalidateRenderCache() {
        this.cachedWidth = undefined;
        this.cachedPrefixChildren = [];
        this.cachedPrefixLines = [];
    }
    removeChild(component) {
        super.removeChild(component);
        this.invalidateRenderCache();
    }
    clear() {
        super.clear();
        this.invalidateRenderCache();
    }
    invalidate() {
        this.invalidateRenderCache();
        super.invalidate();
    }
    hasReusablePrefix(width, prefixEnd) {
        if (this.cachedWidth !== width || this.cachedPrefixChildren.length > prefixEnd) {
            return false;
        }
        for (let index = 0; index < this.cachedPrefixChildren.length; index++) {
            if (this.cachedPrefixChildren[index] !== this.children[index]) {
                return false;
            }
        }
        return true;
    }
    getPrefixEnd() {
        let prefixEnd = Math.max(0, this.children.length - TRANSCRIPT_LIVE_TAIL_COMPONENTS);
        for (const component of this.getDynamicChildren()) {
            const index = this.children.indexOf(component);
            if (index >= 0) prefixEnd = Math.min(prefixEnd, index);
        }
        return prefixEnd;
    }
    render(width) {
        const prefixEnd = this.getPrefixEnd();
        if (!this.hasReusablePrefix(width, prefixEnd)) {
            this.cachedWidth = width;
            this.cachedPrefixChildren = [];
            this.cachedPrefixLines = [];
        }
        for (let index = this.cachedPrefixChildren.length; index < prefixEnd; index++) {
            const child = this.children[index];
            this.cachedPrefixChildren.push(child);
            this.cachedPrefixLines.push(...child.render(width));
        }
        const lines = this.cachedPrefixLines.slice();
        for (let index = prefixEnd; index < this.children.length; index++) {
            lines.push(...this.children[index].render(width));
        }
        return lines;
    }
}`;
}

function getDefaultPiSettingsPath(): string {
  return join(homedir(), '.pi', 'agent', 'settings.json');
}

export function readConfiguredNpmCommand(
  options: { settingsPath?: string } = {},
): string[] | undefined {
  const settingsPath = options.settingsPath ?? getDefaultPiSettingsPath();
  if (!existsSync(settingsPath)) return undefined;

  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { npmCommand?: unknown };
  if (settings.npmCommand === undefined) return undefined;
  if (!Array.isArray(settings.npmCommand)) {
    throw new Error(`Invalid npmCommand in ${settingsPath}: expected an array of strings`);
  }
  if (!settings.npmCommand.every((entry) => typeof entry === 'string')) {
    throw new Error(`Invalid npmCommand in ${settingsPath}: expected an array of strings`);
  }
  return [...settings.npmCommand];
}

function toPackageManagerCommand(
  commandParts: readonly string[] | undefined,
  source: PackageManagerCommand['source'],
): PackageManagerCommand | undefined {
  if (!commandParts || commandParts.length === 0) return undefined;
  const [command, ...args] = commandParts;
  if (!command?.trim()) {
    throw new Error('Invalid package manager command: first entry must be a non-empty command');
  }
  return { command, args, source };
}

function defaultIsCommandAvailable(command: string, cwd: string): boolean {
  const result = spawnSync(command, ['--version'], { cwd, stdio: 'ignore' });
  return !result.error;
}

export function getPackageManagerCommandCandidates(
  options: {
    cwd?: string;
    settingsPath?: string;
    isCommandAvailable?: (command: string) => boolean;
  } = {},
): PackageManagerCommand[] {
  const cwd = options.cwd ?? process.cwd();
  const isCommandAvailable =
    options.isCommandAvailable ?? ((command) => defaultIsCommandAvailable(command, cwd));
  const candidates = [
    toPackageManagerCommand(
      readConfiguredNpmCommand({ settingsPath: options.settingsPath }),
      'settings',
    ),
    isCommandAvailable('aube')
      ? ({ command: 'aube', args: [], source: 'aube' } as const)
      : undefined,
    { command: 'pnpm', args: [], source: 'pnpm' } as const,
  ].filter((candidate): candidate is PackageManagerCommand => !!candidate);

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = [candidate.command, ...candidate.args].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function resolvePackageManagerCommand(
  options: {
    cwd?: string;
    settingsPath?: string;
    isCommandAvailable?: (command: string) => boolean;
  } = {},
): PackageManagerCommand {
  return (
    getPackageManagerCommandCandidates(options)[0] ?? { command: 'pnpm', args: [], source: 'pnpm' }
  );
}

function formatCommandPart(part: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part);
}

export function formatPackageManagerCommand(
  packageManager: PackageManagerCommand,
  args: readonly string[] = [],
): string {
  return [packageManager.command, ...packageManager.args, ...args].map(formatCommandPart).join(' ');
}

export function formatCommand(command: string, args: readonly string[] = []): string {
  return [command, ...args].map(formatCommandPart).join(' ');
}

function normalizePathForDetection(path: string): string {
  return path.toLowerCase().replace(/\\/g, '/');
}

export function detectPiInstallPackageManagerFromPath(path: string): PiInstallPackageManager {
  const normalized = normalizePathForDetection(path);
  if (
    normalized.includes('/global-aube/') ||
    normalized.includes('/.cache/aube/') ||
    normalized.includes('/.aube/')
  ) {
    return 'aube';
  }
  if (normalized.includes('/.pnpm/') || normalized.includes('/pnpm/')) return 'pnpm';
  if (normalized.includes('/.yarn/') || normalized.includes('/yarn/')) return 'yarn';
  if (normalized.includes('/.bun/') || normalized.includes('/install/global/node_modules/'))
    return 'bun';
  if (normalized.includes('/node_modules/') || normalized.includes('/npm/')) return 'npm';
  return 'unknown';
}

export function detectPiInstallPackageManagerFromPaths(
  piPaths: readonly string[],
): PiInstallPackageManager {
  for (const piPath of piPaths) {
    const candidates = [piPath];
    try {
      candidates.push(realpathSync(piPath));
    } catch {
      // The direct path is still useful for non-symlink installs and wrappers.
    }

    for (const candidate of candidates) {
      const packageManager = detectPiInstallPackageManagerFromPath(candidate);
      if (packageManager !== 'unknown') return packageManager;
    }
  }
  return 'unknown';
}

function getPiExecutablePaths(): string[] {
  try {
    return execFileSync('which', ['-a', 'pi'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function preferExternalPiPaths(piPaths: readonly string[]): string[] {
  const workspaceBin = join(REPO_ROOT, 'node_modules', '.bin');
  const externalPaths = piPaths.filter((entry) => !entry.startsWith(workspaceBin));
  return externalPaths.length > 0 ? externalPaths : [...piPaths];
}

function findPiCodingAgentRootFromPath(piPath: string): string | undefined {
  if (!existsSync(piPath)) return undefined;

  const candidates: string[] = [];
  try {
    const shim = readFileSync(piPath, 'utf8');
    const target = shim.match(/^# cmd-shim-target=(.+\/dist\/cli\.js)$/m)?.[1];
    if (target) candidates.push(dirname(dirname(target)));

    // pnpm 10 shims predate cmd-shim-target. Resolve their $basedir-relative
    // CLI path so an older shim can still identify its owning package.
    for (const match of shim.matchAll(/\$(?:basedir|basedir_win)\/([^"'\r\n]*\/dist\/cli\.js)/g)) {
      const relativeTarget = match[1];
      if (relativeTarget) {
        candidates.push(dirname(dirname(resolve(dirname(piPath), relativeTarget))));
      }
    }
  } catch {
    // A native executable or unreadable shim can still use the fallback below.
  }

  try {
    const resolved = realpathSync(piPath);
    if (resolved.endsWith('/dist/cli.js')) candidates.push(dirname(dirname(resolved)));
  } catch {
    // Try any shim-derived candidate.
  }

  for (const candidate of candidates) {
    if (readPackageName(candidate) === PI_CODING_AGENT_PACKAGE_NAME) {
      return realpathSync(candidate);
    }
  }
  return undefined;
}

export function findPiExecutablePath(
  options: { piPaths?: readonly string[] } = {},
): string | undefined {
  const piPaths = preferExternalPiPaths(options.piPaths ?? getPiExecutablePaths());
  return piPaths.find((piPath) => findPiCodingAgentRootFromPath(piPath) !== undefined);
}

export function findPiCodingAgentRootFromExecutable(
  options: { piPath?: string; piPaths?: readonly string[] } = {},
): string | undefined {
  const piPaths = options.piPath
    ? [options.piPath]
    : preferExternalPiPaths(options.piPaths ?? getPiExecutablePaths());
  for (const piPath of piPaths) {
    const packageRoot = findPiCodingAgentRootFromPath(piPath);
    if (packageRoot) return packageRoot;
  }
  return undefined;
}

export function detectPiInstallPackageManager(
  options: { piPath?: string } = {},
): PiInstallPackageManager {
  if (options.piPath) {
    return detectPiInstallPackageManagerFromPaths([options.piPath]);
  }

  const piPaths = getPiExecutablePaths();
  const nonWorkspacePaths = piPaths.filter(
    (entry) => !entry.startsWith(join(REPO_ROOT, 'node_modules', '.bin')),
  );
  return detectPiInstallPackageManagerFromPaths(
    nonWorkspacePaths.length > 0 ? nonWorkspacePaths : piPaths,
  );
}

export function buildPiSelfUpdateCommand(
  packageManager: PiInstallPackageManager,
  packageName = PI_CODING_AGENT_PACKAGE_NAME,
): PiSelfUpdateCommand | undefined {
  switch (packageManager) {
    case 'aube':
      return { packageManager, command: 'aube', args: ['add', '-g', `${packageName}@latest`] };
    case 'pnpm':
      return {
        packageManager,
        command: 'pnpm',
        args: [
          'add',
          '-g',
          `${packageName}@latest`,
          // pnpm 11 delays newly published versions by default. Pi's explicit
          // update command should honor the registry's latest tag immediately.
          '--config.minimum-release-age=0',
        ],
      };
    case 'npm':
      return { packageManager, command: 'npm', args: ['update', '-g', packageName] };
    case 'yarn':
      return { packageManager, command: 'yarn', args: ['global', 'add', `${packageName}@latest`] };
    case 'bun':
      return { packageManager, command: 'bun', args: ['update', '-g', packageName] };
    case 'unknown':
      return undefined;
  }
}

export function buildPiApproveBuildsCommand(
  packageManager: PiInstallPackageManager,
): PiApproveBuildsCommand | undefined {
  if (packageManager !== 'aube') return undefined;
  return { command: 'aube', args: ['approve-builds', '-g', '--all'] };
}

export function buildPiPackageWorkspaceApproveBuildsCommand(
  packageManager: PackageManagerCommand,
): PiApproveBuildsCommand {
  return {
    command: packageManager.command,
    args: [...packageManager.args, 'approve-builds', '--all'],
  };
}

function getDefaultPiPackageWorkspace(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? dirname(getDefaultPiSettingsPath());
  return join(agentDir, 'npm');
}

function findExistingPackageFile(
  packageRoot: string,
  relativePaths: readonly string[],
): string | undefined {
  return relativePaths.map((relativePath) => join(packageRoot, relativePath)).find(existsSync);
}

function readPackageName(packageRoot: string): string | undefined {
  try {
    const packageJsonPath = join(packageRoot, 'package.json');
    if (!existsSync(packageJsonPath)) return undefined;
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: string };
    return packageJson.name;
  } catch {
    return undefined;
  }
}

function findContainingPackageRoot(filePath: string, packageName: string): string | undefined {
  let current = dirname(filePath);
  while (true) {
    if (readPackageName(current) === packageName) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function findPackagePathFromActivePi(packageName: string): string | undefined {
  for (const piPath of preferExternalPiPaths(getPiExecutablePaths())) {
    const piPackageRoot =
      findPiCodingAgentRootFromPath(piPath) ??
      (() => {
        try {
          return findContainingPackageRoot(realpathSync(piPath), PI_CODING_AGENT_PACKAGE_NAME);
        } catch {
          return undefined;
        }
      })();
    if (!piPackageRoot) continue;
    if (packageName === PI_CODING_AGENT_PACKAGE_NAME) return piPackageRoot;

    const dependencyPath = join(piPackageRoot, 'node_modules', packageName);
    if (existsSync(dependencyPath)) return realpathSync(dependencyPath);
  }
  return undefined;
}

function findPackagePathFromGlobalList(
  packageName: string,
  packageManager: PackageManagerCommand,
  cwd: string,
): string | undefined {
  try {
    const output = execFileSync(
      packageManager.command,
      [...packageManager.args, 'list', '-g', '--depth', '0', '--json'],
      { cwd, encoding: 'utf8' },
    );
    const entries = JSON.parse(output) as Array<{
      name?: string;
      path?: string;
      dependencies?: Record<string, { path?: string }>;
    }>;

    for (const entry of entries) {
      const dependencyPath = entry.dependencies?.[packageName]?.path;
      if (dependencyPath && existsSync(dependencyPath)) {
        return realpathSync(dependencyPath);
      }

      if (entry.name !== packageName || !entry.path) continue;
      const nestedPackagePath = join(entry.path, 'node_modules', packageName);
      if (existsSync(nestedPackagePath)) {
        return realpathSync(nestedPackagePath);
      }
      if (readPackageName(entry.path) === packageName) {
        return realpathSync(entry.path);
      }
    }
  } catch {
    // Ignore list parsing and command failures; callers try other strategies.
  }
  return undefined;
}

export function findGlobalPackagePath(
  packageName: string,
  options: {
    cwd?: string;
    settingsPath?: string;
    isCommandAvailable?: (command: string) => boolean;
    packageManagerCommand?: PackageManagerCommand;
  } = {},
): string | undefined {
  if (!options.packageManagerCommand) {
    const activePiPackagePath = findPackagePathFromActivePi(packageName);
    if (activePiPackagePath) return activePiPackagePath;
  }

  // Global package-manager commands should not inherit the project cwd. pnpm,
  // for example, warns when package.json contains npm-style `workspaces`, even
  // for `pnpm root -g` / `pnpm list -g`. Run these global lookups from a neutral
  // cwd while still using the project cwd above for command availability checks.
  const globalCommandCwd = tmpdir();
  const packageManagers = options.packageManagerCommand
    ? [options.packageManagerCommand]
    : (() => {
        const configuredCandidates = getPackageManagerCommandCandidates(options);
        const piInstallManager = detectPiInstallPackageManager();
        const ownerCandidate: PackageManagerCommand | undefined =
          piInstallManager === 'aube' || piInstallManager === 'pnpm'
            ? { command: piInstallManager, args: [], source: piInstallManager }
            : undefined;
        if (!ownerCandidate) return configuredCandidates;
        return [ownerCandidate, ...configuredCandidates].filter(
          (candidate, index, candidates) =>
            candidates.findIndex(
              (other) =>
                other.command === candidate.command &&
                other.args.join('\0') === candidate.args.join('\0'),
            ) === index,
        );
      })();

  for (const packageManager of packageManagers) {
    try {
      const globalRoot = execFileSync(
        packageManager.command,
        [...packageManager.args, 'root', '-g'],
        {
          cwd: globalCommandCwd,
          encoding: 'utf8',
        },
      ).trim();
      if (globalRoot) {
        const packagePath = join(globalRoot, packageName);
        if (existsSync(packagePath)) return realpathSync(packagePath);
      }
    } catch {
      // Try the global list fallback below.
    }

    const listedPackagePath = findPackagePathFromGlobalList(
      packageName,
      packageManager,
      globalCommandCwd,
    );
    if (listedPackagePath) return listedPackagePath;
  }

  return undefined;
}

function findPackagePathInAubeState(
  workspaceRoot: string,
  packageName: string,
): string | undefined {
  type AubeStatePackage = { name?: unknown; package_json_path?: unknown };
  type AubeState = { layout?: { packages?: Record<string, AubeStatePackage> } };

  for (const stateFileName of ['fresh.json', 'state.json']) {
    const statePath = join(workspaceRoot, 'node_modules', '.aube-state', stateFileName);
    if (!existsSync(statePath)) continue;

    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as AubeState;
      const packages = state.layout?.packages;
      if (!packages) continue;

      for (const packageEntry of Object.values(packages)) {
        if (packageEntry.name !== packageName) continue;
        if (typeof packageEntry.package_json_path !== 'string') continue;

        const packageJsonPath = resolve(workspaceRoot, packageEntry.package_json_path);
        if (existsSync(packageJsonPath)) {
          return realpathSync(dirname(packageJsonPath));
        }
      }
    } catch {
      // Ignore malformed temp state files and try other workspaces.
    }
  }

  return undefined;
}

function findPackagePathInPiExtensionTempWorkspaces(packageName: string): string | undefined {
  const tempExtensionsRoot = join(homedir(), '.pi', 'agent', 'tmp', 'extensions', 'npm');
  if (!existsSync(tempExtensionsRoot)) return undefined;

  const workspaceRoots = readdirSync(tempExtensionsRoot)
    .map((entry) => join(tempExtensionsRoot, entry))
    .filter((entryPath) => {
      try {
        return statSync(entryPath).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);

  for (const workspaceRoot of workspaceRoots) {
    const directPackageJsonPath = join(workspaceRoot, 'node_modules', packageName, 'package.json');
    if (existsSync(directPackageJsonPath)) {
      return realpathSync(dirname(directPackageJsonPath));
    }

    const statePackagePath = findPackagePathInAubeState(workspaceRoot, packageName);
    if (statePackagePath) return statePackagePath;
  }

  return undefined;
}

export function hasPiCodingAgentResolverUpstreamFix(packageRoot: string): boolean {
  const filePath = join(packageRoot, PI_CODING_AGENT_RESOLVER_RELATIVE_PATH);
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf8');
  return PI_CODING_AGENT_RESOLVER_UPSTREAM_SEMANTIC_TARGETS.every((target) =>
    content.includes(target),
  );
}

export function verifyPiCodingAgentResolverUpstreamFix(
  options: { packageRoot?: string; cwd?: string } = {},
): { packageRoot: string; version: string; sourcePath: string } {
  const packageRoot =
    options.packageRoot ??
    findPiCodingAgentRootFromExecutable() ??
    findGlobalPackagePath(PI_CODING_AGENT_PACKAGE_NAME, { cwd: options.cwd });
  if (!packageRoot) {
    throw new Error(
      `Could not locate installed ${PI_CODING_AGENT_PACKAGE_NAME} via configured package manager, aube, or pnpm`,
    );
  }

  const version = getPackageVersion(packageRoot) ?? 'unknown';
  const sourcePath = join(packageRoot, PI_CODING_AGENT_RESOLVER_RELATIVE_PATH);
  if (!existsSync(sourcePath)) {
    throw new Error(`pi-coding-agent@${version}: resolver file not found at ${sourcePath}`);
  }
  if (!hasPiCodingAgentResolverUpstreamFix(packageRoot)) {
    throw new Error(
      `pi-coding-agent@${version}: authenticated resolver semantics not found at ${sourcePath}. ` +
        'Pi 0.84.0 or newer is required; update pi-update-extensions.ts if upstream changed.',
    );
  }

  return { packageRoot, version, sourcePath };
}

function writeJavaScriptPatchAtomically(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.pi-update-${process.pid}.mjs`;
  writeFileSync(temporaryPath, content);
  try {
    execFileSync(process.execPath, ['--check', temporaryPath], { stdio: 'pipe' });
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function writeTextPatchAtomically(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.pi-update-${process.pid}.tmp`;
  writeFileSync(temporaryPath, content);
  try {
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function isPiCodingAgentTranscriptCachePatchApplied(packageRoot: string): boolean {
  const filePath = join(packageRoot, PI_CODING_AGENT_INTERACTIVE_MODE_RELATIVE_PATH);
  if (!existsSync(filePath)) return false;
  return readFileSync(filePath, 'utf8').includes(PI_CODING_AGENT_TRANSCRIPT_CACHE_PATCH_MARKER);
}

export async function applyPiCodingAgentTranscriptCachePatch(
  options: { dryRun?: boolean; packageRoot?: string; cwd?: string } = {},
): Promise<ApplyPatchResult> {
  const packageRoot =
    options.packageRoot ??
    findPiCodingAgentRootFromExecutable() ??
    findGlobalPackagePath(PI_CODING_AGENT_PACKAGE_NAME, { cwd: options.cwd });
  if (!packageRoot) {
    throw new Error(
      `Could not locate installed ${PI_CODING_AGENT_PACKAGE_NAME} via configured package manager, aube, or pnpm`,
    );
  }

  const version = getPackageVersion(packageRoot) ?? 'unknown';
  const filePath = join(packageRoot, PI_CODING_AGENT_INTERACTIVE_MODE_RELATIVE_PATH);
  if (!existsSync(filePath)) {
    throw new Error(`pi-coding-agent@${version}: interactive mode not found at ${filePath}`);
  }

  if (isPiCodingAgentTranscriptCachePatchApplied(packageRoot)) {
    return { status: 'already-applied', packageRoot, version, patchPath: filePath };
  }

  const content = readFileSync(filePath, 'utf8');
  const expansionTarget = PI_CODING_AGENT_TRANSCRIPT_CACHE_EXPANSION_TARGETS.find((target) =>
    content.includes(target),
  );
  const requiredTargets = [
    PI_CODING_AGENT_TRANSCRIPT_CACHE_INSERTION_TARGET,
    PI_CODING_AGENT_TRANSCRIPT_CACHE_CONSTRUCTOR_TARGET,
    PI_CODING_AGENT_TRANSCRIPT_CACHE_HIDDEN_LABEL_TARGET,
    expansionTarget,
    PI_CODING_AGENT_TRANSCRIPT_CACHE_SHOW_IMAGES_TARGET,
    PI_CODING_AGENT_TRANSCRIPT_CACHE_IMAGE_WIDTH_TARGET,
    PI_CODING_AGENT_TRANSCRIPT_CACHE_OUTPUT_PAD_TARGET,
  ];
  const missingTarget = requiredTargets.find((target) => !target || !content.includes(target));
  if (missingTarget !== undefined || !expansionTarget) {
    throw new Error(
      `pi-coding-agent@${version}: transcript cache target not found at ${filePath}. ` +
        `Expected exact text: ${JSON.stringify(
          missingTarget ?? PI_CODING_AGENT_TRANSCRIPT_CACHE_EXPANSION_TARGETS[0],
        )}. ` +
        `Upstream may have changed; update pi-update-extensions.ts.`,
    );
  }

  if (options.dryRun) {
    return { status: 'would-apply', packageRoot, version, patchPath: filePath };
  }

  const insertion = `${buildPiCodingAgentTranscriptCacheInsertion()}\n${PI_CODING_AGENT_TRANSCRIPT_CACHE_INSERTION_TARGET}`;
  const patched = content
    .replace(PI_CODING_AGENT_TRANSCRIPT_CACHE_INSERTION_TARGET, insertion)
    .replace(
      PI_CODING_AGENT_TRANSCRIPT_CACHE_CONSTRUCTOR_TARGET,
      PI_CODING_AGENT_TRANSCRIPT_CACHE_CONSTRUCTOR_REPLACEMENT,
    )
    .replace(
      PI_CODING_AGENT_TRANSCRIPT_CACHE_HIDDEN_LABEL_TARGET,
      PI_CODING_AGENT_TRANSCRIPT_CACHE_HIDDEN_LABEL_REPLACEMENT,
    )
    .replace(
      expansionTarget,
      buildPiCodingAgentTranscriptCacheExpansionReplacement(expansionTarget),
    )
    .replace(
      PI_CODING_AGENT_TRANSCRIPT_CACHE_SHOW_IMAGES_TARGET,
      PI_CODING_AGENT_TRANSCRIPT_CACHE_SHOW_IMAGES_REPLACEMENT,
    )
    .replace(
      PI_CODING_AGENT_TRANSCRIPT_CACHE_IMAGE_WIDTH_TARGET,
      PI_CODING_AGENT_TRANSCRIPT_CACHE_IMAGE_WIDTH_REPLACEMENT,
    )
    .replace(
      PI_CODING_AGENT_TRANSCRIPT_CACHE_OUTPUT_PAD_TARGET,
      PI_CODING_AGENT_TRANSCRIPT_CACHE_OUTPUT_PAD_REPLACEMENT,
    );
  writeJavaScriptPatchAtomically(filePath, patched);
  return { status: 'applied', packageRoot, version, patchPath: filePath };
}

// ---------------------------------------------------------------------------
// pi-ai Bedrock provider apiKey bearer verification
//
// Pi 0.84 passes provider apiKey through as the Bedrock bearer token. Verify
// that behavior after updates instead of carrying an installed-source rewrite.
// ---------------------------------------------------------------------------

const PI_AI_PACKAGE_NAME = '@earendil-works/pi-ai';
const PI_AI_BEDROCK_RELATIVE_PATHS = [
  'dist/api/bedrock-converse-stream.js',
  'dist/providers/amazon-bedrock.js',
] as const;

export function hasPiAiBedrockApiKeyBearerUpstreamFix(packageRoot: string): boolean {
  const filePath = findExistingPackageFile(packageRoot, PI_AI_BEDROCK_RELATIVE_PATHS);
  if (!filePath) return false;
  const content = readFileSync(filePath, 'utf8');
  return /const bearerToken\s*=\s*options\.bearerToken\s*\|\|\s*options\.apiKey\s*\|\|/.test(
    content,
  );
}

function findPiAiPackageRoot(options: { cwd?: string } = {}): string | undefined {
  const direct = findGlobalPackagePath(PI_AI_PACKAGE_NAME, { cwd: options.cwd });
  if (direct) return direct;

  const codingAgentRoot = findGlobalPackagePath(PI_CODING_AGENT_PACKAGE_NAME, { cwd: options.cwd });
  if (!codingAgentRoot) return undefined;

  const candidates = [
    join(codingAgentRoot, 'node_modules', '@earendil-works', 'pi-ai'),
    join(codingAgentRoot, '..', 'pi-ai'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && readPackageName(candidate) === PI_AI_PACKAGE_NAME) {
      return realpathSync(candidate);
    }
  }

  return undefined;
}

export function verifyPiAiBedrockApiKeyBearerUpstreamFix(
  options: { packageRoot?: string; cwd?: string } = {},
): { packageRoot: string; version: string; sourcePath: string } {
  const packageRoot = options.packageRoot ?? findPiAiPackageRoot({ cwd: options.cwd });
  if (!packageRoot) {
    throw new Error(
      `Could not locate installed ${PI_AI_PACKAGE_NAME} via configured package manager, aube, or pnpm`,
    );
  }

  const version = getPackageVersion(packageRoot) ?? 'unknown';
  const sourcePath = findExistingPackageFile(packageRoot, PI_AI_BEDROCK_RELATIVE_PATHS);
  if (!sourcePath) {
    throw new Error(
      `pi-ai@${version}: Bedrock provider file not found at any of ${PI_AI_BEDROCK_RELATIVE_PATHS.join(', ')}`,
    );
  }
  if (!hasPiAiBedrockApiKeyBearerUpstreamFix(packageRoot)) {
    throw new Error(
      `pi-ai@${version}: Bedrock apiKey bearer semantics not found at ${sourcePath}. ` +
        'Pi 0.84.0 or newer is required; update pi-update-extensions.ts if upstream changed.',
    );
  }

  return { packageRoot, version, sourcePath };
}

// ---------------------------------------------------------------------------
// pi-ai OpenAI Codex authHeader patch
//
// Patches `dist/providers/openai-codex-responses.js` in the installed
// @earendil-works/pi-ai so OpenAI-Codex-compatible proxy routes that use
// provider-level `apiKey` + `authHeader: true` do not need the apiKey to be a
// ChatGPT JWT with a chatgpt_account_id claim. When request auth already
// supplies Authorization, preserve it and omit chatgpt-account-id.
// ---------------------------------------------------------------------------

const PI_AI_OPENAI_CODEX_RELATIVE_PATHS = [
  'dist/providers/openai-codex-responses.js',
  'dist/api/openai-codex-responses.js',
] as const;
const PI_AI_OPENAI_CODEX_AUTH_HEADER_PATCH_MARKER =
  '__pi_update_extensions:openai-codex-auth-header__';
const PI_AI_OPENAI_CODEX_ACCOUNT_ID_TARGET =
  '            const accountId = extractAccountId(apiKey);';
const PI_AI_OPENAI_CODEX_HEADER_TARGETS = [
  [
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
  ].join('\n'),
  [
    'function buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token) {',
    '    const headers = new Headers(initHeaders);',
    '    for (const [key, value] of Object.entries(additionalHeaders || {})) {',
    '        if (value === null) {',
    '            headers.delete(key);',
    '        }',
    '        else {',
    '            headers.set(key, value);',
    '        }',
    '    }',
    '    headers.set("Authorization", `Bearer ${token}`);',
    '    headers.set("chatgpt-account-id", accountId);',
    '    headers.set("originator", "pi");',
    '    const userAgent = _os ? `pi (${_os.platform()} ${_os.release()}; ${_os.arch()})` : "pi (browser)";',
    '    headers.set("User-Agent", userAgent);',
    '    return headers;',
    '}',
  ].join('\n'),
] as const;

export function buildPiAiOpenAICodexAccountIdReplacement(): string {
  return [
    `            // ${PI_AI_OPENAI_CODEX_AUTH_HEADER_PATCH_MARKER}`,
    `            const accountId = hasCodexCallerAuthorizationHeader(model.headers, options?.headers)`,
    `                ? undefined`,
    `                : extractAccountId(apiKey);`,
  ].join('\n');
}

export function buildPiAiOpenAICodexHeaderReplacement(): string {
  return [
    `// ${PI_AI_OPENAI_CODEX_AUTH_HEADER_PATCH_MARKER}`,
    `function hasCodexHeader(headers, name) {`,
    `    if (!headers)`,
    `        return false;`,
    `    const lowerName = name.toLowerCase();`,
    `    return Object.keys(headers).some((key) => key.toLowerCase() === lowerName);`,
    `}`,
    `function hasCodexCallerAuthorizationHeader(...headerSources) {`,
    `    return headerSources.some((headers) => hasCodexHeader(headers, "authorization"));`,
    `}`,
    `function buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token) {`,
    `    const headers = new Headers(initHeaders);`,
    `    for (const [key, value] of Object.entries(additionalHeaders || {})) {`,
    `        if (value === null) {`,
    `            headers.delete(key);`,
    `        } else {`,
    `            headers.set(key, value);`,
    `        }`,
    `    }`,
    `    if (!headers.has("Authorization")) {`,
    `        headers.set("Authorization", \`Bearer \${token}\`);`,
    `    }`,
    `    if (accountId) {`,
    `        headers.set("chatgpt-account-id", accountId);`,
    `    }`,
    `    headers.set("originator", "pi");`,
    `    const userAgent = _os ? \`pi (\${_os.platform()} \${_os.release()}; \${_os.arch()})\` : "pi (browser)";`,
    `    headers.set("User-Agent", userAgent);`,
    `    return headers;`,
    `}`,
  ].join('\n');
}

export function isPiAiOpenAICodexAuthHeaderPatchApplied(packageRoot: string): boolean {
  const filePath = findExistingPackageFile(packageRoot, PI_AI_OPENAI_CODEX_RELATIVE_PATHS);
  if (!filePath) return false;
  return readFileSync(filePath, 'utf8').includes(PI_AI_OPENAI_CODEX_AUTH_HEADER_PATCH_MARKER);
}

export async function applyPiAiOpenAICodexAuthHeaderPatch(
  options: { dryRun?: boolean; packageRoot?: string; cwd?: string } = {},
): Promise<ApplyPatchResult> {
  const packageRoot = options.packageRoot ?? findPiAiPackageRoot({ cwd: options.cwd });
  if (!packageRoot) {
    throw new Error(
      `Could not locate installed ${PI_AI_PACKAGE_NAME} via configured package manager, aube, or pnpm`,
    );
  }

  const version = getPackageVersion(packageRoot) ?? 'unknown';
  const filePath = findExistingPackageFile(packageRoot, PI_AI_OPENAI_CODEX_RELATIVE_PATHS);
  if (!filePath) {
    throw new Error(
      `pi-ai@${version}: OpenAI Codex provider file not found at any of ${PI_AI_OPENAI_CODEX_RELATIVE_PATHS.join(', ')}`,
    );
  }

  if (isPiAiOpenAICodexAuthHeaderPatchApplied(packageRoot)) {
    return { status: 'already-applied', packageRoot, version, patchPath: filePath };
  }

  const content = readFileSync(filePath, 'utf8');
  const headerTarget = PI_AI_OPENAI_CODEX_HEADER_TARGETS.find((target) => content.includes(target));
  const missingTargets = [
    !content.includes(PI_AI_OPENAI_CODEX_ACCOUNT_ID_TARGET)
      ? PI_AI_OPENAI_CODEX_ACCOUNT_ID_TARGET
      : undefined,
    headerTarget ? undefined : 'buildBaseCodexHeaders',
  ].filter((target): target is string => !!target);
  if (missingTargets.length > 0) {
    throw new Error(
      `pi-ai@${version}: target text for OpenAI Codex authHeader patch not found at ${filePath}. ` +
        `Missing ${missingTargets.length} target(s). Upstream may have changed; update pi-update-extensions.ts.`,
    );
  }

  if (options.dryRun) {
    return { status: 'would-apply', packageRoot, version, patchPath: filePath };
  }

  const patched = content
    .replace(PI_AI_OPENAI_CODEX_ACCOUNT_ID_TARGET, buildPiAiOpenAICodexAccountIdReplacement())
    .replace(headerTarget!, buildPiAiOpenAICodexHeaderReplacement());
  writeFileSync(filePath, patched);
  return { status: 'applied', packageRoot, version, patchPath: filePath };
}

// ---------------------------------------------------------------------------
// @plannotator/pi-extension Codex CLI compatibility patch
//
// Codex 0.147 removed the deprecated `--full-auto` flag. Replace it with the
// documented `--sandbox workspace-write` migration in the review, guide, and
// tour command builders. The sandbox option is global and must precede `exec`.
// ---------------------------------------------------------------------------

const PLANNOTATOR_PI_EXTENSION_PACKAGE_NAME = '@plannotator/pi-extension';
const PLANNOTATOR_CODEX_COMMAND_RELATIVE_PATHS = [
  'generated/codex-review.ts',
  'generated/guide-review.ts',
  'generated/tour-review.ts',
] as const;
const PLANNOTATOR_CODEX_FULL_AUTO_LINE = '    "--full-auto",\n';
const PLANNOTATOR_CODEX_FULL_AUTO_INLINE = '    "--full-auto", "--ephemeral",';
const PLANNOTATOR_CODEX_SANDBOX_LINE = '    "--sandbox", "workspace-write",';
const PLANNOTATOR_CODEX_EXEC_LINE = '    "exec",';

function getPlannotatorCodexCommandBlock(content: string): string | undefined {
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const commandStart = content.indexOf('  const command = [', searchFrom);
    if (commandStart < 0) return undefined;
    const commandEnd = content.indexOf('\n  ];', commandStart);
    if (commandEnd < 0) return undefined;
    const commandBlock = content.slice(commandStart, commandEnd);
    if (commandBlock.includes('    "codex",')) return commandBlock;
    searchFrom = commandEnd + 5;
  }
  return undefined;
}

function isPlannotatorCodexCommandCompatible(content: string): boolean {
  const commandBlock = getPlannotatorCodexCommandBlock(content);
  return Boolean(
    commandBlock?.includes(PLANNOTATOR_CODEX_EXEC_LINE) && !commandBlock.includes('"--full-auto"'),
  );
}

function migratePlannotatorCodexCommand(content: string): string | undefined {
  const commandBlock = getPlannotatorCodexCommandBlock(content);
  if (
    !commandBlock ||
    !commandBlock.includes(PLANNOTATOR_CODEX_EXEC_LINE) ||
    commandBlock.split('"--full-auto"').length !== 2
  ) {
    return undefined;
  }

  let replacement = commandBlock;
  if (replacement.includes(PLANNOTATOR_CODEX_FULL_AUTO_INLINE)) {
    replacement = replacement.replace(PLANNOTATOR_CODEX_FULL_AUTO_INLINE, '    "--ephemeral",');
  } else if (replacement.includes(PLANNOTATOR_CODEX_FULL_AUTO_LINE)) {
    replacement = replacement.replace(PLANNOTATOR_CODEX_FULL_AUTO_LINE, '');
  } else {
    return undefined;
  }

  if (!replacement.includes(PLANNOTATOR_CODEX_SANDBOX_LINE)) {
    replacement = replacement.replace(
      PLANNOTATOR_CODEX_EXEC_LINE,
      `${PLANNOTATOR_CODEX_SANDBOX_LINE}\n${PLANNOTATOR_CODEX_EXEC_LINE}`,
    );
  }
  return content.replace(commandBlock, replacement);
}

export function isPlannotatorCodexCompatibilityPatchApplied(packageRoot: string): boolean {
  return PLANNOTATOR_CODEX_COMMAND_RELATIVE_PATHS.every((relativePath) => {
    const filePath = join(packageRoot, relativePath);
    return (
      existsSync(filePath) && isPlannotatorCodexCommandCompatible(readFileSync(filePath, 'utf8'))
    );
  });
}

export async function applyPlannotatorCodexCompatibilityPatch(
  options: { dryRun?: boolean; packageRoot?: string; cwd?: string } = {},
): Promise<ApplyPatchResult> {
  const packageRoot =
    options.packageRoot ??
    findGlobalPackagePath(PLANNOTATOR_PI_EXTENSION_PACKAGE_NAME, { cwd: options.cwd });
  if (!packageRoot) {
    throw new Error(
      `Could not locate installed ${PLANNOTATOR_PI_EXTENSION_PACKAGE_NAME} via configured package manager, aube, or pnpm`,
    );
  }

  const version = getPackageVersion(packageRoot) ?? 'unknown';
  const patchPath = join(packageRoot, 'generated');
  const updates: Array<{ path: string; content: string }> = [];

  for (const relativePath of PLANNOTATOR_CODEX_COMMAND_RELATIVE_PATHS) {
    const filePath = join(packageRoot, relativePath);
    if (!existsSync(filePath)) {
      throw new Error(
        `${PLANNOTATOR_PI_EXTENSION_PACKAGE_NAME}@${version}: Codex command source not found at ${filePath}`,
      );
    }

    const content = readFileSync(filePath, 'utf8');
    if (isPlannotatorCodexCommandCompatible(content)) continue;
    const patched = migratePlannotatorCodexCommand(content);
    if (!patched) {
      throw new Error(
        `${PLANNOTATOR_PI_EXTENSION_PACKAGE_NAME}@${version}: target text for Codex CLI compatibility patch not found at ${filePath}. ` +
          `Upstream may have changed; update pi-update-extensions.ts.`,
      );
    }
    updates.push({ path: filePath, content: patched });
  }

  if (updates.length === 0) {
    return { status: 'already-applied', packageRoot, version, patchPath };
  }
  if (options.dryRun) {
    return { status: 'would-apply', packageRoot, version, patchPath };
  }
  for (const update of updates) writeTextPatchAtomically(update.path, update.content);
  return { status: 'applied', packageRoot, version, patchPath };
}

// ---------------------------------------------------------------------------
// @amaster.ai/pi-computer-use analyze_screenshot patch
//
// @amaster.ai/pi-computer-use@0.1.1 implements
// `computer_use_analyze_screenshot` by calling an upstream CuaDriver MCP tool
// named `screenshot`. Current CuaDriver versions expose screenshots through
// `get_window_state` with `capture_mode: "vision"` instead. Rewire the tool to
// either read an existing `screenshot_file_path` or capture `pid + window_id`
// through `get_window_state`, keeping base64 conversion internal to the vision
// model call.
// ---------------------------------------------------------------------------

const AMASTER_PI_COMPUTER_USE_PACKAGE_NAME = '@amaster.ai/pi-computer-use';
const AMASTER_PI_COMPUTER_USE_INDEX_RELATIVE_PATH = 'dist/index.js';
const AMASTER_PI_COMPUTER_USE_ANALYZE_PATCH_MARKER =
  '__pi_update_extensions:amaster-computer-use-analyze-get-window-state__';
const AMASTER_PI_COMPUTER_USE_IMPORT_TARGET = "import { Type } from 'typebox';";
const AMASTER_PI_COMPUTER_USE_PARAMS_TARGET = [
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
].join('\n');
const AMASTER_PI_COMPUTER_USE_CAPTURE_TARGET = [
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
].join('\n');
const AMASTER_PI_COMPUTER_USE_FORMAT_ERROR_TARGET =
  'function formatToolError(toolName, errorText, params) {';

function buildAmasterPiComputerUseImportReplacement(): string {
  return [
    AMASTER_PI_COMPUTER_USE_IMPORT_TARGET,
    `// ${AMASTER_PI_COMPUTER_USE_ANALYZE_PATCH_MARKER}`,
    "import { mkdtemp, readFile, rm } from 'node:fs/promises';",
    "import os from 'node:os';",
    "import path from 'node:path';",
  ].join('\n');
}

function buildAmasterPiComputerUseParamsReplacement(): string {
  return [
    '            description: \'Analyze a screenshot visually using a configured vision model. Provide either `screenshot_file_path` for an existing image file, or both `pid` and `window_id` to capture that window via get_window_state(capture_mode="vision").\\n\\nGet pid/window_id from `list_windows` or `get_accessibility_tree`. Capturing a window requires the Screen Recording TCC grant — call `check_permissions` first if unsure.\',',
    '            parameters: Type.Object({',
    '                pid: Type.Optional(Type.Number({',
    "                    description: 'Target process ID. Required with window_id when screenshot_file_path is not provided.',",
    '                })),',
    '                window_id: Type.Optional(Type.Number({',
    "                    description: 'CGWindowID / kCGWindowNumber to capture. Required with pid when screenshot_file_path is not provided.',",
    '                })),',
    '                screenshot_file_path: Type.Optional(Type.String({',
    "                    description: 'Existing local screenshot file to analyze. If provided, pid/window_id are not used.',",
    '                })),',
    '                instruction: Type.Optional(Type.String({',
    '                    description: \'What to identify or analyze visually (e.g., "Find the coordinates of the blue submit button").\'',
    '                })),',
    '            }),',
  ].join('\n');
}

function buildAmasterPiComputerUseCaptureReplacement(): string {
  return [
    '                let screenshot;',
    '                try {',
    '                    screenshot = await resolveComputerUseAnalyzeScreenshotInput(client, params);',
    '                }',
    '                catch (err) {',
    '                    const errorText = err instanceof Error ? err.message : String(err);',
    "                    const formatted = formatToolError('screenshot', errorText, params);",
    '                    return {',
    "                        content: [{ type: 'text', text: formatted ?? errorText }],",
    '                        details: undefined,',
    '                        isError: true,',
    '                    };',
    '                }',
    "                console.error('[pi-computer-use analyze_screenshot] screenshot input', JSON.stringify({",
    "                    source: params.screenshot_file_path ? 'file' : 'get_window_state',",
    '                    pid: params.pid,',
    '                    window_id: params.window_id,',
    '                    screenshotFilePath: params.screenshot_file_path,',
    '                    imageBase64Length: screenshot.imageBase64.length,',
    '                    mimeType: screenshot.mimeType,',
    '                }, null, 2));',
    '                const callVision = createPiVisionCaller(visionConfig, ctx);',
    '                const instruction = params.instruction ??',
    "                    'Describe the full screen: identify all visible windows, UI elements, buttons, text fields, and their positions.';",
    '                const analysis = await callVision(instruction, screenshot.imageBase64, screenshot.mimeType);',
  ].join('\n');
}

function buildAmasterPiComputerUseHelperInsertion(): string {
  return [
    `// ${AMASTER_PI_COMPUTER_USE_ANALYZE_PATCH_MARKER}`,
    'async function resolveComputerUseAnalyzeScreenshotInput(client, params) {',
    "    const hasFile = typeof params.screenshot_file_path === 'string' && params.screenshot_file_path.length > 0;",
    '    const hasWindow = params.pid !== undefined || params.window_id !== undefined;',
    '    if (hasFile && hasWindow) {',
    "        throw new Error('Provide either screenshot_file_path or pid + window_id, not both.');",
    '    }',
    '    if (hasFile) {',
    '        return await readScreenshotFileAsBase64(params.screenshot_file_path);',
    '    }',
    "    if (typeof params.pid !== 'number' || typeof params.window_id !== 'number') {",
    "        throw new Error('Provide screenshot_file_path, or provide both pid and window_id to capture a window.');",
    '    }',
    "    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pi-computer-use-'));",
    '    const screenshotPath = path.join(tempDir, `window-${params.window_id}.png`);',
    '    try {',
    "        const result = await client.callTool('get_window_state', {",
    '            pid: params.pid,',
    '            window_id: params.window_id,',
    "            capture_mode: 'vision',",
    '            screenshot_out_file: screenshotPath,',
    '        });',
    '        if (result.isError) {',
    '            const errorText = result.content',
    "                ?.filter((c) => c.type === 'text' && c.text)",
    '                .map((c) => c.text)',
    "                .join('\\n') || 'Failed to capture screenshot via get_window_state.';",
    '            throw new Error(errorText);',
    '        }',
    '        return await readScreenshotFileAsBase64(screenshotPath);',
    '    }',
    '    finally {',
    '        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);',
    '    }',
    '}',
    'async function readScreenshotFileAsBase64(filePath) {',
    '    const data = await readFile(filePath);',
    '    return {',
    "        imageBase64: data.toString('base64'),",
    '        mimeType: mimeTypeForScreenshotPath(filePath),',
    '    };',
    '}',
    'function mimeTypeForScreenshotPath(filePath) {',
    '    const ext = path.extname(filePath).toLowerCase();',
    "    if (ext === '.jpg' || ext === '.jpeg')",
    "        return 'image/jpeg';",
    "    if (ext === '.webp')",
    "        return 'image/webp';",
    "    if (ext === '.gif')",
    "        return 'image/gif';",
    "    return 'image/png';",
    '}',
    AMASTER_PI_COMPUTER_USE_FORMAT_ERROR_TARGET,
  ].join('\n');
}

function isAmasterPiComputerUseAnalyzeScreenshotSemanticallyPatched(content: string): boolean {
  return (
    content.includes('screenshot_file_path') &&
    content.includes("client.callTool('get_window_state'") &&
    content.includes("capture_mode: 'vision'") &&
    content.includes('readScreenshotFileAsBase64') &&
    !content.includes("client.callTool('screenshot'")
  );
}

export function isAmasterPiComputerUseAnalyzeScreenshotPatchApplied(packageRoot: string): boolean {
  const filePath = join(packageRoot, AMASTER_PI_COMPUTER_USE_INDEX_RELATIVE_PATH);
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf8');
  return (
    content.includes(AMASTER_PI_COMPUTER_USE_ANALYZE_PATCH_MARKER) ||
    isAmasterPiComputerUseAnalyzeScreenshotSemanticallyPatched(content)
  );
}

export async function applyAmasterPiComputerUseAnalyzeScreenshotPatch(
  options: { dryRun?: boolean; packageRoot?: string; cwd?: string } = {},
): Promise<ApplyPatchResult> {
  const packageRoot =
    options.packageRoot ??
    findGlobalPackagePath(AMASTER_PI_COMPUTER_USE_PACKAGE_NAME, { cwd: options.cwd }) ??
    findPackagePathInPiExtensionTempWorkspaces(AMASTER_PI_COMPUTER_USE_PACKAGE_NAME);
  if (!packageRoot) {
    throw new Error(
      `Could not locate installed ${AMASTER_PI_COMPUTER_USE_PACKAGE_NAME} via configured package manager, aube, or pnpm`,
    );
  }

  const version = getPackageVersion(packageRoot) ?? 'unknown';
  const filePath = join(packageRoot, AMASTER_PI_COMPUTER_USE_INDEX_RELATIVE_PATH);
  if (!existsSync(filePath)) {
    throw new Error(
      `${AMASTER_PI_COMPUTER_USE_PACKAGE_NAME}@${version}: dist index file not found at ${filePath}`,
    );
  }

  if (isAmasterPiComputerUseAnalyzeScreenshotPatchApplied(packageRoot)) {
    return { status: 'already-applied', packageRoot, version, patchPath: filePath };
  }

  const content = readFileSync(filePath, 'utf8');
  const missingTargets = [
    AMASTER_PI_COMPUTER_USE_IMPORT_TARGET,
    AMASTER_PI_COMPUTER_USE_PARAMS_TARGET,
    AMASTER_PI_COMPUTER_USE_CAPTURE_TARGET,
    AMASTER_PI_COMPUTER_USE_FORMAT_ERROR_TARGET,
  ].filter((target) => !content.includes(target));
  if (missingTargets.length > 0) {
    throw new Error(
      `${AMASTER_PI_COMPUTER_USE_PACKAGE_NAME}@${version}: target text for @amaster.ai/pi-computer-use analyze_screenshot patch not found at ${filePath}. ` +
        `Missing ${missingTargets.length} target(s). Upstream may have changed; update pi-update-extensions.ts.`,
    );
  }

  if (options.dryRun) {
    return { status: 'would-apply', packageRoot, version, patchPath: filePath };
  }

  const patched = content
    .replace(AMASTER_PI_COMPUTER_USE_IMPORT_TARGET, buildAmasterPiComputerUseImportReplacement())
    .replace(AMASTER_PI_COMPUTER_USE_PARAMS_TARGET, buildAmasterPiComputerUseParamsReplacement())
    .replace(AMASTER_PI_COMPUTER_USE_CAPTURE_TARGET, buildAmasterPiComputerUseCaptureReplacement())
    .replace(
      AMASTER_PI_COMPUTER_USE_FORMAT_ERROR_TARGET,
      buildAmasterPiComputerUseHelperInsertion(),
    );
  writeFileSync(filePath, patched);
  return { status: 'applied', packageRoot, version, patchPath: filePath };
}

// ---------------------------------------------------------------------------
// pi-herdr prompt guidance patch
//
// pi-herdr@0.4+ owns herdr_layout / herdr_pane / herdr_agent. Keep the local
// herdr-agent-state fork focused on pane state IPC, and patch herdr_pane's
// promptGuidelines after package updates with bash-routing and sudo sentinel
// guidance that upstream does not ship.
// ---------------------------------------------------------------------------

const PI_HERDR_PACKAGE_NAME = '@ogulcancelik/pi-herdr';
const PI_HERDR_INDEX_RELATIVE_PATH = 'index.ts';
const PI_HERDR_PROMPT_GUIDANCE_PATCH_MARKER = '__pi_update_extensions:pi-herdr-prompt-guidance__';
// Prefer the multi-tool (0.4+) herdr_pane guideline; keep the legacy monotool
// "friendly aliases" line as a fallback for older installs.
const PI_HERDR_PROMPT_GUIDANCE_TARGETS = [
  '\t\t\t"Do not close a Herdr pane you did not create unless the user explicitly asks. herdr_pane always refuses to close the pane running the current pi process.",',
  '\t\t\t"Use friendly aliases such as `server`, `reviewer`, or `tests` for panes created by pane_split, tab_create, or workspace_create.",',
] as const;

const PI_HERDR_BASH_ROUTING_GUIDELINE =
  'When Herdr is explicitly requested, use `bash` for quick one-shot commands and `herdr_pane` for work that needs a real pane: prompts, user input, sudo, persistent cwd/env, logs, sentinels, or follow-up commands.';
const PI_HERDR_SUDO_SENTINEL_GUIDELINE =
  'For sudo/user-input flows: use herdr_layout pane_split with direction "down", set focus true only when the user must type now, run `sudo -v` with `SUDO_READY:<id>` via herdr_pane run, keep dependent commands in that pane (sudo auth is per pane/TTY), end with `TASK_DONE:<id>`, wait_output for both exact sentinels, read final output, then close one-off panes you created.';

export function buildPiHerdrPromptGuidanceReplacement(target: string): string {
  return [
    target,
    `\t\t\t// ${PI_HERDR_PROMPT_GUIDANCE_PATCH_MARKER}`,
    `\t\t\t${JSON.stringify(PI_HERDR_BASH_ROUTING_GUIDELINE)},`,
    `\t\t\t${JSON.stringify(PI_HERDR_SUDO_SENTINEL_GUIDELINE)},`,
  ].join('\n');
}

function isPiHerdrPromptGuidanceSemanticallyPatched(content: string): boolean {
  return (
    content.includes(JSON.stringify(PI_HERDR_BASH_ROUTING_GUIDELINE)) &&
    content.includes(JSON.stringify(PI_HERDR_SUDO_SENTINEL_GUIDELINE))
  );
}

export function isPiHerdrPromptGuidancePatchApplied(packageRoot: string): boolean {
  const filePath = join(packageRoot, PI_HERDR_INDEX_RELATIVE_PATH);
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf8');
  return (
    content.includes(PI_HERDR_PROMPT_GUIDANCE_PATCH_MARKER) ||
    isPiHerdrPromptGuidanceSemanticallyPatched(content)
  );
}

export async function applyPiHerdrPromptGuidancePatch(
  options: { dryRun?: boolean; packageRoot?: string; cwd?: string } = {},
): Promise<ApplyPatchResult> {
  const packageRoot =
    options.packageRoot ?? findGlobalPackagePath(PI_HERDR_PACKAGE_NAME, { cwd: options.cwd });
  if (!packageRoot) {
    throw new Error(
      `Could not locate installed ${PI_HERDR_PACKAGE_NAME} via configured package manager, aube, or pnpm`,
    );
  }

  const version = getPackageVersion(packageRoot) ?? 'unknown';
  const filePath = join(packageRoot, PI_HERDR_INDEX_RELATIVE_PATH);
  if (!existsSync(filePath)) {
    throw new Error(`pi-herdr@${version}: index file not found at ${filePath}`);
  }

  if (isPiHerdrPromptGuidancePatchApplied(packageRoot)) {
    return { status: 'already-applied', packageRoot, version, patchPath: filePath };
  }

  const content = readFileSync(filePath, 'utf8');
  const target = PI_HERDR_PROMPT_GUIDANCE_TARGETS.find((candidate) => content.includes(candidate));
  if (!target) {
    throw new Error(
      `pi-herdr@${version}: target text for pi-herdr prompt guidance patch not found at ${filePath}. ` +
        `Upstream may have changed; update pi-update-extensions.ts.`,
    );
  }

  if (options.dryRun) {
    return { status: 'would-apply', packageRoot, version, patchPath: filePath };
  }

  const patched = content.replace(target, buildPiHerdrPromptGuidanceReplacement(target));
  writeFileSync(filePath, patched);
  return { status: 'applied', packageRoot, version, patchPath: filePath };
}

// ---------------------------------------------------------------------------
// pi-mermaid compatibility patch
//
// Patches the installed pi-mermaid extension after `pi update --extensions`.
// pi-mermaid@0.3.0 still imports the pre-rename @mariozechner/* packages and
// statically imports beautiful-mermaid. Under the @earendil-works CLI this can
// fail extension startup because beautiful-mermaid is ESM-only and the loader
// may try to require it.
//
// The patch moves pi imports to @earendil-works/* and lazy-loads
// beautiful-mermaid through dynamic import from the existing async render path.
// ---------------------------------------------------------------------------

const PI_MERMAID_PACKAGE_NAME = 'pi-mermaid';
const PI_MERMAID_INDEX_RELATIVE_PATH = 'index.ts';
const PI_MERMAID_PATCH_MARKER = '__pi_update_extensions:pi-mermaid-earendil-dynamic-import__';
const PI_MERMAID_IMPORT_TARGET = [
  'import type { ExtensionAPI, ExtensionContext, MessageRenderer, SessionEntry } from "@mariozechner/pi-coding-agent";',
  'import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";',
  'import { Box, Spacer, Text, type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";',
  'import { createHash } from "node:crypto";',
  'import { renderMermaidAscii } from "beautiful-mermaid";',
].join('\n');
const PI_MERMAID_RENDER_FUNCTION_TARGET =
  'function renderAsciiVariant(block: string, diagramHash: string, preset: AsciiPreset): AsciiVariant {';
const PI_MERMAID_RENDER_CALL_TARGET = '\tconst ascii = renderMermaidAscii(block, {';
const PI_MERMAID_VARIANT_PUSH_TARGET =
  'variants.push(renderAsciiVariant(block, diagramHash, preset));';

function buildPiMermaidImportReplacement(): string {
  return [
    `// ${PI_MERMAID_PATCH_MARKER}`,
    'import type { ExtensionAPI, ExtensionContext, MessageRenderer, SessionEntry } from "@earendil-works/pi-coding-agent";',
    'import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";',
    'import { Box, Spacer, Text, type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";',
    'import { createHash } from "node:crypto";',
    '',
    'type RenderMermaidAscii = typeof import("beautiful-mermaid")["renderMermaidAscii"];',
    'let renderMermaidAsciiPromise: Promise<RenderMermaidAscii> | null = null;',
    '',
    'async function getRenderMermaidAscii(): Promise<RenderMermaidAscii> {',
    '\tif (!renderMermaidAsciiPromise) {',
    '\t\trenderMermaidAsciiPromise = import("beautiful-mermaid").then((mod) => mod.renderMermaidAscii);',
    '\t}',
    '\treturn renderMermaidAsciiPromise;',
    '}',
  ].join('\n');
}

function isPiMermaidSemanticallyPatched(content: string): boolean {
  return (
    content.includes('@earendil-works/pi-coding-agent') &&
    content.includes('@earendil-works/pi-tui') &&
    content.includes(
      'type RenderMermaidAscii = typeof import("beautiful-mermaid")["renderMermaidAscii"]',
    ) &&
    content.includes('import("beautiful-mermaid").then((mod) => mod.renderMermaidAscii)') &&
    content.includes('async function renderAsciiVariant') &&
    content.includes('const renderMermaidAscii = await getRenderMermaidAscii();') &&
    content.includes('variants.push(await renderAsciiVariant(block, diagramHash, preset));')
  );
}

export function isPiMermaidPatchApplied(packageRoot: string): boolean {
  const filePath = join(packageRoot, PI_MERMAID_INDEX_RELATIVE_PATH);
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf8');
  return content.includes(PI_MERMAID_PATCH_MARKER) || isPiMermaidSemanticallyPatched(content);
}

export async function applyPiMermaidPatch(
  options: { dryRun?: boolean; packageRoot?: string; cwd?: string } = {},
): Promise<ApplyPatchResult> {
  const packageRoot =
    options.packageRoot ?? findGlobalPackagePath(PI_MERMAID_PACKAGE_NAME, { cwd: options.cwd });
  if (!packageRoot) {
    throw new Error(
      `Could not locate installed ${PI_MERMAID_PACKAGE_NAME} via configured package manager, aube, or pnpm`,
    );
  }

  const version = getPackageVersion(packageRoot) ?? 'unknown';
  const filePath = join(packageRoot, PI_MERMAID_INDEX_RELATIVE_PATH);
  if (!existsSync(filePath)) {
    throw new Error(`pi-mermaid@${version}: extension file not found at ${filePath}`);
  }

  if (isPiMermaidPatchApplied(packageRoot)) {
    return { status: 'already-applied', packageRoot, version, patchPath: filePath };
  }

  const content = readFileSync(filePath, 'utf8');
  const missingTargets = [
    PI_MERMAID_IMPORT_TARGET,
    PI_MERMAID_RENDER_FUNCTION_TARGET,
    PI_MERMAID_RENDER_CALL_TARGET,
    PI_MERMAID_VARIANT_PUSH_TARGET,
  ].filter((target) => !content.includes(target));
  if (missingTargets.length > 0) {
    throw new Error(
      `pi-mermaid@${version}: target text for pi-mermaid patch not found at ${filePath}. ` +
        `Missing ${missingTargets.length} target(s). Upstream may have changed; update pi-update-extensions.ts.`,
    );
  }

  if (options.dryRun) {
    return { status: 'would-apply', packageRoot, version, patchPath: filePath };
  }

  const patched = content
    .replace(PI_MERMAID_IMPORT_TARGET, buildPiMermaidImportReplacement())
    .replace(
      PI_MERMAID_RENDER_FUNCTION_TARGET,
      'async function renderAsciiVariant(block: string, diagramHash: string, preset: AsciiPreset): Promise<AsciiVariant> {',
    )
    .replace(
      PI_MERMAID_RENDER_CALL_TARGET,
      '\tconst renderMermaidAscii = await getRenderMermaidAscii();\n\tconst ascii = renderMermaidAscii(block, {',
    )
    .replace(
      PI_MERMAID_VARIANT_PUSH_TARGET,
      'variants.push(await renderAsciiVariant(block, diagramHash, preset));',
    );
  writeFileSync(filePath, patched);
  return { status: 'applied', packageRoot, version, patchPath: filePath };
}

// ---------------------------------------------------------------------------
// pi-continuous-learning compatibility patch
//
// pi-continuous-learning@0.14.0 was published before Pi's package namespace
// moved from @mariozechner/* to @earendil-works/*. Its compiled runtime JS
// still imports the old packages, so standalone commands such as
// `pi-cl-analyze` fail with ERR_MODULE_NOT_FOUND after `pi install` installs
// only the current Pi runtime packages.
//
// Patch compiled JS in dist/ only. The source and declaration files can keep
// their published contents; runtime import resolution is the broken path.
// ---------------------------------------------------------------------------

const PI_CONTINUOUS_LEARNING_PACKAGE_NAME = 'pi-continuous-learning';
const PI_CONTINUOUS_LEARNING_DIST_RELATIVE_PATH = 'dist';
const PI_CONTINUOUS_LEARNING_NAMESPACE_REPLACEMENTS = [
  ['@mariozechner/pi-coding-agent', '@earendil-works/pi-coding-agent'],
  ['@mariozechner/pi-ai', '@earendil-works/pi-ai'],
  ['@mariozechner/pi-tui', '@earendil-works/pi-tui'],
] as const;

function collectJavaScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const entryPath = join(directory, entry);
    const entryStat = statSync(entryPath);
    if (entryStat.isDirectory()) {
      files.push(...collectJavaScriptFiles(entryPath));
    } else if (entryStat.isFile() && entryPath.endsWith('.js')) {
      files.push(entryPath);
    }
  }
  return files;
}

function replaceOldPiNamespaces(content: string): string {
  let patched = content;
  for (const [from, to] of PI_CONTINUOUS_LEARNING_NAMESPACE_REPLACEMENTS) {
    patched = patched.replaceAll(from, to);
  }
  return patched;
}

function readContinuousLearningRuntimeFiles(
  packageRoot: string,
): Array<{ path: string; content: string }> {
  const distPath = join(packageRoot, PI_CONTINUOUS_LEARNING_DIST_RELATIVE_PATH);
  if (!existsSync(distPath)) return [];
  return collectJavaScriptFiles(distPath).map((path) => ({
    path,
    content: readFileSync(path, 'utf8'),
  }));
}

export function isPiContinuousLearningPatchApplied(packageRoot: string): boolean {
  const runtimeFiles = readContinuousLearningRuntimeFiles(packageRoot);
  if (runtimeFiles.length === 0) return false;
  return runtimeFiles.every(({ content }) => !content.includes('@mariozechner/'));
}

export async function applyPiContinuousLearningPatch(
  options: { dryRun?: boolean; packageRoot?: string; cwd?: string } = {},
): Promise<ApplyPatchResult> {
  const packageRoot =
    options.packageRoot ??
    findGlobalPackagePath(PI_CONTINUOUS_LEARNING_PACKAGE_NAME, { cwd: options.cwd });
  if (!packageRoot) {
    throw new Error(
      `Could not locate installed ${PI_CONTINUOUS_LEARNING_PACKAGE_NAME} via configured package manager, aube, or pnpm`,
    );
  }

  const version = getPackageVersion(packageRoot) ?? 'unknown';
  const distPath = join(packageRoot, PI_CONTINUOUS_LEARNING_DIST_RELATIVE_PATH);
  if (!existsSync(distPath)) {
    throw new Error(
      `pi-continuous-learning@${version}: compiled dist directory not found at ${distPath}`,
    );
  }

  const runtimeFiles = readContinuousLearningRuntimeFiles(packageRoot);
  if (runtimeFiles.length === 0) {
    throw new Error(
      `pi-continuous-learning@${version}: no compiled JavaScript files found in ${distPath}`,
    );
  }

  const filesToPatch = runtimeFiles
    .map(({ path, content }) => ({ path, content, patched: replaceOldPiNamespaces(content) }))
    .filter(({ content, patched }) => content !== patched);

  if (filesToPatch.length === 0) {
    return { status: 'already-applied', packageRoot, version, patchPath: distPath };
  }

  if (options.dryRun) {
    return { status: 'would-apply', packageRoot, version, patchPath: distPath };
  }

  for (const { path, patched } of filesToPatch) {
    writeFileSync(path, patched);
  }
  return { status: 'applied', packageRoot, version, patchPath: distPath };
}

// ---------------------------------------------------------------------------
// BB thread built-in tooling guard patch
//
// BB supplies thread orchestration, pane control, and user-question tools.
// Keep the overlapping external Pi extensions installed for normal Pi sessions,
// but make their entrypoints no-ops when BB launches Pi with BB_THREAD_ID.
// ---------------------------------------------------------------------------

export const BB_THREAD_ORCHESTRATION_PACKAGE_NAMES = [
  'pi-subagents',
  'pi-intercom',
  '@ogulcancelik/pi-herdr',
  '@dkmnx/pi-clarify',
] as const;

type BbThreadOrchestrationPackageName = (typeof BB_THREAD_ORCHESTRATION_PACKAGE_NAMES)[number];

const BB_THREAD_ORCHESTRATION_GUARD_MARKER =
  '__pi_update_extensions:bb-thread-builtin-orchestration';

const PI_SUBAGENTS_ENTRYPOINT_SOURCE = 'export { default } from "./src/extension/index.ts";\n';

function patchBbThreadOrchestrationEntrypoint(
  packageName: BbThreadOrchestrationPackageName,
  content: string,
): string {
  if (
    content.includes(BB_THREAD_ORCHESTRATION_GUARD_MARKER) &&
    content.includes('process.env.BB_THREAD_ID?.trim()')
  ) {
    return content;
  }

  if (packageName === 'pi-subagents') {
    if (content !== PI_SUBAGENTS_ENTRYPOINT_SOURCE) {
      throw new Error('pi-subagents BB thread orchestration guard: upstream entrypoint changed');
    }
    return [
      'import piSubagentsExtension from "./src/extension/index.ts";',
      '',
      `// ${BB_THREAD_ORCHESTRATION_GUARD_MARKER}`,
      'export default process.env.BB_THREAD_ID?.trim() ? () => {} : piSubagentsExtension;',
      '',
    ].join('\n');
  }

  const targets: Record<
    Exclude<BbThreadOrchestrationPackageName, 'pi-subagents'>,
    {
      declaration: string;
      indent: string;
    }
  > = {
    'pi-intercom': {
      declaration: 'export default function piIntercomExtension(pi: ExtensionAPI) {\n',
      indent: '  ',
    },
    '@ogulcancelik/pi-herdr': {
      declaration: 'export default function (pi: ExtensionAPI) {\n',
      indent: '\t',
    },
    '@dkmnx/pi-clarify': {
      declaration: 'export default function (pi: ExtensionAPI) {\n',
      indent: '  ',
    },
  };
  const target = targets[packageName];
  if (!content.includes(target.declaration)) {
    throw new Error(`${packageName} BB thread tooling guard: upstream entrypoint changed`);
  }
  return content.replace(
    target.declaration,
    [
      target.declaration.trimEnd(),
      `${target.indent}// ${BB_THREAD_ORCHESTRATION_GUARD_MARKER}`,
      `${target.indent}if (process.env.BB_THREAD_ID?.trim()) return;`,
      '',
    ].join('\n'),
  );
}

export function isBbThreadOrchestrationGuardPatchApplied(
  packageName: BbThreadOrchestrationPackageName,
  packageRoot: string,
): boolean {
  const entrypointPath = join(packageRoot, 'index.ts');
  if (!existsSync(entrypointPath)) return false;
  const content = readFileSync(entrypointPath, 'utf8');
  return (
    content.includes(BB_THREAD_ORCHESTRATION_GUARD_MARKER) &&
    content.includes('process.env.BB_THREAD_ID?.trim()')
  );
}

export async function applyBbThreadOrchestrationGuardPatch(options: {
  packageName: BbThreadOrchestrationPackageName;
  dryRun?: boolean;
  packageRoot?: string;
  cwd?: string;
}): Promise<ApplyPatchResult> {
  const { packageName } = options;
  const packageRoot =
    options.packageRoot ?? findGlobalPackagePath(packageName, { cwd: options.cwd });
  if (!packageRoot) {
    throw new Error(
      `Could not locate installed ${packageName} via configured package manager, aube, or pnpm`,
    );
  }

  const version = getPackageVersion(packageRoot) ?? 'unknown';
  const entrypointPath = join(packageRoot, 'index.ts');
  if (!existsSync(entrypointPath)) {
    throw new Error(`${packageName}@${version}: entrypoint not found at ${entrypointPath}`);
  }

  const content = readFileSync(entrypointPath, 'utf8');
  const patched = patchBbThreadOrchestrationEntrypoint(packageName, content);
  if (patched === content) {
    return { status: 'already-applied', packageRoot, version, patchPath: entrypointPath };
  }
  if (options.dryRun) {
    return { status: 'would-apply', packageRoot, version, patchPath: entrypointPath };
  }

  writeFileSync(entrypointPath, patched);
  return { status: 'applied', packageRoot, version, patchPath: entrypointPath };
}

// ---------------------------------------------------------------------------
// pi-subagents built-in agent apply_patch tool patch
//
// Built-in pi-subagents agent definitions predate this toolbox's apply_patch
// tool. Agents with `edit` or `write` can already mutate files, so add the
// narrower patch-shaped editor tool to any built-in agent that has either of
// those tools. Scan the package's agent markdown dynamically instead of naming
// specific agents so new writable built-ins get patched automatically.
// ---------------------------------------------------------------------------

const PI_SUBAGENTS_PACKAGE_NAME = 'pi-subagents';
const PI_SUBAGENTS_AGENTS_RELATIVE_PATH = 'agents';
const PI_SUBAGENTS_APPLY_PATCH_TOOL_NAME = 'apply_patch';

type AgentToolLinePatch = {
  changed: boolean;
  content: string;
  hasWritableTool: boolean;
  hasApplyPatchTool: boolean;
};

function getPiSubagentsAgentsDir(packageRoot: string): string {
  return join(packageRoot, PI_SUBAGENTS_AGENTS_RELATIVE_PATH);
}

function getPiSubagentsAgentMarkdownFiles(packageRoot: string): string[] {
  const agentsDir = getPiSubagentsAgentsDir(packageRoot);
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => join(agentsDir, entry))
    .filter((entryPath) => statSync(entryPath).isFile())
    .sort();
}

function splitFrontmatterTools(rawTools: string): string[] {
  return rawTools
    .split(',')
    .map((tool) => tool.trim())
    .filter(Boolean);
}

function patchAgentToolLine(content: string): AgentToolLinePatch {
  const frontmatterMatch = content.match(/^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---/);
  if (!frontmatterMatch?.groups?.frontmatter) {
    return { changed: false, content, hasWritableTool: false, hasApplyPatchTool: false };
  }

  const frontmatter = frontmatterMatch.groups.frontmatter;
  const toolsLineMatch = frontmatter.match(/^(?<prefix>tools:\s*)(?<tools>.*)$/m);
  if (!toolsLineMatch?.groups) {
    return { changed: false, content, hasWritableTool: false, hasApplyPatchTool: false };
  }

  const tools = splitFrontmatterTools(toolsLineMatch.groups.tools);
  const hasWritableTool = tools.includes('edit') || tools.includes('write');
  const hasApplyPatchTool = tools.includes(PI_SUBAGENTS_APPLY_PATCH_TOOL_NAME);
  if (!hasWritableTool || hasApplyPatchTool) {
    return { changed: false, content, hasWritableTool, hasApplyPatchTool };
  }

  const patchedToolsLine = `${toolsLineMatch.groups.prefix}${toolsLineMatch.groups.tools}, ${PI_SUBAGENTS_APPLY_PATCH_TOOL_NAME}`;
  return {
    changed: true,
    content: content.replace(toolsLineMatch[0], patchedToolsLine),
    hasWritableTool,
    hasApplyPatchTool,
  };
}

export function isPiSubagentsApplyPatchToolPatchApplied(packageRoot: string): boolean {
  const agentFiles = getPiSubagentsAgentMarkdownFiles(packageRoot);
  if (agentFiles.length === 0) return false;

  return agentFiles.every(
    (filePath) => !patchAgentToolLine(readFileSync(filePath, 'utf8')).changed,
  );
}

export async function applyPiSubagentsApplyPatchToolPatch(
  options: { dryRun?: boolean; packageRoot?: string; cwd?: string } = {},
): Promise<ApplyPatchResult> {
  const packageRoot =
    options.packageRoot ?? findGlobalPackagePath(PI_SUBAGENTS_PACKAGE_NAME, { cwd: options.cwd });
  if (!packageRoot) {
    throw new Error(
      `Could not locate installed ${PI_SUBAGENTS_PACKAGE_NAME} via configured package manager, aube, or pnpm`,
    );
  }

  const version = getPackageVersion(packageRoot) ?? 'unknown';
  const agentsDir = getPiSubagentsAgentsDir(packageRoot);
  if (!existsSync(agentsDir)) {
    throw new Error(`pi-subagents@${version}: agents directory not found at ${agentsDir}`);
  }

  const filesToPatch = getPiSubagentsAgentMarkdownFiles(packageRoot)
    .map((filePath) => ({
      filePath,
      patch: patchAgentToolLine(readFileSync(filePath, 'utf8')),
    }))
    .filter(({ patch }) => patch.changed);

  if (filesToPatch.length === 0) {
    return { status: 'already-applied', packageRoot, version, patchPath: agentsDir };
  }

  if (options.dryRun) {
    return { status: 'would-apply', packageRoot, version, patchPath: agentsDir };
  }

  for (const { filePath, patch } of filesToPatch) {
    writeFileSync(filePath, patch.content);
  }
  return { status: 'applied', packageRoot, version, patchPath: agentsDir };
}

// ---------------------------------------------------------------------------
// pi-subagents compact OSC 8 TUI path links patch
//
// pi-subagents renders generated output, log, artifact, and session paths in
// Text components and widgets, where Markdown links are not parsed. Keep the
// full absolute path in a file:// OSC 8 target while displaying only the final
// three path segments. Restrict escape sequences to TUI render paths so model
// content and persisted run metadata remain plain text.
// ---------------------------------------------------------------------------

const PI_SUBAGENTS_TUI_PATH_LINKS_RELATIVE_PATH = 'src/tui/path-links.ts';
const PI_SUBAGENTS_TUI_RENDER_RELATIVE_PATH = 'src/tui/render.ts';
const PI_SUBAGENTS_TUI_FLEET_RELATIVE_PATH = 'src/tui/fleet.ts';
const PI_SUBAGENTS_EXTENSION_INDEX_RELATIVE_PATH = 'src/extension/index.ts';
const PI_SUBAGENTS_TUI_PATH_LINKS_PATCH_MARKER_PREFIX =
  '__pi_update_extensions:pi-subagents-tui-path-links';
const PI_SUBAGENTS_TUI_PATH_LINKS_PATCH_MARKER =
  '__pi_update_extensions:pi-subagents-tui-path-links-v2__';

export function buildPiSubagentsTuiPathLinksSource(): string {
  return [
    'import * as path from "node:path";',
    'import { pathToFileURL } from "node:url";',
    'import { hyperlink } from "@earendil-works/pi-tui";',
    '',
    `// ${PI_SUBAGENTS_TUI_PATH_LINKS_PATCH_MARKER}`,
    'const DISPLAY_PATH_SEGMENTS = 3;',
    'const FILE_REFERENCE_LINE = /^(?<prefix>\\s*(?:⎿\\s+)?(?:artifacts?(?: dir)?|async dir|catalog|dir|events|full output|log|metadata|output(?: artifact)?|parallel handoff|quality|quota|result|saved output|session|transcript(?: file)?):\\s+)(?<path>.+?)\\s*$/i;',
    'const MARKDOWN_PATH_LINE = /^(?<prefix>\\s*-\\s+)`(?<path>[^`]+)`\\s*$/;',
    '',
    'export function compactFilePath(filePath: string): string {',
    '\tconst absolutePath = path.resolve(filePath);',
    '\tconst root = path.parse(absolutePath).root;',
    '\tconst segments = absolutePath.slice(root.length).split(path.sep).filter(Boolean);',
    '\treturn segments.slice(-DISPLAY_PATH_SEGMENTS).join(path.sep) || absolutePath;',
    '}',
    '',
    'export function formatFileLink(filePath: string): string {',
    '\tif (!path.isAbsolute(filePath)) return filePath;',
    '\tconst absolutePath = path.resolve(filePath);',
    '\treturn hyperlink(compactFilePath(absolutePath), pathToFileURL(absolutePath).href);',
    '}',
    '',
    'function absoluteReferencePath(value: string): string | undefined {',
    '\tconst candidate = value.trim();',
    '\treturn path.isAbsolute(candidate) ? candidate : undefined;',
    '}',
    '',
    'export function linkFileReferences(text: string): string {',
    '\treturn text.split("\\n").map((line) => {',
    '\t\tconst reference = FILE_REFERENCE_LINE.exec(line);',
    '\t\tconst referencePath = reference?.groups?.path ? absoluteReferencePath(reference.groups.path) : undefined;',
    '\t\tif (reference?.groups?.prefix && referencePath) return `${reference.groups.prefix}${formatFileLink(referencePath)}`;',
    '',
    '\t\tconst markdown = MARKDOWN_PATH_LINE.exec(line);',
    '\t\tconst markdownPath = markdown?.groups?.path ? absoluteReferencePath(markdown.groups.path) : undefined;',
    '\t\tif (markdown?.groups?.prefix && markdownPath) return `${markdown.groups.prefix}${formatFileLink(markdownPath)}`;',
    '\t\treturn line;',
    '\t}).join("\\n");',
    '}',
    '',
  ].join('\n');
}

function replacePiSubagentsTuiTarget(
  content: string,
  target: string,
  replacement: string,
  semanticReplacement: string,
  description: string,
): string {
  if (content.includes(semanticReplacement)) return content;
  if (content.includes(target)) return content.replaceAll(target, replacement);
  throw new Error(`pi-subagents TUI path links patch: upstream ${description} target changed`);
}

function dedupePiSubagentsImport(content: string, importLine: string): string {
  const lines = content.split('\n');
  let found = false;
  return lines
    .filter((line) => {
      if (line !== importLine) return true;
      if (found) return false;
      found = true;
      return true;
    })
    .join('\n');
}

function patchPiSubagentsTuiImports(content: string): string {
  const importPattern = /^import \{ (?<bindings>[^\n]+) \} from "@earendil-works\/pi-tui";$/m;
  const importMatch = content.match(importPattern);
  if (!importMatch?.groups?.bindings) {
    throw new Error('pi-subagents TUI path links patch: upstream render import target changed');
  }
  const additions = ['truncateToWidth', 'wrapTextWithAnsi'].filter(
    (binding) =>
      !importMatch
        .groups!.bindings.split(',')
        .map((part) => part.trim())
        .includes(binding),
  );
  if (additions.length === 0) return content;
  if (!importMatch.groups.bindings.includes('visibleWidth')) {
    throw new Error('pi-subagents TUI path links patch: upstream visibleWidth import changed');
  }
  const bindings = importMatch.groups.bindings.replace(
    'visibleWidth',
    `${additions.join(', ')}, visibleWidth`,
  );
  return content.replace(importMatch[0], `import { ${bindings} } from "@earendil-works/pi-tui";`);
}

function patchPiSubagentsTuiRender(content: string): string {
  let patched = patchPiSubagentsTuiImports(content);
  const pathLinksImport = 'import { formatFileLink, linkFileReferences } from "./path-links.ts";';
  patched = replacePiSubagentsTuiTarget(
    patched,
    'import { buildWorkflowChatProgressRows, type WorkflowChatProgressRow } from "../workflows/chat-progress.ts";',
    [
      'import { buildWorkflowChatProgressRows, type WorkflowChatProgressRow } from "../workflows/chat-progress.ts";',
      pathLinksImport,
    ].join('\n'),
    pathLinksImport,
    'render path-link import',
  );
  patched = dedupePiSubagentsImport(patched, pathLinksImport);
  const oscTruncationLine = `\tif (text.includes("\\x1b]8;")) return truncateToWidth(text, maxWidth, "…"); // ${PI_SUBAGENTS_TUI_PATH_LINKS_PATCH_MARKER}`;
  const legacyOscTruncationPattern =
    /^\tif \(text\.includes\("\\x1b]8;"\)\) return truncateToWidth\(text, maxWidth, "…"\); \/\/ __pi_update_extensions:pi-subagents-tui-path-links(?:-v\d+)?__$/m;
  if (legacyOscTruncationPattern.test(patched)) {
    patched = patched.replace(legacyOscTruncationPattern, oscTruncationLine);
  } else if (!patched.includes(oscTruncationLine)) {
    patched = replacePiSubagentsTuiTarget(
      patched,
      [
        'export function truncLine(text: string, maxWidth: number): string {',
        '\tif (maxWidth <= 0) return "";',
      ].join('\n'),
      [
        'export function truncLine(text: string, maxWidth: number): string {',
        '\tif (maxWidth <= 0) return "";',
        oscTruncationLine,
      ].join('\n'),
      oscTruncationLine,
      'OSC-safe truncation',
    );
  }

  const oscWrapLine = '\tif (text.includes("\\x1b]8;")) return wrapTextWithAnsi(text, maxWidth);';
  patched = replacePiSubagentsTuiTarget(
    patched,
    [
      'function wrapPlainText(text: string, maxWidth: number): string[] {',
      '\tif (maxWidth <= 0) return [""];',
    ].join('\n'),
    [
      'function wrapPlainText(text: string, maxWidth: number): string[] {',
      '\tif (maxWidth <= 0) return [""];',
      oscWrapLine,
    ].join('\n'),
    oscWrapLine,
    'OSC-safe wrapping',
  );

  const pathExpressions = [
    ['shortenPath(output)', 'formatFileLink(output)'],
    ['shortenPath(r.artifactPaths.outputPath)', 'formatFileLink(r.artifactPaths.outputPath)'],
    ['shortenPath(r.sessionFile)', 'formatFileLink(r.sessionFile)'],
    ['shortenPath(r.truncation.artifactPath)', 'formatFileLink(r.truncation.artifactPath)'],
    ['shortenPath(d.artifacts.dir)', 'formatFileLink(d.artifacts.dir)'],
    ['output: ${outputTarget}', 'output: ${formatFileLink(outputTarget)}'],
  ] as const;
  for (const [target, replacement] of pathExpressions) {
    if (patched.includes(target)) patched = patched.replaceAll(target, replacement);
    else if (!patched.includes(replacement)) {
      throw new Error(
        `pi-subagents TUI path links patch: upstream render expression '${target}' target changed`,
      );
    }
  }

  return replacePiSubagentsTuiTarget(
    patched,
    [
      '\t\tconst text = t?.type === "text" ? t.text : "(no output)";',
      '\t\tconst contextPrefix = contextModePrefix(theme, d?.context);',
      '\t\tconst width = getTermWidth() - 4;',
      '\t\tif (!text.includes("\\n")) return new Text(truncLine(`${contextPrefix}${text}`, width), 0, 0);',
      '\t\tif (d && !options.expanded && !result.isError) {',
      '\t\t\tconst lines = text.split(/\\r?\\n/);',
      '\t\t\tconst firstNonEmptyLine = lines.find((line) => line.trim())?.trim() || "(no output)";',
      '\t\t\tconst c = new Container();',
      '\t\t\tc.addChild(new Text(truncLine(`${contextPrefix}${firstNonEmptyLine} · ${lines.length} lines`, width), 0, 0));',
      '\t\t\tc.addChild(new Text(truncLine(theme.fg("accent", `  Press ${liveDetailKeyText()} for full output`), width), 0, 0));',
      '\t\t\treturn c;',
      '\t\t}',
      '\t\tconst c = new Container();',
      '\t\tconst wrapped = wrapPlainText(`${contextPrefix}${text}`, width);',
    ].join('\n'),
    [
      '\t\tconst text = t?.type === "text" ? t.text : "(no output)";',
      '\t\tconst linkedText = linkFileReferences(text);',
      '\t\tconst contextPrefix = contextModePrefix(theme, d?.context);',
      '\t\tconst width = getTermWidth() - 4;',
      '\t\tif (!linkedText.includes("\\n")) return new Text(truncLine(`${contextPrefix}${linkedText}`, width), 0, 0);',
      '\t\tif (d && !options.expanded && !result.isError) {',
      '\t\t\tconst lines = linkedText.split(/\\r?\\n/);',
      '\t\t\tconst firstNonEmptyLine = lines.find((line) => line.trim())?.trim() || "(no output)";',
      '\t\t\tconst c = new Container();',
      '\t\t\tc.addChild(new Text(truncLine(`${contextPrefix}${firstNonEmptyLine} · ${lines.length} lines`, width), 0, 0));',
      '\t\t\tc.addChild(new Text(truncLine(theme.fg("accent", `  Press ${liveDetailKeyText()} for full output`), width), 0, 0));',
      '\t\t\treturn c;',
      '\t\t}',
      '\t\tconst c = new Container();',
      '\t\tconst wrapped = wrapPlainText(`${contextPrefix}${linkedText}`, width);',
    ].join('\n'),
    'const linkedText = linkFileReferences(text);',
    'fallback result renderer',
  );
}

function patchPiSubagentsTuiFleet(content: string): string {
  const pathLinksImport = 'import { linkFileReferences } from "./path-links.ts";';
  let patched = replacePiSubagentsTuiTarget(
    content,
    'import { handleHerdrInspectorAction } from "../inspectors/herdr/actions.ts";',
    [
      'import { handleHerdrInspectorAction } from "../inspectors/herdr/actions.ts";',
      pathLinksImport,
    ].join('\n'),
    pathLinksImport,
    'fleet path-link import',
  );
  patched = dedupePiSubagentsImport(patched, pathLinksImport);
  patched = replacePiSubagentsTuiTarget(
    patched,
    [
      '\t\tif (transcriptWarning) raw.unshift(`Transcript preview warning: ${transcriptWarning}`, "");',
      '\t\tconst lines: string[] = [];',
      '\t\tfor (const line of raw) {',
    ].join('\n'),
    [
      '\t\tif (transcriptWarning) raw.unshift(`Transcript preview warning: ${transcriptWarning}`, "");',
      '\t\tconst linkedRaw = linkFileReferences(raw.join("\\n")).split("\\n");',
      '\t\tconst lines: string[] = [];',
      '\t\tfor (const line of linkedRaw) {',
    ].join('\n'),
    'const linkedRaw = linkFileReferences(raw.join("\\n")).split("\\n");',
    'fleet detail renderer',
  );
  return patched;
}

function patchPiSubagentsExtensionIndex(content: string): string {
  const pathLinksImport =
    'import { formatFileLink, linkFileReferences } from "../tui/path-links.ts";';
  let patched = replacePiSubagentsTuiTarget(
    content,
    'import { openSubagentFleet } from "../tui/fleet.ts";',
    ['import { openSubagentFleet } from "../tui/fleet.ts";', pathLinksImport].join('\n'),
    pathLinksImport,
    'extension path-link import',
  );
  patched = dedupePiSubagentsImport(patched, pathLinksImport);
  patched = replacePiSubagentsTuiTarget(
    patched,
    'return new Text(content, 0, 0);',
    'return new Text(linkFileReferences(content), 0, 0);',
    'new Text(linkFileReferences(content), 0, 0)',
    'plain message renderer',
  );
  patched = replacePiSubagentsTuiTarget(
    patched,
    'shortenPath(details.sessionValue)',
    'formatFileLink(details.sessionValue)',
    'formatFileLink(details.sessionValue)',
    'completion session renderer',
  );
  return replacePiSubagentsTuiTarget(
    patched,
    'wrapTextWithAnsi(formatSubagentControlNotice(this.details), bodyWidth)',
    'wrapTextWithAnsi(linkFileReferences(formatSubagentControlNotice(this.details)), bodyWidth)',
    'linkFileReferences(formatSubagentControlNotice(this.details))',
    'control notice renderer',
  );
}

function getPiSubagentsTuiPathLinkFiles(packageRoot: string): {
  linkSourcePath: string;
  renderPath: string;
  fleetPath: string;
  extensionIndexPath: string;
} {
  return {
    linkSourcePath: join(packageRoot, PI_SUBAGENTS_TUI_PATH_LINKS_RELATIVE_PATH),
    renderPath: join(packageRoot, PI_SUBAGENTS_TUI_RENDER_RELATIVE_PATH),
    fleetPath: join(packageRoot, PI_SUBAGENTS_TUI_FLEET_RELATIVE_PATH),
    extensionIndexPath: join(packageRoot, PI_SUBAGENTS_EXTENSION_INDEX_RELATIVE_PATH),
  };
}

export function isPiSubagentsTuiPathLinksPatchApplied(packageRoot: string): boolean {
  const files = getPiSubagentsTuiPathLinkFiles(packageRoot);
  if (!Object.values(files).every((filePath) => existsSync(filePath))) return false;
  const linkSource = readFileSync(files.linkSourcePath, 'utf8');
  const renderSource = readFileSync(files.renderPath, 'utf8');
  const fleetSource = readFileSync(files.fleetPath, 'utf8');
  const extensionSource = readFileSync(files.extensionIndexPath, 'utf8');
  return (
    linkSource === buildPiSubagentsTuiPathLinksSource() &&
    renderSource.includes(PI_SUBAGENTS_TUI_PATH_LINKS_PATCH_MARKER) &&
    renderSource.includes('return wrapTextWithAnsi(text, maxWidth);') &&
    renderSource.includes('formatFileLink(output)') &&
    renderSource.includes('const linkedText = linkFileReferences(text);') &&
    fleetSource.includes('const linkedRaw = linkFileReferences(raw.join("\\n")).split("\\n");') &&
    renderSource.split('from "./path-links.ts"').length === 2 &&
    fleetSource.split('from "./path-links.ts"').length === 2 &&
    extensionSource.split('from "../tui/path-links.ts"').length === 2 &&
    extensionSource.includes('new Text(linkFileReferences(content), 0, 0)') &&
    extensionSource.includes('formatFileLink(details.sessionValue)') &&
    extensionSource.includes('linkFileReferences(formatSubagentControlNotice(this.details))')
  );
}

export async function applyPiSubagentsTuiPathLinksPatch(
  options: { dryRun?: boolean; packageRoot?: string; cwd?: string } = {},
): Promise<ApplyPatchResult> {
  const packageRoot =
    options.packageRoot ?? findGlobalPackagePath(PI_SUBAGENTS_PACKAGE_NAME, { cwd: options.cwd });
  if (!packageRoot) {
    throw new Error(
      `Could not locate installed ${PI_SUBAGENTS_PACKAGE_NAME} via configured package manager, aube, or pnpm`,
    );
  }

  const version = getPackageVersion(packageRoot) ?? 'unknown';
  const files = getPiSubagentsTuiPathLinkFiles(packageRoot);
  for (const sourcePath of [files.renderPath, files.fleetPath, files.extensionIndexPath]) {
    if (!existsSync(sourcePath)) {
      throw new Error(`pi-subagents@${version}: TUI path-link source not found at ${sourcePath}`);
    }
  }
  if (isPiSubagentsTuiPathLinksPatchApplied(packageRoot)) {
    return { status: 'already-applied', packageRoot, version, patchPath: files.linkSourcePath };
  }
  if (
    existsSync(files.linkSourcePath) &&
    !readFileSync(files.linkSourcePath, 'utf8').includes(
      PI_SUBAGENTS_TUI_PATH_LINKS_PATCH_MARKER_PREFIX,
    )
  ) {
    throw new Error(
      `pi-subagents@${version}: refusing to replace existing unrecognized ${files.linkSourcePath}`,
    );
  }

  const patchedFiles = [
    { path: files.linkSourcePath, content: buildPiSubagentsTuiPathLinksSource() },
    {
      path: files.renderPath,
      content: patchPiSubagentsTuiRender(readFileSync(files.renderPath, 'utf8')),
    },
    {
      path: files.fleetPath,
      content: patchPiSubagentsTuiFleet(readFileSync(files.fleetPath, 'utf8')),
    },
    {
      path: files.extensionIndexPath,
      content: patchPiSubagentsExtensionIndex(readFileSync(files.extensionIndexPath, 'utf8')),
    },
  ];

  if (options.dryRun) {
    return { status: 'would-apply', packageRoot, version, patchPath: files.linkSourcePath };
  }
  for (const file of patchedFiles) writeTextPatchAtomically(file.path, file.content);
  return { status: 'applied', packageRoot, version, patchPath: files.linkSourcePath };
}

export function findInstalledNpmPackagePath(
  installedPackages: readonly InstalledPackage[],
  packageName: string,
): string | undefined {
  const exactSource = `npm:${packageName}`;
  const versionedSourcePrefix = `${exactSource}@`;
  return installedPackages.find(
    (entry) => entry.source === exactSource || entry.source.startsWith(versionedSourcePrefix),
  )?.installedPath;
}

export function getInstalledPackage(
  installedPackages: readonly InstalledPackage[],
  source: string,
): InstalledPackage {
  const installedPackage = installedPackages.find((entry) => entry.source === source);
  if (!installedPackage) {
    throw new Error(`Installed package '${source}' was not found in 'pi list' output`);
  }
  return installedPackage;
}

/** Extract version from an installed npm package's package.json */
function getPackageVersion(installedPath: string): string | undefined {
  try {
    const packageJsonPath = join(installedPath, 'package.json');
    if (!existsSync(packageJsonPath)) {
      return undefined;
    }
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: string };
    return packageJson.version;
  } catch {
    return undefined;
  }
}

/** Remove an exact version or tag from an npm package spec. */
export function getPackageNameFromSpec(spec: string): string {
  const lastAt = spec.lastIndexOf('@');
  return lastAt > 0 ? spec.slice(0, lastAt) : spec;
}

/** Build a gitchamber package spec with the exact installed version. */
export function buildGitchamberSpec(source: string, version: string): string | undefined {
  if (source.startsWith('npm:')) {
    const packageName = getPackageNameFromSpec(source.slice(4));
    return `${packageName}@${version}`;
  }
  if (source.startsWith('git:') || source.startsWith('https://github.com/')) {
    return undefined;
  }
  return undefined;
}

/** Get the exact installed version of a local devDependency from node_modules */
function getLocalDevDependencyVersion(packageName: string, cwd: string): string | undefined {
  try {
    // Try local node_modules first
    const localPackageJsonPath = join(cwd, 'node_modules', packageName, 'package.json');
    if (existsSync(localPackageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(localPackageJsonPath, 'utf8')) as {
        version?: string;
      };
      return packageJson.version;
    }
  } catch {
    // Fall through to try global
  }

  // Try globally installed packages using the configured package manager first,
  // then aube (when available), then pnpm.
  try {
    const globalPackagePath = findGlobalPackagePath(packageName, { cwd });
    if (globalPackagePath) {
      const globalPackageJsonPath = join(globalPackagePath, 'package.json');
      if (existsSync(globalPackageJsonPath)) {
        const packageJson = JSON.parse(readFileSync(globalPackageJsonPath, 'utf8')) as {
          version?: string;
        };
        return packageJson.version;
      }
    }
  } catch {
    // Ignore errors
  }

  return undefined;
}

/** Extract GitHub repo from README.md content using multiple strategies */
export function extractGitHubRepoFromReadme(
  readmeContent: string,
  packageName: string,
): string | undefined {
  const baseName = packageName.replace(/^@[^/]+\//, ''); // Remove scope

  // Common repos to exclude (not the package itself, but commonly referenced)
  const excludedRepos = ['badlogic/pi-mono', 'mariozechner/pi-mono', 'ttttmr/pi-context'];

  // Strategy 1: Find git clone commands with GitHub URLs (most explicit)
  const cloneMatch = readmeContent.match(/git clone https:\/\/github\.com\/([^/]+)\/([^/\s.]+)/);
  if (cloneMatch) {
    const ownerRepo = `${cloneMatch[1]}/${cloneMatch[2]}`;
    if (!excludedRepos.includes(ownerRepo)) {
      return ownerRepo;
    }
  }

  // Strategy 2: Find all github.com/owner/repo patterns
  const githubMatches = Array.from(
    readmeContent.matchAll(/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)/g),
  );

  // Filter out excluded repos
  const validMatches = githubMatches.filter((match) => {
    const ownerRepo = `${match[1]}/${match[2]}`;
    return !excludedRepos.includes(ownerRepo);
  });

  // Strategy 3: Prefer repos that match the package name exactly
  for (const match of validMatches) {
    const [, owner, repo] = match;
    if (repo === baseName) {
      return `${owner}/${repo}`;
    }
  }

  // Strategy 4: Prefer repos where the package name is a significant part of the repo name
  // (avoid matching generic repos like "pi-context" when looking for "pi-boomerang")
  for (const match of validMatches) {
    const [, owner, repo] = match;
    // Require the repo to contain the full package name, or vice versa with high overlap
    if (repo.includes(baseName)) {
      return `${owner}/${repo}`;
    }
  }

  // Do not use an unrelated pi-* link as a fallback. Package READMEs often
  // link to integrations, and treating such a link as source can overwrite a
  // different gitchamber snapshot.
  return undefined;
}

/** Try to construct GitHub owner/repo from package.json author + package name */
function constructRepoFromAuthor(
  packageJson: { author?: string | { name?: string } },
  packageName: string,
): string | undefined {
  // Extract owner from author field
  let authorName: string | undefined;
  if (typeof packageJson.author === 'string') {
    // Parse "Name <email> (url)" format
    const match = packageJson.author.match(/^([^<]+)/);
    authorName = match ? match[1].trim() : packageJson.author;
  } else if (packageJson.author?.name) {
    authorName = packageJson.author.name;
  }

  if (!authorName) return undefined;

  // Convert author name to likely GitHub username (lowercase, no spaces)
  const likelyOwner = authorName.toLowerCase().replace(/\s+/g, '');
  const baseName = packageName.replace(/^@[^/]+\//, '');

  return `${likelyOwner}/${baseName}`;
}

/** Try to detect GitHub repo for a package using multiple strategies */
function detectGitHubRepo(
  installedPath: string,
  packageName: string,
): { ownerRepo: string; source: 'manual' | 'package-json' | 'readme' | 'author' } | undefined {
  const baseName = packageName.replace(/^@[^/]+\//, '');

  // Strategy 0: Check manual overrides first
  if (GITCHAMBER_MANUAL_OVERRIDES[baseName]) {
    return { ownerRepo: GITCHAMBER_MANUAL_OVERRIDES[baseName], source: 'manual' };
  }

  // Strategy 1: Check package.json repository field
  try {
    const packageJsonPath = join(installedPath, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      repository?: string | { type?: string; url?: string };
      author?: string | { name?: string };
    };

    if (packageJson.repository) {
      let repoUrl: string | undefined;
      if (typeof packageJson.repository === 'string') {
        repoUrl = packageJson.repository;
      } else if (packageJson.repository.url) {
        repoUrl = packageJson.repository.url;
      }

      if (repoUrl) {
        const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
        if (match) {
          return { ownerRepo: `${match[1]}/${match[2]}`, source: 'package-json' };
        }
      }
    }
  } catch {
    // Continue to README fallback
  }

  // Strategy 2: Read README.md and extract GitHub repo
  try {
    const readmePath = join(installedPath, 'README.md');
    if (existsSync(readmePath)) {
      const readmeContent = readFileSync(readmePath, 'utf8');
      const repoFromReadme = extractGitHubRepoFromReadme(readmeContent, packageName);
      if (repoFromReadme) {
        return { ownerRepo: repoFromReadme, source: 'readme' };
      }
    }
  } catch {
    // Continue to author fallback
  }

  // Strategy 3: Construct from author name + package name
  try {
    const packageJsonPath = join(installedPath, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      author?: string | { name?: string };
    };
    const repoFromAuthor = constructRepoFromAuthor(packageJson, packageName);
    if (repoFromAuthor) {
      return { ownerRepo: repoFromAuthor, source: 'author' };
    }
  } catch {
    // No luck
  }

  return undefined;
}
function getGitchamberOutputError(output: string, spec: string): string | undefined {
  const failedMatch = output.match(/Done: \d+ succeeded, (\d+) failed/);
  const failedCount = failedMatch ? Number.parseInt(failedMatch[1], 10) : 0;
  if (!output.includes('✗ Error:') && failedCount === 0) return undefined;
  return output.match(/✗ Error: ([^\n]+)/)?.[1] ?? `Failed to fetch ${spec}`;
}

function formatGitchamberCommandError(error: unknown, spec: string, timeoutMs: number): string {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ETIMEDOUT'
  ) {
    return `Timed out after ${Math.ceil(timeoutMs / 1000)} seconds while fetching ${spec}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function updateGitchamberSources(
  installedPackages: readonly InstalledPackage[],
  options: {
    dryRun?: boolean;
    cwd?: string;
    timeoutMs?: number;
    includePiSiblingPackages?: boolean;
    execFile?: typeof execFileSync;
    log?: (message: string) => void;
  } = {},
): Promise<GitchamberFetchResult[]> {
  const {
    dryRun = false,
    cwd = process.cwd(),
    timeoutMs = DEFAULT_GITCHAMBER_TIMEOUT_MS,
    includePiSiblingPackages = true,
  } = options;
  const execFile = options.execFile ?? execFileSync;
  const log = options.log ?? console.log;
  const results: GitchamberFetchResult[] = [];
  const specsByPackageName = new Map<string, { spec: string; source: string; version: string }>();

  const addSpec = (spec: string, source: string, version: string): void => {
    const packageName = getPackageNameFromSpec(spec);
    if (!specsByPackageName.has(packageName)) {
      specsByPackageName.set(packageName, { spec, source, version });
    }
  };

  for (const installedPackage of installedPackages) {
    const version = getPackageVersion(installedPackage.installedPath);
    if (!version) continue;
    const spec = buildGitchamberSpec(installedPackage.source, version);
    if (spec) addSpec(spec, installedPackage.source, version);
  }

  if (includePiSiblingPackages) {
    for (const packageName of GITCHAMBER_PACKAGES) {
      const version = getLocalDevDependencyVersion(packageName, cwd);
      if (version) addSpec(`${packageName}@${version}`, `npm:${packageName}`, version);
    }
  }

  const specsToFetch = [...specsByPackageName.values()];
  if (specsToFetch.length === 0) return results;

  const sourcesJsonPath = join(cwd, 'node_modules', '.gitchamber', 'sources.json');
  type GitchamberSource = { name: string; version: string };
  type GitchamberSourcesJson = {
    packages?: GitchamberSource[];
    repos?: GitchamberSource[];
  };
  const existingPackages = new Map<string, string>();
  const existingRepos = new Map<string, string>();
  if (existsSync(sourcesJsonPath)) {
    try {
      const sourcesJson = JSON.parse(
        readFileSync(sourcesJsonPath, 'utf8'),
      ) as GitchamberSourcesJson;
      for (const pkg of sourcesJson.packages ?? []) existingPackages.set(pkg.name, pkg.version);
      for (const repo of sourcesJson.repos ?? []) existingRepos.set(repo.name, repo.version);
    } catch {
      // A damaged cache must not block a repair fetch.
    }
  }

  for (const [index, { spec, source, version }] of specsToFetch.entries()) {
    const packageName = getPackageNameFromSpec(spec);
    const installedPackage = installedPackages.find((entry) => entry.source === source);
    const detectedRepo = installedPackage
      ? detectGitHubRepo(installedPackage.installedPath, packageName)
      : undefined;
    const repoSpec = detectedRepo ? `${detectedRepo.ownerRepo}@${version}` : undefined;
    const cachedRepoName = detectedRepo ? `github.com/${detectedRepo.ownerRepo}` : undefined;

    if (
      existingPackages.get(packageName) === version ||
      (cachedRepoName !== undefined && existingRepos.get(cachedRepoName) === version)
    ) {
      results.push({ packageSpec: spec, version, status: 'already-exists' });
      continue;
    }

    if (dryRun) {
      results.push({ packageSpec: spec, version, status: 'would-fetch' });
      continue;
    }

    const runFetch = (fetchSpec: string): string => {
      log(
        `[gitchamber ${index + 1}/${specsToFetch.length}] Fetching ${fetchSpec} ` +
          `(timeout ${Math.ceil(timeoutMs / 1000)}s)...`,
      );
      return execFile('gitchamber', [fetchSpec], {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
        stdio: ['ignore', 'pipe', 'inherit'],
      });
    };

    try {
      const output = runFetch(spec);
      const outputError = getGitchamberOutputError(output, spec);
      if (!outputError) {
        results.push({ packageSpec: spec, version, status: 'fetched' });
        continue;
      }

      if (repoSpec) {
        log(`[gitchamber] Package lookup failed; trying repository ${repoSpec}.`);
        try {
          const fallbackOutput = runFetch(repoSpec);
          const fallbackError = getGitchamberOutputError(fallbackOutput, repoSpec);
          if (!fallbackError) {
            results.push({ packageSpec: repoSpec, version, status: 'fetched' });
            continue;
          }
          results.push({
            packageSpec: repoSpec,
            version,
            status: 'error',
            error: fallbackError,
          });
          continue;
        } catch (error) {
          results.push({
            packageSpec: repoSpec,
            version,
            status: 'error',
            error: formatGitchamberCommandError(error, repoSpec, timeoutMs),
          });
          continue;
        }
      }

      results.push({ packageSpec: spec, version, status: 'error', error: outputError });
    } catch (error) {
      results.push({
        packageSpec: spec,
        version,
        status: 'error',
        error: formatGitchamberCommandError(error, spec, timeoutMs),
      });
    }
  }

  return results;
}

export async function runPiUpdate(
  options: {
    dryRun?: boolean;
    approve?: boolean;
    piPath?: string;
    piCommand?: string;
    piPackageWorkspace?: string;
    piPackageManager?: PackageManagerCommand;
    execFile?: typeof execFileSync;
    log?: (message: string) => void;
  } = {},
): Promise<void> {
  const execFile = options.execFile ?? execFileSync;
  const log = options.log ?? console.log;
  const packageManager = detectPiInstallPackageManager({ piPath: options.piPath });
  const selfUpdateCommand = buildPiSelfUpdateCommand(packageManager);
  const approveBuildsCommand = options.approve
    ? buildPiApproveBuildsCommand(packageManager)
    : undefined;

  if (selfUpdateCommand) {
    const display = formatCommand(selfUpdateCommand.command, selfUpdateCommand.args);
    if (options.dryRun) {
      log(`Would run: ${display}`);
    } else {
      // Do not let this workspace's `packageManager` pin make pnpm replace
      // itself before it can run the global update. The temporary directory
      // has no project manifest, so the installed package-manager binary runs
      // directly.
      execFile(selfUpdateCommand.command, selfUpdateCommand.args, {
        cwd: tmpdir(),
        stdio: 'inherit',
      });
      log(`Ran: ${display}`);
    }
  } else {
    log('Skipping pi self-update: could not detect a supported package manager for `pi`.');
  }

  if (options.approve) {
    if (approveBuildsCommand) {
      const display = formatCommand(approveBuildsCommand.command, approveBuildsCommand.args);
      if (options.dryRun) {
        log(`Would run: ${display}`);
      } else {
        execFile(approveBuildsCommand.command, approveBuildsCommand.args, {
          cwd: tmpdir(),
          stdio: 'inherit',
        });
        log(`Ran: ${display}`);
      }
    } else {
      log(`Skipping approve-builds: ${packageManager} installs do not use Aube approve-builds.`);
    }
  }

  if (options.dryRun) {
    log('Would run: PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 pi update --extensions');
  } else {
    // Bun prepends the workspace's node_modules/.bin to PATH for scripts. Run
    // the package-manager-owned executable directly so extension updates use
    // the CLI that the self-update step just installed. Pi invokes the user's
    // configured package manager as a child process. The pnpm environment
    // override makes this explicit update honor the registry's latest tag
    // immediately instead of silently retaining releases that are too new for
    // pnpm's default minimum-release-age policy.
    const piExecutable = options.piCommand ?? findPiExecutablePath() ?? options.piPath ?? 'pi';
    execFile(piExecutable, ['update', '--extensions'], {
      stdio: 'inherit',
      env: { ...process.env, PNPM_CONFIG_MINIMUM_RELEASE_AGE: '0' },
    });
    log('Ran: pi update --extensions');
  }

  if (!options.approve) return;

  const piPackageWorkspace = options.piPackageWorkspace ?? getDefaultPiPackageWorkspace();
  if (!existsSync(join(piPackageWorkspace, 'package.json'))) {
    log(`Skipping package build approval: no Pi package workspace at ${piPackageWorkspace}.`);
    return;
  }
  const piPackageManager =
    options.piPackageManager ?? resolvePackageManagerCommand({ cwd: piPackageWorkspace });
  const workspaceApproveCommand = buildPiPackageWorkspaceApproveBuildsCommand(piPackageManager);
  const display = formatCommand(workspaceApproveCommand.command, workspaceApproveCommand.args);
  if (options.dryRun) {
    log(`Would run in ${piPackageWorkspace}: ${display}`);
    return;
  }
  execFile(workspaceApproveCommand.command, workspaceApproveCommand.args, {
    cwd: piPackageWorkspace,
    stdio: 'inherit',
  });
  log(`Ran in ${piPackageWorkspace}: ${display}`);
}

// ---------------------------------------------------------------------------
// Sync agent workspace devDependencies with the globally installed pi CLI.
//
// pi extensions load in the same process as the CLI, so every
// @mariozechner/* package referenced by an extension MUST resolve to the
// same version as the CLI does. If the root workspace pins an older pi-tui
// than pi-coding-agent's internal copy, `instanceof Editor` checks quietly
// fail and prototype monkey-patches miss their target.
//
// This function:
//   1. Reads the globally installed pi-coding-agent's package.json.
//   2. Extracts its own version + its @mariozechner/* dep ranges.
//   3. Rewrites the agent workspace root package.json devDependencies to
//      those exact versions.
//   4. Runs the configured package manager's install command so node_modules
//      reflects the change.
// ---------------------------------------------------------------------------

function stripRangePrefix(spec: string): string {
  return spec.replace(/^[\^~>=<\s]+/, '');
}

function readGlobalPiCodingAgentPackageJson(): {
  version: string;
  path: string;
  json: { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
} {
  const packageRoot =
    findPiCodingAgentRootFromExecutable() ?? findGlobalPackagePath(PI_CODING_AGENT_PACKAGE_NAME);
  if (!packageRoot) {
    throw new Error(
      `Could not locate globally installed ${PI_CODING_AGENT_PACKAGE_NAME} via configured package manager, aube, or pnpm.`,
    );
  }
  const packageJsonPath = join(packageRoot, 'package.json');
  const json = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    version?: string;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  if (!json.version) {
    throw new Error(`Missing version in ${packageJsonPath}`);
  }
  return { version: json.version, path: packageJsonPath, json };
}

function computeDesiredPiSiblingVersions(): {
  piCodingAgentVersion: string;
  desired: Record<string, string>;
} {
  const { version: piCodingAgentVersion, json } = readGlobalPiCodingAgentPackageJson();
  const globalDeps: Record<string, string> = {
    ...json.dependencies,
    ...json.peerDependencies,
  };

  const desired: Record<string, string> = {};
  for (const name of PI_SIBLING_PACKAGES) {
    if (name === PI_CODING_AGENT_PACKAGE_NAME) {
      desired[name] = piCodingAgentVersion;
      continue;
    }
    const spec = globalDeps[name];
    // pi-agent-core landed in 0.67.x; older pi-coding-agent releases will
    // not declare it. Absence means "skip pinning", not "error".
    if (spec) {
      desired[name] = stripRangePrefix(spec);
    }
  }
  return { piCodingAgentVersion, desired };
}

function planDepSyncChanges(
  current: Record<string, string>,
  desired: Record<string, string>,
): DepSyncChange[] {
  const changes: DepSyncChange[] = [];
  for (const [name, to] of Object.entries(desired)) {
    const from = current[name];
    if (!from) {
      changes.push({ kind: 'add', name, to });
    } else if (stripRangePrefix(from) !== to) {
      changes.push({ kind: 'bump', name, from, to });
    }
  }
  return changes;
}

function writeDepSyncToPackageJson(packageJsonPath: string, changes: DepSyncChange[]): void {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    devDependencies?: Record<string, string>;
    [key: string]: unknown;
  };
  const devDependencies: Record<string, string> = { ...pkg.devDependencies };
  for (const change of changes) {
    devDependencies[change.name] = change.to;
  }
  const sortedDevDependencies = Object.fromEntries(
    Object.entries(devDependencies).sort(([a], [b]) => a.localeCompare(b)),
  );
  pkg.devDependencies = sortedDevDependencies;
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

export function getPnpmWorkspaceOverrideChanges(
  workspacePath: string,
  desired: Record<string, string>,
): DepSyncChange[] {
  if (!existsSync(workspacePath)) return [];
  const content = readFileSync(workspacePath, 'utf8');
  const changes: DepSyncChange[] = [];

  for (const [name, to] of Object.entries(desired)) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = content.match(new RegExp(`^\\s*['"]?${escapedName}['"]?\\s*:\\s*(\\S+)`, 'm'));
    const from = match?.[1]?.replace(/^['"]|['"]$/g, '');
    if (from && from !== to) changes.push({ kind: 'bump', name, from, to });
  }

  return changes;
}

export function writePnpmWorkspaceOverrides(
  workspacePath: string,
  changes: readonly DepSyncChange[],
): void {
  if (changes.length === 0) return;
  let content = readFileSync(workspacePath, 'utf8');

  for (const change of changes) {
    const escapedName = change.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^(\\s*['"]?${escapedName}['"]?\\s*:\\s*)\\S+`, 'm');
    content = content.replace(pattern, `$1${change.to}`);
  }

  writeFileSync(workspacePath, content);
}

function dedupeDepSyncChanges(changes: readonly DepSyncChange[]): DepSyncChange[] {
  const seen = new Set<string>();
  return changes.filter((change) => {
    const key = JSON.stringify(change);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function syncDevDependenciesWithGlobalPi(
  options: { dryRun?: boolean; cwd?: string } = {},
): Promise<DepSyncResult> {
  const cwd = options.cwd ?? REPO_ROOT;
  const packageJsonPath = join(cwd, 'package.json');
  const pnpmWorkspacePath = join(cwd, 'pnpm-workspace.yaml');

  const { piCodingAgentVersion, desired } = computeDesiredPiSiblingVersions();
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    devDependencies?: Record<string, string>;
  };
  const current: Record<string, string> = { ...pkg.devDependencies };

  const packageJsonChanges = planDepSyncChanges(current, desired);
  const workspaceOverrideChanges = getPnpmWorkspaceOverrideChanges(pnpmWorkspacePath, desired);
  const changes = dedupeDepSyncChanges([...packageJsonChanges, ...workspaceOverrideChanges]);

  if (changes.length === 0) {
    return { status: 'in-sync', changes, piCodingAgentVersion };
  }

  if (options.dryRun) {
    return { status: 'would-update', changes, piCodingAgentVersion };
  }

  writeDepSyncToPackageJson(packageJsonPath, packageJsonChanges);
  writePnpmWorkspaceOverrides(pnpmWorkspacePath, workspaceOverrideChanges);
  const packageManager = resolvePackageManagerCommand({ cwd });
  execFileSync(packageManager.command, [...packageManager.args, 'install'], {
    stdio: 'inherit',
    cwd,
  });
  return { status: 'updated', changes, piCodingAgentVersion };
}

export function buildPiUpdateHelp(): string {
  return `Update Pi, installed Pi packages, local compatibility patches, and source snapshots.

Usage:
  mise run pi-update [options]
  bun run scripts/pi-update-extensions.ts [options]

Options:
  -n, --dry-run                  Preview all work without changing files.
  -h, --help                     Show this help and exit.
      --approve-builds           Approve all pending dependency build scripts.
      --approve                  Alias for --approve-builds.
      --skip-update              Do not update Pi or installed Pi packages.
      --skip-deps-sync           Do not align workspace Pi dependencies.
      --skip-patch               Do not verify or apply compatibility patches.
      --skip-gitchamber          Do not refresh source snapshots.
      --gitchamber-timeout=SEC   Stop one source fetch after SEC seconds.
                                 Default: ${DEFAULT_GITCHAMBER_TIMEOUT_MS / 1000}.

Examples:
  mise run pi-update-dry-run
  mise run pi-update
  mise run pi-update --skip-update --skip-deps-sync --skip-gitchamber
  mise run pi-update --skip-update --skip-deps-sync --skip-patch --gitchamber-timeout=900`;
}

export function parseCliArgs(argv: string[]): UpdateCliArgs {
  let dryRun = false;
  let help = false;
  let approve = false;
  let skipUpdate = false;
  let skipDepsSync = false;
  let skipPatch = false;
  let skipGitchamber = false;
  let gitchamberTimeoutMs = DEFAULT_GITCHAMBER_TIMEOUT_MS;

  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') {
      dryRun = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--approve' || arg === '--approve-builds') {
      approve = true;
      continue;
    }
    if (arg === '--skip-update') {
      skipUpdate = true;
      continue;
    }
    if (arg === '--skip-deps-sync') {
      skipDepsSync = true;
      continue;
    }
    if (arg === '--skip-patch') {
      skipPatch = true;
      continue;
    }
    if (arg === '--skip-gitchamber') {
      skipGitchamber = true;
      continue;
    }
    if (arg.startsWith('--gitchamber-timeout=')) {
      const seconds = Number(arg.slice('--gitchamber-timeout='.length));
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error('--gitchamber-timeout must be a positive number of seconds');
      }
      gitchamberTimeoutMs = Math.ceil(seconds * 1000);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    dryRun,
    help,
    approve,
    skipUpdate,
    skipDepsSync,
    skipPatch,
    skipGitchamber,
    gitchamberTimeoutMs,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const {
    dryRun,
    help,
    approve,
    skipUpdate,
    skipDepsSync,
    skipPatch,
    skipGitchamber,
    gitchamberTimeoutMs,
  } = parseCliArgs(argv);

  if (help) {
    console.log(buildPiUpdateHelp());
    return 0;
  }

  if (!skipUpdate) {
    await runPiUpdate({ dryRun, approve });
  }

  if (!skipDepsSync) {
    try {
      const depSync = await syncDevDependenciesWithGlobalPi({ dryRun, cwd: REPO_ROOT });
      if (depSync.status === 'in-sync') {
        console.log(
          `Dep sync: already in sync with globally installed pi@${depSync.piCodingAgentVersion}.`,
        );
      } else {
        console.log(
          `Dep sync: ${depSync.status} against globally installed pi@${depSync.piCodingAgentVersion}.`,
        );
        for (const change of depSync.changes) {
          if (change.kind === 'bump') {
            console.log(`  bump ${change.name}: ${change.from} -> ${change.to}`);
          } else {
            console.log(`  add  ${change.name}: ${change.to}`);
          }
        }
      }
    } catch (error) {
      console.error(`Dep sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const installedPackages = getInstalledPackages({ cwd: REPO_ROOT });

  if (!skipPatch) {
    try {
      const resolverResult = verifyPiCodingAgentResolverUpstreamFix({ cwd: REPO_ROOT });
      console.log(
        `Verified upstream: pi-coding-agent authenticated resolver (${resolverResult.version})`,
      );
    } catch (error) {
      console.error(
        `Failed pi-coding-agent resolver verification: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const transcriptCacheResult = await applyPiCodingAgentTranscriptCachePatch({
        dryRun,
        cwd: REPO_ROOT,
      });
      const label =
        transcriptCacheResult.status === 'already-applied'
          ? `Already applied: pi-coding-agent transcript cache patch (${transcriptCacheResult.version})`
          : transcriptCacheResult.status === 'would-apply'
            ? `Would apply: pi-coding-agent transcript cache patch (${transcriptCacheResult.version})`
            : `${transcriptCacheResult.status}: pi-coding-agent transcript cache patch (${transcriptCacheResult.version}) via ${transcriptCacheResult.patchPath}`;
      console.log(label);
    } catch (error) {
      console.error(
        `Skipped pi-coding-agent transcript cache patch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const bedrockResult = verifyPiAiBedrockApiKeyBearerUpstreamFix({ cwd: REPO_ROOT });
      console.log(`Verified upstream: pi-ai Bedrock apiKey bearer (${bedrockResult.version})`);
    } catch (error) {
      console.error(
        `Failed pi-ai Bedrock apiKey bearer verification: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const codexAuthResult = await applyPiAiOpenAICodexAuthHeaderPatch({
        dryRun,
        cwd: REPO_ROOT,
      });
      const label =
        codexAuthResult.status === 'already-applied'
          ? `Already applied: pi-ai OpenAI Codex authHeader patch (${codexAuthResult.version})`
          : codexAuthResult.status === 'would-apply'
            ? `Would apply: pi-ai OpenAI Codex authHeader patch (${codexAuthResult.version})`
            : `${codexAuthResult.status}: pi-ai OpenAI Codex authHeader patch (${codexAuthResult.version}) via ${codexAuthResult.patchPath}`;
      console.log(label);
    } catch (error) {
      console.error(
        `Skipped pi-ai OpenAI Codex authHeader patch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const computerUseResult = await applyAmasterPiComputerUseAnalyzeScreenshotPatch({
        dryRun,
        cwd: REPO_ROOT,
        packageRoot: findInstalledNpmPackagePath(
          installedPackages,
          AMASTER_PI_COMPUTER_USE_PACKAGE_NAME,
        ),
      });
      const label =
        computerUseResult.status === 'already-applied'
          ? `Already applied: @amaster.ai/pi-computer-use analyze_screenshot patch (${computerUseResult.version})`
          : computerUseResult.status === 'would-apply'
            ? `Would apply: @amaster.ai/pi-computer-use analyze_screenshot patch (${computerUseResult.version})`
            : `${computerUseResult.status}: @amaster.ai/pi-computer-use analyze_screenshot patch (${computerUseResult.version}) via ${computerUseResult.patchPath}`;
      console.log(label);
    } catch (error) {
      console.error(
        `Skipped @amaster.ai/pi-computer-use analyze_screenshot patch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const plannotatorResult = await applyPlannotatorCodexCompatibilityPatch({
        dryRun,
        cwd: REPO_ROOT,
        packageRoot: findInstalledNpmPackagePath(
          installedPackages,
          PLANNOTATOR_PI_EXTENSION_PACKAGE_NAME,
        ),
      });
      const label =
        plannotatorResult.status === 'already-applied'
          ? `Already applied: @plannotator/pi-extension Codex CLI compatibility patch (${plannotatorResult.version})`
          : plannotatorResult.status === 'would-apply'
            ? `Would apply: @plannotator/pi-extension Codex CLI compatibility patch (${plannotatorResult.version})`
            : `${plannotatorResult.status}: @plannotator/pi-extension Codex CLI compatibility patch (${plannotatorResult.version}) via ${plannotatorResult.patchPath}`;
      console.log(label);
    } catch (error) {
      console.error(
        `Skipped @plannotator/pi-extension Codex CLI compatibility patch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const mermaidResult = await applyPiMermaidPatch({
        dryRun,
        cwd: REPO_ROOT,
      });
      const label =
        mermaidResult.status === 'already-applied'
          ? `Already applied: pi-mermaid compatibility patch (${mermaidResult.version})`
          : mermaidResult.status === 'would-apply'
            ? `Would apply: pi-mermaid compatibility patch (${mermaidResult.version})`
            : `${mermaidResult.status}: pi-mermaid compatibility patch (${mermaidResult.version}) via ${mermaidResult.patchPath}`;
      console.log(label);
    } catch (error) {
      console.error(
        `Skipped pi-mermaid compatibility patch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const herdrResult = await applyPiHerdrPromptGuidancePatch({
        dryRun,
        cwd: REPO_ROOT,
        packageRoot: findInstalledNpmPackagePath(installedPackages, PI_HERDR_PACKAGE_NAME),
      });
      const label =
        herdrResult.status === 'already-applied'
          ? `Already applied: pi-herdr prompt guidance patch (${herdrResult.version})`
          : herdrResult.status === 'would-apply'
            ? `Would apply: pi-herdr prompt guidance patch (${herdrResult.version})`
            : `${herdrResult.status}: pi-herdr prompt guidance patch (${herdrResult.version}) via ${herdrResult.patchPath}`;
      console.log(label);
    } catch (error) {
      console.error(
        `Skipped pi-herdr prompt guidance patch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const continuousLearningResult = await applyPiContinuousLearningPatch({
        dryRun,
        cwd: REPO_ROOT,
      });
      const label =
        continuousLearningResult.status === 'already-applied'
          ? `Already applied: pi-continuous-learning compatibility patch (${continuousLearningResult.version})`
          : continuousLearningResult.status === 'would-apply'
            ? `Would apply: pi-continuous-learning compatibility patch (${continuousLearningResult.version})`
            : `${continuousLearningResult.status}: pi-continuous-learning compatibility patch (${continuousLearningResult.version}) via ${continuousLearningResult.patchPath}`;
      console.log(label);
    } catch (error) {
      console.error(
        `Skipped pi-continuous-learning compatibility patch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    for (const packageName of BB_THREAD_ORCHESTRATION_PACKAGE_NAMES) {
      try {
        const result = await applyBbThreadOrchestrationGuardPatch({
          packageName,
          dryRun,
          cwd: REPO_ROOT,
          packageRoot: findInstalledNpmPackagePath(installedPackages, packageName),
        });
        const label =
          result.status === 'already-applied'
            ? `Already applied: ${packageName} BB thread orchestration guard (${result.version})`
            : result.status === 'would-apply'
              ? `Would apply: ${packageName} BB thread orchestration guard (${result.version})`
              : `${result.status}: ${packageName} BB thread orchestration guard (${result.version}) via ${result.patchPath}`;
        console.log(label);
      } catch (error) {
        console.error(
          `Skipped ${packageName} BB thread orchestration guard: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    try {
      const subagentsApplyPatchToolResult = await applyPiSubagentsApplyPatchToolPatch({
        dryRun,
        cwd: REPO_ROOT,
        packageRoot: findInstalledNpmPackagePath(installedPackages, 'pi-subagents'),
      });
      const label =
        subagentsApplyPatchToolResult.status === 'already-applied'
          ? `Already applied: pi-subagents apply_patch agent tool patch (${subagentsApplyPatchToolResult.version})`
          : subagentsApplyPatchToolResult.status === 'would-apply'
            ? `Would apply: pi-subagents apply_patch agent tool patch (${subagentsApplyPatchToolResult.version})`
            : `${subagentsApplyPatchToolResult.status}: pi-subagents apply_patch agent tool patch (${subagentsApplyPatchToolResult.version}) via ${subagentsApplyPatchToolResult.patchPath}`;
      console.log(label);
    } catch (error) {
      console.error(
        `Skipped pi-subagents apply_patch agent tool patch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const subagentsPathLinksResult = await applyPiSubagentsTuiPathLinksPatch({
        dryRun,
        cwd: REPO_ROOT,
        packageRoot: findInstalledNpmPackagePath(installedPackages, 'pi-subagents'),
      });
      const label =
        subagentsPathLinksResult.status === 'already-applied'
          ? `Already applied: pi-subagents compact TUI path links patch (${subagentsPathLinksResult.version})`
          : subagentsPathLinksResult.status === 'would-apply'
            ? `Would apply: pi-subagents compact TUI path links patch (${subagentsPathLinksResult.version})`
            : `${subagentsPathLinksResult.status}: pi-subagents compact TUI path links patch (${subagentsPathLinksResult.version}) via ${subagentsPathLinksResult.patchPath}`;
      console.log(label);
    } catch (error) {
      console.error(
        `Skipped pi-subagents compact TUI path links patch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Update gitchamber sources for extensions and pi-agent packages
  if (!skipGitchamber) {
    const gitchamberResults = await updateGitchamberSources(installedPackages, {
      dryRun,
      cwd: REPO_ROOT,
      timeoutMs: gitchamberTimeoutMs,
    });
    if (gitchamberResults.length > 0) {
      console.log(
        `${dryRun ? 'Gitchamber source plan' : 'Gitchamber source results'} (${gitchamberResults.length}):`,
      );
      for (const result of gitchamberResults) {
        const statusLabel = result.status === 'error' ? ` (${result.error})` : '';
        console.log(`- ${result.packageSpec} (${result.status})${statusLabel}`);
      }
    } else {
      console.log('No gitchamber sources to fetch');
    }
  }

  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
