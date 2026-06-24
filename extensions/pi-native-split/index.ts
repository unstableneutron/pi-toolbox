import { complete, type Message } from '@earendil-works/pi-ai/compat';
import {
  BorderedLoader,
  SessionManager,
  SessionSelectorComponent,
  UserMessageSelectorComponent,
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasTui } from '../shared/ui-mode';

const GHOSTTY_SPLIT_SCRIPT = `on run argv
	set targetCwd to item 1 of argv
	set startupInput to item 2 of argv
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to targetCwd
		set initial input of cfg to startupInput
		if (count of windows) > 0 then
			try
				set frontWindow to front window
				set targetTerminal to focused terminal of selected tab of frontWindow
				split targetTerminal direction right with configuration cfg
			on error
				new window with configuration cfg
			end try
		else
			new window with configuration cfg
		end if
		activate
	end tell
end run`;

const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

export type SupportedTerminal = 'ghostty' | 'kitty' | 'herdr';

const EMPTY_LAUNCH_VALUE = '__PI_NATIVE_SPLIT_EMPTY__';
const SPLIT_MARKER_ENV = 'PI_NATIVE_SPLIT_MARKER_FILE';
const SPLIT_MARKER_PREFIX = 'pi-native-split';
const CHILD_MARKER_NOTIFY_DELAY_MS = 100;
// Match Herdr's MOBILE_WIDTH_THRESHOLD from src/ui/mobile.rs.
const HERDR_MOBILE_WIDTH_THRESHOLD = 64;

type SplitMarkerKind = 'split-fork' | 'split-handoff';
type SplitPromptKind = 'raw' | 'handoff' | 'none';
type SplitMarkerSide = 'parent' | 'child';

type NativeSplitDetails = {
  terminal: SupportedTerminal;
  parent?: { pane?: string; workspace?: string; window?: string };
  child?: {
    pane?: string;
    window?: string;
    target?: 'pane' | 'tab';
    pid?: string;
    listenOn?: string;
    socket?: string;
  };
};

type SplitMarkerData = {
  v: 1;
  id: string;
  side: SplitMarkerSide;
  kind: SplitMarkerKind;
  at: string;
  parent: { id: string; file?: string; leaf: string | null };
  child: { id: string; file: string };
  prompt: SplitPromptKind;
  native?: NativeSplitDetails;
};

type CreatedSplitSession = {
  manager: SessionManager;
  file: string;
  id: string;
  parentSessionFile?: string;
  parentSessionId: string;
  sourceLeafId: string | null;
};

type PendingParentMarker = { customType: string; data: SplitMarkerData };
type SplitMarkerSeed = PendingParentMarker;

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatSplitMarkerCustomType(kind: SplitMarkerKind, childSessionId: string): string {
  return `${SPLIT_MARKER_PREFIX}.${kind}.${childSessionId}`;
}

function hasObjectKeys(value: object): boolean {
  return Object.keys(value).length > 0;
}

function materializeSessionFile(manager: SessionManager, sessionFile: string): void {
  const header = manager.getHeader();
  if (!header) {
    throw new Error('Cannot materialize session without a header');
  }

  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  const records = [header, ...manager.getEntries()];
  fs.writeFileSync(sessionFile, `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`, {
    flag: 'w',
  });
}

function buildNativeDetails(
  terminal: SupportedTerminal,
  env: NodeJS.ProcessEnv,
): NativeSplitDetails {
  if (terminal === 'kitty') {
    const parent: NativeSplitDetails['parent'] = {};
    if (env.KITTY_WINDOW_ID) parent.window = env.KITTY_WINDOW_ID;
    return { terminal, parent: hasObjectKeys(parent) ? parent : undefined };
  }

  if (terminal === 'herdr') {
    const parent: NativeSplitDetails['parent'] = {};
    if (env.HERDR_PANE_ID) parent.pane = env.HERDR_PANE_ID;
    if (env.HERDR_WORKSPACE_ID) parent.workspace = env.HERDR_WORKSPACE_ID;
    return { terminal, parent: hasObjectKeys(parent) ? parent : undefined };
  }

  return { terminal };
}

function getKittyChildWindowId(stdout: string | undefined): string | undefined {
  const trimmed = stdout?.trim();
  return trimmed && /^\d+$/.test(trimmed) ? trimmed : undefined;
}

