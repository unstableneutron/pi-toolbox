# pi-codex-computer-use

Pi extension that exposes Codex.app's bundled native Computer Use and browser
runtime MCP surfaces.

This package does **not** ship a separate macOS automation helper. It reuses the
installed Codex.app stack as-is:

```text
Pi tool call
  -> pi-codex-computer-use extension
  -> codex app-server --listen stdio://
  -> mcpServer/tool/call(server="computer-use" | "node_repl")
  -> Codex Computer Use.app / SkyComputerUseClient or browser-client runtime
```

Abort handling is implemented at the shared bridge layer, not per tool. When Pi
aborts any Computer Use or browser tool call, the extension sends a best-effort
MCP-style `notifications/cancelled` notification for the in-flight app-server
request, waits up to 50ms for the transport write to flush, rejects locally with
`Operation aborted`, and resets the affected bridge so the next call starts from
a fresh app-server/thread. App-server timeouts use the same reset path.

## Tools

The extension exposes compact Pi-facing surfaces over Codex's native Computer Use
and browser MCP tools.

### Computer Use

| Pi tool                  | Purpose                                    |
| ------------------------ | ------------------------------------------ |
| `computer_list_apps`     | List local apps visible to Codex CUA       |
| `computer_get_app_state` | Read screenshot + accessibility tree       |
| `computer_action`        | Dispatch one native click/scroll/type/etc. |

`computer_action.action` maps to Codex native tools:

| `computer_action.action` | Codex native tool          |
| ------------------------ | -------------------------- |
| `click`                  | `click`                    |
| `scroll`                 | `scroll`                   |
| `drag`                   | `drag`                     |
| `press_key`              | `press_key`                |
| `type_text`              | `type_text`                |
| `set_value`              | `set_value`                |
| `select_text`            | `select_text`              |
| `secondary_action`       | `perform_secondary_action` |

### Browser

Codex browser automation is intentionally routed through Codex app-server's
`node_repl` MCP server. That preserves Codex thread metadata needed by the
in-app browser (`iab`) backend while exposing a compact Pi browser surface.

| Pi tool              | Purpose                                           |
| -------------------- | ------------------------------------------------- |
| `codex_browser_list` | List tabs for the selected Codex browser backend  |
| `codex_browser_eval` | Evaluate browser-client JavaScript for automation |

Browser tools default to `backend: "iab"`. Use `backend: "chrome"` to target the
Codex Chrome extension backend (`agent.browsers.get("extension")`).

`codex_browser_eval.script` runs as an async JavaScript function body with
`agent`, `browser`, `tab`, and `nodeRepl` bindings available. Return a
JSON-serializable value for structured output, use `nodeRepl.write(...)` for
exact text, and use `nodeRepl.emitImage(...)` for screenshots.

The extension resolves `scripts/browser-client.mjs` in this order:

1. `~/.codex/plugins/cache/openai-bundled/<plugin>/latest/scripts/browser-client.mjs`
2. the highest version-like cache directory under that plugin
3. the installed Codex.app bundled plugin path

Use `/codex-computer-use-doctor` for actionable setup checks. It verifies the
Codex Computer Use app/helper paths, bundle identities, TCC permissions, helper
process state, and display capture readiness. In Pi's TUI it opens an
input-capturing doctor view with colored check results and actions. `Re-check`
is always available, all check lines render directly in the view, and any
assistable issue appears as a selectable action: opening the matching System
Settings pane for missing Screen Recording or Accessibility permission, or
starting a short `caffeinate -dimsu -t 600` guard when the display appears
asleep.

## Elicitation auto-approval

Pi auto-approves Codex app-server elicitations for this extension by default.
This avoids races where a short-lived Computer Use or browser bridge closes while
waiting for a manual approval prompt. Override with
`PI_CODEX_COMPUTER_USE_AUTO_APPROVE`:

| Value                     | Behavior                                        |
| ------------------------- | ----------------------------------------------- |
| unset, empty, or `all`    | Auto-approve `computer-use` and `node_repl`     |
| `0`, `false`, `no`, `off` | Disable auto-approval; ask Pi UI when available |
| `computer-use`            | Auto-approve native Computer Use only           |
| `node_repl`               | Auto-approve browser/runtime Node REPL only     |
| `computer-use,node_repl`  | Auto-approve both explicit server names         |

For compatibility with an early typo, `PI_CODEX_COMPUTER_PUSE_AUTO_APPROVE` is
also accepted when the canonical variable is unset.

## Codex Desktop app-server wrapper

`codex-desktop-app-server-wrapper.mjs` lets Codex Desktop keep its expected
stdio app-server contract while the real app-server listens on a Unix socket that
other Pi tooling can also connect to.

Launch Codex Desktop directly with `CODEX_CLI_PATH` pointing at the wrapper:

```bash
PI_CODEX_DESKTOP_REAL_CODEX=/Applications/Codex.app/Contents/Resources/codex \
PI_CODEX_DESKTOP_APP_SERVER_SOCKET="$HOME/.codex/pi-codex-desktop/app-server.sock" \
CODEX_CLI_PATH="$PWD/extensions/pi-codex-computer-use/scripts/codex-desktop-app-server-wrapper.mjs" \
/Applications/Codex.app/Contents/MacOS/Codex
```

The wrapper rewrites Desktop's local app-server spawn from:

```text
codex app-server --analytics-default-enabled
```

to:

```text
codex app-server --listen unix://$PI_CODEX_DESKTOP_APP_SERVER_SOCKET --analytics-default-enabled
```

Then it bridges Desktop stdio JSON-RPC to the Unix-socket WebSocket transport.
Use the exposed socket with `scripts/codex-control.mjs --socket ...` for
additional same-process clients.

## Sync bundled Codex skills

The `skills/` directory is copied from the installed Codex.app bundled plugins.
Refresh it after updating Codex.app with:

```bash
aubr -C extensions/pi-codex-computer-use sync:skills
```

Override the Codex.app location when needed:

```bash
PI_COMPUTER_USE_CODEX_APP=/path/to/Codex.app \
  aubr -C extensions/pi-codex-computer-use sync:skills
```

Currently synced skills:

- `computer-use`
- `control-in-app-browser`
- `control-chrome`

This package also includes a Pi-specific overlay skill, `codex-computer-use`,
that explains the compact tool names. The sync command refreshes only the
vendor-copied Codex skills.

## Development

```bash
aubr -C extensions/pi-codex-computer-use test
aubr -C extensions/pi-codex-computer-use check
```
