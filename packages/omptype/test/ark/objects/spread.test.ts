import { expect, it } from "bun:test";
import { scope, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "../type-assert";

it("within scope", () => {
	const s = scope({
		user: { isAdmin: "false", name: "string" },
		admin: { "...": "user", isAdmin: "true" },
	}).export();

	const _type1: Eq<typeof s.admin.infer, { isAdmin: true; name: string }> = true;
	expect(s.admin.json).toEqual({
		domain: "object",
		required: [
			{ key: "isAdmin", value: { unit: true } },
			{ key: "name", value: "string" },
		],
	});
});

it("from another `type` call", () => {
	const User = type({ isAdmin: "false", name: "string" });
	const Admin = type({ "...": User, isAdmin: "true" });

	const _type3: Eq<typeof Admin.infer, { isAdmin: true; name: string }> = true;
	expect(Admin.json).toEqual({
		domain: "object",
		required: [
			{ key: "isAdmin", value: { unit: true } },
			{ key: "name", value: "string" },
		],
	});
});

it("from an object literal", () => {
	// no idea why you'd want to do this
	const T = type({
		"...": {
			inherited: "boolean",
			overridden: "string",
		},
		overridden: "number",
	});

	const _type5: Eq<
		typeof T.infer,
		{
			inherited: boolean;
			overridden: number;
		}
	> = true;

	expect(T.json).toEqual({
		domain: "object",
		required: [
			{
				key: "inherited",
				value: [{ unit: false }, { unit: true }],
			},
			{ key: "overridden", value: "number" },
		],
	});
});

it("escaped key", () => {
	const T = type({
		"\\...": "string",
	});

	const _type7: Eq<typeof T.infer, { "...": string }> = true;

	expect(T.json).toEqual({
		domain: "object",
		required: [{ key: "...", value: "string" }],
	});
});

it("with non-object", () => {
	// @ts-expect-error
	expect(() => type({ "...": "string" })).toThrow(
		"Spread operand must resolve to an object literal type (was string)",
	);
});

// this is a regression test to ensure nodes are handled even if they aren't just an object
it("with complex type", () => {
	const AdminUser = type({
		"...": [{ name: "string" }, "&", { isAdmin: "false" }],
		isAdmin: "true",
	});

	const _type10: Eq<typeof AdminUser.infer, { isAdmin: true; name: string }> = true;
	expect(AdminUser.json).toEqual({
		domain: "object",
		required: [
			{ key: "isAdmin", value: { unit: true } },
			{ key: "name", value: "string" },
		],
	});
});

it("object keyword treated as empty", () => {
	const T = type({
		"...": "object",
		foo: "string",
	});

	const _type12: Eq<
		typeof T.t,
		{
			foo: string;
		}
	> = true;
	expect(T.expression).toBe("{ foo: string }");
});

it("narrowed object keyword treated as empty", () => {
	const T = type({
		"...": type.object.narrow(() => true),
		foo: "string",
	});

	const _type14: Eq<
		typeof T.t,
		{
			foo: string;
		}
	> = true;
	expect(T.expression).toBe("{ foo: string }");
});

it("errors on proto node", () => {
	expect(() =>
		type({
			"...": "Date",
			foo: "string",
		}),
	).toThrow("Spread operand must resolve to an object literal type (was Date)");
});

it.todo("autocompletes shallow string");

it.todo("autocompletes nested strings");
