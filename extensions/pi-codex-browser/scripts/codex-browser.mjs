#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_SOCKET_DIR,
  createConnectedChromeClient,
  discoverBrowserUseBackends,
  selectChromeBackends,
} from './browser-use-protocol.mjs';
import { sendBridgeCommand } from './codex-browser-bridge.mjs';
import {
  CodexControlClient,
  getMcpText,
} from '../../pi-codex-computer-use/scripts/codex-control.mjs';

const COMMANDS = new Set([
  'doctor',
  'chrome_backends_list',
  'chrome_tabs_list',
  'chrome_tab_new',
  'chrome_tab_claim',
  'chrome_tab_goto',
  'chrome_execute_command',
  'httpbin_form_demo',
  'x_feed_top20',
  'bridge_snippet',
  'raw',
  'help',
]);

const DEFAULT_APP_SERVER_SOCKET = path.join(
  os.homedir(),
  '.codex/app-server-control/app-server-control.sock',
);
const DEFAULT_CHROME_BROWSER_CLIENT_PATH = path.join(
  os.homedir(),
  '.codex/plugins/cache/openai-bundled/chrome/latest/scripts/browser-client.mjs',
);
const NODE_REPL_RESULT_START = '<<<codex-browser:start>>>';
const NODE_REPL_RESULT_END = '<<<codex-browser:end>>>';

function parseJsonArgument(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label}: ${message}`);
  }
}

function parseNumberArgument(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} requires a number`);
  return number;
}

