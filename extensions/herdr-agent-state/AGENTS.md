# Herdr Agent State Extension Guidance

This directory is a self-maintained fork of Herdr's managed Pi integration. Keep
local changes surgical so future upstream refreshes are easy to diff and merge.

## Upstream sources

- Primary upstream asset:
  `https://github.com/ogulcancelik/herdr/blob/master/src/integration/assets/pi/herdr-agent-state.ts`
- Raw refresh URL:
  `https://raw.githubusercontent.com/ogulcancelik/herdr/master/src/integration/assets/pi/herdr-agent-state.ts`
- Local gitchamber snapshot:
  `node_modules/.gitchamber/github.com/ogulcancelik/herdr/src/integration/assets/pi/herdr-agent-state.ts`
- Related Herdr Pi tool package:
  `https://github.com/ogulcancelik/pi-extensions/tree/main/packages/pi-herdr`

Before editing this extension, compare against the upstream Herdr asset. If the
snapshot is missing or stale, run:

```bash
gitchamber ogulcancelik/herdr#master
```

Prefer checking the raw URL or gitchamber snapshot over ad hoc clones. Do not add
a submodule unless the user explicitly asks for that maintenance model.

## Local fork policy

- Preserve the top-of-file upstream link in `index.ts`.
- Keep local behavior changes small, well-tested, and easy to explain.
- Avoid reshaping upstream logic unless needed for the local Pi environment.
- When upstream changes are pulled in, reapply local deltas intentionally rather
  than blending unrelated refactors into the refresh.

## Runtime gates

The extension module may load, but it should not register handlers unless all
process-level Herdr pane checks pass:

- `HERDR_ENV=1`
- `HERDR_PANE_ID` is set and non-empty
- `PI_SUBAGENT_CHILD !== '1'`

Within event handlers, use the shared `hasTui(ctx)` helper from
`../shared/ui-mode` rather than open-coding `ctx.mode` or `ctx.hasUI` checks.
Non-TUI sessions should not emit Herdr state.

Do not add prompt guidance to this state-reporting fork. Herdr prompt guidance
belongs with the `herdr` tool in `@ogulcancelik/pi-herdr`; local additions are
patched by `scripts/pi-update-extensions.ts` and applied through
`mise run pi-update`.

Agent state IPC additionally requires Herdr's socket env:

- `HERDR_SOCKET_PATH` is set

Keep tests covering these gates whenever this extension changes.
