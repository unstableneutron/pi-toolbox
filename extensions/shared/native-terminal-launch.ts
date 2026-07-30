/**
 * Shared helpers for launching shell commands in a native terminal split/pane.
 *
 * Supports Ghostty, Kitty, and Herdr. Higher-level session workflows
 * (pi-native-split, btw pane mode) build the command and pass it here.
 */

// Match Herdr's MOBILE_WIDTH_THRESHOLD from src/ui/mobile.rs.
const NATIVE_MOBILE_WIDTH_THRESHOLD = 64;

export type SupportedTerminal = 'ghostty' | 'kitty' | 'herdr';

export type NativeTerminalDetails = {
  terminal: SupportedTerminal;
  parent?: { pane?: string; workspace?: string; window?: string };
  child?: {
    pane?: string;
    window?: string;
    target?: 'pane' | 'tab';
    pid?: string;
    listenOn?: string;
    socket?: string;
  };
};

export type NativeLaunchResult = {
  code: number;
  stdout?: string;
  stderr?: string;
};

export type NativeExecFn = (
  command: string,
  args: string[],
) => Promise<NativeLaunchResult> | NativeLaunchResult;

export type PrepareNativeCommand = (native: NativeTerminalDetails) => {
  /** Shell command to run inside the new pane/window (not already wrapped in sh -c). */
  command: string;
  cleanupOnFailure?: () => void;
};

const GHOSTTY_SPLIT_SCRIPT = `on run argv
	set targetCwd to item 1 of argv
	set startupInput to item 2 of argv
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to targetCwd
		set initial input of cfg to startupInput
		if (count of windows) > 0 then
			try
				set frontWindow to front window
				set targetTerminal to focused terminal of selected tab of frontWindow
				split targetTerminal direction right with configuration cfg
			on error
				new window with configuration cfg
			end try
		else
			new window with configuration cfg
		end if
		activate
	end tell
end run`;

type HerdrPaneInfo = {
  pane_id?: unknown;
  focused?: unknown;
  workspace_id?: unknown;
};

type FocusedHerdrPane = {
  paneId: string;
  workspaceId?: string;
};

export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatThrownLaunchError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

export function detectTerminal(
  env: NodeJS.ProcessEnv = process.env,
): SupportedTerminal | undefined {
  if (
    env.HERDR_ENV === '1' ||
    (typeof env.HERDR_PANE_ID === 'string' && env.HERDR_PANE_ID.length > 0)
  ) {
    return 'herdr';
  }

  const termProgram = (env.TERM_PROGRAM ?? '').toLowerCase();
  const term = (env.TERM ?? '').toLowerCase();

  if (termProgram === 'ghostty' || term.includes('ghostty') || env.GHOSTTY_RESOURCES_DIR) {
    return 'ghostty';
  }

  if (env.KITTY_WINDOW_ID || termProgram === 'kitty') {
    return 'kitty';
  }

  return undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function getTerminalColumns(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const envColumns = parsePositiveInteger(env.COLUMNS);
  if (envColumns !== undefined) return envColumns;

  const stdoutColumns = process.stdout.columns;
  return Number.isInteger(stdoutColumns) && stdoutColumns > 0 ? stdoutColumns : undefined;
}

export function shouldCreateNativeTab(
  env: NodeJS.ProcessEnv = process.env,
  threshold = NATIVE_MOBILE_WIDTH_THRESHOLD,
): boolean {
  const columns = getTerminalColumns(env);
  return columns !== undefined && columns <= threshold;
}

function hasObjectKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}

export function buildNativeTerminalDetails(
  terminal: SupportedTerminal,
  env: NodeJS.ProcessEnv = process.env,
): NativeTerminalDetails {
  if (terminal === 'kitty') {
    const parent: NativeTerminalDetails['parent'] = {};
    if (env.KITTY_WINDOW_ID) parent.window = env.KITTY_WINDOW_ID;
    return { terminal, parent: hasObjectKeys(parent) ? parent : undefined };
  }

  if (terminal === 'herdr') {
    const parent: NativeTerminalDetails['parent'] = {};
    if (env.HERDR_PANE_ID) parent.pane = env.HERDR_PANE_ID;
    if (env.HERDR_WORKSPACE_ID) parent.workspace = env.HERDR_WORKSPACE_ID;
    return { terminal, parent: hasObjectKeys(parent) ? parent : undefined };
  }

  return { terminal };
}

