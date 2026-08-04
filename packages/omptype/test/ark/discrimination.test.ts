import { expect, it } from "bun:test";
import { registeredReference } from "@ark/schema";
import { scope, type } from "@oh-my-pi/omptype/ark";

it("2 literal branches", () => {
	// should not use a switch with <=2 branches to avoid needless convolution
	const T = type("'a'|'b'");
	expect(T.json).toEqual([{ unit: "a" }, { unit: "b" }]);
	expect(T.internal.assertHasKind("union").discriminantJson).toEqual({
		kind: "unit",
		path: [],
		cases: { '"a"': true, '"b"': true },
	});
	expect(T.allows("a")).toEqual(true);
	expect(T.allows("b")).toEqual(true);
	expect(T.allows("c")).toEqual(false);
});

it(">2 literal branches", () => {
	const T = type("'a'|'b'|'c'");
	expect(T.json).toEqual([{ unit: "a" }, { unit: "b" }, { unit: "c" }]);
	expect(T.internal.assertHasKind("union").discriminantJson).toEqual({
		kind: "unit",
		path: [],
		cases: { '"a"': true, '"b"': true, '"c"': true },
	});
	expect(T.allows("a")).toEqual(true);
	expect(T.allows("b")).toEqual(true);
	expect(T.allows("c")).toEqual(true);
	expect(T.allows("d")).toEqual(false);
});

it(">2 domain branches", () => {
	const T = type("string|bigint|number");
	expect(T.json).toEqual(["bigint", "number", "string"]);
	expect(T.internal.assertHasKind("union").discriminantJson).toEqual({
		kind: "domain",
		path: [],
		cases: { '"bigint"': true, '"number"': true, '"string"': true },
	});
	expect(T.allows("foo")).toEqual(true);
	expect(T.allows(5n)).toEqual(true);
	expect(T.allows(5)).toEqual(true);
	expect(T.allows(true)).toEqual(false);
});

it("literals can be included in domain branches", () => {
	const T = type("string|bigint|true");
	expect(T.json).toEqual(["bigint", "string", { unit: true }]);
	expect(T.internal.assertHasKind("union").discriminantJson).toEqual({
		kind: "domain",
		path: [],
		cases: { '"bigint"': true, '"string"': true, '"boolean"': { unit: true } },
	});
	expect(T.allows("foo")).toEqual(true);
	expect(T.allows(5n)).toEqual(true);
	expect(T.allows(true)).toEqual(true);
	expect(T.allows(5)).toEqual(false);
});

const getPlaces = () =>
	scope({
		rainForest: {
			climate: "'wet'",
			color: "'green'",
			isRainForest: "true",
		},
		desert: { climate: "'dry'", color: "'brown'", isDesert: "true" },
		sky: { climate: "'dry'", color: "'blue'", isSky: "true" },
		ocean: { climate: "'wet'", color: "'blue'", isOcean: "true" },
	});

it("nested", () => {
	const $ = getPlaces();
	const climate = $.type("ocean | sky | rainForest | desert");

	const missingLabel = climate({
		climate: "wet",
		color: "blue",
	});

	expect(missingLabel.toString()).toBe("isOcean must be true (was missing)");

	const twoMissingKeys = climate({
		color: "blue",
	});

	expect(twoMissingKeys.toString()).toBe('climate must be "dry" or "wet" (was undefined)');

	expect(climate.internal.assertHasKind("union").discriminantJson).toEqual({
		kind: "unit",
		path: ["color"],
		cases: {
			'"blue"': {
				kind: "unit",
				path: ["climate"],
				cases: {
					'"dry"': { required: [{ key: "isSky", value: { unit: true } }] },
					'"wet"': { required: [{ key: "isOcean", value: { unit: true } }] },
				},
			},
			'"brown"': {
				required: [
					{ key: "climate", value: { unit: "dry" } },
					{ key: "isDesert", value: { unit: true } },
				],
			},
			'"green"': {
				required: [
					{ key: "climate", value: { unit: "wet" } },
					{ key: "isRainForest", value: { unit: true } },
				],
			},
		},
	});
});

it("indiscriminable", () => {
	const T = getPlaces().type([
		"ocean",
		"|",
		{
			climate: "'wet'",
			color: "'blue'",
			indistinguishableFrom: "ocean",
		},
	]);

	expect(T.internal.assertHasKind("union").discriminantJson).toEqual(null);
});

it("discriminate optional key", () => {
	const T = type({
		direction: "'forward' | 'backward'",
		"operator?": "'by'",
	}).or({
		duration: "'s' | 'min' | 'h'",
		operator: "'to'",
	});

	expect(T.internal.assertHasKind("union").discriminantJson).toEqual(null);
});

