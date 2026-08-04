import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

describe("parse", () => {
	it("integer literal", () => {
		const DivisibleByTwo = type("number%2");
		const _type: Eq<typeof DivisibleByTwo.infer, number> = true;
		expect(DivisibleByTwo.json).toEqual({ domain: "number", divisor: 2 });
	});

	it("chained", () => {
		const T = type("number").divisibleBy(2);
		const Expected = type("number%2");
		const _type: Eq<typeof T, typeof Expected> = true;
		expect(T.json).toEqual(Expected.json);
	});

	it("whitespace after %", () => {
		const T = type("number % 5");
		const _type: Eq<typeof T.infer, number> = true;
		expect(T.json).toEqual({ domain: "number", divisor: 5 });
	});

	it("with bounds", () => {
		const T = type("7<number%8<222");
		const Expected = type("number%8").and("7<number<222");
		expect(T.json).toEqual(Expected.json);
		expect(T.description).toBe("a multiple of 8 and more than 7 and less than 222");
	});

	it("docs example", () => {
		const N = type("0 < number <= 100");

		expect(N.description).toBe("positive and at most 100");
	});

	it("allows non-narrowed divisor", () => {
		const d = 5 as number;
		const T = type(`number%${d}`);
		const _type: Eq<typeof T.infer, number> = true;
	});

	it("fails at runtime on non-integer divisor", () => {
		expect(() => type("number%2.3")).toThrow();
	});

	it("non-numeric divisor", () => {
		expect(() => type("number%foobar")).toThrow();
	});

	it("zero divisor", () => {
		expect(() => type("number%0")).toThrow();
	});

	it("unknown", () => {
		expect(() => type("unknown%2")).toThrow();
	});

	it("indivisible", () => {
		expect(() => type("string%1")).toThrow();
	});

	it("morph", () => {
		expect(() => type("string.numeric.parse > 2")).toThrow('cannot bound morph in "string.numeric.parse > 2"');
	});

	it("chained indivisible", () => {
		expect(() => type("string").divisibleBy(2)).toThrow();
	});

	it("overlapping", () => {
		expect(() => type("(number|string)%10")).toThrow();
	});
});

describe("intersection", () => {
	it("identical", () => {
		const T = type("number%2&number%2");
		expect(T.json).toEqual(type("number%2").json);
	});

	it("purely divisible", () => {
		const T = type("number%4&number%2");
		expect(T.json).toEqual(type("number%4").json);
	});

	it("common divisor", () => {
		const T = type("number%6&number%4");
		expect(T.json).toEqual(type("number%12").json);
	});

	it("relatively prime", () => {
		const T = type("number%2&number%3");
		expect(T.json).toEqual(type("number%6").json);
	});

	it("valid literal", () => {
		const T = type("number%5&0");
		expect(T.json).toEqual(type("0").json);
	});

	it("invalid literal", () => {
		expect(() => type("number%3&8")).toThrow(
			"ParseError: Intersection of % 3 and 8 results in an unsatisfiable type",
		);
	});
});
