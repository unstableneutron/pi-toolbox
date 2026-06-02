import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { getCodexComputerUsePaths } from './codex-paths';
import { DoctorReportView, type DoctorViewAction } from './doctor-ui';

const execFileAsync = promisify(execFile);

const SERVICE_BUNDLE_ID = 'com.openai.sky.CUAService';
const CLIENT_BUNDLE_ID = 'com.openai.sky.CUAService.cli';
const SCREEN_CAPTURE_SERVICE = 'kTCCServiceScreenCapture';
const ACCESSIBILITY_SERVICE = 'kTCCServiceAccessibility';
const SCREEN_CAPTURE_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
const ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const DEFAULT_CAFFEINATE_SECONDS = 600;

interface CodexComputerUsePathsForDoctor {
  codexApp: string;
  codexExecutable: string;
  codexHome: string;
  stableComputerUseApp: string;
  stableComputerUseClient: string;
  browserClientScripts: Record<string, string | undefined>;
}

export interface BundleInfo {
  bundleId?: string;
  teamIdentifier?: string;
  version?: string;
  build?: string;
}

export interface TccRow {
  service: string;
  client: string;
  authValue: number;
}

export interface ProcessInfo {
  pid: number;
  command: string;
}

export interface DisplayState {
  displayAsleep: boolean;
}

export interface DoctorFixableIssue {
  caffeinateSeconds?: number;
  id: string;
  instructions: string;
  settingsUrl?: string;
  title: string;
}

export interface CodexComputerUseDoctorReport {
  text: string;
  hasFixableIssues: boolean;
  fixableIssues: DoctorFixableIssue[];
}

export interface CodexComputerUseDoctorDeps {
  exists?: (filePath: string) => boolean;
  findProcesses?: () => Promise<ProcessInfo[]>;
  openSettingsUrl?: (url: string) => Promise<void>;
  readBundleInfo?: (appPath: string) => Promise<BundleInfo>;
  readDisplayState?: () => Promise<DisplayState>;
  readTccRows?: () => Promise<TccRow[]>;
  startWakeGuard?: (seconds: number) => Promise<void>;
}

export interface CodexComputerUseDoctorOptions {
  deps?: CodexComputerUseDoctorDeps;
  paths?: CodexComputerUsePathsForDoctor;
}

function boolMark(ok: boolean): string {
  return ok ? '✓' : '✗';
}

function helperAppPath(paths: { stableComputerUseClient: string }): string {
  return path.dirname(path.dirname(path.dirname(paths.stableComputerUseClient)));
}

async function defaultReadBundleInfo(appPath: string): Promise<BundleInfo> {
  const infoPlist = path.join(appPath, 'Contents/Info.plist');
  const { stdout } = await execFileAsync('/usr/bin/plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    infoPlist,
  ]);
  const info = JSON.parse(stdout);
  let teamIdentifier: string | undefined;
  try {
    const codesign = await execFileAsync('/usr/bin/codesign', ['-dv', appPath]);
    const combined = `${codesign.stdout}\n${codesign.stderr}`;
    teamIdentifier = combined.match(/TeamIdentifier=(.+)/)?.[1]?.trim();
  } catch {
    teamIdentifier = undefined;
  }
  return {
    bundleId: info.CFBundleIdentifier,
    build: info.CFBundleVersion,
    teamIdentifier,
    version: info.CFBundleShortVersionString,
  };
}

function parseTccRows(stdout: string): TccRow[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [service, client, authValue] = line.split('|');
      return { service, client, authValue: Number(authValue) };
    });
}

export function parseTccRowsFromOutputs(outputs: string[]): TccRow[] {
  return outputs.flatMap(parseTccRows);
}

async function defaultReadTccRows(): Promise<TccRow[]> {
  const tccDbs = [
    path.join(os.homedir(), 'Library/Application Support/com.apple.TCC/TCC.db'),
    '/Library/Application Support/com.apple.TCC/TCC.db',
  ].filter((dbPath) => fs.existsSync(dbPath));
  const clients = [SERVICE_BUNDLE_ID, CLIENT_BUNDLE_ID].map((client) => `'${client}'`).join(',');
  const query = [
    'select service, client, auth_value',
    'from access',
    `where client in (${clients})`,
    'order by service, client;',
  ].join(' ');
  const outputs = await Promise.all(
    tccDbs.map(async (tccDb) => {
      try {
        const { stdout } = await execFileAsync('/usr/bin/sqlite3', [tccDb, query]);
        return stdout;
      } catch {
        return '';
      }
    }),
  );
  return parseTccRowsFromOutputs(outputs);
}

