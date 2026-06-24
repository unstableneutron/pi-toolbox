import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai/compat';
import { Type } from 'typebox';

import { renderComputerToolCall, renderComputerToolResult } from './rendering';
import type { ComputerUseSession } from './session';

const AppParam = Type.String({
  description: 'App name, full app path, or unambiguous bundle identifier',
});

const SelectTextAppParam = Type.String({ description: 'App name or bundle identifier' });
const ElementIndexParam = Type.String({ description: 'Element identifier' });

const ListAppsParams = Type.Object({}, { additionalProperties: false });
const GetAppStateParams = Type.Object({ app: AppParam });
const ClickParams = Type.Object({
  app: AppParam,
  element_index: Type.Optional(Type.String({ description: 'Element index to click' })),
  x: Type.Optional(Type.Number({ description: 'X coordinate in screenshot pixel coordinates' })),
  y: Type.Optional(Type.Number({ description: 'Y coordinate in screenshot pixel coordinates' })),
  click_count: Type.Optional(Type.Integer({ description: 'Number of clicks. Defaults to 1' })),
  mouse_button: Type.Optional(
    StringEnum(['left', 'right', 'middle'] as const, {
      description: 'Mouse button to click. Defaults to left.',
    }),
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
  key: Type.String({ description: 'Key or key combination to press' }),
});
const TypeTextParams = Type.Object({
  app: AppParam,
  text: Type.String({ description: 'Literal text to type' }),
});
const ScrollParams = Type.Object({
  app: AppParam,
  element_index: ElementIndexParam,
  direction: Type.String({ description: 'Scroll direction: up, down, left, or right' }),
  pages: Type.Optional(
    Type.Number({
      description: 'Number of pages to scroll. Fractional values are supported. Defaults to 1',
    }),
  ),
});
const SelectTextParams = Type.Object({
  app: SelectTextAppParam,
  element_index: Type.String({ description: 'Text element identifier' }),
  text: Type.String({ description: 'Target text as shown in the accessibility tree' }),
  prefix: Type.Optional(
    Type.String({
      description:
        'Optional text immediately before the target, used to disambiguate repeated matches',
    }),
  ),
  suffix: Type.Optional(
    Type.String({
      description:
        'Optional text immediately after the target, used to disambiguate repeated matches',
    }),
  ),
  selection: Type.Optional(
    StringEnum(['text', 'cursor_before', 'cursor_after'] as const, {
      description:
        'Whether to select the text or place the cursor before or after it. Defaults to text.',
    }),
  ),
});
const SetValueParams = Type.Object({
  app: AppParam,
  element_index: ElementIndexParam,
  value: Type.String({ description: 'Value to assign' }),
});
const PerformSecondaryActionParams = Type.Object({
  app: AppParam,
  element_index: ElementIndexParam,
  action: Type.String({ description: 'Secondary accessibility action name' }),
});

type ToolParamsSchema =
  | typeof ListAppsParams
  | typeof GetAppStateParams
  | typeof ClickParams
  | typeof DragParams
  | typeof PressKeyParams
  | typeof TypeTextParams
  | typeof ScrollParams
  | typeof SelectTextParams
  | typeof SetValueParams
  | typeof PerformSecondaryActionParams;

interface ComputerUseToolSpec {
  piName: string;
  label: string;
  codexTool: string;
  description: string;
  promptSnippet: string;
  promptGuidelines?: string[];
  parameters: ToolParamsSchema;
}

const COMMON_COMPUTER_USE_GUIDELINES = [
  'Call computer_get_app_state once per assistant turn before interacting with an app unless the latest Computer Use result already describes the exact current UI state.',
  'Prefer element_index values from computer_get_app_state over screenshot coordinates when possible.',
  'Computer Use operates local GUI apps and can cause side effects; follow the bundled Computer Use confirmation policy for risky actions.',
];

export const COMPUTER_USE_TOOL_SPECS: ComputerUseToolSpec[] = [
  {
    piName: 'computer_list_apps',
    label: 'Computer: List Apps',
    codexTool: 'list_apps',
    description:
      'List the apps on this computer. Returns the set of apps that are currently running, as well as any that have been used in the last 14 days, including details on usage frequency.',
    promptSnippet: 'List local Mac apps available through Computer Use.',
    parameters: ListAppsParams,
  },
  {
    piName: 'computer_get_app_state',
    label: 'Computer: Get App State',
    codexTool: 'get_app_state',
    description:
      "Start an app use session if needed, then get the state of the app's key window and return a screenshot and accessibility tree. This must be called once per assistant turn before interacting with the app.",
    promptSnippet: 'Inspect an app screenshot and accessibility tree before interacting with it.',
    parameters: GetAppStateParams,
  },
  {
    piName: 'computer_click',
    label: 'Computer: Click',
    codexTool: 'click',
    description: 'Click an element by index or pixel coordinates from screenshot.',
    promptSnippet: 'Click a Computer Use element index or screenshot coordinate.',
    promptGuidelines: [
      'Provide either element_index or both x and y. Prefer element_index when available.',
    ],
    parameters: ClickParams,
  },
  {
    piName: 'computer_drag',
    label: 'Computer: Drag',
    codexTool: 'drag',
    description: 'Drag from one point to another using pixel coordinates.',
    promptSnippet: 'Drag between two screenshot pixel coordinates.',
    parameters: DragParams,
  },
  {
    piName: 'computer_press_key',
    label: 'Computer: Press Key',
    codexTool: 'press_key',
    description:
      'Press a key or key-combination on the keyboard, including modifier and navigation keys. This supports xdotool key syntax. Examples: "a", "Return", "Tab", "super+c", "Up", "KP_0".',
    promptSnippet: 'Press a key or key-combination using xdotool syntax.',
    parameters: PressKeyParams,
  },
  {
    piName: 'computer_type_text',
    label: 'Computer: Type Text',
    codexTool: 'type_text',
    description: 'Type literal text using keyboard input.',
    promptSnippet: 'Type literal text into the focused app control.',
    parameters: TypeTextParams,
  },
  {
    piName: 'computer_scroll',
    label: 'Computer: Scroll',
    codexTool: 'scroll',
    description: 'Scroll an element in a direction by a number of pages.',
    promptSnippet: 'Scroll an element up, down, left, or right by pages.',
    parameters: ScrollParams,
  },
  {
    piName: 'computer_select_text',
    label: 'Computer: Select Text',
    codexTool: 'select_text',
    description:
      'Select text inside a text element, or place the text cursor before or after it. Provide text exactly as it appears in the accessibility tree, including any Markdown formatting. If the text is not unique, provide surrounding prefix or suffix text to disambiguate it.',
    promptSnippet: 'Select exact accessibility-tree text or place the cursor before or after it.',
    promptGuidelines: [
      'Provide text exactly as it appears in the accessibility tree, including any Markdown formatting.',
      'Use prefix or suffix when the target text is not unique.',
    ],
    parameters: SelectTextParams,
  },
  {
    piName: 'computer_set_value',
    label: 'Computer: Set Value',
    codexTool: 'set_value',
    description: 'Set the value of a settable accessibility element.',
    promptSnippet: 'Set the value of a settable accessibility element.',
    parameters: SetValueParams,
  },
  {
    piName: 'computer_perform_secondary_action',
    label: 'Computer: Perform Secondary Action',
    codexTool: 'perform_secondary_action',
    description: 'Invoke a secondary accessibility action exposed by an element.',
    promptSnippet: 'Invoke a secondary accessibility action exposed by an element.',
    parameters: PerformSecondaryActionParams,
  },
];

interface ToPiToolResultInput {
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
      promptGuidelines: [...COMMON_COMPUTER_USE_GUIDELINES, ...(spec.promptGuidelines ?? [])],
      executionMode: 'sequential',
      parameters: spec.parameters,
      renderCall: (args: unknown, theme: any) => renderComputerToolCall(spec.piName, args, theme),
      renderResult: renderComputerToolResult,
      async execute(
        _toolCallId: string,
        params: any,
        signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) {
        const { threadId, rawResult } = await session.callTool(ctx, spec.codexTool, params, signal);
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