function augmentNativeWithChildEnv(
  native: NativeSplitDetails | undefined,
  env: NodeJS.ProcessEnv,
): NativeSplitDetails | undefined {
  const terminal = native?.terminal ?? detectTerminal(env);
  if (!terminal) return native;

  if (terminal === 'kitty') {
    return {
      ...native,
      terminal,
      child: {
        ...native?.child,
        ...(env.KITTY_WINDOW_ID ? { window: env.KITTY_WINDOW_ID } : {}),
        ...(env.KITTY_PID ? { pid: env.KITTY_PID } : {}),
        ...(env.KITTY_LISTEN_ON ? { listenOn: env.KITTY_LISTEN_ON } : {}),
      },
    };
  }

  if (terminal === 'herdr') {
    return {
      ...native,
      terminal,
      child: {
        ...native?.child,
        ...(env.HERDR_PANE_ID ? { pane: env.HERDR_PANE_ID } : {}),
        ...(env.HERDR_SOCKET_PATH ? { socket: env.HERDR_SOCKET_PATH } : {}),
      },
    };
  }

  return { ...native, terminal };
}

function augmentParentMarkerFromLaunchResult(
  terminal: SupportedTerminal,
  marker: PendingParentMarker | undefined,
  result: LaunchResult,
): void {
  if (!marker || result.code !== 0 || terminal !== 'kitty') return;

  const window = getKittyChildWindowId(result.stdout);
  if (!window) return;

  marker.data.native = {
    ...marker.data.native,
    terminal,
    child: { ...marker.data.native?.child, window },
  };
}

function createSplitMarkerPair(
  session: CreatedSplitSession,
  kind: SplitMarkerKind,
  prompt: SplitPromptKind,
  native: NativeSplitDetails | undefined,
): { customType: string; parent: SplitMarkerData; child: SplitMarkerData } {
  const id = randomUUID();
  const at = new Date().toISOString();
  const customType = formatSplitMarkerCustomType(kind, session.id);
  const base = {
    v: 1 as const,
    id,
    kind,
    at,
    parent: {
      id: session.parentSessionId,
      file: session.parentSessionFile,
      leaf: session.sourceLeafId,
    },
    child: {
      id: session.id,
      file: session.file,
    },
    prompt,
    native,
  };

  return {
    customType,
    parent: { ...base, side: 'parent' },
    child: { ...base, side: 'child' },
  };
}

function writeMarkerSeed(seed: SplitMarkerSeed): string {
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-split-marker-'));
  const seedFile = path.join(seedDir, 'marker.json');
  fs.writeFileSync(seedFile, JSON.stringify(seed), 'utf8');
  return seedFile;
}

function formatSplitMarkerLink(data: SplitMarkerData): string {
  if (data.side === 'parent') {
    return `child → ${data.child.id}`;
  }

  return `parent ← ${data.parent.id}`;
}

function formatSplitMarkerNotification(data: SplitMarkerData): string {
  const terminal = data.native?.terminal ?? 'native';
  return `⇄ ${data.kind} via ${terminal}\n${formatSplitMarkerLink(data)}`;
}

function formatSplitMarkerLabel(data: SplitMarkerData): string {
  return `${data.kind} ${formatSplitMarkerLink(data)}`;
}

function getSplitMarkerLabelTarget(
  ctx: Pick<ExtensionContext, 'sessionManager'>,
  data: SplitMarkerData,
): string | undefined {
  const sourceLeafId = getNearestSplitSourceEntryId(ctx, data.parent.leaf);
  if (sourceLeafId) return sourceLeafId;

  return ctx.sessionManager.getLeafId?.() ?? undefined;
}

function labelSplitMarker(
  pi: ExtensionAPI,
  ctx: Pick<ExtensionContext, 'sessionManager'>,
  data: SplitMarkerData,
): void {
  const targetId = getSplitMarkerLabelTarget(ctx, data);
  if (!targetId || ctx.sessionManager.getLabel?.(targetId)) return;

  pi.setLabel(targetId, formatSplitMarkerLabel(data));
}

function notifySplitMarker(
  ctx: Pick<ExtensionContext, 'hasUI' | 'ui'>,
  data: SplitMarkerData,
): void {
  if (!ctx.hasUI) return;
  ctx.ui.notify(formatSplitMarkerNotification(data), 'info');
}

