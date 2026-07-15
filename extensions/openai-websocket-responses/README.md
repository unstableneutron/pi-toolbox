# openai-websocket-responses

Experimental Pi extension for OpenAI-compatible Responses API WebSocket
endpoints, with Azure/LFM-friendly URL handling and midstream recovery.

The extension provides two modes:

1. An explicit `openai-websocket-responses` API provider.
2. Optional transparent patching of existing API providers such as
   `openai-responses` for selected providers/models.

## Settings

Configure the extension in `~/.pi/agent/settings.json`:

```json
{
  "openaiWebsocketResponses": {
    "patch": {
      "enabled": true,
      "apis": ["openai-responses", "openai-codex-responses"],
      "providers": ["openai", "openai-codex"],
      "providerModels": [],
      "excludeProviderModels": []
    },
    "request": {
      "profile": "auto",
      "queryParams": {},
      "queryParamsByProvider": {
        "facade": {
          "api-version": "preview",
          "deployment": "${model.id}",
          "region": "${headers.x-azure-region}",
          "azure-resource-bucket": "${headers.x-azure-resource-bucket}"
        }
      },
      "queryParamsByProviderModel": {},
      "storeByProviderModel": {
        "facade/productivity/gpt-5*": true,
        "facade/prototype/gpt-5*": true
      }
    },
    "websocket": {
      "retries": 2,
      "connectTimeoutMs": 15000,
      "firstEventTimeoutMs": 60000,
      "idleTimeoutMs": 0
    },
    "diagnostics": {
      "successTimingFields": true,
      "successTimelineSampleRate": 0.05,
      "successTimelineSlowStartThresholdMs": 30000
    },
    "debug": {
      "enabled": false,
      "logFile": "~/.pi/agent/openai-websocket-responses.debug.jsonl"
    },
    "recovery": {
      "enabled": true,
      "pollIntervalMs": 1000,
      "timeoutMs": 30000,
      "notFoundGraceMs": 5000,
      "emitSyntheticDeltas": true
    }
  }
}
```

Defaults: `patch.enabled` is `true`; `patch.apis` is
`["openai-responses", "openai-codex-responses"]`; `patch.providers` is
`["openai", "openai-codex"]`; `patch.providerModels` and
`patch.excludeProviderModels` are empty arrays; `request.profile` is `"auto"`;
`request.queryParams`, `request.queryParamsByProvider`,
`request.queryParamsByProviderModel`, and `request.storeByProviderModel` are
empty; WebSocket defaults are `retries: 2`, `connectTimeoutMs: 15000`,
`firstEventTimeoutMs: 60000`, and `idleTimeoutMs: 0`; diagnostic defaults are
`successTimingFields: true`, `successTimelineSampleRate: 0.05`, and
`successTimelineSlowStartThresholdMs: 30000`; debug logging is disabled;
recovery defaults are shown above. Keep `providerModels` narrow when request
query params contain deployment-specific values.

For the current Azure/LFM WSS route, `api-version` alone is not enough. The
handshake also needs Azure routing values in URL query params. Use `${model.id}`
to derive the deployment per model without hardcoding every deployment. Template
values are resolved on each request.

Supported query-param template variables:

- `${headers.<name>}`: a model header, matched case-insensitively
- `${model.id}`
- `${model.name}`
- `${model.provider}`

If a template cannot be resolved, that query param is omitted.

`request.queryParams`, `request.queryParamsByProvider`, and
`request.queryParamsByProviderModel` add URL query params. Use provider or
provider/model-scoped params when patching both Azure and Codex models, so Azure
routing values do not leak into Codex URLs. Provider/model keys support `*`
globs such as `facade/gpt-5*`. `patch.providers` also supports globs; for
example, `["*"]` means every provider whose API is listed in `patch.apis`.
Azure routing values such as `x-azure-region`, `x-azure-resource-bucket`, and
`x-azure-deployment` remain headers.

`request.storeByProviderModel` overrides the non-Codex `store` default by
provider/model glob. For example, `"facade/productivity/gpt-5*": false` forces
matching facade productivity models to use stateless Responses requests. Codex
profile requests ignore store overrides and always use `store: false`.

The extension intentionally has no built-in model-family allowlist. WebSocket
compatibility depends on the configured provider endpoint and model deployment.
Use provider-level defaults for known OpenAI Responses/Codex Responses providers,
use `providerModels` for proxy/facade routes where only some deployments are WSS
compatible, and use `excludeProviderModels` for any model that fails on WebSocket.
Do not assume legacy model families such as `gpt-4*` support this transport
without a smoke test against the exact provider/model route.

