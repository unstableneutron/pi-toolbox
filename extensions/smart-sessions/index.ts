import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import {
  type Component,
  Key,
  Markdown,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';

import { compactName, WINDOW_TITLE_MAX_WORDS, type RollingSessionSummary } from './contracts';
import { buildConversationSnapshot, buildRollingSummaryInput } from './conversation';
import { formatInlineRollingSummary, formatRollingSummaryMarkdown } from './rendering';
import { readRollingSummarySidecar, writeRollingSummaryCurrent } from './sidecar';
import { generateRollingSummary } from './unified-summary';
import { hasTui } from '../shared/ui-mode';

const DISABLE_ENV_VAR = 'PI_SMART_SESSIONS_DISABLED';
const ENTRY_TYPE_WINDOW = 'smart-sessions/window-name';
const HERDR_TITLE_SOURCE = 'pi-toolbox:smart-sessions:title';
const HERDR_PI_SOURCE = 'herdr:pi';
const INLINE_SUMMARY_WIDGET_KEY = 'smart-sessions/summary-ready';
const AUTO_SUMMARY_MIN_WORK_MS = 5 * 60_000;
const AUTO_SUMMARY_IDLE_MS = 60_000;
const AUTO_SUMMARY_FALLBACK_IDLE_MS = 5 * 60_000;
const AUTO_SUMMARY_MIN_TURNS = 1;
const MAX_ROLLING_REWRITE_COUNT = 12;
const EXIT_SUMMARY_STATE_KEY = '__PI_SMART_SESSIONS_EXIT_SUMMARY_STATE__';
const RESUME_RUN_ID_ENV = 'PI_RESUME_RUN_ID';
const SHIM_VERSION_ENV = 'PI_SMART_SESSION_SHIM_VERSION';
const SHIM_TARGET_ENV = 'PI_SMART_SESSION_SHIM_TARGET';
const SHIM_TARGET_MISSING_ENV = 'PI_SMART_SESSION_SHIM_TARGET_MISSING';
const WRAPPER_SHA_ENV = 'PI_SMART_SESSION_WRAPPER_SHA256';
const RESUME_HINT_DIR = 'resume-hints';
const WRAPPER_NOTICE_FILE = 'wrapper-notice-shown';
const MANAGED_WRAPPER_MARKER = 'PI_SMART_SESSION_WRAPPER=1';
const SMART_SESSION_SHIM_VERSION = '1';

let bundledSmartSessionScriptSha256: string | undefined;

let generatedResumeRunId: string | undefined;
let generatedResumeRunIdInUse = false;

let herdrTitleSeq = Date.now() * 1000;
const herdrAgentRenameInFlight = new Set<string>();

const SUMMARY_MARKDOWN_THEME = {
  heading: (text: string) => `\x1b[1;36m${text}\x1b[0m`,
  link: (text: string) => `\x1b[4;36m${text}\x1b[0m`,
  linkUrl: (text: string) => `\x1b[2;36m${text}\x1b[0m`,
  code: (text: string) => `\x1b[33m${text}\x1b[0m`,
  codeBlock: (text: string) => text,
  codeBlockBorder: (text: string) => `\x1b[2m${text}\x1b[0m`,
  quote: (text: string) => `\x1b[2m${text}\x1b[0m`,
  quoteBorder: (text: string) => `\x1b[2m${text}\x1b[0m`,
  hr: (text: string) => `\x1b[2m${text}\x1b[0m`,
  listBullet: (text: string) => `\x1b[1;36m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[0m`,
  strikethrough: (text: string) => `\x1b[9m${text}\x1b[0m`,
  underline: (text: string) => `\x1b[4m${text}\x1b[0m`,
};

interface ExitSummaryState {
  installed: boolean;
  pendingText: string | null;
}

interface BackgroundSummaryState {
  currentRunStartedAt: number | null;
  currentRunTurns: number;
  accumulatedWorkMs: number;
  accumulatedTurns: number;
  timer: ReturnType<typeof setTimeout> | null;
  fallbackTimer: ReturnType<typeof setTimeout> | null;
  abort: AbortController | null;
}

type RefreshReason = 'auto' | 'manual' | 'rename' | 'background';
type RefreshSummaryResult =
  | { ok: true; result: RollingSessionSummary }
  | { ok: false; reason: string };

function isDisabled(): boolean {
  const value = process.env[DISABLE_ENV_VAR]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function getExitSummaryState(): ExitSummaryState {
  const globalState = globalThis as typeof globalThis & {
    [EXIT_SUMMARY_STATE_KEY]?: ExitSummaryState;
  };

  if (!globalState[EXIT_SUMMARY_STATE_KEY]) {
    globalState[EXIT_SUMMARY_STATE_KEY] = {
      installed: false,
      pendingText: null,
    };
  }

  return globalState[EXIT_SUMMARY_STATE_KEY]!;
}

function ensureExitSummaryWriterInstalled(): void {
  const state = getExitSummaryState();
  if (state.installed) return;

  state.installed = true;
  process.once('exit', () => {
    const text = state.pendingText;
    state.pendingText = null;
    state.installed = false;

    if (!text) return;

    try {
      writeSync(1, text);
    } catch {
      // Ignore exit-time write failures.
    }
  });
}

function clearPendingExitSummary(): void {
  getExitSummaryState().pendingText = null;
}

function setPendingExitSummary(text: string): void {
  ensureExitSummaryWriterInstalled();
  getExitSummaryState().pendingText = text;
}

export function formatExitSummary(title: string, sessionId: string): string {
  return [
    '',
    '',
    `\x1b[1;36mπ -\x1b[0m \x1b[1m${title}\x1b[0m`,
    '',
    `\x1b[2mpi --session ${sessionId}\x1b[0m`,
    '',
  ].join('\n');
}

function sanitizeResumeRunId(value: string | undefined): string | undefined {
  const sanitized = value
    ?.trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '')
    .slice(0, 160);

  if (!sanitized || sanitized === '.' || sanitized === '..') return undefined;
  return sanitized;
}

function getResumeRunId(): string {
  const explicit = sanitizeResumeRunId(process.env[RESUME_RUN_ID_ENV]);
  if (explicit && (!generatedResumeRunIdInUse || explicit !== generatedResumeRunId)) {
    generatedResumeRunIdInUse = false;
    return explicit;
  }

  generatedResumeRunId ??= `pi-${Date.now()}-${process.pid}`;
  generatedResumeRunIdInUse = true;
  process.env[RESUME_RUN_ID_ENV] = generatedResumeRunId;
  return generatedResumeRunId;
}

function getSmartSessionsDir(): string {
  return join(getAgentDir(), 'smart-sessions');
}

function getResumeHintPath(): string {
  return join(getSmartSessionsDir(), RESUME_HINT_DIR, getResumeRunId());
}

function sanitizeHintField(value: string | undefined): string {
  return (value ?? '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function writeTextFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, text, 'utf8');
  renameSync(tempPath, path);
}

function getWrapperNoticePath(): string {
  return join(getSmartSessionsDir(), WRAPPER_NOTICE_FILE);
}

function getBundledSmartSessionScriptPath(): string {
  return fileURLToPath(new URL('./scripts/pi-smart-session', import.meta.url));
}

function getHomeDir(): string {
  return process.env.HOME || homedir();
}

function getDetectedShellName(): string {
  const shellName = basename(process.env.SHELL || '').toLowerCase();
  if (shellName.includes('zsh')) return 'Zsh';
  if (shellName.includes('bash')) return 'Bash';
  return shellName || 'Unknown shell';
}

function readTextIfExists(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

function getInstalledSmartSessionWrapperPath(): string {
  return join(getHomeDir(), '.local', 'bin', 'pi');
}

function formatHomePath(path: string): string {
  const home = getHomeDir().replace(/\/$/, '');
  if (home && home !== '/' && path.startsWith(`${home}/`)) {
    return `$HOME/${path.slice(home.length + 1)}`;
  }
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getBundledSmartSessionScriptSha256(): string {
  bundledSmartSessionScriptSha256 ??= createHash('sha256')
    .update(readFileSync(getBundledSmartSessionScriptPath()))
    .digest('hex');
  return bundledSmartSessionScriptSha256;
}

function buildSmartSessionShim(): string {
  const target = getBundledSmartSessionScriptPath();
  const targetSha = getBundledSmartSessionScriptSha256();

  return `#!/bin/sh
# ${MANAGED_WRAPPER_MARKER}
PI_SMART_SESSION_SHIM=1
PI_SMART_SESSION_SHIM_VERSION=${SMART_SESSION_SHIM_VERSION}
PI_SMART_SESSION_SHIM_TARGET=${shellQuote(target)}
PI_SMART_SESSION_WRAPPER_SHA256=${targetSha}

script_path() {
	case "$0" in
	/*) printf '%s\n' "$0" ;;
	*) printf '%s\n' "$(pwd)/$0" ;;
	esac
}

canonical_path() {
	path=$1
	dir=$(dirname "$path")
	base=$(basename "$path")
	if resolved=$(cd "$dir" 2>/dev/null && printf '%s/%s\n' "$(pwd -P)" "$base"); then
		printf '%s\n' "$resolved"
	else
		printf '%s\n' "$path"
	fi
}

find_real_pi() {
	self=$(canonical_path "$(script_path)")
	old_ifs=$IFS
	IFS=:
	for dir in ${'${PATH:-}'}; do
		[ -n "$dir" ] || dir=.
		candidate=$dir/pi
		[ -x "$candidate" ] || continue
		candidate_path=$(canonical_path "$candidate")
		[ "$candidate_path" = "$self" ] && continue
		IFS=$old_ifs
		printf '%s\n' "$candidate_path"
		return 0
	done
	IFS=$old_ifs
	return 1
}

real_pi=$(find_real_pi) || {
	printf 'pi smart-sessions shim could not find the real pi binary in PATH.\n' >&2
	exit 127
}

if [ -x "$PI_SMART_SESSION_SHIM_TARGET" ]; then
	exec env \
		PI_SMART_SESSION_REAL_PI="$real_pi" \
		PI_SMART_SESSION_SHIM_VERSION="$PI_SMART_SESSION_SHIM_VERSION" \
		PI_SMART_SESSION_SHIM_TARGET="$PI_SMART_SESSION_SHIM_TARGET" \
		PI_SMART_SESSION_WRAPPER_SHA256="$PI_SMART_SESSION_WRAPPER_SHA256" \
		"$PI_SMART_SESSION_SHIM_TARGET" "$@"
fi

printf 'pi smart-sessions shim target is missing; falling back to real pi.\n' >&2
printf 'Refresh with /smart-sessions-setup, or remove this shim with: rm %s\n' "$(script_path)" >&2
exec env \
	PI_SMART_SESSION_SHIM_VERSION="$PI_SMART_SESSION_SHIM_VERSION" \
	PI_SMART_SESSION_SHIM_TARGET="$PI_SMART_SESSION_SHIM_TARGET" \
	PI_SMART_SESSION_WRAPPER_SHA256="$PI_SMART_SESSION_WRAPPER_SHA256" \
	PI_SMART_SESSION_SHIM_TARGET_MISSING=1 \
	"$real_pi" "$@"
`;
}

function wrapperStatus(path: string): 'missing' | 'installed' | 'unmanaged' {
  if (!existsSync(path)) return 'missing';
  return readTextIfExists(path).includes(MANAGED_WRAPPER_MARKER) ? 'installed' : 'unmanaged';
}

function localBinIsInPath(wrapperPath: string): boolean {
  return (process.env.PATH || '').split(':').includes(dirname(wrapperPath));
}

function formatSetupStatus(wrapperPath: string): string {
  const status = wrapperStatus(wrapperPath);
  const pathStatus = localBinIsInPath(wrapperPath)
    ? '$HOME/.local/bin is already on PATH.'
    : 'Add $HOME/.local/bin to PATH before the real pi binary if this wrapper is not found.';

  return [
    `${getDetectedShellName()} detected.`,
    '',
    `Wrapper path: ${formatHomePath(wrapperPath)}`,
    `Status: ${status}`,
    '',
    status === 'installed'
      ? 'The pi --last wrapper is installed.'
      : status === 'unmanaged'
        ? 'An unmanaged pi file already exists at the wrapper path. It will not be overwritten.'
        : 'Install the smart-sessions pi wrapper at the path above.',
    '',
    pathStatus,
  ].join('\n');
}

function installSmartSessionWrapper(wrapperPath: string): void {
  const status = wrapperStatus(wrapperPath);
  if (status === 'unmanaged') {
    throw new Error(`Refusing to overwrite unmanaged file: ${wrapperPath}`);
  }
  mkdirSync(dirname(wrapperPath), { recursive: true });
  writeTextFileAtomic(wrapperPath, buildSmartSessionShim());
  chmodSync(wrapperPath, 0o755);
}

function currentShimEnvIsFresh(): boolean {
  return (
    process.env[SHIM_VERSION_ENV] === SMART_SESSION_SHIM_VERSION &&
    process.env[SHIM_TARGET_ENV] === getBundledSmartSessionScriptPath() &&
    process.env[WRAPPER_SHA_ENV] === getBundledSmartSessionScriptSha256() &&
    !process.env[SHIM_TARGET_MISSING_ENV]
  );
}

function processWasLaunchedByLegacyManagedWrapper(): boolean {
  if (process.env[SHIM_VERSION_ENV]) return false;
  const wrapperRunId = sanitizeResumeRunId(process.env[RESUME_RUN_ID_ENV]);
  return Boolean(
    wrapperRunId && (!generatedResumeRunIdInUse || wrapperRunId !== generatedResumeRunId),
  );
}

function maybeRefreshSmartSessionShim(ctx: ExtensionContext): boolean {
  const sawShimEnv = Boolean(process.env[SHIM_VERSION_ENV]);
  if (!sawShimEnv && !processWasLaunchedByLegacyManagedWrapper()) return false;
  if (currentShimEnvIsFresh()) return true;

  const wrapperPath = getInstalledSmartSessionWrapperPath();
  if (wrapperStatus(wrapperPath) !== 'installed') return false;

  try {
    installSmartSessionWrapper(wrapperPath);
    ctx.ui.notify(
      `Updated smart-sessions pi wrapper at ${formatHomePath(wrapperPath)} for future runs.`,
      'info',
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Could not update smart-sessions pi wrapper: ${message}`, 'error');
  }

  return true;
}

async function runSmartSessionsSetup(ctx: ExtensionCommandContext): Promise<void> {
  const wrapperPath = getInstalledSmartSessionWrapperPath();

  while (true) {
    const status = wrapperStatus(wrapperPath);
    const choices =
      status === 'installed'
        ? ['Check again', 'Exit']
        : ['Install it for me', 'Check again', 'Exit'];
    const choice = await ctx.ui.select(formatSetupStatus(wrapperPath), choices);

    if (choice === 'Install it for me') {
      try {
        installSmartSessionWrapper(wrapperPath);
        ctx.ui.notify(
          `Installed smart-sessions pi wrapper at ${formatHomePath(wrapperPath)}.`,
          'info',
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, 'error');
      }
      continue;
    }

    if (choice === 'Check again') continue;
    return;
  }
}

function getBestKnownSessionTitle(ctx: ExtensionContext, currentSessionName?: string): string {
  const existing = currentSessionName?.trim();
  if (existing) return existing;

  const sidecar = readRollingSummarySidecar(ctx.sessionManager.getSessionId());
  if (sidecar.current?.longTitle) return sidecar.current.longTitle;
  return 'Untitled session';
}

function writeResumeHint(ctx: ExtensionContext, currentSessionName?: string): void {
  if (!hasTui(ctx)) return;

  try {
    const sessionId = sanitizeHintField(ctx.sessionManager.getSessionId());
    if (!sessionId) return;

    const updatedAtMs = String(Date.now());
    const cwd = sanitizeHintField(ctx.cwd);
    const title = sanitizeHintField(getBestKnownSessionTitle(ctx, currentSessionName));
    writeTextFileAtomic(getResumeHintPath(), `${sessionId}\t${updatedAtMs}\t${cwd}\t${title}\n`);
  } catch {
    // Resume hints are best-effort and must never disrupt the session.
  }
}

function maybeShowWrapperSetupTip(ctx: ExtensionContext): void {
  if (!hasTui(ctx)) return;
  if (process.env[SHIM_VERSION_ENV]) return;
  const wrapperRunId = sanitizeResumeRunId(process.env[RESUME_RUN_ID_ENV]);
  if (wrapperRunId && (!generatedResumeRunIdInUse || wrapperRunId !== generatedResumeRunId)) return;

  try {
    const noticePath = getWrapperNoticePath();
    if (existsSync(noticePath)) return;
    writeTextFileAtomic(noticePath, `${new Date().toISOString()}\n`);
    ctx.ui.notify('Tip: enable `pi --last` resume handoff with /smart-sessions-setup', 'info');
  } catch {
    // Ignore notice bookkeeping failures.
  }
}

async function renameTmuxWindow(pi: ExtensionAPI, name: string): Promise<boolean> {
  if (!process.env.TMUX) return false;

  try {
    const pane = process.env.TMUX_PANE?.trim();
    let target: string | undefined;

    if (pane) {
      const result = await pi.exec('tmux', ['display-message', '-p', '-t', pane, '#{window_id}']);
      if (result.code === 0) {
        target = result.stdout?.trim() || undefined;
      }
    }

    const args = target ? ['rename-window', '-t', target, name] : ['rename-window', name];
    const result = await pi.exec('tmux', args);
    return result.code === 0;
  } catch {
    return false;
  }
}

async function renameZellijTab(pi: ExtensionAPI, name: string): Promise<boolean> {
  if (!process.env.ZELLIJ) return false;

  try {
    const result = await pi.exec('zellij', ['action', 'rename-tab', name]);
    return result.code === 0;
  } catch {
    return false;
  }
}

function renameTerminalTitle(name: string): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(`\x1b]0;${name}\x07`);
}

function herdrPaneTitleTarget(): { socketPath: string; paneId: string } | undefined {
  if (process.env.HERDR_ENV !== '1') return undefined;

  const socketPath = process.env.HERDR_SOCKET_PATH?.trim();
  const paneId = process.env.HERDR_PANE_ID?.trim();
  if (!socketPath || !paneId) return undefined;

  return { socketPath, paneId };
}

function nextHerdrTitleSeq(): number {
  herdrTitleSeq += 1;
  return herdrTitleSeq;
}

function sendHerdrPaneRequest(socketPath: string, request: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let done = false;
    let socket: ReturnType<typeof createConnection> | undefined;
    let responseBuffer = '';
    const finish = (response?: unknown) => {
      if (done) return;

      done = true;
      socket?.destroy();
      resolve(response);
    };

    try {
      socket = createConnection(socketPath);
    } catch {
      finish();
      return;
    }

    socket.on('error', finish);
    socket.on('connect', () => socket?.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (data) => {
      responseBuffer += data.toString();
      const lineEnd = responseBuffer.indexOf('\n');
      if (lineEnd === -1) return;

      const line = responseBuffer.slice(0, lineEnd).trim();
      try {
        finish(JSON.parse(line) as unknown);
      } catch {
        finish();
      }
    });
    socket.on('end', finish);
    const timeout = setTimeout(finish, 500);
    timeout.unref?.();
  });
}

function getHerdrAgentLookup(response: unknown): { ok: true; name?: string } | { ok: false } {
  if (!response || typeof response !== 'object' || 'error' in response) return { ok: false };

  const result = (response as { result?: unknown }).result;
  if (!result || typeof result !== 'object' || !('agent' in result)) return { ok: false };

  const agent = (result as { agent?: unknown }).agent;
  if (!agent || typeof agent !== 'object') return { ok: false };

  const name = (agent as { name?: unknown }).name;
  if (typeof name !== 'string') return { ok: true };

  const trimmed = name.trim();
  return trimmed ? { ok: true, name: trimmed } : { ok: true };
}

async function maybeRenameHerdrAgent(
  socketPath: string,
  paneId: string,
  name: string,
): Promise<void> {
  const key = `${socketPath}:${paneId}`;
  if (herdrAgentRenameInFlight.has(key)) return;

  herdrAgentRenameInFlight.add(key);
  try {
    const current = await sendHerdrPaneRequest(socketPath, {
      id: `${HERDR_TITLE_SOURCE}:agent-get:${nextHerdrTitleSeq()}`,
      method: 'agent.get',
      params: { target: paneId },
    });

    const lookup = getHerdrAgentLookup(current);
    if (!lookup.ok || lookup.name) return;

    await sendHerdrPaneRequest(socketPath, {
      id: `${HERDR_TITLE_SOURCE}:agent-rename:${nextHerdrTitleSeq()}`,
      method: 'agent.rename',
      params: {
        target: paneId,
        name,
      },
    });
  } catch {
    // Herdr naming is best-effort and should never disrupt the Pi session.
  } finally {
    herdrAgentRenameInFlight.delete(key);
  }
}

function reportHerdrPanePresentation(options: {
  title: string;
  displayAgent: string;
  agentName?: string | null;
}): void {
  const target = herdrPaneTitleTarget();
  if (!target) return;

  const agentName = options.agentName?.trim();
  if (agentName) {
    void maybeRenameHerdrAgent(target.socketPath, target.paneId, agentName).catch(() => {});
  }

  const seq = nextHerdrTitleSeq();
  void sendHerdrPaneRequest(target.socketPath, {
    id: `${HERDR_TITLE_SOURCE}:${seq}`,
    method: 'pane.report_metadata',
    params: {
      pane_id: target.paneId,
      source: HERDR_TITLE_SOURCE,
      applies_to_source: HERDR_PI_SOURCE,
      title: options.title,
      display_agent: options.displayAgent,
      seq,
    },
  });
}

async function applyWindowName(
  pi: ExtensionAPI,
  name: string,
  herdr?: { title?: string; displayAgent?: string; agentName?: string | null },
): Promise<void> {
  reportHerdrPanePresentation({
    title: herdr?.title ?? name,
    displayAgent: herdr?.displayAgent ?? name,
    agentName: herdr?.agentName,
  });
  if (await renameTmuxWindow(pi, name)) return;
  if (await renameZellijTab(pi, name)) return;
  renameTerminalTitle(name);
}

function getStoredWindowName(entries: unknown[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as {
      type?: string;
      customType?: string;
      data?: { windowName?: unknown };
    };

    if (entry.type === 'custom' && entry.customType === ENTRY_TYPE_WINDOW) {
      const candidate = typeof entry.data?.windowName === 'string' ? entry.data.windowName : '';
      return compactName(candidate, WINDOW_TITLE_MAX_WORDS);
    }
  }

  return undefined;
}

function clearInlineSummaryWidget(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(INLINE_SUMMARY_WIDGET_KEY, undefined);
}

function showInlineSummaryWidget(ctx: ExtensionContext, summary: RollingSessionSummary) {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(INLINE_SUMMARY_WIDGET_KEY, () => ({
    render(width: number) {
      return formatInlineRollingSummary(summary, width);
    },
    invalidate() {},
  }));
}

class SummaryComponent implements Component {
  private scrollOffset = 0;
  private viewportHeight = 0;
  private totalLines = 0;
  private cachedWidth?: number;
  private cachedRender?: string[];
  private markdown: Markdown;

  constructor(
    private readonly summary: RollingSessionSummary,
    private readonly tui: TUI,
    private readonly onDone: () => void,
  ) {
    this.markdown = new Markdown(
      formatRollingSummaryMarkdown(summary),
      0,
      0,
      SUMMARY_MARKDOWN_THEME,
    );
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRender = undefined;
    this.markdown = new Markdown(
      formatRollingSummaryMarkdown(this.summary),
      0,
      0,
      SUMMARY_MARKDOWN_THEME,
    );
  }

  private dim(value: string): string {
    return `\x1b[2m${value}\x1b[0m`;
  }

  private bold(value: string): string {
    return `\x1b[1m${value}\x1b[0m`;
  }

  private cyan(value: string): string {
    return `\x1b[36m${value}\x1b[0m`;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')) || data === 'q') {
      this.onDone();
      return;
    }

    const maxScroll = Math.max(0, this.totalLines - this.viewportHeight);

    if (matchesKey(data, Key.up)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (matchesKey(data, Key.down)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - Math.max(1, this.viewportHeight - 1));
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = Math.min(
        maxScroll,
        this.scrollOffset + Math.max(1, this.viewportHeight - 1),
      );
    } else {
      return;
    }

    this.cachedWidth = undefined;
    this.cachedRender = undefined;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedRender && this.cachedWidth === width) return this.cachedRender;

    const boxWidth = Math.max(20, Math.min(width, 120));
    const innerWidth = Math.max(20, boxWidth - 4);
    const hz = (count: number) => '─'.repeat(Math.max(0, count));
    const bodyLines = this.markdown.render(innerWidth);
    const terminalRows = this.tui.terminal?.rows ?? 24;

    this.totalLines = bodyLines.length;
    this.viewportHeight = Math.max(
      8,
      Math.min(Math.max(1, bodyLines.length), Math.max(8, terminalRows - 8)),
    );
    const maxScroll = Math.max(0, this.totalLines - this.viewportHeight);
    this.scrollOffset = Math.min(this.scrollOffset, maxScroll);

    const visibleLines = bodyLines.slice(
      this.scrollOffset,
      this.scrollOffset + this.viewportHeight,
    );
    while (visibleLines.length < this.viewportHeight) {
      visibleLines.push('');
    }

    const frameLine = (line: string): string => {
      const truncated = truncateToWidth(line, innerWidth);
      const padding = Math.max(0, innerWidth - visibleWidth(truncated));
      return this.dim('│') + ' ' + truncated + ' '.repeat(padding) + ' ' + this.dim('│');
    };

    const scrollInfo =
      this.totalLines > this.viewportHeight
        ? this.dim(
            ` (${this.scrollOffset + 1}-${Math.min(this.totalLines, this.scrollOffset + this.viewportHeight)}/${this.totalLines})`,
          )
        : '';

    const output = [
      this.dim(`╭${hz(boxWidth - 2)}╮`),
      frameLine(this.bold(this.cyan('Session Summary')) + scrollInfo),
      this.dim(`├${hz(boxWidth - 2)}┤`),
      ...visibleLines.map((line) => frameLine(line)),
      this.dim(`├${hz(boxWidth - 2)}┤`),
      frameLine(
        `${this.dim('↑/↓')} scroll · ${this.dim('PgUp/PgDn')} page · ${this.dim('Esc/q')} close`,
      ),
      this.dim(`╰${hz(boxWidth - 2)}╯`),
    ];

    this.cachedWidth = width;
    this.cachedRender = output;
    return output;
  }
}

export default function smartSessionsExtension(pi: ExtensionAPI) {
  if (isDisabled()) return;

  let forceRefresh = false;
  let refreshInFlight: Promise<RefreshSummaryResult> | null = null;
  const backgroundSummary: BackgroundSummaryState = {
    currentRunStartedAt: null,
    currentRunTurns: 0,
    accumulatedWorkMs: 0,
    accumulatedTurns: 0,
    timer: null,
    fallbackTimer: null,
    abort: null,
  };

  function resetSummaryWork(): void {
    backgroundSummary.accumulatedWorkMs = 0;
    backgroundSummary.accumulatedTurns = 0;
  }

  function cancelBackgroundSummary(): void {
    if (backgroundSummary.timer) {
      clearTimeout(backgroundSummary.timer);
      backgroundSummary.timer = null;
    }
    if (backgroundSummary.fallbackTimer) {
      clearTimeout(backgroundSummary.fallbackTimer);
      backgroundSummary.fallbackTimer = null;
    }
    if (backgroundSummary.abort) {
      backgroundSummary.abort.abort();
      backgroundSummary.abort = null;
    }
  }

  function startBackgroundSummaryRun(): void {
    backgroundSummary.currentRunStartedAt = Date.now();
    backgroundSummary.currentRunTurns = 0;
  }

  function noteBackgroundSummaryTurn(): void {
    if (backgroundSummary.currentRunStartedAt == null) return;
    backgroundSummary.currentRunTurns += 1;
  }

  function finishBackgroundSummaryRun(): { durationMs: number; turns: number } {
    const durationMs =
      backgroundSummary.currentRunStartedAt == null
        ? 0
        : Math.max(0, Date.now() - backgroundSummary.currentRunStartedAt);
    const turns = backgroundSummary.currentRunTurns;

    backgroundSummary.currentRunStartedAt = null;
    backgroundSummary.currentRunTurns = 0;
    backgroundSummary.accumulatedWorkMs += durationMs;
    backgroundSummary.accumulatedTurns += turns;

    return { durationMs, turns };
  }

  async function applySummaryNames(
    ctx: ExtensionContext,
    summary: RollingSessionSummary,
  ): Promise<void> {
    pi.setSessionName(summary.longTitle);
    if (getStoredWindowName(ctx.sessionManager.getBranch()) !== summary.shortTitle) {
      pi.appendEntry(ENTRY_TYPE_WINDOW, { windowName: summary.shortTitle });
    }
    await applyWindowName(pi, summary.shortTitle, {
      title: summary.longTitle,
      displayAgent: summary.shortTitle,
      agentName: ctx.sessionManager.getLeafId(),
    });
    writeResumeHint(ctx, summary.longTitle);
  }

  function getApplicableSummary(ctx: ExtensionContext): RollingSessionSummary | undefined {
    const snapshot = buildConversationSnapshot(ctx.sessionManager.getBranch());
    if (!snapshot) return undefined;

    const sidecar = readRollingSummarySidecar(ctx.sessionManager.getSessionId());
    if (!sidecar.current) return undefined;
    return sidecar.current.conversationHash === snapshot.conversationHash
      ? sidecar.current
      : undefined;
  }

  async function restoreNamesFromState(ctx: ExtensionContext): Promise<void> {
    const applicable = getApplicableSummary(ctx);
    const hasStaleSidecar =
      !!readRollingSummarySidecar(ctx.sessionManager.getSessionId()).current && !applicable;
    const shortTitle = hasStaleSidecar
      ? undefined
      : (applicable?.shortTitle ?? getStoredWindowName(ctx.sessionManager.getBranch()));
    const longTitle = applicable?.longTitle ?? pi.getSessionName();

    if (longTitle) {
      pi.setSessionName(longTitle);
    }
    if (shortTitle) {
      await applyWindowName(pi, shortTitle, {
        title: longTitle ?? shortTitle,
        displayAgent: shortTitle,
        agentName: ctx.sessionManager.getLeafId(),
      });
    }
    writeResumeHint(ctx, longTitle);
  }

  async function refreshSummary(
    ctx: ExtensionContext,
    reason: RefreshReason,
    externalSignal?: AbortSignal,
  ): Promise<RefreshSummaryResult> {
    const sessionId = ctx.sessionManager.getSessionId();
    const sidecar = readRollingSummarySidecar(sessionId);
    const input = buildRollingSummaryInput(ctx.sessionManager.getBranch(), {
      previousCheckpointEntryId: sidecar.current?.checkpointEntryId,
    });
    const forceHardRebuild = (sidecar.current?.rewriteCount ?? 0) >= MAX_ROLLING_REWRITE_COUNT;
    const generatedAtMs = sidecar.current?.generatedAt
      ? Date.parse(sidecar.current.generatedAt)
      : NaN;
    const elapsedSincePreviousSummaryMs = Number.isFinite(generatedAtMs)
      ? Math.max(0, Date.now() - generatedAtMs)
      : null;

    if (!input.snapshot) {
      return { ok: false, reason: 'no conversation to summarize' };
    }

    if (
      !forceHardRebuild &&
      !input.freshConversation &&
      sidecar.current &&
      sidecar.current.conversationHash === input.snapshot.conversationHash
    ) {
      return { ok: true, result: sidecar.current };
    }

    const result = await generateRollingSummary(
      ctx,
      {
        previousSummary:
          forceHardRebuild || input.mode === 'rebuild'
            ? ''
            : sidecar.current
              ? JSON.stringify(sidecar.current, null, 2)
              : '',
        freshConversation:
          forceHardRebuild || input.mode === 'rebuild'
            ? input.snapshot.conversation
            : input.freshConversation || input.snapshot.conversation,
        mode: forceHardRebuild ? 'rebuild' : input.mode,
        metadata: {
          sessionId,
          currentShortTitle: sidecar.current?.shortTitle ?? null,
          currentLongTitle: sidecar.current?.longTitle ?? null,
          freshMessageCount:
            forceHardRebuild || input.mode === 'rebuild'
              ? input.snapshot.messageCount
              : input.freshMessageCount,
          totalMessageCount: input.snapshot.messageCount,
          elapsedSincePreviousSummaryMs,
          isFirstSummary: !sidecar.current,
        },
      },
      externalSignal,
    );

    if (!result.ok) {
      return result;
    }

    const summary: RollingSessionSummary = {
      ...result.result,
      rewriteCount:
        forceHardRebuild || input.mode === 'rebuild' ? 0 : (sidecar.current?.rewriteCount ?? 0) + 1,
      checkpointEntryId: input.checkpointEntryId ?? input.snapshot.lastMessageEntryId ?? 'entry-0',
      conversationHash: input.snapshot.conversationHash,
      generatedAt: new Date().toISOString(),
    };

    writeRollingSummaryCurrent(sessionId, summary);
    if (reason !== 'background') {
      resetSummaryWork();
    }
    return { ok: true, result: summary };
  }

  async function showSummaryOverlay(ctx: ExtensionContext, summary: RollingSessionSummary) {
    if (!ctx.hasUI) return;

    await ctx.ui.custom<void>(
      (tui, _theme, _kb, done) => new SummaryComponent(summary, tui, () => done(undefined)),
      { overlay: true },
    );
  }

  function showInlineSummaryWidgetFromApplicableState(ctx: ExtensionContext): void {
    const summary = getApplicableSummary(ctx);
    if (!summary) return;
    showInlineSummaryWidget(ctx, summary);
  }

  function queueExitSummary(ctx: ExtensionContext) {
    if (!ctx.hasUI || !process.stdout.isTTY) {
      clearPendingExitSummary();
      return;
    }

    const sessionId = ctx.sessionManager.getSessionId();
    const title = getBestKnownSessionTitle(ctx, pi.getSessionName());
    setPendingExitSummary(formatExitSummary(title, sessionId));
  }

  async function maybeRefreshBeforeAgentStart(ctx: ExtensionContext): Promise<void> {
    const applicable = getApplicableSummary(ctx);
    if (applicable && !forceRefresh) {
      await applySummaryNames(ctx, applicable);
      return;
    }

    refreshInFlight = refreshSummary(ctx, 'auto');
    const result = await refreshInFlight;
    refreshInFlight = null;

    if (result.ok) {
      forceRefresh = false;
      await applySummaryNames(ctx, result.result);
    }
  }

  async function prepareCommandContext(ctx: ExtensionCommandContext): Promise<boolean> {
    clearInlineSummaryWidget(ctx);
    cancelBackgroundSummary();
    await ctx.waitForIdle();
    if (refreshInFlight) {
      await refreshInFlight;
    }

    return !!buildConversationSnapshot(ctx.sessionManager.getBranch());
  }

  async function runBackgroundSummary(ctx: ExtensionContext): Promise<void> {
    if (backgroundSummary.abort) return;
    if (refreshInFlight) {
      await refreshInFlight;
    }

    const applicable = getApplicableSummary(ctx);
    if (applicable) {
      resetSummaryWork();
      showInlineSummaryWidget(ctx, applicable);
      return;
    }

    const controller = new AbortController();
    backgroundSummary.abort = controller;

    try {
      refreshInFlight = refreshSummary(ctx, 'background', controller.signal);
      const result = await refreshInFlight;
      if (result.ok) {
        resetSummaryWork();
        showInlineSummaryWidget(ctx, result.result);
      }
    } finally {
      refreshInFlight = null;
      backgroundSummary.abort = null;
    }
  }

  function scheduleBackgroundSummary(ctx: ExtensionContext) {
    if (
      backgroundSummary.accumulatedWorkMs < AUTO_SUMMARY_MIN_WORK_MS ||
      backgroundSummary.accumulatedTurns < AUTO_SUMMARY_MIN_TURNS
    ) {
      return;
    }

    cancelBackgroundSummary();

    backgroundSummary.timer = setTimeout(() => {
      backgroundSummary.timer = null;
      void runBackgroundSummary(ctx);
    }, AUTO_SUMMARY_IDLE_MS);

    backgroundSummary.fallbackTimer = setTimeout(() => {
      backgroundSummary.fallbackTimer = null;
      void runBackgroundSummary(ctx);
    }, AUTO_SUMMARY_FALLBACK_IDLE_MS);
  }

  // Smart-sessions exists to rename terminal/tmux/zellij windows, render the
  // inline summary widget, and drive a background LLM summarizer whose output
  // is only ever shown in a UI. In print/RPC mode (hasUI === false) every
  // handler becomes a no-op; /rename and /summarize commands stay registered
  // below for explicit invocation.
  pi.on('session_start', async (event, ctx) => {
    if (!hasTui(ctx)) return;
    clearPendingExitSummary();
    cancelBackgroundSummary();
    clearInlineSummaryWidget(ctx);
    writeResumeHint(ctx, pi.getSessionName());
    const wrapperShimSeen = maybeRefreshSmartSessionShim(ctx);
    if (!wrapperShimSeen) maybeShowWrapperSetupTip(ctx);

    if (event.reason === 'fork') {
      forceRefresh = true;
      return;
    }

    forceRefresh = false;
    await restoreNamesFromState(ctx);
    showInlineSummaryWidgetFromApplicableState(ctx);
  });

  pi.on('before_agent_start', async (_event, ctx) => {
    if (!hasTui(ctx)) return;
    clearInlineSummaryWidget(ctx);
    cancelBackgroundSummary();
    void maybeRefreshBeforeAgentStart(ctx);
  });

  pi.on('agent_start', async (_event, ctx) => {
    if (!hasTui(ctx)) return;
    clearInlineSummaryWidget(ctx);
    cancelBackgroundSummary();
    startBackgroundSummaryRun();
  });

  pi.on('turn_end', async (_event, ctx) => {
    if (!hasTui(ctx)) return;
    noteBackgroundSummaryTurn();
  });

  pi.on('agent_end', async (_event, ctx) => {
    if (!hasTui(ctx)) return;
    finishBackgroundSummaryRun();
    scheduleBackgroundSummary(ctx);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    if (!hasTui(ctx)) return;
    cancelBackgroundSummary();
    writeResumeHint(ctx, pi.getSessionName());
    queueExitSummary(ctx);
  });

  pi.registerCommand('rename', {
    description: 'Rename session from the rolling summary context',
    handler: async (_args, ctx) => {
      if (!(await prepareCommandContext(ctx))) {
        if (ctx.hasUI) ctx.ui.notify('No conversation to summarize', 'error');
        return;
      }

      const result = await refreshSummary(ctx, 'rename');
      if (!result.ok) {
        if (ctx.hasUI) ctx.ui.notify(`Rename failed: ${result.reason}`, 'error');
        return;
      }

      await applySummaryNames(ctx, result.result);
      if (ctx.hasUI) ctx.ui.notify(`Renamed: ${result.result.longTitle}`, 'info');
    },
  });

  pi.registerCommand('summarize', {
    description: 'Show the rolling summary of the current session',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        return;
      }

      if (!(await prepareCommandContext(ctx))) {
        ctx.ui.notify('No conversation to summarize', 'error');
        return;
      }

      const current = getApplicableSummary(ctx);
      if (current) {
        await applySummaryNames(ctx, current);
        await showSummaryOverlay(ctx, current);
        return;
      }

      type LoaderResult =
        | { kind: 'ok'; result: RollingSessionSummary }
        | { kind: 'cancelled' }
        | { kind: 'error'; reason: string };

      const loaderResult = await ctx.ui.custom<LoaderResult>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, 'Generating session summary...');
        let settled = false;

        const finish = (result: LoaderResult) => {
          if (settled) return;
          settled = true;
          done(result);
        };

        loader.onAbort = () => finish({ kind: 'cancelled' });

        void refreshSummary(ctx, 'manual', loader.signal)
          .then((result) => {
            if (result.ok) {
              finish({ kind: 'ok', result: result.result });
              return;
            }

            if (result.reason === 'cancelled') {
              finish({ kind: 'cancelled' });
            } else {
              finish({ kind: 'error', reason: result.reason });
            }
          })
          .catch(() => finish({ kind: 'error', reason: 'unexpected error' }));

        return loader;
      });

      if (loaderResult.kind === 'cancelled') {
        ctx.ui.notify('Summary cancelled', 'info');
        return;
      }

      if (loaderResult.kind === 'error') {
        ctx.ui.notify(`Summary failed: ${loaderResult.reason}`, 'error');
        return;
      }

      await applySummaryNames(ctx, loaderResult.result);
      await showSummaryOverlay(ctx, loaderResult.result);
    },
  });

  pi.registerCommand('smart-sessions-setup', {
    description: 'Show the zsh wrapper for pi --last resume handoff',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      await runSmartSessionsSetup(ctx);
    },
  });
}
