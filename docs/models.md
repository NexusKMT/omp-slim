# Model configuration in OMP Slim

OMP Slim uses explicitly configured Chat Completions endpoints. There is no
bundled vendor catalog, provider discovery, KDL compatibility tree, subscription
login, or automatic alternate-model routing.

## Configure an endpoint

The default profile reads `~/.omp/agent/models.yml` or `models.yaml`. Named
profiles and `PI_CODING_AGENT_DIR` use their corresponding agent directory.
Declare at least one model for each provider:

```yaml
providers:
  my-endpoint:
    baseUrl: https://gateway.example.com/v1
    api: openai-completions
    apiKey: MY_ENDPOINT_API_KEY
    models:
      - id: my-model
        name: My chat model
        input: [text, image]
        contextWindow: 128000
        maxTokens: 8192
```

Set `MY_ENDPOINT_API_KEY` in the process environment. For an endpoint that
requires no credentials, use `auth: none` and omit `apiKey`. A provider name is a
local configuration identifier, not a subscription or vendor integration.
`baseUrl` must be an absolute HTTP(S) URL. The only accepted `api` value is
`openai-completions`, which is also the default when omitted.

Provider entries accept `apiKey`, `auth`, `authHeader`, `headers`, `compat`, and
an explicit `models` array. Unknown provider/model fields and retired protocol
names are rejected. Models require an `id`; duplicate IDs within a provider
are rejected.

## Capabilities and wire options

Configure the capabilities the endpoint actually supports; model names never
infer transport, thinking, image support, pricing, or limits. Model overrides
include `name`, `baseUrl`, `headers`, `input`, `supportsTools`, `contextWindow`,
`maxContextWindow`, `maxTokens`, `omitMaxOutputTokens`, `cost`, `promptCache`,
`imageCountBudget`, `imageInputDecoder`, and `tokenizer`. `kind`, if supplied,
must be `chat`. Missing input metadata defaults to text; missing prices display
as unknown rather than asserting that requests are free.

The retained `compat` fields are:

- `supportsStore`
- `supportsDeveloperRole`
- `supportsUsageInStreaming`
- `supportsStrictMode`
- `maxTokensField`: `max_tokens` or `max_completion_tokens`

Thinking metadata uses `mode: effort`, a nonempty `efforts` list, and optional
`defaultLevel`, `requiresEffort`, and `effortMap`. Supported efforts are
`minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; the default must occur in
the configured list. Keep those declarations consistent with the endpoint.

The precise accepted shape is defined in
[`models-config-schema-bundle.ts`](../packages/coding-agent/src/config/models-config-schema-bundle.ts).
Endpoint validation is shared with extension-supplied manual providers in
[`models-config.ts`](../packages/coding-agent/src/config/models-config.ts), and
model materialization lives in [`build.ts`](../packages/catalog/src/build.ts).

## Select the main model

```sh
omp --model my-endpoint/my-model
```

Use `/model` to change the main selection interactively, or set
`model: my-endpoint/my-model` in settings. Planning, subagents, compaction,
advisors and helper requests use that main model. An unavailable saved model
reports an error; explicitly choosing another model remains possible.

Retries retain the selected model. Model roles, provider-specific protocol
routing, predictive models, fallback chains and automatic model promotion are
removed. See [single-model behavior](slim-single-model.md) for inheritance and
session-history details. Older reports in that document record historical
builds; current source and native validation are tracked in [SLIM.md](../SLIM.md).