`request.profile` controls endpoint-specific request shaping:

- `auto` detects Codex from `openai-codex-responses`, `openai-codex`,
  ChatGPT/backend-api URLs, or `/codex` paths; it detects Azure from
  `azure-openai-responses`, `.openai.azure.com`, `azure_openai` paths,
  `api-version`, or `x-azure-*` headers.
- `azure` forces Azure/LFM-compatible behavior.
- `codex` forces OpenAI Codex/ChatGPT-compatible behavior.
- `generic` uses plain Responses WSS URL/body behavior.

## Request body behavior

The WebSocket `response.create` body follows Azure Responses fields that also
match Pi's Codex Responses path where Azure supports them:

- Pi system prompts are sent as top-level `instructions` instead of an input
  `system`/`developer` item.
- `store` defaults to `true` for Azure/generic profiles and is forced to `false`
  for the Codex profile because ChatGPT/Codex backends reject stored responses.
  Use `request.storeByProviderModel` with provider/model globs to explicitly
  override non-Codex model families.
- If no system prompt exists, `instructions` falls back to
  `"You are a helpful assistant."`.
- `text.verbosity` defaults to `low`; callers may pass `textVerbosity` as
  `low`, `medium`, or `high`.
- `include` starts with `["reasoning.encrypted_content"]` so reasoning items can
  be replayed safely across stateless turns.
- Reasoning requests include `reasoning.summary: "auto"` by default.
- `tool_choice: "auto"` and `parallel_tool_calls: true` are sent by default.
- With Pi 0.80.7 or newer, models configured with
  `compat.supportsToolSearch: true` use native deferred tool loading. Initially
  inactive definitions are omitted from top-level `tools`; when a loader
  activates them, the next request replays completed client `tool_search_call`
  and `tool_search_output` items at
  that tool result. Models without the flag keep Pi's normal full active-tool
  fallback.
- When `sessionId` is present, it is sent as a 64-character-clamped
  `prompt_cache_key`. Azure/generic profiles omit it for `cacheRetention:
"none"`; Codex matches Codex behavior and still sends the key when a
  `sessionId` is present.

Profile-specific differences:

- `azure`/`generic` send `max_output_tokens` only when the caller explicitly
  provides `maxTokens`; `codex` omits it because Codex backends reject it.
- `azure`/`generic` send `prompt_cache_retention: "24h"` for `cacheRetention:
"long"`; `codex` omits retention.
- `codex` allows `service_tier` when provided; `azure`/`generic` omit it because
  Azure's published Responses schema does not include it.
- `codex` resolves backend API URLs to `/codex/responses` and sets Codex WSS
  headers such as `OpenAI-Beta: responses_websockets=2026-02-06`.

## Native dynamic tool loading

Pi 0.80.7 accepts `supportsToolSearch` at either provider or model `compat`
level in `~/.pi/agent/models.json`. For example:

```json
{
  "providers": {
    "facade": {
      "api": "openai-websocket-responses",
      "baseUrl": "https://proxy.example.com/openai/v1",
      "apiKey": "$FACADE_API_KEY",
      "compat": {
        "supportsToolSearch": true
      },
      "models": [
        {
          "id": "gpt-5.4",
          "name": "GPT-5.4",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 272000,
          "maxTokens": 128000
        }
      ]
    }
  }
}
```

The same flag also works when a model keeps `api: "openai-responses"` and this
extension transparently patches its transport. Enable it only after verifying
that the endpoint and model accept OpenAI's native `tool_search_call`,
`tool_search_output`, and `defer_loading` protocol. Dynamic activation still
works without the flag, but Pi sends the complete active tool list on the next
request instead.

## Recovery behavior

`websocket.retries` applies only before response state exists: connection
failure, send failure, or close before any response event. When transparent
patching runs with Pi's default `auto` transport, a WebSocket failure before the
stream starts falls back to the original provider with `transport: "sse"`.
Explicit `transport: "websocket"` and `transport: "websocket-cached"` requests
stay on WebSocket and report the failure.

After `response.created` provides a `response_id`, the extension does not resend
the same request over a new socket. It polls:

```http
GET /responses/{response_id}
```

If the retrieved snapshot grows from already-emitted text, the extension emits
synthetic text deltas for the missing suffix. If the snapshot completes with
function calls, the extension emits each complete recovered tool call once. When
retrieve reaches `completed`, the recovered response id becomes the next
continuation checkpoint.

