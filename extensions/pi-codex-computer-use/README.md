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

The extension exposes a compact Pi-facing surface over Codex's native Computer Use
MCP tools:

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

This package also includes a Pi-specific overlay skill, `codex-computer-use`,
that explains the compact tool names. The sync command refreshes only the
vendor-copied Codex skills.

## Development

```bash
pnpm test
pnpm run check
```
