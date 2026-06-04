---
name: pi-session-explorer
description: Use when investigating Pi session JSONL files, session history, subagent runs, slow or empty turns, WebSocket diagnostics, or aggregate patterns across many Pi sessions.
---

# Pi Session Explorer

Canonical CLI for Pi session forensics. It handles both one-session reads and aggregate scans.

## Quick Start

```bash
skills/pi-session-explorer/bin/session-explorer read <session.jsonl> --mode overview
skills/pi-session-explorer/bin/session-explorer read <session.jsonl> --mode diagnostics
skills/pi-session-explorer/bin/session-explorer read <session.jsonl> --mode websocket
skills/pi-session-explorer/bin/session-explorer ws --root <project-or-jsonl-dir> --since 48h
```

Use `--max-content 0` for untruncated content and `--offset`/`--limit` to page by user turn.

## Single-Session Modes

| Need | Command |
|------|---------|
| First pass | `read <file> --mode overview` |
| Conversation only | `read <file> --mode conversation` |
| Full tool I/O | `read <file> --mode full --max-content 0` |
| Tool calls/results | `read <file> --mode tools` |
| Cost/cache tokens | `read <file> --mode costs` |
| Subagent paths/status | `read <file> --mode subagents` |
| Empty/error/transport turns | `read <file> --mode diagnostics` |
| OpenAI WebSocket latency/continuation | `read <file> --mode websocket` |

## Aggregate WebSocket Triage

```bash
skills/pi-session-explorer/bin/session-explorer ws --root <project-or-jsonl-dir> --since 48h
skills/pi-session-explorer/bin/session-explorer ws --root <dir> --errors
skills/pi-session-explorer/bin/session-explorer ws --root <dir> --slow-start-ms 30000
skills/pi-session-explorer/bin/session-explorer ws --root <dir> --continuation
```

`--root` accepts a project root, an encoded Pi sessions directory, or any directory containing `.jsonl` files such as `scratch/openai-ws-smoke-sessions/`.
`--since` is relative to the latest diagnostic found in the scanned set, which keeps archived session bundles queryable.

## Interpretation Rules

- A large timestamp gap before the first assistant turn is a slow-start/stall clue; confirm with `--mode diagnostics`.
- Empty assistant + zero usage + `outcome: transport_error` means transport/provider artifact, not an intentional model response.
- For WebSocket continuation, compare `continuation`, `previousResponseId`, `sentInputItems/fullInputItems`, and `requestBytes/fullBytes`.
- `delta` means fewer input items were sent against `previousResponseId`; payload bytes may still be close to full context when the new item is large.
- `firstEventMs`, `responseCreatedMs`, and `completedMs` distinguish startup latency from full turn duration.
- `--errors` finds non-`completed` outcomes; use `--slow-start-ms` separately for slow-but-completed turns.
- `--mode subagents` resolves persistent nested child sessions; drill into the child JSONL with `read` before concluding a worker is stuck.

## Agent and Tool Forensics

When an artifact says a child lacked tools or refused to write output, verify the child session before accepting the claim:

```bash
skills/pi-session-explorer/bin/session-explorer read <child-session.jsonl> --mode overview
skills/pi-session-explorer/bin/session-explorer read <child-session.jsonl> --mode tools
```

- `ENOENT` from `read` means that specific file is missing; it does not prove the `read` tool is unavailable if later `read` calls succeed.
- `toolCount: 0` plus no tool calls supports a real no-tool run; successful `read`, `grep`, or `bash` calls disprove it.
- For review-only tasks, phrase prompts as “do not modify project/source files; writing the configured output artifact is allowed” so agents do not over-apply no-edit rules.
- Late progress/intercom updates can arrive after a run completed; trust final subagent status, output artifacts, and child session logs over delayed progress text.
- If a child fails before a session is created, inspect the subagent result error first; broken project extensions/imports can prevent startup before the task runs.

## Session Locations

Parent sessions live under `~/.pi/agent/sessions/--<project-path>--/*.jsonl`.
Nested subagent sessions usually live at:

```text
~/.pi/agent/sessions/<project>/<parent-session-stem>/<runId>/run-<N>/session.jsonl
```

For raw format details, read `skills/pi-session-explorer/references/session-format.md`.

## Current Limits

`read` and `ws` are implemented. `sessions`, `search`, `timeline`, `tool-calls`, and `sql` remain bootstrap commands; if they report bootstrap output, use `rg`, `read`, and `ws` instead of relying on them.
