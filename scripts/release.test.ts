import { describe, expect, test } from "bun:test";
import { isValidExplicitVersion } from "./release";

describe("isValidExplicitVersion", () => {
	test("rejects malformed versions", () => {
		expect(isValidExplicitVersion("999.bad")).toBe(false);
		expect(isValidExplicitVersion("17")).toBe(false);
		expect(isValidExplicitVersion("17.2")).toBe(false);
		expect(isValidExplicitVersion("17.2.8.9")).toBe(false);
		expect(isValidExplicitVersion("v17.2.8.9")).toBe(false);
		expect(isValidExplicitVersion("abc")).toBe(false);
		expect(isValidExplicitVersion("")).toBe(false);
		expect(isValidExplicitVersion("v")).toBe(false);
		expect(isValidExplicitVersion("17.2.8-")).toBe(false);
	});

	test("accepts valid three-segment numeric versions", () => {
		expect(isValidExplicitVersion("17.2.8")).toBe(true);
		expect(isValidExplicitVersion("0.0.0")).toBe(true);
		expect(isValidExplicitVersion("1.0.0")).toBe(true);
	});

	test("accepts leading v prefix", () => {
		expect(isValidExplicitVersion("v17.2.8")).toBe(true);
		expect(isValidExplicitVersion("V17.2.8")).toBe(false);
	});

	test("accepts prerelease suffixes", () => {
		expect(isValidExplicitVersion("17.2.8-rc.1")).toBe(true);
		expect(isValidExplicitVersion("v17.2.8-rc.1")).toBe(true);
		expect(isValidExplicitVersion("1.0.0-beta")).toBe(true);
		expect(isValidExplicitVersion("1.0.0-alpha.1.2")).toBe(true);
		expect(isValidExplicitVersion("1.0.0-0.3.7")).toBe(true);
		expect(isValidExplicitVersion("1.0.0-x.7.z.92")).toBe(true);
	});
});
