import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

/**
 * Manual reload command.
 *
 * This mirrors the documented ctx.reload() example but intentionally exposes
 * only a slash command. We do not expose an LLM-callable tool here because
 * extension-originated sendUserMessage('/slash-command') currently injects
 * literal user text instead of executing the slash command.
 */
export default function (pi: ExtensionAPI) {
  pi.registerCommand('reload-runtime', {
    description: 'Reload extensions, skills, prompts, and themes',
    handler: async (_args, ctx) => {
      await ctx.reload();
      return;
    },
  });
}
