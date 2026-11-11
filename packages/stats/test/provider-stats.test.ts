import { describe, expect, it } from "bun:test";
import { getProviderDashboardStats } from "@oh-my-pi/omp-stats/aggregator";
import { initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import type { MessageStats } from "@oh-my-pi/omp-stats/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-providers-");
const T0 = Date.UTC(2026, 6, 20, 10, 0, 0);
const MINUTE = 60_000;

function message(overrides: Partial<MessageStats> & { entryId: string }): MessageStats {
	return {
		sessionFile: "/tmp/session.jsonl",
		folder: "/tmp/project",
		model: "model-x",
		provider: "prov-a",
		api: "openai-completions",
		timestamp: T0,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 600,
			output: 300,
			cacheRead: 100,
			cacheWrite: 0,
			totalTokens: 1000,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
		},
		agentType: "main",
		...overrides,
	};
}

describe("getProviderDashboardStats", () => {
	it("aggregates recorded provider totals, hourly burn, and request series", async () => {
		await initDb();
		insertMessageStats([
			message({ entryId: "a1", provider: "prov-a", timestamp: T0 }),
			message({ entryId: "a2", provider: "prov-a", timestamp: T0 + MINUTE, stopReason: "error" }),
			message({
				entryId: "b1",
				provider: "prov-b",
				model: "model-y",
				timestamp: T0 + 2 * MINUTE,
				usage: {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 150,
					cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
				},
			}),
		]);

		const stats = await getProviderDashboardStats("all");

		expect(stats.providers.map(p => p.provider)).toEqual(["prov-a", "prov-b"]);
		const provA = stats.providers[0];
		expect(provA.totalRequests).toBe(2);
		expect(provA.failedRequests).toBe(1);
		expect(provA.totalTokens).toBe(2000);
		expect(provA.models).toBe(1);

		// All prov-a messages land in one hour bucket. Bun test pins JS `Date`
		// to UTC while SQLite 'localtime' uses the OS timezone, so assert the
		// grouping/summing contract rather than a specific hour value.
		const provAHours = stats.hourly.filter(p => p.provider === "prov-a");
		expect(provAHours).toHaveLength(1);
		expect(provAHours[0].hour).toBeGreaterThanOrEqual(0);
		expect(provAHours[0].hour).toBeLessThan(24);
		expect(provAHours[0].totalTokens).toBe(2000);
		expect(provAHours[0].outputTokens).toBe(600);
		expect(provAHours[0].requests).toBe(2);
		expect(stats.series.some(p => p.provider === "prov-b" && p.totalTokens === 150)).toBe(true);
	});
});
