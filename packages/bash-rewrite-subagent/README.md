# pi-bash-rewrite-subagent

Local-only convenience bundle for strict `pi-subagents` child processes.

It loads:

- `pi-fff-search` for direct FFF tools and the FFF Bash provider.
- `pi-multi-edit` for `edit`, `apply_patch`, and the patch Bash provider.
- `pi-bash-rewrite` as the only active `bash` override.

The bundle is private because `pi-multi-edit` is private and the bundle imports
repository-local source. It is not a public aggregate package or the owner of
provider logic. It lives under `packages/`, outside the root Pi manifest's
`extensions/` discovery directory, so normal toolbox sessions do not load it.

## Required tool allowlist

Loading an extension does not activate its tools. A child that needs all
rewrite routes must include these tool names:

```text
bash,read,ls,fff_grep,fff_find_files,apply_patch
```

Keep any other tools required by the agent, such as `grep`, `find`, `edit`,
`write`, `intercom`, or `contact_supervisor`.

For a built-in agent override in `~/.pi/agent/settings.json`, use an explicit
extension set:

```json
{
  "tools": [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "edit",
    "write",
    "apply_patch",
    "fff_grep",
    "fff_find_files",
    "contact_supervisor"
  ],
  "extensions": ["/absolute/path/to/pi-toolbox/packages/bash-rewrite-subagent/index.ts"]
}
```

An explicit `extensions` field makes `pi-subagents` pass `--no-extensions` to
the child and load only the runtime extension plus the listed paths. This
narrowing is intentional: it prevents ambient extensions from adding tools or
competing overrides to a strict child. If an agent needs `intercom`, keep the
tool name and add the `pi-intercom` extension path to this array. Custom user
agents must put the tool names and extension path in their own frontmatter
because built-in overrides do not replace every custom-agent field.

If an active rewrite target has no provider, the matching command runs as
Bash and the host reports one diagnostic. Deliberately inactive targets do not
produce a warning. The bundle does not weaken strict allowlists.
`pi-subagents` also reports requested extension tools that were not
registered, so a child can fail its launch contract even after a safe raw-Bash
fallback. This makes a misconfigured strict allowlist visible.
