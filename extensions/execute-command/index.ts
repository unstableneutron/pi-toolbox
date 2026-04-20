import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';

export default function (pi: ExtensionAPI) {
  // Queue of commands to execute after agent turn ends
  let pendingCommand: { command: string; reason?: string } | null = null;

  // Tool to execute a command/message directly (self-invoke)
  pi.registerTool({
    name: 'execute_command',
    label: 'Execute Command',
    description: `Execute /answer or queue plain-text follow-up input as if the user typed it. Use this to:
- Self-invoke /answer after asking multiple questions
- Queue a follow-up prompt for yourself
- Prefill text for the user to send manually

Slash commands other than /answer are not safely supported here and should be run manually.`,
    promptSnippet:
      'Execute /answer or queue plain-text follow-up input. ' +
      'Do not use this tool for /reload or other slash commands.',

    parameters: Type.Object({
      command: Type.String({
        description: "The command or message to execute (e.g., '/answer', '/reload', or any text)",
      }),
      reason: Type.Optional(
        Type.String({
          description: "Optional explanation for why you're executing this command (shown to user)",
        }),
      ),
    }),

    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const { command, reason } = params;

      if (command.startsWith('/') && command !== '/answer') {
        const explanation =
          command === '/reload' || command === '/reload-runtime'
            ? 'Cannot safely execute /reload or /reload-runtime via execute_command in this runtime. Run /reload manually, or type /reload-runtime manually if you want the custom alias.'
            : `Cannot safely execute ${command} via execute_command in this runtime. Run that slash command manually instead.`;

        return {
          content: [{ type: 'text', text: explanation }],
          details: {
            command,
            reason,
            queued: false,
            rejected: true,
          },
        };
      }

      // Store command to be executed after agent turn ends
      pendingCommand = { command, reason };

      const explanation = reason
        ? `Queued for execution: ${command}\nReason: ${reason}`
        : `Queued for execution: ${command}`;

      return {
        content: [{ type: 'text', text: explanation }],
        details: {
          command,
          reason,
          queued: true,
        },
      };
    },
  });

  // Execute pending command after agent turn completes
  pi.on('agent_end', async (_event, ctx) => {
    if (pendingCommand) {
      const { command } = pendingCommand;
      pendingCommand = null;

      // Special handling for /answer via event bus (needs context)
      if (command === '/answer') {
        setTimeout(() => {
          pi.events.emit('trigger:answer', ctx);
        }, 100);
      }
      // For non-command text, prefill editor and notify
      else {
        if (ctx.hasUI) {
          ctx.ui.setEditorText(command);
          ctx.ui.notify(`Press Enter to send: ${command}`, 'info');
        }
      }
    }
  });
}
