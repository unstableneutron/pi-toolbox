# pi-toolbox

A personal bundle of [pi](https://github.com/badlogic/pi-mono) extensions, skills, prompts, and subagent templates.

## What's in here

| Directory                         | Contents                                                                                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extensions/`                     | Custom pi extensions plus config wrappers for a handful of npm-installed pi packages. Each subdirectory is a pnpm workspace member.                                                                                                                      |
| `agents/`                         | Subagent definitions (`scout`, `worker`, `planner`, `reviewer`, `researcher`, `finder`, `delegate`, `context-builder`, `changed-files-checker`). Extension allowlists are intentionally omitted so subagents inherit the host user's full extension set. |
| `prompts/`                        | Slash-command prompt templates (`/plan`, `/implement`, `/review-execute-check`, etc.).                                                                                                                                                                   |
| `skills/`                         | Author-originated pi skills.                                                                                                                                                                                                                             |
| `tests/`                          | Vitest coverage for guardrails config, extension layout, and the `scripts/pi-update-extensions.ts` tooling.                                                                                                                                              |
| `scripts/pi-update-extensions.ts` | Maintenance script that keeps this workspace's devDependencies pinned to the globally installed `pi` CLI version, patches pi-coding-agent's extension resolver, and refreshes gitchamber source snapshots.                                               |

## Quick start (at your own risk)

```bash
# 1. Install workspace dependencies (pnpm required).
pnpm install

# 2. Run tests.
pnpm test

# 3. Lint + format.
pnpm check
```

## Using this with pi

This repo is shaped as a pi package (see `package.json` → `pi` field). To try extensions in your own pi setup, clone the repo and either:

- Point individual extensions via `pi --extension <absolute-path-to>/extensions/<name>/index.ts`, or
- `pi install <absolute-path-to-this-repo>` to register the whole toolbox.

## Extensions at a glance

- `answer` — /answer command with an interactive Q&A TUI.
- `btw` — lightweight side-channel for inline notes.
- `execute-command` — self-invocation and follow-up-input queueing.
- `handoff` — transfer focused context to a new session.
- `loop` — /loop command with a breakout tool.
- `multi-edit` — multi-file edit tool with diff preview.
- `notify` — OSC 777 desktop notifications.
- `pi-fff-search` — fff-router backed find/grep/read tools.
- `pi-md-hooks` — markdown rendering hooks.
- `pi-native-split` — session splitting helpers.
- `pi-retry` — retry + refusal-recovery state machine.
- `proxied-providers` — provider proxying with Bedrock support.
- `reload-runtime` — /reload-runtime command.
- `safe-escape` — safer ESC handling with warnings.
- `shared` — editor-behaviors helpers consumed by other extensions.
- `skill-shortcut` — skill autocomplete in the editor.
- `smart-sessions` — rolling-summary sessions.
- `todos` — file-based todo tool.
- `web-search` — Parallel Web search/fetch (requires `PARALLEL_API_KEY`).
- `whimsical` — loading messages.
- `guardrails.json` — permission-gate and policy config for `@aliou/pi-guardrails`.

## License

[MIT](./LICENSE) © unstableneutron.
