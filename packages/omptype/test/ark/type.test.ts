import { expect, it } from "bun:test";
import { scope, Type, type } from "@oh-my-pi/omptype/ark";

it("root discriminates", () => {
	const T = type("string");
	const out = T("");
	if (out instanceof type.errors) out.throw();
	else expect<string>(out);
});

it("allows", () => {
	const T = type("number%2");
	const data: unknown = 4;
	if (T.allows(data)) {
		// narrows correctly
		expect<number>(data);
	} else throw new Error();

	expect(T.allows(5)).toEqual(false);
});

it("allows doc example", () => {
	const Numeric = type("number | bigint");
	const numerics = [0, "one", 2n].filter(Numeric.allows);
	expect(numerics).toEqual([0, 2n]);
});

it("extends doc example", () => {
	const N = type(Math.random() > 0.5 ? "boolean" : "string");
	expect(N.expression).toEqual("string | boolean");
	const ez = N.ifExtends("boolean");
	expect(ez?.expression).toEqual("'boolean' | undefined");
});

it("errors can be thrown", () => {
	const T = type("number");
	try {
		const result = T("invalid");
		if (result instanceof type.errors) result.throw();
	} catch (e) {
		expect(e).toBeInstanceOf(TraversalError);
		expect((e as TraversalError).arkErrors instanceof type.errors);
		return;
	}
	throw new assert.AssertionError({ message: "Expected to throw" });
});

it("assert", () => {
	const T = type({ a: "string" });
	expect(T.assert({ a: "1" })).toEqual({ a: "1" });
	expect(() => T.assert({ a: 1 })).toThrow("TraversalError: a must be a string (was a number)");
});

it("select", () => {
	const Units = type("'red' | 'blue'").select("unit");

	expect<UnitNode[]>(Units);
	expect(Units).toEqual([{ unit: "blue" }, { unit: "red" }]);
});

it("is treated as covariant", () => {
	type("1") satisfies Type<number>;

	// @ts-expect-error
	expect(() => type("1") satisfies Type<string>).toThrow(
		"missing the following properties from type 'Type<string, {}>'",
	);

	// errors correctly if t is declared as its own type param
	const accept = <t extends string>(t: Type<t>) => t;

	const T = type("1");

	// @ts-expect-error
	expect(() => accept(T)).toThrow(
		"Argument of type 'Type<1, {}>' is not assignable to parameter of type 'Type<string, {}>'",
	);
});

// the negative cases of these assignability tests
// contribute a ton of instantiations and check time

it("base signature obeys assignability rules", () => {
	type("'foo'[]") satisfies Type<string[]>;

	// @ts-expect-error
	expect(() => type("number[]") satisfies Type<string[]>).toThrow("Type 'number' is not assignable to type 'string'");
});

it("args signature obeys assignability rules", () => {
	type("'foo'", "[]") satisfies Type<string[]>;

	// @ts-expect-error
	expect(() => type("number", "[]") satisfies Type<string[]>).toThrow(
		"Type 'number' is not assignable to type 'string'",
	);
});

it("type.Any allows arbitrary scope", () => {
	const foo = scope({
		foo: "string",
	}).resolve("foo");

	foo satisfies type.Any<string>;

	// @ts-expect-error (fails with default ambient type)
	expect((): Type<string> => foo).toThrow(
		"Type<string, { foo: string; }>' is not assignable to type 'Type<string, {}>'",
	);
});

it("distribute", () => {
	const T = type("===", 0, "1", "2", 3, "4", 5);

	const numbers = T.distribute(
		n => n.ifExtends(type.number) ?? type.raw(n.expression.slice(1, -1)).as<number>(),
		branches => type.raw(branches).as<number[]>(),
	);

	expect(numbers.expression).toEqual("[1, 2, 4, 0, 3, 5]");
});

it("attached types", () => {
	const attachments: Record<keyof Ark.typeAttachments, string | object> = flatMorph({ ...type }, (k, v) =>
		v instanceof Type ? [k, v.expression] : v instanceof Generic ? [k, v.json] : [],
	);

	expect(attachments).toEqual({
		bigint: "bigint",
		boolean: "boolean",
		false: "false",
		never: "never",
		null: "null",
		number: "number",
		object: "object",
		string: "string",
		symbol: "symbol",
		true: "true",
		unknown: "unknown",
		undefined: "undefined",
		arrayIndex: type.arrayIndex.expression,
		Key: "string | symbol",
		Record: keywords.Record.internal.json,
		Date: "Date",
		Array: "Array",
	});

	expect<number>(type.number.t);
});

