/**
 * Non-structural schema keys stripped during OpenAI strict mode sanitization.
 * These are decorative/validation-only keywords that don't affect the structural
 * shape OpenAI's strict mode enforces.
 */
export const NON_STRUCTURAL_SCHEMA_KEYS: Record<string, true> = {
	format: true,
	pattern: true,
	minLength: true,
	maxLength: true,
	minimum: true,
	maximum: true,
	exclusiveMinimum: true,
	exclusiveMaximum: true,
	minItems: true,
	maxItems: true,
	uniqueItems: true,
	multipleOf: true,
	$schema: true,
	examples: true,
	default: true,
	title: true,
	$comment: true,
	if: true,
	// oxlint-disable-next-line unicorn/no-thenable -- JSON Schema keyword
	then: true,
	else: true,
	not: true,
	unevaluatedProperties: true,
	unevaluatedItems: true,
	patternProperties: true,
	propertyNames: true,
	contains: true,
	minContains: true,
	maxContains: true,
	dependentRequired: true,
	dependentSchemas: true,
	contentEncoding: true,
	contentMediaType: true,
	contentSchema: true,
	deprecated: true,
	readOnly: true,
	writeOnly: true,
	minProperties: true,
	maxProperties: true,
	$dynamicRef: true,
	$dynamicAnchor: true,
};

/** JSON Schema combinator keywords. */
export const COMBINATOR_KEYS = ["anyOf", "allOf", "oneOf"] as const;
