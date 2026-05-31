import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type, type Static } from 'typebox';

import type { ComputerUseSession } from './session';

const AppParam = Type.String({
  description: 'App name, full app path, or unambiguous bundle identifier',
});

const ElementIndexParam = Type.String({ description: 'Element identifier from get_app_state' });

const ListAppsParams = Type.Object({});
const GetAppStateParams = Type.Object({ app: AppParam });
const ClickParams = Type.Object({
  app: AppParam,
  element_index: Type.Optional(Type.String({ description: 'Element index to click' })),
  x: Type.Optional(Type.Number({ description: 'X coordinate in screenshot pixels' })),
  y: Type.Optional(Type.Number({ description: 'Y coordinate in screenshot pixels' })),
  mouse_button: Type.Optional(StringEnum(['left', 'right', 'middle'] as const)),
  click_count: Type.Optional(Type.Integer({ description: 'Number of clicks. Defaults to 1' })),
});
const ScrollParams = Type.Object({
  app: AppParam,
  element_index: ElementIndexParam,
  direction: StringEnum(['up', 'down', 'left', 'right'] as const),
  pages: Type.Optional(
    Type.Number({ description: 'Number of pages to scroll; fractional values are supported' }),
  ),
});
const DragParams = Type.Object({
  app: AppParam,
  from_x: Type.Number({ description: 'Start X coordinate' }),
  from_y: Type.Number({ description: 'Start Y coordinate' }),
  to_x: Type.Number({ description: 'End X coordinate' }),
  to_y: Type.Number({ description: 'End Y coordinate' }),
});
const PressKeyParams = Type.Object({
  app: AppParam,
  key: Type.String({ description: 'Key or key combination, e.g. Return, Tab, super+c' }),
});
const TypeTextParams = Type.Object({ app: AppParam, text: Type.String() });
const SetValueParams = Type.Object({
  app: AppParam,
  element_index: ElementIndexParam,
  value: Type.String({ description: 'Value to assign' }),
});
const SelectTextParams = Type.Object({
  app: AppParam,
  element_index: ElementIndexParam,
  text: Type.String({ description: 'Target text as shown in the accessibility tree' }),
  prefix: Type.Optional(Type.String()),
  suffix: Type.Optional(Type.String()),
  selection: Type.Optional(StringEnum(['text', 'cursor_before', 'cursor_after'] as const)),
});
const SecondaryActionParams = Type.Object({
  app: AppParam,
  element_index: ElementIndexParam,
  action: Type.String({ description: 'Secondary accessibility action name' }),
});

type ToolParamsSchema =
  | typeof ListAppsParams
  | typeof GetAppStateParams
  | typeof ClickParams
  | typeof ScrollParams
  | typeof DragParams
  | typeof PressKeyParams
  | typeof TypeTextParams
  | typeof SetValueParams
  | typeof SelectTextParams
  | typeof SecondaryActionParams;

export interface ComputerUseToolSpec {
  piName: string;
  label: string;
  codexTool: string;
  description: string;
  promptSnippet: string;
  parameters: ToolParamsSchema;
}

export const COMPUTER_USE_TOOL_SPECS: ComputerUseToolSpec[] = [
  {
    piName: 'computer_use_list_apps',
    label: 'Computer Use: List Apps',
    codexTool: 'list_apps',
    description: 'List apps visible to Codex.app native Computer Use.',
    promptSnippet: 'List local Mac apps available through Codex Computer Use.',
    parameters: ListAppsParams,
  },
  {
    piName: 'computer_use_get_app_state',
    label: 'Computer Use: Get App State',
    codexTool: 'get_app_state',
    description:
      'Get a screenshot and accessibility tree for an app through Codex native Computer Use.',
    promptSnippet: 'Inspect a Mac app before interacting with it through Computer Use.',
    parameters: GetAppStateParams,
  },
  {
    piName: 'computer_use_click',
    label: 'Computer Use: Click',
    codexTool: 'click',
    description:
      'Click an accessibility element or screenshot coordinate through Codex native Computer Use.',
    promptSnippet: 'Click a local Mac UI element by element index or coordinates.',
    parameters: ClickParams,
  },
  {
    piName: 'computer_use_scroll',
    label: 'Computer Use: Scroll',
    codexTool: 'scroll',
    description: 'Scroll an accessibility element through Codex native Computer Use.',
    promptSnippet: 'Scroll a local Mac UI element by element index.',
    parameters: ScrollParams,
  },
  {
    piName: 'computer_use_drag',
    label: 'Computer Use: Drag',
    codexTool: 'drag',
    description: 'Drag between screenshot coordinates through Codex native Computer Use.',
    promptSnippet: 'Drag between coordinates in a local Mac app.',
    parameters: DragParams,
  },
  {
    piName: 'computer_use_press_key',
    label: 'Computer Use: Press Key',
    codexTool: 'press_key',
    description: 'Press a key or key chord in an app through Codex native Computer Use.',
    promptSnippet: 'Press keys in a local Mac app.',
    parameters: PressKeyParams,
  },
  {
    piName: 'computer_use_type_text',
    label: 'Computer Use: Type Text',
    codexTool: 'type_text',
    description: 'Type literal text into the focused app through Codex native Computer Use.',
    promptSnippet: 'Type text into the focused local Mac control.',
    parameters: TypeTextParams,
  },
  {
    piName: 'computer_use_set_value',
    label: 'Computer Use: Set Value',
    codexTool: 'set_value',
    description: 'Set a settable accessibility element value through Codex native Computer Use.',
    promptSnippet: 'Set the value of an accessibility element by element index.',
    parameters: SetValueParams,
  },
  {
    piName: 'computer_use_select_text',
    label: 'Computer Use: Select Text',
    codexTool: 'select_text',
    description:
      'Select text or place the cursor in a text element through Codex native Computer Use.',
    promptSnippet: 'Select text or place a cursor inside a text element.',
    parameters: SelectTextParams,
  },
  {
    piName: 'computer_use_secondary_action',
    label: 'Computer Use: Secondary Action',
    codexTool: 'perform_secondary_action',
    description: 'Invoke a secondary accessibility action exposed by an element.',
    promptSnippet: 'Invoke a secondary action such as Open on a local Mac accessibility element.',
    parameters: SecondaryActionParams,
  },
];

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
        'Use computer_use_get_app_state before interacting with an app unless the latest Computer Use result already describes the exact current UI state.',
        'Prefer element_index values from computer_use_get_app_state over screenshot coordinates when possible.',
        'Computer Use operates local GUI apps and can cause side effects; follow the bundled Computer Use confirmation policy for risky actions.',
      ],
      executionMode: 'sequential',
      parameters: spec.parameters,
      async execute(
        _toolCallId: string,
        params: Static<typeof spec.parameters>,
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) {
        const { threadId, rawResult } = await session.callTool(ctx, spec.codexTool, params);
        return toPiToolResult({
          threadId,
          rawResult,
          piName: spec.piName,
          codexTool: spec.codexTool,
        });
      },
    });
  }
}
