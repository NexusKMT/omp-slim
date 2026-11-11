import { describe, expect, test } from "bun:test";
import { shouldEnableAppendOnlyContext } from "@oh-my-pi/pi-coding-agent/config/append-only-context-mode";

describe("shouldEnableAppendOnlyContext", () => {
	test("honors explicit settings without model-name policies", () => {
		expect(shouldEnableAppendOnlyContext("on")).toBe(true);
		expect(shouldEnableAppendOnlyContext("off")).toBe(false);
		expect(shouldEnableAppendOnlyContext("auto")).toBe(false);
		expect(shouldEnableAppendOnlyContext(undefined)).toBe(false);
	});
});
