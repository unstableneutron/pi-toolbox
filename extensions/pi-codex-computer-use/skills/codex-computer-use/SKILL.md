---
name: codex-computer-use
description: Use Codex.app's native Computer Use and browser integrations through Pi's compact `computer_*` and `codex_browser_*` tools. Use for local Mac app UI inspection, Codex in-app browser work, and Chrome extension browser work.
---

# Codex Computer and Browser Use in Pi

This package exposes Codex.app's bundled native Computer Use MCP server and
Codex browser runtime through compact Pi tool surfaces. Codex's vendor skills
are synced verbatim under the other skill directories; this overlay explains the
Pi-specific tool names.

## Computer Use workflow

Use these tools for local Mac GUI work:

1. `computer_list_apps` — discover local apps Codex Computer Use can target.
2. `computer_get_app_state` — inspect one app's current screenshot and
   accessibility tree.
3. `computer_action` — run one native Codex Computer Use action.

Prefer `element_index` values from `computer_get_app_state` over screenshot
coordinates when both are available.

## Native action mapping

Use `computer_action.action` to choose the native Codex operation:

| `computer_action.action` | Native Codex tool          | Notes                                    |
| ------------------------ | -------------------------- | ---------------------------------------- |
| `click`                  | `click`                    | Use `element_index` when possible        |
| `scroll`                 | `scroll`                   | Requires `element_index` and `direction` |
| `drag`                   | `drag`                     | Uses coordinate endpoints                |
| `press_key`              | `press_key`                | Use for Return, Tab, shortcuts, arrows   |
| `type_text`              | `type_text`                | Types into the focused control           |
| `set_value`              | `set_value`                | Replaces a settable AX element value     |
| `select_text`            | `select_text`              | Selects text or positions a cursor       |
| `secondary_action`       | `perform_secondary_action` | Pass action name as `secondary_action`   |

Example: open Downloads in Finder and inspect it:

```text
computer_get_app_state({ app: "Finder" })
computer_action({ app: "Finder", action: "press_key", key: "super+alt+l" })
computer_get_app_state({ app: "Finder" })
```

## Browser workflow

Use these tools for Codex browser work:

1. `codex_browser_list` — list tabs for the selected backend. Defaults to
   `backend: "iab"`; use `backend: "chrome"` for the Codex Chrome extension
   backend.
2. `codex_browser_eval` — evaluate Codex browser-client JavaScript. The `script`
   runs as an async function body with `agent`, `browser`, `tab`, and `nodeRepl`
   bindings available.

Return JSON-serializable values from `codex_browser_eval` for structured output.
Use `nodeRepl.emitImage(...)` for screenshots and `nodeRepl.write(...)` for exact
text output.

Run `/codex-computer-use-status` when browser or Computer Use calls fail, or when
you need to inspect resolved Codex paths, app-server/thread state, and summarized
MCP server/tool status. Use `/codex-computer-use-status verbose` when you need
raw diagnostic JSON; it writes the JSON to a temporary file and prints the path
instead of dumping full MCP schemas into the status output.

Example: open Slickdeals in the in-app browser and inspect it:

```text
codex_browser_eval({
  script: `
    await tab.goto("https://slickdeals.net");
    return {
      title: await tab.title(),
      url: await tab.url(),
      snapshot: await tab.playwright.domSnapshot()
    };
  `
})
```

## Safety

Computer Use operates live local apps, and browser tools operate live pages.
Follow the synced `computer-use` and browser skills' confirmation policies before
risky side effects such as deleting files, submitting forms, uploading data,
changing permissions, making purchases, or transmitting sensitive data.
