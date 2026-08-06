import { stripVTControlCharacters } from 'node:util';

import { describe, expect, test } from 'vitest';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';

import { createExecutorRenderer } from './rendering';

function theme(): Theme {
  return {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  } as Theme;
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    expanded: false,
    isError: false,
    ...overrides,
  } as any;
}

function render(component: Component, width = 120): string {
  return stripVTControlCharacters(component.render(width).join('\n')).trimEnd();
}

describe('Executor tool rendering', () => {
  test('keeps execute calls compact and reveals redacted code only when expanded', () => {
    const renderer = createExecutorRenderer({ kind: 'execute', label: 'Executor Execute' });
    const args = {
      code: [
        'const token = "must-not-render";',
        'return tools["executor.coreTools.connections.list"]({ token });',
      ].join('\n'),
      waitMs: 5_000,
    };

    const collapsed = render(renderer.renderCall(args, theme(), context()));
    const expanded = render(renderer.renderCall(args, theme(), context({ expanded: true })));

    expect(collapsed).toBe('Executor Execute  coreTools.connections.list · 2 lines');
    expect(collapsed).not.toContain('const token');
    expect(expanded).toContain('wait 5s');
    expect(expanded).toContain('const token = "[REDACTED]";');
    expect(expanded).not.toContain('must-not-render');
  });

  test('summarizes completed execute results without repeating output', () => {
    const renderer = createExecutorRenderer({ kind: 'execute', label: 'Executor Execute' });
    const result = {
      content: [{ type: 'text', text: '{"integrations":[],"connections":[]}' }],
      details: {
        endpoint: 'https://user:password@executor.example.com/mcp?token=secret#fragment',
        source: 'executor-profile',
        fullOutputPath: '/tmp/private-output',
        structuredContent: {
          status: 'completed',
          result: { integrations: [], connections: [] },
          emitted: 1,
          logs: ['[log] connected', '[warn] retry avoided'],
        },
      },
    };

    const collapsed = render(
      renderer.renderResult(result, { expanded: false, isPartial: false }, theme(), context()),
    );
    const expanded = render(
      renderer.renderResult(
        result,
        { expanded: true, isPartial: false },
        theme(),
        context({ expanded: true }),
      ),
    );

    expect(collapsed).toBe('✓ 2 fields · integrations, connections · 1 emitted · 2 logs');
    expect(collapsed).not.toContain('{"integrations"');
    expect(expanded).toContain('"integrations": []');
    expect(expanded).toContain('Logs');
    expect(expanded).toContain('[warn] retry avoided');
    expect(expanded).toContain('https://executor.example.com/mcp');
    expect(expanded).not.toContain('password');
    expect(expanded).not.toContain('token=secret');
    expect(expanded).not.toContain('/tmp/private-output');
  });

  test('renders yielded and partial execution as active states', () => {
    const renderer = createExecutorRenderer({ kind: 'execute', label: 'Executor Execute' });
    const running = {
      content: [
        {
          type: 'text',
          text: '{"state":"running","jobId":"62e69344-3e49-491b","retryAfterMs":5000}',
        },
      ],
      details: {
        structuredContent: {
          state: 'running',
          jobId: '62e69344-3e49-491b',
          retryAfterMs: 5_000,
        },
      },
    };
    const partial = {
      content: [{ type: 'text', text: 'executor_execute: Loading Jenkins jobs' }],
      details: { structuredContent: null },
    };

    expect(
      render(
        renderer.renderResult(running, { expanded: false, isPartial: false }, theme(), context()),
      ),
    ).toBe('◌ Still running · job 62e69344 · retry in 5s');
    expect(
      render(
        renderer.renderResult(partial, { expanded: false, isPartial: true }, theme(), context()),
      ),
    ).toBe('Executing… · Loading Jenkins jobs');
  });

  test('uses only the bounded preview for a truncated expanded result', () => {
    const renderer = createExecutorRenderer({ kind: 'execute', label: 'Executor Execute' });
    const result = {
      content: [
        {
          type: 'text',
          text: 'bounded preview\n\n[Output truncated. outputId=output-1; nextOffset=15; totalBytes=50000. Use executor_read_output to continue.]',
        },
      ],
      details: {
        outputId: 'output-1',
        outputPage: { nextOffset: 15, totalBytes: 50_000 },
        structuredContent: {
          status: 'completed',
          result: { items: Array.from({ length: 100 }, () => 'must-not-render') },
          logs: [],
        },
      },
    };

    const expanded = render(
      renderer.renderResult(
        result,
        { expanded: true, isPartial: false },
        theme(),
        context({ expanded: true }),
      ),
    );

    expect(expanded).toContain('✓ 1 field · items · output truncated');
    expect(expanded).toContain('bounded preview');
    expect(expanded).toContain('Output ID output-1');
    expect(expanded).toContain('Total     49 KiB');
    expect(expanded).not.toContain('must-not-render');
    expect(expanded).not.toContain('[Output truncated.');
  });

  test('keeps errors short when collapsed and redacts credentials', () => {
    const renderer = createExecutorRenderer({ kind: 'execute', label: 'Executor Execute' });
    const result = {
      content: [
        {
          type: 'text',
          text: 'Error: request failed with Authorization: Bearer private-token\nremote stack line',
        },
      ],
    };

    const collapsed = render(
      renderer.renderResult(
        result,
        { expanded: false, isPartial: false },
        theme(),
        context({ isError: true }),
      ),
    );
    const expanded = render(
      renderer.renderResult(
        result,
        { expanded: true, isPartial: false },
        theme(),
        context({ expanded: true, isError: true }),
      ),
    );

    expect(collapsed).toBe('✗ request failed with Authorization: Bearer [REDACTED]');
    expect(collapsed).not.toContain('remote stack');
    expect(expanded).toContain('remote stack line');
    expect(expanded).not.toContain('private-token');
  });

  test('renders search counts and bounded expanded matches', () => {
    const renderer = createExecutorRenderer({ kind: 'search', label: 'Executor Search' });
    const result = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            items: [
              {
                path: 'executor.jenkins.jobs.list',
                kind: 'integration',
                summary: 'List Jenkins jobs.',
              },
            ],
            total: 7,
            nextCursor: 'opaque-cursor',
          }),
        },
      ],
      details: { structuredContent: null },
    };

    const collapsed = render(
      renderer.renderResult(result, { expanded: false, isPartial: false }, theme(), context()),
    );
    const expanded = render(
      renderer.renderResult(
        result,
        { expanded: true, isPartial: false },
        theme(),
        context({ expanded: true }),
      ),
    );

    expect(collapsed).toBe('1 of 7 matches');
    expect(expanded).toContain('executor.jenkins.jobs.list');
    expect(expanded).toContain('List Jenkins jobs.');
    expect(expanded).not.toContain('opaque-cursor');
  });
});
