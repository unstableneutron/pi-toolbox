# pi-bash-rewrite

Optional Pi extension that owns the single active `bash` override for shell-to-tool rewrites.

## What it does

`pi-bash-rewrite` parses a `bash` command once, rewrites recognized safe shell idioms to structured tool calls, and otherwise delegates to the builtin bash tool unchanged. Builtin rewrites cover `read` and `ls`; other tools are provided by extensions over the shared event bus:

- `pi-fff-search` provides `fff_grep` and `fff_find_files` execution plus compact rendering.
- `multi-edit` provides `apply_patch` execution for `apply_patch <<'PATCH'` heredocs.

If this extension is not loaded, those provider extensions still work as normal direct tools; they just do not override `bash`.

The parser tolerates narrow safety/navigation prefixes before a rewriteable command:

- optional shebang line, e.g. `#!/usr/bin/env bash`
- standalone `set -e`, `set -u`, `set -euo pipefail`, and `set -o pipefail` preambles
- one or more simple `cd <literal-dir> &&`, `cd <literal-dir>;`, or `cd <literal-dir>` newline prefixes

When a `cd` prefix is accepted, providers execute with that effective cwd. More complex setup, variables, command substitutions, loops, redirects, and non-rewriteable commands still pass through to builtin bash unchanged.

## Provider contract

Providers register synchronously when `pi-bash-rewrite` emits:

```ts
pi.events.emit('bash-rewrite:collect-providers', {
  apiVersion: 1,
  register(provider) {
    // provider: { id, priority?, tools, fallbackOnExecuteError?, execute, renderPreview?, renderResult? }
  },
});
```

Rules:

- Provider IDs are de-duplicated; higher `priority` wins dispatch order, then ID sort.
- `tools` declares the rewrite target names a provider can execute.
- `execute(decision, runtime)` must return a normal Pi tool result.
- Set `fallbackOnExecuteError: false` for mutating rewrites such as `apply_patch` so failures do not silently run raw shell.
- Unsubscribe provider listeners on `session_shutdown` when the extension runtime supports it.

The orchestrator adds routing metadata to rewritten results: `routedVia`, `rewriteProviderId`, `rewriteRecognizer`, `rewriteFromCommand`, `rewriteToParams`, `rewriteCall`, and `rewriteCwd` when a `cd` prefix changed the provider cwd.

## Development

```shell
aube exec vitest run extensions/bash-rewrite
aube exec vitest run extensions/bash-rewrite extensions/pi-fff-search/index.test.ts extensions/multi-edit/index.test.ts
```

Use `test-fixtures/README.md` for corpus refresh and local triage commands.
