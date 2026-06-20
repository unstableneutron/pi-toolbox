import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export default function (pi: ExtensionAPI) {
  // Queue of commands to execute after agent turn ends
  let pendingCommand: { command: string; reason?: string } | null = null;
  let pendingAnswerTimer: ReturnType<typeof setTimeout> | undefined;

  const clearPendingAnswerTimer = (): void => {
    if (pendingAnswerTimer) {
      clearTimeout(pendingAnswerTimer);
      pendingAnswerTimer = undefined;
    }
  };

  // Tool to execute a command/message directly (self-invoke)
  pi.registerTool({
    name: 'execute_command',
    label: 'Execute Command',
    description: `Queue a follow-up for yourself after the current turn. Supports:
- /answer to self-invoke the answer flow after asking questions
- Plain text to prefill the editor for the user to review and send`,
    promptSnippet: 'Queue /answer or plain-text follow-up input for after this turn',

    parameters: Type.Object({
      command: Type.String({
        description: "The command or message to queue (e.g., '/answer' or any plain text)",
      }),
      reason: Type.Optional(
        Type.String({
          description: "Optional explanation for why you're queueing this (shown to user)",
        }),
      ),
    }),

    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const { command, reason } = params;

      if (command.startsWith('/') && command !== '/answer') {
        return {
          content: [
            {
              type: 'text',
              text: `Only /answer is supported. To run ${command}, have the user type it manually.`,
            },
          ],
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
        // 0.69.0+: end the current tool batch without paying for an automatic
        // follow-up LLM turn. The queued command runs from `agent_end` below,
        // so any assistant reply would be wasted. This only takes effect when
        // every finalized result in the batch is terminating, so if the model
        // calls execute_command alongside other tools we still get a normal
        // follow-up turn.
        terminate: true,
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
        clearPendingAnswerTimer();
        pendingAnswerTimer = setTimeout(() => {
          pendingAnswerTimer = undefined;
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

  pi.on('session_shutdown', async () => {
    pendingCommand = null;
    clearPendingAnswerTimer();
  });
}
