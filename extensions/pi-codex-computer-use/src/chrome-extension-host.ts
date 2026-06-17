interface ChromeDebugTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface ChromeExtensionHostRuntimeConfig {
  browserClientPath: string;
  trustedBrowserClientSha256s?: string[];
}

interface ChromeExtensionAppServerInfo {
  localAppServerUrl: string;
  runtimeConfig: ChromeExtensionHostRuntimeConfig;
}

interface EnsureChromeExtensionAppServerOptions {
  debugBaseUrl?: string;
  extensionId?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  WebSocketImpl?: typeof WebSocket;
}

const DEFAULT_CHROME_DEBUG_BASE_URL = 'http://127.0.0.1:9224';
const DEFAULT_EXTENSION_ID = 'hehggadaopoacecdllhhajmbjkdcmajg';
const DEFAULT_NATIVE_PROBE_TIMEOUT_MS = 8_000;
const CHROME_EXTENSION_ID_ENV = 'PI_CODEX_CHROME_EXTENSION_ID';
const CHROME_APP_SERVER_ORIGIN_ENV = 'PI_CODEX_CHROME_APP_SERVER_ORIGIN';

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

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let cleanupAbort = () => {};
    const timer = setTimeout(() => {
      cleanupAbort();
      resolve();
    }, ms);
    cleanupAbort = addAbortListener(signal, () => {
      clearTimeout(timer);
      reject(createOperationAbortedError());
    });
  });
}

export function getConfiguredChromeDebugBaseUrl(): string {
  return process.env.PI_CODEX_CHROME_DEBUG_URL ?? DEFAULT_CHROME_DEBUG_BASE_URL;
}

export function getChromeExtensionOrigin(extensionId: string = DEFAULT_EXTENSION_ID): string {
  return `chrome-extension://${extensionId}`;
}

export function getConfiguredChromeExtensionId(): string {
  const configured = process.env[CHROME_EXTENSION_ID_ENV]?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_EXTENSION_ID;
}

export function getConfiguredChromeAppServerOrigin(): string {
  const configured = process.env[CHROME_APP_SERVER_ORIGIN_ENV]?.trim();
  return configured && configured.length > 0
    ? configured.replace(/\/+$/u, '')
    : getChromeExtensionOrigin(DEFAULT_EXTENSION_ID);
}

export function findChromeExtensionServiceWorkerTarget(
  targets: ChromeDebugTarget[],
  extensionId: string = DEFAULT_EXTENSION_ID,
): ChromeDebugTarget | undefined {
  const extensionPrefix = `${getChromeExtensionOrigin(extensionId)}/`;
  return targets.find(
    (target) =>
      target.type === 'service_worker' &&
      typeof target.url === 'string' &&
      target.url.startsWith(extensionPrefix) &&
      typeof target.webSocketDebuggerUrl === 'string',
  );
}

function findChromeExtensionPageTarget(
  targets: ChromeDebugTarget[],
  extensionId: string = DEFAULT_EXTENSION_ID,
): ChromeDebugTarget | undefined {
  const extensionPrefix = `${getChromeExtensionOrigin(extensionId)}/`;
  return targets.find(
    (target) =>
      target.type === 'page' &&
      typeof target.url === 'string' &&
      target.url.startsWith(extensionPrefix) &&
      typeof target.webSocketDebuggerUrl === 'string',
  );
}

function buildCreateExtensionPageExpression(): string {
  return `
(async () => {
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html'), active: false });
  return { tabId: tab.id };
})()`;
}

function buildCloseExtensionPageExpression(tabId: number): string {
  return `chrome.tabs.remove(${JSON.stringify(tabId)}).then(() => ({ ok: true }), (error) => ({ ok: false, error: String(error && (error.message || error)) }))`;
}

function buildEnsureExpression(): string {
  return `
(async () => {
  const win = await chrome.windows.getCurrent();
  await chrome.storage.session.set({ codexSidePanelOpenWindowIds: win.id == null ? [] : [win.id] });
  return await chrome.runtime.sendMessage({ type: 'ensure_codex_app_server', windowId: win.id });
})()`;
}

function validateEnsureResult(value: any): ChromeExtensionAppServerInfo {
  if (value?.ok !== true) {
    throw new Error(value?.error ?? 'Codex Chrome Extension native host did not start app-server.');
  }
  const result = value.result ?? value;
  if ('string' !== typeof result?.localAppServerUrl || result.localAppServerUrl.length === 0) {
    throw new Error('Codex Chrome Extension native host did not return localAppServerUrl.');
  }
  if ('string' !== typeof result?.runtimeConfig?.browserClientPath) {
    throw new Error('Codex Chrome Extension native host did not return browserClientPath.');
  }
  return result as ChromeExtensionAppServerInfo;
}

