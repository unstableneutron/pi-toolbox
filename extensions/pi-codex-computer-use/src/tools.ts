import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

import type { ComputerUseSession } from './session';

const AppParam = Type.String({
  description: 'App name, full app path, or unambiguous bundle identifier',
});

const ElementIndexParam = Type.String({ description: 'Element identifier from get_app_state' });

const ListAppsParams = Type.Object({});
const GetAppStateParams = Type.Object({ app: AppParam });
const ComputerActionParams = Type.Object({
  action: StringEnum([
    'click',
    'scroll',
    'drag',
    'press_key',
    'type_text',
    'set_value',
    'select_text',
    'secondary_action',
  ] as const),
  app: AppParam,
  element_index: Type.Optional(ElementIndexParam),
  x: Type.Optional(Type.Number({ description: 'X coordinate in screenshot pixels' })),
  y: Type.Optional(Type.Number({ description: 'Y coordinate in screenshot pixels' })),
  mouse_button: Type.Optional(StringEnum(['left', 'right', 'middle'] as const)),
  click_count: Type.Optional(Type.Integer({ description: 'Number of clicks. Defaults to 1' })),
  direction: Type.Optional(StringEnum(['up', 'down', 'left', 'right'] as const)),
  pages: Type.Optional(
    Type.Number({ description: 'Number of pages to scroll; fractional values are supported' }),
  ),
  from_x: Type.Optional(Type.Number({ description: 'Drag start X coordinate' })),
  from_y: Type.Optional(Type.Number({ description: 'Drag start Y coordinate' })),
  to_x: Type.Optional(Type.Number({ description: 'Drag end X coordinate' })),
  to_y: Type.Optional(Type.Number({ description: 'Drag end Y coordinate' })),
  key: Type.Optional(
    Type.String({ description: 'Key or key combination, e.g. Return, Tab, super+c' }),
  ),
  text: Type.Optional(Type.String({ description: 'Literal or target text, depending on action' })),
  value: Type.Optional(Type.String({ description: 'Value for set_value' })),
  prefix: Type.Optional(Type.String({ description: 'Text immediately before target text' })),
  suffix: Type.Optional(Type.String({ description: 'Text immediately after target text' })),
  selection: Type.Optional(StringEnum(['text', 'cursor_before', 'cursor_after'] as const)),
  secondary_action: Type.Optional(
    Type.String({ description: 'Secondary accessibility action name for action=secondary_action' }),
  ),
});

type ToolParamsSchema =
  | typeof ListAppsParams
  | typeof GetAppStateParams
  | typeof ComputerActionParams;

type ComputerActionName =
  | 'click'
  | 'scroll'
  | 'drag'
  | 'press_key'
  | 'type_text'
  | 'set_value'
  | 'select_text'
  | 'secondary_action';

export interface ComputerActionCallParams {
  action: ComputerActionName;
  secondary_action?: string;
  [key: string]: unknown;
}

export interface ComputerUseToolSpec {
  piName: string;
  label: string;
  codexTool?: string;
  description: string;
  promptSnippet: string;
  parameters: ToolParamsSchema;
}

export const COMPUTER_USE_TOOL_SPECS: ComputerUseToolSpec[] = [
  {
    piName: 'computer_list_apps',
    label: 'Computer: List Apps',
    codexTool: 'list_apps',
    description: 'List apps visible to Codex.app native Computer Use.',
    promptSnippet: 'List local Mac apps available through Codex Computer Use.',
    parameters: ListAppsParams,
  },
  {
    piName: 'computer_get_app_state',
    label: 'Computer: Get App State',
    codexTool: 'get_app_state',
    description:
      'Get a screenshot and accessibility tree for an app through Codex native Computer Use.',
    promptSnippet: 'Inspect a Mac app before interacting with it through Computer Use.',
    parameters: GetAppStateParams,
  },
  {
    piName: 'computer_action',
    label: 'Computer: Action',
    description:
      'Run one Codex native Computer Use action such as click, scroll, drag, press_key, type_text, set_value, select_text, or secondary_action.',
    promptSnippet: 'Run a local Mac UI action through Codex native Computer Use.',
    parameters: ComputerActionParams,
  },
];

const COMPUTER_ACTION_TO_CODEX_TOOL: Record<ComputerActionName, string> = {
  click: 'click',
  scroll: 'scroll',
  drag: 'drag',
  press_key: 'press_key',
  type_text: 'type_text',
  set_value: 'set_value',
  select_text: 'select_text',
  secondary_action: 'perform_secondary_action',
};

function omitUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

export function buildComputerActionCall(params: ComputerActionCallParams): {
  codexTool: string;
  arguments: Record<string, unknown>;
} {
  const { action, secondary_action: secondaryAction, ...rest } = params;
  const codexTool = COMPUTER_ACTION_TO_CODEX_TOOL[action];
  if (!codexTool) {
    throw new Error(`Unsupported computer_action action: ${String(action)}`);
  }

  const args = omitUndefined(rest);
  if (action === 'secondary_action') {
    if (!secondaryAction) {
      throw new Error('computer_action with action=secondary_action requires secondary_action');
    }
    args.action = secondaryAction;
  }

  return { codexTool, arguments: args };
}

export interface ToPiToolResultInput {
  threadId: string;
  piName: string;
  codexTool: string;
  rawResult: any;
}

export function toPiToolResult(input: ToPiToolResultInput) {
  return {
    content: input.rawResult?.content ?? [
      { type: 'text', text: JSON.stringify(input.rawResult ?? null, null, 2) },
    ],
    details: {
      codexTool: input.codexTool,
      piTool: input.piName,
      server: 'computer-use',
      threadId: input.threadId,
      rawResult: input.rawResult,
    },
  };
}

export function registerComputerUseTools(
  pi: { registerTool(tool: any): void },
  session: ComputerUseSession,
): void {
  for (const spec of COMPUTER_USE_TOOL_SPECS) {
    pi.registerTool({
      name: spec.piName,
      label: spec.label,
      description: spec.description,
      promptSnippet: spec.promptSnippet,
      promptGuidelines: [
        'Use computer_get_app_state before interacting with an app unless the latest Computer Use result already describes the exact current UI state.',
        'Use computer_action for click, scroll, drag, press_key, type_text, set_value, select_text, and secondary_action operations.',
        'Prefer element_index values from computer_get_app_state over screenshot coordinates when possible.',
        'Computer Use operates local GUI apps and can cause side effects; follow the bundled Computer Use confirmation policy for risky actions.',
      ],
      executionMode: 'sequential',
      parameters: spec.parameters,
      async execute(
        _toolCallId: string,
        params: any,
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) {
        const call = spec.codexTool
          ? { codexTool: spec.codexTool, arguments: params }
          : buildComputerActionCall(params);
        const { threadId, rawResult } = await session.callTool(ctx, call.codexTool, call.arguments);
        return toPiToolResult({
          threadId,
          rawResult,
          piName: spec.piName,
          codexTool: call.codexTool,
        });
      },
    });
  }
}