function readMarkerSeed(seedFile: string): SplitMarkerSeed | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(seedFile, 'utf8')) as SplitMarkerSeed;
    if (!parsed?.customType || !parsed?.data) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function cleanupTempPath(tempFile: string | undefined): void {
  if (!tempFile || tempFile === EMPTY_LAUNCH_VALUE) return;

  try {
    fs.rmSync(path.dirname(tempFile), { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
}

function installChildMarkerHandler(pi: ExtensionAPI, env: NodeJS.ProcessEnv): void {
  const markerFile = env[SPLIT_MARKER_ENV];
  if (!markerFile) return;

  let notifyTimer: ReturnType<typeof setTimeout> | undefined;
  const clearNotifyTimer = (): void => {
    if (!notifyTimer) return;
    clearTimeout(notifyTimer);
    notifyTimer = undefined;
  };

  pi.on?.('session_start', (_event, ctx) => {
    clearNotifyTimer();
    const seed = readMarkerSeed(markerFile);
    cleanupTempPath(markerFile);
    if (!seed) return;

    const data = {
      ...seed.data,
      native: augmentNativeWithChildEnv(seed.data.native, env),
    };
    pi.appendEntry(seed.customType, data);
    labelSplitMarker(pi, ctx, data);
    notifyTimer = setTimeout(() => {
      notifyTimer = undefined;
      notifySplitMarker(ctx, data);
    }, CHILD_MARKER_NOTIFY_DELAY_MS);
  });

  pi.on?.('session_shutdown', () => {
    clearNotifyTimer();
  });
}

function prepareChildMarkerSeed(
  session: CreatedSplitSession,
  customType: string,
  data: SplitMarkerData,
): string {
  materializeSessionFile(session.manager, session.file);
  return writeMarkerSeed({ customType, data });
}

export function detectTerminal(
  env: NodeJS.ProcessEnv = process.env,
): SupportedTerminal | undefined {
  if (env.HERDR_ENV === '1') {
    return 'herdr';
  }

  const termProgram = env.TERM_PROGRAM?.toLowerCase() || '';
  const term = env.TERM?.toLowerCase() || '';

  if (termProgram === 'ghostty' || term.includes('ghostty') || env.GHOSTTY_RESOURCES_DIR) {
    return 'ghostty';
  }

  if (env.KITTY_WINDOW_ID || termProgram === 'kitty') {
    return 'kitty';
  }

  return undefined;
}

export function getLauncherScriptPath(): string {
  return fileURLToPath(new URL('./launcher.sh', import.meta.url));
}

function writePromptFile(prompt: string): string {
  const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-split-'));
  const promptFile = path.join(promptDir, 'prompt.txt');
  fs.writeFileSync(promptFile, prompt, 'utf8');
  return promptFile;
}

export function buildLaunchWrapperArgs(
  cwd: string,
  sessionFile: string | undefined,
  prompt: string,
  markerFile?: string,
): { argv: string[]; promptFile?: string; markerFile?: string } {
  const promptFile = prompt.length > 0 ? writePromptFile(prompt) : undefined;

  return {
    argv: [
      '/bin/sh',
      getLauncherScriptPath(),
      cwd,
      sessionFile ?? EMPTY_LAUNCH_VALUE,
      promptFile ?? EMPTY_LAUNCH_VALUE,
      markerFile ?? EMPTY_LAUNCH_VALUE,
    ],
    promptFile,
    markerFile,
  };
}

function cleanupPromptTempPath(promptFile: string | undefined): void {
  if (!promptFile) return;

  try {
    fs.rmSync(path.dirname(promptFile), { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
}

function formatSessionLaunchHint(file: string): string {
  const fileStem = path.basename(file, '.jsonl');
  const sessionId = fileStem.split('_').at(-1) || fileStem;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const hintTarget = uuidPattern.test(sessionId) ? sessionId : fileStem;
  return `pi --session ${hintTarget}`;
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('');
  }

  return '';
}

export function getUserMessagesForForking(
  ctx: ExtensionCommandContext,
): Array<{ entryId: string; text: string }> {
  const result: Array<{ entryId: string; text: string }> = [];

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== 'message') continue;
    if (entry.message.role !== 'user') continue;

    const text = extractUserMessageText(entry.message.content);
    if (text) {
      result.push({ entryId: entry.id, text });
    }
  }

  return result;
}

function isNonEmptyTextPart(part: unknown): part is { type: 'text'; text: string } {
  if (typeof part !== 'object' || part === null) return false;

  const candidate = part as { type?: unknown; text?: unknown };
  return (
    candidate.type === 'text' &&
    typeof candidate.text === 'string' &&
    candidate.text.trim().length > 0
  );
}

function hasAssistantTextContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;

  return content.some(isNonEmptyTextPart);
}

function isMeaningfulSplitSourceEntry(entry: SessionEntry): boolean {
  if (entry.type !== 'message') return false;

  if (entry.message.role === 'user') return true;
  if (entry.message.role !== 'assistant') return false;

  return hasAssistantTextContent(entry.message.content);
}

export function getNearestSplitSourceEntryId(
  ctx: Pick<ExtensionContext, 'sessionManager'>,
  startEntryId?: string | null,
): string | null {
  let entryId = startEntryId ?? ctx.sessionManager.getLeafId?.() ?? null;
  const visited = new Set<string>();

  while (entryId && !visited.has(entryId)) {
    visited.add(entryId);
    const entry = ctx.sessionManager.getEntry(entryId);
    if (!entry) return null;
    if (isMeaningfulSplitSourceEntry(entry)) return entry.id;
    entryId = entry.parentId ?? null;
  }

  return null;
}

function getParentSessionId(ctx: ExtensionCommandContext): string {
  return ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager.getHeader?.()?.id ?? 'unknown';
}

function createChildSessionDetails(
  ctx: ExtensionCommandContext,
  sourceLeafId: string | null,
): CreatedSplitSession | undefined {
  const parentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
  const parentSessionId = getParentSessionId(ctx);
  const manager = SessionManager.create(ctx.cwd, ctx.sessionManager.getSessionDir());
  const file = manager.newSession({ parentSession: parentSessionFile });
  if (!file) return undefined;

  return {
    manager,
    file,
    id: manager.getSessionId(),
    parentSessionFile,
    parentSessionId,
    sourceLeafId,
  };
}

function openCurrentSessionSnapshot(ctx: ExtensionCommandContext): SessionManager | undefined {
  const sessionFile = ctx.sessionManager.getSessionFile?.();
  if (!sessionFile) return undefined;

  return SessionManager.open(sessionFile, ctx.sessionManager.getSessionDir());
}

function createForkedSessionFromCurrentLeafDetails(
  ctx: ExtensionCommandContext,
): CreatedSplitSession | undefined {
  const snapshot = openCurrentSessionSnapshot(ctx);
  if (!snapshot) return createChildSessionDetails(ctx, null);

  const sourceLeafId = getNearestSplitSourceEntryId({ sessionManager: snapshot });
  if (!sourceLeafId) {
    return createChildSessionDetails(ctx, null);
  }

  const parentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
  const parentSessionId = getParentSessionId(ctx);
  const file = snapshot.createBranchedSession(sourceLeafId);
  if (!file) return undefined;

  return {
    manager: snapshot,
    file,
    id: snapshot.getSessionId(),
    parentSessionFile,
    parentSessionId,
    sourceLeafId,
  };
}

function createForkedSessionDetails(
  ctx: ExtensionCommandContext,
  entryId: string,
): CreatedSplitSession | undefined {
  const selectedEntry = ctx.sessionManager.getEntry(entryId);
  if (!selectedEntry || selectedEntry.type !== 'message' || selectedEntry.message.role !== 'user') {
    return undefined;
  }

  if (!selectedEntry.parentId) {
    return createChildSessionDetails(ctx, null);
  }

  const snapshot = openCurrentSessionSnapshot(ctx);
  if (!snapshot) return undefined;

  const parentSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
  const parentSessionId = getParentSessionId(ctx);
  try {
    const file = snapshot.createBranchedSession(selectedEntry.parentId);
    if (!file) return undefined;

    return {
      manager: snapshot,
      file,
      id: snapshot.getSessionId(),
      parentSessionFile,
      parentSessionId,
      sourceLeafId: selectedEntry.parentId,
    };
  } catch {
    return undefined;
  }
}

export function createForkedSession(
  ctx: ExtensionCommandContext,
  entryId: string,
): string | undefined {
  return createForkedSessionDetails(ctx, entryId)?.file;
}

export async function selectForkEntry(ctx: ExtensionCommandContext): Promise<string | null> {
  const userMessages = getUserMessagesForForking(ctx);
  if (userMessages.length === 0) {
    ctx.ui.notify('No messages to fork from', 'info');
    return null;
  }

  return ctx.ui.custom<string | null>((_tui, _theme, _keybindings, done) => {
    const selector = new UserMessageSelectorComponent(
      userMessages.map((message) => ({ id: message.entryId, text: message.text })),
      (selectedEntryId) => done(selectedEntryId),
      () => done(null),
    );

    const forwardInput = (data: string): void => {
      const messageList = selector.getMessageList?.();
      messageList?.handleInput?.(data);
    };

    return Object.assign(selector, {
      handleInput: forwardInput,
    });
  });
}

export async function selectResumeSession(ctx: ExtensionCommandContext): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, _theme, keybindings, done) => {
    const selector = new SessionSelectorComponent(
      (onProgress) => SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir(), onProgress),
      (onProgress) => SessionManager.listAll(onProgress),
      (sessionPath) => done(sessionPath),
      () => done(null),
      () => done(null),
      () => tui.requestRender(),
      { showRenameHint: false, keybindings },
      ctx.sessionManager.getSessionFile() ?? undefined,
    );

    return selector;
  });
}

