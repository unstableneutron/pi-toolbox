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

When a `cd` prefix is accepted, providers execute with that effective cwd. Output limits written as `| head -N` or `| sed -n '1,Np'` fold into the structured call. `cat -n FILE` and `grep -n '' FILE` also map to `read` because Pi already renders line numbers. More complex setup, variables, command substitutions, loops, redirects, and non-rewriteable commands still pass through to builtin bash unchanged.

## Provider contract

`contract.ts` is the authoritative provider contract and is exported as
`pi-bash-rewrite/contract`. Providers can use a type-only import so they stay
usable when the host extension is not active. They register synchronously when
`pi-bash-rewrite` emits:

```ts
import type {
  BashRewriteCollectProvidersEvent,
  BashRewriteProviderCollectorPayload,
} from 'pi-bash-rewrite/contract';

const eventName: BashRewriteCollectProvidersEvent = 'bash-rewrite:collect-providers';

pi.events.on(eventName, (payload: unknown) => {
  if (!isApiVersion1Collector(payload)) return;
  payload.register(provider);
});
```

Rules:

- Contract version 1 uses a closed rewrite-target set. A new target requires a
  central recognizer, safety review, tests, and a contract change. Execution
  providers can stay separate, but providers do not add shell recognizers.
- A provider must check `apiVersion === 1` before registration.
- Provider IDs are de-duplicated. Higher `priority` wins for the same target;
  equal priority sorts by provider ID. Priorities do not matter for disjoint
  target sets.
- `tools` declares the rewrite target names a provider can execute.
- `execute(decision, runtime)` must return a normal Pi tool result.
- Set `fallbackOnExecuteError: false` for mutating rewrites such as
  `apply_patch` so failures do not silently run raw shell.
- Keep the provider listener active for the extension process lifetime so Pi
  session switches do not make rewrites dormant.

The orchestrator adds routing metadata to rewritten results: `routedVia`, `rewriteProviderId`, `rewriteRecognizer`, `rewriteFromCommand`, `rewriteToParams`, `rewriteCall`, and `rewriteCwd` when a `cd` prefix changed the provider cwd.

The host fails closed when Pi cannot report active tools. When `bash` is active,
it adds one system-prompt diagnostic if no external providers are registered
or if an active target has no provider. A provider target that is deliberately
outside the strict allowlist is not an error. The diagnostic does not activate
tools. Matching commands still run as Bash.

## Pi subagents

Use the private local bundle at
`packages/bash-rewrite-subagent/index.ts` for strict child processes. It lives
outside the root Pi manifest's `extensions/` discovery directory, so normal
toolbox sessions do not load the bundle. The bundle loads FFF, multi-edit, and
this host while keeping this host as the only `bash` override. Its required
target allowlist is:

```text
bash,read,ls,fff_grep,fff_find_files,apply_patch
```

Keep the agent's other required tools. Loading the bundle does not grant a
tool that is absent from the child allowlist. See
`packages/bash-rewrite-subagent/README.md` for the settings contract.

The parser remains in this package because it has one runtime consumer. A
separate core package is deferred until there is a verified second consumer or
an independent publication requirement.

## Development

```shell
npm test
npm run check
```

Use `test-fixtures/README.md` for corpus refresh and local triage commands.
