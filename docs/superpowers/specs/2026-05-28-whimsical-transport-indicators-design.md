# Whimsical Transport Indicators Design

## Summary

Enhance `extensions/whimsical` so the active working message shows the
effective provider request transport at a glance:

```text
Whimming... · 12.4s · WS via proxy.example
Whimming... · 12.4s · SSE via api.openai.com
Whimming... · 12.4s · POST via localhost:11434
```

The indicator reports the transport that was actually used for the request,
not the configured preference. If the extension cannot detect the effective
transport confidently, it omits the transport token instead of guessing.

## Goals

- Show `WS`, `SSE`, or `POST` inline in the existing whimsical working
  message.
- Prefer effective transport over configured transport.
- Keep the implementation scoped to `whimsical` for now, using a precise
  runtime wrapper rather than changing Pi core packages.
- Avoid mutating provider payloads, messages, request bodies, or agent
  context.
- Keep repeated `/reload` cycles from stacking duplicate wrappers.

## Non-goals

- Do not add a public Pi extension event yet.
- Do not patch Pi core class prototypes for this feature.
- Do not persist transport metadata in session history.
- Do not show fallback history such as `WS→SSE`; show only the final effective
  transport used by the request.

## Architecture

`whimsical` will install an idempotent wrapper around the `pi-ai` API provider
registry. The wrapper re-registers each existing API provider with the same
`api` and original `stream` function, but replaces `streamSimple` with a thin
observer.

```text
@earendil-works/pi-ai provider registry
   |
   | getApiProviders()
   v
+-----------------------------+
| whimsical installs wrappers |
+-----------------------------+
   |
   | registerApiProvider({ api, stream, streamSimple: wrapped })
   v
normal Pi agent streamSimple() path
```

The wrapper observes request behavior in two ways:

1. It wraps `options.onResponse` to classify HTTP responses by headers.
2. It proxies the returned `AssistantMessageEventStream` to infer WebSocket use
   for known WebSocket-capable APIs when streaming starts before any HTTP
   response callback occurs.

This keeps transport detection close to provider execution while leaving the
rest of `whimsical` as a UI renderer. The wrapper reports observations through
a module-level callback installed by the extension runtime; it does not need
direct access to `ctx.ui`.

## Detection Rules

### HTTP requests

When a provider calls `options.onResponse`, classify the effective transport
from response headers:

```text
after_provider_response(headers)
   |
   +-- content-type includes text/event-stream  => SSE
   +-- otherwise                               => POST
```

The classification happens before delegating to the original `onResponse`, so
the working message can update as soon as response headers are available. The
wrapper still awaits and preserves the original callback behavior.

### WebSocket requests

WebSocket success currently does not produce an HTTP `onResponse` callback. To
avoid globally treating “no headers” as WebSocket, the wrapper applies this
inference only to known WebSocket-capable APIs, initially
`openai-codex-responses`.

```text
openai-codex-responses with transport not forced to sse
   |
   +-- first assistant stream event before HTTP onResponse => WS
   +-- HTTP onResponse occurs                             => SSE/POST from headers
```

If the configured transport is `sse`, WebSocket inference is disabled for that
request.

### Fallback behavior

For Codex auto/WebSocket requests that fall back before streaming starts:

```text
try WebSocket
   |
   x fails before stream events
   |
   v
HTTP response arrives
   |
   +-- text/event-stream => SSE
```

The user sees `SSE`, not `WS`, because the effective transport was the fallback
HTTP stream.

## State and Rendering

Extend `WorkingMessageState` with a `lastTransport` field:

```ts
type EffectiveTransport = 'ws' | 'sse' | 'post';

interface WorkingMessageState {
  turnCount: number;
  toolCount: number;
  lastModelTarget: string | undefined;
  lastCustomBaseUrl: CustomBaseUrlDisplay | undefined;
  lastTransport: EffectiveTransport | undefined;
}
```

`recordProviderRequest` continues to refresh model/base-url metadata and clears
stale transport for the new request. A new helper records detected transport
when the wrapper observes it.

Rendering changes only the existing `via` segment:

```text
before: via proxy.example
after:  WS via proxy.example
```

If no custom base URL is shown, the transport still appears as its own segment:

```text
Whimming... · 12.4s · WS
```

Completion statuses may include the same transport/base-url phrase when a
long-run or error status is shown.

## Wrapper Installation

The patch is guarded with a global symbol:

```ts
const TRANSPORT_PATCHED = Symbol.for('whimsical.transport-indicator.patched');
```

The wrapper marks each provider function it installs so `/reload` can call the
installer safely without wrapping an already wrapped provider. Existing provider
behavior remains authoritative: the wrapper delegates to the original
`streamSimple` and only observes callbacks and yielded events.

Because `streamSimple` returns an `AssistantMessageEventStream`, the wrapper
should return another `AssistantMessageEventStream` proxy rather than a bare
async generator. A background task copies events from the original stream into
the proxy, observes the first event for WebSocket inference, and lets the proxy
preserve the expected async-iterable plus `.result()` shape.

If provider registry imports fail, the extension logs or notifies a warning in
UI mode and continues without transport indicators.

## Error Handling

- If response headers are missing or malformed, classify HTTP as `POST` only
  when an HTTP response callback occurred; otherwise leave transport unknown.
- If the stream errors before any event and no HTTP response occurred, leave
  transport unknown.
- If WebSocket inference would apply but the request is explicitly configured
  as `sse`, do not infer `WS`.
- If the wrapper throws internally, it must not break provider streaming. Catch
  observer errors, skip the indicator update, and continue delegating.

## Testing Plan

- Unit-test rendering:
  - no transport keeps current output;
  - `WS via proxy.example`, `SSE via proxy.example`, and `POST via proxy.example`
    render in the requested order;
  - transport renders without `via` when no custom base URL is shown;
  - stale transport clears on the next provider request.
- Unit-test HTTP classification:
  - `content-type: text/event-stream` maps to `sse`;
  - case-insensitive and parameterized content types map correctly;
  - missing or non-SSE content type maps to `post` after an HTTP response.
- Unit-test WebSocket inference:
  - `openai-codex-responses` with `auto` or `websocket` and first stream event
    before `onResponse` maps to `ws`;
  - `openai-codex-responses` with forced `sse` does not infer `ws`;
  - an HTTP response before the first stream event wins over WebSocket
    inference.
- Unit-test wrapper idempotency across repeated installs.
- Lifecycle-test that a detected transport updates the live working message.

## Future Cleanup

This monkeypatch should be replaced when Pi exposes first-class effective
transport metadata through provider callbacks and extension events. At that
point, `whimsical` can drop the registry wrapper and consume the official event
directly.
