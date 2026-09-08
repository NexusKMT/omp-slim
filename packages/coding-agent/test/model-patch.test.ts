import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { applyModelPatch } from "../src/config/model-patch";

describe("applyModelPatch", () => {
	test("preserves explicit capacity across later overrides and custom replacements", () => {
		const base = buildModel({
			id: "claude-mythos-5",
			name: "Mythos",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: null,
		});
		expect(base.contextWindow).toBe(1_000_000);
		expect(base.maxTokens).toBe(128_000);

		const limited = applyModelPatch(base, { contextWindow: 400_000, maxTokens: 16_000 }, "merge");
		const overridden = applyModelPatch(limited, { headers: { "x-custom": "value" } }, "merge");
		expect(overridden.contextWindow).toBe(400_000);
		expect(overridden.maxTokens).toBe(16_000);

		const replacement = applyModelPatch(overridden, { name: "Custom Mythos" }, "replace");
		expect(replacement.contextWindow).toBe(400_000);
		expect(replacement.maxTokens).toBe(16_000);

		const resized = applyModelPatch(replacement, { contextWindow: 200_000, maxTokens: 8_000 }, "merge");
		expect(resized.contextWindow).toBe(200_000);
		expect(resized.maxTokens).toBe(8_000);
	});
});