export async function generateHandoffPrompt(
  goal: string,
  ctx: ExtensionCommandContext,
): Promise<string | null> {
  if (!ctx.model) {
    ctx.ui.notify('No model selected', 'error');
    return null;
  }

  const branch = ctx.sessionManager.getBranch();
  const messages = branch
    .filter((entry): entry is SessionEntry & { type: 'message' } => entry.type === 'message')
    .map((entry) => entry.message);

  if (messages.length === 0) {
    ctx.ui.notify('No conversation to hand off', 'error');
    return null;
  }

  const llmMessages = convertToLlm(messages);
  const conversationText = serializeConversation(llmMessages);

  const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, 'Generating handoff prompt...');
    loader.onAbort = () => done(null);

    const doGenerate = async (): Promise<string | null> => {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
      if (!auth.ok || !auth.apiKey) {
        throw new Error(auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error);
      }

      const userMessage: Message = {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
          },
        ],
        timestamp: Date.now(),
      };

      const response = await complete(
        ctx.model!,
        { systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [userMessage] },
        { apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
      );

      if (response.stopReason === 'aborted') {
        return null;
      }

      return response.content
        .filter((content): content is { type: 'text'; text: string } => content.type === 'text')
        .map((content) => content.text)
        .join('\n');
    };

    doGenerate()
      .then(done)
      .catch((error) => {
        console.error('Split handoff generation failed:', error);
        done(null);
      });

    return loader;
  });

  return result;
}