it("ark attached", () => {
	expect<string>(type.keywords.number.integer.expression).toEqual("number % 1");
});

it("unit", () => {
	const T = type.unit(5);
	expect<5>(T.t);
	expect(T.expression).toEqual("5");
});

it("enumerated", () => {
	const T = type.enumerated(5, true, null);
	expect<5 | true | null>(T.t);
	expect(T.expression).toEqual("5 | null | true");
});

it("schema", () => {
	const T = type.schema({ domain: "string" });
	// uninferred for now
	expect<unknown>(T.t);
	expect(T.expression).toEqual("string");
});

it("ifEquals", () => {
	const T = type("string");
	expect(T.ifEquals("string")).toEqual(T);
	// subtype
	expect(T.ifEquals("'foo'")).toEqual(undefined);
	// supertype
	expect(T.ifEquals("string | number")).toEqual(undefined);
});

it("ifExtends", () => {
	const T = type("string");
	expect<type<string> | undefined>(T.ifExtends("string")).toEqual(T);
	// subtype
	expect<type<"foo"> | undefined>(T.ifExtends("'foo'")).toEqual(undefined);
	// supertype
	expect<type<string | number> | undefined>(T.ifExtends("string | number")).toEqual(T);
});

it("allows assignment to unparameterized Type", () => {
	const T = type({
		name: "string >= 2",
		email: "string.email",
	});

	T satisfies Type;
});

it("allows morph assignment to unparameterized Type", () => {
	const T = type("string").pipe(s => s.length);

	T satisfies Type;
});

it("assert callable as standalone function", () => {
	const { assert } = type("string");

	expect<(data: unknown) => string>(assert);
	expect(assert("foo")).toEqual("foo");
	expect(() => assert(5)).toThrow("TraversalError: must be a string (was a number)");
});

it("toString()", () => {
	// represent a variety of structures to ensure it is correctly composed
	const T = type({
		"[string]": "number | unknown[]",
		a: "1",
		"b?": "2",
		c: ["0 < string < 5", "boolean?", "...", "number[]"],
		d: [["string", "=>", s => s.length], "0 < number % 2 < 100", "...", "bigint[]", "(/^a.*z$/ & string.lower)[]"],
	});
	expect(T.expression).toEqual(
		"{ [string]: number | Array, a: 1, c: [string <= 4 & >= 1, boolean?, ...number[]], d: [(In: string) => Out<unknown>, number % 2 & < 100 & > 0, ...bigint[], (In: /^a.*z$/) => Out</^[a-z]*$/>[]], b?: 2 }",
	);
	expect(`${T}`).toEqual(`Type<${T.expression}>`);
});

it("valueOf", () => {
	//    🪦R.I.P. TS enums🪦
	//         2012-2025
	// Killed by --erasableSyntaxOnly

	// enum TsEnum {
	// 	numeric = 1,
	// 	symmetrical = "symmetrical",
	// 	asymmetrical = "lacirtemmysa"
	// }

	const EquivalentObject = {
		numeric: 1,
		symmetrical: "symmetrical",
		asymmetrical: "lacirtemmysa",
	} as const;

	// TS reverse assigns numeric values
	// need to make sure we don't extract them at runtime

	// Object.assign avoids TS inferring this key (it wouldn't for an enum)
	Object.assign(EquivalentObject, {
		"1": "numeric",
	});

	const T = type.valueOf(EquivalentObject);

	const Expected = type.enumerated(1, "symmetrical", "lacirtemmysa");

	expect<typeof Expected>(T);
	expect(T.expression).toEqual(Expected.expression);
});

it("toJsonSchema docs", () => {
	const User = type({
		name: "string",
		email: "string.email",
		"age?": "number >= 18",
	});

	const schema = User.toJsonSchema();

	const expected: JsonSchema = {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		type: "object",
		properties: {
			name: { type: "string" },
			email: {
				type: "string",
				format: "email",
				pattern: "^[\\w%+.-]+@[\\d.A-Za-z-]+\\.[A-Za-z]{2,}$",
			},
			age: { type: "number", minimum: 18 },
		},
		required: ["email", "name"],
	};

	expect(schema).toEqual(expected);
});
