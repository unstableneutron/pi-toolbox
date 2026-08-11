# pi-executor-remote

A lightweight Pi bridge to an **already-running** Executor HTTP/MCP server.

The extension does not embed Executor, open its database, install its binary, start a sidecar, or
stop a daemon. Executor remains responsible for integrations, credentials, policies, sandboxing,
and persistence. Pi connects through authenticated Streamable HTTP MCP and handles native form and
URL elicitation in the Pi UI.

## Pi tools

The extension registers eight focused bridge tools:

- `executor_search_tools` — search bridge, sandbox, native, and integration capabilities.
- `executor_describe_tool` — get one integration tool's compact TypeScript contract.
- `executor_execute` — run focused TypeScript against connected integrations.
- `executor_list_guides` — list available procedural guide IDs.
- `executor_get_guide` — fetch one guide by exact ID.
- `executor_get_job` — long-poll a yielded Executor call.
- `executor_cancel_job` — cancel a yielded Executor call.
- `executor_read_output` — read the next bounded page of a truncated result.

When `pi-deferred-tools` is loaded, these bridge schemas start inactive. Its general `search_tools`
tool calls the existing Executor search implementation through the shared extension event bus.
Executor-native matches become ordinary Pi proxy tools. Integration matches activate
`executor_describe_tool` and `executor_execute`, but remain Executor paths instead of becoming one Pi
schema per integration. Direct `executor_search_tools` use remains available after it is loaded.

Native artifact tools are registered but initially deferred:

- `executor_create_artifact`
- `executor_edit_artifact`
- `executor_list_artifacts`
- `executor_show_artifact`

`executor_search_tools` returns compact `{ path, kind, summary, state? }` items. Native items stay
`loadable` unless the call sets `load: true`; loaded native tools use Pi's dynamic tool-loading API.
The extension does not inject Pi tools into the Executor sandbox. Inside `executor_execute`, connected
integration paths run under `tools.*`, while `emit` is a sandbox global.

The bridge adapts Executor's current MCP names internally. For example, `skills` backs
`executor_list_guides` and `executor_get_guide`; artifact names are converted from hyphens to
namespaced Pi snake case. The original MCP names are not registered as Pi aliases.

## Discovery workflow

1. Call `executor_search_tools` with a short capability query. It searches bridge, sandbox, native,
   and integration kinds and returns at most 20 concise items by default.
2. For an integration item, call `executor_describe_tool` with the exact returned path. Its `data`
   field describes the success payload without the standard result envelope.
3. Call `executor_execute` with focused TypeScript and return only the fields needed by the task.
4. For a native item, search again with `load: true`, then call the loaded Pi tool directly.
5. Continue pagination with `nextCursor` when it is present; keep the same query, kinds, namespace,
   and limit.

Search responses use `{ items, total, nextCursor? }`; items use `{ path, kind, summary, state? }`.
Only native items include `state`, as either `loadable` or `loaded`.
Describe responses omit unreferenced standard `ToolError`, `ToolHttpMeta`, and `ToolFile`
definitions. JSON output uses compact encoding.
Model-visible output defaults to 12 KB or 300 lines. A larger result is saved to a temporary file and
gets an output ID; use `executor_read_output` with the returned byte offset to read bounded pages.
ANSI terminal control sequences and NUL bytes are removed from model-visible output. Structured JSON
fields named like passwords, authorization headers, API keys, cookies, or access/refresh tokens are
redacted before they enter model-visible text or persisted Pi tool details.

Long `executor_execute` and native MCP calls yield after 20 seconds by default. `executor_execute`
accepts a per-call `waitMs` override and an optional hard `timeoutMs`. A yielded response uses
`{ state: "running", jobId, retryAfterMs }` while the original MCP request continues in the
background. The result additively enables `executor_get_job` and `executor_cancel_job`. Use
`executor_get_job` with the same job ID and an optional `waitMs` to wait again; this polls the
original request and does not start the code again. Use `executor_cancel_job` to stop it. A truncated
result additively enables `executor_read_output`. The hard request timeout defaults to five minutes.
MCP progress notifications update the active Pi tool row before a call yields.

