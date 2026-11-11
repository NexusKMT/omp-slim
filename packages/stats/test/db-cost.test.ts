import { describe, expect, it } from "bun:test";
import { closeDb, getRecentRequests, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import {
	getCostTimeSeries,
	getOverallStats,
	getSessionRollups,
	getStatsByModel,
	getStatsByProvider,
} from "@oh-my-pi/omp-stats/rollup";
import type { MessageStatsInput } from "@oh-my-pi/omp-stats/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-db-");

function message(entryId: string, cost?: MessageStatsInput["usage"]["cost"]): MessageStatsInput {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder: "/tmp/project",
		model: "custom-model",
		provider: "endpoint",
		api: "openai-completions",
		timestamp: Date.now(),
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100, totalTokens: 1800, cost },
		agentType: "main",
	};
}

const CHARGE = { input: 0.01, output: 0.02, cacheRead: 0.002, cacheWrite: 0.003, total: 0.035 };
const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

describe("recorded request costs", () => {
	it("preserves recorded prices and cache usage across all aggregate views and reopen", async () => {
		await initDb();
		insertMessageStats([message("paid", CHARGE)]);
		const request = getRecentRequests(1)[0];
		expect(request.usage.cost).toEqual(CHARGE);
		expect(request.costUnpriced).toBe(false);
		expect(getOverallStats()).toMatchObject({
			totalRequests: 1,
			totalInputTokens: 1000,
			totalOutputTokens: 500,
			totalCacheReadTokens: 200,
			totalCacheWriteTokens: 100,
			totalCost: CHARGE.total,
			unpricedRequests: 0,
			cacheSavings: 0,
		});
		expect(getOverallStats().cacheRate).toBeCloseTo(200 / 1200, 8);
		expect(getStatsByModel()[0].totalCost).toBe(CHARGE.total);
		expect(getStatsByProvider()[0].totalCost).toBe(CHARGE.total);
		expect(getCostTimeSeries()[0].cost).toBe(CHARGE.total);
		expect(getSessionRollups()[0].costTotal).toBe(CHARGE.total);
		closeDb();
		await initDb();
		expect(getRecentRequests(1)[0].usage.cost).toEqual(CHARGE);
	});

	it("never infers a price from old provider names and preserves explicit free requests", async () => {
		await initDb();
		const legacy = { ...message("legacy", FREE), provider: "xai-oauth", model: "grok-4.6" };
		insertMessageStats([legacy, message("unpriced")]);
		const requests = getRecentRequests(2);
		expect(requests.find(row => row.entryId === "legacy")).toMatchObject({
			costUnpriced: false,
			usage: { cost: FREE },
		});
		expect(requests.find(row => row.entryId === "unpriced")).toMatchObject({
			costUnpriced: true,
			usage: { cost: FREE },
		});
		expect(getOverallStats()).toMatchObject({ totalCost: 0, unpricedRequests: 1 });
		closeDb();
		await initDb();
		expect(getOverallStats()).toMatchObject({ totalCost: 0, unpricedRequests: 1 });
	});

	it("normalizes partial recorded costs without supplying a rate card", async () => {
		await initDb();
		insertMessageStats([
			message("total-only", { total: 1.5 }),
			message("components", { input: 0.2, cacheRead: 0.1 }),
			message("empty", {}),
			message("invalid", { total: Number.NaN }),
		]);
		const byId = new Map(getRecentRequests(4).map(row => [row.entryId, row]));
		expect(byId.get("total-only")?.usage.cost.total).toBe(1.5);
		expect(byId.get("components")?.usage.cost.total).toBeCloseTo(0.3, 10);
		expect(byId.get("empty")?.costUnpriced).toBe(true);
		expect(byId.get("invalid")?.costUnpriced).toBe(true);
		expect(getOverallStats()).toMatchObject({ totalRequests: 4, unpricedRequests: 2 });
		expect(getOverallStats().totalCost).toBeCloseTo(1.8, 10);
	});

	it("updates a re-ingested recorded price without duplicating the request", async () => {
		await initDb();
		const initial = message("updated");
		insertMessageStats([initial]);
		expect(getOverallStats().unpricedRequests).toBe(1);
		insertMessageStats([{ ...initial, usage: { ...initial.usage, cost: CHARGE } }]);
		expect(getOverallStats()).toMatchObject({ totalRequests: 1, totalCost: CHARGE.total, unpricedRequests: 0 });
	});

	it("keeps legacy cache baselines when refreshing a recorded request", async () => {
		const db = await initDb();
		const row = message("historical-cache", CHARGE);
		insertMessageStats([row]);
		expect(
			db.query<{ baseline: number | null }, []>("SELECT cost_no_cache_input AS baseline FROM messages").get()
				?.baseline,
		).toBeNull();
		db.run("UPDATE messages SET cost_no_cache_input = 0.1");
		insertMessageStats([row]);
		expect(
			db.query<{ baseline: number | null }, []>("SELECT cost_no_cache_input AS baseline FROM messages").get()
				?.baseline,
		).toBe(0.1);
		expect(getOverallStats().cacheSavings).toBeCloseTo((0.1 - 0.015) / 0.1, 10);
	});
});
