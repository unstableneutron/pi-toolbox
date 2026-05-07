# Proxied Providers: Why Some Built-ins Needed Local Parity Copies

This extension exists to do two narrow jobs:

- keep the built-in provider family's **payload and parser semantics**
- replace only the built-in **transport/auth behavior**
- apply that override only for opted-in providers via `settings.json -> proxiedProviders`
- optionally alias a source model reference to `[targetProvider/]targetModel` via `settings.json -> proxiedProviderModelAliases`
- optionally route every model resolved to a source provider through a target provider via `settings.json -> proxiedProviderRoutes`

In practice, that sounds simpler than it is.

For some providers, the public `@earendil-works/pi-ai` API gives us enough reusable pieces that we can keep the wrapper thin. For others, the transport, request builder, and stream parser are tightly coupled inside one non-exported implementation, so the only safe option is to carry a **local parity copy** of the missing logic.

This document explains:

1. why that happened provider-by-provider
2. why runtime monkey-patching is not a clean answer here
3. what a future TS/TS-land codegen strategy could look like if we want to reduce manual drift

## Settings knobs

Recommended minimal config for Anthropic shorthands:

```json
{
  "proxiedProviders": {
    "facade": true
  },
  "proxiedProviderRoutes": {
    "anthropic": "devai"
  },
  "proxiedProviderModelAliases": {
    "claude-sonnet-4-6": "facade/global.anthropic.claude-sonnet-4-6",
    "claude-opus-4-6": "facade/global.anthropic.claude-opus-4-6-v1",
    "claude-haiku-4-5": "facade/global.anthropic.claude-haiku-4-5-20251001-v1:0"
  }
}
```

Routing precedence:

1. exact `proxiedProviderModelAliases`
2. `proxiedProviderRoutes`
3. transport-only proxy overrides from `proxiedProviders`
4. original built-in provider behavior

Provider-route semantics:

- `proxiedProviderRoutes` maps a **resolved source provider** to a target provider, for example `{ "anthropic": "devai" }`
- routes apply to any model Pi resolved to that provider, including shorthand or fuzzy selections that resolved to that provider
- routes reuse the same deterministic target lookup used by explicit aliases:
  - exact target model id
  - exact target model name
  - normalized shorthand/date/version lookup
- route misses and ambiguous matches are errors; the extension does not silently fall back to the original provider
- direct self-routes like `{ "anthropic": "anthropic" }` are treated as configuration errors rather than no-op fallbacks

Alias semantics:

- key: either `sourceProvider/sourceModel` **or** bare `sourceModel`
- exact `sourceProvider/sourceModel` matches first
- if no exact match exists, the extension falls back to bare model aliases
- bare model aliases also match provider-specific canonical ids when they normalize to the same shorthand (for example Bedrock-resolved ids)
- string value without `/`: rewrite to `sourceProvider/<value>`
- string value with `/`: rewrite to `<targetProvider>/<targetModel>`
- object value: explicit `targetProvider?` + `targetModel`
- for bare source keys, prefer fully qualified target strings like `facade/...` so routing does not depend on whichever provider originally resolved the model

Exhaustive source-form examples for the same target:

```json
{
  "proxiedProviderModelAliases": {
    "claude-sonnet-4-6": "facade/global.anthropic.claude-sonnet-4-6",
    "anthropic/claude-sonnet-4-6": "facade/global.anthropic.claude-sonnet-4-6",
    "us.anthropic.claude-sonnet-4-6": "facade/global.anthropic.claude-sonnet-4-6"
  }
}
```

Those three source keys all route to the same facade target:

- `claude-sonnet-4-6` — shorthand model id
- `anthropic/claude-sonnet-4-6` — explicit provider/model source
- `us.anthropic.claude-sonnet-4-6` — provider-specific canonical source id after Bedrock resolution

In practice, the shorthand form is the preferred user config. The longer forms are useful for debugging, migration, or explicit overrides.

---

## Core constraint

The extension needs a seam like this:

- **reuse** request builder
- **reuse** stream parser
- **replace** transport/auth

That is easy only if upstream exposes public helpers such as:

- `buildRequest(...)`
- `forwardStreamEvents(...)`
- `createClient(...)` with injectable transport hooks

If upstream only exports a top-level function like:

```ts
streamSimpleProvider(model, context, options);
```

and that function internally does:

1. create a client
2. build the request body
3. send the request
4. parse the streaming response

then we cannot swap only step 3 without reimplementing some of the surrounding logic.

---

## Provider by provider

### Bedrock _(removed)_

This extension used to carry a Bedrock transport wrapper
(`createStreamSimpleProxiedBedrock`) that translated
`options.headers.Authorization` into `AWS_BEARER_TOKEN_BEDROCK` and
pinned a handful of AWS env vars before delegating to pi-ai's
`streamSimpleBedrock`.

pi-ai 0.68.1 made the wrapper unnecessary for our use case:

- `model.baseUrl` is read natively and pinned to `config.endpoint` via
  the internal `shouldUseExplicitBedrockEndpoint` check.
