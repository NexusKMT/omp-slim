import { describe, expect, test } from "bun:test";
import { shouldInlineToolDescriptors } from "@oh-my-pi/pi-coding-agent/config/inline-tool-descriptors-mode";

describe("shouldInlineToolDescriptors", () => {
	test("honors explicit on and off regardless of model", () => {
		expect(shouldInlineToolDescriptors("on")).toBe(true);
		expect(shouldInlineToolDescriptors("off")).toBe(false);
	});

	test("auto stays off", () => {
		expect(shouldInlineToolDescriptors("auto")).toBe(false);
		expect(shouldInlineToolDescriptors(undefined)).toBe(false);
	});
});
