import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

import { runChromeDebugBrowserEval, runChromeDebugBrowserList } from './chrome-debug-browser';
import { getCodexComputerUsePaths } from './codex-paths';
import type { ComputerUseSession } from './session';

type BrowserBackend = 'iab' | 'chrome';

const NODE_REPL_SERVER = 'node_repl';
const NODE_REPL_JS_TOOL = 'js';
const BROWSER_RESULT_START = '<<<pi-codex-browser-result:start>>>';
const BROWSER_RESULT_END = '<<<pi-codex-browser-result:end>>>';

const BROWSER_BACKEND_TO_CODEX_ID: Record<BrowserBackend, string> = {
  iab: 'iab',
  chrome: 'extension',
};

const BrowserBackendParam = Type.Optional(StringEnum(['iab', 'chrome'] as const));

const CodexBrowserListParams = Type.Object({
  backend: BrowserBackendParam,
  debugUrl: Type.Optional(
    Type.String({ description: 'Chrome/Brave DevTools base URL, e.g. http://127.0.0.1:9224.' }),
  ),
  extensionId: Type.Optional(
    Type.String({ description: 'Codex Chrome extension ID to verify/use for Chrome backend.' }),
  ),
});

const CodexBrowserEvalParams = Type.Object({
  backend: BrowserBackendParam,
  debugUrl: Type.Optional(
    Type.String({ description: 'Chrome/Brave DevTools base URL, e.g. http://127.0.0.1:9224.' }),
  ),
  extensionId: Type.Optional(
    Type.String({ description: 'Codex Chrome extension ID to verify/use for Chrome backend.' }),
  ),
  script: Type.String({
    description:
      'JavaScript async function body to run with agent, browser, tab, and nodeRepl bindings.',
  }),
});

type BrowserToolParamsSchema = typeof CodexBrowserListParams | typeof CodexBrowserEvalParams;

interface BrowserRuntimeScriptInput {
  backend: BrowserBackend;
  browserClientPath: string;
  debugUrl?: string;
  extensionId?: string;
}

interface CodexBrowserEvalScriptInput extends BrowserRuntimeScriptInput {
  script: string;
}

interface BrowserToolSpec {
  piName: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: BrowserToolParamsSchema;
}

interface ChromeDebugBrowserToolOptions {
  debugUrl?: string;
  extensionId?: string;
}

interface ChromeNativeBridgeOptions {
  debugBaseUrl?: string;
  extensionId?: string;
}

