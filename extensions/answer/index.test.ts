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
  test('uses an available OpenAI Codex mini model id', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/const CODEX_MODEL_ID = ["']gpt-5\.4-mini["'];/);
    expect(source).not.toContain('gpt-5.1-codex-mini');
  });

  test('uses the built-in anthropic haiku alias id', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/const HAIKU_MODEL_ID = ["']claude-haiku-4-5["'];/);
    expect(source).not.toContain('claude-haiku-4-5-20251001');
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
