import { describe, expect, it } from "bun:test";
import type { Context, Model, TJsonSchema, Tool } from "@oh-my-pi/pi-ai/types";
import {
	enforceStrictSchema,
	mergeCompatibleEnumSchemas,
	normalizeSchemaForCCA,
	normalizeSchemaForFactoryDroid,
	normalizeSchemaForGoogle,
	normalizeSchemaForMCP,
	normalizeSchemaForMoonshot,
	sanitizeSchemaForOpenAIResponses,
	sanitizeSchemaForStrictMode,
	schemaNeedsDraft202012Upgrade,
	stripResidualCombiners,
	tryEnforceStrictSchema,
	upgradeJsonSchemaTo202012,
} from "@oh-my-pi/pi-ai/utils/schema";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// ---------------------------------------------------------------------------
// mergeCompatibleEnumSchemas
// ---------------------------------------------------------------------------

describe("mergeCompatibleEnumSchemas", () => {
	it("deduplicates structurally equal nested enum values and appends novel ones", () => {
		const existing = {
			type: "object",
			enum: [{ kind: "A", payload: { level: 1 } }],
		};
		const incoming = {
			type: "object",
			enum: [
				{ kind: "A", payload: { level: 1 } },
				{ kind: "B", payload: { level: 2 } },
			],
		};

		const merged = mergeCompatibleEnumSchemas(existing, incoming);

		expect(merged).toEqual({
			type: "object",
			enum: [
				{ kind: "A", payload: { level: 1 } },
				{ kind: "B", payload: { level: 2 } },
			],
		});
	});
});

// ---------------------------------------------------------------------------
// sanitizeSchemaForStrictMode
// ---------------------------------------------------------------------------

describe("sanitizeSchemaForStrictMode", () => {
	it("converts nullable keyword to explicit null union", () => {
		const sanitized = sanitizeSchemaForStrictMode({
			type: "string",
			nullable: true,
		});

		expect(sanitized).toEqual({
			anyOf: [{ type: "string" }, { type: "null" }],
		});
	});

	it("hoists description to the wrapper when wrapping `nullable: true` as an anyOf", () => {
		// Sanitize-side nullable wrap mirrors the optional-property wrap shape
		// produced by `enforceStrictSchema`: description lives on the wrapper,
		// branches stay bare. Both top-level entry points share this contract
		// so downstream consumers don't have to special-case which path produced
		// the nullable union.
		const sanitized = sanitizeSchemaForStrictMode({
			type: "string",
			nullable: true,
			description: "label",
		});

		expect(sanitized).toEqual({
			anyOf: [{ type: "string" }, { type: "null" }],
			description: "label",
		});
	});

	it("strips not branches", () => {
		const schema = {
			type: "object",
			not: {
				type: "object",
				properties: { token: { const: "secret" } },
				required: ["token"],
			},
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);

		expect(sanitized.not).toBeUndefined();
	});

	it("merges const into existing enum instead of overwriting", () => {
		const schema = {
			type: "string",
			enum: ["A", "B"],
			const: "C",
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);

		expect(sanitized.enum).toEqual(["A", "B", "C"]);
	});
});

// ---------------------------------------------------------------------------
// upgradeJsonSchemaTo202012
// ---------------------------------------------------------------------------

describe("upgradeJsonSchemaTo202012", () => {
	it("infers draft-07 tuple and dependency keywords without a $schema URI", () => {
		const schema = {
			type: "object",
			properties: {
				definitions: { type: "string" },
				tuple: {
					type: "array",
					items: [{ type: "string" }, { type: "integer" }],
					additionalItems: false,
				},
				gated: {
					type: "object",
					dependencies: {
						a: ["b"],
						c: { required: ["d"] },
					},
				},
			},
			definitions: {
				Ref: { type: "string" },
			},
		};

		expect(schemaNeedsDraft202012Upgrade(schema)).toBe(true);
		expect(upgradeJsonSchemaTo202012(schema)).toEqual({
			type: "object",
			properties: {
				definitions: { type: "string" },
				tuple: {
					type: "array",
					prefixItems: [{ type: "string" }, { type: "integer" }],
					items: false,
				},
				gated: {
					type: "object",
					dependentRequired: { a: ["b"] },
					dependentSchemas: { c: { required: ["d"] } },
				},
			},
			$defs: {
				Ref: { type: "string" },
			},
		});
	});

	it("returns unchanged schemas by identity when no draft upgrade is needed", () => {
		const schema = { type: "object", properties: { name: { type: "string" } } };

		expect(schemaNeedsDraft202012Upgrade(schema)).toBe(false);
		expect(upgradeJsonSchemaTo202012(schema)).toBe(schema);
	});
});

// ---------------------------------------------------------------------------
// normalizeSchemaForGoogle
// ---------------------------------------------------------------------------

