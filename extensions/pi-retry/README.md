# pi-retry

`pi-retry` is a Pi package that helps recover from retryable terminal assistant states.

It handles:

- refusals
- empty assistant stops
- stranded tool-result leaves
- retryable terminal assistant errors
- length-truncated responses after successful compaction
- manual retry via `/retry`
- resume/startup/reload prompts for retryable leaves

## Install

Local path:

```bash
pi install /absolute/path/to/extensions/pi-retry
```

Temporary for the current run:

```bash
pi -e /absolute/path/to/extensions/pi-retry
```

## What it does

### Live recovery

When a run reaches a retryable terminal state, `pi-retry`:

1. classifies the terminal leaf
2. records pending recovery intent
3. dispatches recovery only after the run is idle

This avoids stranded queued follow-up messages that can happen when relying on same-run follow-up timing.

While recovery is in progress, `pi-retry` now updates status by phase:

- queued: for example `↻ Refusal detected; retrying...`
- dispatched: for example `↻ Continue sent; waiting for recovery...`
- recovered: a brief success status before clearing
- exhausted / failed: clears or replaces stale retry text with a warning state

For refusal recovery, `pi-retry` now uses a stock preset of continue-style follow-up
messages for the first 5 attempts. The first continue attempt stays visually clean with
no counter suffix, and later continue attempts show `· 2/5` through `· 5/5`.

If refusal rewrites are enabled, `pi-retry` then tries up to 2 rewrite-based retries,
capped by the usable configured review models. Rewrite retries show their own counters,
for example:

- `↻ Refusal detected; asking gpt-5.4 for review...`
- `↻ Rewrite sent; waiting for recovery...`
- `↻ Refusal detected; asking gemini-3.1-pro-preview for review... · 2/2`

### Reopen/resume/reload recovery

On `startup`, `resume`, and `reload`, `pi-retry` inspects the current session leaf.

If the leaf still looks retryable, it shows a confirm dialog and can send the first
recovery message immediately.

### Manual retry

Use:

```text
/retry
```

The command:

- waits for the current run to become idle
- checks the current leaf
- reuses the same confirm prompt and immediate recovery path
- notifies you if the current leaf is not retryable

## Retryable leaf types

### Empty stop

Assistant message with `stopReason: "stop"` but no user-visible text or tool call output.

### Refusal

Assistant stop message whose visible text matches the refusal heuristics in `refusal-review.ts`.

### Retryable terminal error

Assistant terminal error whose `errorMessage` matches the retryable provider classifier.

### Length-truncated response after compaction

Assistant message with `stopReason: "length"` and no tool calls. If Pi successfully compacts
immediately afterward, `pi-retry` sends a hidden continuation message from the compaction leaf:

```text
Continue from where you were cut off. Do not repeat prior content.
```

This is limited to one automatic continuation attempt per uninterrupted recovery sequence.

### Stranded tool results

A branch whose leaf is a `toolResult` after every tool call from the nearest assistant
`toolUse` message has returned. `pi-retry` sends `Continue.` from that leaf instead of
branching, so the next model call sees the completed tool results.

## Configuration

### Disable extension-owned terminal-leaf recovery

```bash
export PI_RETRY_REFUSAL_RECOVERY_DISABLED=1
```

Accepted truthy values:

- `1`
- `true`
- `yes`

Despite the historical variable name, this currently disables the extension-owned terminal-leaf recovery flow more broadly.

### Tune refusal continue attempts

```bash
export PI_RETRY_REFUSAL_CONTINUE_ATTEMPTS=5
```

Defaults to `5`.

### Tune refusal rewrite attempts

```bash
export PI_RETRY_REFUSAL_REWRITE_ATTEMPTS=2
```

Defaults to `2`, but the effective rewrite count is capped by the review models
available at runtime.

### Disable refusal rewrites only

```bash
export PI_RETRY_REFUSAL_REWRITES_DISABLED=1
```

Accepted truthy values:

- `1`
- `true`
- `yes`

When set, refusals stop after the configured continue-attempt budget and never
escalate to rewrite review.

## Development

From `extensions/pi-retry/`:

```bash
pnpm run check
pnpm run fix
npx vitest run index.test.ts runtime.test.ts refusal-review.test.ts
```

Targeted tests:

```bash
npx vitest run index.test.ts runtime.test.ts refusal-review.test.ts
```

## Package metadata

This package uses the Pi package manifest in `package.json`:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

That lets Pi discover it as a package instead of relying only on `index.ts` fallback loading.