function takeValue(rest, flag) {
  const value = rest.shift();
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

function normalizeCommandArgv(argv) {
  const rest = [...argv];
  const options = {};
  let json = false;

  while (rest.length > 0) {
    const next = rest[0];
    if (next === '--json') {
      json = true;
      rest.shift();
    } else if (next === '--socket-dir') {
      rest.shift();
      options.socketDir = takeValue(rest, '--socket-dir');
    } else if (next === '--socket') {
      rest.shift();
      options.socketPath = takeValue(rest, '--socket');
    } else if (next === '--timeout-ms' || next === '--timeout') {
      rest.shift();
      options.requestTimeoutMs = parseNumberArgument(takeValue(rest, next), next);
    } else if (next === '--session-id') {
      rest.shift();
      options.sessionId = takeValue(rest, '--session-id');
    } else if (next === '--turn-id') {
      rest.shift();
      options.turnId = takeValue(rest, '--turn-id');
    } else if (next === '--thread-id') {
      rest.shift();
      options.threadId = takeValue(rest, '--thread-id');
    } else if (next === '--app-server-socket') {
      rest.shift();
      options.appServerSocket = takeValue(rest, '--app-server-socket');
    } else if (next === '--browser-client-path') {
      rest.shift();
      options.browserClientPath = takeValue(rest, '--browser-client-path');
    } else if (next === '--bridge-socket') {
      rest.shift();
      options.bridgeSocket = takeValue(rest, '--bridge-socket');
    } else if (next === '--help' || next === '-h') {
      rest.shift();
      rest.unshift('help');
      break;
    } else {
      break;
    }
  }

  const command = rest.shift() ?? 'help';
  if (!COMMANDS.has(command)) throw new Error(`Unknown command: ${command}`);
  return { command, json, options, rest };
}

function parseCommandOptions(parsed) {
  const { command, options, rest } = parsed;

  if (command === 'raw') {
    const method = rest.shift();
    if (!method) throw new Error('raw requires <method>');
    options.method = method;
  }

  while (rest.length > 0) {
    const next = rest.shift();
    if (next === '--limit') {
      options.limit = parseNumberArgument(takeValue(rest, '--limit'), '--limit');
    } else if (next === '--socket-dir') {
      options.socketDir = takeValue(rest, '--socket-dir');
    } else if (next === '--socket') {
      options.socketPath = takeValue(rest, '--socket');
    } else if (next === '--timeout-ms' || next === '--timeout') {
      options.requestTimeoutMs = parseNumberArgument(takeValue(rest, next), next);
    } else if (next === '--session-id') {
      options.sessionId = takeValue(rest, '--session-id');
    } else if (next === '--turn-id') {
      options.turnId = takeValue(rest, '--turn-id');
    } else if (next === '--thread-id') {
      options.threadId = takeValue(rest, '--thread-id');
    } else if (next === '--app-server-socket') {
      options.appServerSocket = takeValue(rest, '--app-server-socket');
    } else if (next === '--browser-client-path') {
      options.browserClientPath = takeValue(rest, '--browser-client-path');
    } else if (next === '--bridge-socket') {
      options.bridgeSocket = takeValue(rest, '--bridge-socket');
    } else if (next === '--params-json') {
      options.params = parseJsonArgument(takeValue(rest, '--params-json'), '--params-json');
    } else if (next === '--tab-id' || next === '--tab') {
      options.tabId = parseNumberArgument(takeValue(rest, next), next);
    } else if (next === '--url') {
      options.url = takeValue(rest, '--url');
    } else if (next === '--command-json') {
      options.commandParams = parseJsonArgument(
        takeValue(rest, '--command-json'),
        '--command-json',
      );
    } else if (next === '--items') {
      options.items = parseNumberArgument(takeValue(rest, '--items'), '--items');
    } else if (next === '--comment-items') {
      options.commentItems = parseNumberArgument(
        takeValue(rest, '--comment-items'),
        '--comment-items',
      );
    } else if (next === '--comments-per-item') {
      options.commentsPerItem = parseNumberArgument(
        takeValue(rest, '--comments-per-item'),
        '--comments-per-item',
      );
    } else if (command === 'chrome_tab_goto' && !options.url) {
      options.url = next;
    } else if (command === 'chrome_execute_command' && !options.commandParams) {
      options.commandParams = parseJsonArgument(next, 'command-json');
    } else {
      throw new Error(`Unexpected argument: ${next}`);
    }
  }

  if (command === 'raw' && !options.params) options.params = {};
  return { command: parsed.command, json: parsed.json, options };
}

export function parseArgv(argv = process.argv.slice(2)) {
  return parseCommandOptions(normalizeCommandArgv(argv));
}

function connectionOptions(options) {
  return {
    ...(options.requestTimeoutMs ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.socketDir ? { socketDir: options.socketDir } : {}),
    ...(options.socketPath ? { socketPath: options.socketPath } : {}),
    ...(options.turnId ? { turnId: options.turnId } : {}),
  };
}

async function withChromeClient(options, fn) {
  const connection = await createConnectedChromeClient(connectionOptions(options));
  try {
    return await fn(connection);
  } finally {
    await connection.client.close().catch(() => {});
  }
}

function extractTabs(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.tabs)) return result.tabs;
  if (Array.isArray(result?.userTabs)) return result.userTabs;
  return [];
}

function extractTabId(value) {
  if (typeof value === 'number') return value;
  if (typeof value?.id === 'number') return value.id;
  if (typeof value?.tabId === 'number') return value.tabId;
  if (typeof value?.tab_id === 'number') return value.tab_id;
  if (typeof value?.tab?.id === 'number') return value.tab.id;
  if (typeof value?.tab?.tabId === 'number') return value.tab.tabId;
  return null;
}

function truncateTabs(result, limit) {
  if (!limit) return result;
  const tabs = extractTabs(result);
  if (tabs.length === 0) return result;
  return { tabs: tabs.slice(0, limit), totalTabs: tabs.length };
}