- Bearer auth is selected via the SDK-native `httpBearerAuth` scheme
  (`config.token` + `authSchemePreference`), so HTTP/2 works and the
  old duplicate-`Authorization`-header workaround is gone.
- `AWS_BEARER_TOKEN_BEDROCK` can be set once by the user's shell
  (typically by an external command such as `iap-auth`), so no
  per-request env translation is required inside pi.

For the author's current setup — `facade/*` models consumed directly,
with the bearer supplied by the shell — the wrapper was never invoked
(no entry in `proxiedProviders`) and rewriting-into-bedrock wasn't
used either, so the file was deleted outright. Rewrites that target a
different API on the same provider (for example
`anthropic/* → devai`) still work through the generic routing in
`index.ts`.

If a future setup needs a bedrock-specific transport override again,
reinstate this extension's prior approach from git history:
re-add `bedrock.ts` with a `createStreamSimpleProxiedBedrock` factory
and register it via `registerWrappedApi({ api: 'bedrock-converse-stream',
proxiedSimpleFactory })`. The last working version of that file is the
cleanest starting point — it's a ~15-line body with a minimal env-var
neutralization list.

---

### Google Gemini CLI

**Why the wrapper is smaller than Bedrock**

Gemini CLI gave us one important public seam:

- `buildRequest(...)`

That meant we could reuse the upstream request builder rather than recreating the outbound body from scratch.

We still needed local code for:

- endpoint replacement (`baseUrl` as the sole endpoint)
- resolved-header authority
- proxied fetch transport
- SSE event forwarding/parsing

The public package does **not** expose the Gemini CLI stream parser as a reusable helper, so the parser still had to live locally. But because the request builder was public, this wrapper is only a **partial** parity copy instead of a near-full one.

**Summary:** request builder reusable, parser not reusable.

---

### Google Vertex

**Why the wrapper is larger than Gemini CLI**

Vertex did not expose the request-building seam that Gemini CLI did.

We needed to change:

- transport base URL resolution
- auth/header behavior
- streaming transport path

while preserving:

- request-body semantics
- system prompt / tool serialization behavior
- stream parser semantics

Because there is no public `buildVertexRequest(...)` helper, the wrapper needs local copies of:

- message conversion
- request body construction
- SSE event forwarding/parsing

This is why Vertex looks much closer to a full port than Gemini CLI.

**Summary:** no public builder, so both payload building and parsing needed local parity logic.

---

### OpenAI Codex Responses

**Why the wrapper is also substantial**

Codex was difficult for a different reason: transport policy itself is part of the built-in behavior.

For proxied Codex, v1 requires:

- respect `model.baseUrl`
- resolved headers remain authoritative
- no auth reconstruction from `apiKey`
- SSE-only behavior in proxied mode
- explicit websocket rejection
- preserved request-body semantics
- preserved SSE event semantics

The built-in implementation bundles together:

- request body construction
- auth/header handling
- transport selection (SSE vs websocket)
- SSE parsing
- websocket behavior

So even if we could intercept some part of it, we would still inherit behavior we explicitly wanted to remove.

That forced local ownership of:

- request body shaping
- SSE-only transport policy
- SSE event handling
- tool-call stream handling
- websocket rejection

**Summary:** transport policy and parser behavior were bundled together, so a local parity copy was the safest route.

---

## Why we did not just monkey-patch at runtime

Short version: in modern TS/ESM code, that usually is not a clean or provider-scoped option.

### 1. The helper we want is usually not exported

A typical upstream module looks like:

```ts
function createClient(...) { ... }

export const streamSimpleFoo = (...) => {
  const client = createClient(...)
  ...
}
```

If `createClient` is module-local, dynamically importing the module does **not** give us access to that symbol.

### 2. Exported functions close over local bindings

Even if the module exports `streamSimpleFoo`, that function already closes over the original local `createClient` binding.

So replacing something on the imported namespace object does not reliably replace the internal function call site.

### 3. ESM exports are poor monkey-patching targets

Even for exported functions, ESM namespace bindings are effectively read-only from consumer code. Patching them is fragile and runtime-dependent.

### 4. Global patches are too broad

Possible hacks like these are all unattractive:

- patch `globalThis.fetch`
- patch `BedrockRuntimeClient.prototype.send`
- patch shared SDK internals

Why they are bad here:

- affect non-proxied providers too
- create cross-talk risk between concurrent requests
- break provider-scoped opt-in semantics
- are brittle across upstream upgrades

### 5. Loader/source rewriting is effectively a custom build system

We could theoretically:

- rewrite imported source before evaluation
- inject exports into upstream modules
- alias imports to transformed copies

But that is much more complex and fragile than carrying a local parity copy with tests.

**Bottom line:** runtime patching is possible only in hacky global ways, not in a clean provider-scoped way for these built-ins.

---

## If we want a codegen path later, what are the realistic TS/TS-land strategies?

Yes — but the key idea is usually **not** “import the original module and overwrite its private functions.”

The realistic idea is instead:

> generate a controlled local fork of the upstream module, expose the seams we need, and import **that**.

### Strategy 1: Vendored generated copies + AST patching

This is the most practical approach if we stay inside this repo.

#### Flow

