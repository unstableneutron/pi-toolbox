import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

import { getCodexComputerUsePaths } from './codex-paths';
import type { ComputerUseSession } from './session';

export type BrowserBackend = 'iab' | 'chrome';

const NODE_REPL_SERVER = 'node_repl';
const NODE_REPL_JS_TOOL = 'js';

const BROWSER_BACKEND_TO_CODEX_ID: Record<BrowserBackend, string> = {
  iab: 'iab',
  chrome: 'extension',
};

const BrowserBackendParam = Type.Optional(StringEnum(['iab', 'chrome'] as const));

const CodexBrowserListParams = Type.Object({
  backend: BrowserBackendParam,
});

const CodexBrowserEvalParams = Type.Object({
  backend: BrowserBackendParam,
  script: Type.String({
    description:
      'JavaScript async function body to run with agent, browser, tab, and nodeRepl bindings.',
  }),
});

type BrowserToolParamsSchema = typeof CodexBrowserListParams | typeof CodexBrowserEvalParams;

interface BrowserRuntimeScriptInput {
  backend: BrowserBackend;
  browserClientPath: string;
}

export interface CodexBrowserEvalScriptInput extends BrowserRuntimeScriptInput {
  script: string;
}

export interface BrowserToolSpec {
  piName: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: BrowserToolParamsSchema;
}

export const BROWSER_TOOL_SPECS: BrowserToolSpec[] = [
  {
    piName: 'codex_browser_list',
    label: 'Codex Browser: List Tabs',
    description: 'List Codex browser tabs for the in-app browser or Chrome extension backend.',
    promptSnippet: 'List Codex browser tabs before choosing a tab or evaluating browser code.',
    parameters: CodexBrowserListParams,
  },
  {
    piName: 'codex_browser_eval',
    label: 'Codex Browser: Evaluate JavaScript',
    description:
      'Evaluate JavaScript in Codex.app browser runtime with agent, browser, tab, and nodeRepl bindings.',
    promptSnippet: 'Run browser-client JavaScript through Codex node_repl for browser automation.',
    parameters: CodexBrowserEvalParams,
  },
];

function quoted(value: string): string {
  return JSON.stringify(value);
}

function normalizeBackend(value: unknown): BrowserBackend {
  return value === 'chrome' ? 'chrome' : 'iab';
}

function buildBrowserRuntimePrelude({
  backend,
  browserClientPath,
}: BrowserRuntimeScriptInput): string {
  const codexBrowserId = BROWSER_BACKEND_TO_CODEX_ID[backend];
  const recoveryHint =
    backend === 'chrome'
      ? 'Open the Codex Chrome Extension side panel in Chrome or Brave, confirm it is connected, then retry.'
      : 'Open the Codex in-app Browser for this Codex thread, then retry.';

  return `if (!globalThis.agent) {
  const { setupBrowserRuntime } = await import(${quoted(browserClientPath)});
  await setupBrowserRuntime({ globals: globalThis });
}
if (!globalThis.__piCodexBrowsers) {
  globalThis.__piCodexBrowsers = {};
}
if (!globalThis.__piCodexGetBrowser) {
  globalThis.__piCodexGetBrowser = async (piBackend, codexBrowserId, unavailableMessage, recoveryHint) => {
    if (!globalThis.__piCodexBrowsers[piBackend]) {
      const __piAvailableBrowsers = await agent.browsers.list();
      const __piMatchingBrowser = __piAvailableBrowsers.find(
        (__piBrowser) => __piBrowser.id === codexBrowserId || __piBrowser.type === codexBrowserId,
      );
      if (!__piMatchingBrowser) {
        const __piAvailableSummary = __piAvailableBrowsers.length === 0
          ? "none"
          : __piAvailableBrowsers
              .map((__piBrowser) => [__piBrowser.type, __piBrowser.id].filter(Boolean).join(":"))
              .join(", ");
        throw new Error(
          unavailableMessage +
            " Available browser backends: " +
            __piAvailableSummary +
            ". " +
            recoveryHint,
        );
      }
      globalThis.__piCodexBrowsers[piBackend] = await agent.browsers.get(codexBrowserId);
    }
    return globalThis.__piCodexBrowsers[piBackend];
  };
}
globalThis.browser = await globalThis.__piCodexGetBrowser(
  ${quoted(backend)},
  ${quoted(codexBrowserId)},
  ${quoted(`No Codex ${backend} browser backend is available.`)},
  ${quoted(recoveryHint)},
);
await browser.nameSession("🔎 Pi Browser");`;
}

function buildEnsureTabBlock(backend: BrowserBackend): string {
  return `if (!globalThis.tab || globalThis.__piCodexTabBackend !== ${quoted(backend)}) {
  globalThis.tab = await browser.tabs.selected().catch(() => undefined);
  if (!globalThis.tab) {
    globalThis.tab = await browser.tabs.new();
  }
  globalThis.__piCodexTabBackend = ${quoted(backend)};
}`;
}

