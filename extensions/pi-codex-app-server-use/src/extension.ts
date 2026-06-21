import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

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
  registerAppServerExecTools,
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
  'Use write_stdin only for running exec_command sessions; poll sparingly.',
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
  let execToolsRegistered = false;
  let execWasActive = false;
  let previousToolNames: string[] | undefined;
  let lastUnavailableWarningKey: string | undefined;

  function ensureComputerUseToolsRegistered(): void {
    if (computerUseToolsRegistered) return;
    registerComputerUseTools(pi, computerUseSession);
    registerCodexBrowserTools(pi, computerUseSession);
    computerUseToolsRegistered = true;
  }

  function ensureExecToolsRegistered(): void {
    if (execToolsRegistered) return;
    registerAppServerExecTools(pi, execSessions);
    registerViewImageTool(pi);
    execToolsRegistered = true;
  }

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

  async function syncActiveTools(ctx: ExtensionContext): Promise<void> {
    const config = getCodexAppServerUseConfig(ctx);
    const appServerAvailable = await isAppServerAvailableForEnabledCapabilities(ctx, config);
    const execActive = appServerAvailable && isAppServerExecActive(ctx, config);
    let activeTools = withoutTools(pi.getActiveTools(), COMPUTER_USE_TOOL_NAMES);

    if (execActive) {
      const codexExecToolNames = getCodexExecToolNames(ctx);
      ensureExecToolsRegistered();
      if (!execWasActive) {
        previousToolNames = withoutTools(activeTools, APP_SERVER_EXEC_CONTROL_TOOL_NAMES);
      }
      const baseTools = withoutTools(
        previousToolNames ?? activeTools,
        APP_SERVER_EXEC_CONTROL_TOOL_NAMES,
      );
      activeTools = config.exec.replaceLocalTools
        ? mergeToolNames(codexExecToolNames, withoutTools(baseTools, REPLACED_PI_LOCAL_TOOL_NAMES))
        : mergeToolNames(baseTools, codexExecToolNames);
      execWasActive = true;
    } else if (execWasActive) {
      activeTools = withoutTools(
        previousToolNames ?? activeTools,
        APP_SERVER_EXEC_CONTROL_TOOL_NAMES,
      );
      previousToolNames = undefined;
      execWasActive = false;
    } else {
      activeTools = withoutTools(activeTools, APP_SERVER_EXEC_CONTROL_TOOL_NAMES);
    }

    if (appServerAvailable && config.computerUse.enabled) {
      ensureComputerUseToolsRegistered();
      activeTools = mergeToolNames(activeTools, COMPUTER_USE_TOOL_NAMES);
    }

    pi.setActiveTools(activeTools);
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        'codex-app-server-use',
        config.ui.statusLine
          ? `Codex AppServer exec:${config.exec.enabled ? (config.exec.replaceLocalTools ? 'replace' : 'on') : 'off'} computer:${config.computerUse.enabled ? 'on' : 'off'}`
          : undefined,
      );
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    await syncActiveTools(ctx);
  });

  pi.on('model_select', async (_event, ctx) => {
    await syncActiveTools(ctx);
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
    computerUseSession.close();
    execSessions.close();
  });
}