1. pull upstream source snapshots
2. copy selected provider files into a generated local directory
3. run a codemod that:
   - exports previously-local helpers like `buildRequest`, `createClient`, `forwardEvents`
   - injects transport hooks
   - rewrites internal imports to local/generated paths
4. import the generated modules from this extension instead of the original upstream modules

#### Good tooling

- `ts-morph`
- `recast`
- `jscodeshift`
- Babel parser + generator
- TypeScript compiler API

#### Pros

- deterministic
- diffable
- testable
- provider-scoped
- no runtime monkey-patching

#### Cons

- still a fork, just generated
- generator must be kept in sync with upstream source layout
- upgrades can break the codemod

This is probably the best "code-gen" direction if we want one.

---

### Strategy 2: Patch the dependency source with `patch-package` / patched deps

Instead of generating local copies, patch the installed dependency so the missing helpers become public exports.

#### Pros

- thin local wrapper code
- no need to duplicate as much provider logic

#### Cons

- patches are version-sensitive
- installed-package patching is easy to forget during upgrades
- still not a runtime override; it is effectively a maintained fork
- makes the extension depend on local package patch discipline

This can work, but it is operationally messier than explicit generated local copies.

---

### Strategy 3: Maintain a small local "compat fork" package

Create a local package or directory that intentionally vendors the needed upstream provider modules, with small controlled edits.

Think of it as:

- upstream source imported once
- forked locally in a clearly named namespace
- extension imports the local compat modules

#### Pros

- very explicit
- easy to review
- avoids loader tricks

#### Cons

- manual drift unless paired with codegen
- still a fork

This is effectively what we are doing now, just without an automated extraction pipeline.

---

### Strategy 4: Generate seam-exposed wrapper modules

Instead of copying the whole upstream file, generate a transformed variant that changes this shape:

```ts
function createClient(...) { ... }
function buildRequest(...) { ... }
function forwardEvents(...) { ... }

export const streamSimpleFoo = (...) => { ... }
```

into this shape:

```ts
export function createClient(...) { ... }
export function buildRequest(...) { ... }
export function forwardEvents(...) { ... }

export function streamSimpleFooWithHooks(..., hooks = {}) { ... }
export const streamSimpleFoo = (...) => streamSimpleFooWithHooks(...)
```

Then the extension can import the generated `*WithHooks` entrypoint.

#### Pros

- best reuse if the transformation is reliable
- gives us clean transport seams

#### Cons

- AST transform must understand enough of the source to safely rewrite it
- more sophisticated than plain file copy

This is appealing if we want an upgradeable "semi-fork" workflow.

---

### Strategy 5: Loader-time transforms / import aliasing

Examples:

- custom Node ESM loader
- build-time aliasing to transformed modules
- Vite/Rollup plugin that rewrites provider modules

#### Pros

- powerful

#### Cons

- hard to reason about
- hard to test
- easy to make environment-specific
- still does not solve module-local closure issues unless source is rewritten

This is usually not worth it here.

---

## What would be the ideal upstream shape?

The cleanest long-term solution is not more clever patching. It is better upstream seams.

For example:

### Gemini CLI

```ts
export function buildRequest(...) { ... }
export function forwardGeminiCliEvents(...) { ... }
export function streamGoogleGeminiCliWithHooks(..., hooks?: { fetch?: ... }) { ... }
```

### Vertex

```ts
export function buildVertexRequest(...) { ... }
export function forwardVertexEvents(...) { ... }
```

### Codex

```ts
export function buildCodexRequestBody(...) { ... }
export function forwardCodexSseEvents(...) { ... }
export function streamCodexWithHooks(..., hooks?: { fetch?: ..., transportPolicy?: ... }) { ... }
```

If upstream exposed those seams publicly, our extension could become dramatically smaller.

---

## Recommendation

If we ever invest in reducing drift, the order of preference is:

1. **Best long-term:** upstream exported helpers / hookable stream entrypoints
2. **Best local TS strategy:** generated local parity copies using AST codemods
3. **Okay but messier:** dependency patching (`patch-package`, patched dependencies)
4. **Avoid:** runtime monkey-patching of imports, global fetch patching, prototype patching

So yes, a "code-gen copy + patch + expose seams" approach is plausible in TS land.

The clean version of that approach is:

- copy upstream source into a generated local module
- codemod the missing exports / hook points into it
- import the generated module instead of trying to overwrite private runtime bindings

That is much safer than trying to monkey-patch already-evaluated ESM modules.

---

## Practical takeaway

The amount of code we had to port is mostly a measure of **how entangled the upstream implementation is**, not of how complicated proxied mode itself is.

- **Gemini CLI** needed the least help because it already exposed `buildRequest(...)`.
- **Vertex** needed local request + parser parity because the useful seams were not public.
- **Codex** needed local transport policy + parser parity because transport and semantics were bundled together.
- **Bedrock** used to be the worst offender, but pi-ai 0.68.1 fixed the relevant seams upstream (`model.baseUrl` → `config.endpoint`, SDK-native `httpBearerAuth`) and the local wrapper was deleted.

That is why some wrappers are thin, some are large, and one is gone.