export function buildCodexBrowserListScript(input: BrowserRuntimeScriptInput): string {
  return `${buildBrowserRuntimePrelude(input)}
var __piSelectedTab = await browser.tabs.selected().catch(() => undefined);
var __piSelectedTabInfo = __piSelectedTab
  ? {
      id: __piSelectedTab.id,
      title: await __piSelectedTab.title().catch(() => undefined),
      url: await __piSelectedTab.url().catch(() => undefined),
    }
  : undefined;
var __piBrowserResult = {
  backend: ${quoted(input.backend)},
  browserId: browser.browserId,
  selectedTab: __piSelectedTabInfo,
  tabs: await browser.tabs.list(),
};
nodeRepl.write(JSON.stringify(__piBrowserResult, null, 2));`;
}

export function buildCodexBrowserEvalScript(input: CodexBrowserEvalScriptInput): string {
  return `${buildBrowserRuntimePrelude(input)}
${buildEnsureTabBlock(input.backend)}
var __piBrowserEvalResult = await (async ({ agent, browser, tab, nodeRepl }) => {
${input.script}
})({ agent: globalThis.agent, browser: globalThis.browser, tab: globalThis.tab, nodeRepl });
if (__piBrowserEvalResult !== undefined) {
  if (typeof __piBrowserEvalResult === "string") {
    nodeRepl.write(__piBrowserEvalResult);
  } else {
    nodeRepl.write(JSON.stringify(__piBrowserEvalResult, null, 2));
  }
}`;
}

function getBrowserClientPath(backend: BrowserBackend): string {
  const paths = getCodexComputerUsePaths();
  const script = paths.browserClientScripts[backend];
  if (!script) {
    throw new Error(
      `Codex ${backend} browser-client.mjs was not found. Refresh Codex.app bundled plugins or run pnpm run sync:skills, then retry.`,
    );
  }
  return script;
}

export function buildNodeReplJsArguments(code: string, timeoutMs: number): Record<string, unknown> {
  return {
    code,
    timeout_ms: timeoutMs,
  };
}

export function toCodexBrowserToolResult(input: {
  threadId: string;
  piName: string;
  rawResult: any;
}) {
  return {
    content: input.rawResult?.content ?? [
      { type: 'text', text: JSON.stringify(input.rawResult ?? null, null, 2) },
    ],
    details: {
      codexTool: NODE_REPL_JS_TOOL,
      piTool: input.piName,
      server: NODE_REPL_SERVER,
      threadId: input.threadId,
      rawResult: input.rawResult,
    },
  };
}

async function runNodeReplJs(
  session: ComputerUseSession,
  ctx: ExtensionContext,
  piName: string,
  code: string,
) {
  const timeoutMs = 120_000;
  const { threadId, rawResult } = await session.callMcpTool(ctx, {
    server: NODE_REPL_SERVER,
    tool: NODE_REPL_JS_TOOL,
    arguments: buildNodeReplJsArguments(code, timeoutMs),
    timeoutMs: timeoutMs + 5_000,
  });
  return toCodexBrowserToolResult({ threadId, rawResult, piName });
}

function getBrowserScriptInput(params: any): BrowserRuntimeScriptInput {
  const backend = normalizeBackend(params.backend);
  return {
    backend,
    browserClientPath: getBrowserClientPath(backend),
  };
}

export function registerCodexBrowserTools(
  pi: { registerTool(tool: any): void },
  session: ComputerUseSession,
): void {
  for (const spec of BROWSER_TOOL_SPECS) {
    pi.registerTool({
      name: spec.piName,
      label: spec.label,
      description: spec.description,
      promptSnippet: spec.promptSnippet,
      promptGuidelines: [
        'Use codex_browser_list to inspect available tabs before evaluating browser code when tab state is unclear.',
        'Use codex_browser_eval for Codex browser runtime JavaScript. The script runs as an async function body with agent, browser, tab, and nodeRepl bindings.',
        'Return JSON-serializable values from codex_browser_eval; use nodeRepl.emitImage(...) for screenshots and nodeRepl.write(...) for exact text output.',
        'Browser actions operate live pages; follow the synced Codex browser safety and confirmation policy before risky side effects.',
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
        const input = getBrowserScriptInput(params);

        if (spec.piName === 'codex_browser_list') {
          return await runNodeReplJs(session, ctx, spec.piName, buildCodexBrowserListScript(input));
        }

        return await runNodeReplJs(
          session,
          ctx,
          spec.piName,
          buildCodexBrowserEvalScript({ ...input, script: params.script }),
        );
      },
    });
  }
}
