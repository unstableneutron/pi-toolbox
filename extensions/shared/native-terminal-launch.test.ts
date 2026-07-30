import { describe, expect, test } from 'vitest';

import {
  buildNativeTerminalDetails,
  detectTerminal,
  getKittyChildWindowId,
  launchShellInNativeSplit,
  parseCreatedHerdrPaneId,
  parseCreatedHerdrTabRootPaneId,
  parseFocusedHerdrPane,
  shellQuote,
  shouldCreateNativeTab,
  type NativeExecFn,
  type NativeLaunchResult,
} from './native-terminal-launch';

describe('detectTerminal', () => {
  test('returns herdr when HERDR_ENV is set', () => {
    expect(detectTerminal({ HERDR_ENV: '1' } as NodeJS.ProcessEnv)).toBe('herdr');
  });

  test('returns herdr when HERDR_PANE_ID is set', () => {
    expect(detectTerminal({ HERDR_PANE_ID: 'p_1' } as NodeJS.ProcessEnv)).toBe('herdr');
  });

  test('returns ghostty for Ghostty markers', () => {
    expect(
      detectTerminal({
        TERM_PROGRAM: 'ghostty',
        GHOSTTY_RESOURCES_DIR: '/Applications/Ghostty.app/Contents/Resources',
      } as NodeJS.ProcessEnv),
    ).toBe('ghostty');
  });

  test('returns kitty for Kitty markers', () => {
    expect(
      detectTerminal({
        TERM_PROGRAM: 'kitty',
        KITTY_WINDOW_ID: '12',
      } as NodeJS.ProcessEnv),
    ).toBe('kitty');
  });

  test('returns undefined for unsupported terminals', () => {
    expect(detectTerminal({ TERM_PROGRAM: 'iTerm.app' } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe('shellQuote', () => {
  test('quotes empty and special values', () => {
    expect(shellQuote('')).toBe("''");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe('shouldCreateNativeTab', () => {
  test('creates a tab on narrow terminals', () => {
    expect(shouldCreateNativeTab({ COLUMNS: '50' } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldCreateNativeTab({ COLUMNS: '120' } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('herdr response parsing', () => {
  test('parses focused pane and created ids', () => {
    expect(
      parseFocusedHerdrPane(
        JSON.stringify({
          result: {
            panes: [
              { pane_id: 'p_a', focused: false, workspace_id: 'w_1' },
              { pane_id: 'p_b', focused: true, workspace_id: 'w_1' },
            ],
          },
        }),
      ),
    ).toEqual({ paneId: 'p_b', workspaceId: 'w_1' });

    expect(
      parseCreatedHerdrPaneId(JSON.stringify({ result: { pane: { pane_id: 'p_new' } } })),
    ).toBe('p_new');
    expect(
      parseCreatedHerdrTabRootPaneId(
        JSON.stringify({ result: { root_pane: { pane_id: 'p_tab' } } }),
      ),
    ).toBe('p_tab');
  });
});

describe('launchShellInNativeSplit', () => {
  test('creates a herdr split and runs the prepared command', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: NativeExecFn = async (command, args) => {
      calls.push({ command, args });
      if (command === 'herdr' && args[0] === 'pane' && args[1] === 'list') {
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              panes: [{ pane_id: 'p_focus', focused: true, workspace_id: 'w_1' }],
            },
          }),
        } satisfies NativeLaunchResult;
      }
      if (command === 'herdr' && args[0] === 'pane' && args[1] === 'split') {
        return {
          code: 0,
          stdout: JSON.stringify({ result: { pane: { pane_id: 'p_child' } } }),
        };
      }
      if (command === 'herdr' && args[0] === 'pane' && args[1] === 'run') {
        return { code: 0, stdout: 'ok' };
      }
      return { code: 1, stderr: `unexpected ${command} ${args.join(' ')}` };
    };

    const result = await launchShellInNativeSplit({
      terminal: 'herdr',
      exec,
      cwd: '/tmp/project',
      env: { HERDR_ENV: '1', COLUMNS: '120' } as NodeJS.ProcessEnv,
      prepare: (native) => ({
        command: `echo ${shellQuote(native.child?.pane ?? '')}`,
      }),
    });

    expect(result.result.code).toBe(0);
    expect(result.native).toEqual({
      terminal: 'herdr',
      parent: { pane: 'p_focus', workspace: 'w_1' },
      child: { pane: 'p_child', target: 'pane' },
    });
    expect(calls.at(-1)).toEqual({
      command: 'herdr',
      args: ['pane', 'run', 'p_child', "echo 'p_child'"],
    });
  });

  test('launches kitty with prepared command', async () => {
    const exec: NativeExecFn = async (command, args) => {
      expect(command).toBe('kitten');
      expect(args.slice(0, 4)).toEqual(['@', 'launch', '--type', 'window']);
      return { code: 0, stdout: '42\n' };
    };

    const result = await launchShellInNativeSplit({
      terminal: 'kitty',
      exec,
      cwd: '/tmp/project',
      env: {
        KITTY_WINDOW_ID: '7',
        COLUMNS: '160',
        SHELL: '/bin/zsh',
      } as NodeJS.ProcessEnv,
      prepare: () => ({ command: 'pi --session /tmp/s.jsonl' }),
    });

    expect(result.result.code).toBe(0);
    expect(result.native.child?.window).toBe('42');
    expect(result.native.child?.target).toBe('pane');
    expect(getKittyChildWindowId('42\n')).toBe('42');
    expect(
      buildNativeTerminalDetails('kitty', { KITTY_WINDOW_ID: '7' } as NodeJS.ProcessEnv),
    ).toEqual({
      terminal: 'kitty',
      parent: { window: '7' },
    });
  });
});