interface BrowserToolRuntimeDeps {
  runChromeDebugBrowserEval?: typeof runChromeDebugBrowserEval;
  runChromeDebugBrowserList?: typeof runChromeDebugBrowserList;
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

function buildBrowserRuntimeNoiseFilterScript(): string {
  return `if (!globalThis.__piCodexOriginalConsole) {
  globalThis.__piCodexOriginalConsole = globalThis.console;
}
if (!globalThis.__piCodexIsBrowserRuntimeNoise) {
  globalThis.__piCodexIsBrowserRuntimeNoise = (__piArgs) => {
    const __piText = __piArgs
      .map((__piArg) => {
        if (typeof __piArg === "string") return __piArg;
        try { return JSON.stringify(__piArg); } catch { return String(__piArg); }
      })
      .join(" ");
    return __piText.includes("IAB_DISCOVERY") ||
      __piText.includes("[Statsig]") ||
      __piText.includes("oaistatsig.com") ||
      __piText.includes("selectedBrowser") ||
      (__piArgs.length === 1 &&
        __piArgs[0] &&
        typeof __piArgs[0] === "object" &&
        Object.prototype.hasOwnProperty.call(__piArgs[0], "selectedBrowser"));
  };
}
if (typeof process !== "undefined" && process?.stdout?.write && process?.stderr?.write && !globalThis.__piCodexOriginalProcessWrites) {
  globalThis.__piCodexOriginalProcessWrites = {
    stdout: process.stdout.write.bind(process.stdout),
    stderr: process.stderr.write.bind(process.stderr),
  };
  const __piWrapProcessWrite = (__piStreamName) => {
    const __piOriginalWrite = globalThis.__piCodexOriginalProcessWrites[__piStreamName];
    return (__piChunk, ...__piRest) => {
      const __piText = typeof __piChunk === "string"
        ? __piChunk
        : (typeof Buffer !== "undefined" && Buffer.isBuffer(__piChunk) ? __piChunk.toString("utf8") : String(__piChunk));
      if (globalThis.__piCodexIsBrowserRuntimeNoise([__piText])) return true;
      return __piOriginalWrite(__piChunk, ...__piRest);
    };
  };
  process.stdout.write = __piWrapProcessWrite("stdout");
  process.stderr.write = __piWrapProcessWrite("stderr");
}
if (!globalThis.__piCodexFilteredConsole) {
  const __piOriginalConsole = globalThis.__piCodexOriginalConsole;
  const __piFilteredConsole = Object.create(__piOriginalConsole ?? null);
  for (const __piMethod of ["debug", "error", "info", "log", "warn"]) {
    const __piOriginalMethod = __piOriginalConsole?.[__piMethod]?.bind(__piOriginalConsole);
    __piFilteredConsole[__piMethod] = (...__piArgs) => {
      if (globalThis.__piCodexIsBrowserRuntimeNoise(__piArgs)) return;
      return __piOriginalMethod?.(...__piArgs);
    };
  }
  globalThis.__piCodexFilteredConsole = __piFilteredConsole;
}
globalThis.console = globalThis.__piCodexFilteredConsole;`;
}

function buildNodeReplResultWrapperScript(): string {
  return `var __piNodeRepl = Object.create(nodeRepl);
Object.defineProperty(__piNodeRepl, "write", {
  configurable: true,
  value: (__piValue) => nodeRepl.write(${quoted(BROWSER_RESULT_START)} + "\\n" + String(__piValue) + "\\n" + ${quoted(BROWSER_RESULT_END)}),
});`;
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

  return `${buildBrowserRuntimeNoiseFilterScript()}
${buildNodeReplResultWrapperScript()}
if (!globalThis.agent) {
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
__piNodeRepl.write(JSON.stringify(__piBrowserResult, null, 2));`;
}

export function buildCodexBrowserEvalScript(input: CodexBrowserEvalScriptInput): string {
  return `${buildBrowserRuntimePrelude(input)}
${buildEnsureTabBlock(input.backend)}
var __piBrowserEvalResult = await (async ({ agent, browser, tab, nodeRepl }) => {
${input.script}
})({ agent: globalThis.agent, browser: globalThis.browser, tab: globalThis.tab, nodeRepl: __piNodeRepl });
if (__piBrowserEvalResult !== undefined) {
  if (typeof __piBrowserEvalResult === "string") {
    __piNodeRepl.write(__piBrowserEvalResult);
  } else {
    __piNodeRepl.write(JSON.stringify(__piBrowserEvalResult, null, 2));
  }
}`;
}

function getBrowserClientPath(backend: BrowserBackend): string {
  const paths = getCodexComputerUsePaths();
  const script = paths.browserClientScripts[backend];
  if (!script) {
    throw new Error(
      `Codex ${backend} browser-client.mjs was not found. Install or update the matching Codex.app bundled plugin, then retry.`,
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

function normalizeDelimitedBrowserOutput(value: string): string {
  let output = value;
  if (output.startsWith('\r\n')) output = output.slice(2);
  else if (output.startsWith('\n')) output = output.slice(1);
  if (output.endsWith('\r\n')) output = output.slice(0, -2);
  else if (output.endsWith('\n')) output = output.slice(0, -1);
  return output;
}

function extractDelimitedBrowserOutput(value: string): string[] {
  const outputs: string[] = [];
  let cursor = 0;
  while (true) {
    const start = value.indexOf(BROWSER_RESULT_START, cursor);
    if (start < 0) break;
    const contentStart = start + BROWSER_RESULT_START.length;
    const end = value.indexOf(BROWSER_RESULT_END, contentStart);
    if (end < 0) break;
    outputs.push(normalizeDelimitedBrowserOutput(value.slice(contentStart, end)));
    cursor = end + BROWSER_RESULT_END.length;
  }
  return outputs;
}

function sanitizeBrowserToolContent(content: any[] | undefined): any[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const textOutputs: string[] = [];
  const nonTextContent: any[] = [];

  for (const part of content) {
    if (part?.type === 'text' && 'string' === typeof part.text) {
      textOutputs.push(...extractDelimitedBrowserOutput(part.text));
    } else {
      nonTextContent.push(part);
    }
  }

  if (textOutputs.length === 0) return content;
  return [...textOutputs.map((text) => ({ type: 'text', text })), ...nonTextContent];
}

export function toCodexBrowserToolResult(input: {
  threadId: string;
  piName: string;
  rawResult: any;
}) {
  return {
    content: sanitizeBrowserToolContent(input.rawResult?.content) ?? [
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
  backend: BrowserBackend,
  code: string,
  signal?: AbortSignal,
  chromeOptions: ChromeNativeBridgeOptions = {},
) {
  const timeoutMs = 120_000;
  const { threadId, rawResult } = await session.callBrowserMcpTool(
    ctx,
    backend,
    {
      server: NODE_REPL_SERVER,
      tool: NODE_REPL_JS_TOOL,
      arguments: buildNodeReplJsArguments(code, timeoutMs),
      timeoutMs: timeoutMs + 5_000,
    },
    signal,
    chromeOptions,
  );
  return toCodexBrowserToolResult({ threadId, rawResult, piName });
}

function isChromeBridgeUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Codex extension-host WebSocket upgrade') ||
    message.includes('Could not find a debuggable Codex Chrome Extension') ||
    message.includes('Could not open a debuggable Codex Chrome Extension page') ||
    message.includes('No handler registered for method: ensureCodexAppServer')
  );
}

function getBrowserScriptInput(params: any): BrowserRuntimeScriptInput {
  const backend = normalizeBackend(params.backend);
  return {
    backend,
    browserClientPath: getBrowserClientPath(backend),
    ...(typeof params.debugUrl === 'string' && params.debugUrl.trim().length > 0
      ? { debugUrl: params.debugUrl.trim() }
      : {}),
    ...(typeof params.extensionId === 'string' && params.extensionId.trim().length > 0
      ? { extensionId: params.extensionId.trim() }
      : {}),
  };
}

export function registerCodexBrowserTools(
  pi: { registerTool(tool: any): void },
  session: ComputerUseSession,
  deps: BrowserToolRuntimeDeps = {},
): void {
  const runDirectChromeList = deps.runChromeDebugBrowserList ?? runChromeDebugBrowserList;
  const runDirectChromeEval = deps.runChromeDebugBrowserEval ?? runChromeDebugBrowserEval;
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
        signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) {
        const input = getBrowserScriptInput(params);
        const chromeOptions: ChromeDebugBrowserToolOptions = {
          ...(input.debugUrl ? { debugUrl: input.debugUrl } : {}),
          ...(input.extensionId ? { extensionId: input.extensionId } : {}),
        };
        const chromeNativeOptions: ChromeNativeBridgeOptions = {
          ...(input.debugUrl ? { debugBaseUrl: input.debugUrl } : {}),
          ...(input.extensionId ? { extensionId: input.extensionId } : {}),
        };

        if (spec.piName === 'codex_browser_list') {
          try {
            return await runNodeReplJs(
              session,
              ctx,
              spec.piName,
              input.backend,
              buildCodexBrowserListScript(input),
              signal,
              chromeNativeOptions,
            );
          } catch (error) {
            if (input.backend !== 'chrome' || !isChromeBridgeUnavailableError(error)) throw error;
            return await runDirectChromeList(chromeOptions);
          }
        }

        try {
          return await runNodeReplJs(
            session,
            ctx,
            spec.piName,
            input.backend,
            buildCodexBrowserEvalScript({ ...input, script: params.script }),
            signal,
            chromeNativeOptions,
          );
        } catch (error) {
          if (input.backend !== 'chrome' || !isChromeBridgeUnavailableError(error)) throw error;
          return await runDirectChromeEval({ ...chromeOptions, script: params.script });
        }
      },
    });
  }
}
