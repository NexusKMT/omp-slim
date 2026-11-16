# Endpoints in OMP Slim

OMP Slim sends model requests through `openai-completions`. Each provider name
identifies an endpoint declared in `models.yml`; the name does not select a
vendor integration, authentication flow, or inferred model capabilities.

Follow [model configuration](models.md) to set `baseUrl`, credentials, model IDs,
input capabilities, limits, thinking efforts and the supported `compat` fields.
Select the main model with `omp --model my-endpoint/my-model` or `/model`.
Planning, subagents, compaction, advisors and helper requests share that selection.

For endpoints that require a key, configure `apiKey` using the supported value
resolution in the model configuration. Use `auth: none` for an endpoint that
requires no credentials. Custom headers belong in the provider/model settings.
The runtime resolves dynamic headers for each request.

There is no built-in vendor catalog, subscription login, automatic local-engine
discovery, provider quota dashboard, or alternate-model routing. A local server
can be used by explicitly declaring its Chat Completions endpoint and models.

The implementation boundaries are documented in
[endpoint constraints](provider-endpoint-constraints.md),
[wire options](provider-compat-reference.md), and
[streaming internals](provider-streaming-internals.md).
