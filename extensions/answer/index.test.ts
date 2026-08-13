import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

import answerExtension from './index';

function createCommandHarness() {
  const commands = new Map<string, (args: string, ctx: any) => Promise<void> | void>();
  const pi = {
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, command.handler);
    },
    registerShortcut: () => {},
    events: { on: () => {} },
  };

  answerExtension(pi as any);
  return { commands };
}

describe('answer extension model selection config', () => {
  test('uses GPT-5.6 Luna without a Haiku fallback', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    expect(source).toContain("{ provider: 'openai-codex', id: 'gpt-5.6-luna' }");
    expect(source).toContain("{ provider: 'openai', id: 'gpt-5.6-luna' }");
    expect(source).not.toMatch(/haiku/i);
  });
});

describe('answer command mode guards', () => {
  test('returns without touching UI outside TUI mode', async () => {
    const { commands } = createCommandHarness();

    await expect(
      commands.get('answer')?.('', { mode: 'print', hasUI: false }),
    ).resolves.toBeUndefined();
  });
});