describe("normalizeSchemaForMCP", () => {
	it("keeps validation keywords without mutating description", () => {
		const normalized = normalizeSchemaForMCP({
			type: "string",
			pattern: "^\\d+$",
			minLength: 1,
			description: "ID",
		}) as Record<string, unknown>;

		expect(normalized).toEqual({
			type: "string",
			pattern: "^\\d+$",
			minLength: 1,
			description: "ID",
		});
	});

	it("leaves a genuine JSON Schema that happens to have a `def` property alone", () => {
		// `def` is not a JSON Schema keyword, so normalization must not corrupt
		// schemas that use it as an ordinary property name.
		const schema = {
			type: "object",
			properties: { def: { type: "string" } },
			required: ["def"],
		};
		expect(normalizeSchemaForMCP(schema)).toEqual(schema);
	});
});

// ---------------------------------------------------------------------------
// sanitizeSchemaForOpenAIResponses
// ---------------------------------------------------------------------------

describe("enforceStrictSchema and tryEnforceStrictSchema", () => {
	it("keeps strict mode enabled for an enum-only root schema by inferring a concrete type", () => {
		const result = tryEnforceStrictSchema({
			enum: ["draft", "published"],
		});

		expect(result.strict).toBe(true);
		expect(result.schema).toEqual({
			type: "string",
			enum: ["draft", "published"],
		});
	});

	it("keeps strict mode enabled for a const-only root schema by inferring a concrete type", () => {
		const result = tryEnforceStrictSchema({ const: 7 });

		expect(result.strict).toBe(true);
		expect(result.schema).toEqual({
			type: "number",
			enum: [7],
		});
	});

	it("infers array type when items is present without an explicit type", () => {
		const result = tryEnforceStrictSchema({
			items: { type: "string" },
		});

		expect(result.strict).toBe(true);
		expect(result.schema).toEqual({
			type: "array",
			items: { type: "string" },
		});
	});

	it("recurses into $defs and definitions when enforcing strict rules", () => {
		const schema = {
			type: "object",
			properties: {
				payload: { $ref: "#/$defs/Payload" },
				legacy: { $ref: "#/definitions/Legacy" },
			},
			required: ["payload", "legacy"],
			$defs: {
				Payload: {
					type: "object",
					properties: { value: { type: "string" } },
					required: [],
				},
			},
			definitions: {
				Legacy: {
					type: "object",
					properties: { count: { type: "number" } },
					required: [],
				},
			},
		} as Record<string, unknown>;

		const strict = enforceStrictSchema(schema);
		const defs = strict.$defs as Record<string, Record<string, unknown>>;
		const definitions = strict.definitions as Record<string, Record<string, unknown>>;

		expect(defs.Payload.additionalProperties).toBe(false);
		expect(definitions.Legacy.additionalProperties).toBe(false);
		expect(defs.Payload.required).toEqual(["value"]);
		expect(definitions.Legacy.required).toEqual(["count"]);
	});

	it("enforces strict object constraints inside tuple items", () => {
		const schema = {
			type: "array",
			prefixItems: [
				{ type: "string" },
				{
					type: "object",
					properties: {
						id: { type: "string" },
						nickname: { type: "string" },
					},
					required: ["id"],
				},
			],
		} as Record<string, unknown>;

		const result = tryEnforceStrictSchema(schema);
		const tupleItems = result.schema.prefixItems as Array<Record<string, unknown>>;
		const tupleObjectItem = tupleItems[1] as Record<string, unknown>;
		const tupleProperties = tupleObjectItem.properties as Record<string, Record<string, unknown>>;

		expect(result.strict).toBe(true);
		expect(tupleObjectItem.additionalProperties).toBe(false);
		expect(tupleObjectItem.required).toEqual(["id", "nickname"]);
		expect(tupleProperties.nickname).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
	});
});

// ---------------------------------------------------------------------------
// stripResidualCombiners
// ---------------------------------------------------------------------------

describe("stripResidualCombiners", () => {
	it("collapses identical anyOf variants to the underlying type", () => {
		const stripped = stripResidualCombiners({
			anyOf: [
				{ type: "string", minLength: 1 },
				{ type: "string", minLength: 1 },
			],
			oneOf: [
				{ type: "string", pattern: "^a" },
				{ type: "string", pattern: "^a" },
			],
		}) as Record<string, unknown>;

		expect(stripped.type).toBe("string");
		expect(stripped.anyOf).toBeUndefined();
		expect(stripped.oneOf).toBeUndefined();
		expect(stripped.minLength).toBe(1);
		expect(stripped.pattern).toBe("^a");
	});

	it("strips residual combiners to a fixpoint at the same node", () => {
		const normalized = stripResidualCombiners({
			anyOf: [
				{ type: "string", description: "A" },
				{ type: "string", description: "B" },
			],
			oneOf: [{ type: "number" }, { type: "number" }],
		}) as Record<string, unknown>;

		expect(normalized.anyOf).toBeUndefined();
		expect(normalized.oneOf).toBeUndefined();
	});

	it("drops array-only keys when mixed-type collapse picks string from anyOf fixpoint", () => {
		const stripped = stripResidualCombiners({
			anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
			description: "pr number, url, or branch",
		}) as Record<string, unknown>;

		expect(stripped.type).toBe("string");
		expect(stripped.items).toBeUndefined();
		expect(stripped.anyOf).toBeUndefined();
		expect(stripped.description).toBe("pr number, url, or branch");
	});
});

