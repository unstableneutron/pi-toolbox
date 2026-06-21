import {
  getConfiguredChromeDebugBaseUrl,
  getConfiguredChromeExtensionId,
  getChromeExtensionOrigin,
} from './chrome-extension-host';

interface ChromeDebugTarget {
  id?: string;
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface ChromeDebugBrowserOptions {
  debugUrl?: string;
  debugBaseUrl?: string;
  extensionId?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  WebSocketImpl?: typeof WebSocket;
}

interface ChromeDebugBrowserEvalOptions extends ChromeDebugBrowserOptions {
  script: string;
}

interface ChromeDebugTabInfo {
  id: string;
  title?: string;
  url?: string;
}

interface ChromeDebugBrowserListResult {
  backend: 'chrome';
  browserId: 'chrome-devtools';
  selectedTab?: ChromeDebugTabInfo;
  tabs: ChromeDebugTabInfo[];
}

interface ChromeDebugToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string }>;
  details: Record<string, unknown>;
}

const CHROME_DEBUG_REQUEST_TIMEOUT_MS = 30_000;
const CHROME_DEBUG_FETCH_TIMEOUT_MS = 5_000;
const CHROME_DEBUG_DEFAULT_PORTS = [9224, 9222, 9223, 9225, 9230];

function createOperationAbortedError(): Error {
  return new Error('Operation aborted');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createOperationAbortedError();
}

