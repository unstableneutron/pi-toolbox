#!/usr/bin/env bun

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
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

/** Subset of GITCHAMBER_PACKAGES that must always be pinned in the agent
 * workspace's devDependencies. (Same list today, kept as a separate name
 * for intent clarity.) */
const PI_SIBLING_PACKAGES = GITCHAMBER_PACKAGES;

/** Manual overrides for packages that don't have detectable repo metadata */
const GITCHAMBER_MANUAL_OVERRIDES: Record<string, string> = {
  'pi-boomerang': 'nicobailon/pi-boomerang',
};

/**
 * Extension packages that currently publish without Aube trusted-publisher
 * evidence even though older releases had it. Keeping these package-level
 * excludes in the user Aube config lets `pi update --extensions` continue to
 * fail closed for every other dependency while bypassing known Pi extension
 * trust-downgrade false positives.
 */
const AUBE_EXTENSION_TRUST_POLICY_EXCLUDES = ['pi-subagents'] as const;

export type UpdateCliArgs = {
  directory?: string;
  dryRun: boolean;
  approve: boolean;
  skipUpdate: boolean;
  skipDepsSync: boolean;
  skipPatch: boolean;
  skipGitchamber: boolean;
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

export type AubeTrustPolicyExcludeResult = {
  status: 'already-present' | 'updated' | 'would-update';
  configPath: string;
  entries: string[];
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
// The patch is idempotent (checked via a marker comment) and loudly fails if
// the upstream target line changes so we notice instead of silently no-oping.
// ---------------------------------------------------------------------------

const PI_CODING_AGENT_PACKAGE_NAME = '@earendil-works/pi-coding-agent';
const PI_CODING_AGENT_RESOLVER_RELATIVE_PATH = 'dist/core/model-resolver.js';
const PI_CODING_AGENT_RESOLVER_PATCH_MARKER =
  '__pi_update_extensions:model-resolver-uses-available__';
const PI_CODING_AGENT_RESOLVER_PATCH_TARGET = '    const availableModels = modelRegistry.getAll();';

export function buildPiCodingAgentResolverReplacement(): string {
  return [
    `    // ${PI_CODING_AGENT_RESOLVER_PATCH_MARKER}`,
    `    // Prefer authenticated models so fuzzy matches do not land on a`,
    `    // provider the user can't actually call. Fall back to getAll() so`,
    `    // "--api-key + --model" first-time-setup still works when nothing`,
    `    // is authenticated yet.`,
    `    let availableModels = modelRegistry.getAvailable();`,
    `    if (availableModels.length === 0) {`,
    `        availableModels = modelRegistry.getAll();`,
    `    }`,
  ].join('\n');
}

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
  '__pi_update_extensions:transcript-prefix-cache__';
const PI_CODING_AGENT_TRANSCRIPT_CACHE_INSERTION_TARGET = 'function isCustomSessionEntry(item) {';
const PI_CODING_AGENT_TRANSCRIPT_CACHE_CONSTRUCTOR_TARGET =
  '        this.chatContainer = new Container();';
const PI_CODING_AGENT_TRANSCRIPT_CACHE_CONSTRUCTOR_REPLACEMENT = [
  '        this.chatContainer = process.env.PI_TRANSCRIPT_CACHE_DISABLED === "1"',
  '            ? new Container()',
  '            : new TranscriptContainer();',
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
const PI_CODING_AGENT_TRANSCRIPT_CACHE_EXPANSION_TARGET = [
  '        for (const container of [this.loadedResourcesContainer, this.chatContainer]) {',
  '            for (const child of container.children) {',
  '                if (isExpandable(child)) {',
  '                    child.setExpanded(expanded);',
  '                }',
  '            }',
  '        }',
  '        this.ui.requestRender();',
].join('\n');
const PI_CODING_AGENT_TRANSCRIPT_CACHE_EXPANSION_REPLACEMENT = [
  '        for (const container of [this.loadedResourcesContainer, this.chatContainer]) {',
  '            for (const child of container.children) {',
  '                if (isExpandable(child)) {',
  '                    child.setExpanded(expanded);',
  '                }',
  '            }',
  '        }',
  '        this.chatContainer.invalidateRenderCache?.();',
  '        this.ui.requestRender();',
].join('\n');

export function buildPiCodingAgentTranscriptCacheInsertion(): string {
  return `// ${PI_CODING_AGENT_TRANSCRIPT_CACHE_PATCH_MARKER}
const TRANSCRIPT_LIVE_TAIL_COMPONENTS = 64;
class TranscriptContainer extends Container {
    cachedWidth;
    cachedPrefixChildren = [];
    cachedPrefixLines = [];
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
    render(width) {
        const prefixEnd = Math.max(0, this.children.length - TRANSCRIPT_LIVE_TAIL_COMPONENTS);
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

function getDefaultAubeConfigPath(): string {
  return join(homedir(), '.config', 'aube', 'config.toml');
}

function formatTomlString(value: string): string {
  return JSON.stringify(value);
}

function addTomlStringArrayEntries(
  content: string,
  key: string,
  entries: readonly string[],
): string {
  const missingEntries = entries.filter((entry) => !content.includes(formatTomlString(entry)));
  if (missingEntries.length === 0) return content;

  const arrayPattern = new RegExp(`(^${key}\\s*=\\s*\\[)([\\s\\S]*?)(^\\])`, 'm');
  const match = content.match(arrayPattern);
  if (match?.index === undefined) {
    const prefix = content.trimEnd();
    const block = [
      `${key} = [`,
      ...missingEntries.map((entry) => `    ${formatTomlString(entry)},`),
      ']',
    ].join('\n');
    return `${prefix}${prefix ? '\n' : ''}${block}\n`;
  }

  return content.replace(arrayPattern, (_full, start: string, body: string, end: string) => {
    const insertion = missingEntries.map((entry) => `    ${formatTomlString(entry)},`).join('\n');
    const separator = body.endsWith('\n') || body.length === 0 ? '' : '\n';
    return `${start}${body}${separator}${insertion}\n${end}`;
  });
}

export function ensureAubeTrustPolicyExcludes(
  entries: readonly string[] = AUBE_EXTENSION_TRUST_POLICY_EXCLUDES,
  options: { dryRun?: boolean; configPath?: string } = {},
): AubeTrustPolicyExcludeResult {
  const configPath = options.configPath ?? getDefaultAubeConfigPath();
  const content = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const missingEntries = entries.filter((entry) => !content.includes(formatTomlString(entry)));

  if (missingEntries.length === 0) {
    return { status: 'already-present', configPath, entries: [] };
  }

  if (options.dryRun) {
    return { status: 'would-update', configPath, entries: missingEntries };
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    addTomlStringArrayEntries(content, 'trustPolicyExclude', missingEntries),
  );
  return { status: 'updated', configPath, entries: missingEntries };
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

function findPiExecutablePath(): string | undefined {
  try {
    const piPaths = execFileSync('which', ['-a', 'pi'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    return (
      piPaths.find((entry) => !entry.startsWith(join(REPO_ROOT, 'node_modules', '.bin'))) ??
      piPaths[0]
    );
  } catch {
    return undefined;
  }
}

export function findPiCodingAgentRootFromExecutable(
  options: { piPath?: string } = {},
): string | undefined {
  const piPath = options.piPath ?? findPiExecutablePath();
  if (!piPath || !existsSync(piPath)) return undefined;

  const candidates: string[] = [];
  try {
    const shim = readFileSync(piPath, 'utf8');
    const target = shim.match(/^# cmd-shim-target=(.+\/dist\/cli\.js)$/m)?.[1];
    if (target) candidates.push(dirname(dirname(target)));
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

export function detectPiInstallPackageManager(
  options: { piPath?: string } = {},
): PiInstallPackageManager {
  const piPath = options.piPath ?? findPiExecutablePath();
  if (!piPath) return 'unknown';

  const candidates = [piPath];
  try {
    candidates.push(realpathSync(piPath));
  } catch {
    // The direct path is still useful for non-symlink installs.
  }

  for (const candidate of candidates) {
    const packageManager = detectPiInstallPackageManagerFromPath(candidate);
    if (packageManager !== 'unknown') return packageManager;
  }
  return 'unknown';
}

export function buildPiSelfUpdateCommand(
  packageManager: PiInstallPackageManager,
  packageName = PI_CODING_AGENT_PACKAGE_NAME,
): PiSelfUpdateCommand | undefined {
  switch (packageManager) {
    case 'aube':
      return { packageManager, command: 'aube', args: ['add', '-g', `${packageName}@latest`] };
    case 'pnpm':
      return { packageManager, command: 'pnpm', args: ['update', '-g', '--latest', packageName] };
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
  // Global package-manager commands should not inherit the project cwd. pnpm,
  // for example, warns when package.json contains npm-style `workspaces`, even
  // for `pnpm root -g` / `pnpm list -g`. Run these global lookups from a neutral
  // cwd while still using the project cwd above for command availability checks.
  const globalCommandCwd = tmpdir();
  const packageManagers = options.packageManagerCommand
    ? [options.packageManagerCommand]
    : getPackageManagerCommandCandidates(options);

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

export function isPiCodingAgentResolverPatchApplied(packageRoot: string): boolean {
  const filePath = join(packageRoot, PI_CODING_AGENT_RESOLVER_RELATIVE_PATH);
  if (!existsSync(filePath)) return false;
  return readFileSync(filePath, 'utf8').includes(PI_CODING_AGENT_RESOLVER_PATCH_MARKER);
}

export async function applyPiCodingAgentResolverPatch(
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
  const filePath = join(packageRoot, PI_CODING_AGENT_RESOLVER_RELATIVE_PATH);
  if (!existsSync(filePath)) {
    throw new Error(`pi-coding-agent@${version}: resolver file not found at ${filePath}`);
  }

  if (isPiCodingAgentResolverPatchApplied(packageRoot)) {
    return { status: 'already-applied', packageRoot, version, patchPath: filePath };
  }

  const content = readFileSync(filePath, 'utf8');
  if (!content.includes(PI_CODING_AGENT_RESOLVER_PATCH_TARGET)) {
    throw new Error(
      `pi-coding-agent@${version}: target line for resolver patch not found at ${filePath}. ` +
        `Expected exact line: ${JSON.stringify(PI_CODING_AGENT_RESOLVER_PATCH_TARGET)}. ` +
        `Upstream may have changed; update pi-update-extensions.ts.`,
    );
  }

  if (options.dryRun) {
    return { status: 'would-apply', packageRoot, version, patchPath: filePath };
  }

  const patched = content.replace(
    PI_CODING_AGENT_RESOLVER_PATCH_TARGET,
    buildPiCodingAgentResolverReplacement(),
  );
  writeFileSync(filePath, patched);
  return { status: 'applied', packageRoot, version, patchPath: filePath };
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
  const requiredTargets = [
    PI_CODING_AGENT_TRANSCRIPT_CACHE_INSERTION_TARGET,
    PI_CODING_AGENT_TRANSCRIPT_CACHE_CONSTRUCTOR_TARGET,
    PI_CODING_AGENT_TRANSCRIPT_CACHE_HIDDEN_LABEL_TARGET,
    PI_CODING_AGENT_TRANSCRIPT_CACHE_EXPANSION_TARGET,
  ];
  const missingTarget = requiredTargets.find((target) => !content.includes(target));
  if (missingTarget) {
    throw new Error(
      `pi-coding-agent@${version}: transcript cache target not found at ${filePath}. ` +
        `Expected exact text: ${JSON.stringify(missingTarget)}. ` +
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
      PI_CODING_AGENT_TRANSCRIPT_CACHE_EXPANSION_TARGET,
      PI_CODING_AGENT_TRANSCRIPT_CACHE_EXPANSION_REPLACEMENT,
    );
  writeJavaScriptPatchAtomically(filePath, patched);
  return { status: 'applied', packageRoot, version, patchPath: filePath };
}

// ---------------------------------------------------------------------------
// pi-ai Bedrock provider apiKey bearer patch
//
// Patches `dist/providers/amazon-bedrock.js` in the installed
// @earendil-works/pi-ai so facade Bedrock Converse routes can use the
// provider-level `apiKey` as the SDK HTTP bearer token. This avoids exporting
// AWS_BEARER_TOKEN_BEDROCK, which would make the built-in amazon-bedrock
// provider appear authenticated and load all of its models.
//
// Keep the behavior narrowly scoped to local facade providers: built-in
// amazon-bedrock must continue to use normal AWS credentials, and other
// providers should not implicitly reinterpret apiKey as a Bedrock bearer token.
// ---------------------------------------------------------------------------

const PI_AI_PACKAGE_NAME = '@earendil-works/pi-ai';
const PI_AI_BEDROCK_RELATIVE_PATHS = [
  'dist/api/bedrock-converse-stream.js',
  'dist/providers/amazon-bedrock.js',
] as const;
const PI_AI_BEDROCK_API_KEY_BEARER_PATCH_MARKER =
  '__pi_update_extensions:bedrock-api-key-as-bearer__';
const PI_AI_BEDROCK_API_KEY_BEARER_PATCH_TARGETS = [
  '        const bearerToken = options.bearerToken || process.env.AWS_BEARER_TOKEN_BEDROCK || undefined;',
  '        const bearerToken = options.bearerToken || getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options.env) || undefined;',
] as const;

export function buildPiAiBedrockApiKeyBearerReplacement(): string {
  return [
    `        // ${PI_AI_BEDROCK_API_KEY_BEARER_PATCH_MARKER}`,
    `        // Local facade Bedrock proxies authenticate with provider apiKey`,
    `        // as an HTTP bearer token. Do not apply this to built-in`,
    `        // amazon-bedrock, where auth can come from AWS credential-chain`,
    `        // sentinels instead of a real bearer token.`,
    `        const envBearerToken =`,
    `            typeof getProviderEnvValue === "function"`,
    `                ? getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options.env)`,
    `                : process.env.AWS_BEARER_TOKEN_BEDROCK;`,
    `        const bearerToken =`,
    `            options.bearerToken ||`,
    `            (["facade", "facade-full"].includes(model.provider) ? options.apiKey : undefined) ||`,
    `            envBearerToken ||`,
    `            undefined;`,
  ].join('\n');
}

export function isPiAiBedrockApiKeyBearerPatchApplied(packageRoot: string): boolean {
  const filePath = findExistingPackageFile(packageRoot, PI_AI_BEDROCK_RELATIVE_PATHS);
  if (!filePath) return false;
  return readFileSync(filePath, 'utf8').includes(PI_AI_BEDROCK_API_KEY_BEARER_PATCH_MARKER);
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

export async function applyPiAiBedrockApiKeyBearerPatch(
  options: { dryRun?: boolean; packageRoot?: string; cwd?: string } = {},
): Promise<ApplyPatchResult> {
  const packageRoot = options.packageRoot ?? findPiAiPackageRoot({ cwd: options.cwd });
  if (!packageRoot) {
    throw new Error(
      `Could not locate installed ${PI_AI_PACKAGE_NAME} via configured package manager, aube, or pnpm`,
    );
  }

  const version = getPackageVersion(packageRoot) ?? 'unknown';
  const filePath = findExistingPackageFile(packageRoot, PI_AI_BEDROCK_RELATIVE_PATHS);
  if (!filePath) {
    throw new Error(
      `pi-ai@${version}: Bedrock provider file not found at any of ${PI_AI_BEDROCK_RELATIVE_PATHS.join(', ')}`,
    );
  }

  if (isPiAiBedrockApiKeyBearerPatchApplied(packageRoot)) {
    return { status: 'already-applied', packageRoot, version, patchPath: filePath };
  }

  const content = readFileSync(filePath, 'utf8');
  const target = PI_AI_BEDROCK_API_KEY_BEARER_PATCH_TARGETS.find((candidate) =>
    content.includes(candidate),
  );
  if (!target) {
    throw new Error(
      `pi-ai@${version}: target line for Bedrock apiKey bearer patch not found at ${filePath}. ` +
        `Expected one of: ${JSON.stringify([...PI_AI_BEDROCK_API_KEY_BEARER_PATCH_TARGETS])}. ` +
        `Upstream may have changed; update pi-update-extensions.ts.`,
    );
  }

  if (options.dryRun) {
    return { status: 'would-apply', packageRoot, version, patchPath: filePath };
  }

  const patched = content.replace(target, buildPiAiBedrockApiKeyBearerReplacement());
  writeFileSync(filePath, patched);
  return { status: 'applied', packageRoot, version, patchPath: filePath };
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
// pi-herdr owns the `herdr` tool and is the right place for Herdr-specific
// tool routing guidance. Keep the local herdr-agent-state fork focused on
// pane state IPC, and patch pi-herdr's promptGuidelines after package updates.
// ---------------------------------------------------------------------------

const PI_HERDR_PACKAGE_NAME = '@ogulcancelik/pi-herdr';
const PI_HERDR_INDEX_RELATIVE_PATH = 'index.ts';
const PI_HERDR_PROMPT_GUIDANCE_PATCH_MARKER = '__pi_update_extensions:pi-herdr-prompt-guidance__';
const PI_HERDR_PROMPT_GUIDANCE_TARGET =
  '\t\t\t"Use `herdr` run for long-running processes in other panes instead of `bash`.",';

const PI_HERDR_BASH_ROUTING_GUIDELINE =
  'Use `bash` for quick one-shot commands; use `herdr` when a task needs a real pane: prompts, user input, sudo, persistent cwd/env, logs, sentinels, or follow-up commands.';
const PI_HERDR_SUDO_SENTINEL_GUIDELINE =
  'For sudo/user-input flows: split a fresh pane down (`pane_split`, `direction: "down"`), set `focus: true` only when the user must type now, verify readiness, run `sudo -v` with `SUDO_READY:<id>`, keep dependent commands in that pane (sudo auth is per pane/TTY), end with `TASK_DONE:<id>`, `watch` both exact sentinels, read final output, then `stop` one-off panes.';

export function buildPiHerdrPromptGuidanceReplacement(): string {
  return [
    PI_HERDR_PROMPT_GUIDANCE_TARGET,
    `\t\t\t// ${PI_HERDR_PROMPT_GUIDANCE_PATCH_MARKER}`,
    `\t\t\t${JSON.stringify(PI_HERDR_BASH_ROUTING_GUIDELINE)},`,
    `\t\t\t${JSON.stringify(PI_HERDR_SUDO_SENTINEL_GUIDELINE)},`,
  ].join('\n');
}

function isPiHerdrPromptGuidanceSemanticallyPatched(content: string): boolean {
  return (
    content.includes(PI_HERDR_BASH_ROUTING_GUIDELINE) &&
    content.includes(PI_HERDR_SUDO_SENTINEL_GUIDELINE)
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
  if (!content.includes(PI_HERDR_PROMPT_GUIDANCE_TARGET)) {
    throw new Error(
      `pi-herdr@${version}: target text for pi-herdr prompt guidance patch not found at ${filePath}. ` +
        `Upstream may have changed; update pi-update-extensions.ts.`,
    );
  }

  if (options.dryRun) {
    return { status: 'would-apply', packageRoot, version, patchPath: filePath };
  }

  const patched = content.replace(
    PI_HERDR_PROMPT_GUIDANCE_TARGET,
    buildPiHerdrPromptGuidanceReplacement(),
  );
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
// pi-subagents foreground intercom detach patch
//
// pi-subagents@0.27.0 handles blocking child `contact_supervisor` asks by
// waiting for a separate `pi-intercom:detach-request` event before returning
// control to the parent foreground `subagent(...)` call. pi-intercom@0.6.0 does
// not emit that event, so the parent can remain blocked and hide the supervisor
// ask until manual interrupt/termination. Detach once the child has actually
// emitted `intercom_sent` for a blocking ask, leaving the child alive to receive
// the reply.
// ---------------------------------------------------------------------------

const PI_SUBAGENTS_PACKAGE_NAME = 'pi-subagents';
const PI_SUBAGENTS_AGENTS_RELATIVE_PATH = 'agents';
const PI_SUBAGENTS_APPLY_PATCH_TOOL_NAME = 'apply_patch';
const PI_SUBAGENTS_EXECUTION_RELATIVE_PATH = 'src/runs/foreground/execution.ts';
const PI_SUBAGENTS_INTERCOM_DETACH_PATCH_MARKER =
  '__pi_update_extensions:pi-subagents-blocking-intercom-detach__';
const PI_SUBAGENTS_INTERCOM_DETACH_VARS_TARGET = [
  '\t\tlet detached = false;',
  '\t\tlet intercomStarted = false;',
  '\t\tlet assistantError: string | undefined;',
].join('\n');
const PI_SUBAGENTS_INTERCOM_DETACH_EVENT_TYPE_TARGET = [
  '\t\t\tlet evt: { type?: string; message?: Message; toolName?: string; args?: unknown };',
  '\t\t\ttry {',
  '\t\t\t\tevt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown };',
].join('\n');
const PI_SUBAGENTS_INTERCOM_DETACH_TOOL_START_TARGET = [
  '\t\t\tif (evt.type === "tool_execution_start") {',
  '\t\t\t\tconst toolArgs = evt.args && typeof evt.args === "object" && !Array.isArray(evt.args)',
  '\t\t\t\t\t? evt.args as Record<string, unknown>',
  '\t\t\t\t\t: {};',
  '\t\t\t\tif (options.allowIntercomDetach && (evt.toolName === "intercom" || evt.toolName === "contact_supervisor")) {',
  '\t\t\t\t\tintercomStarted = true;',
  '\t\t\t\t}',
].join('\n');
const PI_SUBAGENTS_INTERCOM_DETACH_TOOL_RESULT_TARGET = [
  '\t\t\tif (evt.type === "tool_result_end" && evt.message) {',
  '\t\t\t\tresult.messages.push(evt.message);',
].join('\n');

function buildPiSubagentsVarsReplacement(): string {
  return [
    '\t\tlet detached = false;',
    '\t\tlet intercomStarted = false;',
    `\t\t// ${PI_SUBAGENTS_INTERCOM_DETACH_PATCH_MARKER}`,
    '\t\tlet blockingIntercomStarted = false;',
    '\t\tlet assistantError: string | undefined;',
  ].join('\n');
}

function buildPiSubagentsEventTypeReplacement(): string {
  return [
    '\t\t\tlet evt: { type?: string; message?: Message; toolName?: string; args?: unknown; customType?: string; data?: unknown };',
    '\t\t\ttry {',
    '\t\t\t\tevt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown; customType?: string; data?: unknown };',
  ].join('\n');
}

function buildPiSubagentsToolStartReplacement(): string {
  return [
    '\t\t\tif (options.allowIntercomDetach && intercomStarted && blockingIntercomStarted && evt.type === "custom" && evt.customType === "intercom_sent") {',
    '\t\t\t\tdetachForIntercom();',
    '\t\t\t\treturn;',
    '\t\t\t}',
    '',
    '\t\t\tif (evt.type === "tool_execution_start") {',
    '\t\t\t\tconst toolArgs = evt.args && typeof evt.args === "object" && !Array.isArray(evt.args)',
    '\t\t\t\t\t? evt.args as Record<string, unknown>',
    '\t\t\t\t\t: {};',
    '\t\t\t\tif (options.allowIntercomDetach && (evt.toolName === "intercom" || evt.toolName === "contact_supervisor")) {',
    '\t\t\t\t\tintercomStarted = true;',
    '\t\t\t\t\tblockingIntercomStarted ||= (evt.toolName === "intercom" && toolArgs.action === "ask")',
    '\t\t\t\t\t\t|| (evt.toolName === "contact_supervisor" && toolArgs.reason !== "progress_update");',
    '\t\t\t\t}',
  ].join('\n');
}

function buildPiSubagentsToolResultReplacement(): string {
  return [
    '\t\t\tif (evt.type === "tool_result_end" && evt.message) {',
    '\t\t\t\tblockingIntercomStarted = false;',
    '\t\t\t\tresult.messages.push(evt.message);',
  ].join('\n');
}

function isPiSubagentsSemanticallyPatched(content: string): boolean {
  return (
    content.includes('let blockingIntercomStarted = false;') &&
    content.includes('evt.customType === "intercom_sent"') &&
    content.includes('toolArgs.reason !== "progress_update"') &&
    content.includes('blockingIntercomStarted = false;')
  );
}

export function isPiSubagentsIntercomDetachPatchApplied(packageRoot: string): boolean {
  const filePath = join(packageRoot, PI_SUBAGENTS_EXECUTION_RELATIVE_PATH);
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf8');
  return (
    content.includes(PI_SUBAGENTS_INTERCOM_DETACH_PATCH_MARKER) ||
    isPiSubagentsSemanticallyPatched(content)
  );
}

export async function applyPiSubagentsIntercomDetachPatch(
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
  const filePath = join(packageRoot, PI_SUBAGENTS_EXECUTION_RELATIVE_PATH);
  if (!existsSync(filePath)) {
    throw new Error(`pi-subagents@${version}: execution file not found at ${filePath}`);
  }

  if (isPiSubagentsIntercomDetachPatchApplied(packageRoot)) {
    return { status: 'already-applied', packageRoot, version, patchPath: filePath };
  }

  const content = readFileSync(filePath, 'utf8');
  const missingTargets = [
    PI_SUBAGENTS_INTERCOM_DETACH_VARS_TARGET,
    PI_SUBAGENTS_INTERCOM_DETACH_EVENT_TYPE_TARGET,
    PI_SUBAGENTS_INTERCOM_DETACH_TOOL_START_TARGET,
    PI_SUBAGENTS_INTERCOM_DETACH_TOOL_RESULT_TARGET,
  ].filter((target) => !content.includes(target));
  if (missingTargets.length > 0) {
    throw new Error(
      `pi-subagents@${version}: target text for pi-subagents intercom detach patch not found at ${filePath}. ` +
        `Missing ${missingTargets.length} target(s). Upstream may have changed; update pi-update-extensions.ts.`,
    );
  }

  if (options.dryRun) {
    return { status: 'would-apply', packageRoot, version, patchPath: filePath };
  }

  const patched = content
    .replace(PI_SUBAGENTS_INTERCOM_DETACH_VARS_TARGET, buildPiSubagentsVarsReplacement())
    .replace(PI_SUBAGENTS_INTERCOM_DETACH_EVENT_TYPE_TARGET, buildPiSubagentsEventTypeReplacement())
    .replace(PI_SUBAGENTS_INTERCOM_DETACH_TOOL_START_TARGET, buildPiSubagentsToolStartReplacement())
    .replace(
      PI_SUBAGENTS_INTERCOM_DETACH_TOOL_RESULT_TARGET,
      buildPiSubagentsToolResultReplacement(),
    );
  writeFileSync(filePath, patched);
  return { status: 'applied', packageRoot, version, patchPath: filePath };
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
// pi-codex-goal post-compaction continuation patch
//
// pi-codex-goal@0.1.21 can enter host-overflow recovery after a large
// assistant(stop) turn, let the host auto-compact, and then block its normal
// hidden continuation because the recovery phase requires a user-started turn.
// If no user-like follow-up is queued after compaction, Pi may attempt a bare
// agent.continue() from an assistant tail and fail with
// "Cannot continue from message role: assistant".
//
// The hotfix queues the active goal continuation as a user follow-up after
// host-overflow compaction, before the normal hidden-continuation gate.
// ---------------------------------------------------------------------------

const PI_CODEX_GOAL_PACKAGE_NAME = 'pi-codex-goal';
const PI_CODEX_GOAL_SESSION_HANDLERS_RELATIVE_PATH = 'src/goal-runtime-session-handlers.ts';
const PI_CODEX_GOAL_POST_COMPACTION_USER_FOLLOWUP_PATCH_MARKER =
  '__pi_update_extensions:pi-codex-goal-post-compaction-user-followup__';
const PI_CODEX_GOAL_POST_COMPACTION_USER_FOLLOWUP_TARGET = [
  '      recoveryRuntime.onSessionCompact();',
  '      status.refreshUi(ctx);',
  '      if (!recoveryPhaseBlocksContinuation(runtimeState.recoveryState.phase)) {',
  '        continuation.maybeContinueAfterCurrentEvent(ctx);',
  '      }',
].join('\n');

function buildPiCodexGoalPostCompactionUserFollowupReplacement(): string {
  return [
    '      recoveryRuntime.onSessionCompact();',
    '      status.refreshUi(ctx);',
    `      // ${PI_CODEX_GOAL_POST_COMPACTION_USER_FOLLOWUP_PATCH_MARKER}`,
    '      const postCompactionGoal = stateController.getGoal();',
    '      if (',
    '        postCompactionGoal?.status === "active" &&',
    '        runtimeState.recoveryState.phase.kind === "hostOverflowRecoveringNeedsUserStart"',
    '      ) {',
    '        pi.sendUserMessage(compactContinuationPrompt(postCompactionGoal), {',
    '          deliverAs: "followUp",',
    '        });',
    '        return;',
    '      }',
    '      if (!recoveryPhaseBlocksContinuation(runtimeState.recoveryState.phase)) {',
    '        continuation.maybeContinueAfterCurrentEvent(ctx);',
    '      }',
  ].join('\n');
}

function isPiCodexGoalPostCompactionUserFollowupSemanticallyPatched(content: string): boolean {
  return (
    content.includes('const postCompactionGoal = stateController.getGoal();') &&
    content.includes(
      'runtimeState.recoveryState.phase.kind === "hostOverflowRecoveringNeedsUserStart"',
    ) &&
    content.includes('pi.sendUserMessage(compactContinuationPrompt(postCompactionGoal), {') &&
    content.includes('deliverAs: "followUp"')
  );
}

export function isPiCodexGoalPostCompactionUserFollowupPatchApplied(packageRoot: string): boolean {
  const filePath = join(packageRoot, PI_CODEX_GOAL_SESSION_HANDLERS_RELATIVE_PATH);
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf8');
  return (
    content.includes(PI_CODEX_GOAL_POST_COMPACTION_USER_FOLLOWUP_PATCH_MARKER) ||
    isPiCodexGoalPostCompactionUserFollowupSemanticallyPatched(content)
  );
}

export async function applyPiCodexGoalPostCompactionUserFollowupPatch(
  options: { dryRun?: boolean; packageRoot?: string; cwd?: string } = {},
): Promise<ApplyPatchResult> {
  const packageRoot =
    options.packageRoot ?? findGlobalPackagePath(PI_CODEX_GOAL_PACKAGE_NAME, { cwd: options.cwd });
  if (!packageRoot) {
    throw new Error(
      `Could not locate installed ${PI_CODEX_GOAL_PACKAGE_NAME} via configured package manager, aube, or pnpm`,
    );
  }

  const version = getPackageVersion(packageRoot) ?? 'unknown';
  const filePath = join(packageRoot, PI_CODEX_GOAL_SESSION_HANDLERS_RELATIVE_PATH);
  if (!existsSync(filePath)) {
    throw new Error(`pi-codex-goal@${version}: session handler file not found at ${filePath}`);
  }

  if (isPiCodexGoalPostCompactionUserFollowupPatchApplied(packageRoot)) {
    return { status: 'already-applied', packageRoot, version, patchPath: filePath };
  }

  const content = readFileSync(filePath, 'utf8');
  if (!content.includes(PI_CODEX_GOAL_POST_COMPACTION_USER_FOLLOWUP_TARGET)) {
    throw new Error(
      `pi-codex-goal@${version}: target text for pi-codex-goal post-compaction user follow-up patch not found at ${filePath}. ` +
        'Upstream may have changed; update pi-update-extensions.ts.',
    );
  }

  if (options.dryRun) {
    return { status: 'would-apply', packageRoot, version, patchPath: filePath };
  }

  const patched = content.replace(
    PI_CODEX_GOAL_POST_COMPACTION_USER_FOLLOWUP_TARGET,
    buildPiCodexGoalPostCompactionUserFollowupReplacement(),
  );
  writeFileSync(filePath, patched);
  return { status: 'applied', packageRoot, version, patchPath: filePath };
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

/** Build a gitchamber package spec with exact version */
function buildGitchamberSpec(source: string, version: string): string | undefined {
  // Handle npm: prefix
  if (source.startsWith('npm:')) {
    const packageName = source.slice(4);
    return `${packageName}@${version}`;
  }
  // Handle git/github sources - use as-is for repos
  if (source.startsWith('git:') || source.startsWith('https://github.com/')) {
    // For git sources, we can't easily version-lock via gitchamber
    // Return undefined to skip
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
function extractGitHubRepoFromReadme(
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

  // Strategy 5: Return first valid match if any found (only if it's a reasonable guess)
  if (validMatches.length > 0) {
    // Only use first match if the repo name starts with "pi-" (pi package naming convention)
    const [, owner, repo] = validMatches[0];
    if (repo.startsWith('pi-')) {
      return `${owner}/${repo}`;
    }
  }

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
export async function updateGitchamberSources(
  installedPackages: readonly InstalledPackage[],
  options: { dryRun?: boolean; cwd?: string } = {},
): Promise<GitchamberFetchResult[]> {
  const { dryRun = false, cwd = process.cwd() } = options;
  const results: GitchamberFetchResult[] = [];

  // Collect all packages to fetch
  const specsToFetch: Array<{ spec: string; source: string; version: string }> = [];

  // 1. Add installed extensions that are npm packages
  for (const installedPackage of installedPackages) {
    const version = getPackageVersion(installedPackage.installedPath);
    if (!version) continue;

    const spec = buildGitchamberSpec(installedPackage.source, version);
    if (spec) {
      specsToFetch.push({ spec, source: installedPackage.source, version });
    }
  }

  // 2. Add pi-agent related devDependencies
  for (const packageName of GITCHAMBER_PACKAGES) {
    const version = getLocalDevDependencyVersion(packageName, cwd);
    if (version) {
      specsToFetch.push({
        spec: `${packageName}@${version}`,
        source: `npm:${packageName}`,
        version,
      });
    }
  }

  if (specsToFetch.length === 0) {
    return results;
  }

  // Check which packages are already fetched at the correct version
  const sourcesJsonPath = join(cwd, 'node_modules', '.gitchamber', 'sources.json');
  type GitchamberSource = { name: string; version: string };
  type GitchamberSourcesJson = { packages?: GitchamberSource[] };
  let existingPackages: Map<string, string> = new Map();
  if (existsSync(sourcesJsonPath)) {
    try {
      const sourcesJson = JSON.parse(
        readFileSync(sourcesJsonPath, 'utf8'),
      ) as GitchamberSourcesJson;
      if (Array.isArray(sourcesJson.packages)) {
        for (const pkg of sourcesJson.packages) {
          existingPackages.set(pkg.name, pkg.version);
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  for (const { spec, source, version } of specsToFetch) {
    // Extract package name from spec (everything before @version)
    const packageName = spec.replace(/@[^@]+$/, ''); // Remove version suffix

    // Check if already fetched at this version
    if (existingPackages.get(packageName) === version) {
      results.push({ packageSpec: spec, version, status: 'already-exists' });
      continue;
    }

    if (dryRun) {
      results.push({ packageSpec: spec, version, status: 'would-fetch' });
      continue;
    }

    try {
      // Use execFileSync to capture output without displaying it
      const output = execFileSync('gitchamber', [spec], { encoding: 'utf8' });
      // Gitchamber returns exit code 0 even on failure, so we need to parse output
      // Success: "Done: 1 succeeded, 0 failed"
      // Failure: "Done: 0 succeeded, 1 failed" or contains "✗ Error:"
      const failedMatch = output.match(/Done: \d+ succeeded, (\d+) failed/);
      const failedCount = failedMatch ? parseInt(failedMatch[1], 10) : 0;
      const hasError = output.includes('✗ Error:') || failedCount > 0;

      if (hasError) {
        // Try fallback: detect GitHub repo from README or author
        const installedPackage = installedPackages.find((p) => p.source === source);
        if (installedPackage) {
          const detected = detectGitHubRepo(installedPackage.installedPath, packageName);
          if (detected) {
            const repoSpec = `${detected.ownerRepo}@${version}`;
            try {
              const fallbackOutput = execFileSync('gitchamber', [repoSpec], { encoding: 'utf8' });
              const fallbackFailedMatch = fallbackOutput.match(/Done: \d+ succeeded, (\d+) failed/);
              const fallbackFailedCount = fallbackFailedMatch
                ? parseInt(fallbackFailedMatch[1], 10)
                : 0;
              const fallbackHasError =
                fallbackOutput.includes('✗ Error:') || fallbackFailedCount > 0;

              if (!fallbackHasError) {
                results.push({ packageSpec: repoSpec, version, status: 'fetched' });
                continue;
              }
            } catch {
              // Fallback also failed, report original error
            }
          }
        }

        // Extract error message if possible
        const errorMatch = output.match(/✗ Error: ([^\n]+)/);
        const errorMsg = errorMatch ? errorMatch[1] : `Failed to fetch ${spec}`;
        results.push({
          packageSpec: spec,
          version,
          status: 'error',
          error: errorMsg,
        });
      } else {
        results.push({ packageSpec: spec, version, status: 'fetched' });
      }
    } catch (error) {
      results.push({
        packageSpec: spec,
        version,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
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
    execFile?: typeof execFileSync;
    log?: (message: string) => void;
    aubeConfigPath?: string;
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
      execFile(selfUpdateCommand.command, selfUpdateCommand.args, { stdio: 'inherit' });
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
        execFile(approveBuildsCommand.command, approveBuildsCommand.args, { stdio: 'inherit' });
        log(`Ran: ${display}`);
      }
    } else {
      log(`Skipping approve-builds: ${packageManager} installs do not use Aube approve-builds.`);
    }
  }

  const trustPolicyExcludeResult = ensureAubeTrustPolicyExcludes(
    AUBE_EXTENSION_TRUST_POLICY_EXCLUDES,
    { dryRun: options.dryRun, configPath: options.aubeConfigPath },
  );
  if (trustPolicyExcludeResult.status === 'already-present') {
    log(
      `Aube trustPolicyExclude: already includes ${AUBE_EXTENSION_TRUST_POLICY_EXCLUDES.join(', ')}.`,
    );
  } else {
    log(
      `${trustPolicyExcludeResult.status === 'would-update' ? 'Would update' : 'Updated'} Aube trustPolicyExclude in ${trustPolicyExcludeResult.configPath}: ${trustPolicyExcludeResult.entries.join(', ')}`,
    );
  }

  if (options.dryRun) {
    log('Would run: pi update --extensions');
    return;
  }

  execFile('pi', ['update', '--extensions'], { stdio: 'inherit' });
  log('Ran: pi update --extensions');
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

export async function syncDevDependenciesWithGlobalPi(
  options: { dryRun?: boolean; cwd?: string } = {},
): Promise<DepSyncResult> {
  const cwd = options.cwd ?? REPO_ROOT;
  const packageJsonPath = join(cwd, 'package.json');

  const { piCodingAgentVersion, desired } = computeDesiredPiSiblingVersions();
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    devDependencies?: Record<string, string>;
  };
  const current: Record<string, string> = { ...pkg.devDependencies };

  const changes = planDepSyncChanges(current, desired);

  if (changes.length === 0) {
    return { status: 'in-sync', changes, piCodingAgentVersion };
  }

  if (options.dryRun) {
    return { status: 'would-update', changes, piCodingAgentVersion };
  }

  writeDepSyncToPackageJson(packageJsonPath, changes);
  const packageManager = resolvePackageManagerCommand({ cwd });
  execFileSync(packageManager.command, [...packageManager.args, 'install'], {
    stdio: 'inherit',
    cwd,
  });
  return { status: 'updated', changes, piCodingAgentVersion };
}

export function parseCliArgs(argv: string[]): UpdateCliArgs {
  let dryRun = false;
  let directory: string | undefined;
  let approve = false;
  let skipUpdate = false;
  let skipDepsSync = false;
  let skipPatch = false;
  let skipGitchamber = false;

  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') {
      dryRun = true;
      continue;
    }
    if (arg === '--approve') {
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

    if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    if (directory !== undefined) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }

    directory = arg;
  }

  return {
    directory,
    dryRun,
    approve,
    skipUpdate,
    skipDepsSync,
    skipPatch,
    skipGitchamber,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { dryRun, approve, skipUpdate, skipDepsSync, skipPatch, skipGitchamber } =
    parseCliArgs(argv);

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
      const resolverResult = await applyPiCodingAgentResolverPatch({
        dryRun,
        cwd: REPO_ROOT,
      });
      const label =
        resolverResult.status === 'already-applied'
          ? `Already applied: pi-coding-agent resolver patch (${resolverResult.version})`
          : resolverResult.status === 'would-apply'
            ? `Would apply: pi-coding-agent resolver patch (${resolverResult.version})`
            : `${resolverResult.status}: pi-coding-agent resolver patch (${resolverResult.version}) via ${resolverResult.patchPath}`;
      console.log(label);
    } catch (error) {
      console.error(
        `Skipped pi-coding-agent resolver patch: ${error instanceof Error ? error.message : String(error)}`,
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
      const bedrockResult = await applyPiAiBedrockApiKeyBearerPatch({
        dryRun,
        cwd: REPO_ROOT,
      });
      const label =
        bedrockResult.status === 'already-applied'
          ? `Already applied: pi-ai Bedrock apiKey bearer patch (${bedrockResult.version})`
          : bedrockResult.status === 'would-apply'
            ? `Would apply: pi-ai Bedrock apiKey bearer patch (${bedrockResult.version})`
            : `${bedrockResult.status}: pi-ai Bedrock apiKey bearer patch (${bedrockResult.version}) via ${bedrockResult.patchPath}`;
      console.log(label);
    } catch (error) {
      console.error(
        `Skipped pi-ai Bedrock apiKey bearer patch: ${error instanceof Error ? error.message : String(error)}`,
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

    try {
      const codexGoalResult = await applyPiCodexGoalPostCompactionUserFollowupPatch({
        dryRun,
        cwd: REPO_ROOT,
        packageRoot: findInstalledNpmPackagePath(installedPackages, 'pi-codex-goal'),
      });
      const label =
        codexGoalResult.status === 'already-applied'
          ? `Already applied: pi-codex-goal post-compaction continuation patch (${codexGoalResult.version})`
          : codexGoalResult.status === 'would-apply'
            ? `Would apply: pi-codex-goal post-compaction continuation patch (${codexGoalResult.version})`
            : `${codexGoalResult.status}: pi-codex-goal post-compaction continuation patch (${codexGoalResult.version}) via ${codexGoalResult.patchPath}`;
      console.log(label);
    } catch (error) {
      console.error(
        `Skipped pi-codex-goal post-compaction continuation patch: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const subagentsResult = await applyPiSubagentsIntercomDetachPatch({
        dryRun,
        cwd: REPO_ROOT,
        packageRoot: findInstalledNpmPackagePath(installedPackages, 'pi-subagents'),
      });
      const label =
        subagentsResult.status === 'already-applied'
          ? `Already applied: pi-subagents intercom detach patch (${subagentsResult.version})`
          : subagentsResult.status === 'would-apply'
            ? `Would apply: pi-subagents intercom detach patch (${subagentsResult.version})`
            : `${subagentsResult.status}: pi-subagents intercom detach patch (${subagentsResult.version}) via ${subagentsResult.patchPath}`;
      console.log(label);
    } catch (error) {
      console.error(
        `Skipped pi-subagents intercom detach patch: ${error instanceof Error ? error.message : String(error)}`,
      );
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
  }

  // Update gitchamber sources for extensions and pi-agent packages
  if (!skipGitchamber) {
    const gitchamberResults = await updateGitchamberSources(installedPackages, {
      dryRun,
      cwd: REPO_ROOT,
    });
    if (gitchamberResults.length > 0) {
      console.log(
        `${dryRun ? 'Would fetch' : 'Fetched'} ${gitchamberResults.length} gitchamber source(s):`,
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
