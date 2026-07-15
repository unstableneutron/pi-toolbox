# Vendored `pi-codex-conversion` Responses helpers

This directory contains Azure/LFM-safe adaptations of the shared Responses
conversion and stream-processing logic from `@howaboua/pi-codex-conversion`.

- Upstream repository: <https://github.com/IgorWarzocha/howaboua-pi-stuff>
- Upstream package path: `packages/pi-codex-conversion`
- Upstream source file: `src/providers/openai-responses-shared.ts`
- Snapshot commit inspected: `c916aa4960ee85074e333574592b8d30a37eda62`
- Package version at snapshot: `1.5.17`
- Latest package comparison: `2.2.7` (selective audit; not a wholesale rebase)
- Latest comparison paths: `src/providers/openai-responses/{shared,stream,native-items,signatures}.ts`
- License: MIT

## What was ported

- Per-`output_index` Responses stream state, so interleaved reasoning,
  message, and function-call items stay separate.
- Opaque reasoning item preservation via Pi `thinkingSignature` blocks.
- Assistant message `textSignature` replay, including `phase`.
- Partial tool-call JSON parsing with `partial-json`.
- Failed/aborted assistant-message filtering during replay.
- Synthetic error tool results for unmatched assistant tool calls.
- Local retrieve-recovery helpers that apply final response snapshots using the
  same reasoning-item and partial-JSON parsing rules.
- Optional top-level `instructions` extraction while preserving legacy
  system/developer input-item replay for callers that need it.
- Pi 0.80.7 native deferred tool loading via completed client
  `tool_search_call`/`tool_search_output` input items and `defer_loading` tool
  definitions.
- Pi 0.80.7 cache-write/reasoning usage accounting and terminal encrypted
  reasoning backfill for Azure responses.
- Text-only model fallback for image-bearing tool results.
- Compatibility-aware system/developer prompt roles and bounded safe replay IDs
  for foreign Responses tool calls.

## What was intentionally not ported

- ChatGPT/Codex backend URL handling.
- ChatGPT account/auth headers.
- Codex's default `instructions` fallback when no system prompt is present.
- Native Codex web search and image generation tools.
- Codex custom/freeform tool calls used by code-mode adapters.
- Codex service-tier pricing and compaction UI behavior.

When updating this vendored code, compare against the upstream source file above
and keep Azure/LFM-specific request semantics in this extension's `body.ts`,
`urls.ts`, `headers.ts`, `websocket.ts`, and `retrieve-recovery.ts`.