function addAbortListener(signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (!signal) return () => {};
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

function buildTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { cleanup(): void; signal?: AbortSignal } {
  if (!timeoutMs || timeoutMs <= 0) return { cleanup() {}, ...(signal ? { signal } : {}) };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const cleanupAbort = addAbortListener(signal, () => controller.abort());
  return {
    cleanup() {
      clearTimeout(timeout);
      cleanupAbort();
    },
    signal: controller.signal,
  };
}

function getOptionDebugBaseUrl(value: string | undefined): string {
  return value ?? getConfiguredChromeDebugBaseUrl();
}

function getDebugBaseUrlCandidates(value: string | undefined): string[] {
  if (value) return [value];
  const envValue = process.env.PI_CODEX_CHROME_DEBUG_URL?.trim();
  if (envValue) return [envValue];
  const defaults = [getConfiguredChromeDebugBaseUrl()];
  for (const port of CHROME_DEBUG_DEFAULT_PORTS) defaults.push(`http://127.0.0.1:${port}`);
  return [...new Set(defaults)];
}

function getOptionFetch(fetchImpl: typeof fetch | undefined): typeof fetch {
  return fetchImpl ?? fetch;
}

function getOptionWebSocket(WebSocketImpl: typeof WebSocket | undefined): typeof WebSocket {
  return WebSocketImpl ?? WebSocket;
}

async function fetchChromeDebugJson<T>(
  options: ChromeDebugBrowserOptions,
  path: string,
  init?: RequestInit,
): Promise<T> {
  throwIfAborted(options.signal);
  const debugBaseUrls = getDebugBaseUrlCandidates(options.debugBaseUrl ?? options.debugUrl);
  const fetchImpl = getOptionFetch(options.fetchImpl);
  let lastError: unknown;
  for (const debugBaseUrl of debugBaseUrls) {
    const timeoutSignal = buildTimeoutSignal(
      options.signal,
      options.requestTimeoutMs ?? CHROME_DEBUG_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetchImpl(new URL(path, debugBaseUrl), {
        ...init,
        ...(timeoutSignal.signal ? { signal: timeoutSignal.signal } : {}),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `Chrome debug endpoint ${debugBaseUrl}${path} failed with ${response.status}${body ? `: ${body}` : ''}`,
        );
      }
      return (await response.json()) as T;
    } catch (error) {
      if (options.signal?.aborted) throw createOperationAbortedError();
      lastError = error;
    } finally {
      timeoutSignal.cleanup();
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not reach a Chromium DevTools endpoint for ${path}.`);
}

function isExtensionTarget(target: ChromeDebugTarget, extensionId: string): boolean {
  return (
    typeof target.url === 'string' &&
    target.url.startsWith(`${getChromeExtensionOrigin(extensionId)}/`)
  );
}

function readExplicitExtensionId(value: string | undefined): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  const envValue = process.env.PI_CODEX_CHROME_EXTENSION_ID?.trim();
  return envValue && envValue.length > 0 ? envValue : undefined;
}

function extensionIdFromUrl(url: string | undefined): string | undefined {
  return url?.match(/^chrome-extension:\/\/([a-p]{32})\//u)?.[1];
}

function detectCodexExtensionId(targets: ChromeDebugTarget[]): string | undefined {
  const titledCodexTarget = targets.find(
    (target) =>
      typeof target.title === 'string' &&
      target.title.toLowerCase() === 'codex' &&
      extensionIdFromUrl(target.url),
  );
  const titledCodexId = extensionIdFromUrl(titledCodexTarget?.url);
  if (titledCodexId) return titledCodexId;

  const exactServiceWorkerTarget = targets.find(
    (target) => target.type === 'service_worker' && target.url?.endsWith('/background.js'),
  );
  return extensionIdFromUrl(exactServiceWorkerTarget?.url);
}

function getTargetExtensionId(
  options: ChromeDebugBrowserOptions,
  targets: ChromeDebugTarget[],
): string {
  return (
    readExplicitExtensionId(options.extensionId) ??
    detectCodexExtensionId(targets) ??
    getConfiguredChromeExtensionId()
  );
}

function targetToTabInfo(target: ChromeDebugTarget): ChromeDebugTabInfo | undefined {
  if (target.type !== 'page' || typeof target.id !== 'string') return undefined;
  if (typeof target.url === 'string' && target.url.startsWith('chrome-extension://'))
    return undefined;
  return {
    id: target.id,
    ...(typeof target.title === 'string' ? { title: target.title } : {}),
    ...(typeof target.url === 'string' ? { url: target.url } : {}),
  };
}

async function readChromeDebugTargets(
  options: ChromeDebugBrowserOptions,
): Promise<ChromeDebugTarget[]> {
  return (await resolveChromeDebugTargets(options)).targets;
}

async function resolveChromeDebugTargets(options: ChromeDebugBrowserOptions): Promise<{
  debugBaseUrl: string;
  targets: ChromeDebugTarget[];
}> {
  const explicitDebugBaseUrl = options.debugBaseUrl ?? options.debugUrl;
  const envDebugBaseUrl = process.env.PI_CODEX_CHROME_DEBUG_URL?.trim();
  const candidates = getDebugBaseUrlCandidates(explicitDebugBaseUrl);
  if (explicitDebugBaseUrl || envDebugBaseUrl) {
    const debugBaseUrl = candidates[0]!;
    return {
      debugBaseUrl,
      targets: await fetchChromeDebugJson<ChromeDebugTarget[]>(
        { ...options, debugBaseUrl },
        '/json/list',
      ),
    };
  }

  let lastReachable: { debugBaseUrl: string; targets: ChromeDebugTarget[] } | undefined;
  let lastError: unknown;
  for (const debugBaseUrl of candidates) {
    try {
      const targets = await fetchChromeDebugJson<ChromeDebugTarget[]>(
        { ...options, debugBaseUrl },
        '/json/list',
      );
      const extensionId = getTargetExtensionId(options, targets);
      const resolved = { debugBaseUrl, targets };
      if (targets.some((target) => isExtensionTarget(target, extensionId))) return resolved;
      lastReachable = resolved;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastReachable) return lastReachable;
  throw lastError instanceof Error
    ? lastError
    : new Error('Could not reach a Chromium DevTools endpoint.');
}

async function assertConfiguredExtensionLoaded(
  options: ChromeDebugBrowserOptions,
  targets: ChromeDebugTarget[],
): Promise<void> {
  const extensionId = getTargetExtensionId(options, targets);
  if (targets.some((target) => isExtensionTarget(target, extensionId))) return;
  throw new Error(
    `Could not find Codex Chrome Extension ${extensionId} in Chrome debug targets at ${getOptionDebugBaseUrl(
      options.debugBaseUrl ?? options.debugUrl,
    )}. Confirm the unpacked extension is loaded and Brave was started with remote debugging enabled.`,
  );
}

export async function listChromeDebugBrowserTabs(
  options: ChromeDebugBrowserOptions = {},
): Promise<ChromeDebugBrowserListResult> {
  const targets = await readChromeDebugTargets(options);
  await assertConfiguredExtensionLoaded(options, targets);
  const tabs = targets.flatMap((target) => {
    const tab = targetToTabInfo(target);
    return tab ? [tab] : [];
  });
  return {
    backend: 'chrome',
    browserId: 'chrome-devtools',
    selectedTab: tabs[0],
    tabs,
  };
}

class ChromeDebugProtocolClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { reject(error: Error): void; resolve(value: any): void }
  >();
  private readonly socket: WebSocket;
  private readonly eventListeners = new Map<string, Array<(params: any) => void>>();
  private closed = false;
  private opened?: Promise<void>;
  private readonly cleanupAbort: () => void;

  constructor(
    webSocketDebuggerUrl: string,
    WebSocketImpl: typeof WebSocket,
    private readonly signal?: AbortSignal,
  ) {
    this.socket = new WebSocketImpl(webSocketDebuggerUrl);
    this.socket.addEventListener('message', (event) => this.handleMessage(event));
    this.cleanupAbort = addAbortListener(signal, () => {
      this.rejectAll(createOperationAbortedError());
      this.close();
    });
  }

  async open(): Promise<void> {
    throwIfAborted(this.signal);
    this.opened ??= new Promise<void>((resolve, reject) => {
      const cleanupAbort = addAbortListener(this.signal, () =>
        reject(createOperationAbortedError()),
      );
      this.socket.addEventListener(
        'open',
        () => {
          cleanupAbort();
          resolve();
        },
        { once: true },
      );
      this.socket.addEventListener(
        'error',
        () => {
          cleanupAbort();
          reject(new Error('Could not connect to Chrome debug target.'));
        },
        {
          once: true,
        },
      );
    });
    await this.opened;
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = CHROME_DEBUG_REQUEST_TIMEOUT_MS,
  ) {
    await this.open();
    throwIfAborted(this.signal);
    const id = this.nextId++;
    const request = JSON.stringify({ id, method, params });
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome debug ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanupAbort = addAbortListener(this.signal, () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(createOperationAbortedError());
      });
      this.pending.set(id, {
        reject: (error) => {
          clearTimeout(timer);
          cleanupAbort();
          reject(error);
        },
        resolve: (value) => {
          clearTimeout(timer);
          cleanupAbort();
          resolve(value);
        },
      });
      this.socket.send(request);
    });
  }

  waitForEvent(method: string, timeoutMs = CHROME_DEBUG_REQUEST_TIMEOUT_MS): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Chrome debug event ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const listener = (params: any) => {
        cleanup();
        resolve(params);
      };
      const cleanup = () => {
        clearTimeout(timer);
        cleanupAbort();
        const listeners = this.eventListeners.get(method) ?? [];
        this.eventListeners.set(
          method,
          listeners.filter((candidate) => candidate !== listener),
        );
      };
      const listeners = this.eventListeners.get(method) ?? [];
      listeners.push(listener);
      this.eventListeners.set(method, listeners);
      const cleanupAbort = addAbortListener(this.signal, () => {
        cleanup();
        reject(createOperationAbortedError());
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cleanupAbort();
    this.socket.close();
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private handleMessage(event: MessageEvent): void {
    const message = JSON.parse(String(event.data));
    if (message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string') {
      for (const listener of this.eventListeners.get(message.method) ?? [])
        listener(message.params);
    }
  }
}

class ChromeDebugTab {
  private client?: ChromeDebugProtocolClient;

  constructor(
    readonly id: string,
    private readonly webSocketDebuggerUrl: string,
    private readonly WebSocketImpl: typeof WebSocket,
    private readonly signal?: AbortSignal,
  ) {}

  async goto(url: string): Promise<void> {
    const client = await this.getClient();
    await client.send('Page.enable');
    const loaded = client.waitForEvent('Page.loadEventFired', 45_000).catch(() => undefined);
    await client.send('Page.navigate', { url });
    await loaded;
  }

  async title(): Promise<string | undefined> {
    return (await this.evaluate('document.title')) as string | undefined;
  }

  async url(): Promise<string | undefined> {
    return (await this.evaluate('location.href')) as string | undefined;
  }

  async text(): Promise<string> {
    return String((await this.evaluate('document.body?.innerText ?? ""')) ?? '');
  }

  async evaluate(expressionOrFunction: string | ((...args: any[]) => unknown), ...args: unknown[]) {
    const expression =
      typeof expressionOrFunction === 'function'
        ? `(${expressionOrFunction.toString()})(...${JSON.stringify(args)})`
        : expressionOrFunction;
    const client = await this.getClient();
    await client.send('Runtime.enable');
    const result = await client.send('Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? 'Chrome debug evaluation failed.');
    }
    if (Object.prototype.hasOwnProperty.call(result.result ?? {}, 'value')) {
      return result.result.value;
    }
    return result.result?.description;
  }

  close(): void {
    this.client?.close();
  }

  private async getClient(): Promise<ChromeDebugProtocolClient> {
    if (!this.client) {
      this.client = new ChromeDebugProtocolClient(
        this.webSocketDebuggerUrl,
        this.WebSocketImpl,
        this.signal,
      );
      await this.client.open();
    }
    return this.client;
  }
}

class ChromeDebugTabs {
  private readonly openedTabs: ChromeDebugTab[] = [];

  constructor(
    private readonly options: Required<Pick<ChromeDebugBrowserOptions, 'WebSocketImpl'>> &
      ChromeDebugBrowserOptions,
  ) {}

  async list(): Promise<ChromeDebugTabInfo[]> {
    return (await listChromeDebugBrowserTabs(this.options)).tabs;
  }

  async selected(): Promise<ChromeDebugTab | undefined> {
    const target = (await readChromeDebugTargets(this.options)).find(
      (candidate) =>
        candidate.type === 'page' &&
        typeof candidate.id === 'string' &&
        typeof candidate.webSocketDebuggerUrl === 'string' &&
        !(typeof candidate.url === 'string' && candidate.url.startsWith('chrome-extension://')),
    );
    return target ? this.toTab(target) : undefined;
  }

  async new(url = 'about:blank'): Promise<ChromeDebugTab> {
    const encodedUrl = encodeURIComponent(url);
    let target: ChromeDebugTarget;
    try {
      target = await fetchChromeDebugJson<ChromeDebugTarget>(
        this.options,
        `/json/new?${encodedUrl}`,
        {
          method: 'PUT',
        },
      );
    } catch {
      target = await fetchChromeDebugJson<ChromeDebugTarget>(
        this.options,
        `/json/new?${encodedUrl}`,
      );
    }
    return this.toTab(target);
  }

  async get(id: string): Promise<ChromeDebugTab> {
    const target = (await readChromeDebugTargets(this.options)).find(
      (candidate) => candidate.id === id,
    );
    if (!target) throw new Error(`Chrome debug tab not found: ${id}`);
    return this.toTab(target);
  }

  private toTab(target: ChromeDebugTarget): ChromeDebugTab {
    if (typeof target.id !== 'string' || typeof target.webSocketDebuggerUrl !== 'string') {
      throw new Error('Chrome debug target is missing id or webSocketDebuggerUrl.');
    }
    const tab = new ChromeDebugTab(
      target.id,
      target.webSocketDebuggerUrl,
      this.options.WebSocketImpl,
      this.options.signal,
    );
    this.openedTabs.push(tab);
    return tab;
  }

  close(): void {
    for (const tab of this.openedTabs) tab.close();
    this.openedTabs.length = 0;
  }
}

class ChromeDebugBrowser {
  readonly browserId = 'chrome-devtools';
  readonly tabs: ChromeDebugTabs;

  constructor(private readonly options: ChromeDebugBrowserOptions) {
    this.tabs = new ChromeDebugTabs({
      ...options,
      WebSocketImpl: getOptionWebSocket(options.WebSocketImpl),
    });
  }

  async nameSession(): Promise<void> {
    // Cosmetic in the Codex browser runtime; Chrome DevTools does not expose a matching concept.
  }

  close(): void {
    this.tabs.close();
  }
}

function formatBrowserEvalOutput(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function makeChromeDebugToolResult(input: {
  operation: 'eval' | 'list';
  output: string;
  rawResult?: unknown;
}): ChromeDebugToolResult {
  return {
    content: [{ type: 'text', text: input.output }],
    details: {
      backend: 'chrome',
      bridge: 'chrome-devtools',
      operation: input.operation,
      rawResult: input.rawResult,
      server: 'chrome-devtools',
    },
  };
}

export async function runChromeDebugBrowserList(
  options: ChromeDebugBrowserOptions = {},
): Promise<ChromeDebugToolResult> {
  const result = await listChromeDebugBrowserTabs(options);
  return makeChromeDebugToolResult({
    operation: 'list',
    output: JSON.stringify(result, null, 2),
    rawResult: result,
  });
}

export async function runChromeDebugBrowserEval(
  options: ChromeDebugBrowserEvalOptions,
): Promise<ChromeDebugToolResult> {
  const resolved = await resolveChromeDebugTargets(options);
  const targets = resolved.targets;
  await assertConfiguredExtensionLoaded(options, targets);
  const browser = new ChromeDebugBrowser({ ...options, debugBaseUrl: resolved.debugBaseUrl });
  const tab = (await browser.tabs.selected()) ?? (await browser.tabs.new());
  const writes: string[] = [];
  const images: Array<{ type: 'image'; data: string }> = [];
  const nodeRepl = {
    async emitImage(data: string) {
      images.push({ type: 'image', data });
    },
    write(value: unknown) {
      writes.push(String(value));
    },
  };
  const agent = {
    browsers: {
      async get() {
        return browser;
      },
      async list() {
        return [{ id: browser.browserId, name: 'Chrome DevTools', type: 'chrome' }];
      },
    },
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    const result = await new AsyncFunction('agent', 'browser', 'tab', 'nodeRepl', options.script)(
      agent,
      browser,
      tab,
      nodeRepl,
    );
    const output = writes.length > 0 ? writes.join('\n') : formatBrowserEvalOutput(result);
    const toolResult = makeChromeDebugToolResult({ operation: 'eval', output, rawResult: result });
    return images.length > 0
      ? { ...toolResult, content: [...toolResult.content, ...images] }
      : toolResult;
  } finally {
    browser.close();
  }
}
