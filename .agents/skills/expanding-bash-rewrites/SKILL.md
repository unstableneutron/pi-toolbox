---
name: expanding-bash-rewrites
description: Use when newer models or heavier bash usage is surfacing commands the `bash-rewrite` classifier does not yet catch, when the `rewritten/total` ratio in the triage report has dropped, or when asked to add recognizers to `extensions/bash-rewrite/bash-rewrite.ts` from recent session traffic.
---

# Expanding the bash-rewrite classifier

## Overview

`extensions/bash-rewrite/bash-rewrite.ts` classifies `bash` tool calls that collapse to structured tools (`read`, `ls`, `fff_grep`, `fff_find_files`, or `apply_patch`) and the active `extensions/bash-rewrite/index.ts` orchestrator dispatches them to providers. Everything else passes through to builtin bash. Coverage drifts as newer models reach for shell shapes older ones didn't. `scripts/extract-bash-corpus.ts --triage` extracts recent sessions, runs each command through `tryRewriteBash`, and clusters pass-throughs — the source of candidate recognizers.

## The loop

`extract + triage → sample clusters → implement recognizer + tests → re-triage → commit`

One or two recognizers per round. Stop when a round adds nothing measurable — the remaining clusters are build tools, vcs, or shell flow control.

## Commands

```shell
aube exec vitest run extensions/bash-rewrite/bash-rewrite.test.ts \
  extensions/bash-rewrite/bash-rewrite-corpus.test.ts

cd extensions/bash-rewrite
./scripts/extract-bash-corpus.ts --from local --days 3 \
    --out test-fixtures/bash-corpus.local.jsonl --triage
pnpm test                       # unit + corpus regression
pnpm run fix && pnpm run check  # after every bash-rewrite.ts edit
```

The triage report shows totals, per-tool/recognizer counts, and top pass-through clusters keyed by `first-token[:pipeN][:redir][:subsh][:chain][:@second-token]`.

## Classifying a cluster

Sample 3–5 commands from each top cluster, then classify:

- **Rewritable** — simple shape, safe semantics, maps to a target tool (e.g. `/usr/bin/grep PAT FILE`, `cat FILE | sed -n 'N,Mp'`).
- **Not a candidate** — build tools (`cargo`, `pnpm`), vcs (`git`, `gh`), shell flow (`for`, `if`), edit ops (`sed -i`), env-prefixed invocations.
- **Intentional pass-through** — existing recognizer deliberately bails (`grep -c`, `find -o` boolean, multi-file `head`/`cat` with order-dependent output).

If rewritable, identify what's blocking the existing recognizer (first-token match, flag handling, stage count, redirect shape).

Signature buckets collapsed into `cd:chain:@/Users/USER/Projects/foo`? Re-cluster on the actual work token:

```shell
jq -r '.command' test-fixtures/bash-corpus.local.jsonl \
  | awk '{ w=$0; sub(/^cd [^&]+&& */, "", w); split(w, a, " "); print a[1] }' \
  | sort | uniq -c | sort -rn | head -20
```

For a sharper lens on "is this specific shape passing through, and why," use the probe script — it runs every command through `tryRewriteBash` and samples unique pass-through shapes per first-token:

```shell
./scripts/probe-passthrough.ts test-fixtures/bash-corpus.local.jsonl grep 20
./scripts/probe-passthrough.ts test-fixtures/bash-corpus.local.jsonl head 20
```

## Current recognizer inventory

Read this before adding anything new — your target may already exist and just need one flag or shape loosened.

| Recognizer            | Source shape                                     | Target                                                                |
| --------------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| `cat-file`            | `cat FILE`                                       | `read(path)`                                                          |
| `ls-dir`              | `ls [flags] [PATH]`                              | `ls(path?)`                                                           |
| `head-n-file`         | `head [-N] FILE`                                 | `read(path, limit?)`                                                  |
| `grep-search`         | `grep/rg/egrep/fgrep PAT [FILE ...]`             | `fff_grep(patterns, within, …)` — multi-path emits `within: string[]` |
| `find-name-glob`      | `find PATH -name GLOB`                           | `fff_find_files(query, glob)`                                         |
| `fd-search`           | `fd PAT [PATH]`                                  | `fff_find_files(query, within?)`                                      |
| `sed-range-print`     | `sed -n 'N,Mp' FILE`                             | `read(path, offset, limit)`                                           |
| `cat-sed-range`       | `cat FILE \| sed -n 'N,Mp'`                      | `read(path, offset, limit)`                                           |
| `cat-grep`            | `cat FILE \| grep PAT`                           | `fff_grep(patterns, within, …)`                                       |
| `find-xargs-cat`      | `find PATH \| head -1 \| xargs cat [\| head -N]` | `read(path, limit?)`                                                  |
| `apply-patch-heredoc` | `apply_patch <<'PATCH' … PATCH`                  | `apply_patch(patch)`                                                  |
| `<recognizer>+head`   | any of the above `\| head -N`                    | same target, with `limit: N`                                          |

