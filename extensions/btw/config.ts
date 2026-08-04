import { getAgentDir } from '@earendil-works/pi-coding-agent';
import fs from 'node:fs';
import path from 'node:path';

export const BTW_SURFACE_MODES = ['popup', 'overlay', 'pane', 'inline'] as const;
export type BtwSurfaceMode = (typeof BTW_SURFACE_MODES)[number];

export const BTW_FALLBACK_MODES = ['inline', 'pane'] as const;
export type BtwFallbackMode = (typeof BTW_FALLBACK_MODES)[number];

export type BtwConfig = {
  defaultMode: BtwSurfaceMode;
  fallbackMode: BtwFallbackMode;
};

export const DEFAULT_BTW_CONFIG: BtwConfig = {
  defaultMode: 'popup',
  fallbackMode: 'inline',
};

export type BtwInvocation =
  | { kind: 'config'; args: string }
  | { kind: 'question'; question: string };

function isSurfaceMode(value: unknown): value is BtwSurfaceMode {
  return typeof value === 'string' && BTW_SURFACE_MODES.includes(value as BtwSurfaceMode);
}

function isFallbackMode(value: unknown): value is BtwFallbackMode {
  return typeof value === 'string' && BTW_FALLBACK_MODES.includes(value as BtwFallbackMode);
}

function btwConfigPath(): string {
  return path.join(getAgentDir(), 'btw.json');
}

export function normalizeBtwConfig(value: unknown): BtwConfig {
  if (!value || typeof value !== 'object') return { ...DEFAULT_BTW_CONFIG };
  const record = value as Record<string, unknown>;
  return {
    defaultMode: isSurfaceMode(record.defaultMode)
      ? record.defaultMode
      : DEFAULT_BTW_CONFIG.defaultMode,
    fallbackMode: isFallbackMode(record.fallbackMode)
      ? record.fallbackMode
      : DEFAULT_BTW_CONFIG.fallbackMode,
  };
}

export function readBtwConfig(filePath = btwConfigPath()): BtwConfig {
  try {
    return normalizeBtwConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return { ...DEFAULT_BTW_CONFIG };
  }
}

export function writeBtwConfig(config: BtwConfig, filePath = btwConfigPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

export function formatBtwConfig(config: BtwConfig): string {
  return `BTW config — mode ${config.defaultMode}, fallback ${config.fallbackMode}`;
}

export function applyBtwConfigCommand(
  current: BtwConfig,
  rawArgs: string,
): { config: BtwConfig; changed: boolean } {
  const args = rawArgs.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (args.length === 0) return { config: current, changed: false };

  if (args.length === 1 && args[0] === 'reset') {
    return { config: { ...DEFAULT_BTW_CONFIG }, changed: true };
  }

  if (args.length === 2 && args[0] === 'mode' && isSurfaceMode(args[1])) {
    return { config: { ...current, defaultMode: args[1] }, changed: true };
  }

  if (args.length === 2 && args[0] === 'fallback' && isFallbackMode(args[1])) {
    return { config: { ...current, fallbackMode: args[1] }, changed: true };
  }

  throw new Error(
    'Usage: /btw config [mode popup|overlay|pane|inline | fallback inline|pane | reset]',
  );
}

export function parseBtwInvocation(rawArgs: string): BtwInvocation {
  const trimmed = rawArgs.trim();
  if (trimmed === 'config') return { kind: 'config', args: '' };
  if (trimmed.startsWith('config ')) {
    return { kind: 'config', args: trimmed.slice('config '.length).trim() };
  }
  if (trimmed === 'ask') return { kind: 'question', question: '' };
  if (trimmed.startsWith('ask ')) {
    return { kind: 'question', question: trimmed.slice('ask '.length).trim() };
  }
  return { kind: 'question', question: trimmed };
}
