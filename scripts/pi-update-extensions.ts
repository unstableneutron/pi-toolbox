#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
  '@mariozechner/pi-agent-core',
  '@mariozechner/pi-ai',
  '@mariozechner/pi-coding-agent',
  '@mariozechner/pi-tui',
] as const;

/** Subset of GITCHAMBER_PACKAGES that must always be pinned in the agent
 * workspace's devDependencies. (Same list today, kept as a separate name
 * for intent clarity.) */
const PI_SIBLING_PACKAGES = GITCHAMBER_PACKAGES;

/** Manual overrides for packages that don't have detectable repo metadata */
const GITCHAMBER_MANUAL_OVERRIDES: Record<string, string> = {
  'pi-boomerang': 'nicobailon/pi-boomerang',
};

export type UpdateCliArgs = {
  directory?: string;
  dryRun: boolean;
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
// @mariozechner/pi-coding-agent so `resolveCliModel` prefers authenticated
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

const PI_CODING_AGENT_PACKAGE_NAME = '@mariozechner/pi-coding-agent';
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

export function findGlobalPnpmPackagePath(
  packageName: string,
  options: { cwd?: string } = {},
): string | undefined {
  const cwd = options.cwd ?? process.cwd();
  try {
    const globalRoot = execFileSync('pnpm', ['root', '-g'], {
      cwd,
      encoding: 'utf8',
    }).trim();
    if (!globalRoot) return undefined;
    const packagePath = join(globalRoot, packageName);
    if (!existsSync(packagePath)) return undefined;
    return realpathSync(packagePath);
  } catch {
    return undefined;
  }
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
    findGlobalPnpmPackagePath(PI_CODING_AGENT_PACKAGE_NAME, { cwd: options.cwd });
  if (!packageRoot) {
    throw new Error(
      `Could not locate installed ${PI_CODING_AGENT_PACKAGE_NAME} via 'pnpm root -g'`,
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

  // Try global pnpm store
  try {
    const globalPath = execFileSync('pnpm', ['root', '-g'], { encoding: 'utf8', cwd }).trim();
    const globalPackageJsonPath = join(globalPath, packageName, 'package.json');
    if (existsSync(globalPackageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(globalPackageJsonPath, 'utf8')) as {
        version?: string;
      };
      return packageJson.version;
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

export async function runPiUpdate(options: { dryRun?: boolean } = {}): Promise<void> {
  if (options.dryRun) {
    return;
  }

  execFileSync('pi', ['update', '--extensions'], { stdio: 'inherit' });
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
//   4. Runs `pnpm install` so node_modules reflects the change.
// ---------------------------------------------------------------------------

function stripRangePrefix(spec: string): string {
  return spec.replace(/^[\^~>=<\s]+/, '');
}

function readGlobalPiCodingAgentPackageJson(): {
  version: string;
  path: string;
  json: { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
} {
  const packageRoot = findGlobalPnpmPackagePath(PI_CODING_AGENT_PACKAGE_NAME);
  if (!packageRoot) {
    throw new Error(
      `Could not locate globally installed ${PI_CODING_AGENT_PACKAGE_NAME} via 'pnpm root -g'.`,
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
  execFileSync('pnpm', ['install'], { stdio: 'inherit', cwd });
  return { status: 'updated', changes, piCodingAgentVersion };
}

export function parseCliArgs(argv: string[]): UpdateCliArgs {
  let dryRun = false;
  let directory: string | undefined;
  let skipUpdate = false;
  let skipDepsSync = false;
  let skipPatch = false;
  let skipGitchamber = false;

  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') {
      dryRun = true;
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
    skipUpdate,
    skipDepsSync,
    skipPatch,
    skipGitchamber,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { dryRun, skipUpdate, skipDepsSync, skipPatch, skipGitchamber } = parseCliArgs(argv);

  if (!skipUpdate) {
    await runPiUpdate({ dryRun });
    console.log(dryRun ? 'Would run: pi update' : 'Ran: pi update');
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
