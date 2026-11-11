/** Standard Chat strict-mode enforcement and MCP schema preparation. */
import { parseLocalRefPointer } from "@oh-my-pi/omptype";
import * as AIError from "../../error";
import { dereferenceJsonSchema } from "./dereference";
import { upgradeJsonSchemaTo202012 } from "./draft";
import { areJsonValuesEqual } from "./equality";
import { COMBINATOR_KEYS, NON_STRUCTURAL_SCHEMA_KEYS } from "./fields";
import { enter, epochNext, exit, once, stamp } from "./stamps";
import { isJsonObject, isJsonObjectEmpty, type JsonObject } from "./types";

const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"]);
const SCHEMA_VALUE_KEYS = new Set([
	"items",
	"additionalItems",
	"unevaluatedItems",
	"additionalProperties",
	"unevaluatedProperties",
	"not",
	"if",
	"then",
	"else",
	"contains",
	"propertyNames",
	"contentSchema",
]);
const SCHEMA_ARRAY_KEYS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);

/** Upgrade MCP tool schemas without rewriting standard JSON Schema constraints. */
export function normalizeSchemaForMCP(value: unknown): unknown {
	const schema = dereferenceJsonSchema(upgradeJsonSchemaTo202012(value));
	return normalizeMcpNode(schema);
}

function normalizeMcpNode(value: unknown, schemaMap = false): unknown {
	if (!isJsonObject(value)) return value;
	if (!enter(value)) return {};
	try {
		const result: JsonObject = {};
		for (const [key, entry] of Object.entries(value)) {
			if (schemaMap) {
				result[key] = normalizeMcpNode(entry);
			} else if (key === "$schema" || key === "nullable") {
				continue;
			} else if (SCHEMA_MAP_KEYS.has(key)) {
				result[key] = normalizeMcpNode(entry, true);
			} else if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(entry)) {
				result[key] = entry.map(child => normalizeMcpNode(child));
			} else if (SCHEMA_VALUE_KEYS.has(key)) {
				result[key] = normalizeMcpNode(entry);
			} else {
				result[key] = entry;
			}
		}
		return result;
	} finally {
		exit(value);
	}
}

/**
 * Single primitive JSON Schema `type` keyword. Strict mode treats these
 * scalar types as concrete-enough; aggregate shapes (object, array) are not
 * included because they're not derivable from a single `enum`/`const` value.
 */
type StrictPrimitiveType = "null" | "string" | "number" | "boolean";

function primitiveJsonTypeOf(value: unknown): StrictPrimitiveType | undefined {
	if (value === null) return "null";
	switch (typeof value) {
		case "string":
			return "string";
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		default:
			return undefined;
	}
}
function jsonSchemaTypeAcceptsValue(type: string, value: unknown): boolean {
	switch (type) {
		case "null":
			return value === null;
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "array":
			return Array.isArray(value);
		case "object":
			return isJsonObject(value);
		default:
			return true;
	}
}

function narrowEnumToType(schema: Record<string, unknown>, type: string): boolean {
	const enumValues = schema.enum;
	if (!Array.isArray(enumValues)) return true;

	const narrowed = enumValues.filter(value => jsonSchemaTypeAcceptsValue(type, value));
	if (narrowed.length === 0) return false;
	if (narrowed.length !== enumValues.length) schema.enum = narrowed;
	return true;
}

/**
 * Returns the primitive `type` keyword that fully describes the constraint
 * expressed by this node's `enum` (or `const`), or `undefined` when the
 * constraint cannot be reduced to a single primitive type.
 *
 * Strict mode requires every schema node to declare a concrete `type`. When
 * the author wrote `{enum:[...]}` or `{const:X}` without a `type`, we can
 * infer one — but only when every value reduces to the same primitive type.
 * Mixed-primitive enums (`[1, "two", null]`), enums containing non-primitives
 * (`[{a:1}]`), and non-primitive consts (`{a:1}`, `[1,2,3]`) all return
 * undefined: those shapes cannot be described by a single `type` keyword, so
 * strict mode cannot represent them and the caller must fall back.
 */
