import { describe, expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

describe("non-tuple", () => {
	it("allows and apply", () => {
		const T = type("string[]");
		const _0: Eq<typeof T.infer, string[]> = true;
		expect(T.allows([])).toBe(true);
		expect(T([])).toEqual([]);
		expect(T.allows(["foo", "bar"])).toBe(true);
		expect(T(["foo", "bar"])).toEqual(["foo", "bar"]);
		expect(T.allows(["foo", "bar", 5])).toBe(false);
		expect(String(T(["foo", "bar", 5]))).toBe("2 must be a string (was 5)");
		expect(T.allows([5, "foo", "bar"])).toBe(false);
		expect(String(T([5, "foo", "bar"]))).toBe("0 must be a string (was 5)");
	});

	it("nested", () => {
		const T = type("string[][]");
		const _0: Eq<typeof T.infer, string[][]> = true;
		expect(T.allows([])).toBe(true);
		expect(T([])).toEqual([]);
		expect(T.allows([["foo"]])).toBe(true);
		expect(T([["foo"]])).toEqual([["foo"]]);
		expect(T.allows(["foo"])).toBe(false);
		expect(String(T(["foo"]))).toBe('0 must be an array (was "foo")');
		expect(T.allows([["foo", 5]])).toBe(false);
		expect(String(T([["foo", 5]]))).toBe("0.1 must be a string (was 5)");
	});

	it("tuple expression", () => {
		const T = type(["string", "[]"]);
		const _0: Eq<typeof T.infer, string[]> = true;
		expect(T.json).toEqual(type("string[]").json);
	});

	it("root expression", () => {
		const T = type("string", "[]");
		const _0: Eq<typeof T.infer, string[]> = true;
		expect(T.json).toEqual(type("string[]").json);
	});

	it("chained", () => {
		const T = type({ a: "string" }).array();
		const _0: Eq<typeof T.infer, { a: string }[]> = true;

		expect(() => type({ a: "hmm" }).array()).toThrow('unknown keyword "hmm" in "hmm"');
	});

	it("incomplete token", () => {
		expect(() => type("string[")).toThrow("expected ']' in \"string[\"");
	});
});

describe("non-variadic tuple", () => {
	it("empty", () => {
		const T = type([]);
		const _0: Eq<typeof T.infer, []> = true;
		expect(T.expression).toBe("[]");
		expect(T.json).toEqual({ proto: "Array", exactLength: 0 });
		expect(T([])).toEqual([]);
		expect(String(T([1]))).toBe("must be an array of at most length 0 (was an array)");
	});

	it("shallow", () => {
		const T = type(["string", "number"]);
		const _0: Eq<typeof T.infer, [string, number]> = true;
		expect(T.allows(["", 0])).toBe(true);
		expect(T(["", 0])).toEqual(["", 0]);
		expect(T.allows([true, 0])).toBe(false);
		expect(String(T([true, 0]))).toBe("0 must be a string (was true)");
		expect(T.allows([0, false])).toBe(false);
		expect(String(T([0, false]))).toBe("0 must be a string (was 0)");
		// too short
		expect(T.allows([""])).toBe(false);
		expect(String(T([""]))).toBe("must be an array of at least length 2 (was an array)");
		// too long
		expect(T.allows(["", 0, 1])).toBe(false);
		expect(String(T(["", 0, 1]))).toBe("must be an array of at most length 2 (was an array)");
		// non-array
		expect(
			T.allows({
				length: 2,
				0: "",
				1: 0,
			}),
		).toBe(false);
		expect(
			String(
				T({
					length: 2,
					0: "",
					1: 0,
				}),
			),
		).toBe("must be an array (was an object)");
	});

	it("nested", () => {
		const T = type([["string", "number"], [{ a: "bigint", b: ["null"] }]]);
		const _0: Eq<
			typeof T.infer,
			[
				[string, number],
				[
					{
						a: bigint;
						b: [null];
					},
				],
			]
		> = true;
		const valid: typeof T.infer = [["", 0], [{ a: 0n, b: [null] }]];
		expect(T.allows(valid)).toBe(true);
		expect(T(valid)).toEqual(valid);
		const invalid = [["", 0], [{ a: 0n, b: [undefined] }]];
		expect(T.allows(invalid)).toBe(false);
		expect(String(T(invalid))).toBe("1.0.b.0 must be null (was undefined)");
	});

	it("optional tuple", () => {
		const T = type([["string", "?"]]);
		const _0: Eq<typeof T.infer, [string?]> = true;
		expect(T([])).toEqual([]);
		expect(T(["foo"])).toEqual(["foo"]);
		expect(String(T([5]))).toBe("0 must be a string (was 5)");
		expect(String(T(["foo", "bar"]))).toBe("must be an array of at most length 1 (was an array)");
	});

	it("optional string-embedded tuple", () => {
		const T = type(["string?"]);

		const Expected = type([["string", "?"]]);
		const _0: Eq<typeof T, typeof Expected> = true;
		expect(T.expression).toEqual(Expected.expression);
	});

	it("optional object tuple", () => {
		const T = type([[{ foo: "string" }, "?"], "string?"]);
		const _0: Eq<
			typeof T.t,
			[
				{
					foo: string;
				}?,
				string?,
			]
		> = true;
		expect(T.expression).toBe("[{ foo: string }?, string?]");
	});

	it("optional nested object tuple", () => {
		const T = type([[[{ foo: "string" }, "?"]], ["string", "?"]]);
		const _0: Eq<
			typeof T.t,
			[
				[
					{
						foo: string;
					}?,
				],
				string?,
			]
		> = true;
		expect(T.expression).toBe("[[{ foo: string }?], string?]");
	});
});

describe("variadic tuple", () => {
	it("spreads simple arrays", () => {
		const WellRested = type(["string", "...", "number[]"]);
		const _0: Eq<typeof WellRested.infer, [string, ...number[]]> = true;
		expect(WellRested(["foo"])).toEqual(["foo"]);
		expect(WellRested(["foo", 1, 2])).toEqual(["foo", 1, 2]);
	});

	it("spreads array expressions", () => {
		const GreatSpread = type(["0", "...", "(Date|RegExp)[]"]);
		const _0: Eq<typeof GreatSpread.infer, [0, ...(RegExp | Date)[]]> = true;
	});

	it("distributes spread unions", () => {
		const T = type(["1", "...", "(Date[] | RegExp[])"]);
		const _0: Eq<typeof T.infer, [1, ...(Date[] | RegExp[])]> = true;
		const Expected = type(["1", "...", "Date[]"]).or(["1", "...", "RegExp[]"]);
		expect(T.json).toEqual(Expected.json);
	});

	it("distributes spread union tuples", () => {
		const counting = ["2", "3", "4"] as const;
		const fibbing = ["1", "2", "3", "5", "8"] as const;
		const CountOrFib = type(counting, "|", fibbing);
		const _0: Eq<typeof CountOrFib.infer, [2, 3, 4] | [1, 2, 3, 5, 8]> = true;
		const T = type(["1", "...", CountOrFib]);
		const _1: Eq<typeof T.infer, [1, 2, 3, 4] | [1, 1, 2, 3, 5, 8]> = true;
		const Expected = type(["1", ...counting]).or(["1", ...fibbing]);
		expect(T.json).toEqual(Expected.json);
	});

	it("allows array keyword", () => {
		const types = scope({
			myArrayKeyword: "boolean[]",
			myVariadicKeyword: ["string", "...", "myArrayKeyword"],
		}).export();
		const _0: Eq<typeof types.myVariadicKeyword.infer, [string, ...boolean[]]> = true;
	});

	it("errors on non-array", () => {
		expect(() => type(["number", "...", "string"])).toThrow("tuple spread element must be an array");
	});

	it("allows multiple fixed spreads", () => {
		const T = type(["string", "...", "number[]", "...", ["boolean", "bigint"], "...", ["symbol"]]);
		const Expected = type(["string", "...", "number[]", "boolean", "bigint", "symbol"]);
		const _0: Eq<typeof T.infer, [string, ...number[], boolean, bigint, symbol]> = true;
		const _1: Eq<typeof Expected.infer, typeof T.infer> = true;
		expect(T.json).toEqual(Expected.json);
	});

	it("errors on multiple variadic", () => {
		expect(() => type(["...", "string[]", "...", "number[]"])).toThrow(
			"a tuple may have one spread followed by an array definition",
		);
	});
});

it("reduces minLength", () => {
	const T = type(["number", "number", "...", "number[]", "number"]);
	const Expected = type("number[]>=3");
	expect(T.json).toEqual(Expected.json);
});

it("multiple errors", () => {
	const StringArray = type("string[]");
	expect(StringArray([1, 2]).toString()).toBe(`value at [0] must be a string (was a number)
value at [1] must be a string (was a number)`);
});
