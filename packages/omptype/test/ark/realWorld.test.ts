import { expect, it } from "bun:test";
import { AssertionError } from "node:assert";
import { type ArkErrors, type Module, type StandardSchemaV1, scope, type Type, type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

type Out<t> = t;
type To<t> = t;

declare class TimeStub {
	declare readonly isoString: string;

	private constructor();

	declare static from: (isoString: string) => TimeStub;

	declare static fromDate: (date: Date) => TimeStub;

	declare toDate: () => Date;

	declare toString: () => string;
}

// https://github.com/arktypeio/arktype/issues/915
it("time stub w/ private constructor", () => {
	// TimeStub is just declared at a type-level since --experimental-strip-types
	// doesn't yet support private constructors

	const MockTimeStub = class TimeStub {};

	const types = scope({
		timeStub: ["instanceof", MockTimeStub] as type.cast<TimeStub>,
		account: "clientDocument&accountData",
		clientDocument: {
			"id?": "string",
			"coll?": "string",
			"ts?": "timeStub",
			"ttl?": "timeStub",
		},
		accountData: {
			user: "user|timeStub",
			provider: "provider",
			providerUserId: "string",
		},
		user: {
			name: "string",
			"accounts?": "account[]",
		},
		provider: "'GitHub'|'Google'",
	}).export();

	expect(types.account.json).toEqual({
		required: [
			{ key: "provider", value: [{ unit: "GitHub" }, { unit: "Google" }] },
			{ key: "providerUserId", value: "string" },
			{
				key: "user",
				value: [
					{
						required: [{ key: "name", value: "string" }],
						optional: [
							{
								key: "accounts",
								value: { sequence: "$account", proto: "Array" },
							},
						],
						domain: "object",
					},
					"$ark.TimeStub",
				],
			},
		],
		optional: [
			{ key: "coll", value: "string" },
			{ key: "id", value: "string" },
			{ key: "ts", value: "$ark.TimeStub" },
			{ key: "ttl", value: "$ark.TimeStub" },
		],
		domain: "object",
	});
});

it("nested bound traversal", () => {
	// https://github.com/arktypeio/arktype/issues/898
	const User = type({
		name: "string",
		email: "string.email",
		tags: "(string>=2)[]>=3",
		score: "number.integer>=0",
	});

	const out = User({
		name: "Ok",
		email: "",
		tags: ["AB", "B"],
		score: 0,
	});

	expect(out.toString()).toEqual(`email must be an email address (was "")
tags must be at least length 3 (was 2)`);
});

it("multiple refinement errors", () => {
	const nospacePattern = /^\S*$/;

	const Schema = type({
		name: "string",
		email: "string.email",
		tags: "(string>=2)[]>=3",
		score: "number.integer>=0",
		"date?": "Date",
		"nospace?": nospacePattern,
		extra: "string|null",
	});

	const data = {
		name: "Ok",
		email: "",
		tags: ["AB", "B"],
		score: -1,
		date: undefined,
		nospace: "One space",
	};

	const out = Schema(data);

	expect(out.toString()).toEqual(`email must be an email address (was "")
extra must be a string or null (was missing)
score must be non-negative (was -1)
tags must be at least length 3 (was 2)
date must be a Date (was undefined)
nospace must be matched by ^\\S*$ (was "One space")`);
});

it("discrimination false negative", () => {
	// https://github.com/arktypeio/arktype/issues/910
	const badScope = scope({
		a: {
			x: "'x1'",
			y: "'y1'",
			z: "string",
		},
		b: {
			x: "'x1'",
			y: "'y2'",
			z: "number",
		},
		c: {
			x: "'x2'",
			y: "'y3'",
			z: "string",
		},
		union: "a | b | c",
	}).export();

	const badType = badScope.union;

	type Test = typeof badType.infer;

	const value: Test = {
		x: "x2",
		y: "y3",
		z: "",
	}; // no type error

	const out = badType(value); // matches scope union item 'c'; should not fail
	expect(out).toEqual(value);
});
it("morph path", () => {
	// https://github.com/arktypeio/arktype/issues/754
	const withMorph = type({
		key: type("string").pipe(type("3<=string<=4"), s => s.trim()),
	});

	const outWithMorph = withMorph({
		key: "  This is too long  ",
	});

	expect(outWithMorph.toString()).toEqual("key must be at most length 4 (was 20)");

	const withoutMorph = type({
		key: type("3<=string<=4"),
	});

	const outWithoutMorph = withoutMorph({
		key: "  This is too long  ",
	});

	expect(outWithoutMorph.toString()).toEqual("key must be at most length 4 (was 20)");
});

it("cross scope reference", () => {
	// https://github.com/arktypeio/arktype/issues/700
	const A = type({
		required: "boolean",
	});

	const B = scope({ A }).type({
		a: "A",
	});

	const C = scope({
		B,
	}).type({
		b: "B",
	});

	const _crossC: Eq<typeof C.t, { b: { a: { required: boolean } } }> = true;

	const _crossScope: Eq<typeof C.$.t, { B: { a: { required: boolean } } }> = true;

	expect(C.json).toEqual({
		domain: "object",
		required: [
			{
				key: "b",
				value: {
					domain: "object",
					required: [
						{
							key: "a",
							value: {
								domain: "object",
								required: [
									{
										key: "required",
										value: [{ unit: false }, { unit: true }],
									},
								],
							},
						},
					],
				},
			},
		],
	});
});

// https://github.com/arktypeio/arktype/issues/947
it("chained inline type expression inference", () => {
	const A = type({
		action: "'a' | 'b'",
	}).or({
		action: "'c'",
	});

	const Referenced = type({
		someField: "string",
	}).and(A);

	const _referenced: Eq<
		typeof Referenced.infer,
		{ someField: string; action: "a" | "b" } | { someField: string; action: "c" }
	> = true;

	const Inlined = type({
		someField: "string",
	}).and(
		type({
			action: "'a' | 'b'",
		}).or({
			action: "'c'",
		}),
	);

	const _inlined: Eq<typeof Inlined, typeof Referenced> = true;
});

// https://discord.com/channels/957797212103016458/1242116299547476100
it("infers morphs at nested paths", () => {
	const parseBigint = type("string", "=>", (s, ctx) => {
		try {
			return BigInt(s);
		} catch {
			return ctx.error("a valid number");
		}
	});

	const Test = type({
		group: {
			nested: {
				value: parseBigint,
			},
		},
	});

	const out = Test({ group: { nested: { value: "5" } } });
	const _nestedMorph: Eq<typeof Test.infer.group.nested.value, bigint> = true;
	expect(out).toEqual({ group: { nested: { value: 5n } } });
});

// https://discord.com/channels/957797212103016458/957804102685982740/1242221022380556400
it("nested pipe to validated output", () => {
	const trimString = (s: string) => s.trim();

	const trimStringReference = trimString;

	const validatedTrimString = type("string").pipe(trimString, type("1<=string<=3"));

	const CreatePatientInput = type({
		"patient_id?": "string|null",
		"first_name?": validatedTrimString.or("null"),
		"middle_name?": "string|null",
		"last_name?": "string|null",
	});

	const _validatedOutput: Eq<typeof CreatePatientInput.t.first_name, ((In: string) => To<string>) | null | undefined> =
		true;

	expect(CreatePatientInput.json).toEqual({
		optional: [
			{
				key: "first_name",
				value: [
					{
						in: "string",
						morphs: [trimStringReference, { domain: "string", maxLength: 3, minLength: 1 }],
					},
					{ unit: null },
				],
			},
			{ key: "last_name", value: ["string", { unit: null }] },
			{ key: "middle_name", value: ["string", { unit: null }] },
			{ key: "patient_id", value: ["string", { unit: null }] },
		],
		domain: "object",
	});
	expect(CreatePatientInput({ first_name: " Bob  " })).toEqual({
		first_name: "Bob",
	});
	expect(CreatePatientInput({ first_name: " John  " }).toString()).toEqual(
		"first_name must be at most length 3 (was 4)",
	);

	expect(CreatePatientInput({ first_name: 5 }).toString()).toEqual(
		"first_name must be a string or null (was a number)",
	);
});

// https://github.com/arktypeio/arktype/issues/968
it("handles consecutive pipes", () => {
	const MyAssets = scope({
		Asset: {
			token: "string",
			amount: type("string").pipe((s, ctx) => {
				try {
					return BigInt(s);
				} catch {
					return ctx.error("a valid non-decimal number");
				}
			}),
		},
		Assets: {
			assets: "Asset[]>=1",
		},
	})
		.export()
		.Assets.pipe(o => {
			const assets = o.assets.reduce<Record<string, bigint>>((acc, asset) => {
				acc[asset.token] = asset.amount;
				return acc;
			}, {});
			return { ...o, assets };
		});

	const out = MyAssets({ assets: [{ token: "a", amount: "1" }] });

	expect(out).toEqual({ assets: { a: 1n } });
});

// https://discord.com/channels/957797212103016458/957804102685982740/1243850690644934677
it("more chained pipes/narrows", () => {
	const Amount = type("string", ":", (s, ctx) => Number.isInteger(Number(s)) || ctx.reject("number"))
		.pipe((s, ctx) => {
			try {
				return BigInt(s);
			} catch {
				return ctx.error("a non-decimal number");
			}
		})
		.narrow(() => true);

	const Token = type("7<string<=120")
		.pipe(s => s.toLowerCase())
		.narrow(() => true);

	const $ = scope({
		Asset: {
			token: Token,
			amount: Amount,
		},
		Assets: () => $.type("Asset[]>=1").pipe(assets => assets),
	});

	const types = $.export();

	const out = types.Assets([{ token: "lovelace", amount: "5000000" }]);

	expect(out).toEqual([{ token: "lovelace", amount: 5000000n }]);
});

it("regex index signature", () => {
	const test = scope({
		svgPath: /^\.\/([\da-f])+(-([\da-f])+)*\.svg$/,
		svgMap: {
			"[svgPath]": "string.digits",
		},
	}).export();
	const _regexModule: Eq<
		typeof test,
		Module<{
			svgMap: { [x: string]: string };
			svgPath: string;
		}>
	> = true;
	expect(test.svgMap({ "./f.svg": "123", bar: 5 })).toEqual({
		"./f.svg": "123",
		bar: 5,
	});
	expect(test.svgMap({ "./f.svg": "123a" }).toString()).toEqual(
		'value at ["./f.svg"] must be only digits 0-9 (was "123a")',
	);
});

it("standalone type from cyclic", () => {
	const types = scope({
		JsonSchema: "JsonSchemaArray|JsonSchemaNumber",
		JsonSchemaArray: {
			items: "JsonSchema",
			type: "'array'",
		},
		JsonSchemaNumber: {
			type: "'number'|'integer'",
		},
	}).export();

	const standalone = types.JsonSchemaArray.describe("standalone");

	expect(standalone.json).toEqual({
		required: [
			{ key: "items", value: "$JsonSchema" },
			{ key: "type", value: { unit: "array" } },
		],
		meta: "standalone",
		domain: { meta: "standalone", domain: "object" },
	});

	const valid: typeof standalone.infer = {
		type: "array",
		items: { type: "array", items: { type: "number" } },
	};

	const out = standalone(valid);

	expect(out).toEqual(valid);

	const failOut = standalone({
		type: "array",
		items: { type: "array" },
	});

	expect(failOut.toString()).toEqual(
		'items.items must be an object (was missing) or items.type must be "integer" or "number" (was "array")',
	);
});

it("more external cyclic scope references", () => {
	const $ = scope({
		box: {
			"box?": "box",
		},
	});

	const box = $.type("box|null");

	expect(box({})).toEqual({});
	expect(box(null)).toEqual(null);
	expect(box({ box: { box: { box: {} } } })).toEqual({
		box: { box: { box: {} } },
	});
	expect(box({ box: { box: { box: "whoops" } } })?.toString()).toEqual("box.box.box must be an object (was a string)");
});

it("morph with alias child", () => {
	const types = scope({
		ArraySchema: {
			"items?": "Schema",
		},
		Schema: "TypeWithKeywords",
		TypeWithKeywords: "ArraySchema",
	}).export();

	const T = types.Schema.pipe(o => JSON.stringify(o));

	expect(T({ items: {} })).toEqual('{"items":{}}');
	expect(T({ items: null }).toString()).toEqual("items must be an object (was null)");
});

it("terse missing key error", () => {
	const types = scope({
		Library: {
			sections: "Sections",
		},
		Sections: {
			"[string]": "Book[]",
		},
		Book: {
			isbn: "string",
			title: "string",
			"subtitle?": "string",
			authors: "string[]",
			publisher: "Publisher",
		},
		Publisher: {
			id: "string",
			name: "string",
		},
	}).export();

	expect(types.Library({}).toString()).toEqual("sections must be Sections (was missing)");
});

it("narrowed quoted description", () => {
	const T = type("string")
		.narrow(function _narrowedQuoteDescription() {
			return true;
		})
		.describe('This will "fail"');

	const _narrowedDescription: Eq<typeof T.t, string> = true;

	expect(T.json).toEqual({
		domain: { domain: "string", meta: 'This will "fail"' },
		predicate: [
			{
				predicate: "$ark._narrowedQuoteDescription",
				meta: 'This will "fail"',
			},
		],
		meta: 'This will "fail"',
	});
});

it("extract in of narrowed morph", () => {
	const SubSubType = type("string").pipe(s => parseInt(s, 10));
	const SubType = type({ amount: SubSubType }).narrow(() => true);
	const MyType = type({
		sub: SubType,
	});

	type MyType = typeof MyType.in.infer;

	const _narrowedInput: Eq<MyType, { sub: { amount: string } }> = true;
});

it("narrowed morph", () => {
	const T = type("string")
		.pipe(s => parseInt(s, 10))
		.narrow(() => true);

	const _narrowedMorph: Eq<typeof T.t, (In: string) => Out<number>> = true;

	const _u = T.pipe(
		n => `${n}`,
		s => `${s}++` as const,
	);
});

it("recursive reference from union", () => {
	const $ = scope({
		TypeWithKeywords: "ArraySchema",
		Schema: "number|ArraySchema",
		ArraySchema: {
			"additionalItems?": "Schema",
		},
	});

	$.export();

	expect($.json).toEqual({
		TypeWithKeywords: {
			optional: [{ key: "additionalItems", value: ["$ArraySchema", "number"] }],
			domain: "object",
		},
		Schema: ["$ArraySchema", "number"],
		ArraySchema: {
			optional: [{ key: "additionalItems", value: ["$ArraySchema", "number"] }],
			domain: "object",
		},
	});
});

// https://discord.com/channels/957797212103016458/957804102685982740/1254900389346807849
it("narrows nested morphs", () => {
	const parseBigint = type("string").pipe(s => BigInt(s));
	const Fee = type({ amount: parseBigint }).narrow(fee => typeof fee.amount === "bigint");

	const Claim = type({
		fee: Fee,
	});

	const out = Claim.assert({ fee: { amount: "5" } });

	expect(out).toEqual({ fee: { amount: 5n } });
});

// https://github.com/arktypeio/arktype/issues/1037
it("can morph an optional key", () => {
	const T = type({
		"optionalKey?": ["string", "=>", x => x.toLowerCase()],
	});

	const _optionalMorph: Eq<typeof T.t, { optionalKey?: (In: string) => Out<string> }> = true;

	expect(T({})).toEqual({});

	expect(T({ optionalKey: "FOO" })).toEqual({ optionalKey: "foo" });
});

// https://discord.com/channels/957797212103016458/1261621890775126160/1261621890775126160
it("can narrow output of a piped union", () => {
	const parseBigint = (v: string | number) => BigInt(v);
	const morphReference = parseBigint;
	const validatePositiveBigint = (b: bigint) => b > 0n;
	const predicateReference = validatePositiveBigint;

	const Amount = type("string|number").pipe(parseBigint).narrow(validatePositiveBigint);

	const _pipedUnion: Eq<typeof Amount.t, (In: string | number) => Out<bigint>> = true;
	expect(Amount.json).toEqual({
		in: ["number", "string"],
		morphs: [morphReference, { predicate: [predicateReference] }],
	});

	expect(Amount("1000")).toEqual(1000n);
	expect(Amount("-5").toString()).toEqual("must be valid according to validatePositiveBigint (was -5n)");
});

it("nested 'and' chained from morph on optional", () => {
	const validatedTrimString = type("string").pipe(s => s.trim(), type("1<=string<=3"));

	const T = type({
		"first_name?": validatedTrimString.and("unknown"),
	});

	expect(T.expression).toEqual("{ first_name?: (In: string) => To<string <= 3 & >= 1> }");
});

it("cyclic narrow in scope", () => {
	const _root = scope({
		filename: "0<string<255",
		file: {
			type: "'file'",
			name: "filename",
		},
		directory: {
			type: "'directory'",
			name: "filename",
			children: [
				"root[]",
				":",
				(v, ctx) => {
					if (new Set(v.map(f => f.name)).size !== v.length)
						return ctx.mustBe("names must be unique in a directory");

					return true;
				},
			],
		},
		root: "file|directory",
	}).resolve("root");
});

// https://github.com/arktypeio/arktype/discussions/1080#discussioncomment-10247616
it("pipe to discriminated morph union", () => {
	const ObjSchema = type({
		action: "'order.completed'",
	}).or({
		action: `'scheduled'`,
		id: "string.integer.parse",
		calendarID: "string.integer.parse",
		appointmentTypeID: "string.integer.parse",
	});

	const parseJsonToObj = type("string.json.parse").pipe(ObjSchema);

	expect(parseJsonToObj.expression).toEqual(
		'(In: string) => To<{ action: "order.completed" } | { action: "scheduled", appointmentTypeID: number % 1, calendarID: number % 1, id: number % 1 }>',
	);

	const out = parseJsonToObj(
		JSON.stringify({
			action: "scheduled",
			id: "1",
			calendarID: "1",
			appointmentTypeID: "1",
		}),
	);

	const _pipeUnion: Eq<
		typeof out,
		| ArkErrors
		| { action: "order.completed" }
		| {
				action: "scheduled";
				id: number;
				calendarID: number;
				appointmentTypeID: number;
		  }
	> = true;

	expect(out).toEqual({
		action: "scheduled",
		id: 1,
		calendarID: 1,
		appointmentTypeID: 1,
	});
});

// https://github.com/arktypeio/arktype/discussions/1080#discussioncomment-10247616
it("pipe to discriminated morph inner union", () => {
	const ObjSchema = type({
		action: "'order.completed'",
	}).or({
		action: "'scheduled' | 'rescheduled' | 'canceled' | 'changed'",
		id: "string.integer.parse",
		calendarID: "string.integer.parse",
		appointmentTypeID: "string.integer.parse",
	});

	const parseJsonToObj = type("string.json.parse").pipe(ObjSchema);

	const out = parseJsonToObj(
		JSON.stringify({
			action: "scheduled",
			id: "1",
			calendarID: "1",
			appointmentTypeID: "1",
		}),
	);

	expect(out).toEqual({
		action: "scheduled",
		id: 1,
		calendarID: 1,
		appointmentTypeID: 1,
	});
});

// https://discord.com/channels/957797212103016458/957804102685982740/1276840721370054688
it("directly nested piped type instantiation", () => {
	const T = type({
		"test?": type("string").pipe(x => x === "true"),
	});

	const _nestedPipe: Eq<typeof T.t, { test?: (In: string) => Out<boolean> }> = true;
});

it("discriminated union error", () => {
	const C = type({ city: "string", "+": "reject" }).pipe(o => ({
		...o,
		type: "city",
	}));
	const N = type({ name: "string", "+": "reject" }).pipe(o => ({
		...o,
		type: "name",
	}));

	const T = C.or(N);

	const out = T({ city: "foo", name: "foo" });
	expect(out.toString()).toEqual("name must be removed or city must be removed");
});

it("array intersection with object literal", () => {
	const T = type({ name: "string" }).and("string[]");

	expect(T.expression).toEqual("{ name: string } & string[]");
});

it("tuple or morph inference", () => {
	const T = type(["string", "string"]).or(["null", "=>", () => undefined]);

	expect(T.expression).toEqual("[string, string] | (In: null) => Out<unknown>");
});

it("scoped discrimnated union", () => {
	const $ = scope({
		TypeWithNoKeywords: { type: "'boolean'|'null'" },
		TypeWithKeywords: "ArraySchema|ObjectSchema", // without both ArraySchema and ObjectSchema there's no error
		// "#BaseSchema": "TypeWithNoKeywords|boolean", // errors even with union reversed
		"#BaseSchema": "boolean|TypeWithNoKeywords", // without the `boolean` there's no error (even if still union such as `string|TypeWithNoKeywords`)
		ArraySchema: {
			"additionalItems?": "BaseSchema", // without this reference there's no error
			type: "'array'",
		},
		// If `ObjectSchema` doesn't have `type` key there's no error
		ObjectSchema: {
			type: "'object'",
		},
	});
	const JsonSchema = $.export();
	expect(JsonSchema.TypeWithKeywords.expression).toEqual(
		'{ type: "array", additionalItems?: { type: "boolean" | "null" } | false | true } | { type: "object" }',
	);

	expect(
		JsonSchema.TypeWithKeywords({
			type: "array",
			additionalItems: { type: "boolean" },
		}),
	).toEqual({ type: "array", additionalItems: { type: "boolean" } });
	expect(
		JsonSchema.TypeWithKeywords({
			type: "array",
			additionalItems: {
				type: "whoops",
			},
		}).toString(),
	).toEqual('additionalItems.type must be "boolean" or "null" (was "whoops")');
});

// https://github.com/arktypeio/arktype/issues/1127
it("keys can overlap with RegExp", () => {
	const MaybeEmpty = type("<t>", "t|undefined|null");

	const ApiSchema = type({
		ref: MaybeEmpty("string"),
		service_code: MaybeEmpty("number"),
		action: MaybeEmpty("string"),
		source: type("string | null"),
		lastIndex: type("string | null"),
	});

	const _overlapRegex: Eq<
		typeof ApiSchema.t,
		{
			ref: string | null | undefined;
			service_code: number | null | undefined;
			action: string | null | undefined;
			source: string | null;
			lastIndex: string | null;
		}
	> = true;

	expect(ApiSchema.expression).toEqual(
		"{ action: string | undefined | null, lastIndex: string | null, ref: string | undefined | null, service_code: number | undefined | null, source: string | null }",
	);
});

it("error on bounded liftArray", () => {
	// @ts-expect-error
	expect(() => type("2 < Array.liftFrom<string> < 4"))
		.toThrow("ParseError: MaxLength operand must be a string or an array (was a morph)");
});

// https://discord.com/channels/957797212103016458/1290304355643293747
it("can extract proto Node at property", () => {
	const D = type("Date");

	const O = type({
		last_updated: D,
	});

	const T = O.get("last_updated");

	const _protoNode: Eq<typeof T.t, Date> = true;
	expect(D.expression).toEqual("Date");
	expect(T.expression).toEqual(D.expression);
	expect(T.extends(D)).toEqual(true);
});

it("piped through Type", () => {
	const Letters = type("'a'|'b'|'c'");
	// normally, this would just be .to(Letters), but this should work as
	// well, even if it's less efficient
	const Letter = type("string").pipe(s => Letters(s));

	expect(Letter("d").toString()).toEqual('must be "a", "b" or "c" (was "d")');
});

it(".in types are always unionable", () => {
	const MorphArrayMorph = type("string")
		.pipe(e => e)
		.array()
		.pipe(e => e);
	const OtherType = type("string[]");
	const EitherInput = MorphArrayMorph.in.or(OtherType.in);

	expect(EitherInput(["str"])).toEqual(["str"]);
});

it("intersecting unknown with piped type preserves identity", () => {
	const Base = type({
		foo: type("string").pipe(() => 123),
	})
		.pipe(c => c)
		.to({
			foo: "123",
		});

	const Identity = Base.and("unknown");

	expect(Base.json).toEqual(Identity.json);
	expect(Base.internal.id).toEqual(Identity.internal.id);
});

it("index signature union intersection with default", () => {
	const T = type({
		storeA: "Record<string, string>",
	})
		.or({
			storeB: {
				foo: "Record<string, string>",
			},
		})
		.and({
			ext: ["string", "=", ".txt"],
		});

	expect(T.expression).toEqual(
		'{ storeA: { [string]: string }, ext: string = ".txt" } | { storeB: { foo: { [string]: string } }, ext: string = ".txt" }',
	);
});

it("correct toString for array of union", () => {
	const T = type("(string | number)[]");
	expect(T.expression).toEqual("(number | string)[]");
});

it("union with length constraint", () => {
	const Feedback = type({
		contact: "string.email | string == 0",
	});

	expect(Feedback.expression).toEqual("{ contact: string == 0 | /^[\\w%+.-]+@[\\d.A-Za-z-]+\\.[A-Za-z]{2,}$/ }");
});

it("deleted undeclared keys allowed in input", () => {
	const T = type({ foo: "string" }).onUndeclaredKey("delete");

	expect(T.json).toEqual({
		undeclared: "delete",
		required: [{ key: "foo", value: "string" }],
		domain: "object",
	});

	expect(T.in.json).toEqual({
		required: [{ key: "foo", value: "string" }],
		domain: "object",
	});

	const extras = { foo: "hi", bar: 3 };

	expect(T(extras)).toEqual({ foo: "hi" });
	expect(T.allows(extras)).toEqual(true);
	expect(T.in(extras)).toEqual(extras);
});

it("deleted undeclared keys rejected in output", () => {
	const T = type({ foo: "string" }).onUndeclaredKey("delete");

	expect(T.json).toEqual({
		undeclared: "delete",
		required: [{ key: "foo", value: "string" }],
		domain: "object",
	});

	expect(T.out.json).toEqual({
		undeclared: "reject",
		required: [{ key: "foo", value: "string" }],
		domain: "object",
	});

	expect(T.out({ foo: "hi", bar: 3 }).toString()).toEqual("bar must be removed");
});

it("includesMorph only when expected", () => {
	const Unmorphed = type({
		"optional?": "string",
		required: "string",
		tuple: ["string", "number?"],
		array: "string[]",
		closed: {
			"+": "reject",
			a: "true",
		},
	});
	expect(Unmorphed.internal.includesTransform).toEqual(false);
});

it("morph includesMorph", () => {
	const T = type({
		prop: ["string", "=>", s => s.length],
	});

	expect(T.internal.includesTransform).toEqual(true);
});

it("default prop includesMorph", () => {
	const T = type({
		prop: "number = 5",
	});

	expect(T.internal.includesTransform).toEqual(true);
});

it("default tuple includesMorph", () => {
	const T = type({
		tuple: ["number = 5"],
	});

	expect(T.internal.includesTransform).toEqual(true);
});

it("onUndeclaredKey delete includesMorph", () => {
	const T = type({
		inner: {
			"+": "delete",
			foo: "string",
		},
	});
	expect(T.internal.includesTransform).toEqual(true);
});

it("distill doesn't treat functions returning any/never as morphs", () => {
	type T = {
		any(): any;
		never(): never;
	};
	const _T = type("unknown").as<T>();
});

it("distills morphs returning any/never", () => {
	const T = type({
		any: ["unknown", "=>", (): any => {}],
		never: ["unknown", "=>", () => [] as never],
	});
});

// https://github.com/arktypeio/arktype/issues/1274
it("fail on non-discriminable union of objects with onUndeclaredKey: delete", () => {
	const Point2d = type({
		x: "number",
		y: "number",
		"+": "delete",
	});

	const Point3d = type({
		x: "number",
		y: "number",
		z: "number",
		"+": "delete",
	});

	expect(() =>
		Point2d.or(Point3d),
	).toThrow(`ParseError: An unordered union of a type including a morph and a type with overlapping input is indeterminate:
Left: { x: number, y: number, z: number, + (undeclared): delete }
Right: { x: number, y: number, + (undeclared): delete }`);
});

// https://github.com/arktypeio/arktype/issues/1266
it("onUndeclaredKey intersection cases", () => {
	const types = type.module({
		// Works: overlapping fields are named the same, have simple type
		ModelA_V1: { times: "number", "+": "reject" },
		ModelA_V2: {
			times: "number",
			version: "2",
			"+": "reject",
		},
		ModelA: "ModelA_V2 | ModelA_V1",
		// Works: non-overlapping list fields
		ModelB_V1: { times: "number.integer[]", "+": "reject" },
		ModelB_V2: {
			frames: "number.integer[]",
			version: "2",
			"+": "reject",
		},
		ModelB: "ModelB_V2 | ModelB_V1",
		// Does not work: overlapping array field
		ModelC_V1: { times: "number[]", "+": "reject" },
		ModelC_V2: {
			times: "number[]",
			version: "2",
			"+": "reject",
		},
		ModelC: "ModelC_V2 | ModelC_V1",
		// Works: overlapping map fields
		ModelD_V1: { times: "Record<string, number>", "+": "reject" },
		ModelD_V2: {
			times: "Record<string, number>",
			version: "2",
			"+": "reject",
		},
		ModelD: "ModelD_V2 | ModelD_V1",
		// Works: overlapping user-defined sub-model
		Time: { value: "number" },
		ModelE_V1: { time: "Time", "+": "reject" },
		ModelE_V2: {
			time: "Time",
			version: "2",
			"+": "reject",
		},
		ModelE: "ModelE_V2 | ModelE_V1",
		Times: { values: "number[]" },
		// Does not work: arrays within overlapping sub-model
		ModelF_V1: { times: "Times", "+": "reject" },
		ModelF_V2: {
			times: "Times",
			version: "2",
			"+": "reject",
		},
		ModelF: "ModelF_V2 | ModelF_V1",
	});

	types.ModelA.assert({ times: 0.0, version: 2 });
	types.ModelB.assert({ frames: [0], version: 2 });
	types.ModelC.assert({ times: [0.0], version: 2 });
	types.ModelD.assert({ times: { age: 7.3 }, version: 2 });
	types.ModelE.assert({ time: { value: 0.0 }, version: 2 });
	types.ModelF.assert({ times: { values: [0.0] }, version: 2 });
});

it("can nested type call from standard schema generic", () => {
	function fn<
		T extends {
			schema: StandardSchemaV1;
		},
	>(_: T) {
		return {} as StandardSchemaV1.InferOutput<T["schema"]>;
	}

	// was inferred as unknown before NoInfer was refactored to conditionals
	const arkRes = fn({
		schema: type({
			name: "string",
		}),
	});

	const _standardSchema: Eq<typeof arkRes, { name: string }> = true;
});

// https://github.com/arktypeio/arktype/issues/1317
it("discriminated tuple/array union", () => {
	const TupleType = type(["number", "number"]);
	const TupleArrayType = TupleType.array();
	const UnionType = TupleType.or(TupleArrayType);

	expect(TupleType.assert([1, 2])).toEqual([1, 2]);
	expect(TupleArrayType.assert([[1, 2]])).toEqual([[1, 2]]);
	expect(UnionType.assert([[1, 2]])).toEqual([[1, 2]]);
});

it("doomed shirt example", () => {
	const urDOOMed = type({
		grouping: "(0 | (1 | (2 | (3 | (4 | 5)[])[])[])[])[]",
		nestedGenerics: "Exclude<0n | unknown[] | Record<string, unknown>, object>",
		"escapes\\?": "'a | b' | 'c | d'",
	});

	const _doomed: Eq<
		typeof urDOOMed.t,
		{
			grouping: (0 | (1 | (2 | (3 | (4 | 5)[])[])[])[])[];
			nestedGenerics: 0n;
			"escapes?": "a | b" | "c | d";
		}
	> = true;

	expect(urDOOMed.expression).toEqual(
		'{ escapes?: "a | b" | "c | d", grouping: (((((4 | 5)[] | 3)[] | 2)[] | 1)[] | 0)[], nestedGenerics: 0n }',
	);
});

it.todo("ArkErrors not assignable to ArkErrorInput");

it("described input of morph", () => {
	class ValidatedUserID {
		readonly data: string;
		static fromString(value: string): ValidatedUserID {
			return new ValidatedUserID(value);
		}
		private constructor(data: string) {
			this.data = data;
		}
	}

	const UserID = type("string").describe("a userID").pipe.try(ValidatedUserID.fromString);

	const User = type({
		id: UserID,
	});

	const out = User({
		iD: "typo, oops",
	});

	expect(out.toString()).toEqual("id must be a userID (was missing)");
});

// https://github.com/arktypeio/arktype/issues/1400
it("configured union message", () => {
	const Schema = type('"abc" | "cde"').configure({
		message: () => "hello world",
	});

	const res = Schema("efg");

	expect(res.toString()).toEqual("hello world");
});

it("allows morph union with non-overlapping root objects", () => {
	const MasterSkinItem = type({
		"+": "reject",
		type: "'skin'",
		masterItem: "true",

		skin: "string",
		short: "string",

		minPrice: "number.integer >=0",
		stattrakAvailable: "boolean = false",
		souvenirAvailable: "boolean = false",
		qualities: type("1 | 2 | 3 | 4 |5").array().or(["null"]),
	});

	const SkinItem = type({
		"+": "reject",
		type: "'skin'",
		// "masterItem?": "false",
		skin: "string",
		short: "string",

		"weight?": "number",
		souvenir: "boolean = false",
		stattrak: "boolean = false",
		quality: type("1 | 2 | 3 | 4 |5").optional(),
	});

	const Skinish = MasterSkinItem.or(SkinItem);
	expect(Skinish.expression).toEqual(
		'{ masterItem: true, minPrice: number % 1 & >= 0, qualities: (1 | 2 | 3 | 4 | 5)[] | [null], short: string, skin: string, type: "skin", souvenirAvailable: boolean = false, stattrakAvailable: boolean = false, + (undeclared): reject } | { short: string, skin: string, type: "skin", souvenir: boolean = false, stattrak: boolean = false, quality?: 1 | 2 | 3 | 4 | 5, weight?: number, + (undeclared): reject }',
	);
});

it("allows inferring a schema's type argument in a generic wrapper function when the type uses Default", () => {
	function someFunction<TSchema extends Record<string, any>>(schema: Type<TSchema, {}>): (typeof schema)["infer"] {
		const someData = { hello: "world" };
		return schema.assert(someData);
	}

	const schema = type({
		hello: type("string").pipe(s => s === "world"),
		goodbye: "string='blah'",
	});

	someFunction(schema);
});

it("allows inferring a schema in a generic wrapper function when the type uses Default", () => {
	function someFunction<schema extends type.Any<Record<string, any>>>(schema: schema) {
		const someData = { hello: "world" };
		return schema.assert(someData);
	}

	const schema = type({
		hello: type("string").pipe(s => s === "world"),
		goodbye: "string='blah'",
	});

	someFunction(schema);
});

it("reports all string.date errors", () => {
	const Thing = type({
		date1: "string.date",
		date2: "string.date",
		date3: "string.date",
	});

	const out = Thing({
		date1: "",
		date2: "",
		date3: "",
	});

	if (!(out instanceof type.errors)) throw new AssertionError({});

	expect(out.length).toEqual(3);
	expect(out.summary).toEqual(`date1 must be a parsable date (was "")
date2 must be a parsable date (was "")
date3 must be a parsable date (was "")`);
});

// https://github.com/arktypeio/arktype/issues/1188
it("cyclic discriminated union issue 1", () => {
	let wasPiped = false;

	const $ = scope({
		Foo: {
			"oneOf?": "Bar[]", // NB: don't get the error if this is not an array
		},
		Bar: "Foo",
	}).export();

	const baz = $.Bar.pipe((_: object): type.Any | undefined => {
		wasPiped = true;
		return type("string");
	});

	// previously threw "TypeError: this.Foo1Apply is not a function"
	const r = baz({ oneOf: [{}] });

	expect(wasPiped).toEqual(true);
	expect(r?.toString()).toEqual("Type<string>");
});

// https://github.com/arktypeio/arktype/issues/1367
it("cyclic discriminated union issue 2", () => {
	const componentModule = type.module({
		container: {
			type: "'container'",
			content: "component",
		},

		flexbox: {
			type: "'flexbox'",
			items: "component",
		},

		tabsItem: {
			id: "string",
			title: "component",
			content: "component",
		},
		tabs: {
			type: "'tabs'",
			items: "tabsItem[]",
		},

		singleComponent: "string | flexbox | tabs",
		component: "singleComponent | singleComponent[]",
	});
	const componentSchema = componentModule.component;

	const component: typeof componentSchema.infer = {
		type: "tabs",
		items: [
			{
				id: "tab-id",
				title: "tab-title",
				content: [],
			},
		],
	};

	const result = componentSchema(component);

	expect(result).toEqual(component);
});

// https://github.com/arktypeio/arktype/issues/1362
it("cyclic discriminated union with private alias", () => {
	const componentModule = type.module({
		"#tabsItem": {
			id: "string",
			title: "component",
			content: "component",
		},
		tabs: {
			type: "'tabs'",
			items: "tabsItem[]",
		},
		component: "string | tabs",
	});
	const componentSchema = componentModule.component;

	const component: typeof componentSchema.infer = {
		type: "tabs",
		items: [],
	};

	// previously threw "TypeError: this.tabs1Apply is not a function"
	expect(componentSchema(component)).toEqual(component);
});

// https://github.com/arktypeio/arktype/issues/1209
it("cyclic discriminated union issue 3", () => {
	const $ = scope({
		literal: '"foo"',
		record: {
			"[string]": "value",
		},
		value: "literal|literal[]|record",
	}).export();

	const result = $.value({});

	expect(result).toEqual({});
});

// https://github.com/arktypeio/arktype/issues/1284
it("cyclic discriminated union issue 4", () => {
	const ruleset = scope({
		TypeX: {
			id: "string",
			"+": "reject",
		},
		// always worked
		TypeA: {
			label: "string",
			id: "string",
			"result?": "TypeA | TypeX",
			"+": "reject",
		},
		// previously did not work
		TypeB: {
			label: "string",
			id: "string",
			"result?": "TypeB | TypeX | null",
			"+": "reject",
		},
		// always worked
		TypeC: {
			label: "string",
			id: "string",
			"result?": "TypeA | TypeX | null",
			"+": "reject",
		},
	});
	const types = ruleset.export();

	const data = {
		label: "hi",
		id: "C",
		result: { label: "A", id: "B" },
	};

	expect(types.TypeA(data)).toEqual(data);
	// previously resulted in error:
	// result.label must be removed
	expect(types.TypeB(data)).toEqual(data);
	expect(types.TypeC(data)).toEqual(data);
});