The next real model turn opens or reuses a WebSocket and sends only the new
input with `previous_response_id`. If Azure reports `previous_response_not_found`
before any response events are processed, the extension clears the stale
continuation and retries once without `previous_response_id` using the full Pi
model context for that turn. That pays the full-context penalty once and creates
a fresh response id for later delta turns.

The extension keeps its own per-session socket/continuation cache keyed by
session, URL, provider, model, and headers; it does not share Pi's built-in
`openai-codex-responses` cache. Idle sockets are retained internally for up to
15 minutes after a turn finishes, and are removed sooner if the idle socket emits
`close` or `error`. After interactive user-initiated runs, Node `ws` sockets also
receive protocol-level pings while idle so stale cached sockets can be evicted
before the next turn; these pings do not extend the 15-minute idle cache TTL. The
extension never sends keepalive pings while a socket is busy with an active
response.

### Session diagnostics

Transport diagnostics are sparse and Pi-native. A normal successful WebSocket
turn does not add noise, but significant transport events add an
`openai_websocket_transport` item to the final assistant message's
`diagnostics` array in the session JSONL.

The diagnostic includes a local `requestId`, configured/final transport,
outcome, sanitized WebSocket URL plus `urlHash`, request byte count,
connection/cache metadata, upstream response ids when available, and a bounded
timeline. Timeline events record the path that matters for later debugging:
WebSocket acquisition, stale cached sockets, close/error codes, retry decisions,
SSE fallback, response id discovery, and retrieve recovery start/done/failure.

Successful WebSocket turns include compact startup timing fields by default:
`firstEventMs`, `responseCreatedMs`, `lastEventMs`, and `completedMs` when those
milestones are observed. Full timelines are always included for failures and
significant transport events. For otherwise normal successful requests,
`diagnostics.successTimelineSampleRate` controls random full-timeline sampling;
the default `0.05` samples roughly 5%. Successful requests also keep a full
timeline when startup is slow: `successTimelineSlowStartThresholdMs` compares
the time to `response.created` (or the first WebSocket event if no response id
was recorded) against the threshold. This slow-start threshold is intentionally
about startup latency, not total generation duration, because long model turns
can legitimately keep a WebSocket open for much longer.

Diagnostics also include a compact continuation summary so session analysis can
distinguish full-context sends from previous-response-id deltas without reading
debug logs. `continuation` records the continuation decision such as `delta` or
`no_continuation`; `sentInputItems` records the number of Responses API input
items sent on the actual request. For `delta` sends, `fullInputItems` and
`fullBytes` estimate the full-context request that was avoided; the existing
`requestBytes` field remains the actual payload size sent over the WebSocket.
When a `previous_response_not_found` recovery retries with full context, the
diagnostic sets `fallback: "previous_response_not_found"` and updates
`sentInputItems` to the full-context item count.

When transparent `transport: "auto"` falls back to SSE before the stream starts,
the WebSocket failure diagnostic is copied onto the final SSE assistant message
with `fallbackTransport: "sse"`. If a catastrophic failure prevents emitting an
assistant message at all, the extension appends a custom session entry named
`openai-websocket-transport-diagnostic` with the same diagnostic payload.

## Debugging

Enable JSONL transport logs when diagnosing reuse, continuation, and reconnect
behavior:

```json
{
  "openaiWebsocketResponses": {
    "debug": {
      "enabled": true,
      "logFile": ".pi/openai-websocket-responses.debug.jsonl"
    }
  }
}
```

Each record includes a timestamp, event name, hashed cache key, continuation
decision, request input counts, retry/fallback decisions, and idle socket cache
evictions. Authorization and token-like fields are redacted before writing.

A helper script can validate whether facade/Azure accepts persisted responses:

```bash
uv run scratch/validate-facade-store-true.py
```

## Limitations

- There is no known working WSS event-stream reattach protocol for an existing
  live `response_id`.
- `GET /responses/{id}?stream=true` only works for background streaming
  responses. WSS-created responses are recovered with JSON polling instead.
- Synthetic deltas are conservative. If retrieved text diverges from already
  emitted text, recovery fails rather than rewriting history.
- The extension does not send `generate: false` warmups. A future transport
  preconnect may open an idle socket, but semantic warmup needs the exact next
  input and is not safe by default around tool calls.

## Smoke test

With `facade/gpt-5.5-nomoderation` left as an `openai-responses` model and the
patch config above enabled:

```bash
pi --no-session --no-tools --no-skills \
  --mode json \
  --model 'facade/gpt-5.5-nomoderation:medium' \
  -p 'Reply with exactly OK.'
```
