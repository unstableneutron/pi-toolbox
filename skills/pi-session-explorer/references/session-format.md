# Pi Session JSONL Format

## Contents
- File location and naming
- Line types
- Message structure
- Content types
- Subagent sessions
- Common pitfalls

## File Location and Naming

Sessions are stored in `~/.pi/agent/sessions/` organized by project:

```
~/.pi/agent/sessions/
├── --Users-haza-Projects-sentry--/
│   ├── 2026-02-20T20-17-15-095Z_1a6f6bc4-....jsonl   ← parent session
│   ├── 2026-02-20T20-17-15-095Z_1a6f6bc4-.../        ← nested subagent sessions dir
│   │   └── 5f316403/                                  ← runId (8-char hex)
│   │       ├── run-0/session.jsonl                       ← parallel task 0
│   │       ├── run-1/session.jsonl                       ← parallel task 1
│   │       └── async-<uuid>/session.jsonl                ← async run
│   ├── subagent-artifacts/                              ← metadata & summaries
│   │   ├── 5f316403_worker_0_input.md
│   │   ├── 5f316403_worker_0_output.md
│   │   └── 5f316403_worker_0_meta.json
```

- Directory names encode the project path with `--` delimiters and `-` replacing `/`
- Parent session filenames: `<ISO-timestamp>_<UUID>.jsonl`
- Nested subagent session filenames are usually `session.jsonl`
- Each line is a standalone JSON object
- The nested subagent dir has the same stem as the parent JSONL (without `.jsonl`)
- The `runId` links nested session dirs to `subagent-artifacts/<runId>_*` files

## Line Types

Every line has a `type` field:

| Type | Purpose | Key Fields |
|------|---------|------------|
| `session` | First line, session metadata | `version`, `id`, `timestamp`, `cwd` |
| `model_change` | Model switch event | `provider`, `modelId` |
| `thinking_level_change` | Thinking mode change | `thinkingLevel` |
| `message` | Conversation content | `message: {role, content, ...}` |

## Message Structure

**Critical:** The actual message is nested inside a `message` field:

```json
{
  "type": "message",
  "id": "abc123",
  "parentId": "def456",
  "timestamp": "2026-02-20T20:49:39.589Z",
  "message": {
    "role": "user",
    "content": [{"type": "text", "text": "Hello"}],
    "timestamp": 1771620579506
  }
}
```

### Message Roles

| Role | Description |
|------|-------------|
| `user` | User messages |
| `assistant` | Agent responses (text, tool calls, thinking) |
| `toolResult` | Tool execution results |

### Assistant Messages with Metadata

```json
{
  "role": "assistant",
  "content": [...],
  "api": "anthropic-messages",
  "provider": "anthropic",
  "model": "claude-opus-4-6",
  "usage": {
    "input": 3, "output": 209,
    "cacheRead": 0, "cacheWrite": 11576, "totalTokens": 11788,
    "cost": {"input": 0.000015, "output": 0.005225, "total": 0.077}
  },
  "stopReason": "toolUse"
}
```

### toolResult Messages

```json
{
  "role": "toolResult",
  "toolCallId": "toolu_abc123",
  "toolName": "bash",
  "content": [{"type": "text", "text": "output here"}],
  "isError": false,
  "timestamp": 1771620584031
}
```

## Content Types

The `content` field is an array of typed objects:

| Type | Found In | Fields |
|------|----------|--------|
| `text` | user, assistant, toolResult | `text` |
| `toolCall` | assistant | `id`, `name`, `arguments` |
| `thinking` | assistant | `thinking`, `thinkingSignature` |

## Subagent Sessions

When the main agent delegates to subagents (worker, reviewer, scout), the subagent `toolResult` contains rich metadata in a `details` field.

### Subagent toolResult Structure

```json
{
  "role": "toolResult",
  "toolCallId": "toolu_xxx",
  "toolName": "subagent",
  "content": [{"type": "text", "text": "Done. Added the Workflow link..."}],
  "details": {
    "mode": "single",
    "results": [...],
    "artifacts": {...}
  }
}
```

### details.mode

| Mode | Description |
|------|-------------|
| `single` | One agent, one task |
| `parallel` | Multiple agents running concurrently |
| `chain` | Sequential pipeline, each step feeds the next |

