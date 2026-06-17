# pi-codex-computer-use

Pi extension that exposes Codex.app's bundled native Computer Use and browser
runtime MCP surfaces.

This package loads a small control command by default, but Codex Computer Use is
**disabled by default**. While disabled, it does not inject Computer Use tools or
plugin skills into the agent prompt. Enable it only in the sessions, projects, or
user profile where you want Codex Computer Use available:

```json
{
  "packages": [
    {
      "source": "pi-codex-computer-use"
    }
  ]
}
```

Use the state-specific command shown by Pi: `/codex-computer-use-enable` appears
while disabled, and `/codex-computer-use-disable` appears while enabled. The
command opens a `/settings`-style editor where Enter/Space cycles each level
through `unset`, `true`, and `false`; choose `Save` to persist and reload:

- `This session` writes a sidecar file next to the current session file.
- `This project` writes `.pi/settings.json` in the current project.
- `All sessions for this user` writes `~/.pi/agent/settings.json`.

The persisted setting uses:

```json
{
  "codexComputerUse": { "enabled": true }
}
```

For local development from this repository, point the package source at the
extension directory instead of the npm package name:

```json
{
  "packages": [
    {
      "source": "/path/to/pi-toolbox/extensions/pi-codex-computer-use"
    }
  ]
}
```

If the broader `pi-toolbox` package is loaded globally, the control command is
available but the tools and skills remain disabled until `/codex-computer-use`
enables them for the current session, project, or user.

You can also load the extension directly in a specific project with an explicit
local extension path:

```json
{
  "extensions": [
    "/path/to/pi-toolbox/extensions/pi-codex-computer-use/extensions/codex-computer-use/index.ts"
  ]
}
```

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

Codex browser automation is routed through Codex app-server's `node_repl` MCP
server when possible. That preserves Codex thread metadata needed by the in-app
browser (`iab`) backend and by the official Codex Chrome browser-client runtime.

For local Chromium-family browser development, the Chrome backend has an
explicit fallback: if Codex's extension-host app-server WebSocket is unavailable,
refuses the direct Pi connection, or its native app-server probe times out, Pi
verifies the configured Codex extension is loaded in the target browser and then
drives the browser through its DevTools debug endpoint. Brave is the common local
target, but the fallback is generic to Chrome-family browsers such as Chrome,
Chromium, Edge, Arc, Vivaldi, and Opera when they expose a DevTools endpoint.
This fallback is intentionally small and documented; it does not replace or
modify Codex.app's trusted `browser-client.mjs` or native host.

For direct Codex.app parity and protocol debugging, prefer the shared Desktop
app-server mode documented below. In that mode Pi talks to the same app-server
instance that Codex.app launched, and both the in-app browser (`iab`) and the
Chrome/Brave extension browser (`chrome`) are driven through Codex's
`node_repl` + `browser-client.mjs` runtime. The DevTools fallback is only a
local Chromium escape hatch; it is not evidence that the official Codex browser
bridge path works.

| Pi tool              | Purpose                                           |
| -------------------- | ------------------------------------------------- |
| `codex_browser_list` | List tabs for the selected Codex browser backend  |
| `codex_browser_eval` | Evaluate browser-client JavaScript for automation |

Browser tools default to `backend: "iab"`. Use `backend: "chrome"` to target the
Codex Chrome extension backend (`agent.browsers.get("extension")`).

Chrome calls accept optional per-call settings so a session can target Brave or
another Chromium debug endpoint without restarting Pi:

```json
{
  "backend": "chrome",
  "debugUrl": "http://127.0.0.1:9224",
  "extensionId": "abggnaecfoknpafciidmojghmkdkkhao"
}
```

`debugUrl` is the Chromium DevTools base URL. `extensionId` is optional; when it
is omitted, the fallback first uses `PI_CODEX_CHROME_EXTENSION_ID` when set and
otherwise auto-detects a loaded Codex extension target from `/json/list`. If no
per-call or environment debug URL is configured, the DevTools fallback probes the
default/common local ports `9224`, `9222`, `9223`, `9225`, and `9230` and uses
the first reachable Chromium endpoint with the selected Codex extension.

Selection precedence is:

1. per-call `debugUrl` / `extensionId`
2. environment overrides
3. auto-detected Chromium DevTools endpoint and Codex extension target
4. built-in defaults

By default the Chrome bridge targets the official Codex Chrome extension ID
`hehggadaopoacecdllhhajmbjkdcmajg`. For local unpacked-extension experiments,
set `PI_CODEX_CHROME_EXTENSION_ID` before starting Pi to target a different
Chromium extension ID, for example:

```bash
PI_CODEX_CHROME_EXTENSION_ID=abggnaecfoknpafciidmojghmkdkkhao pi
```

