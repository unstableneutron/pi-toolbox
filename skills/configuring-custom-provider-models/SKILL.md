---
name: configuring-custom-provider-models
description: Use when adding or changing Pi models in `models.json`, especially custom providers, proxy or facade routes, per-model headers, uncertain API selection, or when routing must be proven with isolated Pi runs and direct endpoint checks.
---

# Configuring Pi Custom Provider Models

Choose `api` from the endpoint's actual behavior, make JSON changes scriptedly, and prove routing with isolated `pi` runs before trusting the config.

## When to Use

- Adding or changing provider/model entries in `models.json`
- Custom `baseUrl`, proxy, facade, Azure, Vertex, Bedrock, or OpenAI-compatible routes
- Per-model headers, aliases, compatibility flags, or multi-region route variants
- Uncertainty about whether `extensions/proxied-providers` is involved

Do **not** use this for writing a brand-new transport implementation. That is extension work, not `models.json` configuration.

## Choose the API

| Route behavior | Use this `api` |
|---|---|
| OpenAI Responses semantics, `/responses` | `openai-responses` |
| OpenAI chat/completions-compatible route | `openai-completions` |
| Anthropic `/messages` | `anthropic-messages` |
| Google GenAI native API | `google-generative-ai` |
| Existing local Bedrock facade pattern in this repo | `bedrock-converse-stream` |

Pick by **payload/endpoint semantics**, not by vendor branding.

## Recommended Workflow

1. Read `models.json` siblings first. Match nearby patterns before inventing new ones.
2. If one logical model needs multiple regions or routes, stop and decide whether to create separate aliases or add only a single-region subset first.
3. If the request says scripted edit, use `jq` or `uv run --isolated python` — not manual block editing.
4. Validate syntax immediately:
   ```bash
   jq empty models.json
   jq '.providers.facade.models[] | select(.id=="gpt-5.3-codex")' models.json
   ```
4. Run an **isolated Pi smoke test** so installed skills/extensions do not skew results:
   ```bash
   pi --no-session --no-tools --no-skills --no-extensions \
     -e extensions/proxied-providers/index.ts \
     --mode json --provider facade --model 'gpt-5.3-codex' \
     -p 'Reply with exactly OK.'
   ```
6. If headers or backend routing are uncertain, test the backend directly with `curl` before removing anything.
7. Only claim a header is optional after a direct stripped-header comparison succeeds.

## Proxied-Providers Check

`settings.json -> proxiedProviders.facade = true` is **not enough** by itself.

In this repo, `extensions/proxied-providers` only intercepts models whose `api` is one of:
- `bedrock-converse-stream`
- `google-gemini-cli`
- `google-vertex`
- `openai-codex-responses`

So `facade` models using `openai-responses` or `openai-completions` bypass that extension.

## Quick Reference

| Need to prove | Command/evidence |
|---|---|
| JSON is valid | `jq empty models.json` |
| Entry is present | `jq '.providers.<provider>.models[] | select(.id=="...")' models.json` |
| Pi route works | isolated `pi --no-skills --no-extensions ...` smoke run |
| Backend route works | direct `curl` against the exact endpoint |
| Header can be removed | stripped-header `curl` also succeeds |
| One model spans multiple regions | create separate aliases or get approval for a single-region subset |
| Proxied extension is active | model `api` matches one of the wrapped APIs |

## Example

For the facade Azure route in this repo, `gpt-5.3-codex` should use:
- `api: "openai-responses"`
- `baseUrl: "https://proxy.example.com/api/v2/proxy/experimental/azure_openai/openai/v1/"`
- model headers for `x-azure-region`, `x-azure-resource-bucket`, and `x-azure-deployment`

Then verify with:
```bash
jq empty models.json
pi --no-session --no-tools --no-skills --no-extensions \
  -e extensions/proxied-providers/index.ts \
  --mode json --provider facade --model 'gpt-5.3-codex' \
  -p 'Reply with exactly OK.'
```
If header necessity is unclear, compare direct `curl` calls with full vs stripped headers before simplifying the config.

## Rationalization Traps

| Excuse | Reality |
|---|---|
| "I'll just hand-edit the JSON, it's faster" | If the request says scripted edit, use `jq` or `uv run --isolated python`. |
| "A normal Pi run worked once, so routing is proven" | Use isolated `pi --no-skills --no-extensions ...` smoke tests. |
| "The provider is proxied, so every model must use the extension" | Only models whose `api` matches the wrapped APIs go through `extensions/proxied-providers`. |
| "I can treat two regions as one model and decide later" | Multiple regions need separate aliases or an explicit single-region subset decision. |
| "One success means the extra headers are optional" | Only stripped-header direct `curl` tests can prove a header is optional. |

## Common Mistakes

| Mistake | Fix |
|---|---|
| Choosing API by provider name alone | Choose API from endpoint semantics |
| Manually editing JSON after being asked for scripted changes | Use `jq` or `uv run --isolated python` |
| Trusting ordinary `pi` runs after extensions/skills affected earlier results | Use isolated `pi` runs |
| Removing headers after one success path | Prove stripped-header success directly with `curl` |
| Assuming every proxied provider model uses `extensions/proxied-providers` | Check the model's `api` first |
| Adding the provider prefix into the model `id` unnecessarily | Keep provider and model id as separate concerns unless the backend truly expects the prefix |
| Representing multiple regional routes with one ambiguous model entry | Use separate aliases or confirm a single-region subset first |

## Red Flags

Stop and verify more carefully if you find yourself thinking:
- "The vendor is Azure, so the API must be azure-openai-responses"
- "A normal pi run worked once, that's enough"
- "If the provider is marked proxied, every model must be going through the extension"
- "The extra headers are probably redundant"
- "I'll just edit the JSON by hand"
