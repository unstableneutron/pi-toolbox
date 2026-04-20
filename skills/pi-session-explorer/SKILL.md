---
name: pi-session-explorer
description: Explore and query many Pi session JSONL files across a project with an indexed workflow (rg → index → sessions/search → timeline/tool-calls → sql).
---

# Pi Session Explorer

Use this skill to investigate **many Pi session JSONL files** in aggregate, not just read one file.

## Workflow (in order)

1. **Broad discovery with `rg` first**
   - Use `rg` to quickly identify interesting terms, IDs, tools, or error strings in raw session files.
2. **Build or refresh index with `index`**
   - Run `skills/pi-session-explorer/bin/session-explorer index` before analytical queries.
3. **Prefer `sessions` and `search` for most analysis**
   - `sessions` for high-level grouped session summaries.
   - `search` for finding values/events across indexed data.
4. **Use `timeline` and `tool-calls` for focused drill-down**
   - `timeline` for event sequencing.
   - `tool-calls` for tool invocation inspection.
5. **Use `sql` only as an escape hatch**
   - Reach for raw SQL when canned commands are insufficient.

## Command surface

```bash
skills/pi-session-explorer/bin/session-explorer index
skills/pi-session-explorer/bin/session-explorer sessions
skills/pi-session-explorer/bin/session-explorer search --value "<term>"
skills/pi-session-explorer/bin/session-explorer timeline
skills/pi-session-explorer/bin/session-explorer tool-calls
skills/pi-session-explorer/bin/session-explorer sql --query "select 1"
```

## Notes

- This bootstrap provides command skeleton and structure.
- Full DuckDB indexing/query depth is implemented in later tasks.
