---
name: codex-computer-use
description: Use Codex.app's native Computer Use and browser integrations through Pi's `computer_*` and `codex_browser_*` tools. Use for local Mac app UI inspection, Codex in-app browser work, and Chrome extension browser work.
---

# Codex Computer and Browser Use in Pi

This package exposes Codex.app's bundled native Computer Use MCP server and
browser tool surfaces through Pi. The Codex `computer-use` vendor skill is
discovered dynamically from the installed Codex plugin cache or Codex.app bundle;
browser vendor skills such as `control-in-app-browser` and `control-chrome` are
intentionally not injected by this package until browser use moves to its own
extension.

## Computer Use workflow

Use these tools for local Mac GUI work:

1. `computer_list_apps` — discover local apps Codex Computer Use can target.
2. `computer_get_app_state` — inspect one app's current screenshot and
   accessibility tree.
3. Call one native-shaped `computer_*` action tool.

Prefer `element_index` values from `computer_get_app_state` over screenshot
coordinates when both are available.

Call `computer_get_app_state` once per assistant turn before interacting with an
app unless the latest Computer Use result already describes the exact current UI
state.

## Native action mapping

Each Pi action tool maps 1:1 to a native Codex Computer Use MCP tool:

| Pi tool                             | Native Codex tool          | Notes                                    |
| ----------------------------------- | -------------------------- | ---------------------------------------- |
| `computer_click`                    | `click`                    | Use `element_index` when possible        |
| `computer_scroll`                   | `scroll`                   | Requires `element_index` and `direction` |
| `computer_drag`                     | `drag`                     | Uses coordinate endpoints                |
| `computer_press_key`                | `press_key`                | Use for Return, Tab, shortcuts, arrows   |
| `computer_type_text`                | `type_text`                | Types into the focused control           |
| `computer_set_value`                | `set_value`                | Replaces a settable AX element value     |
| `computer_select_text`              | `select_text`              | Selects text or positions a cursor       |
| `computer_perform_secondary_action` | `perform_secondary_action` | Pass native secondary action name        |

For `computer_select_text`, provide `text` exactly as shown in the accessibility
tree, including Markdown formatting. Use `prefix` or `suffix` when the target
text is not unique.

Example: open Downloads in Finder and inspect it:

```text
computer_get_app_state({ app: "Finder" })
computer_press_key({ app: "Finder", key: "super+alt+l" })
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

Run `/codex-app-server-doctor` when browser or Computer Use calls fail, or when
you need to inspect resolved Codex paths, app-server/thread state, and summarized
MCP server/tool status.

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
Follow the injected `computer-use` skill's confirmation policy before risky side
effects such as deleting files, submitting forms, uploading data, changing
permissions, making purchases, or transmitting sensitive data.
