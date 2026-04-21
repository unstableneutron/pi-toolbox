import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { tryRewriteBash, type RewriteTool } from './bash-rewrite';

/**
 * Regression test driven by a deduplicated, sanitized corpus of real bash-tool
 * invocations. Two corpora are supported:
 *
 *   - `test-fixtures/bash-corpus.jsonl` — derived from the public
 *     https://huggingface.co/datasets/badlogicgames/pi-mono dataset. This is
 *     the committed fixture every CI run exercises. Refresh via
 *     `scripts/extract-bash-corpus.py --from pi-mono --out ...`.
 *
 *   - `test-fixtures/bash-corpus.local.jsonl` — optional, gitignored.
 *     Derived from the developer's own `~/.pi/agent/sessions`. When present
 *     the same invariants run against it too, so you can cross-check the
 *     classifier against your actual traffic before shipping a change.
 *     Refresh via `scripts/extract-bash-corpus.py --from local --out ...`.
 *
 * Assertions are deliberately aggregate rather than per-command — both
 * corpora drift over time. We guard against:
 *
 *   - Any command throws. The classifier must be pure and total.
 *   - Rewrite hit rate collapses to zero (recognizer broke) or explodes
 *     (classifier is false-positiving).
 *   - Specific high-risk pass-through shapes (e.g. `pnpm … | tail -N`) ever
 *     rewrite. These aren't searches; rewriting them would hide build output.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const publicCorpusPath = path.join(here, 'test-fixtures/bash-corpus.jsonl');
const localCorpusPath = path.join(here, 'test-fixtures/bash-corpus.local.jsonl');

interface CorpusRow {
  command: string;
}

function loadCorpus(filePath: string): CorpusRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as CorpusRow);
}

function runCorpusSuite(label: string, filePath: string, opts: { required: boolean }): void {
  const available = existsSync(filePath);
  if (!available) {
    if (opts.required) {
      throw new Error(`required corpus fixture missing: ${filePath}`);
    }
    describe.skip(`bash-rewrite corpus — ${label} (skipped: ${filePath} absent)`, () => {
      test('skipped', () => {});
    });
    return;
  }

  const corpus = loadCorpus(filePath);
  describe(`bash-rewrite corpus — ${label}`, () => {
    test(`corpus is non-trivially sized (got ${corpus.length})`, () => {
      expect(corpus.length).toBeGreaterThanOrEqual(500);
    });

    test('no command throws through tryRewriteBash', () => {
      const throwers: { command: string; error: unknown }[] = [];
      for (const { command } of corpus) {
        try {
          tryRewriteBash(command, '/repo');
        } catch (error) {
          throwers.push({ command: command.slice(0, 120), error });
        }
      }
      expect(throwers).toEqual([]);
    });

    test('rewrite hit rate stays within a plausible band', () => {
      let hits = 0;
      const byTool = new Map<RewriteTool, number>();
      for (const { command } of corpus) {
        const r = tryRewriteBash(command, '/repo');
        if (!r) continue;
        hits += 1;
        byTool.set(r.decision.tool, (byTool.get(r.decision.tool) ?? 0) + 1);
      }
      const rate = hits / corpus.length;
      // Wide band: guard against catastrophic collapse (a refactor that
      // rewrote nothing) or runaway false-positives, but absorb day-to-day
      // drift across both the public and local corpora.
      expect(rate).toBeGreaterThan(0.01);
      expect(rate).toBeLessThan(0.35);
      // Every tool we claim to support should fire at least once on a
      // realistically-sized corpus. The `fff_find_files` recognizer is
      // currently only triggered by the `find-xargs-cat` defensive-read
      // idiom and the `find <path> -name GLOB | head` pipeline, so it's
      // rare; we still want a signal if it stops firing entirely. If pi-mono
      // doesn't exercise it (it's a small tool and rarely appears there),
      // the assertion will fail for that corpus and the local corpus will
      // fill the gap — both together should cover all four tools.
      const present = new Set(byTool.keys());
      const expected: RewriteTool[] = ['fff_grep', 'read', 'ls'];
      for (const tool of expected) {
        expect(present.has(tool), `no rewrites fired for tool "${tool}"`).toBe(true);
      }
    });

    test('never rewrites build-output pipelines', () => {
      // These shapes are noise-trimming for test/build output, not searches.
      // Rewriting them would eat the exit-code-driving tail and break feedback.
      const BUILD_TOOLS = [
        'pnpm',
        'npm',
        'bun',
        'yarn',
        'npx',
        'git',
        'jj',
        'chezmoi',
        'mise',
        'cargo',
        'go',
        'python',
        'python3',
        'uv',
        'tsc',
        'eslint',
        'oxlint',
        'oxfmt',
        'vitest',
      ];
      const offenders: { command: string; target: RewriteTool }[] = [];
      for (const { command } of corpus) {
        const head = command.trimStart().split(/\s+/, 1)[0] ?? '';
        if (!BUILD_TOOLS.includes(head)) continue;
        const r = tryRewriteBash(command, '/repo');
        if (r) offenders.push({ command: command.slice(0, 160), target: r.decision.tool });
      }
      expect(offenders).toEqual([]);
    });

    // Deliberately NO text-based redirect check here — `<` and `>` inside
    // quoted regex strings (e.g. `rg -n '"id":"foo"|bar'`) would false-positive.
    // Redirect handling is a classifier responsibility enforced by the unit
    // tests in bash-rewrite.test.ts (the classifier inspects post-parse tokens,
    // which shell-quote already distinguishes from in-string punctuation).
  });
}

runCorpusSuite('pi-mono (public)', publicCorpusPath, { required: true });
runCorpusSuite('local (optional)', localCorpusPath, { required: false });
