import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, test, vi } from 'vitest';

const copyToClipboardMock = vi.hoisted(() => vi.fn());

// Force terminal-capability detection to report hyperlink support before
// pi-md-hooks is imported. Without this, getCapabilities() inspects the real
// process env ($TERM, $TERM_PROGRAM, etc.) and typically returns
// `hyperlinks: false` in a test runner, causing the file:// linkification
// under test to be skipped entirely.
vi.mock('@earendil-works/pi-tui', async () => {
  const actual =
    await vi.importActual<typeof import('@earendil-works/pi-tui')>('@earendil-works/pi-tui');
  return {
    ...actual,
    getCapabilities: () => ({
      images: null,
      trueColor: true,
      hyperlinks: true,
    }),
  };
});

vi.mock('@earendil-works/pi-coding-agent', async () => {
  const actual = await vi.importActual<typeof import('@earendil-works/pi-coding-agent')>(
    '@earendil-works/pi-coding-agent',
  );
  return {
    ...actual,
    copyToClipboard: copyToClipboardMock,
  };
});

import { Markdown, type MarkdownTheme } from '@earendil-works/pi-tui';

import {
  buildCodeBlockIndex,
  createPiMdHooksExtension,
  installMarkdownPatch,
  parseCopyCodeBlockLabel,
  resetPiMdHooksTestState,
  trimSharedLeadingWhitespace,
  type LoadMarkdownModule,
} from './index';

const plainMarkdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
};

async function createExtensionHarness(
  cwd: string,
  loader: LoadMarkdownModule = async () => ({ Markdown }),
) {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
  const commands = new Map<string, any>();
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => Promise<void> | void) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
  } as any;

  await createPiMdHooksExtension(loader)(pi);

  const notify = vi.fn();
  const ctx = {
    hasUI: true,
    mode: 'tui',
    sessionManager: {
      getCwd: () => cwd,
    },
    ui: {
      notify,
      addAutocompleteProvider: vi.fn(),
    },
  } as any;

  return { commands, handlers, ctx, notify };
}

function getHandler(
  handlers: Map<string, (event: any, ctx: any) => Promise<void> | void>,
  event: string,
) {
  const handler = handlers.get(event);
  if (!handler) {
    throw new Error(`Missing handler: ${event}`);
  }
  return handler;
}

afterEach(() => {
  vi.restoreAllMocks();
  copyToClipboardMock.mockReset();
  resetPiMdHooksTestState();
});

