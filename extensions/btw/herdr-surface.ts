import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NativeExecFn, NativeLaunchResult } from '../shared/native-terminal-launch';

const BTW_HERDR_PLUGIN_ID = 'pi-toolbox.btw';
const BTW_HERDR_PLUGIN_ENTRYPOINT = 'btw';
export const BTW_HERDR_LAUNCH_ENV = 'PI_TOOLBOX_BTW_LAUNCH_FILE';
let linkedPluginRoot: string | undefined;

export type BtwHerdrPlacement = 'popup' | 'overlay';

export type BtwHerdrLaunchPayload = {
  version: 1;
  cwd: string;
  sessionFile: string;
  prompt?: string;
};

type InstalledPlugin = {
  plugin_id?: unknown;
  manifest_path?: unknown;
  enabled?: unknown;
};

type PluginListResponse = {
  result?: {
    plugins?: unknown;
  };
};

export function isHerdrSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_ENV === '1' && !!env.HERDR_SOCKET_PATH;
}

function getBtwHerdrPluginRoot(): string {
  return fileURLToPath(new URL('./herdr-plugin/', import.meta.url));
}

export function buildHerdrPluginOpenArgs(
  placement: BtwHerdrPlacement,
  launchFile: string,
): string[] {
  const args = [
    'plugin',
    'pane',
    'open',
    '--plugin',
    BTW_HERDR_PLUGIN_ID,
    '--entrypoint',
    BTW_HERDR_PLUGIN_ENTRYPOINT,
    '--placement',
    placement,
  ];
  args.push('--env', `${BTW_HERDR_LAUNCH_ENV}=${launchFile}`, '--focus');
  return args;
}

function parseInstalledPlugin(stdout: string | undefined): InstalledPlugin | undefined {
  if (!stdout?.trim()) return undefined;
  try {
    const parsed = JSON.parse(stdout) as PluginListResponse;
    const plugins = parsed.result?.plugins;
    if (!Array.isArray(plugins)) return undefined;
    return plugins.find(
      (plugin): plugin is InstalledPlugin =>
        !!plugin &&
        typeof plugin === 'object' &&
        (plugin as InstalledPlugin).plugin_id === BTW_HERDR_PLUGIN_ID,
    );
  } catch {
    return undefined;
  }
}

function sameManifest(plugin: InstalledPlugin, pluginRoot: string): boolean {
  if (typeof plugin.manifest_path !== 'string') return false;
  try {
    return (
      fs.realpathSync(plugin.manifest_path) ===
      fs.realpathSync(path.join(pluginRoot, 'herdr-plugin.toml'))
    );
  } catch {
    return false;
  }
}

async function ensureBtwHerdrPlugin(
  exec: NativeExecFn,
  pluginRoot = getBtwHerdrPluginRoot(),
): Promise<NativeLaunchResult> {
  if (linkedPluginRoot === pluginRoot) return { code: 0 };

  const listed = await exec('herdr', ['plugin', 'list', '--plugin', BTW_HERDR_PLUGIN_ID, '--json']);
  const installed = listed.code === 0 ? parseInstalledPlugin(listed.stdout) : undefined;
  if (installed?.enabled === false) {
    return {
      code: 1,
      stderr: `Herdr plugin ${BTW_HERDR_PLUGIN_ID} is disabled`,
    };
  }
  if (installed?.enabled === true && sameManifest(installed, pluginRoot)) {
    linkedPluginRoot = pluginRoot;
    return { code: 0 };
  }
  const linked = await exec('herdr', ['plugin', 'link', pluginRoot]);
  if (linked.code === 0) linkedPluginRoot = pluginRoot;
  return linked;
}

function createLaunchFile(payload: BtwHerdrLaunchPayload): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-toolbox-btw-'));
  fs.chmodSync(directory, 0o700);
  const launchFile = path.join(directory, 'launch.json');
  fs.writeFileSync(launchFile, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  return launchFile;
}

function cleanupHerdrLaunchFile(launchFile: string | undefined): void {
  if (!launchFile) return;
  try {
    fs.rmSync(path.dirname(launchFile), { recursive: true, force: true });
  } catch {
    // Best-effort cleanup for launch failures and abandoned helper starts.
  }
}

function launchError(result: NativeLaunchResult): string {
  return result.stderr?.trim() || result.stdout?.trim() || 'unknown Herdr launch error';
}

export async function launchBtwHerdrSurface(options: {
  exec: NativeExecFn;
  placement: BtwHerdrPlacement;
  payload: BtwHerdrLaunchPayload;
  pluginRoot?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const plugin = await ensureBtwHerdrPlugin(options.exec, options.pluginRoot);
  if (plugin.code !== 0) return { ok: false, error: launchError(plugin) };

  const launchFile = createLaunchFile(options.payload);
  try {
    const opened = await options.exec(
      'herdr',
      buildHerdrPluginOpenArgs(options.placement, launchFile),
    );
    if (opened.code !== 0) {
      cleanupHerdrLaunchFile(launchFile);
      return { ok: false, error: launchError(opened) };
    }
    const cleanupTimer = setTimeout(() => cleanupHerdrLaunchFile(launchFile), 60_000);
    cleanupTimer.unref?.();
    return { ok: true };
  } catch (error) {
    cleanupHerdrLaunchFile(launchFile);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
