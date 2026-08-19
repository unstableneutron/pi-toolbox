# pi-web-search

Adds `web_search` and `web_fetch` tools to Pi. A configured `PARALLEL_API_KEY`
uses the Parallel SDK. Without a key, or when the keyed account cannot serve a
request, the tools use Parallel's free Search MCP.

Prime Agent uses the separate `prime-websearch-parallel` Python skill. Do not
install this Pi extension in Prime Agent because it would add duplicate web
search capabilities instead of replacing Prime's bundled `websearch` skill.

## Development

From `extensions/web-search/`:

```bash
aube run test --no-install
```
