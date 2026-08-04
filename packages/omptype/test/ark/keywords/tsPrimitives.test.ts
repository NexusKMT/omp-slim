import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import { intrinsic, rootSchema } from "@ark/schema";
import type { Eq } from "../type-assert";

it("string strings", () => {
	const StringType = type("string");
	const _0: Eq<typeof StringType.infer, string> = true;
	expect(StringType("string")).toBe("string");
});

it("any", () => {
	const Any = type("unknown.any");
	expect(Any.json).toEqual(type.unknown.json);
	const _0: Eq<typeof Any.infer, any> = true;
});

it("any in expression", () => {
	const T = type("string", "&", "unknown.any");
	const _0: Eq<typeof T.infer, any> = true;
	expect(T.json).toEqual(intrinsic.string.json);
});

it("boolean", () => {
	const BooleanType = type("boolean");
	const _0: Eq<typeof BooleanType.infer, boolean> = true;
	expect(BooleanType.json).toEqual(rootSchema([{ unit: false }, { unit: true }]).json);
});

it("never", () => {
	const Never = type("never");
	const _0: Eq<typeof Never.infer, never> = true;
	expect(Never.json).toEqual(rootSchema([]).json);
});

it("never in union", () => {
	const T = type("string|never");
	const _0: Eq<typeof T.infer, string> = true;
	expect(T.json).toEqual(intrinsic.string.json);
});

it("unknown", () => {
	expect(type("unknown").json).toEqual(rootSchema({}).json);
});
