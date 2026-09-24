import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { validateAgentCompactionThresholdOverrides } from "@oh-my-pi/pi-coding-agent/config/compaction-threshold";

describe("task.agentCompactionThresholdOverrides", () => {
	it("normalizes sparse finite numeric entries into both child settings", () => {
		expect(validateAgentCompactionThresholdOverrides(undefined)).toEqual({});
		expect(validateAgentCompactionThresholdOverrides(null)).toEqual({});
		expect(
			validateAgentCompactionThresholdOverrides({
				scout: { thresholdPercent: 80 },
				task: { thresholdTokens: -1 },
				eval: { thresholdPercent: 150, thresholdTokens: -90000 },
			}),
		).toEqual({
			scout: { thresholdPercent: 80, thresholdTokens: -1 },
			task: { thresholdPercent: -1, thresholdTokens: -1 },
			eval: { thresholdPercent: 150, thresholdTokens: -90000 },
		});
	});

	it("rejects malformed maps, agent entries, and threshold fields", () => {
		const malformed: [unknown, string][] = [
			["scout: 80%", "Invalid task.agentCompactionThresholdOverrides"],
			[[], "Invalid task.agentCompactionThresholdOverrides"],
			[{ scout: 90000 }, "task.agentCompactionThresholdOverrides.scout"],
			[{ scout: [] }, "task.agentCompactionThresholdOverrides.scout"],
			[{ scout: {} }, "task.agentCompactionThresholdOverrides.scout"],
			[{ scout: { thresholdPercnt: 80 } }, "task.agentCompactionThresholdOverrides.scout.thresholdPercnt"],
			[{ scout: { thresholdPercent: "80" } }, "task.agentCompactionThresholdOverrides.scout.thresholdPercent"],
			[
				{ scout: { thresholdTokens: Number.POSITIVE_INFINITY } },
				"task.agentCompactionThresholdOverrides.scout.thresholdTokens",
			],
			[{ scout: { thresholdPercent: Number.NaN } }, "task.agentCompactionThresholdOverrides.scout.thresholdPercent"],
		];
		for (const [value, message] of malformed) {
			expect(() => validateAgentCompactionThresholdOverrides(value)).toThrow(message);
		}
	});

	it("rejects malformed values while loading settings", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-compaction-threshold-"));
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "project");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(cwd, { recursive: true });

		try {
			await fs.writeFile(
				path.join(agentDir, "config.yml"),
				JSON.stringify({
					task: { agentCompactionThresholdOverrides: { scout: { thresholdPercent: 80 } } },
				}),
			);
			const valid = await Settings.loadReadOnly({ agentDir, cwd });
			expect(valid.get("task.agentCompactionThresholdOverrides")).toEqual({
				scout: { thresholdPercent: 80 },
			});

			const malformed: { value: unknown; message: string }[] = [
				{ value: "scout: 80%", message: "Invalid task.agentCompactionThresholdOverrides" },
				{ value: [], message: "Invalid task.agentCompactionThresholdOverrides" },
				{ value: { scout: 90000 }, message: "task.agentCompactionThresholdOverrides.scout" },
				{ value: { scout: {} }, message: "task.agentCompactionThresholdOverrides.scout" },
				{
					value: { scout: { thresholdPercnt: 80 } },
					message: "task.agentCompactionThresholdOverrides.scout.thresholdPercnt",
				},
				{
					value: { scout: { thresholdPercent: "80" } },
					message: "task.agentCompactionThresholdOverrides.scout.thresholdPercent",
				},
			];
			for (const invalid of malformed) {
				await fs.writeFile(
					path.join(agentDir, "config.yml"),
					JSON.stringify({ task: { agentCompactionThresholdOverrides: invalid.value } }),
				);
				await expect(Settings.loadReadOnly({ agentDir, cwd })).rejects.toThrow(invalid.message);
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("rejects invalid set and override calls without changing the effective value", () => {
		const settings = Settings.isolated();
		const valid = { scout: { thresholdTokens: 90000 } };
		settings.override("task.agentCompactionThresholdOverrides", valid);
		const previous = structuredClone(settings.get("task.agentCompactionThresholdOverrides"));

		expect(() =>
			settings.set("task.agentCompactionThresholdOverrides", {
				scout: { thresholdPercent: Number.NaN },
			}),
		).toThrow("task.agentCompactionThresholdOverrides.scout.thresholdPercent");
		expect(settings.get("task.agentCompactionThresholdOverrides")).toEqual(previous);

		expect(() =>
			settings.override("task.agentCompactionThresholdOverrides", {
				scout: { thresholdTokens: Number.POSITIVE_INFINITY },
			}),
		).toThrow("task.agentCompactionThresholdOverrides.scout.thresholdTokens");
		expect(settings.get("task.agentCompactionThresholdOverrides")).toEqual(previous);
	});
});
