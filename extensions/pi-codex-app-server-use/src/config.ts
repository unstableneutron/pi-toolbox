import fs from 'node:fs';
import path from 'node:path';

import {
  getAgentDir,
  type ExtensionCommandContext,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import {
  CodexAppServerUseSettingsView,
  type CodexAppServerUseSettingsEditResult,
} from './settings-ui';

const SETTINGS_KEY = 'codexAppServerUse';
const SESSION_STATE_SUFFIX = '.codex-app-server-use.json';

export type CodexAppServerUseScope = 'project' | 'session' | 'user';
export type CodexAppServerExecModels = 'all' | 'auto';

export interface CodexAppServerUseConfig {
  computerUse: { enabled: boolean };
  exec: {
    enabled: boolean;
    replaceLocalTools: boolean;
    models: CodexAppServerExecModels;
  };
  ui: { statusLine: boolean };
}

export interface CodexAppServerUseConfigPatch {
  computerUse?: Partial<CodexAppServerUseConfig['computerUse']> | undefined;
  exec?: Partial<CodexAppServerUseConfig['exec']> | undefined;
  ui?: Partial<CodexAppServerUseConfig['ui']> | undefined;
}

interface SettingsWithCodexAppServerUse {
  codexAppServerUse?: CodexAppServerUseConfigPatch;
}

export interface CodexAppServerUseConfigStatus {
  config: CodexAppServerUseConfig;
  source: 'default' | CodexAppServerUseScope;
  paths: {
    project: string;
    session: string;
    user: string;
  };
}

export const DEFAULT_CODEX_APP_SERVER_USE_CONFIG: CodexAppServerUseConfig = {
  computerUse: { enabled: false },
  exec: {
    enabled: false,
    replaceLocalTools: false,
    models: 'auto',
  },
  ui: { statusLine: true },
};

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJsonObject(filePath: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getProjectSettingsPath(ctx: Pick<ExtensionContext, 'cwd'>): string {
  return path.join(ctx.cwd, '.pi/settings.json');
}

function getSessionSettingsPath(ctx: Pick<ExtensionContext, 'sessionManager'>): string {
  return `${ctx.sessionManager.getSessionFile()}${SESSION_STATE_SUFFIX}`;
}

function getUserSettingsPath(): string {
  return path.join(getAgentDir(), 'settings.json');
}

function getConfigPaths(ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>) {
  return {
    project: getProjectSettingsPath(ctx),
    session: getSessionSettingsPath(ctx),
    user: getUserSettingsPath(),
  };
}

function normalizeExecModels(value: unknown): CodexAppServerExecModels | undefined {
  return value === 'auto' || value === 'all' ? value : undefined;
}

function normalizeConfigPatch(value: unknown): CodexAppServerUseConfigPatch {
  if (!isObject(value)) return {};
  const computerUse = isObject(value.computerUse) ? value.computerUse : {};
  const exec = isObject(value.exec) ? value.exec : {};
  const ui = isObject(value.ui) ? value.ui : {};
  return {
    ...(typeof computerUse.enabled === 'boolean'
      ? { computerUse: { enabled: computerUse.enabled } }
      : {}),
    ...(typeof exec.enabled === 'boolean' ||
    typeof exec.replaceLocalTools === 'boolean' ||
    normalizeExecModels(exec.models)
      ? {
          exec: {
            ...(typeof exec.enabled === 'boolean' ? { enabled: exec.enabled } : {}),
            ...(typeof exec.replaceLocalTools === 'boolean'
              ? { replaceLocalTools: exec.replaceLocalTools }
              : {}),
            ...(normalizeExecModels(exec.models)
              ? { models: normalizeExecModels(exec.models) }
              : {}),
          },
        }
      : {}),
    ...(typeof ui.statusLine === 'boolean' ? { ui: { statusLine: ui.statusLine } } : {}),
  };
}

function readConfigPatchFromSettings(filePath: string): CodexAppServerUseConfigPatch {
  const settings = readJsonObject(filePath) as SettingsWithCodexAppServerUse;
  return normalizeConfigPatch(settings.codexAppServerUse);
}

function readConfigPatchFromSession(filePath: string): CodexAppServerUseConfigPatch {
  return normalizeConfigPatch(readJsonObject(filePath));
}

function mergeConfigPatch(
  base: CodexAppServerUseConfig,
  patch: CodexAppServerUseConfigPatch,
): CodexAppServerUseConfig {
  return {
    computerUse: { ...base.computerUse, ...patch.computerUse },
    exec: { ...base.exec, ...patch.exec },
    ui: { ...base.ui, ...patch.ui },
  };
}

function hasConfigPatch(patch: CodexAppServerUseConfigPatch): boolean {
  return Boolean(patch.computerUse || patch.exec || patch.ui);
}

function readConfigLevels(paths: ReturnType<typeof getConfigPaths>): {
  project: CodexAppServerUseConfigPatch;
  session: CodexAppServerUseConfigPatch;
  user: CodexAppServerUseConfigPatch;
} {
  return {
    project: readConfigPatchFromSettings(paths.project),
    session: readConfigPatchFromSession(paths.session),
    user: readConfigPatchFromSettings(paths.user),
  };
}

export function getCodexAppServerUseConfigStatus(
  ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
): CodexAppServerUseConfigStatus {
  const paths = getConfigPaths(ctx);
  const levels = readConfigLevels(paths);
  const config = [levels.user, levels.project, levels.session].reduce(
    mergeConfigPatch,
    structuredClone(DEFAULT_CODEX_APP_SERVER_USE_CONFIG),
  );
  const source = hasConfigPatch(levels.session)
    ? 'session'
    : hasConfigPatch(levels.project)
      ? 'project'
      : hasConfigPatch(levels.user)
        ? 'user'
        : 'default';
  return { config, source, paths };
}

export function getCodexAppServerUseConfig(
  ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
): CodexAppServerUseConfig {
  return getCodexAppServerUseConfigStatus(ctx).config;
}

function removeFileIfExists(filePath: string): void {
  try {
    fs.rmSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function deepMergePatch(
  left: CodexAppServerUseConfigPatch,
  right: CodexAppServerUseConfigPatch,
): CodexAppServerUseConfigPatch {
  return {
    ...(left.computerUse || right.computerUse
      ? { computerUse: { ...left.computerUse, ...right.computerUse } }
      : {}),
    ...(left.exec || right.exec ? { exec: { ...left.exec, ...right.exec } } : {}),
    ...(left.ui || right.ui ? { ui: { ...left.ui, ...right.ui } } : {}),
  };
}

function removeEmptyObjects(value: CodexAppServerUseConfigPatch): CodexAppServerUseConfigPatch {
  return {
    ...(value.computerUse && Object.keys(value.computerUse).length > 0
      ? { computerUse: value.computerUse }
      : {}),
    ...(value.exec && Object.keys(value.exec).length > 0 ? { exec: value.exec } : {}),
    ...(value.ui && Object.keys(value.ui).length > 0 ? { ui: value.ui } : {}),
  };
}

export function writeCodexAppServerUseConfig(
  ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
  scope: CodexAppServerUseScope,
  patch: CodexAppServerUseConfigPatch,
): string {
  const normalizedPatch = removeEmptyObjects(normalizeConfigPatch(patch));

  if (scope === 'session') {
    const filePath = getSessionSettingsPath(ctx);
    if (!hasConfigPatch(normalizedPatch)) {
      removeFileIfExists(filePath);
      return filePath;
    }
    const existing = readConfigPatchFromSession(filePath);
    writeJsonObject(filePath, deepMergePatch(existing, normalizedPatch) as Record<string, unknown>);
    return filePath;
  }

  const filePath = scope === 'project' ? getProjectSettingsPath(ctx) : getUserSettingsPath();
  const settings = readJsonObject(filePath);
  if (!hasConfigPatch(normalizedPatch)) {
    delete settings[SETTINGS_KEY];
    writeJsonObject(filePath, settings);
    return filePath;
  }
  const existing = normalizeConfigPatch(settings[SETTINGS_KEY]);
  const merged = removeEmptyObjects(deepMergePatch(existing, normalizedPatch));
  if (!hasConfigPatch(merged)) {
    delete settings[SETTINGS_KEY];
  } else {
    settings[SETTINGS_KEY] = merged;
  }
  writeJsonObject(filePath, settings);
  return filePath;
}

function formatConfigStatus(status: CodexAppServerUseConfigStatus): string {
  const source = status.source === 'default' ? 'default' : status.source;
  return [
    `Codex AppServer Use (${source})`,
    `Computer Use: ${status.config.computerUse.enabled ? 'enabled' : 'off'}`,
    `Exec tools: ${status.config.exec.enabled ? 'enabled' : 'off'}`,
    `Replace local tools: ${status.config.exec.replaceLocalTools ? 'on' : 'off'}`,
    `Models: ${status.config.exec.models}`,
  ].join('\n');
}

function parseScope(args: string): CodexAppServerUseScope | undefined {
  const scope = args
    .trim()
    .split(/\s+/)
    .find((part) => ['session', 'project', 'local', 'user', 'global'].includes(part.toLowerCase()));
  if (!scope) return undefined;
  const normalized = scope.toLowerCase();
  if (normalized === 'project' || normalized === 'local') return 'project';
  if (normalized === 'user' || normalized === 'global') return 'user';
  return 'session';
}

function parsePatch(args: string): CodexAppServerUseConfigPatch | undefined {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words[0] === 'computer-use' || words[0] === 'computer') {
    const enabled = words.includes('on') || words.includes('enable') || words.includes('enabled');
    const disabled =
      words.includes('off') || words.includes('disable') || words.includes('disabled');
    if (enabled || disabled) return { computerUse: { enabled } };
  }
  if (words[0] === 'exec') {
    if (words[1] === 'replace' || words[1] === 'replacement') {
      const enabled = words.includes('on') || words.includes('enable') || words.includes('enabled');
      const disabled =
        words.includes('off') || words.includes('disable') || words.includes('disabled');
      if (enabled || disabled) return { exec: { replaceLocalTools: enabled } };
    }
    if (words[1] === 'models' || words[1] === 'model') {
      const models = words.find(
        (word): word is CodexAppServerExecModels => word === 'auto' || word === 'all',
      );
      if (models) return { exec: { models } };
    }
    const enabled = words.includes('on') || words.includes('enable') || words.includes('enabled');
    const disabled =
      words.includes('off') || words.includes('disable') || words.includes('disabled');
    if (enabled || disabled) return { exec: { enabled } };
  }
  return undefined;
}

async function editSettings(
  ctx: ExtensionCommandContext,
): Promise<CodexAppServerUseSettingsEditResult | undefined> {
  if (!ctx.hasUI || !ctx.ui.custom) return undefined;
  const paths = getConfigPaths(ctx);
  const levels = readConfigLevels(paths);
  return await ctx.ui.custom<CodexAppServerUseSettingsEditResult | undefined>(
    (_tui, theme, _keybindings, done) => new CodexAppServerUseSettingsView(levels, theme, done),
  );
}

export async function runCodexAppServerUseSettingsCommand(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const action = args.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (action === 'status') {
    ctx.ui.notify(formatConfigStatus(getCodexAppServerUseConfigStatus(ctx)), 'info');
    return;
  }

  const directPatch = parsePatch(args);
  if (directPatch) {
    const scope = parseScope(args) ?? 'user';
    const filePath = writeCodexAppServerUseConfig(ctx, scope, directPatch);
    ctx.ui.notify(`Saved Codex AppServer Use settings to ${filePath}. Reloading…`, 'info');
    await ctx.reload();
    return;
  }

  const result = await editSettings(ctx);
  if (!result) return;

  const filePaths = [
    writeCodexAppServerUseConfig(ctx, 'session', result.session),
    writeCodexAppServerUseConfig(ctx, 'project', result.project),
    writeCodexAppServerUseConfig(ctx, 'user', result.user),
  ];
  ctx.ui.notify(
    `Saved Codex AppServer Use settings. Wrote ${filePaths.join(', ')}. Reloading…`,
    'info',
  );
  await ctx.reload();
}

export function formatCodexAppServerComputerUseStatus(status: {
  enabled: boolean;
  source: CodexAppServerUseConfigStatus['source'];
}): string {
  const source = status.source === 'default' ? 'default' : status.source;
  return `${status.enabled ? 'enabled' : 'disabled'} (${source})`;
}