async function launchGhostty(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  sessionFile: string | undefined,
  prompt: string,
  env: NodeJS.ProcessEnv,
  beforeRun?: (native: NativeSplitDetails) => string | undefined,
) {
  const markerFile = beforeRun?.(buildNativeDetails('ghostty', env));
  const launch = buildLaunchWrapperArgs(ctx.cwd, sessionFile, prompt, markerFile);
  const startupInput = `${launch.argv.map(shellQuote).join(' ')}\n`;

  try {
    const result = await pi.exec('osascript', [
      '-e',
      GHOSTTY_SPLIT_SCRIPT,
      '--',
      ctx.cwd,
      startupInput,
    ]);

    if (result.code !== 0) {
      cleanupPromptTempPath(launch.promptFile);
      cleanupTempPath(launch.markerFile);
    }

    return result;
  } catch (error) {
    cleanupPromptTempPath(launch.promptFile);
    cleanupTempPath(launch.markerFile);
    throw error;
  }
}

async function launchKitty(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  sessionFile: string | undefined,
  prompt: string,
  env: NodeJS.ProcessEnv,
  beforeRun?: (native: NativeSplitDetails) => string | undefined,
) {
  const shouldLaunchTab = shouldCreateNativeTab(env);
  const markerFile = beforeRun?.({
    ...buildNativeDetails('kitty', env),
    child: { target: shouldLaunchTab ? 'tab' : 'pane' },
  });
  const launch = buildLaunchWrapperArgs(ctx.cwd, sessionFile, prompt, markerFile);
  const shellPath = env.SHELL || process.env.SHELL || '/bin/sh';
  const wrapperCommand = launch.argv.map(shellQuote).join(' ');

  try {
    const result = await pi.exec('kitten', [
      '@',
      'launch',
      '--type',
      shouldLaunchTab ? 'tab' : 'window',
      '--location',
      shouldLaunchTab ? 'after' : 'vsplit',
      '--cwd',
      ctx.cwd,
      shellPath,
      '-ilc',
      wrapperCommand,
    ]);

    if (result.code !== 0) {
      cleanupPromptTempPath(launch.promptFile);
      cleanupTempPath(launch.markerFile);
    }

    return result;
  } catch (error) {
    cleanupPromptTempPath(launch.promptFile);
    cleanupTempPath(launch.markerFile);
    throw error;
  }
}

type LaunchResult = { code: number; stdout?: string; stderr?: string };

type HerdrPaneInfo = {
  pane_id?: unknown;
  focused?: unknown;
  workspace_id?: unknown;
};

type FocusedHerdrPane = {
  paneId: string;
  workspaceId?: string;
};

function parseJsonResponse(stdout: string | undefined, context: string): unknown {
  try {
    return JSON.parse(stdout || '');
  } catch (error) {
    throw new Error(`${context} returned invalid JSON: ${formatThrownLaunchError(error)}`);
  }
}

function getHerdrErrorMessage(response: unknown): string | undefined {
  if (!response || typeof response !== 'object' || !('error' in response)) return undefined;

  const error = (response as { error?: { message?: unknown } }).error;
  return typeof error?.message === 'string' ? error.message : JSON.stringify(error);
}

function parseFocusedHerdrPane(stdout: string | undefined): FocusedHerdrPane {
  const response = parseJsonResponse(stdout, 'herdr pane list');
  const errorMessage = getHerdrErrorMessage(response);
  if (errorMessage) throw new Error(`herdr pane list failed: ${errorMessage}`);

  const panes = (response as { result?: { panes?: HerdrPaneInfo[] } }).result?.panes;
  if (!Array.isArray(panes)) {
    throw new Error('herdr pane list did not return result.panes');
  }

  const focusedPane = panes.find((pane) => pane && pane.focused === true);
  if (typeof focusedPane?.pane_id !== 'string' || focusedPane.pane_id.length === 0) {
    throw new Error('herdr pane list did not include a focused pane');
  }

  const workspaceId =
    typeof focusedPane.workspace_id === 'string' && focusedPane.workspace_id.length > 0
      ? focusedPane.workspace_id
      : undefined;

  return { paneId: focusedPane.pane_id, workspaceId };
}

