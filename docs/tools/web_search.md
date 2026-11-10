# Web search

`web_search` retrieves current sources through HTTP search engines or the current session model's hosted search capability. It never selects a second chat model. The old `web` model role, per-call model overrides, cheaper `webSearchModel` substitutions, and automatic xAI injection for X queries have been removed.

The application uses the active model object as supplied by the session, including its provider, endpoint, and routing. The automatic chain first tries Parallel, then that exact model's hosted search when supported, followed by Exa, Firecrawl, SearXNG, and the existing public HTTP engine paths. Other HTTP engines remain available through explicit `--engine` selection. A failure advances only to HTTP search endpoints. It does not discover another chat model or replay the request against a model-role fallback chain.

## Inputs

| Field | Meaning |
| --- | --- |
| `query` | Required search text. Supports `site:`, excluded sites, date bounds, quoted phrases, and other common search directives. |
| `recency` | Optional `day`, `week`, `month`, or `year` filter, when supported by the engine. |
| `limit` | Maximum result count, bounded by each provider. |
| `num_search_results` | Provider-specific search breadth or local result cap. |
| `max_tokens` | Output budget for the current model's hosted search. |
| `temperature` | Sampling parameter for hosted adapters that support it. |

Returned results include source titles, URLs, snippets, and any supplied citations. The pipeline applies query constraints after retrieval when an engine cannot express them itself. A constraint that would remove every result is relaxed with a visible note.

## HTTP engines and hosted search

HTTP adapters include Brave, DeepSeek search, DuckDuckGo, Ecosia, Exa, Firecrawl search, Google, Jina search, Kagi, Keenable, Kimi search, Mojeek, Ollama web search, Parallel, SearXNG, Startpage, Synthetic search, Tavily, TinyFish search, and Z.AI search. These adapters call retrieval endpoints without selecting a chat model. The `public` adapter combines results from several public HTTP engines.

Hosted adapters exist for Anthropic, Codex, Gemini, OpenAI, OpenRouter, and xAI. They are admitted only by the current session model's declared `webSearch` capability. Hosted answers without sources or citations are rejected so an ordinary model reply is not presented as a search result.

The former Perplexity search adapter selected Sonar or another consumer model internally and has been removed from OMP's search product. Generic provider transports and historical message formats remain available to the underlying libraries.

X operators are advertised only when the current model supports xAI search. Reading an X URL also uses only that current X-capable model; otherwise the read result explains that an external reader is needed. Credentials for an unrelated xAI account never cause OMP to switch models.

## CLI

`omp q` and `omp web-search` use HTTP engines. `--engine` selects a retrieval endpoint and cannot name a model:

```sh
omp q --engine=duckduckgo "TypeScript release notes"
omp q --engine=public --recency=week "latest TypeScript changes"
omp q 'transformer scaling site:arxiv.org after:2024 -site:reddit.com'
```

Library callers can supply `SearchQueryParams.engine` for the same HTTP selection. The removed `model` parameter is rejected. Callers that already own a session may provide its current model in `runSearchQuery` options for hosted search.

## Cancellation, limits, and errors

Each provider request uses `providers.webSearchTimeoutSeconds` (60 seconds by default, capped at 300). Engine-specific limits can be shorter. Cancellation stops the search rather than advancing to another engine. Ordinary HTTP failures can advance to another available HTTP engine; the output records which engines failed and which served the result.

Source snippets and citation excerpts are capped at 240 characters in the model-facing summary. Full source URLs remain available. Empty responses and unsupported current-model hosted searches surface as errors or recorded fallback failures.

The implementation is in `packages/coding-agent/src/web/search/index.ts`, the transport registry in `provider.ts`, and provider adapters in `providers/`. `web_search.enabled` still controls tool availability.
