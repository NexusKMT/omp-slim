import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getRecentRequests } from "@oh-my-pi/omp-stats/db";
import { getOverallStats } from "@oh-my-pi/omp-stats/rollup";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-priority-");

interface SessionLines {
	lines: Array<Record<string, unknown>>;
}

async function writeSession(folder: string, name: string, { lines }: SessionLines): Promise<string> {
	const dir = path.join(getSessionsDir(), folder);
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, name);
	const text = `${lines.map(line => JSON.stringify(line)).join("\n")}\n`;
	await fs.writeFile(filePath, text);
	return filePath;
}

function assistantEntry(opts: {
	id: string;
	parentId?: string | null;
	provider: string;
	api?: string;
	premiumRequests?: number;
	serviceTier?: string;
}): Record<string, unknown> {
	return {
		type: "message",
		id: opts.id,
		parentId: opts.parentId ?? null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: opts.api ?? "openai-responses",
			provider: opts.provider,
			model: "gpt-5.4",
			stopReason: "stop",
			timestamp: Date.now(),
			...(opts.serviceTier !== undefined ? { serviceTier: opts.serviceTier } : {}),
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				...(opts.premiumRequests !== undefined ? { premiumRequests: opts.premiumRequests } : {}),
			},
		},
	};
}

describe("recorded premium request history", () => {
	it("does not infer premium units from service tiers or provider names", async () => {
		await writeSession("--tmp--proj", "01.jsonl", {
			lines: [
				{ type: "session", version: 1, id: "s1", timestamp: new Date().toISOString(), cwd: "/tmp/proj" },
				{ type: "service_tier_change", id: "stc1", timestamp: new Date().toISOString(), serviceTier: "priority" },
				assistantEntry({ id: "a1", provider: "endpoint", serviceTier: "priority" }),
				assistantEntry({ id: "a2", provider: "openai-codex", serviceTier: "ultrafast" }),
			],
		});
		await syncAllSessions();
		expect(getOverallStats().totalRequests).toBe(2);
		expect(getOverallStats().totalPremiumRequests).toBe(0);
	});

	it("preserves explicit historical premium units on repeated sync", async () => {
		await writeSession("--tmp--proj", "02.jsonl", {
			lines: [
				{ type: "session", version: 1, id: "s2", timestamp: new Date().toISOString(), cwd: "/tmp/proj" },
				assistantEntry({ id: "b1", provider: "legacy-endpoint", premiumRequests: 0.33 }),
			],
		});
		await syncAllSessions();
		expect(getRecentRequests(1)[0]?.usage.premiumRequests).toBeCloseTo(0.33, 6);
		await syncAllSessions();
		expect(getOverallStats().totalPremiumRequests).toBeCloseTo(0.33, 6);
	});
});