### details.results[]

Each result object contains:

| Field | Type | Description |
|-------|------|-------------|
| `agent` | string | Agent name (worker, reviewer, scout) |
| `task` | string | The task prompt given to the agent |
| `exitCode` | number | 0 = success, non-zero = failure |
| `messages` | array | Full conversation (same format as session messages, inline) |
| `model` | string | Model used (e.g., "claude-sonnet-4-6:minimal") |
| `usage` | object | `{input, output, cacheRead, cacheWrite, cost, turns}` |
| `progressSummary` | object | `{toolCount, tokens, durationMs}` |
| `skills` | array | Skill names loaded (e.g., ["commit"]) |
| `sessionFile` | string | Path to full JSONL in temp dir |
| `artifactPaths` | object | Paths to input/output/jsonl/metadata files |
| `progress` | object | Status tracking with task details |

### details.artifacts

```json
{
  "dir": "~/.pi/agent/sessions/<project>/subagent-artifacts",
  "files": [
    {
      "inputPath": ".../<hash>_worker_input.md",
      "outputPath": ".../<hash>_worker_output.md",
      "jsonlPath": ".../<hash>_worker.jsonl",
      "metadataPath": ".../<hash>_worker_metadata.json"
    }
  ]
}
```

### Subagent Session File Locations

Four ways to access subagent session data (in order of reliability):

1. **Nested session dir** — `<parent-session-stem>/<runId>/run-<N>/session.jsonl` (persistent, preferred for full sessions)
2. **Inline messages** — `details.results[].messages` (embedded in parent, always available but may lack tool details)
3. **Temp session file** — `details.results[].sessionFile` at `$TMPDIR/pi-subagent-session-<random>/run-<N>/` (may be cleaned up)
4. **Persistent artifacts** — `details.artifacts.files[]` in `subagent-artifacts/` (meta/input/output always available; JSONL may be deleted in favor of nested dir)

To read a subagent's full session, first check the nested session dir, then fall back to `sessionFile` or `artifactPaths.jsonlPath`. Use `skills/pi-session-explorer/bin/session-explorer read <path> --mode overview` for all session JSONLs.

## Assistant Diagnostics

Assistant messages may include a `diagnostics` array. The consolidated reader exposes these via:

```bash
skills/pi-session-explorer/bin/session-explorer read <session.jsonl> --mode diagnostics
skills/pi-session-explorer/bin/session-explorer read <session.jsonl> --mode websocket
```

For `openai_websocket_transport`, important fields are:

| Field | Triage meaning |
|-------|----------------|
| `outcome` | `completed`, `transport_error`, fallback outcomes, etc. |
| `eventCount` / `responseIdSeen` | Whether the stream made progress and saw a response id |
| `firstEventMs` / `responseCreatedMs` / `completedMs` | Startup and completion timing |
| `continuation` | `delta`, `no_continuation`, or cache decision state |
| `previousResponseId` / `fallback` | Server-state continuation and fallback behavior |
| `requestBytes` / `fullBytes` | Sent payload size vs full-context payload size |
| `sentInputItems` / `fullInputItems` | Sent input items vs full-context item count |

An empty assistant turn with zero usage and `outcome: transport_error` is a provider/transport stall artifact, not a model-authored empty answer.

## Common Pitfalls

1. **Nested message:** Content is at `line.message.content`, NOT `line.content`
2. **Content is an array:** Even single messages use `[{type: "text", text: "..."}]`
3. **Tool results are separate entries:** Not inside the assistant message
4. **Large sessions:** Tool results often contain huge outputs
5. **String content:** Some older content fields may be plain strings
6. **Subagent details:** The `details` field on subagent toolResults is NOT in the `content` array — it's a sibling of `content` on the message object
7. **Subagent session locations:** `sessionFile` paths are in `$TMPDIR` and get cleaned up. `artifactPaths.jsonlPath` may also be deleted. The reliable location is the nested session dir: `<parent-stem>/<runId>/run-<N>/`. Use `skills/pi-session-explorer/bin/session-explorer read <parent.jsonl> --mode subagents` which auto-resolves to the correct path.