function parseCreatedHerdrPaneId(stdout: string | undefined): string {
  const response = parseJsonResponse(stdout, 'herdr pane split');
  const errorMessage = getHerdrErrorMessage(response);
  if (errorMessage) throw new Error(`herdr pane split failed: ${errorMessage}`);

  const paneId = (response as { result?: { pane?: { pane_id?: unknown } } }).result?.pane?.pane_id;
  if (typeof paneId !== 'string' || paneId.length === 0) {
    throw new Error('herdr pane split did not return result.pane.pane_id');
  }

  return paneId;
}

function parseCreatedHerdrTabRootPaneId(stdout: string | undefined): string {
  const response = parseJsonResponse(stdout, 'herdr tab create');
  const errorMessage = getHerdrErrorMessage(response);
  if (errorMessage) throw new Error(`herdr tab create failed: ${errorMessage}`);

  const paneId = (response as { result?: { root_pane?: { pane_id?: unknown } } }).result?.root_pane
    ?.pane_id;
  if (typeof paneId !== 'string' || paneId.length === 0) {
    throw new Error('herdr tab create did not return result.root_pane.pane_id');
  }

  return paneId;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function getTerminalColumns(env: NodeJS.ProcessEnv): number | undefined {
  const envColumns = parsePositiveInteger(env.COLUMNS);
  if (envColumns !== undefined) return envColumns;

  const stdoutColumns = process.stdout.columns;
  return Number.isInteger(stdoutColumns) && stdoutColumns > 0 ? stdoutColumns : undefined;
}

function shouldCreateNativeTab(env: NodeJS.ProcessEnv): boolean {
  const columns = getTerminalColumns(env);
  return columns !== undefined && columns <= HERDR_MOBILE_WIDTH_THRESHOLD;
}

async function launchHerdr(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  sessionFile: string | undefined,
  prompt: string,
  env: NodeJS.ProcessEnv,
  beforeRun?: (native: NativeSplitDetails) => string | undefined,
) {
  let launch: ReturnType<typeof buildLaunchWrapperArgs> | undefined;

  try {
    const listResult = await pi.exec('herdr', ['pane', 'list']);
    if (listResult.code !== 0) {
      return listResult;
    }

    const focusedPane = parseFocusedHerdrPane(listResult.stdout);
    let newPaneId: string;
    let target: 'pane' | 'tab';

    if (shouldCreateNativeTab(env)) {
      const createArgs = ['tab', 'create'];
      if (focusedPane.workspaceId) {
        createArgs.push('--workspace', focusedPane.workspaceId);
      }
      createArgs.push('--cwd', ctx.cwd, '--no-focus');

      const tabResult = await pi.exec('herdr', createArgs);
      if (tabResult.code !== 0) {
        return tabResult;
      }

      newPaneId = parseCreatedHerdrTabRootPaneId(tabResult.stdout);
      target = 'tab';
    } else {
      const splitResult = await pi.exec('herdr', [
        'pane',
        'split',
        focusedPane.paneId,
        '--direction',
        'right',
        '--cwd',
        ctx.cwd,
        '--no-focus',
      ]);
      if (splitResult.code !== 0) {
        return splitResult;
      }

      newPaneId = parseCreatedHerdrPaneId(splitResult.stdout);
      target = 'pane';
    }

    const markerFile = beforeRun?.({
      terminal: 'herdr',
      parent: {
        pane: focusedPane.paneId,
        workspace: focusedPane.workspaceId,
      },
      child: { pane: newPaneId, target },
    });
    launch = buildLaunchWrapperArgs(ctx.cwd, sessionFile, prompt, markerFile);
    const wrapperCommand = launch.argv.map(shellQuote).join(' ');

    const runResult = await pi.exec('herdr', ['pane', 'run', newPaneId, wrapperCommand]);
    if (runResult.code !== 0) {
      cleanupPromptTempPath(launch.promptFile);
      cleanupTempPath(launch.markerFile);
    }

    return runResult;
  } catch (error) {
    cleanupPromptTempPath(launch?.promptFile);
    cleanupTempPath(launch?.markerFile);
    throw error;
  }
}

function formatThrownLaunchError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}

async function launchSessionInTerminal(
  terminal: SupportedTerminal,
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  sessionFile: string | undefined,
  prompt: string,
  env: NodeJS.ProcessEnv,
  beforeRun?: (native: NativeSplitDetails) => string | undefined,
): Promise<LaunchResult> {
  try {
    if (terminal === 'ghostty') {
      return await launchGhostty(pi, ctx, sessionFile, prompt, env, beforeRun);
    }

    if (terminal === 'herdr') {
      return await launchHerdr(pi, ctx, sessionFile, prompt, env, beforeRun);
    }

    return await launchKitty(pi, ctx, sessionFile, prompt, env, beforeRun);
  } catch (error) {
    return {
      code: 1,
      stderr: `pre-launch command failed: ${formatThrownLaunchError(error)}`,
    };
  }
}

