import { describe, expect, test } from "bun:test";
import { shouldInlineToolDescriptors } from "@oh-my-pi/pi-coding-agent/config/inline-tool-descriptors-mode";

describe("shouldInlineToolDescriptors", () => {
	test("honors explicit settings without model-name policies", () => {
		expect(shouldInlineToolDescriptors("on")).toBe(true);
		expect(shouldInlineToolDescriptors("off")).toBe(false);
		expect(shouldInlineToolDescriptors("auto")).toBe(false);
		expect(shouldInlineToolDescriptors(undefined)).toBe(false);
	});
});
