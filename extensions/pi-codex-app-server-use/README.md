# pi-codex-app-server-use

Pi extension for using the running Codex AppServer daemon from Pi.

The extension is **safe to load by default**: all optional capabilities are off
until enabled in `/codex-app-server`.

## Capabilities

- AppServer-backed `exec_command`, `write_stdin`, and `apply_patch` tools via
  `command/exec` and `command/exec/write` on the running Codex AppServer
  control socket.
- Codex-compatible `view_image` for reading workspace image files into Pi image
  content when the selected model supports image input. If a `view_image` CLI is
  available on `PATH` or in `~/.local/bin`, the extension uses it first and
  falls back to its local JS reader on failure.
- Codex native Computer Use tools through Codex AppServer MCP calls.
- Codex browser automation through the existing `node_repl` browser-client path
  and the local Chromium DevTools fallback.

All capabilities use the global Codex AppServer daemon. The extension does not
spawn or maintain its own app-server process. When every capability is disabled,
Pi does not probe the daemon and does not warn. When any active capability needs
the daemon and the control socket is unavailable, the extension suppresses its
tools for that session and warns with:

```bash
codex app-server daemon --help
```

Default control socket:

```text
~/.codex/app-server-control/app-server-control.sock
```

Override it with:

```bash
PI_CODEX_APP_SERVER_CONTROL_SOCKET=/path/to/app-server-control.sock pi
```

## Settings

Open settings with:

```text
/codex-app-server
```

The settings UI has separate areas for:

- **Computer Use** — enables native CUA and browser MCP tools.
- **Exec Tools** — controls AppServer-backed `exec_command`, `write_stdin`, and
  `apply_patch`, plus local `view_image`.

Settings use the `codexAppServerUse` key and follow normal precedence:

```text
session → project → user → defaults
```

Defaults:

```json
{
  "codexAppServerUse": {
    "computerUse": { "enabled": false },
    "exec": {
      "enabled": false,
      "replaceLocalTools": false,
      "models": "auto"
    },
    "ui": { "statusLine": true }
  }
}
```

Only write the fields you want to override. For example, to enable Computer Use
for a project:

```json
{
  "codexAppServerUse": {
    "computerUse": { "enabled": true }
  }
}
```

### Exec settings

- `enabled: false` — do not expose AppServer exec tools.
- `enabled: true` — add `exec_command`, `write_stdin`, `apply_patch`, and
  `view_image` while active.
- `replaceLocalTools: true` — while active, remove Pi's local `read`, `bash`,
  `edit`, and `write` tools. Unrelated tools remain available.

### Model activation

- `auto` — enable for GPT/Codex-like models only.
- `all` — enable for every model.

### Sandbox policy

Sandbox policy is intentionally not exposed yet. AppServer exec currently sends
`sandboxPolicy: { "type": "dangerFullAccess" }` for each `command/exec` call.

Direct commands:

```text
/codex-app-server status
/codex-app-server computer-use enabled project
/codex-app-server computer-use off user
/codex-app-server exec on user
/codex-app-server exec off user
/codex-app-server exec replace on project
/codex-app-server exec replace off project
/codex-app-server exec models auto project
/codex-app-server exec models all project
```

## Tools

### Exec tools

`exec_command` accepts Codex-style parameters:

- `cmd` (required)
- `workdir`
- `shell`
- `tty`
- `yield_time_ms`
- `max_output_tokens`
- `login`

Compatibility aliases are accepted: `command` → `cmd`, and `cwd` or
`working_directory` → `workdir`.

`write_stdin` accepts:

- `session_id` (required)
- `chars`
- `yield_time_ms`
- `max_output_tokens`

`apply_patch` accepts:

- `input` — full patch text using `*** Begin Patch` / `*** End Patch`

Compatibility aliases are accepted: `patch` or `patchText` → `input`.

`view_image` accepts:

- `path` — local image path, relative to the current Pi cwd unless absolute
- `detail` — optional; only `original` is supported

Compatibility aliases are accepted: `file_path` or `image_path` → `path`.
Supported image types are PNG, JPEG, GIF, and WebP. Unlike the exec tools,
`view_image` is exposed as a Pi-side tool. The Codex AppServer protocol has a
native `view_image` tool handler for turns, but it does not expose a dedicated
client RPC for calling it directly; AppServer can run an installed `view_image`
CLI through generic `command/exec` shell/PATH execution.

The tool result details follow Codex unified exec output:

```json
{
  "chunk_id": "...",
  "wall_time_seconds": 1.23,
  "output": "...",
  "session_id": 1,
  "exit_code": 0,
  "original_token_count": 1234
}
```

### Computer Use

Computer Use remains default-off. When enabled it exposes:

| Pi tool                  | Purpose                                   |
| ------------------------ | ----------------------------------------- |
| `computer_list_apps`     | List local apps visible to Codex CUA      |
| `computer_get_app_state` | Read screenshot + accessibility tree      |
| `computer_action`        | Dispatch native click/scroll/type actions |
| `codex_browser_list`     | List browser tabs for a Codex backend     |
| `codex_browser_eval`     | Evaluate browser-client JavaScript        |

Use `/codex-app-server-doctor` for setup checks.

## Local development

```bash
aubr -C extensions/pi-codex-app-server-use test
aubr -C extensions/pi-codex-app-server-use check
```
