import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { ComputerUseSession } from './src/session';
import { registerComputerUseTools } from './src/tools';

export default function piComputerUseExtension(pi: ExtensionAPI): void {
  const session = new ComputerUseSession();

  registerComputerUseTools(pi, session);

  pi.registerCommand('computer-use', {
    description: 'Show pi-codex-computer-use Codex native CUA bridge status',
    handler: async (_args, ctx) => {
      const status = await session.getStatus(ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(status, 'info');
      } else {
        console.log(status);
      }
    },
  });

  pi.on('session_shutdown', async () => {
    session.close();
  });
}
