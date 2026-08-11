import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
  DEFERRED_TOOL_POLICY_EVENT,
  DEFERRED_TOOLS_PROTOCOL_VERSION,
  type DeferredToolPolicyRequest,
} from '../../shared/deferred-tools-protocol';
import {
  checkCodexAppServerControlSocket,
  type CodexAppServerControlSocketHealth,
} from './app-server-control';
import { registerCodexBrowserTools } from './browser-tools';
import {
  getCodexAppServerUseConfig,
  getCodexAppServerUseConfigStatus,
  runCodexAppServerUseSettingsCommand,
  type CodexAppServerUseConfig,
} from './config';
import {
  readDefaultBrowserBridgeStatus,
  repairChromeNativeHostManifestsForDetectedExtension,
  runCodexComputerUseDoctor,
} from './doctor';
import {
  APP_SERVER_EXEC_TOOL_NAMES,
  APP_SERVER_EXEC_CONTROL_TOOL_NAMES,
  CodexAppServerExecSessionManager,
  getDefaultCodexRuntimeShell,
  registerAppServerApplyPatchTool,
  registerAppServerExecControlTools,
  REPLACED_PI_LOCAL_TOOL_NAMES,
  shouldUseAppServerExecTools,
} from './exec-tools';
import { getCodexComputerUseSkillPaths } from './plugin-skills';
import { ComputerUseSession } from './session';
import { registerComputerUseTools } from './tools';
import {
  registerViewImageTool,
  supportsViewImageInputs,
  VIEW_IMAGE_TOOL_NAME,
} from './view-image-tool';

const COMPUTER_USE_TOOL_NAMES = [
  'computer_list_apps',
  'computer_get_app_state',
  'computer_click',
  'computer_drag',
  'computer_press_key',
  'computer_type_text',
  'computer_scroll',
  'computer_select_text',
  'computer_set_value',
  'computer_perform_secondary_action',
  'codex_browser_list',
  'codex_browser_eval',
];

const CODEX_EXEC_TOOL_NAMES = [...APP_SERVER_EXEC_TOOL_NAMES, VIEW_IMAGE_TOOL_NAME];
const STATUS_KEY = 'codex-app-server-use';
const STATUS_FLASH_MS = 5_000;

function withoutTools(toolNames: string[], removed: readonly string[]): string[] {
  return toolNames.filter((name) => !removed.includes(name));
}

