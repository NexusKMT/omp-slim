/** Derives per-label output-schema section shapes for incremental yield assembly. */
import { dereferenceJsonSchema } from "@oh-my-pi/pi-ai/utils/schema";
import type { YieldSectionShapes } from "@oh-my-pi/pi-tui/tools/task-yield-assembly";
import { isRecord } from "@oh-my-pi/pi-utils";
import { buildOutputValidator } from "../tools/output-schema-validator";

/** True when `value` is a JSON-schema node whose instances are arrays. */
function isArrayTypedSchema(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (record.type === "array") return true;
	if (Array.isArray(record.type) && record.type.includes("array")) return true;
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		const variants = record[key];
		if (Array.isArray(variants) && variants.some(isArrayTypedSchema)) return true;
	}
	return false;
}

/**
 * Shape of every top-level output-schema property, for `assembleYieldResult`.
 *
 * Array-declared properties (JTD `elements` → JSON `type: "array"`) accumulate
 * into a list even when the agent emits exactly one section — otherwise a single
 * `type: ["findings"]` yield would assemble as a bare object and fail array-typed
 * validation. Every other declared property is scalar: a repeated yield (e.g. a
 * revised `explanation` after async jobs settle) replaces the earlier value
 * instead of assembling an array the schema rejects.
 */
export function yieldSectionShapes(outputSchema: unknown): YieldSectionShapes {
	const shapes = new Map<string, "array" | "scalar">();
	// Use the JTD-converted JSON Schema (matches what validation runs against):
	// JTD `optionalProperties.findings.elements` becomes `properties.findings`
	// with `type: "array"`, which raw `normalizeSchema` would not expose.
	const { jsonSchema } = buildOutputValidator(outputSchema);
	if (jsonSchema === undefined) return shapes;
	const dereferenced = dereferenceJsonSchema(jsonSchema);
	const labelSchema = isRecord(dereferenced) ? dereferenced : jsonSchema;
	const properties = labelSchema.properties;
	if (!isRecord(properties)) return shapes;
	for (const key in properties) {
		shapes.set(key, isArrayTypedSchema(properties[key]) ? "array" : "scalar");
	}
	return shapes;
}
