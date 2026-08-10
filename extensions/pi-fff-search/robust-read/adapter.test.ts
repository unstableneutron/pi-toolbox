import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createLsToolDefinition } from '@earendil-works/pi-coding-agent';
import { createPiFffSearchExtension } from '../index';

const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'robust-read-adapter-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function harness(options: Parameters<typeof createPiFffSearchExtension>[0]) {
  const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const pi = {
    registerTool(tool: any) {
      tools.push(tool);
    },
    on(event: string, handler: (event: any, ctx: any) => any) {
      handlers.set(event, handler);
    },
    events: { on: () => () => {} },
  };
  createPiFffSearchExtension(options)(pi as any);
  return { read: tools.find((tool) => tool.name === 'read')!, tools, handlers };
}

function context(cwd: string, sessionId = 'session') {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
    },
  };
}

describe('Pi robust read adapter', () => {
  test('keeps exactly one read registration and composes missing paths through FFF', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'actual.txt'),
      ['resolved content', ...Array.from({ length: 100 }, (_, index) => `line ${index + 1}`)].join(
        '\n',
      ),
    );
    const callPublicToolOverHttp = vi.fn(async () => ({
      ok: true as const,
      value: {
        mode: 'compact' as const,
        base_path: cwd,
        next_cursor: null,
        items: [{ path: 'actual.txt' }],
      },
    }));
    const { read, tools } = harness({
      overrideBuiltinRead: true,
      robustReadConfig: { maxResponseBytes: 512 },
      ensureDaemonRunning: async () => {},
      callPublicToolOverHttp,
    });
    expect(tools.filter((tool) => tool.name === 'read')).toHaveLength(1);
    const result = await read.execute(
      'call',
      { path: 'missing.txt' },
      undefined,
      undefined,
      context(cwd),
    );
    expect(result.content[0].text).toContain('Path (fixed): actual.txt');
    expect(result.content[0].text).toContain('resolved content');
    expect(Buffer.byteLength(result.content[0].text, 'utf8')).toBeLessThanOrEqual(512);
    expect(result.details.nextOffset).toBeGreaterThan(1);
    expect(result.details).toMatchObject({ routedVia: 'fff-then-builtin' });
  });

  test('keeps the existing directory-to-ls flow', async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, 'folder'));
    const lsExecute = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'child.txt' }],
      details: undefined,
    }));
    const { read } = harness({
      overrideBuiltinRead: true,
      createBuiltInLsTool: ((toolCwd: string) => ({
        ...createLsToolDefinition(toolCwd),
        execute: lsExecute,
      })) as any,
    });
    const result = await read.execute(
      'call',
      { path: 'folder' },
      undefined,
      undefined,
      context(cwd),
    );
    expect(result.content[0].text).toContain('Auto-rewrote read → ls');
    expect(result.content[0].text).toContain('child.txt');
    expect(result.details).toMatchObject({ routedVia: 'read-to-ls' });
  });

  test('preserves Pi native image attachments using validated bytes', async () => {
    const cwd = await workspace();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
      'base64',
    );
    await writeFile(join(cwd, 'pixel.png'), png);
    const { read, handlers } = harness({
      overrideBuiltinRead: true,
      robustReadConfig: { enforceReadBeforeWrite: true },
    });
    const ctx = context(cwd);
    const result = await read.execute('call', { path: 'pixel.png' }, undefined, undefined, ctx);
    expect(result.content.some((entry: { type: string }) => entry.type === 'image')).toBe(true);
    expect(result.content[0].text).toContain('Read image file');
    expect(
      await handlers.get('tool_call')?.({ toolName: 'edit', input: { path: 'pixel.png' } }, ctx),
    ).toBeUndefined();

    const repeated = await read.execute('call', { path: 'pixel.png' }, undefined, undefined, ctx);
    expect(repeated.content[0].text).toContain('Image unchanged');
    expect(repeated.content.some((entry: { type: string }) => entry.type === 'image')).toBe(false);
  });

  test('enforces stale read-before-write state only when configured and allows new files', async () => {
    const cwd = await workspace();
    const path = join(cwd, 'state.txt');
    await writeFile(path, 'before');
    const { read, handlers } = harness({
      overrideBuiltinRead: true,
      robustReadConfig: { enforceReadBeforeWrite: true, rejectStaleWrites: true },
    });
    const ctx = context(cwd);
    expect(
      await handlers.get('tool_call')?.({ toolName: 'write', input: { path: 'new.txt' } }, ctx),
    ).toBeUndefined();
    expect(
      await handlers.get('tool_call')?.({ toolName: 'edit', input: { path: 'state.txt' } }, ctx),
    ).toMatchObject({ block: true });

    await read.execute('call', { path: 'state.txt' }, undefined, undefined, ctx);
    await writeFile(path, 'changed externally and longer');
    expect(
      await handlers.get('tool_call')?.({ toolName: 'edit', input: { path: 'state.txt' } }, ctx),
    ).toMatchObject({ block: true, reason: expect.stringContaining('Stale read') });
  });
});