describe('pi-md-hooks markdown patch', () => {
  test('indexes fenced code blocks by assistant recency and block letter', () => {
    const index = buildCodeBlockIndex([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Old\n```bash\necho old\n```' }],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'New\n```ts\nconst newer = true;\n```\nThen\n```json\n{"ok":true}\n```',
          },
        ],
      },
    ] as any[]);

    expect(index.map((block) => [block.label, block.language, block.content])).toEqual([
      ['1a', 'ts', 'const newer = true;'],
      ['1b', 'json', '{"ok":true}'],
      ['2a', 'bash', 'echo old'],
    ]);
  });

  test('parses copy-codeblock labels case-insensitively', () => {
    expect(parseCopyCodeBlockLabel('1a')).toEqual({ messageNumber: 1, blockIndex: 0 });
    expect(parseCopyCodeBlockLabel('2C')).toEqual({ messageNumber: 2, blockIndex: 2 });
    expect(parseCopyCodeBlockLabel('0a')).toBeUndefined();
    expect(parseCopyCodeBlockLabel('1')).toBeUndefined();
  });

  test('trims shared leading whitespace from copied code blocks', () => {
    expect(trimSharedLeadingWhitespace('    one\n      two\n\n    three')).toBe(
      'one\n  two\n\nthree',
    );
  });

  test('renders labels before indexed assistant code blocks only after TUI session_start', async () => {
    const harness = await createExtensionHarness('/tmp/project');

    const before = new Markdown('```ts\nconst before = true;\n```', 0, 0, plainMarkdownTheme)
      .render(120)
      .join('\n');
    expect(before).not.toContain('// 1a');

    harness.ctx.sessionManager.getBranch = () => [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '```ts\nconst before = true;\n```' }],
        },
      },
    ];
    await getHandler(harness.handlers, 'session_start')(
      { type: 'session_start' },
      { ...harness.ctx, mode: 'tui' },
    );

    const after = new Markdown('```ts\nconst before = true;\n```', 0, 0, plainMarkdownTheme)
      .render(120)
      .join('\n');
    expect(after).toContain('// 1a');
  });

  test('copy command copies a labeled code block from the active TUI session', async () => {
    const harness = await createExtensionHarness('/tmp/project');
    harness.ctx.sessionManager.getBranch = () => [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '```ts\n    const copied = true;\n      console.log(copied);\n```',
            },
          ],
        },
      },
    ];

    const copyCommand = harness.commands.get('copy');
    await copyCommand.handler('1a', harness.ctx);

    expect(copyToClipboardMock).toHaveBeenCalledWith(
      'const copied = true;\n  console.log(copied);',
    );
    expect(harness.notify).toHaveBeenCalledWith('Copied code block 1a', 'info');
  });

  test('autocomplete suggests labeled code blocks for copy arguments', async () => {
    const harness = await createExtensionHarness('/tmp/project');
    harness.ctx.sessionManager.getBranch = () => [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '```bash\npnpm test\n```' }],
        },
      },
    ];
    await getHandler(harness.handlers, 'session_start')({ type: 'session_start' }, harness.ctx);

    const wrapper = harness.ctx.ui.addAutocompleteProvider.mock.calls[0][0];
    const delegate = {
      getSuggestions: vi.fn(),
      applyCompletion: vi.fn(),
      shouldTriggerFileCompletion: vi.fn(),
    };

    const provider = wrapper(delegate);
    const suggestions = await provider.getSuggestions(['/copy '], 0, 6, {
      signal: new AbortController().signal,
    });

    expect(suggestions).toEqual({
      prefix: '',
      items: [{ value: '1a', label: '1a', description: 'bash  pnpm test' }],
    });
  });

  test('delegates markdown link rendering to the underlying Markdown implementation', async () => {
    class FakeMarkdown {
      theme = plainMarkdownTheme;

      getDefaultInlineStyleContext() {
        return {
          applyText: (text: string) => text,
          stylePrefix: '',
        };
      }

      renderInlineTokens(
        tokens: any[],
        styleContext = this.getDefaultInlineStyleContext(),
      ): string {
        return tokens
          .map((token) => {
            if ('link' === token.type) {
              return `ORIGINAL_LINK:${token.text}->${token.href}`;
            }

            if ('text' === token.type) {
              if (token.tokens?.length) {
                return this.renderInlineTokens(token.tokens, styleContext);
              }
              return styleContext.applyText(token.text ?? '');
            }

            if ('paragraph' === token.type) {
              return this.renderInlineTokens(token.tokens ?? [], styleContext);
            }

            if ('codespan' === token.type) {
              return `CODE:${token.text}`;
            }

            if ('string' === typeof token.text) {
              return styleContext.applyText(token.text);
            }

            return '';
          })
          .join('');
      }
    }

    await installMarkdownPatch(async () => ({ Markdown: FakeMarkdown }));

    const markdown = new FakeMarkdown() as any;
    const rendered = markdown.renderInlineTokens([
      {
        type: 'link',
        text: '#1213',
        href: 'https://github.com/badlogic/pi-mono/issues/1213',
        tokens: [{ type: 'text', text: '#1213' }],
      },
    ]);

    expect(rendered).toBe('ORIGINAL_LINK:#1213->https://github.com/badlogic/pi-mono/issues/1213');
  });

  test('renders inline-code file references as clickable file links after session_start sets cwd', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-md-hooks-'));
    const sourceDir = path.join(tempDir, 'src');
    const sourceFile = path.join(sourceDir, 'foo.ts');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourceFile, 'export const foo = 1;\n');

    try {
      const harness = await createExtensionHarness(tempDir);
      await getHandler(harness.handlers, 'session_start')({ type: 'session_start' }, harness.ctx);

      const markdown = new Markdown('Open `src/foo.ts:12:3` next', 0, 0, plainMarkdownTheme);
      const rendered = markdown.render(120).join('\n');

      expect(rendered).toContain(pathToFileURL(sourceFile).href);
      expect(rendered).toContain('src/foo.ts:12:3');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('renders absolute inline-code file references without requiring an active cwd', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-md-hooks-'));
    const sourceFile = path.join(tempDir, 'foo.ts');
    fs.writeFileSync(sourceFile, 'export const foo = 1;\n');

    try {
      await installMarkdownPatch(async () => ({ Markdown }));

      const markdown = new Markdown(`Open \`${sourceFile}:12\` next`, 0, 0, plainMarkdownTheme);
      const rendered = markdown.render(240).join('\n');

      expect(rendered).toContain(pathToFileURL(sourceFile).href);
      expect(rendered).toContain(`${sourceFile}:12`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('renders directory references in plain text when they exist under cwd', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-md-hooks-'));
    const testsDir = path.join(tempDir, 'scratch', 'example-obs-lake', 'tests');
    fs.mkdirSync(testsDir, { recursive: true });

    try {
      const harness = await createExtensionHarness(tempDir);
      await getHandler(harness.handlers, 'session_start')({ type: 'session_start' }, harness.ctx);

      const markdown = new Markdown('- scratch/example-obs-lake/tests/', 0, 0, plainMarkdownTheme);
      const rendered = markdown.render(240).join('\n');

      expect(rendered).toContain(pathToFileURL(testsDir).href);
      expect(rendered).toContain('scratch/example-obs-lake/tests/');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('renders tilde-prefixed directory references in plain text when they exist', async () => {
    const originalHome = process.env.HOME;
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-md-hooks-home-'));
    const skillFile = path.join(
      tempHome,
      '.agents',
      'skills',
      'example-service-observability',
      'SKILL.md',
    );
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, '# skill\n');
    process.env.HOME = tempHome;

    try {
      await installMarkdownPatch(async () => ({ Markdown }));

      const markdown = new Markdown(
        '- ~/.agents/skills/example-service-observability/SKILL.md',
        0,
        0,
        plainMarkdownTheme,
      );
      const rendered = markdown.render(240).join('\n');

      expect(rendered).toContain(pathToFileURL(skillFile).href);
      expect(rendered).toContain('~/.agents/skills/example-service-observability/SKILL.md');
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test('leaves missing inline-code file references unchanged', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-md-hooks-'));

    try {
      const harness = await createExtensionHarness(tempDir);
      await getHandler(harness.handlers, 'session_start')({ type: 'session_start' }, harness.ctx);

      const markdown = new Markdown('Open `src/missing.ts:12` next', 0, 0, plainMarkdownTheme);
      const rendered = markdown.render(120).join('\n');

      expect(rendered).not.toContain('file://');
      expect(rendered).toContain('src/missing.ts:12');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('installs the markdown patch only once', async () => {
    const loader = vi.fn().mockResolvedValue({ Markdown });

    await installMarkdownPatch(loader);
    await installMarkdownPatch(loader);

    expect(loader).toHaveBeenCalledTimes(1);
  });

  test('clears relative file resolution state on session_shutdown', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-md-hooks-'));
    const sourceDir = path.join(tempDir, 'src');
    const sourceFile = path.join(sourceDir, 'foo.ts');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourceFile, 'export const foo = 1;\n');

    try {
      const harness = await createExtensionHarness(tempDir);
      await getHandler(harness.handlers, 'session_start')({ type: 'session_start' }, harness.ctx);
      await getHandler(harness.handlers, 'session_shutdown')(
        { type: 'session_shutdown' },
        harness.ctx,
      );

      const markdown = new Markdown('Open `src/foo.ts:12` next', 0, 0, plainMarkdownTheme);
      const rendered = markdown.render(120).join('\n');

      expect(rendered).not.toContain(pathToFileURL(sourceFile).href);
      expect(rendered).toContain('src/foo.ts:12');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('warns softly only once when the internal Markdown module cannot be loaded', async () => {
    const harness = await createExtensionHarness('/tmp/project', async () => ({
      Markdown: undefined,
    }));

    const sessionStart = getHandler(harness.handlers, 'session_start');
    await sessionStart({ type: 'session_start' }, harness.ctx);
    await sessionStart({ type: 'session_start' }, harness.ctx);

    expect(harness.notify).toHaveBeenCalledTimes(1);
    expect(harness.notify).toHaveBeenCalledWith(
      expect.stringContaining('pi-md-hooks disabled:'),
      'warning',
    );
  });
});
