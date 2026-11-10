# Model metadata

OMP Slim accepts manually configured OpenAI Chat Completions endpoints. This
package contains the shared model/usage types, model validation, explicit
thinking capabilities, and token-cost calculation. It has no bundled provider
or model roster, provider discovery, protocol conversion, or vendor policy rules.

Use `buildModel({ provider, id, baseUrl, ...metadata })` for a new model. An
omitted `api` defaults to `openai-completions`; another API is rejected. Declare
context limits, thinking efforts, image support and endpoint compatibility
explicitly. Model names never change capabilities or routing.

The `test/fixtures/models.ts` helpers are test-owned metadata. Production code
must not import them or treat them as an available-model catalog.