async function runDoctor(options) {
  const discovery = await discoverBrowserUseBackends(connectionOptions(options));
  const chrome = selectChromeBackends(discovery.candidates);
  return {
    ok: chrome.selected.length > 0,
    socketDir: discovery.socketDir,
    socketCount: discovery.socketCount,
    socketListingError: discovery.socketListingError,
    backendCount: discovery.candidates.filter((candidate) => candidate.ok).length,
    selectedBackendCount: chrome.selected.length,
    selectedBackend: chrome.selected[0] ?? null,
    candidates: chrome.candidates,
  };
}

function buildTurnMetadata(threadId, prefix = 'pi-codex-browser') {
  return {
    'x-codex-turn-metadata': {
      session_id: threadId,
      thread_id: threadId,
      thread_source: 'user',
      turn_id: `${prefix}-${Date.now()}`,
    },
  };
}

function extractDelimitedJson(text) {
  const start = text.indexOf(NODE_REPL_RESULT_START);
  if (start < 0) return null;
  const contentStart = start + NODE_REPL_RESULT_START.length;
  const end = text.indexOf(NODE_REPL_RESULT_END, contentStart);
  if (end < 0) return null;
  const json = text.slice(contentStart, end).trim();
  return JSON.parse(json);
}

async function callNodeReplJson(options, code) {
  if (!options.threadId) throw new Error('App-server transport requires --thread-id');
  const timeoutMs = options.requestTimeoutMs ?? 120_000;
  const client = new CodexControlClient({
    requestTimeoutMs: timeoutMs + 10_000,
    socketPath: options.appServerSocket ?? DEFAULT_APP_SERVER_SOCKET,
  });
  try {
    await client.connect();
    await client.initialize('pi-codex-browser');
    await client.request(
      'thread/resume',
      { threadId: options.threadId, excludeTurns: true },
      60_000,
    );
    const rawResult = await client.request(
      'mcpServer/tool/call',
      {
        threadId: options.threadId,
        server: 'node_repl',
        tool: 'js',
        arguments: { code, timeout_ms: timeoutMs },
        _meta: buildTurnMetadata(options.threadId),
      },
      timeoutMs + 20_000,
    );
    const text = getMcpText(rawResult);
    const parsed = extractDelimitedJson(text);
    if (parsed == null) {
      return {
        isError: rawResult?.isError === true,
        rawText: text,
        rawResult,
      };
    }
    return parsed;
  } finally {
    client.close();
  }
}

function buildBridgeSnippet(options) {
  const bridgeSocketPath = options.bridgeSocket ?? '/tmp/codex-browser-node-repl-bridge.sock';
  const bridgeModulePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'codex-browser-bridge.mjs',
  );
  return `const { startCodexBrowserBridge } = await import(${JSON.stringify(bridgeModulePath)});
globalThis.__codexBrowserBridge = await startCodexBrowserBridge({
  bridgeSocketPath: ${JSON.stringify(bridgeSocketPath)},
  requestMeta: nodeRepl.requestMeta,
});
nodeRepl.write(JSON.stringify({
  ok: true,
  bridgeSocketPath: globalThis.__codexBrowserBridge.bridgeSocketPath,
  backend: globalThis.__codexBrowserBridge.backend,
}, null, 2));`;
}

async function callBridgeCommand(options, command) {
  if (!options.bridgeSocket) throw new Error('Bridge transport requires --bridge-socket');
  return await sendBridgeCommand(
    options.bridgeSocket,
    command,
    options,
    options.requestTimeoutMs ?? 120_000,
  );
}

function browserPrelude(options) {
  const browserClientPath = options.browserClientPath ?? DEFAULT_CHROME_BROWSER_CLIENT_PATH;
  return `
if (!globalThis.__piCodexBrowserDescribeTab) {
  globalThis.__piCodexBrowserDescribeTab = async (tab) => ({
    id: tab.id,
    title: await tab.title().catch(() => undefined),
    url: await tab.url().catch(() => undefined),
  });
}
if (!globalThis.__piCodexBrowserGetChrome) {
  globalThis.__piCodexBrowserGetChrome = async () => {
    const { setupBrowserRuntime } = await import(${JSON.stringify(browserClientPath)});
    await setupBrowserRuntime({ globals: globalThis });
    const browser = await agent.browsers.get("extension");
    await browser.nameSession("Pi Codex Browser POC");
    return browser;
  };
}
var __piCodexBrowser = await globalThis.__piCodexBrowserGetChrome();`;
}

