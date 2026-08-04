import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

it("built-in prototypes", () => {
	const A = type({
		age: "number",
	});

	const B = type({
		ages: A.array(),
	});

	const C = rootSchema(B.json as never);

	expect(B.json).toEqual(C.json);
});
