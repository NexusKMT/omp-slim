# Tool schema constraints

Model requests use only standard Chat Completions function tools. The gateway owns any translation to another provider protocol.

`toolWireSchema` resolves the application schema without mutating its memoized input. `adaptSchemaForStrict` upgrades draft-07 schema keywords and, when explicitly enabled, prepares closed objects with required properties for strict function tools. Optional properties become nullable. Schemas with open maps or unconstrained branches fall back to non-strict mode without losing their original constraints. Local tool argument validation remains authoritative.

`normalizeSchemaForMCP` upgrades draft keywords, resolves local references, and removes the schema declaration and legacy nullable annotation for local validation. It traverses only schema positions: property names and instance data such as defaults, enum members, examples and const values remain unchanged. Cycles are bounded and shared subtrees remain intact.

Tests cover strict enforcement, optional/null tool arguments, JSON Schema validation, input immutability, circular references and shared/frozen schema objects.
