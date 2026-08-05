# pi-executor-remote

A lightweight Pi bridge to an **already-running** Executor HTTP/MCP server.

The extension does not embed Executor, open its database, install its binary, start a sidecar, or
stop a daemon. Executor remains responsible for integrations, credentials, policies, sandboxing,
and persistence. Pi connects through authenticated Streamable HTTP MCP and handles native form and
URL elicitation in the Pi UI.

## Pi tools

Eight focused tools are active at startup:

- `executor_find_tools` — find native Executor capabilities and connected integration tools.
- `executor_describe_tool` — get one integration tool's compact TypeScript contract.
- `executor_execute` — run focused TypeScript against connected integrations.
- `executor_list_guides` — list available procedural guide IDs.
- `executor_get_guide` — fetch one guide by exact ID.
- `executor_get_job` — long-poll a yielded Executor call.
- `executor_cancel_job` — cancel a yielded Executor call.
- `executor_read_output` — read the next bounded page of a truncated result.

Native artifact tools are registered but initially deferred:

- `executor_create_artifact`
- `executor_edit_artifact`
- `executor_list_artifacts`
- `executor_show_artifact`

`executor_find_tools` activates matching native tools through Pi's dynamic tool-loading API. It does
not inject Pi tools into the Executor sandbox. Inside `executor_execute`, only connected integration
paths under `tools.*` are available.

The bridge adapts Executor's current MCP names internally. For example, `skills` backs
`executor_list_guides` and `executor_get_guide`; artifact names are converted from hyphens to
namespaced Pi snake case. The original MCP names are not registered as Pi aliases.

## Discovery workflow

1. Call `executor_find_tools` with a short capability query. It returns at most 20 concise matches
   by default.
2. For an integration match, call `executor_describe_tool` with the exact returned path.
3. Call `executor_execute` with focused TypeScript and return only the fields needed by the task.
4. For a native match, call the activated Pi tool directly on the next model turn.

Search results omit ranking scores and repeated type definitions. JSON output uses compact encoding.
Model-visible output defaults to 12 KB or 300 lines. A larger result is saved to a temporary file and
gets an output ID; use `executor_read_output` with the returned byte offset to read bounded pages.
ANSI terminal control sequences and NUL bytes are removed from model-visible output. Structured JSON
fields named like passwords, authorization headers, API keys, cookies, or access/refresh tokens are
redacted before they enter model-visible text or persisted Pi tool details.

Long `executor_execute` and native MCP calls yield after 20 seconds by default. `executor_execute`
accepts a per-call `yieldMs` override. The first response returns a session-local bridge job ID while
the original MCP request continues in the background. Use `executor_get_job` with the same job ID and
an optional `yieldMs` to wait again; this polls the original request and does not start the code again.
Use `executor_cancel_job` to stop it. The hard request timeout defaults to five minutes. MCP progress
notifications update the active Pi tool row before a call yields.

## Endpoint resolution

Resolution order:

1. `PI_EXECUTOR_CONFIG`, when set.
2. Merged user and project configuration:
   - `~/.pi/agent/pi-executor.json`
   - `<cwd>/.pi/pi-executor.json`
3. Environment overrides.
4. The active local daemon manifest at
   `$EXECUTOR_DATA_DIR/server-control/server.json` or
   `~/.executor/server-control/server.json`.

Environment overrides:

- `PI_EXECUTOR_URL`
- `PI_EXECUTOR_TOKEN`
- `PI_EXECUTOR_USERNAME`
- `PI_EXECUTOR_PASSWORD`
- `PI_EXECUTOR_REQUEST_TIMEOUT_MS` — hard call timeout; default 300000 ms.
- `PI_EXECUTOR_YIELD_AFTER_MS` — default per-call yield delay; default 20000 ms.
- `PI_EXECUTOR_MAX_OUTPUT_BYTES` — initial model-visible bytes; default 12288.
- `PI_EXECUTOR_MAX_OUTPUT_LINES` — initial model-visible lines; default 300.
- `PI_EXECUTOR_ALLOW_INSECURE_HTTP`

Example configuration:

```json
{
  "url": "https://executor.example.com",
  "token": "replace-me",
  "requestTimeoutMs": 300000,
  "yieldAfterMs": 20000,
  "maxOutputBytes": 12288,
  "maxOutputLines": 300
}
```

Prefer environment variables or a user-only file for credentials. Project configuration is read
only for projects trusted by Pi. It may override user configuration, but credentials are never
inherited when an override changes the endpoint URL. Bearer and basic authentication are supported.
Non-loopback plain HTTP is rejected unless `allowInsecureHttp` is explicitly enabled.

With the Executor CLI daemon running, no configuration is normally needed. The extension reads the
published server-control manifest, including its authentication settings.

## Status

Run `/executor` to refresh native MCP discovery and inspect the connection. The report includes the
remote MCP names, adapted Pi names, and MCP resources. Executor MCP App resources are reported but
are not registered as model-callable tools. Unsupported MCP App content uses Executor's link
fallback.

## Development

```bash
aube --filter pi-executor-remote test
aube --filter pi-executor-remote check
```

The MCP bridge design was informed by Jeremy Osih's MIT-licensed
[`pi-executor`](https://github.com/jeremyosih/pi-executor). This extension is remote-only and does not
include its sidecar lifecycle implementation.