// ---------------------------------------------------------------------------
// normalizeSchemaForCCA
// ---------------------------------------------------------------------------

describe("circular schema safety", () => {
	it("terminates on a self-referential object with a bounded result from either sanitizer", () => {
		const circular: Record<string, unknown> = {
			type: "object",
			properties: {},
		};
		(circular.properties as Record<string, unknown>).self = circular;

		// Google normalization breaks the back-edge with an empty schema.
		expect(normalizeSchemaForGoogle(circular)).toEqual({ type: "object", properties: { self: {} } });

		// Strict-mode sanitization rebuilds the cycle on the sanitized copy rather than recursing forever.
		const strict = sanitizeSchemaForStrictMode(circular) as { properties: { self: unknown } };
		expect(strict).not.toBe(circular);
		expect(strict.properties.self).toBe(strict);
	});
});

// ---------------------------------------------------------------------------
// DAG-shared subtrees and frozen inputs (normalizeSchemaNode enter/exit)
// ---------------------------------------------------------------------------

describe("DAG-shared subtree normalization", () => {
	it("normalizes a subschema object reused across two properties instead of blanking the second occurrence", () => {
		const shared = { type: "string", description: "shared leaf" };
		const schema = {
			type: "object",
			properties: { a: shared, b: shared },
		};

		const result = normalizeSchemaForGoogle(schema) as {
			properties: { a: Record<string, unknown>; b: Record<string, unknown> };
		};
		expect(result.properties.a).toEqual({ type: "string", description: "shared leaf" });
		expect(result.properties.b).toEqual({ type: "string", description: "shared leaf" });
	});

	it("does not throw on a frozen input schema", () => {
		const shared = Object.freeze({ type: "number" });
		const schema = Object.freeze({
			type: "object",
			properties: Object.freeze({ x: shared, y: shared }),
		});

		const result = normalizeSchemaForGoogle(schema) as {
			properties: { x: Record<string, unknown>; y: Record<string, unknown> };
		};
		expect(result.properties.x).toEqual({ type: "number" });
		expect(result.properties.y).toEqual({ type: "number" });
	});
});

// ---------------------------------------------------------------------------
// normalizeSchemaForMoonshot (Moonshot Flavored JSON Schema)
// ---------------------------------------------------------------------------

const MFJS_FORBIDDEN_KEYWORDS = new Set([
	"const",
	"oneOf",
	"allOf",
	"nullable",
	"prefixItems",
	"minItems",
	"maxItems",
	"minLength",
	"maxLength",
	"pattern",
	"format",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"uniqueItems",
	"title",
	"$schema",
	"$comment",
]);

/** Walk schema-keyword positions only and fail on any keyword MFJS rejects. */
function assertMfjsValid(node: unknown, path = "$"): void {
	if (Array.isArray(node)) {
		for (const [i, entry] of node.entries()) assertMfjsValid(entry, `${path}[${i}]`);
		return;
	}
	if (typeof node === "boolean") throw new Error(`MFJS requires an object schema at ${path}`);
	if (typeof node !== "object" || node === null) return;
	const obj = node as Record<string, unknown>;
	for (const key of Object.keys(obj)) {
		if (MFJS_FORBIDDEN_KEYWORDS.has(key)) throw new Error(`MFJS-forbidden keyword '${key}' at ${path}`);
	}
	if ("type" in obj && typeof obj.type !== "string") {
		throw new Error(`MFJS requires a scalar string 'type' at ${path}, got ${JSON.stringify(obj.type)}`);
	}
	if (Array.isArray(obj.enum)) {
		for (const value of obj.enum) {
			if (typeof value !== "string" && typeof value !== "number") {
				throw new Error(`MFJS enum admits only string/number at ${path}, got ${JSON.stringify(value)}`);
			}
		}
	}
	const props = obj.properties;
	if (props && typeof props === "object" && !Array.isArray(props)) {
		for (const [key, value] of Object.entries(props)) assertMfjsValid(value, `${path}.properties.${key}`);
	}
	if (Array.isArray(obj.anyOf)) {
		for (const [i, entry] of obj.anyOf.entries()) assertMfjsValid(entry, `${path}.anyOf[${i}]`);
	}
	if (obj.items !== undefined) assertMfjsValid(obj.items, `${path}.items`);
	if (obj.additionalProperties && typeof obj.additionalProperties === "object") {
		assertMfjsValid(obj.additionalProperties, `${path}.additionalProperties`);
	}
}
