import { describe, expect, it } from "bun:test";
import { resolveAgentCompactionThresholdOverride } from "@oh-my-pi/pi-coding-agent/config/compaction-threshold";

describe("task.agentCompactionThresholdOverrides", () => {
	it("normalizes finite per-agent threshold fields into both numeric settings", () => {
		expect(resolveAgentCompactionThresholdOverride({ thresholdPercent: 80 })).toEqual({
			thresholdPercent: 80,
			thresholdTokens: -1,
		});
		expect(resolveAgentCompactionThresholdOverride({ thresholdTokens: 90000 })).toEqual({
			thresholdPercent: -1,
			thresholdTokens: 90000,
		});
		expect(resolveAgentCompactionThresholdOverride({ thresholdPercent: 80, thresholdTokens: 90000 })).toEqual({
			thresholdPercent: 80,
			thresholdTokens: 90000,
		});
		expect(
			resolveAgentCompactionThresholdOverride({ thresholdPercent: 80, thresholdTokens: Number.POSITIVE_INFINITY }),
		).toEqual({ thresholdPercent: 80, thresholdTokens: -1 });
	});

	it("silently skips malformed entries and entries without a finite numeric field", () => {
		const malformed: unknown[] = [
			undefined,
			null,
			"80%",
			90000,
			[],
			{},
			{ thresholdPercent: "80", thresholdTokens: "90000" },
			{ thresholdPercent: Number.NaN, thresholdTokens: Number.NEGATIVE_INFINITY },
		];
		for (const value of malformed) {
			expect(resolveAgentCompactionThresholdOverride(value)).toBeUndefined();
		}
		const partiallyNumeric: unknown = { thresholdPercent: "80", thresholdTokens: 90000 };
		expect(resolveAgentCompactionThresholdOverride(partiallyNumeric)).toEqual({
			thresholdPercent: -1,
			thresholdTokens: 90000,
		});
	});
});
