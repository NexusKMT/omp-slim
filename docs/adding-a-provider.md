# Adding an endpoint to OMP Slim

Configure a provider name, `baseUrl`, authentication and explicit model IDs in
`models.yml`, following [model configuration](models.md). Compatible endpoints
use the existing `openai-completions` transport; no vendor-specific catalog
entry or generator is required.

Extension-supplied manual providers pass through the same
[`validateProviderConfiguration`](../packages/coding-agent/src/config/models-config.ts)
contract. They need a valid HTTP(S) endpoint and at least one model ID. Declare
capabilities and wire compatibility explicitly rather than inferring them from
the provider or model name.

There is no KDL rule tree, bundled provider discovery, `gen:compat`, or
`gen:models` command in this downstream. Subscription authentication and other
wire protocols were removed. A change to the shared transport should include a
focused request/response regression test under `packages/ai/test`, and schema
changes should be checked against both YAML and extension registration.
