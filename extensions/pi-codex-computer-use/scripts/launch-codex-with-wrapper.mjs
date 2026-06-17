#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REAL_CODEX_PATH = '/Applications/Codex.app/Contents/Resources/codex';
const DEFAULT_CONNECT_TIMEOUT_MS = '20000';
const CODEX_APP_PROCESS = '/Applications/Codex.app/Contents/MacOS/Codex';
const BRAVE_USER_DATA_RELATIVE = [
  'Library',
  'Application Support',
  'BraveSoftware',
  'Brave-Browser',
];
const BRAVE_NODE_REPL_ENV_ALLOWLIST = [
  'BROWSER_USE_AVAILABLE_BACKENDS',
  'CODEX_CHROME_BROWSER',
  'CODEX_CHROME_USER_DATA_DIR',
  'CODEX_CHROME_NATIVE_HOST_MANIFEST_PATH',
].join(',');

function usage() {
  return `Usage: scripts/launch-codex-with-wrapper.mjs [options]

Launch Codex.app with the local Desktop app-server wrapper and a shared Unix socket.

Options:
  --browser chrome|brave       Browser flavor for Codex's @Chrome plugin checks.
                               Defaults to chrome. brave sets local-debug Brave env.
  --socket PATH                Shared app-server Unix socket path.
  --log PATH                   JSONL bridge log path.
  --wrapper PATH               Desktop wrapper script path.
  --real-codex PATH            Real Codex CLI path. Defaults to bundled Codex.app CLI.
  --connect-timeout-ms MS      Wrapper connect timeout. Defaults to 20000.
  --allow-running              Allow launch even if Codex.app is already running.
  --require-stopped            Refuse to launch if Codex.app is already running (default).
  --dry-run                    Print the launch plan without running open.
  -h, --help                   Show this help.
`;
}

function timestamp(date) {
  return date.toISOString().replace(/[-:.]/g, '');
}

function expandHome(filePath, home) {
  if (filePath === '~') return home;
  if (filePath.startsWith('~/')) return path.join(home, filePath.slice(2));
  return filePath;
}

function readOption(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    allowRunning: false,
    browser: 'chrome',
    dryRun: false,
    requireStopped: true,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--allow-running') {
      options.allowRunning = true;
      options.requireStopped = false;
      continue;
    }
    if (arg === '--require-stopped') {
      options.allowRunning = false;
      options.requireStopped = true;
      continue;
    }
    if (arg === '--browser') {
      options.browser = readOption(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--socket') {
      options.socket = readOption(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--log') {
      options.log = readOption(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--wrapper') {
      options.wrapper = readOption(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--real-codex') {
      options.realCodex = readOption(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--connect-timeout-ms') {
      options.connectTimeoutMs = readOption(argv, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unsupported argument: ${arg}`);
  }

  options.browser = String(options.browser).toLowerCase();
  if (!['chrome', 'brave'].includes(options.browser)) {
    throw new Error(`Unsupported browser: ${options.browser}`);
  }

  return options;
}

function projectRootFromScript(scriptPath) {
  return path.resolve(path.dirname(scriptPath), '..', '..', '..');
}

function buildEnvVars(options, context, defaults) {
  const env = {
    CODEX_CLI_PATH: defaults.wrapperPath,
    PI_CODEX_DESKTOP_REAL_CODEX: defaults.realCodexPath,
    PI_CODEX_DESKTOP_APP_SERVER_SOCKET: defaults.socketPath,
    PI_CODEX_DESKTOP_APP_SERVER_LOG: defaults.logPath,
    PI_CODEX_DESKTOP_CONNECT_TIMEOUT_MS: defaults.connectTimeoutMs,
  };

  if (options.browser === 'brave') {
    const braveUserDataDir = path.join(context.home, ...BRAVE_USER_DATA_RELATIVE);
    env.BROWSER_USE_AVAILABLE_BACKENDS = 'chrome';
    env.CODEX_CHROME_BROWSER = 'brave';
    env.CODEX_CHROME_USER_DATA_DIR = braveUserDataDir;
    env.CODEX_CHROME_NATIVE_HOST_MANIFEST_PATH = path.join(
      braveUserDataDir,
      'NativeMessagingHosts',
      'com.openai.codexextension.json',
    );
    env.NODE_REPL_UNTRUSTED_ENV_ALLOWLIST = BRAVE_NODE_REPL_ENV_ALLOWLIST;
  }

  return env;
}

export function buildLaunchPlan(argv = process.argv.slice(2), rawContext = {}) {
  const scriptPath = rawContext.scriptPath ?? fileURLToPath(import.meta.url);
  const env = rawContext.env ?? process.env;
  const home = env.HOME || os.homedir();
  const now = rawContext.now ?? new Date();
  const cwd = rawContext.cwd ?? process.cwd();
  const context = { cwd, env, home, now, scriptPath };
  const options = parseArgs(argv);
  const projectRoot = projectRootFromScript(scriptPath);
  const logDirectory = path.join(
    projectRoot,
    'scratch',
    'codex-browser-appserver',
    `launch-${timestamp(now)}`,
  );
  const socketPath = path.resolve(
    expandHome(options.socket ?? '~/.codex/pi-codex-desktop/app-server-live.sock', home),
  );
  const logPath = path.resolve(
    expandHome(options.log ?? path.join(logDirectory, 'app-server.jsonl'), home),
  );
  const wrapperPath = path.resolve(
    expandHome(
      options.wrapper ??
        path.join(path.dirname(scriptPath), 'codex-desktop-app-server-wrapper.mjs'),
      home,
    ),
  );
  const realCodexPath = path.resolve(
    expandHome(options.realCodex ?? DEFAULT_REAL_CODEX_PATH, home),
  );
  const connectTimeoutMs = String(options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
  const defaults = { connectTimeoutMs, logPath, realCodexPath, socketPath, wrapperPath };
  const launchEnv = buildEnvVars(options, context, defaults);
  const args = ['-n', '-g'];
  for (const [name, value] of Object.entries(launchEnv)) {
    args.push('--env', `${name}=${value}`);
  }
  args.push('-a', 'Codex');

  return {
    args,
    browser: options.browser,
    command: '/usr/bin/open',
    dryRun: options.dryRun,
    env: launchEnv,
    logPath,
    requireStopped: options.requireStopped,
    socketPath,
  };
}

function codexAppRunning() {
  const result = spawnSync('pgrep', ['-f', `^${CODEX_APP_PROCESS}$`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

async function run(argv = process.argv.slice(2)) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(usage());
    return;
  }

  const plan = buildLaunchPlan(argv);
  if (plan.requireStopped && codexAppRunning()) {
    throw new Error(
      'Codex.app is already running. Stop it first, or pass --allow-running if you intentionally want LaunchServices to reuse/launch another instance.',
    );
  }
  if (!existsSync(plan.env.CODEX_CLI_PATH)) {
    throw new Error(`Wrapper script does not exist: ${plan.env.CODEX_CLI_PATH}`);
  }

  await mkdir(path.dirname(plan.socketPath), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(plan.logPath), { recursive: true, mode: 0o700 });

  if (plan.dryRun) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  const result = spawnSync(plan.command, plan.args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const details = [result.stderr?.trim(), result.stdout?.trim()].filter(Boolean).join('\n');
    throw new Error(`Failed to launch Codex.app${details ? `:\n${details}` : ''}`);
  }

  process.stdout.write(
    [
      'Launched Codex.app with wrapper env.',
      `socket=${plan.socketPath}`,
      `log=${plan.logPath}`,
      `browser=${plan.browser}`,
      '',
    ].join('\n'),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
