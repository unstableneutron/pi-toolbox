import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  BTW_HERDR_LAUNCH_ENV,
  buildHerdrPluginOpenArgs,
  isHerdrSession,
  launchBtwHerdrSurface,
} from './herdr-surface';

const temporaryPaths: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const temporaryPath of temporaryPaths.splice(0)) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
  }
});

function createPluginRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'btw-plugin-test-'));
  temporaryPaths.push(root);
  fs.writeFileSync(path.join(root, 'herdr-plugin.toml'), 'id = "pi-toolbox.btw"\n');
  return root;
}

describe('Herdr BTW surfaces', () => {
  test('requires both the Herdr marker and socket', () => {
    expect(isHerdrSession({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/herdr.sock' })).toBe(true);
    expect(isHerdrSession({ HERDR_ENV: '1' })).toBe(false);
    expect(isHerdrSession({ HERDR_SOCKET_PATH: '/tmp/herdr.sock' })).toBe(false);
  });

  test('builds popup and overlay placement overrides', () => {
    const popup = buildHerdrPluginOpenArgs('popup', '/tmp/launch.json');
    expect(popup).toContain('popup');
    expect(popup).toContain(`${BTW_HERDR_LAUNCH_ENV}=/tmp/launch.json`);

    const overlay = buildHerdrPluginOpenArgs('overlay', '/tmp/launch.json');
    expect(overlay).toContain('overlay');
    expect(overlay).toContain(`${BTW_HERDR_LAUNCH_ENV}=/tmp/launch.json`);
  });

  test('links the bundled plugin and opens a popup with a private launch file', async () => {
    vi.useFakeTimers();
    const pluginRoot = createPluginRoot();
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = vi.fn(async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args[0] === 'plugin' && args[1] === 'list') {
        return { code: 0, stdout: JSON.stringify({ result: { plugins: [] } }) };
      }
      return { code: 0, stdout: JSON.stringify({ result: { type: 'ok' } }) };
    });

    const result = await launchBtwHerdrSurface({
      exec,
      placement: 'popup',
      pluginRoot,
      payload: {
        version: 1,
        cwd: '/repo',
        sessionFile: '/tmp/session.jsonl',
        prompt: 'question',
      },
    });

    expect(result).toEqual({ ok: true });
    expect(calls[1]).toEqual({ command: 'herdr', args: ['plugin', 'link', pluginRoot] });
    const openCall = calls[2]!;
    const envValue = openCall.args.find((arg) => arg.startsWith(`${BTW_HERDR_LAUNCH_ENV}=`));
    const launchFile = envValue?.slice(`${BTW_HERDR_LAUNCH_ENV}=`.length);
    expect(launchFile).toBeTruthy();
    expect(fs.statSync(launchFile!).mode & 0o077).toBe(0);
    expect(JSON.parse(fs.readFileSync(launchFile!, 'utf8'))).toMatchObject({
      cwd: '/repo',
      prompt: 'question',
      sessionFile: '/tmp/session.jsonl',
      version: 1,
    });
    fs.rmSync(path.dirname(launchFile!), { recursive: true, force: true });
  });

  test('cleans the launch file when Herdr rejects the surface', async () => {
    const pluginRoot = createPluginRoot();
    let launchFile: string | undefined;
    const exec = vi.fn(async (_command: string, args: string[]) => {
      if (args[1] === 'list') {
        return { code: 0, stdout: JSON.stringify({ result: { plugins: [] } }) };
      }
      if (args[1] === 'link') return { code: 0 };
      const envValue = args.find((arg) => arg.startsWith(`${BTW_HERDR_LAUNCH_ENV}=`));
      launchFile = envValue?.slice(`${BTW_HERDR_LAUNCH_ENV}=`.length);
      return { code: 1, stderr: 'ui_busy' };
    });

    const result = await launchBtwHerdrSurface({
      exec,
      placement: 'popup',
      pluginRoot,
      payload: { version: 1, cwd: '/repo', sessionFile: '/tmp/session.jsonl' },
    });

    expect(result).toEqual({ ok: false, error: 'ui_busy' });
    expect(launchFile).toBeTruthy();
    expect(fs.existsSync(path.dirname(launchFile!))).toBe(false);
  });

  test('does not relink a disabled plugin', async () => {
    const pluginRoot = createPluginRoot();
    const exec = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({
        result: {
          plugins: [{ plugin_id: 'pi-toolbox.btw', enabled: false }],
        },
      }),
    }));

    const result = await launchBtwHerdrSurface({
      exec,
      placement: 'overlay',
      pluginRoot,
      payload: { version: 1, cwd: '/repo', sessionFile: '/tmp/session.jsonl' },
    });

    expect(result).toEqual({
      ok: false,
      error: 'Herdr plugin pi-toolbox.btw is disabled',
    });
    expect(exec).toHaveBeenCalledOnce();
  });
});
