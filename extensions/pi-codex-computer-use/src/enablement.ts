import fs from 'node:fs';
import path from 'node:path';

import {
  getAgentDir,
  type ExtensionCommandContext,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import {
  CodexComputerUseEnablementSettingsView,
  type CodexComputerUseEnablementEditResult,
  type CodexComputerUseTriState,
} from './enablement-ui';

const SETTINGS_KEY = 'codexComputerUse';
const SESSION_STATE_SUFFIX = '.codex-computer-use.json';

export type CodexComputerUseEnablementScope = 'project' | 'session' | 'user';

interface CodexComputerUseSettings {
  enabled?: unknown;
}

interface SettingsWithCodexComputerUse {
  codexComputerUse?: CodexComputerUseSettings;
}

interface SessionEnablementState {
  enabled?: unknown;
}

export interface CodexComputerUseEnablementLevels {
  project: boolean | undefined;
  session: boolean | undefined;
  user: boolean | undefined;
}

export interface CodexComputerUseEnablementStatus {
  enabled: boolean;
  source: 'default' | CodexComputerUseEnablementScope;
  paths: {
    project: string;
    session: string;
    user: string;
  };
}

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

function getProjectSettingsPath(ctx: Pick<ExtensionContext, 'cwd'>): string {
  return path.join(ctx.cwd, '.pi/settings.json');
}

function getSessionSettingsPath(ctx: Pick<ExtensionContext, 'sessionManager'>): string {
  return `${ctx.sessionManager.getSessionFile()}${SESSION_STATE_SUFFIX}`;
}

function getUserSettingsPath(): string {
  return path.join(getAgentDir(), 'settings.json');
}

function readBooleanSetting(filePath: string): boolean | undefined {
  const settings = readJsonObject(filePath) as SettingsWithCodexComputerUse;
  return typeof settings.codexComputerUse?.enabled === 'boolean'
    ? settings.codexComputerUse.enabled
    : undefined;
}

function readSessionBoolean(filePath: string): boolean | undefined {
  const state = readJsonObject(filePath) as SessionEnablementState;
  return typeof state.enabled === 'boolean' ? state.enabled : undefined;
}

function getEnablementPaths(ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>) {
  return {
    project: getProjectSettingsPath(ctx),
    session: getSessionSettingsPath(ctx),
    user: getUserSettingsPath(),
  };
}

function readEnablementLevels(
  paths: ReturnType<typeof getEnablementPaths>,
): CodexComputerUseEnablementLevels {
  return {
    project: readBooleanSetting(paths.project),
    session: readSessionBoolean(paths.session),
    user: readBooleanSetting(paths.user),
  };
}

export function getCodexComputerUseEnablementStatus(
  ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
): CodexComputerUseEnablementStatus {
  const paths = getEnablementPaths(ctx);
  const levels = readEnablementLevels(paths);

  if (levels.session !== undefined) return { enabled: levels.session, source: 'session', paths };
  if (levels.project !== undefined) return { enabled: levels.project, source: 'project', paths };
  if (levels.user !== undefined) return { enabled: levels.user, source: 'user', paths };

  return { enabled: false, source: 'default', paths };
}

export function isCodexComputerUseEnabled(
  ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
): boolean {
  return getCodexComputerUseEnablementStatus(ctx).enabled;
}

export function writeCodexComputerUseEnablement(
  ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
  scope: CodexComputerUseEnablementScope,
  enabled: boolean,
): string {
  if (scope === 'session') {
    const filePath = getSessionSettingsPath(ctx);
    writeJsonObject(filePath, { enabled });
    return filePath;
  }

  const filePath = scope === 'project' ? getProjectSettingsPath(ctx) : getUserSettingsPath();
  const settings = readJsonObject(filePath);
  const existing =
    typeof settings[SETTINGS_KEY] === 'object' && settings[SETTINGS_KEY] !== null
      ? (settings[SETTINGS_KEY] as Record<string, unknown>)
      : {};
  settings[SETTINGS_KEY] = { ...existing, enabled };
  writeJsonObject(filePath, settings);
  return filePath;
}

function scopeLabel(scope: CodexComputerUseEnablementScope): string {
  if (scope === 'project') return 'this project';
  if (scope === 'user') return 'all sessions for this user';
  return 'this session';
}

function parseAction(args: string): 'disable' | 'enable' | 'status' | undefined {
  const action = args.trim().split(/\s+/, 1)[0]?.toLowerCase();
  if (action === 'enable' || action === 'on') return 'enable';
  if (action === 'disable' || action === 'off') return 'disable';
  if (action === 'status') return 'status';
  return undefined;
}

function parseScope(args: string): CodexComputerUseEnablementScope | undefined {
  const scope = args.trim().split(/\s+/)[1]?.toLowerCase();
  if (scope === 'project' || scope === 'local') return 'project';
  if (scope === 'user' || scope === 'global') return 'user';
  if (scope === 'session') return 'session';
  return undefined;
}

async function chooseAction(
  ctx: ExtensionCommandContext,
): Promise<'disable' | 'enable' | 'status' | undefined> {
  const choice = await ctx.ui.select('Codex Computer Use', ['Enable', 'Disable', 'Status']);
  if (choice === 'Enable') return 'enable';
  if (choice === 'Disable') return 'disable';
  if (choice === 'Status') return 'status';
  return undefined;
}

function triStateToBoolean(value: CodexComputerUseTriState): boolean | undefined {
  if (value === 'unset') return undefined;
  return value === 'true';
}

function writeOptionalCodexComputerUseEnablement(
  ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
  scope: CodexComputerUseEnablementScope,
  value: boolean | undefined,
): string {
  if (scope === 'session') {
    const filePath = getSessionSettingsPath(ctx);
    if (value === undefined) {
      try {
        fs.rmSync(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return filePath;
    }
    writeJsonObject(filePath, { enabled: value });
    return filePath;
  }

  const filePath = scope === 'project' ? getProjectSettingsPath(ctx) : getUserSettingsPath();
  const settings = readJsonObject(filePath);
  const existing =
    typeof settings[SETTINGS_KEY] === 'object' && settings[SETTINGS_KEY] !== null
      ? (settings[SETTINGS_KEY] as Record<string, unknown>)
      : {};

  if (value === undefined) {
    delete existing.enabled;
  } else {
    existing.enabled = value;
  }

  if (Object.keys(existing).length === 0) {
    delete settings[SETTINGS_KEY];
  } else {
    settings[SETTINGS_KEY] = existing;
  }
  writeJsonObject(filePath, settings);
  return filePath;
}

function writeEnablementEditResult(
  ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
  result: CodexComputerUseEnablementEditResult,
): string[] {
  return [
    writeOptionalCodexComputerUseEnablement(ctx, 'session', triStateToBoolean(result.session)),
    writeOptionalCodexComputerUseEnablement(ctx, 'project', triStateToBoolean(result.project)),
    writeOptionalCodexComputerUseEnablement(ctx, 'user', triStateToBoolean(result.user)),
  ];
}

async function editEnablementLevels(
  ctx: ExtensionCommandContext,
): Promise<CodexComputerUseEnablementEditResult | undefined> {
  const levels = readEnablementLevels(getEnablementPaths(ctx));
  if (!ctx.hasUI || !ctx.ui.custom) return undefined;
  return await ctx.ui.custom<CodexComputerUseEnablementEditResult | undefined>(
    (_tui, theme, _keybindings, done) =>
      new CodexComputerUseEnablementSettingsView(levels, theme, done),
  );
}

export async function runCodexComputerUseEnablementCommand(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const action = parseAction(args) ?? (await chooseAction(ctx));
  if (!action) return;

  if (action === 'status') {
    const status = getCodexComputerUseEnablementStatus(ctx);
    const source = status.source === 'default' ? 'default (disabled)' : status.source;
    ctx.ui.notify(
      `Codex Computer Use is ${status.enabled ? 'enabled' : 'disabled'} via ${source}.`,
      'info',
    );
    return;
  }

  const enabled = action === 'enable';
  const explicitScope = parseScope(args);
  if (explicitScope) {
    const filePath = writeCodexComputerUseEnablement(ctx, explicitScope, enabled);
    ctx.ui.notify(
      `Codex Computer Use ${enabled ? 'enabled' : 'disabled'} for ${scopeLabel(explicitScope)}. Wrote ${filePath}. Reloading…`,
      'info',
    );
    await ctx.reload();
    return;
  }

  const result = await editEnablementLevels(ctx);
  if (!result) return;

  const filePaths = writeEnablementEditResult(ctx, result);
  ctx.ui.notify(
    `Saved Codex Computer Use enablement settings. Wrote ${filePaths.join(', ')}. Reloading…`,
    'info',
  );
  await ctx.reload();
}

export function formatCodexComputerUseEnablementStatus(
  status: Pick<CodexComputerUseEnablementStatus, 'enabled' | 'source'>,
): string {
  const source = status.source === 'default' ? 'default' : status.source;
  return `${status.enabled ? 'enabled' : 'disabled'} (${source})`;
}
