# OpenAI WebSocket trace context design

## Status

Approved for planning. This design covers trace context propagation for
`extensions/openai-websocket-responses` only. It intentionally does not add
global tracing for all Pi providers.

## Goal

Make WebSocket/proxy failures easier to correlate across:

- Pi assistant-message diagnostics and debug JSONL
- the extension's cached WebSocket lifecycle
- CLIProxyAPI `main.log`
- CLIProxyAPI `v1-responses-*` request logs and websocket timelines

The implementation should add enough information to debug transport failures
without logging token deltas or creating noisy new log files.

## Non-goals

- Do not add `X-Request-Id` in this phase.
- Do not repurpose `session-id`, `x-client-request-id`, or Pi `sessionId` for
  tracing; those remain cache/session-affinity identifiers.
- Do not disable cached WebSocket reuse by default.
- Do not add private per-message trace protocol fields in phase 1.
- Do not implement all-provider tracing through the current Pi extension hook.

## Existing constraints

Pi currently passes a long-lived `StreamOptions.sessionId` into provider calls.
Built-in OpenAI/Codex providers map that session id to prompt-cache and
session-affinity fields such as `prompt_cache_key`, `session-id`, and
`x-client-request-id`. There is no generic per-provider-request trace id in Pi's
public stream options.

The current `pi-coding-agent` public `before_provider_request` extension event
is payload-only. It cannot patch `streamOptions.headers` globally for all
providers. A future all-provider trace feature should be implemented in Pi core
stream-option assembly or via a first-class header-capable hook, not through the
payload-only hook.

`openai-websocket-responses` already has a local transport diagnostic
`requestId`, but it is not propagated to request headers. CLIProxyAPI already
writes WebSocket upgrade requests to existing `v1-responses-*` logs with
websocket timeline sections, but those logs lack a stable bridge back to Pi
diagnostics and `main.log` session lines.

## Trace model

Use only the W3C Trace Context `traceparent` header:

```http
traceparent: 00-<32 lowercase hex trace-id>-<16 lowercase hex span-id>-01
```

Generate non-zero lowercase hex identifiers. If an inbound `traceparent` already
exists in `options.headers`, preserve or continue it rather than blindly
overwriting it.

### Identifier semantics

- `sessionId`, `session-id`, `x-client-request-id`: Pi session and cache/session
  affinity.
- extension diagnostic `requestId`: local logical model request id for Pi
  diagnostics.
- WebSocket handshake `traceparent`: cached WebSocket connection / proxy session
  trace.
- SSE/retrieve `traceparent`: HTTP transport attempt trace for that logical
  model request.
- upstream `resp_*`: upstream logical response id, once available.

## Scope

Tracing is enabled by default for requests actually handled by
`extensions/openai-websocket-responses`, including:

- direct `openai-websocket-responses`
- transparent-patched `openai-responses`
- transparent-patched `openai-codex-responses`
- extension-owned WebSocket attempts
- extension-owned SSE fallback
- retrieve-recovery GET requests
- `previous_response_not_found` full-context fallback retry

It does not cover unrelated providers such as Anthropic, Gemini, Mistral, or
OpenAI Completions unless they are later routed through a global Pi core tracing
feature.

## WebSocket cached behavior

Cached WebSocket reuse is preserved. Because WebSocket headers are sent only on
the upgrade handshake, a `traceparent` on a cached WebSocket is connection-level,
not per logical model request.

Implementation requirements:

- Inject the WebSocket handshake `traceparent` when opening a new socket.
- Store the connection trace context on the socket cache entry.
- Reuse that connection trace context when a later logical request hits the same
  cached socket.
- Ensure `traceparent` does not break cache reuse. It must either be excluded
  from `headersFingerprint` / socket cache keys or injected after cache-key
  calculation.
- On cache hits, Pi diagnostics should record both the logical request id and the
  reused connection trace context.

This gives a stable bridge between Pi's socket diagnostics and CLIProxyAPI's
proxy websocket session without introducing per-message protocol changes.

## SSE fallback and recovery behavior

For normal HTTP/SSE requests, headers are sent per request. Use one logical
trace id for the extension-handled model request and a new span id for each HTTP
transport attempt.

If WebSocket setup fails before streaming and the extension falls back to SSE:

- record the failed WebSocket connection trace in diagnostics;
- send `traceparent` on the SSE fallback request with the same logical trace id
  and a new span id;
- record the fallback relationship in the diagnostic timeline.

For retrieve-recovery GET requests, send `traceparent` with the same logical
trace id and a new span id for the retrieve attempt.

## Pi diagnostics and debug logs

Attach trace fields to the existing `openai_websocket_transport` diagnostic.
Normal successful responses should remain compact. Significant transport events
or failures may include the existing bounded timeline with span and trace fields.

Normal success details should include, when available:

- local diagnostic `requestId`
- logical trace id
- current `traceparent`
- connection `traceparent` for WebSocket paths
- WebSocket `connectionId` / cache status
- final transport and outcome
- final upstream response id

Failure/significant-event timelines should include only meaningful transport
events such as attempt start, WebSocket acquire, response id discovery,
response completion, retry, close/error, SSE fallback, retrieve recovery, and
`previous_response_not_found` fallback. Do not log token or output delta events.

If no assistant message is produced, include the same trace fields in the
existing custom session diagnostic entry fallback.

Debug JSONL events should include trace id, span id, and traceparent for
connection creation, attempts, fallback, recovery, completion, and transport
errors when debug logging is enabled.

## CLIProxyAPI logging

Enhance existing logs; do not add a new log file format in phase 1.

For WebSocket upgrades and timeline entries, log:

- raw `traceparent`
- parsed `trace_id`
- parsed `span_id`
- proxy WebSocket session id
- upstream auth label/id only in the existing redacted form
- upstream `resp_*` when observed
- terminal/completed/error/close summary

Add trace fields to relevant `main.log` WebSocket connect, disconnect, upstream
disconnect, and downstream error lines where practical. The existing
`v1-responses-*` websocket timeline remains the primary detailed artifact.

## Settings

Start with the smallest setting surface:

```ts
trace: {
  enabled: boolean; // default true
}
```

Provider/model include/exclude filters are deferred until a real endpoint rejects
`traceparent` or another operational need appears.

## Future work

- Add a debug-only `fresh-socket` mode if one-request-per-WebSocket correlation
  is needed for a difficult incident.
- Add a CLIProxyAPI-only per-message trace marker only if connection-level
  tracing plus `resp_*` is insufficient. The proxy must parse and strip such a
  marker before upstream forwarding.
- Add all-provider tracing in Pi core stream-option assembly or a new
  header-capable provider-request hook.

## Validation plan

Extension tests should verify:

- valid W3C lowercase non-zero `traceparent` generation;
- tracing defaults to enabled for extension-handled requests;
- existing `session-id` and `x-client-request-id` behavior is preserved;
- WebSocket cache keys are not invalidated by generated trace context;
- cache hits report the stored connection trace context in diagnostics;
- SSE fallback and retrieve recovery send traceparent with appropriate span ids;
- significant failures include bounded trace timeline entries;
- catastrophic diagnostic fallback includes trace fields.

CLIProxyAPI tests should verify:

- inbound `traceparent` is parsed and logged in websocket timeline entries;
- invalid `traceparent` is logged as raw only or ignored safely;
- proxy websocket session id and upstream `resp_*` appear in timeline summaries;
- upstream read/close/error events include trace fields where available.