function parseJsonResponse(stdout: string | undefined, context: string): unknown {
  try {
    return JSON.parse(stdout || '');
  } catch (error) {
    throw new Error(`${context} returned invalid JSON: ${formatThrownLaunchError(error)}`);
  }
}

function getHerdrErrorMessage(response: unknown): string | undefined {
  if (!response || typeof response !== 'object' || !('error' in response)) return undefined;
  const error = (response as { error?: { message?: unknown } }).error;
  return typeof error?.message === 'string' ? error.message : JSON.stringify(error);
}

export function parseFocusedHerdrPane(stdout: string | undefined): FocusedHerdrPane {
  const response = parseJsonResponse(stdout, 'herdr pane list');
  const errorMessage = getHerdrErrorMessage(response);
  if (errorMessage) throw new Error(`herdr pane list failed: ${errorMessage}`);

  const panes = (response as { result?: { panes?: HerdrPaneInfo[] } }).result?.panes;
  if (!Array.isArray(panes)) {
    throw new Error('herdr pane list did not return result.panes');
  }

  const focusedPane = panes.find((pane) => pane && pane.focused === true);
  if (typeof focusedPane?.pane_id !== 'string' || focusedPane.pane_id.length === 0) {
    throw new Error('herdr pane list did not include a focused pane');
  }

  const workspaceId =
    typeof focusedPane.workspace_id === 'string' && focusedPane.workspace_id.length > 0
      ? focusedPane.workspace_id
      : undefined;

  return { paneId: focusedPane.pane_id, workspaceId };
}

export function parseCreatedHerdrPaneId(stdout: string | undefined): string {
  const response = parseJsonResponse(stdout, 'herdr pane split');
  const errorMessage = getHerdrErrorMessage(response);
  if (errorMessage) throw new Error(`herdr pane split failed: ${errorMessage}`);

  const paneId = (response as { result?: { pane?: { pane_id?: unknown } } }).result?.pane?.pane_id;
  if (typeof paneId !== 'string' || paneId.length === 0) {
    throw new Error('herdr pane split did not return result.pane.pane_id');
  }

  return paneId;
}

export function parseCreatedHerdrTabRootPaneId(stdout: string | undefined): string {
  const response = parseJsonResponse(stdout, 'herdr tab create');
  const errorMessage = getHerdrErrorMessage(response);
  if (errorMessage) throw new Error(`herdr tab create failed: ${errorMessage}`);

  const paneId = (response as { result?: { root_pane?: { pane_id?: unknown } } }).result?.root_pane
    ?.pane_id;
  if (typeof paneId !== 'string' || paneId.length === 0) {
    throw new Error('herdr tab create did not return result.root_pane.pane_id');
  }

  return paneId;
}

export function getKittyChildWindowId(stdout: string | undefined): string | undefined {
  const trimmed = stdout?.trim();
  return trimmed && /^\d+$/.test(trimmed) ? trimmed : undefined;
}

async function launchGhostty(
  exec: NativeExecFn,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prepare: PrepareNativeCommand,
): Promise<{ result: NativeLaunchResult; native: NativeTerminalDetails }> {
  const native = buildNativeTerminalDetails('ghostty', env);
  const prepared = prepare(native);
  const startupInput = prepared.command.endsWith('\n') ? prepared.command : `${prepared.command}\n`;

  try {
    const result = await exec('osascript', ['-e', GHOSTTY_SPLIT_SCRIPT, '--', cwd, startupInput]);
    if (result.code !== 0) {
      prepared.cleanupOnFailure?.();
    }
    return { result, native };
  } catch (error) {
    prepared.cleanupOnFailure?.();
    throw error;
  }
}

