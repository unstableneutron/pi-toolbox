import { describe, expect, test } from 'vitest';

import {
  ensureChromeExtensionAppServer,
  findChromeExtensionServiceWorkerTarget,
} from './chrome-extension-host';

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
        data: makeRuntimeEvaluationResult(message.id, { ok: true, result: appServerInfo }),
      });
    }
  }

  close(): void {}

  private emit(event: string, payload: any): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

function resetFakeWebSocket(): void {
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
});