function inferStrictPrimitiveTypeFromEnumOrConst(node: Record<string, unknown>): StrictPrimitiveType | undefined {
	const values: unknown[] = Array.isArray(node.enum) ? node.enum : Object.hasOwn(node, "const") ? [node.const] : [];
	if (values.length === 0) return undefined;
	let inferred: StrictPrimitiveType | undefined;
	for (const value of values) {
		const t = primitiveJsonTypeOf(value);
		if (t === undefined) return undefined; // non-primitive (object/array) — strict can't represent
		if (inferred === undefined) inferred = t;
		else if (inferred !== t) return undefined; // mixed primitives
	}
	return inferred;
}

/**
 * Per-schema-object memoization key. The result of `tryEnforceStrictSchema`
 * is memoized against the input via `stamp(target, kStrictSchema, …)` so
 * repeated calls (different providers, retries, batching) reuse the same
 * computed pair without re-walking the tree.
 */
const kStrictSchema = Symbol("omp.schema.strict");

/**
 * A boolean schema (`true`/`false`) or the empty object schema `{}`: an
 * unconstrained branch with no declared type. Strict providers (Chat Completions)
 * reject these, and `enforceStrictSchema` would otherwise wave a non-object
 * branch through as `strict: true`, so they disqualify a schema from strict mode
 * wherever they sit in a combinator or `items`/`prefixItems` position.
 */
function isUnrepresentableStrictBranch(value: unknown): boolean {
	return typeof value === "boolean" || (isJsonObject(value) && isJsonObjectEmpty(value));
}

/**
 * Detect schemas that strict mode *cannot* represent.
 *
 * Strict mode requires closed object shapes — every property is declared in
 * `properties` and listed in `required`. That is incompatible with:
 *  - `patternProperties` (open keyset matched by regex),
 *  - `additionalProperties: true` or `additionalProperties: <schema>` (open
 *    keyset with optional further constraint).
 *  - boolean schemas (`true`/`false`) inside `anyOf`/`oneOf`/`allOf`/`items`/
 *    `prefixItems` — strict providers (Chat Completions) reject the unconstrained
 *    branch, and `enforceStrictSchema` would otherwise wave the non-object
 *    branch through as `strict: true` (the `T | undefined` → `anyOf: [<T>, {}]`
 *    → `[<T>, true]` encoding is the canonical offender).
 *
 * This check recurses into every place a child schema may live (properties,
 * items/prefixItems, combinator branches, $defs) so a single offender deep
 * in the tree disqualifies the whole schema. Used to fail-open early in
 * `tryEnforceStrictSchema` rather than throwing during enforcement.
 */
function hasUnrepresentableStrictObjectMap(schema: Record<string, unknown>, epoch: number = epochNext()): boolean {
	if (!once(schema, epoch)) return false;

	let hasPatternProperties = false;
	if (isJsonObject(schema.patternProperties)) {
		for (const _ in schema.patternProperties) {
			hasPatternProperties = true;
			break;
		}
	}
	const additionalPropertiesValue = schema.additionalProperties;
	const hasSchemaAdditionalProperties = additionalPropertiesValue === true || isJsonObject(additionalPropertiesValue);
	if (hasPatternProperties || hasSchemaAdditionalProperties) {
		return true;
	}

	if (isJsonObject(schema.properties)) {
		const properties = schema.properties;
		for (const k in properties) {
			const propertySchema = properties[k];
			if (isUnrepresentableStrictBranch(propertySchema)) return true;
			if (isJsonObject(propertySchema) && hasUnrepresentableStrictObjectMap(propertySchema, epoch)) {
				return true;
			}
		}
	}

	if (isUnrepresentableStrictBranch(schema.items)) {
		return true;
	}
	if (isJsonObject(schema.items)) {
		if (hasUnrepresentableStrictObjectMap(schema.items, epoch)) {
			return true;
		}
	} else if (Array.isArray(schema.items)) {
		for (const itemSchema of schema.items) {
			if (isUnrepresentableStrictBranch(itemSchema)) return true;
			if (isJsonObject(itemSchema) && hasUnrepresentableStrictObjectMap(itemSchema, epoch)) {
				return true;
			}
		}
	}
	if (Array.isArray(schema.prefixItems)) {
		for (const itemSchema of schema.prefixItems) {
			if (isUnrepresentableStrictBranch(itemSchema)) return true;
			if (isJsonObject(itemSchema) && hasUnrepresentableStrictObjectMap(itemSchema, epoch)) {
				return true;
			}
		}
	}

	for (const key of COMBINATOR_KEYS) {
		const variants = schema[key];
		if (!Array.isArray(variants)) continue;
		for (const variant of variants) {
			if (isUnrepresentableStrictBranch(variant)) return true;
			if (isJsonObject(variant) && hasUnrepresentableStrictObjectMap(variant, epoch)) {
				return true;
			}
		}
	}

	for (const defsKey of ["$defs", "definitions"] as const) {
		const defs = schema[defsKey];
		if (!isJsonObject(defs)) continue;
		for (const k in defs) {
			const defSchema = defs[k];
			if (isUnrepresentableStrictBranch(defSchema)) return true;
			if (isJsonObject(defSchema) && hasUnrepresentableStrictObjectMap(defSchema, epoch)) {
				return true;
			}
		}
	}

	return false;
}

