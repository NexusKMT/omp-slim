import { describe, expect, it } from "bun:test";
import {
	type BoundModule,
	type Module,
	type Scope,
	type Submodule,
	scope,
	type Type,
	type,
} from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

describe("submodule", () => {
	const $ = scope({
		a: "string",
		b: "sub.alias",
		sub: scope({ alias: "number" }).export(),
	});
	it("base", () => {
		const types = $.export();
		const _assert1: Eq<
			typeof types,
			Module<{
				a: string;
				b: number;
				sub: Submodule<{
					alias: number;
				}>;
			}>
		> = true;

		const _assert2: Eq<typeof types.sub.alias.infer, number> = true;
		const Expected = type("number").json;
		expect(types.sub.alias.json).toEqual(Expected);
		expect(types.b.json).toEqual(Expected);
	});

	it("non-submodule dot access", () => {
		expect(() => $.type("b.foo")).toThrow();
	});

	it("thunk submodule", () => {
		const $ = scope({
			a: "string",
			c: "a",
			sub: () =>
				scope({
					...$.import("a", "c"),
					foo: "a",
					bar: "foo",
				}).export(),
		});
		const _assert3: Eq<
			typeof $,
			Scope<{
				a: string;
				c: string;
				sub: Submodule<{
					foo: string;
					bar: string;
				}>;
			}>
		> = true;
	});

	it("no alias reference", () => {
		expect(() => $.type("sub")).toThrow();
	});

	it("bad alias reference", () => {
		expect(() => $.type("sub.marine")).toThrow();
	});

	it.todo("completions");

	it("can reference subaliases in expression", () => {
		const dateFrom = type("string.date.parse | Date");

		void dateFrom.t;

		expect(dateFrom("05-21-1993")).toBeInstanceOf(Date);
		expect(dateFrom(new Date())).toBeInstanceOf(Date);

		expect(dateFrom("foobar").toString()).toBe('must be a parsable date (was "foobar")');
	});

	it("allows unbound module in scope", () => {
		const mod = scope({
			a: "number",
		}).export();

		const use1 = scope({
			mod,
			b: "mod.a",
		});

		void use1;

		use1.export();
		expect(use1.json).toEqual({
			"mod.a": { domain: "number" },
			b: { domain: "number" },
		});
	});

	// https://github.com/arktypeio/arktype/issues/1103
	it("allows BoundModule reference in scope", () => {
		const mod2 = scope({
			a: "number",
			c: "string",
		}).export("a");

		const use2 = scope({
			mod2,
			b: "mod2.a",
		});

		void use2;

		use2.export();
		expect(use2.json).toEqual({
			"mod2.a": { domain: "number" },
			b: { domain: "number" },
		});
	});
});

describe("rooted submodules", () => {
	const foo = type.module({ root: "'foo'", bar: "'bar'" });

	const $ = scope({
		foo,
		fooBare: "foo",
		fooBar: "foo.bar",
	});

	it("base", () => {
		const _assert4: Eq<
			typeof $,
			Scope<{
				foo: Submodule<{
					root: "foo";
					bar: "bar";
				}>;
				fooBare: "foo";
				fooBar: "bar";
			}>
		> = true;

		const types = $.export();

		expect(types.foo.bar.expression).toBe('"bar"');
		expect(types.foo.root.expression).toBe('"foo"');

		expect(types.fooBar.expression).toBe('"bar"');
		expect(types.fooBare.expression).toBe('"foo"');
	});

	it.todo("completions");

	it("docs example", () => {
		const userModule = type.module({
			root: {
				name: "string",
			},
			// subaliases can extend a base type by referencing 'root'
			// like any other alias
			admin: {
				"...": "root",
				isAdmin: "true",
			},
			saiyan: {
				"...": "root",
				powerLevel: "number > 9000",
			},
		});

		const rootScope = type.scope({
			user: userModule,
			// user can now be referenced directly in a definition
			group: "user[]",
			// or used as a prefix to access subaliases
			elevatedUser: "user.admin | user.saiyan",
		});

		void rootScope;
		expect(rootScope.json).toEqual({
			"user.root": {
				required: [{ key: "name", value: "string" }],
				domain: "object",
			},
			"user.admin": {
				required: [
					{ key: "isAdmin", value: { unit: true } },
					{ key: "name", value: "string" },
				],
				domain: "object",
			},
			"user.saiyan": {
				required: [
					{ key: "name", value: "string" },
					{
						key: "powerLevel",
						value: { domain: "number", min: { exclusive: true, rule: 9000 } },
					},
				],
				domain: "object",
			},
			group: {
				sequence: {
					required: [{ key: "name", value: "string" }],
					domain: "object",
				},
				proto: "Array",
			},
			elevatedUser: [
				{
					required: [
						{ key: "isAdmin", value: { unit: true } },
						{ key: "name", value: "string" },
					],
					domain: "object",
				},
				{
					required: [
						{ key: "name", value: "string" },
						{
							key: "powerLevel",
							value: {
								domain: "number",
								min: { exclusive: true, rule: 9000 },
							},
						},
					],
					domain: "object",
				},
			],
		});
	});
});

describe("nested submodule", () => {
	const $ = scope({
		outer: scope({
			inner: scope({
				alias: "1",
			}).export(),
		}).export(),
	});

	type Expected$ = {
		outer: Submodule<{
			inner: Submodule<{
				alias: 1;
			}>;
		}>;
	};

	it("export", () => {
		const types = $.export();

		const _assert5: Eq<typeof types, Module<Expected$>> = true;

		const _assert6: Eq<
			typeof types.outer,
			BoundModule<
				{
					inner: Submodule<{
						alias: 1;
					}>;
				},
				Expected$
			>
		> = true;
		const _assert7: Eq<
			typeof types.outer.inner,
			BoundModule<
				{
					alias: 1;
				},
				Expected$
			>
		> = true;
		const _assert8: Eq<typeof types.outer.inner.alias, Type<1, Expected$>> = true;

		expect(types.outer.inner.alias.expression).toEqual("1");
		expect(types.outer.inner.alias.$.json).toEqual({
			"outer.inner.alias": { unit: 1 },
		});
	});

	it("reference", () => {
		const T = $.type(["outer.inner.alias"]);
		const _assert9: Eq<typeof T, Type<[1], Expected$>> = true;
		expect(T.expression).toBe("[1]");
	});

	it("non-submodule dot access", () => {
		expect(() =>
			type({
				a: "true.subtype",
			}),
		).toThrow();
	});

	it.todo("completions");

	type _DeepExpected$ = {
		a: Submodule<{
			b: Submodule<{
				c: Submodule<{
					d: Submodule<{
						e: Submodule<{
							f: Submodule<{
								g: Submodule<{
									alias: 1;
								}>;
							}>;
						}>;
					}>;
				}>;
			}>;
		}>;
	};

	it.todo("deep");
});
