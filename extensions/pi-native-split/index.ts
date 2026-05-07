import { complete, type Message } from '@earendil-works/pi-ai';
import {
  BorderedLoader,
  SessionManager,
  SessionSelectorComponent,
  UserMessageSelectorComponent,
  convertToLlm,
  serializeConversation,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export type SupportedTerminal = 'ghostty' | 'kitty';

const EMPTY_LAUNCH_VALUE = '__PI_NATIVE_SPLIT_EMPTY__';

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function detectTerminal(
  env: NodeJS.ProcessEnv = process.env,
): SupportedTerminal | undefined {
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
): { argv: string[]; promptFile?: string } {
  const promptFile = prompt.length > 0 ? writePromptFile(prompt) : undefined;

  return {
    argv: [
      '/bin/sh',
      getLauncherScriptPath(),
      cwd,
      sessionFile ?? EMPTY_LAUNCH_VALUE,
      promptFile ?? EMPTY_LAUNCH_VALUE,
    ],
    promptFile,
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

function createChildSession(ctx: ExtensionCommandContext): string | undefined {
  const manager = SessionManager.create(ctx.cwd, ctx.sessionManager.getSessionDir());
  return manager.newSession({
    parentSession: ctx.sessionManager.getSessionFile() ?? undefined,
  });
}

function createForkedSessionFromCurrentLeaf(ctx: ExtensionCommandContext): string | undefined {
  const manager = ctx.sessionManager as typeof ctx.sessionManager & {
    createBranchedSession?: (leafId: string) => string | undefined;
  };

  const currentLeafId = ctx.sessionManager.getBranch().at(-1)?.id;
  if (!currentLeafId) {
    return createChildSession(ctx);
  }

  if (!manager.createBranchedSession) {
    return undefined;
  }

  return manager.createBranchedSession(currentLeafId);
}

export function createForkedSession(
  ctx: ExtensionCommandContext,
  entryId: string,
): string | undefined {
  const selectedEntry = ctx.sessionManager.getEntry(entryId);
  if (!selectedEntry || selectedEntry.type !== 'message' || selectedEntry.message.role !== 'user') {
    return undefined;
  }

  const manager = ctx.sessionManager as typeof ctx.sessionManager & {
    createBranchedSession?: (leafId: string) => string | undefined;
  };

  if (!selectedEntry.parentId) {
    return createChildSession(ctx);
  }

  if (!manager.createBranchedSession) {
    return undefined;
  }

  return manager.createBranchedSession(selectedEntry.parentId);
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
) {
  const launch = buildLaunchWrapperArgs(ctx.cwd, sessionFile, prompt);
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
    }

    return result;
  } catch (error) {
    cleanupPromptTempPath(launch.promptFile);
    throw error;
  }
}

async function launchKitty(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  sessionFile: string | undefined,
  prompt: string,
  env: NodeJS.ProcessEnv,
) {
  const launch = buildLaunchWrapperArgs(ctx.cwd, sessionFile, prompt);
  const shellPath = env.SHELL || process.env.SHELL || '/bin/sh';
  const wrapperCommand = launch.argv.map(shellQuote).join(' ');

  try {
    const result = await pi.exec('kitten', [
      '@',
      'new-window',
      '--window-type',
      'os',
      '--cwd',
      ctx.cwd,
      shellPath,
      '-ilc',
      wrapperCommand,
    ]);

    if (result.code !== 0) {
      cleanupPromptTempPath(launch.promptFile);
    }

    return result;
  } catch (error) {
    cleanupPromptTempPath(launch.promptFile);
    throw error;
  }
}

type LaunchResult = { code: number; stdout?: string; stderr?: string };

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
): Promise<LaunchResult> {
  try {
    if (terminal === 'ghostty') {
      return await launchGhostty(pi, ctx, sessionFile, prompt);
    }

    return await launchKitty(pi, ctx, sessionFile, prompt, env);
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

async function runSplitForkForTerminal(
  terminal: SupportedTerminal,
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify('split-fork requires interactive mode', 'error');
    return;
  }

  const wasBusy = !ctx.isIdle();
  const prompt = args.trim();

  let sessionFile: string | undefined;
  if (prompt) {
    sessionFile = createForkedSessionFromCurrentLeaf(ctx);
  } else {
    const selectedEntryId = await selectForkEntry(ctx);
    if (!selectedEntryId) return;
    sessionFile = createForkedSession(ctx, selectedEntryId);
  }

  if (!sessionFile) {
    ctx.ui.notify('Failed to create forked session', 'error');
    return;
  }

  const result = await launchSessionInTerminal(terminal, pi, ctx, sessionFile, prompt, env);
  const successMessage = `Forked new session: ${formatSessionLaunchHint(sessionFile)}${prompt ? ' and sent prompt' : ''}`;
  if (
    notifyLaunchFailure(result, terminal, ctx, { sessionFile, hadStartupInput: prompt.length > 0 })
  ) {
    return;
  }

  notifyLaunchSuccess(ctx, successMessage, wasBusy);
}

async function runSplitResumeForTerminal(
  terminal: SupportedTerminal,
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify('split-resume requires interactive mode', 'error');
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
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify('split-handoff requires interactive mode', 'error');
    return;
  }

  const goal = args.trim();
  if (!goal) {
    ctx.ui.notify('Usage: /split-handoff <goal for new thread>', 'error');
    return;
  }

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

  const sessionFile = createChildSession(ctx);
  if (!sessionFile) {
    ctx.ui.notify('Failed to create handoff session', 'error');
    return;
  }

  const result = await launchSessionInTerminal(terminal, pi, ctx, sessionFile, editedPrompt, env);
  const successMessage = `Handoff session ready: ${formatSessionLaunchHint(sessionFile)}`;
  if (
    notifyLaunchFailure(result, terminal, ctx, {
      sessionFile,
      hadStartupInput: editedPrompt.length > 0,
    })
  ) {
    return;
  }

  notifyLaunchSuccess(ctx, successMessage, false);
}

async function runSplitTreeForTerminal(
  terminal: SupportedTerminal,
  pi: ExtensionAPI,
  _args: string,
  ctx: ExtensionCommandContext,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify('split-tree requires interactive mode', 'error');
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
  const terminal = detectTerminal(env);
  if (!terminal) return;

  pi.registerCommand('split-fork', {
    description:
      'Fork this session into a new terminal-native split or window. Usage: /split-fork [optional prompt]',
    handler: async (args, ctx) => runSplitForkForTerminal(terminal, pi, args, ctx, env),
  });

  pi.registerCommand('split-resume', {
    description: 'Resume another session in a new terminal-native split or window',
    handler: async (_args, ctx) => runSplitResumeForTerminal(terminal, pi, ctx, env),
  });

  pi.registerCommand('split-handoff', {
    description: 'Generate a handoff and continue it in a new terminal-native split or window',
    handler: async (args, ctx) => runSplitHandoffForTerminal(terminal, pi, args, ctx, env),
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
