# Chat Completions wire options

OMP Slim reads endpoint behavior from explicit model metadata. `buildModel` in
[`packages/catalog/src/build.ts`](../packages/catalog/src/build.ts) validates
that metadata without classifying vendor or model names. Provider configuration
and model overrides are described in [models.md](models.md).

The retained `compat` options are consumed by
[`openai-completions.ts`](../packages/ai/src/providers/openai-completions.ts):

| Option | Request behavior |
| --- | --- |
| `supportsDeveloperRole` | Explicit `true` preserves developer messages; otherwise they are sent as system messages. |
| `supportsUsageInStreaming` | Unless explicitly `false`, streaming requests ask for usage with `stream_options.include_usage`. |
| `supportsStrictMode` | Explicit `false` disables strict function-tool serialization. Otherwise a tool's own `strict: true` requests strict adaptation when its schema is representable. |
| `supportsStore` | Explicit `true` sends `store: false`; otherwise the field is omitted. |
| `maxTokensField` | Chooses `max_tokens` or `max_completion_tokens`; the default is `max_completion_tokens`. |

Thinking is declared with `mode: effort`, a supported nonempty `efforts` list,
and optional `defaultLevel`, `requiresEffort`, and `effortMap`. The selected
request effort is sent as `reasoning_effort`. A request that explicitly disables
reasoning sends `none`. Model metadata defines which efforts the UI offers.

Function tools use standard Chat Completions `tools` and `tool_choice` fields.
Provider-native tools are rejected. Tool arguments are validated locally even
when the request uses strict schemas; see [schema preparation](ai-schema-normalize.md).

There is no KDL policy cascade, vendor-name inference, alternate protocol,
forced-tool emulation for another API, or automatic switch to another model.
Gateway-specific protocol translation belongs at the configured endpoint.