function browserScript(options, body) {
  return `${browserPrelude(options)}
var __piCodexBrowserResult = await (async ({ browser }) => {
${body}
})({ browser: __piCodexBrowser });
nodeRepl.write(${JSON.stringify(NODE_REPL_RESULT_START)} + "\\n" + JSON.stringify(__piCodexBrowserResult, null, 2) + "\\n" + ${JSON.stringify(NODE_REPL_RESULT_END)});`;
}

function browserListScript(options) {
  const browserClientPath = options.browserClientPath ?? DEFAULT_CHROME_BROWSER_CLIENT_PATH;
  return `const { setupBrowserRuntime } = await import(${JSON.stringify(browserClientPath)});
await setupBrowserRuntime({ globals: globalThis });
const __piCodexBrowserBackends = await agent.browsers.list();
nodeRepl.write(${JSON.stringify(NODE_REPL_RESULT_START)} + "\\n" + JSON.stringify({
  ok: __piCodexBrowserBackends.some((backend) => backend.type === "extension"),
  transport: "app-server-node-repl",
  backends: __piCodexBrowserBackends,
}, null, 2) + "\\n" + ${JSON.stringify(NODE_REPL_RESULT_END)});`;
}

async function runScriptBackedCommand(command, options, callScriptJson) {
  if (command === 'doctor' || command === 'chrome_backends_list') {
    return await callScriptJson(browserListScript(options));
  }

  if (command === 'chrome_tabs_list') {
    return await callScriptJson(
      browserScript(
        options,
        `const tabs = await browser.user.openTabs();
return {
  transport: "app-server-node-repl",
  totalTabs: tabs.length,
  tabs: tabs.slice(0, ${JSON.stringify(options.limit ?? 100)}),
};`,
      ),
    );
  }

  if (command === 'chrome_tab_new') {
    return await callScriptJson(
      browserScript(
        options,
        `const tab = await browser.tabs.new();
return {
  transport: "app-server-node-repl",
  tab: await globalThis.__piCodexBrowserDescribeTab(tab),
};`,
      ),
    );
  }

  if (command === 'chrome_tab_claim') {
    if (!options.tabId) throw new Error('chrome_tab_claim requires --tab-id');
    return await callScriptJson(
      browserScript(
        options,
        `const openTabs = await browser.user.openTabs();
const userTab = openTabs.find((tab) => String(tab.id) === ${JSON.stringify(String(options.tabId))});
if (!userTab) throw new Error("Could not find user tab ${String(options.tabId)}");
const tab = await browser.user.claimTab(userTab);
return {
  transport: "app-server-node-repl",
  claimedFrom: userTab,
  tab: await globalThis.__piCodexBrowserDescribeTab(tab),
};`,
      ),
    );
  }

  if (command === 'chrome_tab_goto') {
    if (!options.url) throw new Error('chrome_tab_goto requires <url> or --url');
    return await callScriptJson(
      browserScript(
        options,
        `let tab;
let claimedFrom = null;
if (${JSON.stringify(options.tabId != null)}) {
  const openTabs = await browser.user.openTabs();
  claimedFrom = openTabs.find((candidate) => String(candidate.id) === ${JSON.stringify(String(options.tabId ?? ''))});
  if (!claimedFrom) throw new Error("Could not find user tab ${String(options.tabId ?? '')}");
  tab = await browser.user.claimTab(claimedFrom);
} else {
  tab = await browser.tabs.new();
}
await tab.goto(${JSON.stringify(options.url)});
await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: 15_000 }).catch(() => {});
return {
  transport: "app-server-node-repl",
  claimedFrom,
  tab: await globalThis.__piCodexBrowserDescribeTab(tab),
};`,
      ),
    );
  }

  if (command === 'httpbin_form_demo') {
    return await callScriptJson(
      browserScript(
        options,
        `const tab = await browser.tabs.new();
await tab.goto("http://httpbin.org/forms/post");
await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: 15_000 }).catch(() => {});
const fields = {
  custname: "Pi Codex Browser",
  custtel: "555-0100",
  custemail: "pi-codex-browser@example.com",
  delivery: "2026-06-06T12:00",
  comments: "POC submission from codex-browser CLI."
};
for (const [name, value] of Object.entries(fields)) {
  const locator = tab.playwright.locator(\`[name="\${name}"]\`);
  const count = await locator.count();
  if (count !== 1) throw new Error(\`Expected one field named \${name}, found \${count}\`);
  await locator.fill(value, {});
}
const medium = tab.playwright.locator('input[name="size"][value="medium"]');
if (await medium.count() !== 1) throw new Error("Expected one medium size radio");
await medium.check({});
const bacon = tab.playwright.locator('input[name="topping"][value="bacon"]');
if (await bacon.count() !== 1) throw new Error("Expected one bacon checkbox");
await bacon.check({});
const cheese = tab.playwright.locator('input[name="topping"][value="cheese"]');
if (await cheese.count() !== 1) throw new Error("Expected one cheese checkbox");
await cheese.check({});
const submit = tab.playwright.getByRole("button", { name: "Submit order" });
const submitCount = await submit.count();
if (submitCount !== 1) throw new Error(\`Expected one submit button, found \${submitCount}\`);
await tab.playwright.expectNavigation(
  () => submit.click({}),
  { timeoutMs: 20_000, waitUntil: "domcontentloaded" },
);
await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: 15_000 }).catch(() => {});
const body = await tab.playwright.locator("body").innerText({ timeoutMs: 10_000 });
const url = await tab.url();
return {
  transport: "app-server-node-repl",
  tab: await globalThis.__piCodexBrowserDescribeTab(tab),
  submitted: url?.includes("/post") === true && body.includes("Pi Codex Browser"),
  url,
  evidence: {
    containsCustomerName: body.includes("Pi Codex Browser"),
    containsEmail: body.includes("pi-codex-browser@example.com"),
    bodyPreview: body.slice(0, 2000),
  },
};`,
      ),
    );
  }

  throw new Error(`Command ${command} is not implemented for --thread-id transport`);
}

