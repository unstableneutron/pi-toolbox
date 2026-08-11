# pi-deferred-tools

`pi-deferred-tools` keeps a small initial Pi tool set and loads reviewed tool groups additively.
Every deferred tool remains registered in `pi.getAllTools()`, but its schema and active-only prompt
metadata are not sent until `search_tools` enables its group.

The initial policy runs during `session_start`, before the first model request and before any
`before_agent_start` prompt transformation. It preserves `exec_command`,
`apply_patch`, `fff_grep`, `fff_find_files`, `web_search`, `subagent`, `todo`, `search_tools`, and
`multi_tool_use.parallel` as the reviewed baseline. After that boundary, the extension only adds
tools. A reload or session replacement creates a new initial baseline.

Unknown tools fail open. Only reviewed names in `catalog.ts` outside the baseline are deferred. Goal
tools and loop control remain active when their persisted session state says that work is active.
`subagent_wait`, `subagent_supervisor`, and `intercom` currently rely on explicit `search_tools`
discovery because their external owner extensions do not yet provide producer-side activation. Their
capabilities remain registered and loadable; this is an accepted prompt-size trade-off.

## Executor discovery

`search_tools` emits the versioned `pi-deferred-tools:search-provider` protocol from
`extensions/shared/deferred-tools-protocol.ts` when its scope includes Executor. Providers append
their result promise synchronously during the event callback, before any asynchronous work. The
`pi-executor` extension handles that event through its existing search implementation:

- Executor native capabilities are loaded as ordinary deferred Pi proxy tools.
- Connected integration paths are returned as search results and activate
  `executor_describe_tool` plus `executor_execute`.
- Integration paths are not promoted to one Pi schema per integration. Keeping them under
  `executor_execute` avoids schema growth, stale remote catalogs, and loss of sandbox-side
  composition and filtering.

Use `scope: "executor"` to force connected integration discovery. In `auto` scope, providers are
queried only when no direct local tool-group match exists.

## Telemetry

Each persisted `search_tools` result has versioned details with `version`, `query`, `added`, `local`,
`providers`, and optional `providerErrors` fields. This records discovery and activation without a
second session entry or a separate catalog snapshot.

## Tool-owner guidance

Tool owners should omit `promptSnippet` and `promptGuidelines` from deferred tools. Put critical
instructions in the tool description instead. This lets Pi attach the schema at the native deferred
load point without rebuilding the system prompt.

When one tool creates the state required by another tool, the owner should add the companion tool
inside the producer's `execute()` function. Examples are `exec_command` enabling `write_stdin` and
`executor_execute` enabling its job or output readers. This lets Pi persist `addedToolNames` on the
producer result. Owners with model or session activation policy can query the synchronous
`pi-deferred-tools:policy` event so they do not re-enable reviewed deferred consumers at startup.
