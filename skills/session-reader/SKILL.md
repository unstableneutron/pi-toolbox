---
name: session-reader
description: Use when asked to read, review, load, parse, or summarize one Pi session JSONL file, or when given a .jsonl session path.
---

# Session Reader

Compatibility trigger for single-session requests. The implementation now lives in `pi-session-explorer`.

Use:

```bash
skills/pi-session-explorer/bin/session-explorer read <session.jsonl> --mode overview
```

Useful modes:

| Need | Mode |
|------|------|
| First pass | `overview` |
| Conversation only | `conversation` |
| Full tool I/O | `full --max-content 0` |
| Tool calls/results | `tools` |
| Cost/cache tokens | `costs` |
| Subagent paths/status | `subagents` |
| Empty/error/transport turns | `diagnostics` |
| OpenAI WebSocket latency/continuation | `websocket` |

The old wrapper still works:

```bash
uv run skills/session-reader/scripts/read_session.py <session.jsonl> --mode overview
```

Prefer the canonical explorer command for new workflows. For aggregate session triage, use `skills/pi-session-explorer/bin/session-explorer ws` or the `pi-session-explorer` skill.
