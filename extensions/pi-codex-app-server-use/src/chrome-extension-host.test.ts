import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  ensureChromeExtensionAppServer,
  findChromeExtensionServiceWorkerTarget,
  getConfiguredChromeAppServerOrigin,
  getConfiguredChromeExtensionId,
} from './chrome-extension-host';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getConfiguredChromeExtensionId', () => {
  test('uses the official Codex Chrome extension id by default', () => {
    vi.stubEnv('PI_CODEX_CHROME_EXTENSION_ID', '');

    expect(getConfiguredChromeExtensionId()).toBe('hehggadaopoacecdllhhajmbjkdcmajg');
  });

  test('uses PI_CODEX_CHROME_EXTENSION_ID when set for an unpacked Brave extension', () => {
    vi.stubEnv('PI_CODEX_CHROME_EXTENSION_ID', 'abggnaecfoknpafciidmojghmkdkkhao');

    expect(getConfiguredChromeExtensionId()).toBe('abggnaecfoknpafciidmojghmkdkkhao');
  });

  test('keeps the app-server WebSocket origin on the official extension by default', () => {
    vi.stubEnv('PI_CODEX_CHROME_EXTENSION_ID', 'abggnaecfoknpafciidmojghmkdkkhao');

    expect(getConfiguredChromeAppServerOrigin()).toBe(
      'chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg',
    );
  });
});

describe('findChromeExtensionServiceWorkerTarget', () => {
  test('selects the Codex extension service worker target for the configured extension id', () => {
    expect(
      findChromeExtensionServiceWorkerTarget(
        [
          {
            type: 'page',
            url: 'chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/popup.html',
            webSocketDebuggerUrl: 'ws://popup',
          },
          {
            type: 'service_worker',
            url: 'chrome-extension://other/background.js',
            webSocketDebuggerUrl: 'ws://other',
          },
          {
            type: 'service_worker',
            url: 'chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/background.js',
            webSocketDebuggerUrl: 'ws://codex',
          },
        ],
        'hehggadaopoacecdllhhajmbjkdcmajg',
      ),
    ).toEqual({
      type: 'service_worker',
      url: 'chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/background.js',
      webSocketDebuggerUrl: 'ws://codex',
    });
  });

  test('returns undefined when the Codex extension service worker is not debuggable', () => {
    expect(
      findChromeExtensionServiceWorkerTarget(
        [
          {
            type: 'page',
            url: 'chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/popup.html',
            webSocketDebuggerUrl: 'ws://popup',
          },
        ],
        'hehggadaopoacecdllhhajmbjkdcmajg',
      ),
    ).toBeUndefined();
  });
});

function makeResponse(value: unknown): Response {
  return {
    ok: true,
    async json() {
      return value;
    },
  } as Response;
}

function makeRuntimeEvaluationResult(id: number, value: unknown): string {
  return JSON.stringify({ id, result: { result: { value } } });
}

const appServerInfo = {
  localAppServerUrl: 'ws://127.0.0.1:12345?token=test',
  runtimeConfig: { browserClientPath: '/tmp/browser-client.mjs' },
};

class FakeWebSocket {
  static closeCount = 0;
  static ensureResult: unknown = { ok: true, result: appServerInfo };
  static expressions: Array<{ url: string; expression: string }> = [];
  static urls: string[] = [];