it("overlapping default case", () => {
	const T = getPlaces().type(["ocean|rainForest", "|", { temperature: "'hot'" }]);

	expect(T.internal.assertHasKind("union").discriminantJson).toEqual({
		kind: "unit",
		path: ["color"],
		cases: {
			'"blue"': [
				{
					required: [
						{ key: "climate", value: { unit: "wet" } },
						{ key: "isOcean", value: { unit: true } },
					],
				},
				{ required: [{ key: "temperature", value: { unit: "hot" } }] },
			],
			'"green"': [
				{
					required: [
						{ key: "climate", value: { unit: "wet" } },
						{ key: "isRainForest", value: { unit: true } },
					],
				},
				{ required: [{ key: "temperature", value: { unit: "hot" } }] },
			],
			default: {
				required: [{ key: "temperature", value: { unit: "hot" } }],
				domain: "object",
			},
		},
	});
});

it("discriminable default", () => {
	const T = getPlaces().type([{ temperature: "'cold'" }, "|", ["ocean|rainForest", "|", { temperature: "'hot'" }]]);

	expect(T.internal.assertHasKind("union").discriminantJson).toEqual({
		kind: "unit",
		path: ["color"],
		cases: {
			'"blue"': {
				kind: "unit",
				path: ["temperature"],
				cases: {
					'"cold"': true,
					'"hot"': true,
					default: {
						required: [
							{ key: "climate", value: { unit: "wet" } },
							{ key: "isOcean", value: { unit: true } },
						],
					},
				},
			},
			'"green"': {
				kind: "unit",
				path: ["temperature"],
				cases: {
					'"cold"': true,
					'"hot"': true,
					default: {
						required: [
							{ key: "climate", value: { unit: "wet" } },
							{ key: "isRainForest", value: { unit: true } },
						],
					},
				},
			},
			default: {
				kind: "unit",
				path: ["temperature"],
				cases: { '"cold"': true, '"hot"': true },
			},
		},
	});
});

it("won't discriminate between possibly empty arrays", () => {
	const T = type("string[]|boolean[]");
	expect(T.internal.assertHasKind("union").discriminantJson).toEqual(null);
});

it("discriminant path including symbol", () => {
	const s = Symbol("lobmyS");
	const sRef = registeredReference(s);
	const T = type({ [s]: "0" }).or({ [s]: "1" });
	expect(T.internal.assertHasKind("union").discriminantJson).toEqual({
		kind: "unit",
		path: [sRef],
		cases: {
			"0": true,
			"1": true,
		},
	});

	expect(T.allows({ [s]: 0 })).toEqual(true);
	expect(T.allows({ [s]: -1 })).toEqual(false);

	expect(T({ [s]: 1 })).toEqual({ [s]: 1 });
	expect(T({ [s]: 2 }).toString()).toBe("value at [Symbol(lobmyS)] must be 0 or 1 (was 2)");
});

// https://github.com/arktypeio/arktype/issues/1100
it("discriminated null + object", () => {
	const Company = type({
		id: "number",
	}).or("string | null");

	expect(Company(null)).toEqual(null);
	expect(Company({ id: 1 })).toEqual({ id: 1 });
	expect(Company("foo")).toEqual("foo");
	expect(String(Company(5))).toBe("must be an object or a string or null (was 5)");
});

it("differing inner discriminated paths", () => {
	const Discriminated = type(
		{
			innerA: {
				id: "1",
			},
		},
		"|",
		{
			innerB: {
				id: "1",
			},
		},
	)
		.or({ innerA: { id: "2" } })
		.or({ innerB: { id: "2" } });

	const Union = Discriminated.internal.assertHasKind("union");

	expect(Union.discriminantJson).toEqual({
		kind: "unit",
		path: ["innerA", "id"],
		cases: {
			"1": true,
			"2": true,
			default: {
				kind: "unit",
				path: ["innerB", "id"],
				cases: { "1": true, "2": true },
			},
		},
	});

	expect(Union({ innerA: { id: 1 } })).toEqual({ innerA: { id: 1 } });
	expect(Union({ innerB: { id: 1 } })).toEqual({ innerB: { id: 1 } });
	expect(Union({ innerA: { id: 2 } })).toEqual({ innerA: { id: 2 } });
	expect(Union({ innerB: { id: 2 } })).toEqual({ innerB: { id: 2 } });

	expect(Union({})?.toString()).toBe("innerB.id must be 1 or 2 (was undefined)");
});

it("allows strict discriminated keys", () => {
	const AorB = type({
		type: "'A'",
	})
		.or({
			type: "'B'",
		})
		.onUndeclaredKey("reject");

	expect(AorB.internal.assertHasKind("union").discriminantJson).toEqual({
		kind: "unit",
		path: ["type"],
		cases: {
			'"A"': { undeclared: "reject", required: [{ key: "type", value: {} }] },
			'"B"': { undeclared: "reject", required: [{ key: "type", value: {} }] },
		},
	});

	expect(AorB({ type: "A" })).toEqual({ type: "A" });
});

it("can discriminated objects with disjoint strict keys", () => {
	const AorB = type({
		"+": "reject",
		something: "'A'",
	}).or({
		"+": "reject",
		something: "'B'",
		somethingelse: "number",
	});

	expect(AorB.internal.assertHasKind("union").discriminantJson).toEqual({
		kind: "unit",
		path: ["something"],
		cases: {
			'"A"': {
				undeclared: "reject",
				required: [{ key: "something", value: {} }],
			},
			'"B"': {
				undeclared: "reject",
				required: [
					{ key: "something", value: {} },
					{ key: "somethingelse", value: "number" },
				],
			},
		},
	});

	expect(AorB({ something: "A" })).toEqual({ something: "A" });
});

