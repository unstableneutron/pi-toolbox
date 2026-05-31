---
name: codex-computer-use
description: Use Codex.app's native Computer Use integration through Pi's compact `computer_*` tools. Use for local Mac app UI inspection and interaction through Codex CUA.
---

# Codex Computer Use in Pi

This package exposes Codex.app's bundled native Computer Use MCP server through a
compact Pi tool surface. Codex's vendor skills are synced verbatim under the
other skill directories; this overlay explains the Pi-specific tool names.

## Tool workflow

Use these tools for local Mac GUI work:

1. `computer_list_apps` — discover local apps Codex Computer Use can target.
2. `computer_get_app_state` — inspect one app's current screenshot and
   accessibility tree.
3. `computer_action` — run one native Codex Computer Use action.

Prefer `element_index` values from `computer_get_app_state` over screenshot
coordinates when both are available.

## Native action mapping

Use `computer_action.action` to choose the native Codex operation:

| `computer_action.action` | Native Codex tool          | Notes                                      |
| ------------------------ | -------------------------- | ------------------------------------------ |
| `click`                  | `click`                    | Use `element_index` when possible          |
| `scroll`                 | `scroll`                   | Requires `element_index` and `direction`   |
| `drag`                   | `drag`                     | Uses coordinate endpoints                  |
| `press_key`              | `press_key`                | Use for Return, Tab, shortcuts, arrows     |
| `type_text`              | `type_text`                | Types into the focused control             |
| `set_value`              | `set_value`                | Replaces a settable AX element value       |
| `select_text`            | `select_text`              | Selects text or positions a cursor         |
| `secondary_action`       | `perform_secondary_action` | Pass action name as `secondary_action`     |

Example: open Downloads in Finder and inspect it:

```text
computer_get_app_state({ app: "Finder" })
computer_action({ app: "Finder", action: "press_key", key: "super+alt+l" })
computer_get_app_state({ app: "Finder" })
```

## Safety

Computer Use operates live local apps. Follow the synced `computer-use` skill's
confirmation policy before risky GUI side effects such as deleting files,
submitting forms, uploading data, changing permissions, or transmitting
sensitive data.
