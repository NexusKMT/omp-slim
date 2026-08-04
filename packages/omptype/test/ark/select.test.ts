import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

describe("select from User", () => {
	const User = type({
		name: "string",
		platform: "'android' | 'ios'",
		"version?": "number | string",
	});

	const ExpectedConfiguredUser = User.configure(
		{ description: "A STRING" },
		{
			kind: "domain",
			where: d => d.domain === "string",
		},
	);
	it("can select a domain", () => {
		const selected = User.select({
			kind: "domain",
			where: d => d.domain === "string",
		});

		expect(selected).toEqual([{ domain: "string" }]);
	});

	it("fluent selector", () => {
		expect(ExpectedConfiguredUser).toEqual({
			required: [
				{ key: "name", value: { domain: "string", meta: "A STRING" } },
				{ key: "platform", value: [{ unit: "android" }, { unit: "ios" }] },
			],
			optional: [
				{
					key: "version",
					value: ["number", { domain: "string", meta: "A STRING" }],
				},
			],
			domain: "object",
		});
	});

	it("tuple expression selector", () => {
		const T = type([
			User,
			"@",
			{
				description: "A STRING",
			},
			{
				kind: "domain",
				// tuple expression syntax doesn't support narrowing d from kind here
				where: d => d.assertHasKind("domain").domain === "string",
			},
		]);

		expect(T.json).toEqual(ExpectedConfiguredUser.json);
	});

	it("args expression selector", () => {
		const T = type(
			User,
			"@",
			{
				description: "A STRING",
			},
			{
				kind: "domain",
				// args expression syntax doesn't support narrowing d from kind here
				where: d => d.assertHasKind("domain").domain === "string",
			},
		);

		expect(T.json).toEqual(ExpectedConfiguredUser.json);
	});
});

it("docs select config example", () => {
	const SelectivelyConfigured = type({
		name: "string",
		age: "number",
	}).configure(
		{
			description: "a special string",
		},
		// only add the description to string keywords
		{
			kind: "domain",
			where: d => d.domain === "string",
		},
	);

	expect(SelectivelyConfigured.get("name").description).toBe("a special string");
	expect(SelectivelyConfigured.get("age").description).toBe("a number");
});