async function runAppServerCommand(command, options) {
  return await runScriptBackedCommand(command, options, (code) => callNodeReplJson(options, code));
}

async function runBridgeCommand(command, options) {
  return await callBridgeCommand(options, command);
}

export async function runCommand({ command, options }) {
  if (command === 'help') return { text: usage() };
  if (command === 'bridge_snippet') return { text: buildBridgeSnippet(options) };
  if (options.bridgeSocket) return await runBridgeCommand(command, options);
  if (options.threadId) return await runAppServerCommand(command, options);

  if (command === 'doctor') return await runDoctor(options);

  if (command === 'chrome_backends_list') {
    const discovery = await discoverBrowserUseBackends(connectionOptions(options));
    return {
      ...discovery,
      selected: selectChromeBackends(discovery.candidates).selected,
    };
  }

  if (command === 'raw') {
    return await withChromeClient(options, async ({ backend, client, sessionId, turnId }) => ({
      backend,
      method: options.method,
      result: await client.request(options.method, options.params ?? {}),
      sessionId,
      turnId,
    }));
  }

  if (command === 'chrome_tabs_list') {
    return await withChromeClient(options, async ({ backend, client, sessionId, turnId }) => {
      const result = await client.request('getUserTabs', {});
      return {
        backend,
        sessionId,
        turnId,
        result: truncateTabs(result, options.limit),
      };
    });
  }

  if (command === 'chrome_tab_new') {
    return await withChromeClient(options, async ({ backend, client, sessionId, turnId }) => ({
      backend,
      sessionId,
      turnId,
      result: await client.request('createTab', {}),
    }));
  }

  if (command === 'chrome_tab_claim') {
    if (!options.tabId) throw new Error('chrome_tab_claim requires --tab-id');
    return await withChromeClient(options, async ({ backend, client, sessionId, turnId }) => ({
      backend,
      sessionId,
      turnId,
      result: await client.request('claimUserTab', { tabId: options.tabId }),
    }));
  }

  if (command === 'chrome_tab_goto') {
    if (!options.url) throw new Error('chrome_tab_goto requires <url> or --url');
    return await withChromeClient(options, async ({ backend, client, sessionId, turnId }) => {
      let tabId = options.tabId;
      let createdTab = null;
      if (!tabId) {
        createdTab = await client.request('createTab', {});
        tabId = extractTabId(createdTab);
      }
      if (!tabId) throw new Error('Could not determine tab id for navigation');
      const result = await client.request('executeUnhandledCommand', {
        type: 'navigate_tab_url',
        browser_id: 'chrome',
        tab_id: tabId,
        url: options.url,
      });
      return { backend, sessionId, turnId, createdTab, tabId, result };
    });
  }

  if (command === 'chrome_execute_command') {
    if (!options.commandParams) throw new Error('chrome_execute_command requires --command-json');
    return await withChromeClient(options, async ({ backend, client, sessionId, turnId }) => ({
      backend,
      sessionId,
      turnId,
      result: await client.request('executeUnhandledCommand', options.commandParams),
    }));
  }

  throw new Error(`Unknown command: ${command}`);
}

