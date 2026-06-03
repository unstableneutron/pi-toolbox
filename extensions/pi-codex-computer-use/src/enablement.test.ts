import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  getCodexComputerUseEnablementStatus,
  runCodexComputerUseEnablementCommand,
  writeCodexComputerUseEnablement,
} from './enablement';

describe('Codex Computer Use enablement', () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let root: string;
  let ctx: any;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-enable-'));
    process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
    ctx = {
      cwd: path.join(root, 'project'),
      sessionManager: {
        getSessionFile: () => path.join(root, 'sessions/session.jsonl'),
      },
    };
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { force: true, recursive: true });
  });

  test('defaults to disabled when no scope has a setting', () => {
    expect(getCodexComputerUseEnablementStatus(ctx)).toMatchObject({
      enabled: false,
      source: 'default',
    });
  });

  test('prefers session over project over user settings', () => {
    writeCodexComputerUseEnablement(ctx, 'user', true);
    writeCodexComputerUseEnablement(ctx, 'project', false);

    expect(getCodexComputerUseEnablementStatus(ctx)).toMatchObject({
      enabled: false,
      source: 'project',
    });

    writeCodexComputerUseEnablement(ctx, 'session', true);

    expect(getCodexComputerUseEnablementStatus(ctx)).toMatchObject({
      enabled: true,
      source: 'session',
    });
  });

  test('persists all three levels from the settings-style editor', async () => {
    writeCodexComputerUseEnablement(ctx, 'user', false);
    let reloaded = false;
    const commandCtx = {
      ...ctx,
      hasUI: true,
      reload: async () => {
        reloaded = true;
      },
      ui: {
        custom: async () => ({ session: 'unset', project: 'true', user: 'unset' }),
        notify() {},
      },
    };

    await runCodexComputerUseEnablementCommand('enable', commandCtx as any);

    expect(reloaded).toBe(true);
    expect(getCodexComputerUseEnablementStatus(ctx)).toMatchObject({
      enabled: true,
      source: 'project',
    });
    expect(JSON.parse(fs.readFileSync(path.join(ctx.cwd, '.pi/settings.json'), 'utf8'))).toEqual({
      codexComputerUse: { enabled: true },
    });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'agent/settings.json'), 'utf8'))).toEqual({});
  });

  test('writes project settings without removing existing settings', () => {
    const settingsPath = path.join(ctx.cwd, '.pi/settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }));

    expect(writeCodexComputerUseEnablement(ctx, 'project', true)).toBe(settingsPath);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'dark',
      codexComputerUse: { enabled: true },
    });
  });
});
