# Web search

`web_search` retrieves current sources through a single HTTP search endpoint, Parallel. It never selects a chat model: the session's model supplies routing for its own conversation and plays no part in retrieval.

Retired surfaces: the `web` model role, per-call model overrides, hosted search adapters (Anthropic, Codex, Gemini, OpenAI, OpenRouter, xAI), the Perplexity adapter, and the other HTTP engines (Brave, DuckDuckGo, Ecosia, Google, Jina, Kagi, Kimi, Mojeek, Ollama, SearXNG, Startpage, Tavily, TinyFish, Z.AI, and the `public` fan-out). An engine id that no longer exists is rejected rather than silently mapped to another.

## Inputs

| Field | Meaning |
| --- | --- |
| `query` | Required search text. `site:`, `-site:`, `after:`/`before:`, `inurl:`, `intitle:`, `filetype:`, quoted phrases, `-exclusions`, and `OR` groups are parsed out before the request. |
| `recency` | Optional `day`, `week`, `month`, or `year` freshness filter. |
| `limit` | Maximum result count; the provider clamps the request to 40 results. |
| `num_search_results` | Provider search breadth; takes precedence over `limit`. Defaults to 10. |

There is no `max_tokens` or `temperature` input: no adapter samples a model.

Returned results carry source titles, URLs, snippets, and any supplied citations or related questions. Snippets and cited excerpts are capped at 240 characters in the model-facing summary; full URLs are kept. Constraints the endpoint cannot express natively are enforced afterwards by `applyQueryConstraints`, and any constraint that would remove every result is relaxed with a visible `Note:` line instead of returning nothing.

## The Parallel engine

`parallel` calls Parallel's Search API (`POST https://api.parallel.ai/v1beta/search`, header `parallel-beta: search-extract-2025-10-10`). It resolves credentials from the central store — `PARALLEL_API_KEY` or `omp /login parallel`. With no credential at all it falls back to Parallel's public MCP endpoint (`https://search.parallel.ai/mcp`), so the engine is always available; a credential that is configured but unresolvable is an error rather than a silent downgrade to anonymous search.

`site:`/`-site:` and `after:` are mapped onto Parallel's `source_policy`; the remaining directives travel in the query text in the syntax that endpoint accepts.

## CLI

`omp q` and `omp web-search` drive the same engine. `--engine` selects an HTTP endpoint by id and cannot name a model:

```sh
omp q 'TypeScript release notes'
omp q --engine=parallel --recency=week 'latest TypeScript changes'
omp q 'transformer scaling site:arxiv.org after:2024 -site:reddit.com'
```

`--engine=<unknown>` fails with `Unknown HTTP search engine`. `--model` fails with `Web search model overrides are not supported; use --engine for an HTTP search engine.` Library callers passing `SearchQueryParams.engine` hit the same validation, and passing `model` throws.

## Cancellation, limits, and errors

Each request uses `providers.webSearchTimeoutSeconds` (60 seconds by default, capped at 300). Cancellation aborts the search immediately instead of widening it to another endpoint. A failed attempt is recorded in `details.failures` (`provider`, `label`, `reason`, and the HTTP `status` when there is one) and the output names the endpoint that failed.

`web_search.enabled` controls whether the tool is offered at all.

The implementation is `packages/coding-agent/src/web/search/index.ts`, with the engine registry in `provider.ts`, the adapter in `providers/parallel.ts`, and directive parsing in `query.ts`.
