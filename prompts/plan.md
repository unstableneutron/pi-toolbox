---
description: Create a concrete implementation plan for a task
subagent: planner
model: openai/gpt-5.4
thinking: medium
---
Create a concrete implementation plan for the following task:

$@

Requirements:
- Return the plan itself, not implementation.
- Break the work into small, testable steps.
- If the current conversation already contains relevant constraints or analysis, incorporate them.
- Do not make code changes.
