import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  DEFAULT_CODEX_APP_SERVER_USE_CONFIG,
  getCodexAppServerUseConfigStatus,
  runCodexAppServerUseSettingsCommand,
  writeCodexAppServerUseConfig,
} from './config';

describe('Codex AppServer Use config', () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let root: string;
  let ctx: any;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-use-config-'));
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

  test('defaults all AppServer capabilities to off', () => {
    expect(getCodexAppServerUseConfigStatus(ctx)).toMatchObject({
      config: DEFAULT_CODEX_APP_SERVER_USE_CONFIG,
      source: 'default',
    });
  });

  test('merges user, project, and session settings by precedence', () => {
    writeCodexAppServerUseConfig(ctx, 'user', {
      computerUse: { enabled: true },
      exec: { enabled: true, models: 'auto' },
    });
    writeCodexAppServerUseConfig(ctx, 'project', {
      computerUse: { enabled: false },
      exec: { replaceLocalTools: true },
    });

    expect(getCodexAppServerUseConfigStatus(ctx)).toMatchObject({
      config: {
        computerUse: { enabled: false },
        exec: { enabled: true, replaceLocalTools: true, models: 'auto' },
        ui: { statusLine: true },
      },
      source: 'project',
    });

    writeCodexAppServerUseConfig(ctx, 'session', {
      exec: { models: 'all' },
    });

    expect(getCodexAppServerUseConfigStatus(ctx)).toMatchObject({
      config: {
        computerUse: { enabled: false },
        exec: { enabled: true, replaceLocalTools: true, models: 'all' },
        ui: { statusLine: true },
      },
      source: 'session',
    });
  });

  test('persists all three levels from the settings UI', async () => {
    writeCodexAppServerUseConfig(ctx, 'user', { computerUse: { enabled: true } });
    let reloaded = false;
    const commandCtx = {
      ...ctx,
      hasUI: true,
      reload: async () => {
        reloaded = true;
      },
      ui: {
        custom: async () => ({
          session: {},
          project: { computerUse: { enabled: false }, exec: { enabled: true } },
          user: {},
        }),
        notify() {},
      },
    };

    await runCodexAppServerUseSettingsCommand('', commandCtx as any);

    expect(reloaded).toBe(true);
    expect(getCodexAppServerUseConfigStatus(ctx)).toMatchObject({
      config: {
        computerUse: { enabled: false },
        exec: { enabled: true, replaceLocalTools: false, models: 'auto' },
        ui: { statusLine: true },
      },
      source: 'project',
    });
    expect(JSON.parse(fs.readFileSync(path.join(ctx.cwd, '.pi/settings.json'), 'utf8'))).toEqual({
      codexAppServerUse: {
        computerUse: { enabled: false },
        exec: { enabled: true },
      },
    });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'agent/settings.json'), 'utf8'))).toEqual({});
  });

  test('writes project settings without removing existing settings', () => {
    const settingsPath = path.join(ctx.cwd, '.pi/settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }));

    expect(writeCodexAppServerUseConfig(ctx, 'project', { computerUse: { enabled: true } })).toBe(
      settingsPath,
    );
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))).toEqual({
      theme: 'dark',
      codexAppServerUse: { computerUse: { enabled: true } },
    });
  });

  test('direct command toggles exec enablement, replacement, and model activation separately', async () => {
    const notifications: string[] = [];
    let reloadCount = 0;
    const commandCtx = {
      ...ctx,
      hasUI: false,
      reload: async () => {
        reloadCount += 1;
      },
      ui: { notify: (message: string) => notifications.push(message) },
    };

    await runCodexAppServerUseSettingsCommand('exec on project', commandCtx as any);
    await runCodexAppServerUseSettingsCommand('exec replace on project', commandCtx as any);
    await runCodexAppServerUseSettingsCommand('exec models all project', commandCtx as any);

    expect(reloadCount).toBe(3);
    expect(getCodexAppServerUseConfigStatus(ctx)).toMatchObject({
      config: {
        exec: { enabled: true, replaceLocalTools: true, models: 'all' },
      },
      source: 'project',
    });
    expect(JSON.parse(fs.readFileSync(path.join(ctx.cwd, '.pi/settings.json'), 'utf8'))).toEqual({
      codexAppServerUse: {
        exec: { enabled: true, replaceLocalTools: true, models: 'all' },
      },
    });
    expect(notifications).toHaveLength(3);
  });
});
