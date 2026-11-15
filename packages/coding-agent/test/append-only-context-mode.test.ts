import { describe, expect, test } from "bun:test";
import { shouldEnableAppendOnlyContext } from "@oh-my-pi/pi-coding-agent/config/append-only-context-mode";

describe("shouldEnableAppendOnlyContext", () => {
	test("honors explicit on and off settings", () => {
		expect(shouldEnableAppendOnlyContext("on")).toBe(true);
		expect(shouldEnableAppendOnlyContext("off")).toBe(false);
	});
});
