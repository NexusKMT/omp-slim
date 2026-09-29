import { describe, expect, it } from "bun:test";
import { estimateCost, estimateTokens } from "@oh-my-pi/pi-mnemopi/core/token-counter";

describe("token counter", () => {
	it("uses the Python fallback token estimate and pricing table", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcdefghijkl")).toBe(3);
		expect(estimateTokens("abc")).toBe(0);
		expect(estimateCost(1_000_000, "gpt-4o-mini")).toEqual({
			tokens: 1_000_000,
			model: "gpt-4o-mini",
			cost_usd: 0.15,
			rate_per_1m: 0.15,
		});
		expect(estimateCost(333, "unknown-model")).toEqual({
			tokens: 333,
			model: "unknown-model",
			cost_usd: 0.000999,
			rate_per_1m: 3.0,
		});
	});
});
