# pi-render-gate

Pauses Pi TUI rendering while the current Herdr tab is hidden, then flushes one render when the tab becomes visible again.

The extension is intentionally provider-shaped:

- Pi-side: monkey-patches `tui.requestRender()` with a small dirty render gate.
- Herdr-side: uses `HERDR_*` environment variables and the Herdr socket API to subscribe to `workspace.focused` and `tab.focused` events.

It does **not** suspend the Pi process. Agent work, tools, and session state continue while hidden; only TUI render requests are coalesced.

## Requirements

Pi 0.84.1 or newer is required.

The extension activates only when all of these Herdr variables are present:

- `HERDR_ENV=1`
- `HERDR_SOCKET_PATH`
- `HERDR_WORKSPACE_ID`
- `HERDR_TAB_ID`
- `HERDR_PANE_ID`

Set `PI_RENDER_GATE_DISABLED=1` to disable the extension for a session.

## Behavior

- Active when the Herdr workspace is focused and its active tab matches `HERDR_TAB_ID`.
- Rebinds the render gate when Pi switches between regular and fullscreen TUI
  renderers.
- Inactive when another workspace or tab is focused.
- While inactive, coarse lifecycle events schedule one debounced forced render flush, then rendering is paused again. These events are `agent_start`, `agent_end`, `message_end`, `tool_execution_end`, `turn_end`, and `user_bash`. This keeps hidden-pane terminal buffers fresh enough for Herdr `pane read` / `agent read` fallback checks without streaming every intermediate render.
- If the Herdr socket fails, the extension fails open and resumes rendering.

## Development

```bash
pnpm exec vitest run extensions/pi-render-gate/index.test.ts
pnpm exec oxlint -c extensions/pi-render-gate/.oxlintrc.json --type-aware --type-check --deny-warnings extensions/pi-render-gate
```