export async function ensureChromeExtensionAppServer(
  options: EnsureChromeExtensionAppServerOptions = {},
): Promise<ChromeExtensionAppServerInfo> {
  const debugBaseUrl = options.debugBaseUrl ?? getConfiguredChromeDebugBaseUrl();
  const extensionId = options.extensionId ?? getConfiguredChromeExtensionId();
  const fetchImpl = options.fetchImpl ?? fetch;
  const WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  const timeoutMs = options.timeoutMs ?? DEFAULT_NATIVE_PROBE_TIMEOUT_MS;
  const readTargets = async () => {
    throwIfAborted(options.signal);
    const targetsResponse = await fetchImpl(
      new URL('/json/list', debugBaseUrl),
      options.signal ? { signal: options.signal } : undefined,
    );
    if (!targetsResponse.ok) {
      throw new Error(`Could not inspect Chrome debug targets at ${debugBaseUrl}.`);
    }
    return (await targetsResponse.json()) as ChromeDebugTarget[];
  };

  let targets = await readTargets();
  let pageTarget = findChromeExtensionPageTarget(targets, extensionId);
  const serviceWorkerTarget = findChromeExtensionServiceWorkerTarget(targets, extensionId);
  let createdTabId: number | undefined;

  if (!pageTarget) {
    if (!serviceWorkerTarget?.webSocketDebuggerUrl) {
      throw new Error(
        `Could not find a debuggable Codex Chrome Extension service worker at ${debugBaseUrl}. Start Brave with --remote-debugging-port=9224 and confirm the extension is enabled.`,
      );
    }
    const created = (await evaluateInDebugTarget({
      expression: buildCreateExtensionPageExpression(),
      signal: options.signal,
      timeoutMs,
      webSocketDebuggerUrl: serviceWorkerTarget.webSocketDebuggerUrl,
      WebSocketImpl,
    })) as { tabId?: unknown };
    if (Number.isInteger(created?.tabId)) createdTabId = created.tabId as number;

    for (let attempt = 0; attempt < 20; attempt++) {
      targets = await readTargets();
      pageTarget = findChromeExtensionPageTarget(targets, extensionId);
      if (pageTarget) break;
      await sleep(100, options.signal);
    }
  }

  if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error(`Could not open a debuggable Codex Chrome Extension page at ${debugBaseUrl}.`);
  }

  try {
    const runtimeResult = await evaluateInDebugTarget({
      expression: buildEnsureExpression(),
      signal: options.signal,
      timeoutMs,
      webSocketDebuggerUrl: pageTarget.webSocketDebuggerUrl,
      WebSocketImpl,
    });
    return validateEnsureResult(runtimeResult);
  } finally {
    if (createdTabId !== undefined && serviceWorkerTarget?.webSocketDebuggerUrl) {
      await evaluateInDebugTarget({
        expression: buildCloseExtensionPageExpression(createdTabId),
        signal: options.signal,
        timeoutMs,
        webSocketDebuggerUrl: serviceWorkerTarget.webSocketDebuggerUrl,
        WebSocketImpl,
      }).catch(() => {});
    }
  }
}

async function evaluateInDebugTarget({
  expression,
  signal,
  timeoutMs,
  webSocketDebuggerUrl,
  WebSocketImpl,
}: {
  expression: string;
  signal?: AbortSignal;
  timeoutMs: number;
  webSocketDebuggerUrl: string;
  WebSocketImpl: typeof WebSocket;
}): Promise<unknown> {
  throwIfAborted(signal);
  const socket = new WebSocketImpl(webSocketDebuggerUrl);
  let closed = false;
  const closeSocket = () => {
    if (closed) return;
    closed = true;
    socket.close();
  };
  let nextId = 1;
  const pending = new Map<number, { reject(error: Error): void; resolve(value: any): void }>();
  const failAll = (error: Error) => {
    for (const callbacks of pending.values()) callbacks.reject(error);
    pending.clear();
  };
  const cleanupAbort = addAbortListener(signal, () => {
    failAll(createOperationAbortedError());
    closeSocket();
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const callbacks = pending.get(message.id)!;
    pending.delete(message.id);
    if (message.error) {
      callbacks.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    } else {
      callbacks.resolve(message.result);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      closeSocket();
      reject(new Error(`Chrome debug target connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => clearTimeout(timer);
    socket.addEventListener(
      'open',
      () => {
        cleanup();
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        cleanup();
        reject(new Error('Could not connect to Chrome debug target.'));
      },
      {
        once: true,
      },
    );
  });

  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      throwIfAborted(signal);
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Chrome debug ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });

  try {
    await send('Runtime.enable');
    const result = await send('Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true,
      timeout: 15_000,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? 'Codex extension evaluation failed.');
    }
    return result.result?.value;
  } finally {
    closeSocket();
    cleanupAbort();
  }
}
