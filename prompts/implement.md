---
description: Implement a task using the current plan and review context
subagent: worker
model: openai/gpt-5.3-codex
thinking: medium
---
Implement the following task:

$@

Guidance:
- If prior planning or review context is available, follow it.
- Make concrete progress rather than re-planning from scratch.
- Keep the final response focused on what changed, key decisions, and any blockers.