async function defaultFindProcesses(): Promise<ProcessInfo[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,command=']);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /SkyComputerUse(Service|Client)|Codex Computer Use/.test(line))
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      return { pid: Number(match?.[1] ?? 0), command: match?.[2] ?? line };
    });
}

async function defaultOpenSettingsUrl(url: string): Promise<void> {
  await execFileAsync('/usr/bin/open', [url]);
}

async function defaultReadDisplayState(): Promise<DisplayState> {
  const { stdout } = await execFileAsync('/usr/sbin/system_profiler', ['SPDisplaysDataType']);
  return { displayAsleep: /Display Asleep:\s*Yes/i.test(stdout) };
}

async function defaultStartWakeGuard(seconds: number): Promise<void> {
  const child = spawn('/usr/bin/caffeinate', ['-dimsu', '-t', String(seconds)], {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {});
  child.unref();
}

function hasGrantedTcc(rows: TccRow[], client: string, service: string): boolean {
  return rows.some(
    (row) => row.client === client && row.service === service && row.authValue === 2,
  );
}

function formatBundleInfo(label: string, info: BundleInfo): string[] {
  return [
    `  ${label} bundle id: ${info.bundleId ?? '(unknown)'}`,
    `  ${label} version/build: ${info.version ?? '(unknown)'}/${info.build ?? '(unknown)'}`,
    `  ${label} signing team: ${info.teamIdentifier ?? '(unknown)'}`,
  ];
}

function makePermissionIssue(kind: 'screen' | 'accessibility'): DoctorFixableIssue {
  if (kind === 'screen') {
    return {
      id: 'screen-recording-missing',
      title: 'Screen Recording missing for Codex Computer Use.app',
      settingsUrl: SCREEN_CAPTURE_SETTINGS_URL,
      instructions:
        'Enable Codex Computer Use.app in Privacy & Security → Screen & System Audio Recording, then rerun /codex-computer-use-doctor.',
    };
  }
  return {
    id: 'accessibility-missing',
    title: 'Accessibility missing for Codex Computer Use.app',
    settingsUrl: ACCESSIBILITY_SETTINGS_URL,
    instructions:
      'Enable Codex Computer Use.app in Privacy & Security → Accessibility, then rerun /codex-computer-use-doctor.',
  };
}

function makeDisplayAsleepIssue(): DoctorFixableIssue {
  return {
    caffeinateSeconds: DEFAULT_CAFFEINATE_SECONDS,
    id: 'display-asleep',
    instructions:
      'Start a 10-minute caffeinate guard to wake/hold the display, then retry Codex Computer Use capture.',
    title: 'Display appears asleep or not capture-ready',
  };
}

function formatDuration(seconds: number): string {
  if (seconds % 60 === 0) return `${seconds / 60}-minute`;
  return `${seconds}-second`;
}

function actionLabelForIssue(issue: DoctorFixableIssue): string {
  if (issue.caffeinateSeconds !== undefined) {
    return `Start a ${formatDuration(issue.caffeinateSeconds)} caffeinate guard`;
  }
  if (issue.id === 'screen-recording-missing') return 'Open Screen Recording settings';
  if (issue.id === 'accessibility-missing') return 'Open Accessibility settings';
  return issue.instructions;
}

function formatDoctorReportText(lines: string[], fixableIssues: DoctorFixableIssue[]): string {
  const summary = ['Actionable findings:'];
  if (fixableIssues.length === 0) {
    summary.push('✓ No guided fixes recommended');
  } else {
    for (const issue of fixableIssues) {
      summary.push(`✗ ${issue.title} → ${actionLabelForIssue(issue)}`);
    }
  }

  return [lines[0]!, '', ...summary, '', ...lines.slice(2)].join('\n');
}

export async function buildCodexComputerUseDoctorReport(
  options: CodexComputerUseDoctorOptions = {},
): Promise<CodexComputerUseDoctorReport> {
  const deps = options.deps ?? {};
  const exists = deps.exists ?? fs.existsSync;
  const paths = options.paths ?? getCodexComputerUsePaths();
  const helperApp = helperAppPath(paths);
  const lines = ['Codex Computer Use doctor', ''];
  const fixableIssues: DoctorFixableIssue[] = [];

  const codexAppExists = exists(paths.codexApp);
  const codexExecutableExists = exists(paths.codexExecutable);
  const computerUseAppExists = exists(paths.stableComputerUseApp);
  const computerUseClientExists = exists(paths.stableComputerUseClient);

  lines.push('Paths:');
  lines.push(`${boolMark(codexAppExists)} Codex.app exists: ${paths.codexApp}`);
  lines.push(
    `${boolMark(codexExecutableExists)} Codex executable exists: ${paths.codexExecutable}`,
  );
  lines.push(
    `${boolMark(computerUseAppExists)} Computer Use app exists: ${paths.stableComputerUseApp}`,
  );
  lines.push(
    `${boolMark(computerUseClientExists)} Computer Use client exists: ${paths.stableComputerUseClient}`,
  );

  lines.push('', 'Identity:');
  try {
    const serviceInfo = await (deps.readBundleInfo ?? defaultReadBundleInfo)(
      paths.stableComputerUseApp,
    );
    lines.push(...formatBundleInfo('service', serviceInfo));
    if (serviceInfo.bundleId !== SERVICE_BUNDLE_ID) {
      lines.push(`  ⚠ Expected service bundle id ${SERVICE_BUNDLE_ID}`);
    }
  } catch (error) {
    lines.push(
      `  ⚠ Could not read service bundle info: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const clientInfo = await (deps.readBundleInfo ?? defaultReadBundleInfo)(helperApp);
    lines.push(...formatBundleInfo('client', clientInfo));
    if (clientInfo.bundleId !== CLIENT_BUNDLE_ID) {
      lines.push(`  ⚠ Expected client bundle id ${CLIENT_BUNDLE_ID}`);
    }
  } catch (error) {
    lines.push(
      `  ⚠ Could not read client bundle info: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  lines.push('', 'Permissions:');
  let tccRows: TccRow[] = [];
  try {
    tccRows = await (deps.readTccRows ?? defaultReadTccRows)();
  } catch (error) {
    lines.push(
      `⚠ Could not inspect TCC permissions: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const screenGranted = hasGrantedTcc(tccRows, SERVICE_BUNDLE_ID, SCREEN_CAPTURE_SERVICE);
  const accessibilityGranted = hasGrantedTcc(tccRows, SERVICE_BUNDLE_ID, ACCESSIBILITY_SERVICE);
  lines.push(
    `${boolMark(screenGranted)} Screen Recording ${screenGranted ? 'granted' : 'missing'} for Codex Computer Use.app`,
  );
  lines.push(
    `${boolMark(accessibilityGranted)} Accessibility ${accessibilityGranted ? 'granted' : 'missing'} for Codex Computer Use.app`,
  );
  if (!screenGranted) fixableIssues.push(makePermissionIssue('screen'));
  if (!accessibilityGranted) fixableIssues.push(makePermissionIssue('accessibility'));

  lines.push('', 'Runtime:');
  try {
    const processes = await (deps.findProcesses ?? defaultFindProcesses)();
    const serviceRunning = processes.some((processInfo) =>
      processInfo.command.includes('SkyComputerUseService'),
    );
    const clientRunning = processes.some((processInfo) =>
      processInfo.command.includes('SkyComputerUseClient'),
    );
    lines.push(
      `${serviceRunning ? '✓' : '•'} SkyComputerUseService ${serviceRunning ? 'running' : 'not running yet'}`,
    );
    lines.push(
      `${clientRunning ? '✓' : '•'} SkyComputerUseClient MCP ${clientRunning ? 'running' : 'not running yet'}`,
    );
  } catch (error) {
    lines.push(
      `⚠ Could not inspect helper processes: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  lines.push('', 'Capture readiness:');
  try {
    const displayState = await (deps.readDisplayState ?? defaultReadDisplayState)();
    if (displayState.displayAsleep) {
      lines.push('✗ Display appears asleep or not capture-ready');
      fixableIssues.push(makeDisplayAsleepIssue());
    } else {
      lines.push('✓ Display appears awake');
    }
  } catch (error) {
    lines.push(
      `⚠ Could not inspect display sleep state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (fixableIssues.length > 0) {
    lines.push('', 'Guided fixes:');
    for (const issue of fixableIssues) {
      lines.push(`- ${issue.title}`);
      lines.push(`  ${issue.instructions}`);
    }
  }

  return {
    text: formatDoctorReportText(lines, fixableIssues),
    hasFixableIssues: fixableIssues.length > 0,
    fixableIssues,
  };
}

function notify(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI && ctx.ui) {
    ctx.ui.notify(message, 'info');
  } else {
    console.log(message);
  }
}

async function runFixableIssue(
  ctx: ExtensionContext,
  issue: DoctorFixableIssue,
  deps: CodexComputerUseDoctorDeps,
): Promise<void> {
  const openSettingsUrl = deps.openSettingsUrl ?? defaultOpenSettingsUrl;
  const startWakeGuard = deps.startWakeGuard ?? defaultStartWakeGuard;

  if (issue.caffeinateSeconds !== undefined) {
    const duration = formatDuration(issue.caffeinateSeconds);
    await startWakeGuard(issue.caffeinateSeconds);
    notify(
      ctx,
      `Started a ${duration} caffeinate guard. Retry the Codex Computer Use action, or rerun /codex-computer-use-doctor.`,
    );
    return;
  }

  if (issue.settingsUrl) {
    await openSettingsUrl(issue.settingsUrl);
    notify(
      ctx,
      `${issue.instructions}\n\nAfter granting permission, rerun /codex-computer-use-doctor.`,
    );
  }
}

async function runDoctorFallback(
  ctx: ExtensionContext,
  report: CodexComputerUseDoctorReport,
  deps: CodexComputerUseDoctorDeps,
): Promise<void> {
  notify(ctx, report.text);

  if (!ctx.hasUI || !ctx.ui || !report.hasFixableIssues) return;

  for (const issue of report.fixableIssues) {
    if (issue.caffeinateSeconds !== undefined) {
      const duration = formatDuration(issue.caffeinateSeconds);
      const shouldStart = await ctx.ui.confirm(
        'Wake display for Computer Use?',
        `${issue.title}\n\n${issue.instructions}\n\nStart a ${duration} caffeinate guard now?`,
      );
      if (shouldStart) await runFixableIssue(ctx, issue, deps);
      continue;
    }

    if (!issue.settingsUrl) continue;
    const shouldOpen = await ctx.ui.confirm(
      'Fix Codex Computer Use permissions?',
      `${issue.title}\n\n${issue.instructions}\n\nOpen ${
        issue.id === 'screen-recording-missing'
          ? 'Screen & System Audio Recording'
          : 'Accessibility'
      } settings now?`,
    );
    if (shouldOpen) await runFixableIssue(ctx, issue, deps);
  }
}

export async function runCodexComputerUseDoctor(
  ctx: ExtensionContext,
  options: CodexComputerUseDoctorOptions = {},
): Promise<void> {
  const deps = options.deps ?? {};
  if (!ctx.hasUI || !ctx.ui || !ctx.ui.custom) {
    await runDoctorFallback(ctx, await buildCodexComputerUseDoctorReport(options), deps);
    return;
  }

  for (;;) {
    const report = await buildCodexComputerUseDoctorReport(options);
    const action = await ctx.ui.custom<DoctorViewAction>((tui, theme, _keybindings, done) => {
      const view = new DoctorReportView(report, theme, done);
      return {
        render: (width: number) => view.render(width),
        invalidate: () => view.invalidate(),
        handleInput: (data: string) => {
          view.handleInput(data);
          tui.requestRender();
        },
      };
    });

    if (!action || action === 'close') return;
    if (action === 'recheck') continue;

    const issue = report.fixableIssues.find((candidate) => candidate.id === action);
    if (!issue) continue;
    await runFixableIssue(ctx, issue, deps);
    return;
  }
}
