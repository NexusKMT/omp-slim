import { describe, expect, it } from "bun:test";
import {
	resolveAgentCompactionThresholdOverride,
	validateAgentCompactionThresholdOverrides,
} from "@oh-my-pi/pi-coding-agent/config/compaction-threshold";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

describe("task.agentCompactionThresholdOverrides", () => {
	it("maps percentages and token limits to mutually exclusive compaction settings", () => {
		expect(resolveAgentCompactionThresholdOverride("80%")).toEqual({
			"compaction.thresholdPercent": 80,
			"compaction.thresholdTokens": -1,
		});
		expect(resolveAgentCompactionThresholdOverride("90000")).toEqual({
			"compaction.thresholdPercent": -1,
			"compaction.thresholdTokens": 90000,
		});
	});

	it("rejects malformed override values", () => {
		for (const override of ["0%", "100%", "1.5%", "0", "-1", "90000.5", "01", "9007199254740992"]) {
			expect(() => resolveAgentCompactionThresholdOverride(override)).toThrow();
			expect(() => validateAgentCompactionThresholdOverrides({ scout: override })).toThrow();
		}
		expect(() => validateAgentCompactionThresholdOverrides({ scout: 90000 })).toThrow();
	});

	it("rejects malformed setting containers and values during settings load", async () => {
		await expect(
			Settings.loadIsolated({
				inMemory: true,
				overrides: { "task.agentCompactionThresholdOverrides": "scout: 80%" },
			}),
		).rejects.toThrow(
			"Invalid task.agentCompactionThresholdOverrides: expected a map of agent name to compaction threshold, got a string.",
		);
		await expect(
			Settings.loadIsolated({
				inMemory: true,
				overrides: { "task.agentCompactionThresholdOverrides": { scout: "100%" } },
			}),
		).rejects.toThrow("Invalid compaction threshold for task.agentCompactionThresholdOverrides.scout");

		expect(() => validateAgentCompactionThresholdOverrides([{ scout: "80%" }])).toThrow("got an array.");
		expect(() => validateAgentCompactionThresholdOverrides(null)).toThrow("got null.");
	});
});
