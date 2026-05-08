---
description: Run reviewer subagents in parallel across configurable models, then synthesize their recommendations
chainContext: true
fresh: true
---
Review the task/work provided below using a configurable roundtable of parallel reviewer subagents.

Task and optional review configuration:
$@

The user may optionally provide a `reviewer-models` list to use; if they do, then prefer using those models. Otherwise fall back to the default set of trio (as shown below).


Follow this process:

1. Parse the user's request and look for an optional `reviewer-models:` block.
2. Determine the reviewer model list as follows:
   - If the user provided `reviewer-models:`, use that list. Otherwise default to:
    - openai/gpt-5.2:high
    - anthropic/claude-opus-4-6:high
    - google/gemini-3.1-pro-preview:high
3. Normalize the reviewer model list:
   - preserve the user-specified order
   - remove duplicates
   - require at least 1 reviewer
   - cap the list at 6 reviewers
4. After you understand the task, build one shared review brief from:
   - the task itself
   - the current conversation state
   - any plan, implementation, or prior review context already available
5. Call the `subagent` tool in **parallel mode** with one task per reviewer model.
6. For every reviewer task:
   - use `agent: "reviewer"`
   - use the same shared review brief
   - override only the `model`
   - set `clarify: false`
   - instruct the reviewer to work independently and not assume consensus
   - require this output structure:
     - `## Summary`
     - `## Key observations`
     - `## Recommendation`
     - `## Tradeoffs and risks`
7. After the parallel reviews finish, synthesize them in this session.

Output format:

# Roundtable Review

## Reviewers Used
List the models that were actually used, in order.

## Consensus
What the reviewers broadly agree on.

## Disagreements
Important differences in judgment, assumptions, or emphasis.

## Recommendation
Your synthesized recommendation.

## Per-Model Notes
Give a 1-2 sentence takeaway for each reviewer model that actually ran.

Rules:
- Reuse the same `reviewer` agent for every review pass.
- Do not create or invoke a `roundtable-review` subagent.
- Do not delegate the synthesis step to another subagent unless the user explicitly asks.
- If the user supplies no `reviewer-models:` block, use the default three-model set.
- If the user supplies an invalid or empty reviewer list, explain the issue briefly and fall back to the default set unless the user clearly requested otherwise.
- Keep the final synthesis concise but decision-useful.