The matching browser native messaging host manifest must also include
`chrome-extension://<that-id>/` in `allowed_origins`.

This only changes extension discovery/native messaging. Codex.app's bundled
extension host may still require the official extension origin for its local
WebSocket app-server. Override that separately only if you have rebuilt the
native host configuration:

```bash
PI_CODEX_CHROME_APP_SERVER_ORIGIN=chrome-extension://hehggadaopoacecdllhhajmbjkdcmajg
```

`codex_browser_eval.script` runs as an async JavaScript function body with
`agent`, `browser`, `tab`, and `nodeRepl` bindings available. Return a
JSON-serializable value for structured output, use `nodeRepl.write(...)` for
exact text, and use `nodeRepl.emitImage(...)` for screenshots.

When the Chrome DevTools fallback is active, these bindings implement the subset
needed for tab listing, opening tabs, navigation, page title/URL/text reads,
`tab.evaluate(...)`, `nodeRepl.write(...)`, and `nodeRepl.emitImage(...)`. The
full Codex browser-client capability surface remains available only when Codex's
native Chrome backend is discovered successfully.

Native Chrome bridge setup and DevTools fallback operations are bounded and
abort-aware. If Pi cancels a browser tool call, the extension propagates the
abort signal through native app-server setup, Chrome extension probing, DevTools
fetches, WebSocket protocol requests, navigation, and evaluation, then closes any
opened sockets/tabs it owns before returning `Operation aborted`.

For the Chrome backend, keep Codex Desktop and bundled plugins current:

```bash
codex app /path/to/project
codex plugin add chrome@openai-bundled
codex plugin add browser@openai-bundled
codex plugin add computer-use@openai-bundled
codex app-server daemon restart
```

Then restart Brave with remote debugging enabled, for example:

```bash
open -na "Brave Browser" --args --remote-debugging-port=9224
```

The extension resolves `scripts/browser-client.mjs` in this order:

1. `~/.codex/plugins/cache/openai-bundled/<plugin>/latest/scripts/browser-client.mjs`
2. the highest version-like cache directory under that plugin
3. the installed Codex.app bundled plugin path

### Local native-host shim

For local protocol debugging, `scripts/codex-native-host-shim.mjs` can stand in
as the `com.openai.codexextension` native messaging host. It forwards native
messaging bytes unchanged to the real extension host while writing JSONL logs of
complete frames:

- `extension->host` frames from the Chrome extension
- `host->extension` frames from the real native host
- lifecycle events such as `shim-start`, `child-exit`, and incomplete frames

The shim defaults to the official cached host at:

```text
~/.codex/plugins/cache/openai-bundled/chrome/latest/extension-host/macos/arm64/extension-host
```

Override it with `PI_CODEX_NATIVE_HOST_SHIM_REAL_HOST` or a local config file at
`~/.codex/pi-codex-computer-use/native-host-shim-config.json`:

```json
{
  "realHostPath": "/path/to/extension-host",
  "logPath": "/tmp/codex-native-host.jsonl",
  "maxPayloadChars": 50000,
  "fakeGetInfo": false,
  "fakeGetInfoVersion": "1.1.5",
  "rewriteCloseTargetToFinalizeTabs": false
}
```

Set `fakeGetInfo` to `true` only for local protocol debugging. In that mode,
the shim intercepts native-host `getInfo` requests and replies with a synthetic
Chrome extension info object instead of forwarding the request to the extension.
This is useful for isolating failures after the extension's current
`chrome.runtime.getVersion()` call. The same mode can be enabled with
`PI_CODEX_NATIVE_HOST_SHIM_FAKE_GET_INFO=1` and the version can be overridden
with `PI_CODEX_NATIVE_HOST_SHIM_FAKE_GET_INFO_VERSION`.

Set `rewriteCloseTargetToFinalizeTabs` to `true` only for local protocol
debugging of Chrome-extension tab cleanup. In that mode, host-to-extension CDP
`executeCdp` calls for `Target.closeTarget` are rewritten to a same-id
`finalizeTabs({ keep: [] })` request before they reach the extension. This
works around Chrome rejecting `Target.closeTarget` through
`chrome.debugger.sendCommand` with `Not allowed`, while preserving a real
extension response to the original request id. Keep this disabled by default:
`keep: []` closes all non-kept agent-created tabs for the turn/session and is
therefore close to cleanup semantics, but not identical to a precise one-tab CDP
close. The same mode can be enabled with
`PI_CODEX_NATIVE_HOST_SHIM_REWRITE_CLOSE_TARGET_TO_FINALIZE_TABS=1`.

Logs default to:

```text
~/.codex/pi-codex-computer-use/native-host-shim-<timestamp>-<pid>.jsonl
```

Use the shim only in disposable browser profiles or after backing up the native
messaging manifest you edit. The manifest `name` stays
`com.openai.codexextension`; only the manifest `path` should point to the shim.
The shim is a debugging aid, not part of the published runtime path.

## Skills

The package ships only one Pi-specific overlay skill, `codex-computer-use`, which
explains the compact Pi tool names. The vendor Codex skills are not copied into
this repository. Instead, while this extension is loaded, it dynamically exposes
matching skills from the installed Codex plugin sources during Pi resource
discovery:

1. `~/.codex/plugins/cache/openai-bundled/<plugin>/latest/skills/<skill>`
2. the highest version-like cache directory under that plugin
3. the installed Codex.app bundled plugin path

Currently exposed plugin skills when available:

- `computer-use` from `computer-use@openai-bundled`
- `control-in-app-browser` from `browser@openai-bundled`
- `control-chrome` from `chrome@openai-bundled`

Because these skills are provided by the extension's `resources_discover` hook,
unloading or uninstalling this extension also removes them from Pi. After
installing or updating Codex plugins, run `/reload` so Pi refreshes discovered
skill paths.

Use `/codex-computer-use-doctor` for actionable setup checks. It verifies the
Codex Computer Use app/helper paths, bundle identities, TCC permissions, helper
process state, display capture readiness, and the Chromium browser bridge. The
browser section reports the selected DevTools URL, selected Codex extension ID,
app-server origin, relevant environment overrides, native messaging status,
native bridge responsiveness, DevTools fallback usability, and guidance for any
manual steps that cannot be completed automatically.

In Pi's TUI it opens an input-capturing doctor view with colored check results
and actions. `Re-check` is always available, all check lines render directly in
the view, and any assistable issue appears as a selectable action: opening the
matching System Settings pane for missing Screen Recording or Accessibility
permission, starting a short `caffeinate -dimsu -t 600` guard when the display
appears asleep, installing the bundled `computer-use@openai-bundled` plugin,
resetting the live bridge, or adding the exact selected Codex extension origin to
existing `com.openai.codexextension` native messaging manifests. The manifest
repair is confirmation-gated and does not add wildcard origins or change the
native host name.

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
PI_CODEX_DESKTOP_APP_SERVER_LOG="$HOME/.codex/pi-codex-desktop/app-server.jsonl" \
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

When `PI_CODEX_DESKTOP_APP_SERVER_LOG` is set, the wrapper writes JSONL protocol
summaries for every complete JSON-RPC message it bridges:

- `desktop->app-server` for Codex.app requests and notifications
- `app-server->desktop` for app-server responses, requests, and notifications

Each entry includes timestamp, direction, JSON-RPC id/method when present,
result/error markers, payload byte size, and either the full payload or a
truncated preview. Set `PI_CODEX_DESKTOP_APP_SERVER_LOG_MAX_PAYLOAD_CHARS` to
override the default 50KB per-message payload cap.

To make the Pi extension use that same running Desktop app-server instead of
spawning its own stdio app-server, start Pi with the matching socket path and an
explicit opt-in:

```bash
PI_CODEX_USE_DESKTOP_APP_SERVER=1 \
PI_CODEX_DESKTOP_APP_SERVER_SOCKET="$HOME/.codex/pi-codex-desktop/app-server.sock" \
pi
```

With that opt-in, `codex_browser_eval` and `codex_browser_list` route both
`backend: "iab"` and `backend: "chrome"` through the shared Desktop app-server's
`node_repl` MCP server. This is the preferred path for verifying that Pi can
drive the same built-in Browser and connected Chrome/Brave extension instance
that Codex.app is using. Keep the opt-in disabled by default: sharing the
Desktop app-server couples Pi tool calls to the live Codex.app runtime and is
best suited to local protocol debugging and end-to-end validation.

## Development

```bash
aubr -C extensions/pi-codex-computer-use test
aubr -C extensions/pi-codex-computer-use check
```

## Vendored Codex browser-use artifacts

For local learning and browser-extension experiments, this package vendors
reference snapshots under `vendor/`:

- `vendor/codex-chrome-extension/` is an unpacked build of the public Codex
  Chrome Web Store extension. Load this directory with **Load unpacked** in
  `brave://extensions` or `chrome://extensions`.
- `vendor/codex-chrome-plugin/` is a snapshot of Codex.app's bundled Chrome
  plugin from the local Codex plugin cache, including `scripts/browser-client.mjs`
  and the native host binary available on this machine.

These vendored files are not wired into runtime behavior. See
`vendor/README.md` for provenance, caveats, and native messaging notes.
