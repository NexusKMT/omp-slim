import { describe, expect, it } from "bun:test";
import { type Type, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

describe("intersection", () => {
	it("distinct strings", () => {
		const T = type("/a/&/b/");
		const _type: Eq<typeof T.infer, `${string}a${string}` & `${string}b${string}`> = true;
		expect(T.allows("a")).toEqual(false);
		expect(T.allows("b")).toEqual(false);
		expect(T.allows("ab")).toEqual(true);
	});

	it("identical strings", () => {
		const T = type("/a/&/a/");
		expect(T.json).toEqual(type("/a/").json);
	});

	it("string and list", () => {
		const Expected = type("/a/&/b/&/c/").json;
		expect(type(["/a/", "&", "/b/&/c/"]).json).toEqual(Expected);
		expect(type(["/a/", "&", "/b/&/c/"]).json).toEqual(Expected);
	});

	it("redundant string and list", () => {
		const Expected = type("/a/&/b/&/c/").json;
		expect(type(["/a/", "&", "/a/&/b/&/c/"]).json).toEqual(Expected);
		expect(type(["/a/&/b/&/c/", "&", "/c/"]).json).toEqual(Expected);
	});

	it("distinct lists", () => {
		const T = type(["/a/&/b/", "&", "/c/&/d/"]);
		expect(T.json).toEqual(type("/a/&/b/&/c/&/d/").json);
	});

	it("overlapping lists", () => {
		const T = type(["/a/&/b/", "&", "/c/&/b/"]);
		expect(T.json).toEqual(type("/a/&/b/&/c/").json);
	});

	it("identical lists", () => {
		const T = type(["/a/&/b/", "&", "/b/&/a/"]);
		expect(T.json).toEqual(type("/a/&/b/").json);
	});
});

describe("instance", () => {
	it("flagless", () => {
		const T = type(/.*/);
		const _type: Eq<typeof T.infer, string> = true;
		expect(T.json).toEqual(type("/.*/").json);
	});

	it("single flag preserved", () => {
		const T = type(/a/i);
		// the flag should prevent it from reducing to the same regex
		expect(T.json === type("/a/").json).toEqual(false);
		expect(T.allows("A")).toEqual(true);
	});

	it("flag order doesn't matter", () => {
		const A = type(/a/gi);
		const B = type(/a/gi);
		expect(A.json).toEqual(B.json);
	});
});

describe("chained", () => {
	it("matching", () => {
		const T = type("string").matching("foo");
		const Expected = type("/foo/");
		const _type: Eq<typeof T, typeof Expected> = true;
		expect(T.json).toEqual(Expected.json);
	});

	it("invalid operand", () => {
		expect(() => type("number").matching("foo")).toThrow();
	});
});

it("expression doesn't include string basis", () => {
	const T = type(/^a.*z$/);

	expect(T.expression).toBe("/^a.*z$/");
});

it("arkregex integration", () => {
	const T = type({
		email: regex("^.*@.*$"),
	});

	expect(T.expression).toBe("{ email: /^.*@.*$/ }");
	const _type: Eq<
		typeof T,
		Type<{
			email: `${string}@${string}`;
		}>
	> = true;
});
