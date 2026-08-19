# pi-web-search

Adds `web_search` and `web_fetch` tools backed by Parallel Web. A configured
`PARALLEL_API_KEY` uses the Parallel SDK. Without a key, or when the keyed
account cannot serve a request, the tools use Parallel's free Search MCP.

## Prime Agent

Install the Prime wrapper:

```bash
prime-agent package install /absolute/path/to/extensions/web-search/prime-package
```

Prime Agent already includes a Serper-backed `websearch` Python skill. This
package does not replace or disable that skill. It adds Parallel's multi-query
`web_search` and URL extraction `web_fetch` tools. If Prime Agent or another
extension already registered either exact tool name, the Prime entrypoint keeps
the existing owner and registers only the missing tool. The Pi entrypoint keeps
its existing registration behavior.

## Development

From `extensions/web-search/`:

```bash
aube run test --no-install
```