function notifyLaunchFailure(
  result: LaunchResult,
  terminal: SupportedTerminal,
  ctx: ExtensionCommandContext,
  options: {
    sessionFile?: string;
    hadStartupInput?: boolean;
  },
): boolean {
  if (result.code === 0) return false;

  const reason = result.stderr?.trim() || result.stdout?.trim() || 'unknown launch error';
  ctx.ui.notify(`Failed to launch ${terminal}: ${reason}`, 'error');

  if (options.sessionFile) {
    ctx.ui.notify(
      `Retry in a new split/window with: ${formatSessionLaunchHint(options.sessionFile)}`,
      'info',
    );
  }

  if (options.hadStartupInput) {
    ctx.ui.notify(
      'Startup prompt/command was not delivered. Retry launch first, then resend it manually.',
      'warning',
    );
  }

  return true;
}

function notifyLaunchSuccess(
  ctx: ExtensionCommandContext,
  successMessage: string,
  wasBusy: boolean,
): void {
  ctx.ui.notify(successMessage, 'info');

  if (wasBusy) {
    ctx.ui.notify(
      'Forked from current committed state (in-flight turn continues in original session).',
      'info',
    );
  }
}

function notifySplitLaunchSuccess(
  ctx: ExtensionCommandContext,
  marker: PendingParentMarker | undefined,
  fallbackMessage: string,
  wasBusy: boolean,
): void {
  if (marker) {
    notifySplitMarker(ctx, marker.data);
  } else {
    ctx.ui.notify(fallbackMessage, 'info');
  }

  if (wasBusy) {
    ctx.ui.notify(
      'Forked from current committed state (in-flight turn continues in original session).',
      'info',
    );
  }
}

function recordParentMarker(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  pendingParentMarkers: PendingParentMarker[],
  marker: PendingParentMarker | undefined,
  wasBusy: boolean,
): void {
  if (!marker) return;

  if (wasBusy) {
    pendingParentMarkers.push(marker);
    return;
  }

  pi.appendEntry(marker.customType, marker.data);
  labelSplitMarker(pi, ctx, marker.data);
}

function flushPendingParentMarkers(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  pendingParentMarkers: PendingParentMarker[],
): void {
  while (pendingParentMarkers.length > 0) {
    const marker = pendingParentMarkers.shift();
    if (marker) {
      pi.appendEntry(marker.customType, marker.data);
      labelSplitMarker(pi, ctx, marker.data);
    }
  }
}

async function runSplitForkForTerminal(
  terminal: SupportedTerminal,
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  env: NodeJS.ProcessEnv,
  pendingParentMarkers: PendingParentMarker[],
): Promise<void> {
  if (!hasTui(ctx)) {
    return;
  }

  const wasBusy = !ctx.isIdle();
  const prompt = args.trim();

  let splitSession: CreatedSplitSession | undefined;
  if (prompt) {
    splitSession = createForkedSessionFromCurrentLeafDetails(ctx);
  } else {
    const selectedEntryId = await selectForkEntry(ctx);
    if (!selectedEntryId) return;
    splitSession = createForkedSessionDetails(ctx, selectedEntryId);
  }

  if (!splitSession) {
    ctx.ui.notify('Failed to create forked session', 'error');
    return;
  }

  let parentMarker: PendingParentMarker | undefined;
  const result = await launchSessionInTerminal(
    terminal,
    pi,
    ctx,
    splitSession.file,
    prompt,
    env,
    (native) => {
      const marker = createSplitMarkerPair(
        splitSession,
        'split-fork',
        prompt ? 'raw' : 'none',
        native,
      );
      parentMarker = { customType: marker.customType, data: marker.parent };
      return prepareChildMarkerSeed(splitSession, marker.customType, marker.child);
    },
  );
  augmentParentMarkerFromLaunchResult(terminal, parentMarker, result);
  const successMessage = `Forked new session: ${formatSessionLaunchHint(splitSession.file)}${prompt ? ' and sent prompt' : ''}`;
  if (
    notifyLaunchFailure(result, terminal, ctx, {
      sessionFile: splitSession.file,
      hadStartupInput: prompt.length > 0,
    })
  ) {
    return;
  }

  recordParentMarker(pi, ctx, pendingParentMarkers, parentMarker, wasBusy);

  notifySplitLaunchSuccess(ctx, parentMarker, successMessage, wasBusy);
}

