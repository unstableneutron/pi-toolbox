# Test fixtures

Two corpora drive `bash-rewrite-corpus.test.ts`:

| File                      | Source                                                                                 | Committed?      | Role                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash-corpus.jsonl`       | [`badlogicgames/pi-mono`](https://huggingface.co/datasets/badlogicgames/pi-mono) on HF | yes             | Public regression fixture. CI always runs against this.                                                                                                                |
| `bash-corpus.local.jsonl` | `~/.pi/agent/sessions`                                                                 | no (gitignored) | Optional local validation set. If present, the same invariants run against it so you can cross-check the classifier against your own traffic before shipping a change. |

Both files are JSON Lines, one `{"command": "..."}` per line, deduplicated,
filtered (no multi-line, ≤ 2048 bytes), and sanitized through the pipeline in
`../scripts/extract-bash-corpus.py`.

## `bash-corpus.jsonl` (public, committed)

Derived from the public
[`badlogicgames/pi-mono`](https://huggingface.co/datasets/badlogicgames/pi-mono)
coding-agent session-traces dataset, authored by [@badlogic](https://github.com/badlogic)
(Mario Zechner, maintainer of Pi). The dataset is "best-effort redacted" by
pi-share-hf plus LLM review; we apply the same sanitizer pass below as
defense-in-depth.

### Provenance

- Source dataset: `badlogicgames/pi-mono` on HuggingFace, license "other"
  (dataset card explicitly invites use under pi ecosystem tags
  `agent-traces`, `coding-agent`, `pi-share-hf`).
- We extract _bash command strings only_ — factual short strings, deduplicated
  — not the full session traces.
- Attribution in this README. No trace metadata (session IDs, timestamps,
  tool results, thinking levels, etc.) is redistributed.

### Refreshing

```shell
cd extensions/pi-fff-search
python3 scripts/extract-bash-corpus.py --from pi-mono \
    --out test-fixtures/bash-corpus.jsonl
```

Downloads the pi-mono parquet shard (~215 MB) to `/tmp/pi-mono-cache/` if
absent; subsequent runs hit the cache. Requires `duckdb` on PATH.

## `bash-corpus.local.jsonl` (private, gitignored)

Optional companion corpus you can build from your own Pi session logs. Never
committed — the file is listed in `.gitignore`.

```shell
cd extensions/pi-fff-search
python3 scripts/extract-bash-corpus.py --from local --days 7 \
    --out test-fixtures/bash-corpus.local.jsonl
```

### What the sanitizer redacts (both corpora)

The extraction script applies these sanitizers in order (see
`../scripts/extract-bash-corpus.py` for the authoritative list):

1. API tokens (GitHub, OpenAI/Anthropic, Slack, AWS, Bearer headers, JWTs).
2. Email addresses (including backslash-escaped shell-regex forms).
3. SSH `user@ipv4` credentials.
4. Private and public IPv4 addresses.
5. Home directory paths — canonical (`/Users/<name>`) and session-name
   (`--Users-<name>`) — normalized to `USER`.
6. Pi session UUID tails (`2026-04-21T…Z_019db1…`) normalized to `<SESSION_ID>`.
7. Employer-internal project / service / host names (extendable list) →
   `<internal>` / `<internal-host>`.
8. `com.airbnb.*` / `com/airbnb/*` Java package paths → `com/airbnb/<internal>`.
9. Current OS user (from `$USER`) → `USER`. For `--from pi-mono`, the
   author's public handle (`badlogic`) is also normalized to `USER`.

### Auditing your corpus

```shell
# Substitute your own username, email domain, employer-internal codenames:
grep -E '<your-username>|<your-email>|<internal-repo-name>' \
    test-fixtures/bash-corpus.local.jsonl
```

Add additional redaction patterns to the `SANITIZERS` / `INTERNAL_NAMES` lists
in the script, rerun, re-audit, commit only when clean.
