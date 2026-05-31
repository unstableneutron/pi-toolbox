import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { registerCodexBrowserTools } from './src/browser-tools';
import { ComputerUseSession, type CodexDiagnosticStatusOptions } from './src/session';
import { registerComputerUseTools } from './src/tools';

export function parseStatusCommandOptions(args: unknown): CodexDiagnosticStatusOptions {
  const values = Array.isArray(args) ? args : 'string' === typeof args ? args.split(/\s+/) : [];
  return { verbose: values.some((value) => value === 'verbose' || value === '--verbose') };
}

export default function piComputerUseExtension(pi: ExtensionAPI): void {
  const session = new ComputerUseSession();

  registerComputerUseTools(pi, session);
  registerCodexBrowserTools(pi, session);

  pi.registerCommand('codex-computer-use-status', {
    description:
      'Show pi-codex-computer-use Codex native CUA/browser diagnostics. Pass "verbose" to write raw diagnostic JSON to a temp file.',
    handler: async (args, ctx) => {
      const status = await session.getDiagnosticStatus(ctx, parseStatusCommandOptions(args));
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