async function runSplitResumeForTerminal(
  terminal: SupportedTerminal,
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!hasTui(ctx)) {
    return;
  }

  const selectedSession = await selectResumeSession(ctx);
  if (!selectedSession) return;

  const result = await launchSessionInTerminal(terminal, pi, ctx, selectedSession, '', env);
  const successMessage = `Resumed session in new ${terminal}: ${formatSessionLaunchHint(selectedSession)}`;
  if (notifyLaunchFailure(result, terminal, ctx, { sessionFile: selectedSession })) {
    return;
  }

  notifyLaunchSuccess(ctx, successMessage, false);
}

async function runSplitHandoffForTerminal(
  terminal: SupportedTerminal,
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  env: NodeJS.ProcessEnv,
  pendingParentMarkers: PendingParentMarker[],
): Promise<void> {
  if (!hasTui(ctx)) {
    return;
  }

  const goal = args.trim();
  if (!goal) {
    ctx.ui.notify('Usage: /split-handoff <goal for new thread>', 'error');
    return;
  }

  const wasBusy = !ctx.isIdle();
  const sourceLeafId = getNearestSplitSourceEntryId(ctx);
  const generatedPrompt = await generateHandoffPrompt(goal, ctx);
  if (generatedPrompt === null) {
    ctx.ui.notify('Cancelled', 'info');
    return;
  }

  const editedPrompt = await ctx.ui.editor('Edit handoff prompt', generatedPrompt);
  if (editedPrompt === undefined) {
    ctx.ui.notify('Cancelled', 'info');
    return;
  }

  const splitSession = createChildSessionDetails(ctx, sourceLeafId);
  if (!splitSession) {
    ctx.ui.notify('Failed to create handoff session', 'error');
    return;
  }

  let parentMarker: PendingParentMarker | undefined;
  const result = await launchSessionInTerminal(
    terminal,
    pi,
    ctx,
    splitSession.file,
    editedPrompt,
    env,
    (native) => {
      const marker = createSplitMarkerPair(splitSession, 'split-handoff', 'handoff', native);
      parentMarker = { customType: marker.customType, data: marker.parent };
      return prepareChildMarkerSeed(splitSession, marker.customType, marker.child);
    },
  );
  augmentParentMarkerFromLaunchResult(terminal, parentMarker, result);
  const successMessage = `Handoff session ready: ${formatSessionLaunchHint(splitSession.file)}`;
  if (
    notifyLaunchFailure(result, terminal, ctx, {
      sessionFile: splitSession.file,
      hadStartupInput: editedPrompt.length > 0,
    })
  ) {
    return;
  }

  recordParentMarker(pi, ctx, pendingParentMarkers, parentMarker, wasBusy);
  notifySplitLaunchSuccess(ctx, parentMarker, successMessage, false);
}

async function runSplitTreeForTerminal(
  terminal: SupportedTerminal,
  pi: ExtensionAPI,
  _args: string,
  ctx: ExtensionCommandContext,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!hasTui(ctx)) {
    return;
  }

  const sessionFile = ctx.sessionManager.getSessionFile?.() ?? undefined;
  if (!sessionFile) {
    ctx.ui.notify('split-tree requires a persisted session', 'error');
    return;
  }

  const result = await launchSessionInTerminal(terminal, pi, ctx, sessionFile, '/tree', env);
  const successMessage = `Opened ${terminal} split for tree: ${formatSessionLaunchHint(sessionFile)}`;
  if (notifyLaunchFailure(result, terminal, ctx, { sessionFile, hadStartupInput: true })) {
    return;
  }

  notifyLaunchSuccess(ctx, successMessage, false);
}

export async function piNativeSplitExtension(
  pi: ExtensionAPI,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  installChildMarkerHandler(pi, env);

  const terminal = detectTerminal(env);
  if (!terminal) return;

  const pendingParentMarkers: PendingParentMarker[] = [];
  pi.on?.('agent_end', (_event, ctx) => flushPendingParentMarkers(pi, ctx, pendingParentMarkers));

  pi.registerCommand('split-fork', {
    description:
      'Fork this session into a new terminal-native split or window. Usage: /split-fork [optional prompt]',
    handler: async (args, ctx) =>
      runSplitForkForTerminal(terminal, pi, args, ctx, env, pendingParentMarkers),
  });

  pi.registerCommand('split-resume', {
    description: 'Resume another session in a new terminal-native split or window',
    handler: async (_args, ctx) => runSplitResumeForTerminal(terminal, pi, ctx, env),
  });

  pi.registerCommand('split-handoff', {
    description: 'Generate a handoff and continue it in a new terminal-native split or window',
    handler: async (args, ctx) =>
      runSplitHandoffForTerminal(terminal, pi, args, ctx, env, pendingParentMarkers),
  });

  pi.registerCommand('split-tree', {
    description:
      'Open the current persisted session in a new split/window and invoke native /tree there',
    handler: async (args, ctx) => runSplitTreeForTerminal(terminal, pi, args, ctx, env),
  });
}

export default function (pi: ExtensionAPI): Promise<void> | void {
  return piNativeSplitExtension(pi);
}
