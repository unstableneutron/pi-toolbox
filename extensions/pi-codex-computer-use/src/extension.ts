import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { registerCodexBrowserTools } from './browser-tools';
import { runCodexComputerUseDoctor } from './doctor';
import {
  getCodexComputerUseEnablementStatus,
  isCodexComputerUseEnabled,
  runCodexComputerUseEnablementCommand,
} from './enablement';
import { getCodexComputerUseSkillPaths } from './plugin-skills';
import { ComputerUseSession } from './session';
import { registerComputerUseTools } from './tools';

export default function piComputerUseExtension(pi: ExtensionAPI): void {
  const session = new ComputerUseSession();
  let toolsRegistered = false;

  const extensionToolNames = [
    'computer_list_apps',
    'computer_get_app_state',
    'computer_action',
    'codex_browser_list',
    'codex_browser_eval',
  ];

  pi.on('session_start', async (_event, ctx) => {
    const enabled = isCodexComputerUseEnabled(ctx);
    const activeTools = pi.getActiveTools().filter((name) => !extensionToolNames.includes(name));
    if (enabled) {
      if (!toolsRegistered) {
        registerComputerUseTools(pi, session);
        registerCodexBrowserTools(pi, session);
        toolsRegistered = true;
      }
      activeTools.push(...extensionToolNames);
      pi.registerCommand('codex-computer-use-disable', {
        description:
          'Disable Codex Computer Use tools and skills for this session, project, or user.',
        handler: async (args, commandCtx) =>
          runCodexComputerUseEnablementCommand(`disable ${args}`, commandCtx),
      });
    } else {
      pi.registerCommand('codex-computer-use-enable', {
        description:
          'Enable Codex Computer Use tools and skills for this session, project, or user.',
        handler: async (args, commandCtx) =>
          runCodexComputerUseEnablementCommand(`enable ${args}`, commandCtx),
      });
    }
    pi.setActiveTools(activeTools);
  });

  pi.on('resources_discover', async (_event, ctx) => ({
    skillPaths: isCodexComputerUseEnabled(ctx) ? getCodexComputerUseSkillPaths() : [],
  }));

  pi.registerCommand('codex-computer-use-doctor', {
    description:
      'Diagnose Codex native Computer Use setup, permissions, and helper process health; prompts before opening guided fixes.',
    handler: async (_args, ctx) => {
      await runCodexComputerUseDoctor(ctx, {
        extensionEnablement: getCodexComputerUseEnablementStatus(ctx),
        deps: {
          readBridgeMcpStatus: async () => {
            const status = await session.getMcpServerAvailability(ctx);
            return { computerUseAvailable: status.computerUseAvailable };
          },
          resetBridge: () => session.resetBridge(),
        },
      });
    },
  });

  pi.on('session_shutdown', async () => {
    session.close();
  });
}
