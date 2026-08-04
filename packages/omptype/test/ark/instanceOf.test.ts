import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

describe("tuple expression", () => {
	it("base", () => {
		const T = type(["instanceof", Error]);
		expect<Error>(T.infer);
		const Expected = rootSchema(Error);
		expect(T.json).toEqual(Expected.json);
		const e = new Error();
		expect(T(e)).toEqual(e);
		expect(T(e)).toEqual(e);
		expect(T({}).toString()).toEqual("must be an Error (was object)");
		expect(T(undefined).toString()).toEqual("must be an Error (was undefined)");
	});

	it("fluent", () => {
		const T = type.instanceOf(Error);

		const Expected = type(["instanceof", Error]);

		expect<typeof Expected.t>(T.t);
		expect(T.expression).toEqual(Expected.expression);
	});

	it("inherited", () => {
		const T = type(["instanceof", TypeError]);
		const e = new TypeError();
		// for some reason the return of TypeError's constructor is actually
		// inferred as Error? Disabling this check for now, seems like an anomaly.
		// expect<TypeError>(T.infer)
		expect(T(e)).toEqual(e);
		expect(T(new Error()).toString()).toEqual("must be an instance of TypeError (was Error)");
	});
	it("abstract", () => {
		abstract class Base {
			abstract foo: string;
		}
		class Sub extends Base {
			foo = "";
		}
		const T = type(["instanceof", Base]);
		expect<Base>(T.infer);
		const sub = new Sub();
		expect(T(sub)).toEqual(sub);
	});
	it("multiple branches", () => {
		const T = type(["instanceof", Date, Array]);
		expect<Date | unknown[]>(T.infer);
	});
	it("non-constructor", () => {
		// @ts-expect-error
		expect(() => type(["instanceof", () => {}])).toThrow("Type '() => void' is not assignable to type");
	});

	// If perf cost too high can use global type config to expand ArkEnv.preserve
	it("user-defined class", () => {
		class ArkClass {
			isArk = true;
		}
		const Ark = type(["instanceof", ArkClass]);
		expect<ArkClass>(Ark.t);
		// not expanded since there are no morphs
		expect(Ark.infer).toEqual("ArkClass");
		expect(Ark.in.infer).toEqual("ArkClass");
		const a = new ArkClass();
		expect(Ark(a)).toEqual(a);
		expect(Ark({}).toString()).toEqual("must be an instance of ArkClass (was object)");
	});
	it("bidirectional checks doesn't break pipe inference", () => {
		const T = type({
			f: ["string", "=>", () => [] as unknown],
		});
		// Should be inferred as {f: unknown}
		expect<{ f: unknown }>(T.infer);
	});

	it("class with private properties", () => {
		class ArkClass {}
		const Ark = type(["instanceof", ArkClass]);

		expect<ArkClass>(Ark.t);
		// not expanded since there are no morphs
		expect(Ark.infer).toEqual("ArkClass");
		expect(Ark.in.infer).toEqual("ArkClass");
	});

	it("parse error on non-function", () => {
		// @ts-expect-error
		expect(() => type.instanceOf({}))
			.throws(Proto.writeInvalidSchemaMessage({}))
			.toThrow("not assignable to parameter of type 'Constructor<object>'");
	});
});

describe("root expression", () => {
	it("class", () => {
		const T = type("instanceof", Error);
		expect<Error>(T.infer);
		expect(T.json).toEqual(type(["instanceof", Error]).json);
	});
	it("instance branches", () => {
		const T = type("instanceof", Date, Map);
		expect<Date | Map<unknown, unknown>>(T.infer);
		expect(T.json).toEqual(type("Date | Map").json);
	});
	it("non-constructor", () => {
		// @ts-expect-error just an assignability failure so we can't validate an error message
		expect(() => type("instanceof", new Error())).toThrow(writeInvalidConstructorMessage("Error"));
	});
});
