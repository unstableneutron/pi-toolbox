import { afterEach, describe, expect, test } from 'vitest';

import { listChromeDebugBrowserTabs, runChromeDebugBrowserEval } from './chrome-debug-browser';

function makeResponse(value: unknown): Response {
  return {
    ok: true,
    async json() {
      return value;
    },
    async text() {
      return JSON.stringify(value);
    },
  } as Response;
}

const debugBaseUrl = 'http://127.0.0.1:9224';
const extensionId = 'abggnaecfoknpafciidmojghmkdkkhao';

const targets = [
  {
    id: 'extension-worker',
    type: 'service_worker',
    title: 'Codex',
    url: `chrome-extension://${extensionId}/background.js`,
    webSocketDebuggerUrl: 'ws://extension-worker',
  },
  {
    id: 'page-1',
    type: 'page',
    title: 'Example Domain',
    url: 'https://example.com/',
    webSocketDebuggerUrl: 'ws://page-1',
  },
];

class FakeWebSocket {
  static closeCount = 0;
  static urls: string[] = [];
  static navigations: string[] = [];
  static evaluations: string[] = [];

  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(readonly url: string) {
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
    if (message.method === 'Page.navigate') {
      FakeWebSocket.navigations.push(message.params.url);
      this.respond(message.id, { frameId: 'frame-1' });
      queueMicrotask(() =>
        this.emit('message', { data: JSON.stringify({ method: 'Page.loadEventFired' }) }),
      );
      return;
    }
    if (message.method === 'Runtime.evaluate') {
      const expression = String(message.params.expression ?? '');
      FakeWebSocket.evaluations.push(expression);
      if (expression.includes('document.title')) {
        this.respond(message.id, { result: { value: 'Example Domain' } });
      } else if (expression.includes('document.body.innerText')) {
        this.respond(message.id, { result: { value: 'hello from page' } });
      } else if (expression.includes('location.href')) {
        this.respond(message.id, { result: { value: 'https://example.com/' } });
      } else {
        this.respond(message.id, { result: { value: null } });
      }
      return;
    }
    this.respond(message.id, {});
  }

  close(): void {
    FakeWebSocket.closeCount += 1;
  }

  private respond(id: number, result: unknown): void {
    this.emit('message', { data: JSON.stringify({ id, result }) });
  }

  private emit(event: string, payload: any): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

afterEach(() => {
  FakeWebSocket.closeCount = 0;
  FakeWebSocket.urls = [];
  FakeWebSocket.navigations = [];
  FakeWebSocket.evaluations = [];
});

describe('listChromeDebugBrowserTabs', () => {
  test('accepts public debugUrl and auto-detects the loaded Codex extension id', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
      requestedUrls.push(url);
      return makeResponse(targets);
    };

    await expect(
      listChromeDebugBrowserTabs({
        debugUrl: 'http://127.0.0.1:9333',
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toMatchObject({ browserId: 'chrome-devtools' });

    expect(requestedUrls).toEqual(['http://127.0.0.1:9333/json/list']);
  });

  test('lists debuggable Brave page targets and verifies the configured Codex extension is loaded', async () => {
    const fetchImpl = async () => makeResponse(targets);

    await expect(
      listChromeDebugBrowserTabs({
        debugBaseUrl,
        extensionId,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual({
      backend: 'chrome',
      browserId: 'chrome-devtools',
      selectedTab: {
        id: 'page-1',
        title: 'Example Domain',
        url: 'https://example.com/',
      },
      tabs: [
        {
          id: 'page-1',
          title: 'Example Domain',
          url: 'https://example.com/',
        },
      ],
    });
  });
});

describe('runChromeDebugBrowserEval', () => {
  test('runs browser scripts with browser, tab, and nodeRepl bindings over the DevTools protocol', async () => {
    const fetchImpl = async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
      if (url.includes('/json/new')) {
        return makeResponse({
          id: 'new-page',
          type: 'page',
          title: 'New Tab',
          url: 'about:blank',
          webSocketDebuggerUrl: 'ws://new-page',
        });
      }
      return makeResponse(targets);
    };

    const result = await runChromeDebugBrowserEval({
      debugBaseUrl,
      extensionId,
      fetchImpl: fetchImpl as typeof fetch,
      WebSocketImpl: FakeWebSocket as any,
      script: `
const newTab = await browser.tabs.new();
await newTab.goto('https://example.com/');
return { title: await newTab.title(), text: await newTab.evaluate(() => document.body.innerText) };
`,
    });

    expect(result.content).toEqual([
      { type: 'text', text: '{\n  "title": "Example Domain",\n  "text": "hello from page"\n}' },
    ]);
    expect(FakeWebSocket.urls).toEqual(['ws://new-page']);
    expect(FakeWebSocket.navigations).toEqual(['https://example.com/']);
    expect(FakeWebSocket.closeCount).toBe(1);
  });
});
