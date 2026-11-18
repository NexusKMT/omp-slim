# Chat Completions streaming internals

The public `stream`, `streamSimple`, `complete`, and `completeSimple` APIs live
in [`packages/ai/src/stream.ts`](../packages/ai/src/stream.ts). They retain request
coordination, credential resolution, cancellation and shared error handling.
Only `openai-completions` reaches a model transport; other API values fail.

[`openai-completions.ts`](../packages/ai/src/providers/openai-completions.ts)
converts conversation messages and function tools, builds the request body,
and normalizes streamed chunks into `AssistantMessageEvent` values. The request
uses the selected model ID and explicit endpoint configuration. Model and
dynamic headers are resolved before request-level overrides are applied.
The transport restores the selected model ID after an `onPayload` hook.

HTTP requests and SSE decoding use
[`openai-http.ts`](../packages/ai/src/utils/openai-http.ts). The transport also
accepts a standard JSON completion when `stream: false` is requested. First-event
and idle timeouts share cancellation handling; a bounded terminal grace period
allows final usage chunks to arrive after the content has finished.

Text, thinking and function-call deltas accumulate into the final assistant
message. Reasoning aliases are normalized without emitting duplicate thinking
when several aliases occur in one chunk. Saved reasoning-source signatures let
subsequent requests replay applicable reasoning content. Interrupted messages
must not replay incomplete thinking as a completed assistant turn.

Tool argument deltas are parsed incrementally. Provider-native tools are not
accepted. The application validates final arguments before execution; strict
request schemas do not replace that validation. See
[schema preparation](ai-schema-normalize.md).

Usage records track input, output, cache-read and reported reasoning tokens.
Declared model prices determine cost accounting. In-band and HTTP errors use
the shared AI error representation, and cancellation remains distinguishable
from a completed response.

The former Responses, Codex, Anthropic, Gemini, local Foundation Models and
vendor-specific streaming implementations are removed. Their stateful replay,
websocket ownership and protocol-specific recovery rules are not part of this
runtime. Gateway translation belongs behind the declared Chat Completions URL.
