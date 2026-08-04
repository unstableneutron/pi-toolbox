# BTW

`/btw` opens a side conversation without adding its turns to the parent model context. The default
surface is a Herdr popup. When Pi is not inside Herdr, or Herdr cannot open the popup, BTW uses Pi's
in-process floating overlay.

## Surfaces

- `popup` — a modal Herdr floating terminal. Outside Herdr, use the configured fallback.
- `overlay` — a temporary full-tab Herdr terminal pane. Outside Herdr, use the fallback.
- `pane` — a native Herdr, Kitty, or Ghostty split or tab.
- `inline` — Pi's in-process floating overlay.

Set the default and fallback modes:

```text
/btw config mode popup
/btw config mode overlay
/btw config mode pane
/btw config mode inline
/btw config fallback inline
/btw config fallback pane
/btw config reset
```

Configuration is stored in `~/.pi/agent/btw.json`. The defaults are:

```json
{
  "defaultMode": "popup",
  "fallbackMode": "inline"
}
```

Use an explicit surface without changing the default:

```text
/btw-popup <question>
/btw-overlay <question>
/btw-pane <question>
/btw-inline <question>
```

Because `config` is a reserved `/btw` subcommand, use `/btw ask config ...` for a question that
starts with that word.

## Herdr integration

Popup and overlay modes require Herdr 0.8.0 or newer. On the first explicit BTW launch, the
extension links its bundled `pi-toolbox.btw` plugin. The plugin runs a full child Pi TUI with a
forked, compaction-aware copy of the parent branch.

Each popup, overlay, or pane launch creates a persistent fork from the current parent branch. The
fork stays available in Pi's normal session list after its terminal closes. Inline mode keeps its
existing in-process BTW thread and persistence.
