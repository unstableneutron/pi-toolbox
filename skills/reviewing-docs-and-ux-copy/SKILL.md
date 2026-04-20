---
name: reviewing-docs-and-ux-copy
description: Use when reviewing README files, docs, tutorials, runbooks, CLI --help text, option descriptions, or other public-facing text for clarity, accuracy, conciseness, and publishability. Triggers on "review docs", "check help text", "make docs publishable", "freshen up docs", "docs review", "review CLI help".
---

# Reviewing Docs and UX Copy

## Overview

Review public-facing text surfaces for clarity, accuracy, and conciseness. Produce a structured report with targeted improvements and draft copy for obvious gaps — not full rewrites.

**Core principle:** Start simple, stay concise, draft where it matters.

## Scope

If the caller provides explicit scope (files, globs, directories), review ONLY that scope.

If NO scope is given, discover surfaces yourself:

1. **Markdown files** — `README*`, `docs/`, tutorials, guides, `*.md` at repo root
2. **CLI help** — find Click/argparse/typer definitions, run `--help`, inspect help strings in source
3. **Generated docs** — runbooks, changelogs, release notes
4. **Templates** — Jinja/mustache/handlebars templates that produce user-facing markdown or text
5. **Package metadata** — `pyproject.toml` description, `package.json` description
6. **Config examples** — `.example.json`, `.env.example` — check if guidance is current

### Negative scoping

If the caller says "only review X" or "do NOT review Y", respect that strictly. When a repo
mixes new and legacy code, the caller may exclude legacy surfaces. Do not suggest changes to
excluded surfaces, even if they have issues.

### High-signal surfaces

From experience, these surfaces have the highest hit rate for actionable findings:

- **CLI `--help` text** — bare commands/options with no help strings are the most common gap.
  Always run `--help` and check leaf commands, not just top-level groups.
- **Hardcoded PII or machine-specific paths** — emails, user IDs, absolute paths in examples.
  Flag these even if the repo is internal-only.
- **Cross-doc duplication** — the same example (e.g. auth report JSON) pasted into 3+ files
  means 3+ places to update when the schema changes. Flag and suggest a canonical location.

## Review Priorities

Check in this order:

1. **Staleness** — Do referenced commands, flags, paths, file listings match current behavior? Run `--help` and compare to docs.
2. **Clarity** — Easy to follow for someone seeing it for the first time? Flag jargon, missing context, assumed knowledge.
3. **Conciseness** — Flag verbose or repetitive sections. Shorter is better if nothing is lost.
4. **Structure** — Headings, lists, code blocks used effectively? Easy to scan?
5. **Gaps** — Missing docs for important workflows or undocumented commands/options?
6. **PII / portability** — Hardcoded emails, user IDs, absolute paths that make docs feel like personal notes.

## Output Format

Produce a single report with exactly these sections:

### Summary
One paragraph. Overall impression + the single most impactful thing to fix.

### Findings
Numbered list, **≤15 items** by default. Each finding:
- **File/surface**: path or CLI command
- **Issue**: one sentence
- **Severity**: `stale` | `unclear` | `verbose` | `structural` | `gap`
- **Suggestion**: concrete, actionable fix

Prioritize high-impact items. If asked for more depth, expand beyond 15.

### Drafts
For the **top 1–3** most impactful gaps or problems, draft replacement copy directly. Use fenced blocks with the target file path. Keep drafts minimal — targeted sections, not full-file rewrites.

## Constraints

- Do NOT suggest rewriting entire files unless explicitly asked.
- Do NOT make edits. Produce suggestions and drafts only.
- Start simple. Expand only when the caller asks.
- Prefer multiple small targeted improvements over one large restructure.
- When checking CLI help, actually run the commands and compare output to docs.
- Be direct. Skip preamble.

## Multi-pass workflow

For thorough reviews, a two-pass approach works well:

1. **First pass** — broad review, address all findings.
2. **Second pass** — re-review after fixes, catch remaining high/medium items only.

The caller decides whether to do one pass or two.
