import { describe, expect, test, vi } from 'vitest';

import {
  buildCodexComputerUseDoctorReport,
  parseTccRowsFromOutputs,
  runCodexComputerUseDoctor,
} from './doctor';

const paths = {
  codexApp: '/Applications/Codex.app',
  codexExecutable: '/Applications/Codex.app/Contents/Resources/codex',
  codexHome: '/Users/example/.codex',
  stableComputerUseApp: '/Users/example/.codex/computer-use/Codex Computer Use.app',
  stableComputerUseClient:
    '/Users/example/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient',
  browserClientScripts: {},
};

const okTccRows = [
  { service: 'kTCCServiceAccessibility', client: 'com.openai.sky.CUAService', authValue: 2 },
  { service: 'kTCCServiceScreenCapture', client: 'com.openai.sky.CUAService', authValue: 2 },
];

describe('buildCodexComputerUseDoctorReport', () => {
  test('reports healthy paths and required TCC grants', async () => {
    const report = await buildCodexComputerUseDoctorReport({
      paths,
      deps: {
        exists: () => true,
        readBundleInfo: async (appPath) => ({
          bundleId: appPath.endsWith('SkyComputerUseClient.app')
            ? 'com.openai.sky.CUAService.cli'
            : 'com.openai.sky.CUAService',
          teamIdentifier: '2DC432GLL2',
          version: '1.0',
          build: '799',
        }),
        readTccRows: async () => okTccRows,
        readDisplayState: async () => ({ displayAsleep: false }),
        findProcesses: async () => [
          { pid: 100, command: 'SkyComputerUseService' },
          { pid: 101, command: 'SkyComputerUseClient mcp' },
        ],
      },
    });

    expect(report.hasFixableIssues).toBe(false);
    expect(report.text).toContain('✓ Computer Use app exists');
    expect(report.text).toContain('✓ Screen Recording granted for Codex Computer Use.app');
    expect(report.text).toContain('✓ Accessibility granted for Codex Computer Use.app');
  });

  test('classifies missing Screen Recording as a guided manual fix', async () => {
    const report = await buildCodexComputerUseDoctorReport({
      paths,
      deps: {
        exists: () => true,
        readBundleInfo: async () => ({
          bundleId: 'com.openai.sky.CUAService',
          teamIdentifier: '2DC432GLL2',
          version: '1.0',
          build: '799',
        }),
        readTccRows: async () => [
          {
            service: 'kTCCServiceAccessibility',
            client: 'com.openai.sky.CUAService',
            authValue: 2,
          },
        ],
        readDisplayState: async () => ({ displayAsleep: false }),
        findProcesses: async () => [],
      },
    });

    expect(report.hasFixableIssues).toBe(true);
    expect(report.text).toContain('✗ Screen Recording missing for Codex Computer Use.app');
    expect(report.fixableIssues).toEqual([
      expect.objectContaining({
        id: 'screen-recording-missing',
        settingsUrl:
          'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      }),
    ]);
  });

  test('classifies an asleep display as a guided caffeinate fix', async () => {
    const report = await buildCodexComputerUseDoctorReport({
      paths,
      deps: {
        exists: () => true,
        readBundleInfo: async () => ({
          bundleId: 'com.openai.sky.CUAService',
          teamIdentifier: '2DC432GLL2',
          version: '1.0',
          build: '799',
        }),
        readTccRows: async () => okTccRows,
        readDisplayState: async () => ({ displayAsleep: true }),
        findProcesses: async () => [],
      },
    });

    expect(report.hasFixableIssues).toBe(true);
    expect(report.text).toContain('✗ Display appears asleep or not capture-ready');
    expect(report.text).toContain(
      '✗ Display appears asleep or not capture-ready → Start a 10-minute caffeinate guard',
    );
    expect(report.text.indexOf('Actionable findings:')).toBeLessThan(report.text.indexOf('Paths:'));
    expect(report.fixableIssues).toEqual([
      expect.objectContaining({
        caffeinateSeconds: 600,
        id: 'display-asleep',
      }),
    ]);
  });
});

describe('parseTccRowsFromOutputs', () => {
  test('combines user and system TCC rows', () => {
    expect(
      parseTccRowsFromOutputs([
        '',
        'kTCCServiceScreenCapture|com.openai.sky.CUAService|2\n' +
          'kTCCServiceAccessibility|com.openai.sky.CUAService|2\n',
      ]),
    ).toEqual([
      { service: 'kTCCServiceScreenCapture', client: 'com.openai.sky.CUAService', authValue: 2 },
      { service: 'kTCCServiceAccessibility', client: 'com.openai.sky.CUAService', authValue: 2 },
    ]);
  });
});

describe('runCodexComputerUseDoctor', () => {
  test('opens System Settings after a permission fix is selected in the TUI', async () => {
    const notify = vi.fn();
    const custom = vi.fn(async () => 'screen-recording-missing');
    const openSettingsUrl = vi.fn(async () => {});

    await runCodexComputerUseDoctor({ hasUI: true, ui: { custom, notify } } as any, {
      paths,
      deps: {
        exists: () => true,
        readBundleInfo: async () => ({
          bundleId: 'com.openai.sky.CUAService',
          teamIdentifier: '2DC432GLL2',
          version: '1.0',
          build: '799',
        }),
        readTccRows: async () => [],
        readDisplayState: async () => ({ displayAsleep: false }),
        findProcesses: async () => [],
        openSettingsUrl,
      },
    });

    expect(openSettingsUrl).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
    expect(custom).toHaveBeenCalledWith(expect.any(Function));
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('After granting permission'),
      'info',
    );
  });

  test('starts a short caffeinate guard after the display fix is selected in the TUI', async () => {
    const notify = vi.fn();
    const custom = vi.fn(async () => 'display-asleep');
    const startWakeGuard = vi.fn(async () => {});

    await runCodexComputerUseDoctor({ hasUI: true, ui: { custom, notify } } as any, {
      paths,
      deps: {
        exists: () => true,
        readBundleInfo: async () => ({
          bundleId: 'com.openai.sky.CUAService',
          teamIdentifier: '2DC432GLL2',
          version: '1.0',
          build: '799',
        }),
        readTccRows: async () => okTccRows,
        readDisplayState: async () => ({ displayAsleep: true }),
        findProcesses: async () => [],
        startWakeGuard,
      },
    });

    expect(startWakeGuard).toHaveBeenCalledWith(600);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Started a 10-minute caffeinate guard'),
      'info',
    );
  });

  test('rebuilds the report when Re-check is selected', async () => {
    const custom = vi.fn(async () => (custom.mock.calls.length === 1 ? 'recheck' : 'close'));
    const readDisplayState = vi
      .fn()
      .mockResolvedValueOnce({ displayAsleep: true })
      .mockResolvedValueOnce({ displayAsleep: false });

    await runCodexComputerUseDoctor({ hasUI: true, ui: { custom, notify: vi.fn() } } as any, {
      paths,
      deps: {
        exists: () => true,
        readBundleInfo: async () => ({
          bundleId: 'com.openai.sky.CUAService',
          teamIdentifier: '2DC432GLL2',
          version: '1.0',
          build: '799',
        }),
        readTccRows: async () => okTccRows,
        readDisplayState,
        findProcesses: async () => [],
      },
    });

    expect(readDisplayState).toHaveBeenCalledTimes(2);
    expect(custom).toHaveBeenCalledTimes(2);
  });
});
