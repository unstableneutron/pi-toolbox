# pi-codex-computer-use

Pi extension that exposes Codex.app's bundled native Computer Use MCP server.

This package does **not** ship a separate macOS automation helper. It reuses the
installed Codex.app stack as-is:

```text
Pi tool call
  -> pi-codex-computer-use extension
  -> codex app-server --listen stdio://
  -> mcpServer/tool/call(server="computer-use")
  -> Codex Computer Use.app / SkyComputerUseClient
```

## Tools

The extension registers prefixed Pi tools that map one-to-one to Codex's native
Computer Use tools:

| Pi tool                         | Codex native tool          |
| ------------------------------- | -------------------------- |
| `computer_use_list_apps`        | `list_apps`                |
| `computer_use_get_app_state`    | `get_app_state`            |
| `computer_use_click`            | `click`                    |
| `computer_use_scroll`           | `scroll`                   |
| `computer_use_drag`             | `drag`                     |
| `computer_use_press_key`        | `press_key`                |
| `computer_use_type_text`        | `type_text`                |
| `computer_use_set_value`        | `set_value`                |
| `computer_use_select_text`      | `select_text`              |
| `computer_use_secondary_action` | `perform_secondary_action` |

Use `/computer-use` in Pi to inspect the resolved Codex paths and bridge status.

## Sync bundled Codex skills

The `skills/` directory is copied from the installed Codex.app bundled plugins.
Refresh it after updating Codex.app with:

```bash
pnpm run sync:skills
```

Override the Codex.app location when needed:

```bash
PI_COMPUTER_USE_CODEX_APP=/path/to/Codex.app pnpm run sync:skills
```

Currently synced skills:

- `computer-use`
- `control-in-app-browser`
- `control-chrome`

## Development

```bash
pnpm test
pnpm run check
```
