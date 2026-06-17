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

const installedPluginStatus = {
  appBundledMarketplaceHasPlugin: true,
  cacheHasPlugin: true,
  enabled: true,
  installed: true,
};

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
        readComputerUsePluginStatus: async () => installedPluginStatus,
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
        readComputerUsePluginStatus: async () => installedPluginStatus,
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
        readComputerUsePluginStatus: async () => installedPluginStatus,
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

  test('includes extension enablement status when provided', async () => {
    const report = await buildCodexComputerUseDoctorReport({
      paths,
      extensionEnablement: { enabled: false, source: 'default' },
      deps: {
        exists: () => true,
        readBundleInfo: async () => ({
          bundleId: 'com.openai.sky.CUAService',
          teamIdentifier: '2DC432GLL2',
          version: '1.0',
          build: '799',
        }),
        readTccRows: async () => okTccRows,
        readDisplayState: async () => ({ displayAsleep: false }),
        findProcesses: async () => [],
        readComputerUsePluginStatus: async () => ({
          appBundledMarketplaceHasPlugin: true,
          cacheHasPlugin: true,
          enabled: true,
          installed: true,
        }),
      },
    });

    expect(report.text).toContain('Extension:');
    expect(report.text).toContain('✗ pi-codex-computer-use disabled (default)');
    expect(report.text).toContain('Tools and plugin skills are not injected while disabled.');
  });

  test('classifies a missing Computer Use plugin as a guided install fix', async () => {
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
        readDisplayState: async () => ({ displayAsleep: false }),
        findProcesses: async () => [],
        readComputerUsePluginStatus: async () => ({
          appBundledMarketplaceHasPlugin: true,
          cacheHasPlugin: false,
          enabled: false,
          installed: false,
        }),
      },
    });

    expect(report.hasFixableIssues).toBe(true);
    expect(report.text).toContain('✗ computer-use@openai-bundled is not installed and enabled');
    expect(report.text).toContain(
      '✗ computer-use@openai-bundled is not installed and enabled → Install Computer Use plugin from Codex.app',
    );
    expect(report.fixableIssues).toEqual([
      expect.objectContaining({ id: 'computer-use-plugin-missing' }),
    ]);
  });

  test('classifies a missing live bridge server as a guided reset fix', async () => {
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
        readDisplayState: async () => ({ displayAsleep: false }),
        findProcesses: async () => [],
        readBridgeMcpStatus: async () => ({ computerUseAvailable: false }),
        readComputerUsePluginStatus: async () => ({
          appBundledMarketplaceHasPlugin: true,
          cacheHasPlugin: true,
          enabled: true,
          installed: true,
        }),
      },
    });

    expect(report.hasFixableIssues).toBe(true);
    expect(report.text).toContain('✗ computer-use MCP server missing from live bridge');
    expect(report.fixableIssues).toEqual([
      expect.objectContaining({ id: 'computer-use-bridge-missing' }),
    ]);
  });

  test('reports Chromium browser bridge environment overrides and selected target source', async () => {
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
        readDisplayState: async () => ({ displayAsleep: false }),
        findProcesses: async () => [],
        readComputerUsePluginStatus: async () => installedPluginStatus,
        readBrowserBridgeStatus: async () => ({
          debugUrl: { value: 'http://127.0.0.1:9224', source: 'PI_CODEX_CHROME_DEBUG_URL' },
          extensionId: {
            value: 'hehggadaopoacecdllhhajmbjkdcmajg',
            source: 'detected official Codex extension',
          },
          appServerOrigin: {
            value: 'chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg',
            source: 'default official Codex extension origin',
          },
          devToolsReachable: true,
          nativeMessagingConfigured: true,
          nativeBridgeResponsive: false,
          devToolsFallbackUsable: true,
          guidance: [
            'Native bridge did not respond within 8000ms; browser tools will use DevTools fallback.',
          ],
        }),
      },
    });

    expect(report.text).toContain('Chromium browser bridge:');
    expect(report.text).toContain(
      '✓ DevTools endpoint reachable: http://127.0.0.1:9224 (PI_CODEX_CHROME_DEBUG_URL)',
    );
    expect(report.text).toContain(
      '✓ Codex extension selected: hehggadaopoacecdllhhajmbjkdcmajg (detected official Codex extension)',
    );
    expect(report.text).toContain('✗ Native browser bridge did not respond within probe timeout');
    expect(report.text).toContain('✓ DevTools fallback usable for browser tools');
    expect(report.text).toContain('Environment overrides:');
    expect(report.text).toContain('PI_CODEX_CHROME_DEBUG_URL');
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
  test('opens System Settings and reveals the app after a permission fix is selected in the TUI', async () => {
    const notify = vi.fn();
    const custom = vi.fn(async () =>
      custom.mock.calls.length === 1 ? 'screen-recording-missing' : 'close',
    );
    const openSettingsUrl = vi.fn(async () => {});
    const revealInFinder = vi.fn(async () => {});

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
        revealInFinder,
      },
    });

    expect(openSettingsUrl).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
    expect(revealInFinder).toHaveBeenCalledWith(paths.stableComputerUseApp);
    expect(custom).toHaveBeenCalledTimes(2);
    expect(custom).toHaveBeenCalledWith(expect.any(Function));
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('After granting permission'),
      'info',
    );
  });

  test('starts a short caffeinate guard after the display fix is selected in the TUI', async () => {
    const notify = vi.fn();
    const custom = vi.fn(async () => (custom.mock.calls.length === 1 ? 'display-asleep' : 'close'));
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
    expect(custom).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Started a 10-minute caffeinate guard'),
      'info',
    );
  });

  test('installs the Computer Use plugin from a selected doctor action and rechecks', async () => {
    const custom = vi.fn(async () =>
      custom.mock.calls.length === 1 ? 'computer-use-plugin-missing' : 'close',
    );
    const installComputerUsePlugin = vi.fn(async () => {});
    const readComputerUsePluginStatus = vi
      .fn()
      .mockResolvedValueOnce({
        appBundledMarketplaceHasPlugin: true,
        cacheHasPlugin: false,
        enabled: false,
        installed: false,
      })
      .mockResolvedValueOnce({
        appBundledMarketplaceHasPlugin: true,
        cacheHasPlugin: true,
        enabled: true,
        installed: true,
      });

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
        readDisplayState: async () => ({ displayAsleep: false }),
        findProcesses: async () => [],
        installComputerUsePlugin,
        readComputerUsePluginStatus,
      },
    });

    expect(installComputerUsePlugin).toHaveBeenCalledTimes(1);
    expect(readComputerUsePluginStatus).toHaveBeenCalledTimes(2);
    expect(custom).toHaveBeenCalledTimes(2);
  });

  test('resets the live bridge from a selected doctor action and rechecks', async () => {
    const custom = vi.fn(async () =>
      custom.mock.calls.length === 1 ? 'computer-use-bridge-missing' : 'close',
    );
    const resetBridge = vi.fn(async () => {});
    const readBridgeMcpStatus = vi
      .fn()
      .mockResolvedValueOnce({ computerUseAvailable: false })
      .mockResolvedValueOnce({ computerUseAvailable: true });

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
        readDisplayState: async () => ({ displayAsleep: false }),
        findProcesses: async () => [],
        readBridgeMcpStatus,
        readComputerUsePluginStatus: async () => ({
          appBundledMarketplaceHasPlugin: true,
          cacheHasPlugin: true,
          enabled: true,
          installed: true,
        }),
        resetBridge,
      },
    });

    expect(resetBridge).toHaveBeenCalledTimes(1);
    expect(readBridgeMcpStatus).toHaveBeenCalledTimes(2);
    expect(custom).toHaveBeenCalledTimes(2);
  });

  test('repairs Chromium native host manifests from a selected browser doctor action and rechecks', async () => {
    const custom = vi.fn(async () =>
      custom.mock.calls.length === 1 ? 'chrome-native-host-manifest-missing-origin' : 'close',
    );
    const repairChromeNativeHostManifests = vi.fn(async () => {});
    const readBrowserBridgeStatus = vi
      .fn()
      .mockResolvedValueOnce({
        debugUrl: { value: 'http://127.0.0.1:9224', source: 'default Chromium DevTools URL' },
        extensionId: {
          value: 'hehggadaopoacecdllhhajmbjkdcmajg',
          source: 'detected official Codex extension',
        },
        appServerOrigin: {
          value: 'chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg',
          source: 'default official Codex extension origin',
        },
        devToolsReachable: true,
        nativeMessagingConfigured: false,
        repairNativeMessagingAvailable: true,
        nativeBridgeResponsive: false,
        devToolsFallbackUsable: true,
        guidance: [],
      })
      .mockResolvedValueOnce({
        debugUrl: { value: 'http://127.0.0.1:9224', source: 'default Chromium DevTools URL' },
        extensionId: {
          value: 'hehggadaopoacecdllhhajmbjkdcmajg',
          source: 'detected official Codex extension',
        },
        appServerOrigin: {
          value: 'chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg',
          source: 'default official Codex extension origin',
        },
        devToolsReachable: true,
        nativeMessagingConfigured: true,
        nativeBridgeResponsive: true,
        devToolsFallbackUsable: true,
        guidance: [],
      });

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
        readDisplayState: async () => ({ displayAsleep: false }),
        findProcesses: async () => [],
        readBrowserBridgeStatus,
        repairChromeNativeHostManifests,
      },
    });

    expect(repairChromeNativeHostManifests).toHaveBeenCalledTimes(1);
    expect(readBrowserBridgeStatus).toHaveBeenCalledTimes(2);
    expect(custom).toHaveBeenCalledTimes(2);
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
