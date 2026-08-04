import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const launchFile = process.env.PI_TOOLBOX_BTW_LAUNCH_FILE;

function fail(message) {
  process.stderr.write(`pi-toolbox BTW: ${message}\n`);
  process.exit(1);
}

if (!launchFile || !path.isAbsolute(launchFile)) {
  fail('missing a valid launch file');
}

let payload;
let launchDirectory;
try {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  launchDirectory = fs.realpathSync(path.dirname(launchFile));
  const directoryStat = fs.statSync(launchDirectory);
  const fileLstat = fs.lstatSync(launchFile);
  const fileStat = fs.statSync(launchFile);
  if (
    path.dirname(launchDirectory) !== temporaryRoot ||
    !path.basename(launchDirectory).startsWith('pi-toolbox-btw-') ||
    path.basename(launchFile) !== 'launch.json' ||
    fileLstat.isSymbolicLink()
  ) {
    fail('launch file is outside the private BTW temporary directory');
  }
  if ((directoryStat.mode & 0o077) !== 0 || (fileStat.mode & 0o077) !== 0) {
    fail('launch file permissions are not private');
  }
  if (
    typeof process.getuid === 'function' &&
    (directoryStat.uid !== process.getuid() || fileStat.uid !== process.getuid())
  ) {
    fail('launch file is owned by another user');
  }
  if (fileStat.size > 1024 * 1024) fail('launch file is too large');
  payload = JSON.parse(fs.readFileSync(launchFile, 'utf8'));
} catch (error) {
  fail(`cannot read launch file: ${error instanceof Error ? error.message : String(error)}`);
}

if (
  payload?.version !== 1 ||
  typeof payload.cwd !== 'string' ||
  !path.isAbsolute(payload.cwd) ||
  typeof payload.sessionFile !== 'string' ||
  !path.isAbsolute(payload.sessionFile) ||
  (payload.prompt !== undefined && typeof payload.prompt !== 'string')
) {
  fail('launch payload is invalid');
}

try {
  const cwdStat = fs.statSync(payload.cwd);
  const sessionStat = fs.statSync(payload.sessionFile);
  if (!cwdStat.isDirectory() || !sessionStat.isFile()) fail('launch paths have invalid types');
  if (typeof process.getuid === 'function' && sessionStat.uid !== process.getuid()) {
    fail('session file is owned by another user');
  }
} catch (error) {
  fail(`cannot validate launch paths: ${error instanceof Error ? error.message : String(error)}`);
}

try {
  fs.rmSync(launchDirectory, { recursive: true, force: true });
} catch {
  // The parent also schedules best-effort stale cleanup.
}

const args = ['--session', payload.sessionFile];
if (payload.prompt?.trim()) args.push(payload.prompt);

const child = spawn('pi', args, {
  cwd: payload.cwd,
  env: { ...process.env, PI_TOOLBOX_BTW_CHILD: '1' },
  stdio: 'inherit',
});

const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
let forwardedSignal;
for (const signal of Object.keys(signalExitCodes)) {
  process.on(signal, () => {
    if (forwardedSignal) return;
    forwardedSignal = signal;
    child.kill(signal);
  });
}

child.once('error', (error) => fail(`cannot start Pi: ${error.message}`));
child.once('exit', (code, signal) => {
  process.exit(signal ? (signalExitCodes[signal] ?? 1) : (code ?? 1));
});
