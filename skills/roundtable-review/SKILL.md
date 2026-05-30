---
name: roundtable-review
description: Use when a user asks for a roundtable, panel, council, multi-model, model-diverse, or independent reviewer comparison of a plan, diff, implementation, proposal, or decision.
---

# Roundtable Review

## Overview

Run the builtin `reviewer` agent several times in parallel with different models, then synthesize the results in the parent session. The parent owns orchestration and synthesis; do not create a `roundtable-review` agent or ask a child to launch subagents.

Use this for model diversity. If the user wants different review *angles* such as correctness/tests/complexity with the same model, use the normal pi-subagents parallel-review pattern instead.

## Defaults

Default reviewer lineup:

1. `openai/gpt-5.5:high`
2. `anthropic/claude-opus-4-7:high`
3. `google/gemini-3.1-pro-preview:high`

Accept an optional `reviewer-models:` block or comma-separated inline list. Preserve order, resolve user model aliases when instructed by the system, remove duplicates, require at least one reviewer, and cap at six reviewers. If parsing fails, explain briefly and use the default lineup unless the user explicitly requires exact models.

## Workflow

1. Build one shared review brief from the user request and concrete evidence. For fresh reviewers, include all context they need: target files, diff/plan paths, relevant constraints, prior decisions, and what not to review. If reviewing a current diff, inspect or summarize `git status`/`git diff` first.
2. Launch parallel reviewer tasks with the same brief and one model per task:

```ts
subagent({
  tasks: models.map((model) => ({
    agent: "reviewer",
    model,
    output: false,
    progress: false,
    task: `${sharedBrief}\n\nYou are the ${model} roundtable reviewer. Work independently; do not assume consensus. Review only; do not modify project/source files. Return:\n## Summary\n## Key observations\n## Recommendation\n## Tradeoffs and risks`,
  })),
  context: "fresh",
  concurrency: models.length,
  clarify: false,
})
```

Use foreground execution when the user expects the synthesis in the next response. Use `async: true` only when background execution is acceptable; then wait for completion before synthesizing.

3. Synthesize in the parent session. Do not average opinions blindly: prioritize evidence-backed findings, call out disagreements, and decide what is actionable now.

## Output Format

```md
# Roundtable Review

## Reviewers Used
- model ids actually used

## Consensus
- where reviewers agree

## Disagreements
- important differences in assumptions, evidence, or recommendations

## Recommendation
- synthesized next move, with rationale

## Actionable Findings
- blockers/fixes worth doing now, with file/line evidence when available

## Per-Model Notes
- 1-2 sentence takeaway per reviewer
```

If reviewers fail or a model is unavailable, report which slots failed and synthesize from successful reviewers only when enough evidence remains.

## Guardrails

- Review-only by default. If fixes are wanted, synthesize first, then ask or launch one `worker` for accepted fixes.
- Use builtin `reviewer`; do not copy its prompt or create model-specific reviewer agents.
- Keep the shared brief compact but sufficient for fresh-context reviewers.
- Do not expose secrets in the brief. Redact sensitive values before passing them to children.
- Avoid `worktree: true` unless reviewers are explicitly allowed to edit, which is not the default roundtable mode.
