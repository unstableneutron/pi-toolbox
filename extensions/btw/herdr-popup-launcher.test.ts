import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const launcher = fileURLToPath(new URL('./herdr-plugin/herdr-popup-launcher.mjs', import.meta.url));
const temporaryPaths: string[] = [];

afterEach(() => {
  for (const temporaryPath of temporaryPaths.splice(0)) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
  }
});

function createExecutable(directory: string, contents: string): void {
  const executable = path.join(directory, 'pi');
  fs.writeFileSync(executable, contents, { mode: 0o700 });
}

function createLaunchFile(prefix = 'pi-toolbox-btw-'): {
  directory: string;
  launchFile: string;
  sessionFile: string;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(directory, 0o700);
  temporaryPaths.push(directory);
  const sessionFile = path.join(os.tmpdir(), `btw-launcher-session-${process.pid}-${Date.now()}`);
  fs.writeFileSync(sessionFile, '{}\n', { mode: 0o600 });
  temporaryPaths.push(sessionFile);
  const launchFile = path.join(directory, 'launch.json');
  fs.writeFileSync(
    launchFile,
    JSON.stringify({ version: 1, cwd: os.tmpdir(), sessionFile, prompt: 'question' }),
    { mode: 0o600 },
  );
  return { directory, launchFile, sessionFile };
}

function runLauncher(launchFile: string, fakeBin: string) {
  return spawnSync(process.execPath, [launcher], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      PI_TOOLBOX_BTW_LAUNCH_FILE: launchFile,
    },
    timeout: 5_000,
  });
}

describe('Herdr popup launcher', () => {
  test('starts Pi and removes a valid private launch directory', () => {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'btw-fake-bin-'));
    temporaryPaths.push(fakeBin);
    createExecutable(fakeBin, '#!/bin/sh\nexit 0\n');
    const launch = createLaunchFile();

    const result = runLauncher(launch.launchFile, fakeBin);

    expect(result.status).toBe(0);
    expect(fs.existsSync(launch.directory)).toBe(false);
  });

  test('does not delete an untrusted launch directory', () => {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'btw-fake-bin-'));
    temporaryPaths.push(fakeBin);
    createExecutable(fakeBin, '#!/bin/sh\nexit 0\n');
    const launch = createLaunchFile('btw-untrusted-');

    const result = runLauncher(launch.launchFile, fakeBin);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('outside the private BTW temporary directory');
    expect(fs.existsSync(launch.directory)).toBe(true);
  });

  test('exits when the child terminates from a signal', () => {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'btw-fake-bin-'));
    temporaryPaths.push(fakeBin);
    createExecutable(fakeBin, '#!/bin/sh\nkill -TERM $$\n');
    const launch = createLaunchFile();

    const result = runLauncher(launch.launchFile, fakeBin);

    expect(result.status).toBe(143);
    expect(result.error).toBeUndefined();
  });
});