function mergeToolNames(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

function isAppServerExecActive(ctx: ExtensionContext, config: CodexAppServerUseConfig): boolean {
  return config.exec.enabled && shouldUseAppServerExecTools(ctx.model as never, config.exec.models);
}

function shouldUseAnyAppServerCapability(
  ctx: ExtensionContext,
  config: CodexAppServerUseConfig,
): boolean {
  return config.computerUse.enabled || isAppServerExecActive(ctx, config);
}

function getCodexExecToolNames(ctx: ExtensionContext): string[] {
  return supportsViewImageInputs(ctx.model) ? CODEX_EXEC_TOOL_NAMES : APP_SERVER_EXEC_TOOL_NAMES;
}

function getDeferredToolPolicy(pi: ExtensionAPI): Set<string> | undefined {
  const events = (pi as ExtensionAPI & { events?: ExtensionAPI['events'] }).events;
  if (!events || typeof events.emit !== 'function') return undefined;
  const request: DeferredToolPolicyRequest = {
    version: DEFERRED_TOOLS_PROTOCOL_VERSION,
    deferredNames: new Set(),
    handled: false,
  };
  events.emit(DEFERRED_TOOL_POLICY_EVENT, request);
  return request.handled ? request.deferredNames : undefined;
}

function formatUnavailableWarning(
  health: Extract<CodexAppServerControlSocketHealth, { ok: false }>,
): string {
  return `Codex AppServer daemon is unavailable at ${health.socketPath}; AppServer-backed tools are disabled for this session. Run \`codex app-server daemon --help\` for setup help. ${health.error}`;
}

const CODEX_EXEC_GUIDELINES = [
  'Use exec_command for shell commands, file inspection, builds, and tests; prefer rg / rg --files for discovery and focused commands over truncation.',
  'Use tty=true for dev servers, watchers, REPLs, and prompts.',
  'Use apply_patch for text-file changes, including creates/deletes/moves; group related multi-file edits into one patch.',
  'Prefer the apply_patch tool; use shell apply_patch only when chaining edits with other shell steps.',
  'Run independent tool calls in parallel when practical.',
];

function insertBeforeTrailingContext(prompt: string, section: string): string {
  const currentDateIndex = prompt.lastIndexOf('\nCurrent date:');
  if (currentDateIndex !== -1) {
    return `${prompt.slice(0, currentDateIndex)}\n\n${section}${prompt.slice(currentDateIndex)}`;
  }
  return `${prompt}\n\n${section}`;
}

function injectGuidelines(prompt: string): string {
  const match = prompt.match(
    /(^Guidelines:\n)([\s\S]*?)(\n\n(?=Pi documentation\b|# Project Context|# Skills|Current date:))/m,
  );
  if (!match || match.index === undefined) {
    return insertBeforeTrailingContext(
      prompt,
      `Guidelines:\n${CODEX_EXEC_GUIDELINES.map((line) => `- ${line}`).join('\n')}`,
    );
  }

  const [, header, body, suffix] = match as RegExpMatchArray & {
    1: string;
    2: string;
    3: string;
  };
  const existing = new Set(
    body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2)),
  );
  const additions = CODEX_EXEC_GUIDELINES.filter((line) => !existing.has(line)).map(
    (line) => `- ${line}`,
  );
  if (additions.length === 0) return prompt;

  const replacement = `${header}${body.trimEnd()}\n${additions.join('\n')}${suffix}`;
  return `${prompt.slice(0, match.index)}${replacement}${prompt.slice(match.index + match[0]!.length)}`;
}

function injectShell(prompt: string): string {
  const shell = getDefaultCodexRuntimeShell();
  if (/\nCurrent shell:/.test(prompt)) {
    return prompt.replace(/(^Current shell:) .*$/m, `$1 ${shell}`);
  }
  return insertBeforeTrailingContext(prompt, `Current shell: ${shell}`);
}

function buildCodexExecSystemPrompt(basePrompt: string): string {
  return injectShell(injectGuidelines(basePrompt));
}

function asStringRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function normalizedCommandEcho(text: string): string {
  let trimmed = text.trim();
  const fenced = /^```(?:bash|sh|shell)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  if (fenced) trimmed = fenced[1]!.trim();
  const codeSpan = /^`([^`]+)`$/.exec(trimmed);
  if (codeSpan) trimmed = codeSpan[1]!.trim();
  return trimmed.replace(/\s+/g, ' ');
}

function stripPureExecCommandEchoText(message: unknown): Record<string, unknown> | undefined {
  const record = asStringRecord(message);
  if (record.role !== 'assistant' || !Array.isArray(record.content)) return undefined;

  const commandEchoes = new Set<string>();
  for (const block of record.content) {
    const content = asStringRecord(block);
    if (content.type !== 'toolCall' || content.name !== 'exec_command') continue;
    const args = asStringRecord(content.arguments);
    const command = typeof args.cmd === 'string' ? args.cmd : args.command;
    if (typeof command === 'string') commandEchoes.add(normalizedCommandEcho(command));
  }
  if (commandEchoes.size === 0) return undefined;

  let changed = false;
  const content = record.content.filter((block) => {
    const item = asStringRecord(block);
    if (item.type !== 'text' || typeof item.text !== 'string') return true;
    if (!commandEchoes.has(normalizedCommandEcho(item.text))) return true;
    changed = true;
    return false;
  });

  return changed ? { ...record, content } : undefined;
}

function formatExecSessionList(
  sessions: ReturnType<CodexAppServerExecSessionManager['listSessions']>,
): string {
  if (sessions.length === 0) return 'No AppServer exec sessions are running.';
  return [
    'AppServer exec sessions:',
    ...sessions.map((session) => {
      const status = session.running ? 'running' : `exit ${session.exit_code}`;
      const tty = session.tty ? 'tty' : 'pipe';
      return `#${session.session_id} ${status} ${tty} ${session.buffered_chars} chars — ${session.command}`;
    }),
    '',
    'Poll or interact with a session by calling write_stdin with its session_id.',
  ].join('\n');
}

export interface CodexAppServerUseExtensionDeps {
  checkAppServerControlSocket?: typeof checkCodexAppServerControlSocket;
}

export default function piCodexAppServerUseExtension(
  pi: ExtensionAPI,
  deps: CodexAppServerUseExtensionDeps = {},
): void {
  const computerUseSession = new ComputerUseSession();
  const execSessions = new CodexAppServerExecSessionManager();
  const checkHealth = deps.checkAppServerControlSocket ?? checkCodexAppServerControlSocket;
  let computerUseToolsRegistered = false;
  let execControlToolsRegistered = false;
  let execExtraToolsRegistered = false;
  let execWasActive = false;
  let execWasReplacing = false;
  let replacedPiLocalToolNames: string[] = [];
  const execActivatedExtraToolNames = new Set<string>();
  let lastUnavailableWarningKey: string | undefined;
  let statusFlashTimer: ReturnType<typeof setTimeout> | undefined;

  function ensureComputerUseToolsRegistered(): void {
    if (computerUseToolsRegistered) return;
    registerComputerUseTools(pi, computerUseSession);
    registerCodexBrowserTools(pi, computerUseSession);
    computerUseToolsRegistered = true;
  }

  function ensureExecControlToolsRegistered(): void {
    if (execControlToolsRegistered) return;
    registerAppServerExecControlTools(pi, execSessions);
    execControlToolsRegistered = true;
  }

  function ensureExecExtraToolsRegistered(): void {
    if (execExtraToolsRegistered) return;
    registerAppServerApplyPatchTool(pi, execSessions);
    registerViewImageTool(pi);
    execExtraToolsRegistered = true;
  }

  ensureExecControlToolsRegistered();

  function warnIfUnavailable(
    ctx: ExtensionContext,
    health: Extract<CodexAppServerControlSocketHealth, { ok: false }>,
  ): void {
    if (!ctx.hasUI) return;
    const key = `${health.socketPath}\n${health.error}`;
    if (lastUnavailableWarningKey === key) return;
    lastUnavailableWarningKey = key;
    ctx.ui.notify(formatUnavailableWarning(health), 'warning');
  }

  function clearPendingStatusFlash(): void {
    if (!statusFlashTimer) return;
    clearTimeout(statusFlashTimer);
    statusFlashTimer = undefined;
  }

  function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
    const unref = (timer as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(timer);
  }

  function setTemporaryStatus(ctx: ExtensionContext, text: string | undefined): void {
    if (!ctx.hasUI) return;

    clearPendingStatusFlash();
    ctx.ui.setStatus(STATUS_KEY, text);
    if (!text) return;

    statusFlashTimer = setTimeout(() => {
      statusFlashTimer = undefined;
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }, STATUS_FLASH_MS);
    unrefTimer(statusFlashTimer);
  }

  async function isAppServerAvailableForEnabledCapabilities(
    ctx: ExtensionContext,
    config: CodexAppServerUseConfig,
  ): Promise<boolean> {
    if (!shouldUseAnyAppServerCapability(ctx, config)) return false;
    const health = await checkHealth();
    if (health.ok) return true;
    warnIfUnavailable(ctx, health);
    return false;
  }

  async function syncActiveTools(
    ctx: ExtensionContext,
    reason: 'session-start' | 'model-select',
  ): Promise<void> {
    const config = getCodexAppServerUseConfig(ctx);
    const appServerAvailable = await isAppServerAvailableForEnabledCapabilities(ctx, config);
    const execActive = appServerAvailable && isAppServerExecActive(ctx, config);
    const currentActiveTools = pi.getActiveTools();
    const deferredToolNames = getDeferredToolPolicy(pi);
    const requestedCodexToolNames = getCodexExecToolNames(ctx);
    const deferredCodexToolNames = CODEX_EXEC_TOOL_NAMES.filter((name) =>
      deferredToolNames?.has(name),
    );
    const preservedDeferredToolNames = new Set(
      reason === 'model-select'
        ? requestedCodexToolNames.filter((name) => currentActiveTools.includes(name))
        : [],
    );
    let activeTools = withoutTools(
      withoutTools(currentActiveTools, COMPUTER_USE_TOOL_NAMES),
      deferredCodexToolNames.filter((name) => !preservedDeferredToolNames.has(name)),
    );

    if (execActive) {
      ensureExecExtraToolsRegistered();
      if (config.exec.replaceLocalTools && !execWasReplacing) {
        replacedPiLocalToolNames = activeTools.filter((name) =>
          REPLACED_PI_LOCAL_TOOL_NAMES.includes(name),
        );
      } else if (!config.exec.replaceLocalTools && execWasReplacing) {
        activeTools = mergeToolNames(activeTools, replacedPiLocalToolNames);
        replacedPiLocalToolNames = [];
      }

      let baseTools = withoutTools(activeTools, APP_SERVER_EXEC_CONTROL_TOOL_NAMES);
      if (config.exec.replaceLocalTools) {
        baseTools = withoutTools(baseTools, REPLACED_PI_LOCAL_TOOL_NAMES);
      }
      const codexExecToolNames = requestedCodexToolNames.filter(
        (name) => !deferredToolNames?.has(name) || preservedDeferredToolNames.has(name),
      );
      for (const name of codexExecToolNames) {
        if (!APP_SERVER_EXEC_CONTROL_TOOL_NAMES.includes(name) && !activeTools.includes(name)) {
          execActivatedExtraToolNames.add(name);
        }
      }
      activeTools = config.exec.replaceLocalTools
        ? mergeToolNames(codexExecToolNames, baseTools)
        : mergeToolNames(baseTools, codexExecToolNames);
      execWasActive = true;
      execWasReplacing = config.exec.replaceLocalTools;
    } else {
      activeTools = withoutTools(activeTools, [
        ...APP_SERVER_EXEC_CONTROL_TOOL_NAMES,
        ...execActivatedExtraToolNames,
      ]);
      if (execWasActive && execWasReplacing) {
        activeTools = mergeToolNames(activeTools, replacedPiLocalToolNames);
      }
      replacedPiLocalToolNames = [];
      execActivatedExtraToolNames.clear();
      execWasActive = false;
      execWasReplacing = false;
    }

    if (appServerAvailable && config.computerUse.enabled) {
      ensureComputerUseToolsRegistered();
      activeTools = mergeToolNames(activeTools, COMPUTER_USE_TOOL_NAMES);
    }

    pi.setActiveTools(activeTools);
    setTemporaryStatus(
      ctx,
      config.ui.statusLine
        ? `Codex AppServer exec:${config.exec.enabled ? (config.exec.replaceLocalTools ? 'replace' : 'on') : 'off'} computer:${config.computerUse.enabled ? 'on' : 'off'}`
        : undefined,
    );
  }

  pi.on('session_start', async (_event, ctx) => {
    await syncActiveTools(ctx, 'session-start');
  });

  pi.on('model_select', async (_event, ctx) => {
    await syncActiveTools(ctx, 'model-select');
  });

  pi.on('message_end', async (event) => {
    const message = stripPureExecCommandEchoText(event.message);
    return message ? { message: message as unknown as typeof event.message } : undefined;
  });

  pi.on('resources_discover', async (_event, ctx) => {
    const config = getCodexAppServerUseConfig(ctx);
    if (!config.computerUse.enabled) return { skillPaths: [] };
    if (!(await isAppServerAvailableForEnabledCapabilities(ctx, config))) return { skillPaths: [] };
    return { skillPaths: getCodexComputerUseSkillPaths() };
  });

  pi.on('before_agent_start', async (event, ctx) => {
    const config = getCodexAppServerUseConfig(ctx);
    if (!isAppServerExecActive(ctx, config)) return undefined;
    if (!(await isAppServerAvailableForEnabledCapabilities(ctx, config))) return undefined;
    return { systemPrompt: buildCodexExecSystemPrompt(event.systemPrompt) };
  });

  pi.registerCommand('codex-app-server', {
    description: 'Open Codex AppServer Use settings for exec tools and Computer Use.',
    handler: async (args, ctx) => runCodexAppServerUseSettingsCommand(args, ctx),
  });

  pi.registerCommand('ps', {
    description: 'List active Codex AppServer exec sessions.',
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatExecSessionList(execSessions.listSessions()), 'info');
    },
  });

  pi.registerCommand('codex-app-server-doctor', {
    description:
      'Diagnose Codex AppServer, native Computer Use setup, permissions, and helper process health; prompts before guided fixes.',
    handler: async (_args, ctx) => {
      const configStatus = getCodexAppServerUseConfigStatus(ctx);
      await runCodexComputerUseDoctor(ctx, {
        extensionEnablement: {
          enabled: configStatus.config.computerUse.enabled,
          source: configStatus.source,
        },
        deps: {
          readBridgeMcpStatus: async () => {
            const status = await computerUseSession.getMcpServerAvailability(ctx);
            return { computerUseAvailable: status.computerUseAvailable };
          },
          readBrowserBridgeStatus: readDefaultBrowserBridgeStatus,
          repairChromeNativeHostManifests: repairChromeNativeHostManifestsForDetectedExtension,
          resetBridge: () => computerUseSession.resetBridge(),
        },
      });
    },
  });

  pi.on('session_shutdown', async () => {
    clearPendingStatusFlash();
    computerUseSession.close();
    execSessions.close();
  });
}
