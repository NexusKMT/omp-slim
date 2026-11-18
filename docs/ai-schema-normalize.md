# Function-tool schema preparation

OMP Slim sends standard Chat Completions function tools. Schema preparation and
local validation live in
[`packages/ai/src/utils/schema`](../packages/ai/src/utils/schema).

`toolWireSchema` resolves ArkType-compatible parameters or plain JSON Schema
into a cached wire schema. Conversion upgrades older draft keywords and avoids
mutating the application schema. Schema walkers distinguish schema positions
from instance data such as defaults, enum members, examples and const values.

`adaptSchemaForStrict` upgrades draft-07 inputs to draft 2020-12 and attempts
strict adaptation only when requested. Representable objects are closed and
optional properties become nullable. Open maps or unconstrained branches fall
back to non-strict serialization without discarding their original constraints.
The tool's strict flag and the endpoint's `supportsStrictMode` setting decide
whether the transport requests this adaptation.

`normalizeSchemaForMCP` upgrades draft keywords, resolves local references and
removes the schema declaration and legacy nullable annotation for local
validation. Cycles are bounded and shared subtrees remain supported.

Local argument validation is authoritative. Keep wire schemas and runtime
validation consistent when changing required fields, nullable values or unions.
Retained tests cover input immutability, optional/null arguments, JSON Schema
validation, circular references and shared or frozen objects.

The schema layer has no vendor-specific lowering for retired model protocols.
See the [constraints note](../packages/ai/src/utils/schema/CONSTRAINTS.md),
[wire options](provider-compat-reference.md), and
[streaming internals](provider-streaming-internals.md).
