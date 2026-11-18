# Endpoint constraints in OMP Slim

All model endpoints use the same Chat Completions transport. The declared
`baseUrl`, model ID, credentials, headers and capability metadata determine a
request; provider names do not select hidden rules.

Keep changes at the layer that owns them:

| Concern | Owner |
| --- | --- |
| Accepted configuration fields and retired-field rejection | [`models-config-schema-bundle.ts`](../packages/coding-agent/src/config/models-config-schema-bundle.ts) and [`models-config.ts`](../packages/coding-agent/src/config/models-config.ts) |
| Model validation, limits and declared capabilities | [`catalog/src/build.ts`](../packages/catalog/src/build.ts) |
| API keys and request headers | [`config/model-registry.ts`](../packages/coding-agent/src/config/model-registry.ts) |
| Standard request fields and stream events | [`providers/openai-completions.ts`](../packages/ai/src/providers/openai-completions.ts) |
| HTTP and SSE mechanics | [`utils/openai-http.ts`](../packages/ai/src/utils/openai-http.ts) |
| Function-tool schema conversion and local validation | [`utils/schema`](../packages/ai/src/utils/schema) |

Add configuration only for a concrete capability that callers can declare and
test. Preserve explicit false values and model overrides. Do not add vendor
name checks, remote model catalogs, alternate protocol dispatch or automatic
model fallback.

Payload hooks can edit request content, but the transport restores the selected
model ID before sending. Retry and cancellation changes must preserve the
session's visible output and tool execution boundaries.

See [models](models.md), [wire options](provider-compat-reference.md), and
[streaming internals](provider-streaming-internals.md) for the current contract.
