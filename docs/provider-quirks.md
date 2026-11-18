# Endpoint behavior in OMP Slim

The upstream per-provider policy catalog has been removed. OMP Slim does not
infer a transport, login flow, model capabilities or compatibility rules from
provider names, model names or hostnames.

Use [model configuration](models.md) to declare the endpoint's capabilities and
[Chat Completions wire options](provider-compat-reference.md) for the supported
request differences. [Streaming internals](provider-streaming-internals.md)
describes the shared handling of text, thinking, tools, usage and errors.

A gateway may translate Chat Completions to another backend. That translation
is owned by the gateway; adding another backend does not add a new transport or
vendor rule tree to OMP Slim. Local endpoints are configured in the same way.

When investigating a request failure, check the declared URL, selected model
ID, credentials, custom headers and emitted request fields. Add a regression
for the observable wire behavior before changing shared request handling.
See [endpoint constraints](provider-endpoint-constraints.md) for code ownership.
