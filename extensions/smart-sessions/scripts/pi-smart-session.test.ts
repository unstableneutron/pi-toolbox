import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const scriptPath = join(process.cwd(), 'extensions/smart-sessions/scripts/pi-smart-session');

let tempDir = '';

function runScript(args: string[], env: Record<string, string> = {}) {
  return spawnSync('/bin/sh', [scriptPath, ...args], {
    cwd: tempDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
    },
  });
}

function writeFakePi(binDir: string, body: string): string {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, 'pi');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

describe('pi-smart-session helper script', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pi-smart-session-script-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('runs pi and silently removes a clean exit hint', () => {
    const binDir = join(tempDir, 'bin');
    const agentDir = join(tempDir, 'agent');
    const argsFile = join(tempDir, 'args');
    const runIdFile = join(tempDir, 'run-id');
    writeFakePi(
      binDir,
      `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}
printf '%s\\n' "$PI_RESUME_RUN_ID" > ${JSON.stringify(runIdFile)}
mkdir -p "$PI_CODING_AGENT_DIR/smart-sessions/resume-hints"
printf 'session-from-run\\t123\\t%s\\tClean Title\\n' "$PWD" > "$PI_CODING_AGENT_DIR/smart-sessions/resume-hints/$PI_RESUME_RUN_ID"`,
    );

    const result = runScript(['hello'], {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      PI_CODING_AGENT_DIR: agentDir,
    });

    expect(result.status).toBe(0);
    expect(readFileSync(argsFile, 'utf8')).toBe('hello\n');
    expect(result.stderr).not.toContain('Resume with:');
    expect(
      existsSync(
        join(agentDir, 'smart-sessions', 'resume-hints', readFileSync(runIdFile, 'utf8').trim()),
      ),
    ).toBe(false);
  });

  test('--last with an explicit id resumes that session', () => {
    const binDir = join(tempDir, 'bin');
    const argsFile = join(tempDir, 'args');
    writeFakePi(binDir, `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`);

    const result = runScript(['--last', 'session-123', '--model', 'sonnet'], {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
    });

    expect(result.status).toBe(0);
    expect(readFileSync(argsFile, 'utf8')).toBe('--session\nsession-123\n--model\nsonnet\n');
  });

  test('rewrites a leading UUID argument to --session', () => {
    const binDir = join(tempDir, 'bin');
    const argsFile = join(tempDir, 'args');
    writeFakePi(binDir, `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`);

    const result = runScript(['019ea9fb-e943-788c-bbcf-06bbf6330f6a', '--model', 'sonnet'], {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
    });

    expect(result.status).toBe(0);
    expect(readFileSync(argsFile, 'utf8')).toBe(
      '--session\n019ea9fb-e943-788c-bbcf-06bbf6330f6a\n--model\nsonnet\n',
    );
  });

  test('--last recovers the only available hint and deletes it', () => {
    const binDir = join(tempDir, 'bin');
    const agentDir = join(tempDir, 'agent');
    const argsFile = join(tempDir, 'args');
    const hintDir = join(agentDir, 'smart-sessions', 'resume-hints');
    writeFakePi(binDir, `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`);
    mkdirSync(hintDir, { recursive: true });
    const hintFile = join(hintDir, 'stale-run');
    writeFileSync(hintFile, `recovered-session\t456\t${tempDir}\tRecovered Title\n`);

    const result = runScript(['--last', '--thinking', 'low'], {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      PI_CODING_AGENT_DIR: agentDir,
    });

    expect(result.status).toBe(0);
    expect(readFileSync(argsFile, 'utf8')).toBe('--session\nrecovered-session\n--thinking\nlow\n');
    expect(existsSync(hintFile)).toBe(false);
  });

  test('installed pi wrapper skips itself when resolving the real pi binary', () => {
    const wrapperBin = join(tempDir, 'wrapper-bin');
    const realBin = join(tempDir, 'real-bin');
    const argsFile = join(tempDir, 'args');
    mkdirSync(wrapperBin, { recursive: true });
    const wrapperPath = join(wrapperBin, 'pi');
    copyFileSync(scriptPath, wrapperPath);
    chmodSync(wrapperPath, 0o755);
    writeFakePi(realBin, `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`);

    const result = spawnSync(wrapperPath, ['from-wrapper'], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${wrapperBin}:${realBin}:${process.env.PATH ?? ''}`,
        PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(argsFile, 'utf8')).toBe('from-wrapper\n');
  });
});
