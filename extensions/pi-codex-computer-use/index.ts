import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { registerCodexBrowserTools } from './src/browser-tools';
import { runCodexComputerUseDoctor } from './src/doctor';
import { ComputerUseSession } from './src/session';
import { registerComputerUseTools } from './src/tools';

export default function piComputerUseExtension(pi: ExtensionAPI): void {
  const session = new ComputerUseSession();

  registerComputerUseTools(pi, session);
  registerCodexBrowserTools(pi, session);

  pi.registerCommand('codex-computer-use-doctor', {
    description:
      'Diagnose Codex native Computer Use setup, permissions, and helper process health; prompts before opening guided fixes.',
    handler: async (_args, ctx) => {
      await runCodexComputerUseDoctor(ctx, {
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
