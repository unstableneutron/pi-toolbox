# pi-conditional-context

Conditionally include Markdown blocks from Pi context files (`AGENTS.md`,
`CLAUDE.md`, etc.) based on the active model.

The extension uses HTML comment directives so files remain valid Markdown when
the extension is not loaded:

```md
<!-- pi:if class=claude -->

## Claude-like models only

- Before a meaningful tool call, send one concise prose sentence describing the intent.
- Do not echo raw commands or tool arguments as the preface.
<!-- pi:endif -->
```

If the extension is not loaded, Markdown renderers hide the comment directives
and the visible heading preserves the intended meaning for readers and models.

## Syntax

```md
<!-- pi:if class=claude -->

Included only for Claude-like models.

<!-- pi:else -->

Included for all other models.

<!-- pi:endif -->
```

Supported clauses:

- `class=claude`, `class=openai`, `class=codex`, `class=gemini`
- `model=sonnet,opus`
- `provider=anthropic`
- `id=gpt-5.5`
- `api=openai-responses`

Multiple clauses are ANDed:

```md
<!-- pi:if provider=anthropic model=sonnet,opus -->

Only Anthropic Sonnet/Opus models.

<!-- pi:endif -->
```

Values separated by `,` or `|` are ORed.

Top-level OR (`||`) and parentheses are intentionally not supported yet. If you
need OR across groups, duplicate the block:

```md
<!-- pi:if provider=anthropic model=sonnet -->

Instruction for Sonnet or Opus.

<!-- pi:endif -->

<!-- pi:if provider=anthropic model=opus -->

Instruction for Sonnet or Opus.

<!-- pi:endif -->
```

Malformed or unknown `pi:` directives fail closed: the extension removes the
conditional tail from the generated system prompt and emits a UI warning instead
of passing both branches through silently.

`class` is heuristic model-family matching. `model` matches across provider, id,
api, display name, and derived classes. All operators (`=`, `:`, `~=`, `*=`) are
currently treated as substring-style `includes` matching.
