# pi-retry

`pi-retry` is a Pi package that helps recover from retryable terminal assistant states.

It handles:

- refusals
- terse premature-abandonment stops after tool-backed work
- empty assistant stops
- malformed empty OpenAI Responses completions
- stranded tool-result leaves
- retryable terminal assistant errors
- length-truncated responses after successful compaction
- manual retry via `/retry`
- resume/startup/reload prompts for retryable leaves

## Install

Pi 0.84.1 or newer is required for the Pi host entrypoint.

Local path:

```bash
pi install /absolute/path/to/extensions/pi-retry
```

Temporary for the current run:

```bash
pi -e /absolute/path/to/extensions/pi-retry
```

## Host support

`pi-retry` is supported in both Pi and OMP.

The package exposes separate host entrypoints in `package.json`:

- Pi loads `./index.ts` from the `pi.extensions` manifest field.
- OMP loads `./omp.ts` from the `omp.extensions` manifest field.

The OMP entrypoint uses public extension APIs only. It supports terminal-leaf
detection, hidden continuation dispatch, context filtering, status updates,
manual `/retry`, startup retry prompts, and refusal rewrites. Pi additionally
enables a private AgentSession patch layer for provider retry classification,
prompt recovery, and session-tree display integration; OMP intentionally skips
that layer because OMP keeps the relevant AgentSession helpers private.

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
capped by the usable configured review models. Review requests preserve Pi's
credential-resolved base URL, environment, and header deletion markers. Rewrite
retries show their own counters, for example:

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
Generic providers retain the bounded hidden-`Continue.` recovery path.

For OpenAI Responses API families, `message_end` normalizes an empty or
reasoning-only completed response into a retryable provider error before it is
persisted. This prevents malformed `response.completed` output from appearing as
a successful assistant stop and lets Pi's normal retry/backoff path handle it.
Adapters that reconcile terminal `response.output` first, such as
`openai-websocket-responses`, recover missing terminal text before this fallback
is needed.

### Refusal

Assistant stop message whose visible text matches the refusal heuristics in `refusal-review.ts`.

### Premature abandonment

A terse assistant stop such as “I couldn’t complete the work” after the current user turn
already produced tool results. `pi-retry` leaves that response in the transcript and sends one
visible user message:

```text
[pi-retry] Continue the unfinished work. The previous response appears to have stopped prematurely; complete the task or report a concrete blocker with evidence.
```

The detector excludes responses that identify concrete blockers or include completion evidence.
Recovery is limited to one attempt so a model that gives up again cannot create a retry loop.

### Retryable terminal error

Assistant terminal error whose `errorMessage` matches the retryable provider classifier. This
includes transient Responses stream failures such as a 408
`stream closed before response.completed` frame after transport-level recovery is exhausted.
Nested gateway payloads are unwrapped with bounded recursion so a specific inner failure takes
precedence over a generic outer 500. Duplicate Responses item validation errors remove the
matching persisted assistant text item ID before retrying.

### Interrupted unexecuted tool call

An OpenAI Responses SSE stream can end after emitting a tool call but before its terminal event.
When no matching tool result exists, `pi-retry` branches the failed assistant artifact out of the
active path and automatically continues once in the same session. The continuation explicitly
tells the model that the tool did not run, so it must reassess state rather than assume a side
effect occurred.

This is continuation recovery, not provider-request replay. If a matching tool result exists,
`pi-retry` does not auto-continue because the action outcome may already be material.

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
  },
  "omp": {
    "extensions": ["./omp.ts"]
  }
}
```

That lets Pi and OMP discover their host-specific entrypoints instead of relying
only on `index.ts` fallback loading.