## Endpoint resolution

In automatic mode, the first available endpoint wins:

1. `PI_EXECUTOR_MCP_URL`.
2. The profile named by `PI_EXECUTOR_SERVER`.
3. `mcpUrl` in merged Pi configuration.
4. `serverProfile` in merged Pi configuration.
5. The default profile in `$EXECUTOR_DATA_DIR/server-connections.json` or
   `~/.executor/server-connections.json`.
6. The active local daemon manifest.
7. `http://127.0.0.1:4789/mcp`.

Pi configuration is loaded from `PI_EXECUTOR_CONFIG` when set. Otherwise, trusted project settings
in `<cwd>/.pi/pi-executor.json` override user settings in `~/.pi/agent/pi-executor.json`.

Use `PI_EXECUTOR_ENDPOINT_SOURCE` or the `endpointSource` config field to force one source:

- `auto` — use the order above.
- `environment` — require `PI_EXECUTOR_MCP_URL`.
- `config` — require `mcpUrl` in Pi configuration.
- `profile` — use `PI_EXECUTOR_SERVER`, `serverProfile`, or the Executor default profile.
- `local` — use the daemon manifest or the conventional localhost endpoint.

Environment overrides:

- `PI_EXECUTOR_ENDPOINT_SOURCE`
- `PI_EXECUTOR_MCP_URL`
- `PI_EXECUTOR_SERVER`
- `PI_EXECUTOR_TOKEN`; `EXECUTOR_API_KEY` and `EXECUTOR_AUTH_TOKEN` are fallback bearer variables.
- `PI_EXECUTOR_USERNAME`
- `PI_EXECUTOR_PASSWORD`
- `PI_EXECUTOR_REQUEST_TIMEOUT_MS` — hard call timeout; default 300000 ms.
- `PI_EXECUTOR_YIELD_AFTER_MS` — default per-call yield delay; default 20000 ms.
- `PI_EXECUTOR_MAX_OUTPUT_BYTES` — initial model-visible bytes; default 12288.
- `PI_EXECUTOR_MAX_OUTPUT_LINES` — initial model-visible lines; default 300.
- `PI_EXECUTOR_ALLOW_INSECURE_HTTP`

The normal remote configuration reuses an Executor CLI profile and its OAuth login:

```json
{
  "serverProfile": "tcbs-nonprod",
  "allowInsecureHttp": true
}
```

A direct endpoint is also supported. A root origin is normalized to `/mcp`; a non-root path is used
as the exact MCP endpoint:

```json
{
  "endpointSource": "config",
  "mcpUrl": "https://executor.example.com/mcp",
  "requestTimeoutMs": 300000,
  "yieldAfterMs": 20000,
  "maxOutputBytes": 12288,
  "maxOutputLines": 300
}
```

Executor profiles are re-read on every tool call, so a renewed `executor login` takes effect without
reloading Pi. An expired OAuth profile reports the exact `executor login --server <name>` command.
Prefer profile authentication or environment variables over credentials in Pi configuration. Project
configuration is read only for projects trusted by Pi, and credentials are not inherited when an
endpoint changes. Non-loopback plain HTTP is rejected unless `allowInsecureHttp` is explicitly set.

## Status

The status line shows the exact sanitized MCP endpoint. Run `/executor` to refresh native MCP
discovery and inspect the endpoint, selected profile/source, remote MCP names, adapted Pi names, and
MCP resources. Executor MCP App resources are reported but are not registered as model-callable
tools. Unsupported MCP App content uses Executor's link fallback.

## Development

```bash
aube --filter pi-executor-remote test
aube --filter pi-executor-remote check
```

The MCP bridge design was informed by Jeremy Osih's MIT-licensed
[`pi-executor`](https://github.com/jeremyosih/pi-executor). This extension is remote-only and does not
include its sidecar lifecycle implementation.
