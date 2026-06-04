#!/usr/bin/env bun

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
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

export type PackageManagerCommand = {
  command: string;
  args: string[];
  source: 'settings' | 'aube' | 'pnpm';
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
  const cwd = options.cwd ?? process.cwd();
  const packageManagers = options.packageManagerCommand
    ? [options.packageManagerCommand]
    : getPackageManagerCommandCandidates(options);

  for (const packageManager of packageManagers) {
    try {
      const globalRoot = execFileSync(
        packageManager.command,
        [...packageManager.args, 'root', '-g'],
        {
          cwd,
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

    const listedPackagePath = findPackagePathFromGlobalList(packageName, packageManager, cwd);
    if (listedPackagePath) return listedPackagePath;
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
  const packageRoot = findGlobalPackagePath(PI_CODING_AGENT_PACKAGE_NAME);
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