function usage() {
  return `Usage: codex-browser [--json] [--socket-dir DIR] [--socket PATH] [--timeout-ms MS] <command>

Commands:
  doctor
      Probe Browser Use sockets and report whether a Chrome/Brave extension backend is available.
  chrome_backends_list
      List all probed Browser Use backend candidates.
  chrome_tabs_list [--limit N]
      List user-visible Chrome/Brave tabs from the extension backend.
  chrome_tab_new
      Create a Browser Use managed tab.
  chrome_tab_claim --tab-id N
      Claim an existing user tab as a Browser Use managed tab.
  chrome_tab_goto [--tab-id N] <url>
      Navigate a managed tab, creating one first if --tab-id is omitted.
  chrome_execute_command --command-json JSON
      Execute a Browser Use command object, with common commands handled by the bridge.
  httpbin_form_demo
      Create a Chrome/Brave tab, submit the httpbin sample form, and validate the result.
  x_feed_top20
      Open X.com, collect feed items with scrolling, and sample comment threads.
  bridge_snippet [--bridge-socket PATH]
      Print JavaScript that starts the bridge inside a Codex node_repl runtime.
  raw <method> [--params-json JSON]
      Call a native backend method directly.

App-server transport:
  Add --thread-id THREAD to run supported commands through Codex app-server/node_repl.
  This is currently required for Chrome/Brave because direct raw socket access is privileged.
Bridge transport:
  Add --bridge-socket PATH to run supported commands through an active node_repl bridge.

Default socket dir: ${DEFAULT_SOCKET_DIR}
Default app-server socket: ${DEFAULT_APP_SERVER_SOCKET}
`;
}

function formatHuman(result) {
  if (typeof result?.text === 'string') return result.text;
  return JSON.stringify(result, null, 2);
}

export async function runCli(argv = process.argv.slice(2)) {
  const parsed = parseArgv(argv);
  const result = await runCommand(parsed);
  return parsed.json ? JSON.stringify(result, null, 2) : formatHuman(result);
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}

if (isEntrypoint()) {
  runCli()
    .then((output) => {
      process.stdout.write(`${output}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