  readonly url: string;
  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.urls.push(url);
    queueMicrotask(() => this.emit('open', {}));
  }

  addEventListener(event: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  send(raw: string): void {
    const message = JSON.parse(raw);
    if (message.method === 'Runtime.enable') {
      this.emit('message', { data: JSON.stringify({ id: message.id, result: {} }) });
      return;
    }
    if (message.method !== 'Runtime.evaluate') return;

    const expression = String(message.params?.expression ?? '');
    FakeWebSocket.expressions.push({ url: this.url, expression });
    if (expression.includes('chrome.tabs.create')) {
      this.emit('message', { data: makeRuntimeEvaluationResult(message.id, { tabId: 123 }) });
    } else if (expression.includes('chrome.tabs.remove')) {
      this.emit('message', { data: makeRuntimeEvaluationResult(message.id, { ok: true }) });
    } else {
      this.emit('message', {
        data: makeRuntimeEvaluationResult(message.id, FakeWebSocket.ensureResult),
      });
    }
  }

  close(): void {
    FakeWebSocket.closeCount += 1;
  }

  private emit(event: string, payload: any): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

function resetFakeWebSocket(): void {
  FakeWebSocket.closeCount = 0;
  FakeWebSocket.ensureResult = { ok: true, result: appServerInfo };
  FakeWebSocket.expressions = [];
  FakeWebSocket.urls = [];
}

function serviceWorkerTarget(webSocketDebuggerUrl = 'ws://service-worker') {
  return {
    type: 'service_worker',
    url: 'chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/background.js',
    webSocketDebuggerUrl,
  };
}

function pageTarget(webSocketDebuggerUrl = 'ws://page') {
  return {
    type: 'page',
    url: 'chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg/popup.html',
    webSocketDebuggerUrl,
  };
}

const debugBaseUrl = 'http://127.0.0.1:9224';

describe('ensureChromeExtensionAppServer', () => {
  test('uses an existing Codex extension page to request the app-server through the background path', async () => {
    vi.stubEnv('PI_CODEX_CHROME_EXTENSION_ID', '');
    resetFakeWebSocket();
    const fetchImpl = async () => makeResponse([pageTarget()]);

    await expect(
      ensureChromeExtensionAppServer({
        debugBaseUrl,
        fetchImpl: fetchImpl as typeof fetch,
        WebSocketImpl: FakeWebSocket as any,
      }),
    ).resolves.toEqual(appServerInfo);

    expect(FakeWebSocket.urls).toEqual(['ws://page']);
    expect(FakeWebSocket.expressions.map((entry) => entry.expression).join('\n')).toContain(
      'ensure_codex_app_server',
    );
  });

  test('opens a temporary extension page from the service worker when no page target exists', async () => {
    vi.stubEnv('PI_CODEX_CHROME_EXTENSION_ID', '');
    resetFakeWebSocket();
    let reads = 0;
    const fetchImpl = async () => {
      reads += 1;
      return makeResponse(
        reads === 1 ? [serviceWorkerTarget()] : [serviceWorkerTarget(), pageTarget()],
      );
    };

    await expect(
      ensureChromeExtensionAppServer({
        debugBaseUrl,
        fetchImpl: fetchImpl as typeof fetch,
        WebSocketImpl: FakeWebSocket as any,
      }),
    ).resolves.toEqual(appServerInfo);

    const expressions = FakeWebSocket.expressions.map((entry) => entry.expression).join('\n');
    expect(expressions).toContain('chrome.tabs.create');
    expect(expressions).toContain('ensure_codex_app_server');
    expect(expressions).toContain('chrome.tabs.remove');
  });

  test('aborts a hung native app-server request and closes the DevTools socket', async () => {
    vi.stubEnv('PI_CODEX_CHROME_EXTENSION_ID', '');
    resetFakeWebSocket();
    class HangingWebSocket extends FakeWebSocket {
      send(raw: string): void {
        const message = JSON.parse(raw);
        if (message.method === 'Runtime.evaluate') return;
        super.send(raw);
      }
    }
    const controller = new AbortController();
    const fetchImpl = async () => makeResponse([pageTarget()]);
    const operation = ensureChromeExtensionAppServer({
      debugBaseUrl,
      fetchImpl: fetchImpl as typeof fetch,
      WebSocketImpl: HangingWebSocket as any,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 5);

    await expect(operation).rejects.toThrow('Operation aborted');
    expect(FakeWebSocket.closeCount).toBe(1);
  });

  test('surfaces native host status when app-server bootstrap fails', async () => {
    vi.stubEnv('PI_CODEX_CHROME_EXTENSION_ID', '');
    resetFakeWebSocket();
    FakeWebSocket.ensureResult = {
      ok: false,
      error:
        'Timed out waiting for Codex Chrome Extension native host ensureCodexAppServer response after 7000ms.',
      nativeHostStatus: { hostName: 'com.openai.codexextension', state: 'connected' },
      sidePanelOpen: true,
    };
    const fetchImpl = async () => makeResponse([pageTarget()]);

    await expect(
      ensureChromeExtensionAppServer({
        debugBaseUrl,
        fetchImpl: fetchImpl as typeof fetch,
        WebSocketImpl: FakeWebSocket as any,
      }),
    ).rejects.toThrow(
      'nativeHostStatus={"hostName":"com.openai.codexextension","state":"connected"}',
    );
  });
});
