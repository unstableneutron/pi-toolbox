# extensions-config

JSON configuration files consumed by npm-installed pi extensions that hardcode their config path to `~/.pi/agent/extensions/<name>/` via pi's `getAgentDir()` helper.

At runtime those extensions **only** read from `~/.pi/agent/extensions/…`. The copies in this directory are **versioned reference defaults** — what your `~/.pi/agent/extensions/` layout should look like, kept in the repo so you can review drift, bootstrap a fresh machine, or revert to a known-good set.

Files currently tracked:

| File                           | Read by                    | Runtime path                                          |
| ------------------------------ | -------------------------- | ----------------------------------------------------- |
| `guardrails.json`              | `npm:@aliou/pi-guardrails` | `~/.pi/agent/extensions/guardrails.json`              |
| `pi-rtk-optimizer/config.json` | `npm:pi-rtk-optimizer`     | `~/.pi/agent/extensions/pi-rtk-optimizer/config.json` |
| `pi-tool-display/config.json`  | `npm:pi-tool-display`      | `~/.pi/agent/extensions/pi-tool-display/config.json`  |

## Syncing

Two ways of thinking about this directory exist simultaneously:

- **The repo is the source of truth.** You edit JSON here, push to `~/.pi/agent/` when you want it live.
- **The live tree is the source of truth.** You tune via `pi config` or by editing live JSON, pull back into the repo when you want to commit it.

The sync tool supports both. Invoke it from the repo root:

```bash
# Dry-run: status + coloured diffs. Exits non-zero if anything drifts.
mise run sync-extension-configs

# Interactive apply: walks each differing file and prompts for direction.
mise run sync-extension-configs --apply
```

Prompt keys per differing file:

- `<` — pull live → repo (capture your current tuning for commit)
- `>` — push repo → live (bootstrap a fresh machine, revert to committed state)
- `s` — skip this file
- `q` — quit the walk

Writes are atomic (`copyFileSync`). Only files already tracked in `extensions-config/` are ever touched; anything else in `~/.pi/agent/extensions/` is ignored.

## Why not symlinks?

All three of these extensions save via `writeFileSync(tmp) + renameSync(tmp, target)`. That atomic-replace pattern clobbers symlinks on first save, silently detaching the repo from the live state. Explicit copy-and-diff is sturdier.