## Adding a recognizer

Most command recognizer changes live in `bash-rewrite.ts`; `apply_patch` heredoc parsing lives in `apply-patch.ts`:

- **Single-stage** — add a `classify*` function and register it in `SINGLE_STAGE_CLASSIFIERS`. Model it on `classifyCat` / `classifyGrep` / `classifySedRange`.
- **Multi-stage pipeline** — extend the two-stage branch in `tryRewriteBash` (`strippedStages.length === 2`). When the upstream stage is `cat FILE`, pair it with an `extract*Filter` helper that reuses the single-stage classifier but rejects any shape that already carries its own FILE arg. See the `cat-sed-range` branch (template) and `cat-grep` (analogue).
- **New prefix** (absolute path, shell builtin, env-var, …) — extend `FIRST_TOKEN_PATTERN` (gate) and `normalizeStageFirstToken` (per-stage) together.

Recognizer naming — kebab-case, two schemes:

- **Single-source** — end with the source tool: `grep-search`, `cat-file`, `sed-range-print`.
- **Pipeline composition** — join the two stages with `-`: `cat-grep`, `cat-sed-range`. Do **not** use `+head`-style suffixes here; `+head` is reserved for the automatic append of a trailing `| head -N` limit.

Tests in `bash-rewrite.test.ts` or `apply-patch.test.ts` — always cover:

1. Happy path (correct `tool`, `params`, `recognizer`).
2. At least one negative case that must still pass through.
3. `cd X && <new-shape>` prefix composition if the shape can appear after a `cd`.
4. `| head -N` stacking if the recognizer has a meaningful `limit`.

## Measuring lift

Record `rewritten/total` and targeted recognizer counts before and after. Pre-commit gate — all three must pass:

1. **Rewrite rate rises** on the same local corpus (re-run the triage command, compare reports).
2. **`pnpm test` is green** — unit tests + corpus regression invariants.
3. **pi-mono corpus byte-identical** — extraction changes would show up here:

```shell
cd extensions/bash-rewrite
./scripts/extract-bash-corpus.ts --from pi-mono --out /tmp/after.jsonl \
  && diff test-fixtures/bash-corpus.jsonl /tmp/after.jsonl
```

If you're only editing `bash-rewrite.ts` (not the extractor), (3) will always pass — but run it anyway as a cheap smoke test.

## Commit style

One commit per round. Imperative subject, body lists findings + measured lift. Example:

```
Recognize /usr/bin/ and `command` prefixes; add cat|sed pipeline

- rewrite rate: 14.3% -> 16.6% on 2474-cmd 3-day corpus
- grep-search: 57 -> 88 (+31); grep-search+head: 111 -> 135 (+24)
- new cat-sed-range: 5 hits
```

## Common mistakes

- **Rewriting build/test pipelines.** `pnpm … | tail`, `cargo test | grep FAILED` trim noise from exit-code-driving output — rewriting hides errors. `bash-rewrite-corpus.test.ts` enforces this invariant.
- **Trusting the `@second-token` tag.** The signature is intentionally coarse; always sample real commands.
- **Skipping negative tests.** A too-eager recognizer silently drops semantics. Every recognizer needs at least one `toBeNull()` case.
- **Gate + normalizer drift.** If a new prefix passes the gate but downstream classifiers see the raw tokens, they'll mismatch.
- **Expanding `BINARY_PATH_PREFIX_PATTERN` to user `$PATH` dirs.** Stick to `/usr/bin`, `/bin`, `/usr/local/bin`, `/opt/homebrew/bin` — user-installed tools at other paths may differ in flags or semantics.
- **Committing `.local.jsonl` / `.triage.md`.** Both are gitignored; only `bash-corpus.jsonl` is committed.
- **Adding provider dispatch in the classifier.** Keep parser decisions in `bash-rewrite.ts`; execution belongs in `extensions/bash-rewrite/index.ts` providers or external provider listeners.
- **Reintroducing a second `bash` override.** `pi-fff-search` and `multi-edit` register providers over `pi.events`; only `pi-bash-rewrite` registers `bash`.

## See also

- `extensions/bash-rewrite/bash-rewrite.ts` — classifier
- `extensions/bash-rewrite/index.ts` — active bash override/orchestrator and provider contract
- `extensions/bash-rewrite/apply-patch.ts` — `apply_patch <<'PATCH'` heredoc recognizer
- `extensions/bash-rewrite/bash-rewrite.test.ts` — unit tests
- `extensions/bash-rewrite/bash-rewrite-corpus.test.ts` — corpus regression invariants
- `extensions/bash-rewrite/test-fixtures/README.md` — corpus + sanitizer notes
- `extensions/pi-fff-search/index.ts` and `extensions/multi-edit/index.ts` — provider listeners