it("includes non-disjoint branches in corresponding cases", () => {
	const T = type({
		id: "0",
		k1: "number",
	})
		.or({ id: "1", k1: "number" })
		.or({
			name: "string",
		});

	expect(T.internal.assertHasKind("union").discriminantJson).toEqual({
		kind: "unit",
		path: ["id"],
		cases: {
			"0": [{ required: [{ key: "k1", value: "number" }] }, { required: [{ key: "name", value: "string" }] }],
			"1": [{ required: [{ key: "k1", value: "number" }] }, { required: [{ key: "name", value: "string" }] }],
			default: {
				required: [{ key: "name", value: "string" }],
				domain: "object",
			},
		},
	});

	// should hit the case discriminated for id: 1,
	// but still resolve correctly via the { name: string } branch
	expect(T({ name: "foo", id: 1 })).toEqual({ name: "foo", id: 1 });
});

it("correctly dsicriminated onDeclaredKey: reject in the above scenario", () => {
	const T = type({
		id: "0",
		k1: "number",
	})
		.or({ id: "1", k1: "number" })
		.or({
			"+": "reject",
			name: "string",
		});

	expect(T.internal.assertHasKind("union").discriminantJson).toEqual({
		kind: "unit",
		path: ["id"],
		cases: {
			"0": { required: [{ key: "k1", value: "number" }] },
			"1": { required: [{ key: "k1", value: "number" }] },
			default: {
				undeclared: "reject",
				required: [{ key: "name", value: "string" }],
				domain: "object",
			},
		},
	});

	// now that we are rejecting undeclared keys, all branches fail
	expect(T({ name: "foo", id: 1 }).toString()).toBe("k1 must be a number (was missing)");
});

it("discriminate array and tuple", () => {
	const T = type("null[] | false").or([type.undefined]);

	const { discriminantJson } = T.select({
		kind: "union",
		method: "assertFind",
	});

	expect(discriminantJson).toEqual({
		kind: "domain",
		path: [],
		cases: {
			'"object"': [
				{
					sequence: { prefix: [{ unit: "undefined" }] },
					proto: "Array",
					exactLength: 1,
				},
				{ sequence: { unit: null }, proto: "Array" },
			],
			'"boolean"': { unit: false },
		},
	});
});

it("discriminate bounded array and tuple", () => {
	const T = type("3 <= null[] <= 10 | false").or([type.undefined]);

	const { discriminantJson } = T.select({
		kind: "union",
		method: "assertFind",
	});

	expect(discriminantJson).toEqual({
		kind: "domain",
		path: [],
		cases: {
			'"object"': [
				{
					sequence: { prefix: [{ unit: "undefined" }] },
					proto: "Array",
					exactLength: 1,
				},
				{
					sequence: { unit: null },
					proto: "Array",
					maxLength: 10,
					minLength: 3,
				},
			],
			'"boolean"': { unit: false },
		},
	});
});

it("dimscrinate literal undefined value", () => {
	const T = type(["number[]", "|", ["undefined"]]);

	expect(T.assert([])).toEqual([]);
});

// https://github.com/arktypeio/arktype/issues/1547
it("discriminates cyclic union on nested path", () => {
	const s = scope({
		AChild: { type: "'AChild'", children: "(AParent)[] > 0" },
		AParent: { type: "'AParent'", children: "(AChild)[] > 0" },
		BChild: { type: "'BChild'", children: "unknown[]" },
		BParent: {
			type: "'BParent'",
			layout: "number[]",
			children: "(BChild)[] > 0",
		},
	});

	const Thing = s.type("AParent | BParent");

	expect(Thing.internal.assertHasKind("union").discriminantJson).toEqual({
		kind: "unit",
		path: ["type"],
		cases: {
			'"BParent"': {
				required: [
					{
						key: "children",
						value: {
							sequence: {
								required: [
									{ key: "children", value: "Array" },
									{ key: "type", value: { unit: "BChild" } },
								],
								domain: "object",
							},
							proto: "Array",
							minLength: 1,
						},
					},
					{ key: "layout", value: { sequence: "number", proto: "Array" } },
				],
			},
			'"AParent"': {
				required: [
					{
						key: "children",
						value: {
							sequence: {
								required: [
									{
										key: "children",
										value: {
											sequence: "$AParent",
											proto: "Array",
											minLength: 1,
										},
									},
									{ key: "type", value: { unit: "AChild" } },
								],
								domain: "object",
							},
							proto: "Array",
							minLength: 1,
						},
					},
				],
			},
		},
	});

	expect(Thing({
			type: "BParent",
			layout: "",
			children: [{ type: "BChild", children: [] }],
		}).toString()).toBe("layout must be an array (was string)");
});
