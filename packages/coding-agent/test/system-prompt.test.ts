import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/core/system-prompt";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				toolNames: [],
				contextFiles: [],
				skills: [],
			});

			// System prompt uses <tools> XML tag format
			expect(prompt).toContain("<tools>\n(none)\n</tools>");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				toolNames: [],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});
	});
});
