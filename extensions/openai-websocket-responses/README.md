# openai-websocket-responses

Experimental Pi extension that registers an `openai-websocket-responses` API
provider for OpenAI-compatible Responses API WebSocket endpoints.

It currently includes a temporary `facade-ws/gpt-5.5-nomoderation` smoke-test
provider pointed at LLM Fusion Hub's experimental Azure OpenAI route.

## Temporary smoke test

```bash
pi --no-session --no-tools --no-skills --no-extensions \
  -e /Users/thinh_nguyen/Projects/personal/pi-toolbox/extensions/openai-websocket-responses \
  --mode text \
  --model 'facade-ws/gpt-5.5-nomoderation:medium' \
  -p 'Reply with exactly OK.'
```