/**
 * First pass of strict-mode preparation.
 *
 * Rewrites everything strict mode forbids into something it accepts:
 *  - Drops non-structural keywords (`format`, `pattern`, `examples`, …),
 *    `const`, `nullable`, and `additionalProperties` (re-added by
 *    `enforceStrictSchema` as `false`).
 *  - `type: [a, b]` → `anyOf: [{type: a, …}, {type: b, …}]`, copying only the
 *    keywords each variant can use (e.g. `properties` stays only on the
 *    object variant).
 *  - `const` → single-entry `enum`.
 *  - Description carries a `(default: X)` suffix so the model still sees the
 *    documented default after the keyword is stripped.
 *  - `nullable: true` wraps the whole node in `anyOf:[T,{type:"null"}]`.
 *
 * Recurses into properties, items, prefixItems, combinators, and $defs. The
 * `cache` WeakMap dedupes shared subgraphs; the `epoch` is the cycle guard.
 */
export function sanitizeSchemaForStrictMode(
	schema: Record<string, unknown>,
	epoch: number = epochNext(),
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>> = new WeakMap(),
	root: Record<string, unknown> = schema,
): Record<string, unknown> {
	const cached = cache.get(schema);
	if (cached) return cached;
	if (!once(schema, epoch)) return {};

	// Pre-pass: unravel `$ref` with sibling keys by inlining the resolved def.
	// OpenAI strict mode forbids `{$ref, description, ...}`; the SDK resolves
	// and merges, with sibling keys taking precedence over the ref'd def.
	// Cite: openai-python/src/openai/lib/_pydantic.py:96-110 (`_ensure_strict_json_schema`)
	if (typeof schema.$ref === "string") {
		let hasSibling = false;
		for (const k in schema) {
			if (k !== "$ref" && Object.hasOwn(schema, k)) {
				hasSibling = true;
				break;
			}
		}
		if (hasSibling) {
			const resolved = resolveStrictRef(root, schema.$ref);
			if (resolved !== undefined) {
				// Sibling keys on the schema override keys from the resolved def.
				const merged: Record<string, unknown> = { ...resolved };
				for (const k in schema) {
					if (k === "$ref" || !Object.hasOwn(schema, k)) continue;
					merged[k] = schema[k];
				}
				const result = sanitizeSchemaForStrictMode(merged, epoch, cache, root);
				cache.set(schema, result);
				return result;
			}
		}
	}

	// Pre-pass: collapse single-element `allOf` by inlining its sole entry.
	// SDK semantics: `json_schema.update(ensured(all_of[0]))` — the inlined
	// entry's keys WIN over original sibling keys, then `allOf` is dropped.
	// Cite: openai-python/src/openai/lib/_pydantic.py:79-83
	{
		const allOf = schema.allOf;
		if (Array.isArray(allOf) && allOf.length === 1 && isJsonObject(allOf[0])) {
			const merged: Record<string, unknown> = { ...schema };
			delete merged.allOf;
			const sole = allOf[0] as Record<string, unknown>;
			for (const k in sole) {
				if (Object.hasOwn(sole, k)) merged[k] = sole[k];
			}
			const result = sanitizeSchemaForStrictMode(merged, epoch, cache, root);
			cache.set(schema, result);
			return result;
		}
	}

	const typeValue = schema.type;
	if (Array.isArray(typeValue)) {
		const typeVariants = typeValue.filter((entry): entry is string => typeof entry === "string");
		const schemaWithoutType = { ...schema };
		delete schemaWithoutType.type;

		const sanitizedWithoutType = sanitizeSchemaForStrictMode(schemaWithoutType, epoch, cache, root);
		if (typeVariants.length === 0) {
			cache.set(schema, sanitizedWithoutType);
			return sanitizedWithoutType;
		}
		// Build one variant schema per type. Each variant keeps only the keywords
		// relevant to that type — object-only keywords stay on the object variant,
		// array-only keywords on the array variant, etc.
		//
		// `description` is metadata that applies to the whole union, not to any
		// single type variant, so hoist it to the wrapper so both branches share
		// it without duplication. Matches the optional-property wrap in
		// `enforceStrictSchema` and the typical OpenAI strict-mode "description
		// on the union" shape.
		const { description, ...variantBase } = sanitizedWithoutType;
		const variants: Record<string, unknown>[] = [];
		for (const variantType of typeVariants) {
			const variantSchema: Record<string, unknown> = { ...variantBase, type: variantType };
			if (variantType !== "object") {
				delete variantSchema.properties;
				delete variantSchema.required;
				delete variantSchema.additionalProperties;
			}
			if (variantType !== "array") {
				delete variantSchema.items;
			}
			if (!narrowEnumToType(variantSchema, variantType)) continue;
			variants.push(sanitizeSchemaForStrictMode(variantSchema, epoch, cache, root));
		}

		if (variants.length === 0) {
			cache.set(schema, sanitizedWithoutType);
			return sanitizedWithoutType;
		}

		if (variants.length === 1) {
			const sole = variants[0] as Record<string, unknown>;
			if (description !== undefined && !Object.hasOwn(sole, "description")) {
				sole.description = description;
			}
			cache.set(schema, sole);
			return sole;
		}

		const result: JsonObject = { anyOf: variants };
		if (description !== undefined) result.description = description;
		cache.set(schema, result);
		return result;
	}
	// Scalar `type`: walk the keys, rewriting or stripping per strict-mode rules.

	const sanitized: Record<string, unknown> = {};
	cache.set(schema, sanitized);
	for (const key in schema) {
		const value = schema[key];
		if (key in NON_STRUCTURAL_SCHEMA_KEYS || key === "type" || key === "const" || key === "nullable") {
			continue;
		}
		// `properties` map — recurse into each property schema.

		if (key === "properties" && isJsonObject(value)) {
			const properties: Record<string, unknown> = {};
			for (const propertyName in value) {
				const propertySchema = value[propertyName];
				properties[propertyName] = isJsonObject(propertySchema)
					? sanitizeSchemaForStrictMode(propertySchema, epoch, cache, root)
					: propertySchema;
			}
			sanitized.properties = properties;
			continue;
		}
		// `items` can be schema, tuple-array, or scalar boolean — recurse where applicable.

		if (key === "items") {
			if (isJsonObject(value)) {
				sanitized.items = sanitizeSchemaForStrictMode(value, epoch, cache, root);
			} else if (Array.isArray(value)) {
				sanitized.items = value.map(entry =>
					isJsonObject(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
				);
			} else {
				sanitized.items = value;
			}
			continue;
		}
		// `prefixItems` is always an array of schemas (draft 2020-12).

		if (key === "prefixItems" && Array.isArray(value)) {
			sanitized.prefixItems = value.map(entry =>
				isJsonObject(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
			);
			continue;
		}
		// `anyOf`/`oneOf`/`allOf` arrays — recurse into each branch.

		if (COMBINATOR_KEYS.includes(key as (typeof COMBINATOR_KEYS)[number]) && Array.isArray(value)) {
			sanitized[key] = value.map(entry =>
				isJsonObject(entry) ? sanitizeSchemaForStrictMode(entry, epoch, cache, root) : entry,
			);
			continue;
		}
		// Definition maps — recurse into each named schema.

		if ((key === "$defs" || key === "definitions") && isJsonObject(value)) {
			const defs: Record<string, unknown> = {};
			for (const definitionName in value) {
				const definitionSchema = value[definitionName];
				defs[definitionName] = isJsonObject(definitionSchema)
					? sanitizeSchemaForStrictMode(definitionSchema, epoch, cache, root)
					: definitionSchema;
			}
			sanitized[key] = defs;
			continue;
		}
		// `additionalProperties` is owned by `enforceStrictSchema`, which sets it to false.

		if (key === "additionalProperties") {
			continue;
		}

		if (key === "description" && typeof value === "string" && schema.default !== undefined) {
			// Preserve `default:` info for strict-mode providers that strip the keyword.
			// Inline as `(default: X)` text in the description, matching the convention for
			// runtime-placeholder defaults (e.g. `cwd`) that cannot live in the keyword form.
			const defaultVal = schema.default;
			const formatted = typeof defaultVal === "string" ? defaultVal : JSON.stringify(defaultVal);
			sanitized.description = value.includes("(default:") ? value : `${value} (default: ${formatted})`;
			continue;
		}

		sanitized[key] = value;
	}
	// Post-pass: re-derive `type` and turn dropped keywords into a representable shape.

	if (Object.hasOwn(schema, "const")) {
		const constVal = schema.const;
		const existingEnum = Array.isArray(sanitized.enum) ? sanitized.enum : [];
		if (!existingEnum.some(v => areJsonValuesEqual(v, constVal))) {
			existingEnum.push(constVal);
		}
		sanitized.enum = existingEnum;
	}

	// Preserve the original scalar type after the strip-and-rebuild loop.
	if (typeof typeValue === "string") {
		sanitized.type = typeValue;
	}

	if (sanitized.type === undefined && isJsonObject(sanitized.properties)) {
		sanitized.type = "object";
	}

	if (sanitized.type === undefined && (sanitized.items !== undefined || sanitized.prefixItems !== undefined)) {
		sanitized.type = "array";
	}

	// Last-resort inference: a bare `enum`/`const` with homogeneous primitives gets a `type`.
	if (sanitized.type === undefined) {
		const inferred = inferStrictPrimitiveTypeFromEnumOrConst(sanitized);
		if (inferred !== undefined) sanitized.type = inferred;
	}

	// `nullable: true` was stripped above — re-introduce it as an `anyOf` wrapper.
	// `description` hoists to the wrapper so both branches share it without
	// duplication — matches the optional-property wrap in `enforceStrictSchema`
	// and the typical OpenAI strict-mode "description on the union" shape.
	if (schema.nullable === true) {
		const { nullable: _, description, ...withoutNullable } = sanitized;
		const wrapper: JsonObject = { anyOf: [withoutNullable, { type: "null" }] };
		if (description !== undefined) wrapper.description = description;
		return wrapper;
	}

	return sanitized;
}

/**
 * A node whose only constraining keyword is `anyOf` (annotations like
 * `description` aside). Only such nodes can be merged into an enclosing
 * union without changing semantics: sibling keywords (`type`, `enum`,
 * `properties`, …) apply conjunctively with `anyOf`, so spreading the
 * branches of a non-pure node would drop those constraints.
 */
function isPureAnyOfNode(value: unknown): value is Record<string, unknown> & { anyOf: unknown[] } {
	if (!isJsonObject(value) || !Array.isArray(value.anyOf)) return false;
	for (const key in value) {
		if (key !== "anyOf" && key !== "description") return false;
	}
	return true;
}

/**
 * Recursively enforces JSON Schema constraints required by Chat Completions strict mode:
 *   - `additionalProperties: false` on every object node
 *   - every key in `properties` present in `required`
 *
 * Properties absent from the original `required` array were TypeBox-optional.
 * They are made nullable (`anyOf: [T, { type: "null" }]`) so the model can
 * signal omission by outputting null rather than omitting the key entirely.
 *
 * @throws {Error} When a schema node has no `type`, array-based combinator
 *   (`anyOf`/`allOf`/`oneOf`), object-based combinator (`not`), or `$ref` —
 *   i.e. the node is not representable in strict mode. Prefer
 *   {@link tryEnforceStrictSchema} which catches this and degrades gracefully.
 */
export function enforceStrictSchema(
	schema: Record<string, unknown>,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>> = new WeakMap(),
): Record<string, unknown> {
	if (!enter(schema)) {
		throw new AIError.ValidationError("Schema contains a circular object graph — cannot enforce strict mode");
	}
	try {
		const cached = cache.get(schema);
		if (cached) return cached;
		const result = { ...schema };
		cache.set(schema, result);
		return enforceStrictSchemaBody(schema, result, cache);
	} finally {
		exit(schema);
	}
}

function enforceStrictSchemaBody(
	_schema: Record<string, unknown>,
	result: Record<string, unknown>,
	cache: WeakMap<Record<string, unknown>, Record<string, unknown>>,
): Record<string, unknown> {
	const isObjectType = result.type === "object";
	if (isObjectType) {
		result.additionalProperties = false;
		const propertiesValue = result.properties;
		const props =
			propertiesValue != null && typeof propertiesValue === "object" && !Array.isArray(propertiesValue)
				? (propertiesValue as Record<string, unknown>)
				: {};
		const originalRequired = new Set<string>(
			Array.isArray(result.required)
				? result.required.filter((value): value is string => typeof value === "string")
				: [],
		);
		const strictProperties: Record<string, unknown> = {};
		for (const key in props) {
			const value = props[key];
			const processed =
				value != null && typeof value === "object" && !Array.isArray(value)
					? enforceStrictSchema(value as Record<string, unknown>, cache)
					: value;
			// Optional property — wrap as nullable so strict mode accepts it
			if (!originalRequired.has(key)) {
				// Don't double-wrap if already nullable
				if (
					isJsonObject(processed) &&
					Array.isArray(processed.anyOf) &&
					processed.anyOf.some(v => isJsonObject(v) && v.type === "null")
				) {
					strictProperties[key] = processed;
					continue;
				}
				if (isPureAnyOfNode(processed)) {
					strictProperties[key] = { ...processed, anyOf: [...processed.anyOf, { type: "null" }] };
					continue;
				}
				if (isJsonObject(processed) && typeof processed.description === "string") {
					const { description, ...withoutDescription } = processed;
					strictProperties[key] = { anyOf: [withoutDescription, { type: "null" }], description };
					continue;
				}
				strictProperties[key] = { anyOf: [processed, { type: "null" }] };
				continue;
			}
			strictProperties[key] = processed;
		}
		result.properties = strictProperties;
		result.required = Object.keys(strictProperties);
	}
	if (result.items != null && typeof result.items === "object") {
		if (Array.isArray(result.items)) {
			result.items = result.items.map(entry =>
				entry != null && typeof entry === "object" && !Array.isArray(entry)
					? enforceStrictSchema(entry as Record<string, unknown>, cache)
					: entry,
			);
		} else {
			result.items = enforceStrictSchema(result.items as Record<string, unknown>, cache);
		}
	}
	if (Array.isArray(result.prefixItems)) {
		result.prefixItems = result.prefixItems.map(entry =>
			entry != null && typeof entry === "object" && !Array.isArray(entry)
				? enforceStrictSchema(entry as Record<string, unknown>, cache)
				: entry,
		);
	}
	for (const key of COMBINATOR_KEYS) {
		if (Array.isArray(result[key])) {
			result[key] = (result[key] as unknown[]).map(entry =>
				entry != null && typeof entry === "object" && !Array.isArray(entry)
					? enforceStrictSchema(entry as Record<string, unknown>, cache)
					: entry,
			);
		}
	}
	// Splice nested pure unions into the parent `anyOf`: `(A ∨ B) ∨ C` ≡ `A ∨ B ∨ C`.
	// Some strict-mode validators (e.g. DeepSeek behind OpenRouter) reject anyOf
	// branches that carry no `type`, which is exactly what a nested combinator
	// node looks like (#2270). Branch recursion above already flattened deeper
	// levels bottom-up, so a single pass suffices.
	if (Array.isArray(result.anyOf) && result.anyOf.some(isPureAnyOfNode)) {
		const flattened: unknown[] = [];
		for (const branch of result.anyOf) {
			if (!isPureAnyOfNode(branch)) {
				flattened.push(branch);
				continue;
			}
			flattened.push(...branch.anyOf);
			// Keep the inner annotation when the parent has none.
			if (typeof branch.description === "string" && result.description === undefined) {
				result.description = branch.description;
			}
		}
		result.anyOf = flattened;
	}
	for (const defsKey of ["$defs", "definitions"] as const) {
		if (result[defsKey] != null && typeof result[defsKey] === "object" && !Array.isArray(result[defsKey])) {
			const defs = result[defsKey] as Record<string, unknown>;
			const nextDefs: Record<string, unknown> = {};
			for (const name in defs) {
				const def = defs[name];
				nextDefs[name] =
					def != null && typeof def === "object" && !Array.isArray(def)
						? enforceStrictSchema(def as Record<string, unknown>, cache)
						: def;
			}
			result[defsKey] = nextDefs;
		}
	}
	// Strict mode requires every schema node to declare a concrete type (or
	// combinator / `$ref` / `not`). When `type` is missing, try to infer it
	// from a homogeneous-primitive `enum` / `const` so direct calls to
	// `enforceStrictSchema` (which bypass `sanitizeSchemaForStrictMode`'s own
	// inference pass) still produce wire-valid output.
	if (result.type === undefined) {
		const inferred = inferStrictPrimitiveTypeFromEnumOrConst(result);
		if (inferred !== undefined) result.type = inferred;
	}
	// Schemas like `{}`, `{items: {}}`, mixed-primitive enums, and non-primitive
	// consts are not representable in strict mode — `enum`/`const` are not
	// accepted as type substitutes here because they did not yield a single
	// inferable type above.
	if (
		result.type === undefined &&
		result.$ref === undefined &&
		!COMBINATOR_KEYS.some(key => Array.isArray(result[key])) &&
		!isJsonObject(result.not)
	) {
		throw new AIError.ValidationError("Schema node has no type, combinator, or $ref — cannot enforce strict mode");
	}
	return result;
}

export function tryEnforceStrictSchema(schema: Record<string, unknown>): {
	schema: Record<string, unknown>;
	strict: boolean;
} {
	return stamp(schema, kStrictSchema, s => {
		const upgraded = upgradeJsonSchemaTo202012(s) as Record<string, unknown>;
		if (hasUnrepresentableStrictObjectMap(upgraded)) {
			return { schema: upgraded, strict: false };
		}
		try {
			const sanitized = sanitizeSchemaForStrictMode(upgraded);
			return { schema: enforceStrictSchema(sanitized), strict: true };
		} catch {
			return { schema: upgraded, strict: false };
		}
	});
}

/**
 * Resolve a URI-fragment JSON Pointer against the root schema. Each segment
 * must dereference to a dictionary, as in the OpenAI SDK's `resolve_ref` helper.
 */
function resolveStrictRef(root: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
	const pointer = parseLocalRefPointer(ref);
	if (pointer === undefined || pointer.length === 0) return undefined;
	let cursor: unknown = root;
	for (const segment of pointer) {
		if (!isJsonObject(cursor)) return undefined;
		cursor = cursor[segment];
	}
	return isJsonObject(cursor) ? cursor : undefined;
}
