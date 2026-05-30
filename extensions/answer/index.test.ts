import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

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
