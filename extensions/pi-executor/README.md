# pi-executor-remote

A lightweight Pi bridge to an **already-running** Executor HTTP/MCP server.

The extension deliberately does not embed Executor, open its database, install its binary, start a
sidecar, or stop a daemon. Do not load it alongside another extension that registers tools named
`search` or `execute`. It exposes two fixed Pi tools:

- `search` — search Executor's configured integration catalog.
- `execute` — run TypeScript in Executor's sandbox.

Executor remains responsible for integrations, secrets, policies, sandboxing, and persistence. Pi
connects through authenticated Streamable HTTP MCP and handles native form/URL elicitation in the Pi
UI.

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
- `PI_EXECUTOR_REQUEST_TIMEOUT_MS`
- `PI_EXECUTOR_ALLOW_INSECURE_HTTP`

Example configuration:

```json
{
  "url": "https://executor.example.com",
  "token": "replace-me",
  "requestTimeoutMs": 600000
}
```

Prefer environment variables or a user-only file for credentials. Project configuration is read only
for projects trusted by Pi. It may override user configuration, but credentials are never inherited
when an override changes the endpoint URL. Bearer and basic authentication are supported.
Non-loopback plain HTTP is rejected unless `allowInsecureHttp` is explicitly enabled.

With the Executor CLI daemon running, no configuration is normally needed; the extension reads the
published server-control manifest, including its authentication settings.

## Usage

Run `/executor` to check the connection without invoking an integration.

Use `search` before `execute` when a tool path is unknown. `includeDetails` returns the compact
TypeScript input/output shapes used to prepare an `execute` snippet.

Interactive Pi sessions bridge Executor form and browser interactions into Pi. External URLs require
explicit consent before the system browser is opened. Headless sessions cancel elicitation rather
than approving an action without a user.

## Development

```bash
pnpm --filter pi-executor-remote test
pnpm --filter pi-executor-remote check
```

The MCP bridge design was informed by Jeremy Osih's MIT-licensed
[`pi-executor`](https://github.com/jeremyosih/pi-executor), but this extension is remote-only and does
not include its sidecar lifecycle implementation.
