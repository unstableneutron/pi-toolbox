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
      "apis": ["openai-responses"],
      "providers": [],
      "providerModels": ["facade/gpt-5.5-nomoderation"],
      "excludeProviderModels": []
    },
    "request": {
      "queryParams": {
        "api-version": "preview",
        "deployment": "${model.id}",
        "region": "global",
        "azure-resource-bucket": "internal-productivity"
      }
    },
    "websocket": {
      "retries": 2,
      "connectTimeoutMs": 15000,
      "idleTimeoutMs": 0
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

Defaults: `patch.enabled` is `false`; `patch.apis` is
`["openai-responses"]`; `patch.providers`, `patch.providerModels`, and
`patch.excludeProviderModels` are empty arrays; `request.queryParams` is empty;
WebSocket defaults are `retries: 2`, `connectTimeoutMs: 15000`, and
`idleTimeoutMs: 0`; recovery defaults are shown above. Keep `providerModels`
narrow when `request.queryParams` contains deployment-specific values.

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

Only `request.queryParams` adds URL query params. Azure routing values such as
`x-azure-region`, `x-azure-resource-bucket`, and `x-azure-deployment` remain
headers.

## Recovery behavior

`websocket.retries` applies only before response state exists: connection
failure, send failure, or close before any response event. After
`response.created` provides a `response_id`, the extension does not resend the
same request over a new socket. It polls:

```http
GET /responses/{response_id}
```

If the retrieved snapshot grows from already-emitted text, the extension emits
synthetic text deltas for the missing suffix. If the snapshot completes with
function calls, the extension emits each complete recovered tool call once. When
retrieve reaches `completed`, the recovered response id becomes the next
continuation checkpoint.

The next real model turn opens or reuses a WebSocket and sends only the new
input with `previous_response_id`. The extension keeps its own per-session
socket/continuation cache keyed by session, URL, provider, model, and headers;
it does not share Pi's built-in `openai-codex-responses` cache.

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
