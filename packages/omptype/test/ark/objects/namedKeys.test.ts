import { expect, it } from "bun:test";
import { type Type, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("empty", () => {
	const O = type({});
	const _type1: Eq<typeof O.t, object> = true;
	expect(O.json).toEqual(type("object").json);
});

it("required", () => {
	const O = type({ a: "string", b: "number" });
	const _type3: Eq<typeof O.infer, { a: string; b: number }> = true;
	expect(O.json).toEqual({
		domain: "object",
		required: [
			{ key: "a", value: "string" },
			{ key: "b", value: "number" },
		],
	});
});

it("optional keys", () => {
	const O = type({ "a?": "string", b: "number" });
	const _type5: Eq<typeof O.infer, { a?: string; b: number }> = true;
	expect(O.json).toEqual({
		domain: "object",
		required: [{ key: "b", value: "number" }],
		optional: [{ key: "a", value: "string" }],
	});
});

it("chained optional", () => {
	const OptionalString = type("string").optional();
	const _type7: Eq<typeof OptionalString, [Type<string>, "?"]> = true;

	const O = type({ a: OptionalString });
	// directly inferring the optional key causes recursive generics/intersections to fail,
	// so instead we just distill it out like defaults
	const _typeOptionalT: Eq<typeof O.t, { a?: string }> = true;
	const _typeOptionalInfer: Eq<typeof O.infer, { a?: string }> = true;
	const _typeOptionalInferIn: Eq<typeof O.inferIn, { a?: string }> = true;
	expect(O.json).toEqual({
		optional: [
			{
				key: "a",
				value: "string",
			},
		],
		domain: "object",
	});
});

it("string-embedded value optional", () => {
	const s = Symbol("ok");
	const ref = String(s);
	const T = type({ [s]: "string?" });

	const _type12: Eq<
		typeof T.t,
		{
			[s]?: string;
		}
	> = true;
	const _type13: Eq<typeof T.infer, { [s]?: string }> = true;

	expect(T.json).toEqual({
		optional: [
			{
				key: ref,
				value: "string",
			},
		],
		domain: "object",
	});
});

it("tuple value optional", () => {
	const s = Symbol("ok");
	const ref = String(s);
	const T = type({ [s]: [{ foo: "string" }, "?"] });

	const _type15: Eq<typeof T.infer, { [s]?: { foo: string } }> = true;

	expect(T.json).toEqual({
		optional: [
			{
				key: ref,
				value: {
					required: [{ key: "foo", value: "string" }],
					domain: "object",
				},
			},
		],
		domain: "object",
	});
});

// https://github.com/arktypeio/arktype/issues/1102
it("only optional keys not reduced to object", () => {
	const O = type({ "a?": "number" });

	const U = type({ b: O });
	expect(U.expression).toBe("{ b: { a?: number } }");
	const _type18: Eq<
		typeof U.t,
		{
			b: {
				a?: number;
			};
		}
	> = true;
	const _type19: Eq<typeof U.infer, typeof U.t> = true;
	const _type20: Eq<typeof U.inferIn, typeof U.t> = true;
});

// https://github.com/arktypeio/arktype/issues/1102
it("optional keys in union not reduced to object", () => {
	const U = type({ b: type({ "a?": "number" }).or("number") });
	expect(U.expression).toBe("{ b: number | { a?: number } }");
	const _type22: Eq<
		typeof U.t,
		{
			b:
				| {
						a?: number;
				  }
				| number;
		}
	> = true;
});

it("symbol key", () => {
	const s = Symbol();
	const name = String(s);
	const T = type({
		[s]: "string",
	});
	const _type23: Eq<typeof T.infer, { [s]: string }> = true;
	expect(T.json).toEqual({
		domain: "object",
		required: [{ key: name, value: "string" }],
	});
});

it("serializes to same value but not reference equal", () => {
	const T = type("===", {});
	expect(T({}).toString()).toBe("must be reference equal to {} (serialized to the same value)");
});

it("error in obj that has tuple that writes error at proper path", () => {
	expect(() =>
		// @ts-expect-error
		type({ "a?": ["string", ["stringx", "?"]] }),
	).toThrow('unknown keyword "stringx" in "stringx"');
});

it("nested", () => {
	const T = type({ "a?": { b: "boolean" } });
	const _type27: Eq<typeof T.infer, { a?: { b: boolean } }> = true;
});

it("intersections", () => {
	const a = { "a?": "string" } as const;
	const b = { b: "string" } as const;
	const c = { "c?": "string" } as const;
	const Abc = type(a).and(b).and(c);
	const _type28: Eq<typeof Abc.infer, { a?: string; b: string; c?: string }> = true;
	expect(Abc.json).toEqual(type({ ...a, ...b, ...c }).json);
	expect(Abc.json).toEqual(type([[a, "&", b], "&", c]).json);
});

it("intersection", () => {
	const T = type({ a: "number" }).and({ b: "boolean" });
	// Should be simplified from {a: number} & {b: boolean} to {a: number, b: boolean}
	const _typeIntersection: Eq<typeof T.infer, { a: number; b: boolean }> = true;
	expect(T.json).toEqual(type({ a: "number", b: "boolean" }).json);
});

it("escaped optional token", () => {
	const T = type({ "a\\?": "string" });
	const _type33: Eq<typeof T.infer, { "a?": string }> = true;
	expect(T.json).toEqual({
		required: [{ key: "a?", value: "string" }],
		domain: "object",
	});
});

it("traverse optional", () => {
	const O = type({ "a?": "string" });
	expect(O({ a: "a" })).toEqual({ a: "a" });
	expect(O({})).toEqual({});
	expect(O({ a: 1 }).toString()).toBe("a must be a string (was 1)");
});

it("optional symbol", () => {
	const s = Symbol();
	const keyReference = String(s);
	const T = type({
		[s]: type.number.optional(),
	});
	const _type38: Eq<typeof T.infer, { [s]?: number }> = true;
	expect(T.json).toEqual({
		optional: [
			{
				key: keyReference,
				value: "number",
			},
		],
		domain: "object",
	});
});

it("morphed", () => {
	const ProcessForm = type({
		bool_value: type("string")
			.pipe(v => v === "on")
			.optional(),
	});

	const _typeMorphed: Eq<typeof ProcessForm.t, { bool_value?: (In: string) => Out<boolean> }> = true;
	const _type40: Eq<
		typeof ProcessForm.inferIn,
		{
			// key should still be distilled as optional even inside a morph
			bool_value?: string;
		}
	> = true;
	const _type41: Eq<
		typeof ProcessForm.infer,
		{
			// out should also be inferred as optional
			bool_value?: boolean;
		}
	> = true;

	expect(ProcessForm({})).toEqual({});

	expect(ProcessForm({ bool_value: "on" })).toEqual({ bool_value: true });

	expect(ProcessForm({ bool_value: true }).toString()).toBe("bool_value must be a string (was boolean)");
});

it.todo("required key homomorphic");

it.todo("optional value homomorphic");