async function launchKitty(
  exec: NativeExecFn,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prepare: PrepareNativeCommand,
): Promise<{ result: NativeLaunchResult; native: NativeTerminalDetails }> {
  const shouldLaunchTab = shouldCreateNativeTab(env);
  const native: NativeTerminalDetails = {
    ...buildNativeTerminalDetails('kitty', env),
    child: { target: shouldLaunchTab ? 'tab' : 'pane' },
  };
  const prepared = prepare(native);
  const shellPath = env.SHELL || process.env.SHELL || '/bin/sh';

  try {
    const result = await exec('kitten', [
      '@',
      'launch',
      '--type',
      shouldLaunchTab ? 'tab' : 'window',
      '--location',
      shouldLaunchTab ? 'after' : 'vsplit',
      '--cwd',
      cwd,
      shellPath,
      '-ilc',
      prepared.command,
    ]);
    if (result.code !== 0) {
      prepared.cleanupOnFailure?.();
    } else {
      const window = getKittyChildWindowId(result.stdout);
      if (window) {
        native.child = { ...native.child, window };
      }
    }
    return { result, native };
  } catch (error) {
    prepared.cleanupOnFailure?.();
    throw error;
  }
}

async function launchHerdr(
  exec: NativeExecFn,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prepare: PrepareNativeCommand,
): Promise<{ result: NativeLaunchResult; native: NativeTerminalDetails }> {
  let prepared: ReturnType<PrepareNativeCommand> | undefined;

  try {
    const listResult = await exec('herdr', ['pane', 'list']);
    if (listResult.code !== 0) {
      return {
        result: listResult,
        native: buildNativeTerminalDetails('herdr', env),
      };
    }

    const focusedPane = parseFocusedHerdrPane(listResult.stdout);
    let newPaneId: string;
    let target: 'pane' | 'tab';

    if (shouldCreateNativeTab(env)) {
      const createArgs = ['tab', 'create'];
      if (focusedPane.workspaceId) {
        createArgs.push('--workspace', focusedPane.workspaceId);
      }
      createArgs.push('--cwd', cwd, '--no-focus');

      const tabResult = await exec('herdr', createArgs);
      if (tabResult.code !== 0) {
        return {
          result: tabResult,
          native: {
            terminal: 'herdr',
            parent: {
              pane: focusedPane.paneId,
              workspace: focusedPane.workspaceId,
            },
          },
        };
      }

      newPaneId = parseCreatedHerdrTabRootPaneId(tabResult.stdout);
      target = 'tab';
    } else {
      const splitResult = await exec('herdr', [
        'pane',
        'split',
        focusedPane.paneId,
        '--direction',
        'right',
        '--cwd',
        cwd,
        '--no-focus',
      ]);
      if (splitResult.code !== 0) {
        return {
          result: splitResult,
          native: {
            terminal: 'herdr',
            parent: {
              pane: focusedPane.paneId,
              workspace: focusedPane.workspaceId,
            },
          },
        };
      }

      newPaneId = parseCreatedHerdrPaneId(splitResult.stdout);
      target = 'pane';
    }

    const native: NativeTerminalDetails = {
      terminal: 'herdr',
      parent: {
        pane: focusedPane.paneId,
        workspace: focusedPane.workspaceId,
      },
      child: { pane: newPaneId, target },
    };
    prepared = prepare(native);

    const runResult = await exec('herdr', ['pane', 'run', newPaneId, prepared.command]);
    if (runResult.code !== 0) {
      prepared.cleanupOnFailure?.();
    }
    return { result: runResult, native };
  } catch (error) {
    prepared?.cleanupOnFailure?.();
    throw error;
  }
}

/**
 * Launch a shell command in a sibling native terminal split/window/pane.
 */
export async function launchShellInNativeSplit(options: {
  terminal: SupportedTerminal;
  exec: NativeExecFn;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  prepare: PrepareNativeCommand;
}): Promise<{ result: NativeLaunchResult; native: NativeTerminalDetails }> {
  const env = options.env ?? process.env;

  try {
    if (options.terminal === 'ghostty') {
      return await launchGhostty(options.exec, options.cwd, env, options.prepare);
    }
    if (options.terminal === 'herdr') {
      return await launchHerdr(options.exec, options.cwd, env, options.prepare);
    }
    return await launchKitty(options.exec, options.cwd, env, options.prepare);
  } catch (error) {
    return {
      result: {
        code: 1,
        stderr: `pre-launch command failed: ${formatThrownLaunchError(error)}`,
      },
      native: buildNativeTerminalDetails(options.terminal, env),
    };
  }
}
