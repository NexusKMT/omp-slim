import { describe, expect, it } from "bun:test";

import { RequestIdAllocator } from "../../src/mcp/request-id";

describe("RequestIdAllocator", () => {
	it("defaults to unique string ids", () => {
		const allocator = new RequestIdAllocator();
		const ids = [allocator.next(undefined), allocator.next(undefined), allocator.next("string")];

		expect(ids.every(id => typeof id === "string")).toBe(true);
		expect(new Set(ids).size).toBe(3);
	});

	it("issues sequential integers from 1 for integer-only decoders", () => {
		const allocator = new RequestIdAllocator();

		expect([allocator.next("number"), allocator.next("number"), allocator.next("number")]).toEqual([1, 2, 3]);
	});

	it("counts independently per transport instance", () => {
		const first = new RequestIdAllocator();
		const second = new RequestIdAllocator();

		first.next("number");
		first.next("number");

		expect(second.next("number")).toBe(1);
	});

	it("reads the format at call time so a reconfigured server takes effect", () => {
		const allocator = new RequestIdAllocator();

		expect(typeof allocator.next(undefined)).toBe("string");
		expect(allocator.next("number")).toBe(1);
	});

	it("never reuses a numeric id, so a reconnect cannot collide with a late reply", () => {
		const allocator = new RequestIdAllocator();
		const before = allocator.next("number");
		allocator.next("string");

		expect(allocator.next("number")).toBeGreaterThan(before as number);
	});
});
