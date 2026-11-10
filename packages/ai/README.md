# Chat Completions client

This downstream package sends standard OpenAI Chat Completions requests to an
explicitly configured endpoint. The only supported API identifier is
`openai-completions`. Other identifiers can occur in historical transcripts,
but active requests reject them before any network call.

```ts
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { completeSimple } from "@oh-my-pi/pi-ai";

const model = buildModel({
  provider: "my-gateway",
  id: "my-model",
  baseUrl: "https://gateway.example/v1",
  input: ["text", "image"],
  contextWindow: 128000,
  maxTokens: 8192,
});
const response = await completeSimple(model, {
  messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
}, { apiKey: process.env.MY_GATEWAY_API_KEY });
```

Requests go to `baseUrl + /chat/completions` and preserve the configured model
ID. No provider catalog, model-name inference, OAuth login, local authentication
broker, protocol translation gateway, or alternative protocol is included.
Configure any upstream protocol conversion in your gateway.

The client supports SSE and JSON responses, JSON-schema function tools, tool
results, text and image inputs, token/cost accounting, dynamic model headers,
per-request headers, API-key resolvers, cancellation, bounded HTTP retries,
request diagnostics and concurrency limits. `streamOpenAICompletions` accepts
`stream: false` for a JSON response. Chat-only judgment helpers use the same
configured model and transport.

Optional `model.compat` fields describe explicit endpoint capabilities:
`supportsDeveloperRole`, `supportsUsageInStreaming`, `supportsStrictMode`,
`maxTokensField` (`max_completion_tokens` or `max_tokens`), and `supportsStore`.
They are never inferred from a provider or model name. Native hosted tools,
Responses state, vendor thinking signatures, protobuf tool bridges, image/audio/
video generation, embedding and reranking APIs are removed.

`AuthStorage` persists API-key credentials in SQLite. The `credentials` namespace
provides CRUD/reload/change notifications, and `keys` resolves runtime overrides,
configuration, a normalized `<PROVIDER>_API_KEY` environment variable, then stored
keys. A host can install its own configuration value resolver. Legacy OAuth rows
are ignored, and new OAuth credentials are rejected. Storage does not rotate
accounts or refresh tokens.

`providers/mock` is a Bun-test-only fixture. It imports `bun:test` and intercepts
exported streaming functions when explicitly registered by a test. Production
stream dispatch has no mock or custom-protocol registry dependency.
