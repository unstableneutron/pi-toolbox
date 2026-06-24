# pi-toolbox

A personal bundle of [pi](https://github.com/badlogic/pi-mono) extensions, skills, prompts, and subagent templates.

The repo is itself a pi package (see the `pi` field in `package.json`), so the whole thing can be loaded into pi in one shot or cherry-picked one extension at a time.

## What's in here

| Directory                         | Contents                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/`                     | Custom pi extensions. Each subdirectory is a pnpm workspace member with an `index.ts` entry file.                                                                                                                                                                                                                                                                         |
| `extensions-config/`              | Versioned reference configs consumed by npm-installed pi extensions that hardcode their config path under `~/.pi/agent/extensions/…`. Bidirectional sync via `mise run sync-extension-configs`. See [`extensions-config/README.md`](./extensions-config/README.md).                                                                                                       |
| `agents/`                         | Custom subagent definitions (`finder`, `changed-files-checker`). Generic roles (`scout`, `worker`, `planner`, `reviewer`, `researcher`, `delegate`, `context-builder`, `oracle`) come from `pi-subagents` builtins and should be customized through `subagents.agentOverrides`. Not a standard pi-package dir — sync to `~/.pi/agent/agents/` via `mise run sync-agents`. |
| `prompts/`                        | Slash-command prompt templates (`/plan`, `/implement`, `/review-execute-check`, `/diff-review`, `/fact-check`, `/project-recap`, etc.).                                                                                                                                                                                                                                   |
| `skills/`                         | Author-originated pi skills (`configuring-custom-provider-models`, `pi-session-explorer`, `reviewing-docs-and-ux-copy`, `roundtable-review`, `session-reader`).                                                                                                                                                                                                           |
| `tests/`                          | Vitest coverage for guardrails config, extension layout, and the `scripts/pi-update-extensions.ts` tooling.                                                                                                                                                                                                                                                               |
| `scripts/pi-update-extensions.ts` | Maintenance script that keeps this workspace's devDependencies pinned to the globally installed `pi` CLI version, patches pi-coding-agent's extension resolver, and refreshes gitchamber source snapshots.                                                                                                                                                                |

## Standalone roundtable reviewer CLI

`roundtable-review` is a Node CLI that uses the Pi SDK directly to run several
read-only reviewer sessions in parallel, then asks a synthesis session to return
the final analysis.

Default reviewer lineup:

- `openai/gpt-5.5:xhigh`
- `anthropic/claude-opus-4-8:xhigh`
- `google/gemini-3.1-pro-preview:xhigh`

Default synthesis model: `openai/gpt-5.5:xhigh`.

Pi's `xhigh` is the CLI's extra-high/max reasoning setting. The reviewer CLI
also accepts `:max`, `:extra-high`, `:extra_high`, and `:extrahigh` as aliases
for `:xhigh` in model specs.

The CLI loads enabled Pi extensions and skills by default through Pi's normal
resolver, so user/global packages such as `pi-retry` participate when installed.
Project-local resources remain gated unless you pass `--approve`. Use
`--no-extensions` or `--no-skills` only for troubleshooting or isolation.

Long-running runs print periodic live status to stderr by default, without
changing the final Markdown/JSON written to stdout. The status includes each
reviewer/synthesis session's phase, last SDK event, text/thinking character
counts, tool activity, retry activity, and timeout countdown. Use
`--status-interval-ms` to tune the heartbeat or `--no-status` to suppress it.

```bash
# From this checkout
aube run roundtable-review -- "Review the current diff"

# Or invoke the bin directly
./packages/roundtable-review/bin/roundtable-review.js --cwd /path/to/project --verbose "Review the current diff"

# Pipe explicit material from another harness
git diff | ./packages/roundtable-review/bin/roundtable-review.js --stdin "Review this diff"

# Run the standalone subpackage through aubx from this checkout
aubx -p "file:$PWD/packages/roundtable-review" roundtable-review --help

# Run the standalone subpackage through aubx from GitHub
aubx "github:unstableneutron/pi-toolbox#path:packages/roundtable-review" --help
```

For user-wide shell access, link the local checkout into `~/.local/bin`:

```bash
mise run install:cli:roundtable-review
roundtable-review --help
```

The mise task is the preferred repo-local entrypoint so setup tasks stay in one
place. It calls Node directly, so it does not care whether the checkout was
installed with aube, npm, pnpm, or Pi's configured `npmCommand`. The equivalent
package script is also available through your package manager, for example
`aube run install:cli:roundtable-review` or
`npm run install:cli:roundtable-review`. Mise discovers the task from
`mise-tasks/install/cli/roundtable-review.sh`; the path maps to the task name
`install:cli:roundtable-review`.

Pi package installation exposes this repo's extensions, skills, prompts, and
themes to Pi, but it does not automatically link package binaries into
`~/.pi/agent/bin`. For shell-wide use, invoke the bin by path or link/install the
package through your package manager. `aubx roundtable-review` would only work if
`roundtable-review` were published as a registry package; this repo-local CLI is
best run via `aube run ...` or the `~/.local/bin` symlink above.

## Quick start

```bash
# 1. Install workspace dependencies.
aube install

# 2. Run tests.
aube run test

# 3. Lint + format.
aube run check

# 4. (Optional) Re-pin workspace deps to the globally installed pi CLI
#    and refresh gitchamber source snapshots.
aube exec tsx scripts/pi-update-extensions.ts
```

## Using this with pi

The repo lives at <https://github.com/unstableneutron/pi-toolbox>. You have three main options for loading it into pi.

### 1. Install directly from GitHub

```bash
# Global install (writes to ~/.pi/agent/settings.json).
pi install git:github.com/unstableneutron/pi-toolbox

# Project-local install (writes to ./.pi/settings.json).
pi install -l git:github.com/unstableneutron/pi-toolbox

# Pin to a ref.
pi install git:github.com/unstableneutron/pi-toolbox@main
```

Pi clones the repo into `~/.pi/agent/git/github.com/unstableneutron/pi-toolbox` (or `.pi/git/...` for project installs) and runs `npm install` automatically.

### 2. Install a local clone

```bash
git clone https://github.com/unstableneutron/pi-toolbox.git
cd pi-toolbox
pnpm install

# Register this checkout as a pi package.
pi install "$(pwd)"
```

### 3. Try a single extension without installing

```bash
pi --extension /absolute/path/to/pi-toolbox/extensions/<name>/index.ts
```

Useful for experimenting with one extension at a time before committing to the full package.

After installing, toggle individual extensions, skills, and prompts on or off with `pi config`.

## Extensions at a glance

Custom extensions built in this repo:

- `answer` — `/answer` command with an interactive Q&A TUI.
- `btw` — lightweight side-channel for inline notes.
- `execute-command` — self-invocation and follow-up-input queueing.
- `handoff` — transfer focused context to a new session.
- `loop` — `/loop` command with a breakout tool.
- `multi-edit` — multi-file edit tool with diff preview.
- `notify` — OSC 777 desktop notifications.
- `pi-bash-rewrite` — optional bash override that routes recognized shell idioms to structured tools.
- `pi-fff-search` — fff-router backed find/grep/read tools.
- `pi-md-hooks` — markdown rendering hooks.
- `pi-native-split` — session splitting helpers.
- `pi-retry` — retry + refusal-recovery state machine.
- `proxied-providers` — provider proxying with Bedrock support.
- `reload-runtime` — `/reload-runtime` command.
- `safe-escape` — safer ESC handling with warnings.
- `shared` — editor-behaviors helpers consumed by other extensions.
- `skill-shortcut` — skill autocomplete in the editor.
- `smart-sessions` — rolling-summary sessions.
- `todos` — file-based todo tool.
- `web-search` — Parallel Web search/fetch with SDK primary and free Search MCP fallback.
- `whimsical` — loading messages.

Reference configs for npm-installed pi packages live in [`extensions-config/`](./extensions-config/README.md), synced on demand with `mise run sync-extension-configs`:

- `guardrails.json` — permission-gate policy for `npm:@aliou/pi-guardrails`.
- `pi-rtk-optimizer/config.json` — tuning for `npm:pi-rtk-optimizer`.
- `pi-tool-display/config.json` — tuning for `npm:pi-tool-display`.

## Subagents and prompts

- Custom subagent definitions in `agents/` plug into [pi-subagents](https://github.com/badlogic/pi-mono) workflows. Generic orchestration roles use the `pi-subagents` builtins; small local tweaks belong in `subagents.agentOverrides` rather than forked agent files.
- Prompt templates in `prompts/` register as slash commands when this package is loaded. Many of them chain together (e.g. `/plan` → `/plan-review` → `/implement` → `/review-execute-check`) and are designed to be composed via `chain-prompts`.

## License

[MIT](./LICENSE) © unstableneutron.
