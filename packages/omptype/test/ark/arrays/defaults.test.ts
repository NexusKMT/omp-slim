import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("single element tuple", () => {
	const T = type([["number", "=", 5]]);
	expect(T.t).toBeDefined();
	expect(T.expression).toBe("[number = 5]");
	expect(T.json).toEqual({
		sequence: { defaultables: [["number", 5]] },
		proto: "Array",
		maxLength: 1,
	});
	expect(T([])).toEqual([5]);
	expect(T([1])).toEqual([1]);
	expect(String(T([null]))).toBe("value at [0] must be a number (was null)");
	expect(String(T([1, 2]))).toBe("must be at most length 1 (was 2)");
});

it("string", () => {
	const T = type(["string = 'foo'"]);
	expect(T.t).toBeDefined();
	expect(T.expression).toBe('[string = "foo"]');
	expect(T.json).toEqual({
		sequence: { defaultables: [["string", "foo"]] },
		proto: "Array",
		maxLength: 1,
	});
	expect(T([])).toEqual(["foo"]);
	expect(T(["bar"])).toEqual(["bar"]);
	expect(String(T([false]))).toBe("value at [0] must be a string (was boolean)");
	expect(String(T(["foo", "bar"]))).toBe("must be at most length 1 (was 2)");
});

it("defaults following prefix", () => {
	const T = type(["string", "number = 5"]);
	expect(T.t).toBeDefined();
	expect(T.expression).toBe("[string, number = 5]");
	expect(T.json).toEqual({
		sequence: { defaultables: [["number", 5]], prefix: ["string"] },
		proto: "Array",
		maxLength: 2,
		minLength: 1,
	});
	expect(T([""])).toEqual(["", 5]);
	expect(T(["", 7])).toEqual(["", 7]);

	expect(String(T([]))).toBe("must be non-empty");
	expect(String(T(["foo", "bar"]))).toBe("value at [1] must be a number (was a string)");
});

it("defaults preceding variadic", () => {
	const T = type(["number", "string = 'foo'", "...", "number[]"]);
	expect(T.t).toBeDefined();
	expect(T.expression).toBe('[number, string = "foo", ...number[]]');
	expect(T.json).toEqual({
		sequence: {
			defaultables: [["string", "foo"]],
			prefix: ["number"],
			variadic: "number",
		},
		proto: "Array",
		minLength: 1,
	});

	expect(T([5])).toEqual([5, "foo"]);
	expect(T([7, "bar"])).toEqual([7, "bar"]);
	expect(T([8, "bar", 5])).toEqual([8, "bar", 5]);

	expect(String(T([]))).toBe("must be non-empty");
	expect(String(T([5, 5]))).toBe("value at [1] must be a string (was a number)");
});

it("default after undefaulted optional", () => {
	expect(() => type(["number?", "number = 5"])).toThrow("A defaultable element cannot follow an optional element");
});

it("input extracted as optional", () => {
	const T = type(["number = 5"]);
	const _0: Eq<typeof T.in.t, [number?]> = true;
	const _1: Eq<typeof T.inferIn, [number?]> = true;

	expect(T.in.expression).toBe("[number?]");
});

it("output extracted as required", () => {
	const T = type(["number = 5"]);
	const _0: Eq<typeof T.out.t, [number]> = true;
	const _1: Eq<typeof T.inferOut, [number]> = true;

	expect(T.out.expression).toBe("[number]");
});

it("compiled defaults use correct values", () => {
	const T = type(["string = 'foo'"]);
	expect(T.internal).toBeDefined();

	const result = T([]);
	expect(result).toEqual(["foo"]);
});
