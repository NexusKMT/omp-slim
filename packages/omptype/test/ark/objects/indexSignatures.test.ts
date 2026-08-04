import { expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("string index", () => {
	const O = type({ "[string]": "string" });
	const _type1: Eq<typeof O.infer, { [x: string]: string }> = true;
	expect(O.json).toEqual({
		domain: "object",
		index: [{ signature: "string", value: "string" }],
	});

	expect(O({})).toEqual({});
	expect(O({ a: "a", b: "b" })).toEqual({ a: "a", b: "b" });

	const validWithSymbol = { a: "a", [Symbol()]: null };
	expect(validWithSymbol).toEqual(validWithSymbol);

	expect(O({ a: 1 }).toString()).toBe("a must be a string (was a number)");
	expect(O({ a: true, b: false }).toString()).toBe(`a must be a string (was boolean)
b must be a string (was boolean)`);
});

it("symbol index", () => {
	const O = type({ "[symbol]": "1" });
	const _type8: Eq<typeof O.infer, { [x: symbol]: 1 }> = true;
	expect(O.json).toEqual({
		domain: "object",
		index: [{ signature: "symbol", value: { unit: 1 } }],
	});

	expect(O({})).toEqual({});

	expect(O({ a: 999 })).toEqual({ a: 999 });

	const zildjian = Symbol();
	const zildjianName = String(zildjian);

	// I've been dope, suspenseful with a pencil
	// Ever since...
	const prince = Symbol();
	const princeName = String(prince);

	expect(O({ [zildjian]: 1, [prince]: 1 })).toEqual({
		[zildjian]: 1,
		[prince]: 1,
	});

	expect({ a: 0, [zildjian]: 1 }).toEqual({ a: 0, [zildjian]: 1 });

	expect(O({ [zildjian]: 0 }).toString()).toEqual(`value at [${zildjianName}] must be 1 (was 0)`);
	expect(O({ [prince]: null, [zildjian]: undefined }).toString()).toBe(`value at [${princeName}] must be 1 (was null)
value at [${zildjianName}] must be 1 (was undefined)`);
});

it("enumerable indexed union", () => {
	const O = type({ "['foo' | 'bar']": "string" });
	const Expected = type({ foo: "string", bar: "string" });
	const _type16: Eq<typeof O, typeof Expected> = true;
	expect(O.json).toEqual(Expected.json);
});

it("non-enumerable indexed union", () => {
	const O = type({ "[string | symbol]": "string" });
	const _type18: Eq<typeof O.infer, { [x: string]: string; [x: symbol]: string }> = true;
	expect(O.json).toEqual({
		domain: "object",
		index: [{ signature: ["string", "symbol"], value: "string" }],
	});
});

it("multiple indexed", () => {
	const O = type({
		"[string]": "string",
		"[symbol]": "number",
	});
	const _type20: Eq<typeof O.infer, { [x: string]: string; [x: symbol]: number }> = true;
	expect(O.json).toEqual({
		index: [
			{ value: "string", signature: "string" },
			{ value: "number", signature: "symbol" },
		],
		domain: "object",
	});

	expect(O({})).toEqual({});
	expect(O({ foo: "f" })).toEqual({ foo: "f" });

	const sym = Symbol();

	const symName = String(sym);

	const validWithStringsAndSymbols = {
		str: "string",
		[sym]: 8675309,
	};

	expect(O(validWithStringsAndSymbols)).toEqual(validWithStringsAndSymbols);

	expect(
		O({
			str: 100,
			[sym]: "💯",
		}).toString(),
	).toEqual(`str must be a string (was a number)
value at [${symName}] must be a number (was a string)`);
});

it("all key kinds", () => {
	const O = type({
		"[string]": "string",
		required: "'foo'",
		"optional?": "'bar'",
	});
	const _type26: Eq<typeof O.infer, { [x: string]: string; required: "foo"; optional?: "bar" }> = true;
	expect(O.json).toEqual({
		domain: "object",
		required: [{ key: "required", value: { unit: "foo" } }],
		optional: [{ key: "optional", value: { unit: "bar" } }],
		index: [{ signature: "string", value: "string" }],
	});

	const valid: typeof O.infer = { required: "foo", other: "bar" };
	expect(O(valid)).toEqual(valid);
	expect(
		O({
			optional: "wrongString",
			other: 0n,
		}).toString(),
	).toBe(`required must be "foo" (was missing)
optional must be "bar" (was "wrongString")
other must be a string (was a bigint)`);
});

it("index key from scope", () => {
	const types = scope({
		key: "symbol|'foo'|'bar'|'baz'",
		obj: {
			"[key]": "string",
		},
	}).export();
	type Key = symbol | "foo" | "bar" | "baz";
	const _type30: Eq<typeof types.key.infer, Key> = true;
	const _type31: Eq<Record<Key, string>> = true;

	const Expected = type({ "[symbol]": "string" }).and({
		foo: "string",
		bar: "string",
		baz: "string",
	});

	expect(types.obj.json).toEqual(Expected.json);
});

it("intersection with named", () => {
	const T = type({ "[string]": "4" }).and({ "a?": "1" });
	const _type33: Eq<
		typeof T.infer,
		{
			[k: string]: 4;
			a?: never;
		}
	> = true;
	expect(T.json).toEqual({
		optional: [{ key: "a", value: { unit: 1 } }],
		index: [{ value: { unit: 4 }, signature: "string" }],
		domain: "object",
	});
});

it("intersction with right required", () => {
	const T = type({ "a?": "true" }).and({ a: "boolean" });
	const _type35: Eq<typeof T.infer, { a: true }> = true;
	const Expected = type({
		a: "true",
	});
	expect(T.json).toEqual(Expected.json);
});

it("syntax error in index definition", () => {
	expect(() =>
		type({
			// @ts-expect-error
			"[unresolvable]": "string",
		}),
	).toThrow("'unresolvable' is unresolvable");
});

it("does not allow syntax error message as value", () => {
	expect(() =>
		type({
			// @ts-expect-error
			"[unresolvable]": "'unresolvable' is unresolvable",
		}),
	).toThrow("'i' is not allowed here");
});

it("semantic error in index definition", () => {
	expect(() =>
		type({
			// @ts-expect-error
			"[symbol<5]": "string",
		}),
	).toThrow("Bounded expression symbol must be exactly one of number, string, Array, or Date");
});

it("invalid key type for index definition", () => {
	expect(() =>
		type({
			// @ts-expect-error
			"[object]": "string",
		}),
	).toThrow("Indexed key definition 'object' must be a string or symbol");
});

it("does not allow invalid key type error as value", () => {
	expect(() =>
		type({
			// @ts-expect-error
			"[object]": "Indexed key definition 'object' must be a string, number or symbol",
		}),
	).toThrow("'Indexed' is unresolvable");
});

it("escaped index", () => {
	const O = type({ "\\[string]": "string" });
	const _type42: Eq<typeof O.infer, { "[string]": string }> = true;
	expect(O.json).toEqual({
		domain: "object",
		required: [{ key: "[string]", value: "string" }],
	});
});

// https://github.com/arktypeio/arktype/issues/1040
it("can constrain optional keys", () => {
	const Repro = type({
		normal: "string>0",
		"optional?": "string>0",
	});

	type Expected = { normal: string; optional?: string };

	const _type44: Eq<Expected, typeof Repro.infer> = true;
	const _type45: Eq<Expected, typeof Repro.inferIn> = true;

	expect(Repro.expression).toBe("{ normal: string >= 1, optional?: string >= 1 }");
});
