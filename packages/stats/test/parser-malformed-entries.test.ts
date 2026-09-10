import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	closeDb,
	getOverallStats,
	getRecentRequests,
	initDb,
	insertMessageStats,
	insertToolCalls,
} from "@oh-my-pi/omp-stats/db";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-malformed-");

const USAGE = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantEntry(id: string, message: Record<string, unknown>): string {
	return JSON.stringify({
		type: "message",
		id,
		timestamp: "2026-07-12T00:00:00.000Z",
		message: {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-fable-5",
			...message,
		},
	});
}

async function writeSession(lines: string[]): Promise<string> {
	const dir = path.join(getSessionsDir(), "--tmp--malformed");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, "session.jsonl");
	await Bun.write(file, `${lines.join("\n")}\n`);
	return file;
}

// Regression: a single persisted assistant message missing `stopReason` (or
// usage/token fields) used to bind NULL into stats.db's NOT NULL columns and
// crash the entire sync with SQLITE_CONSTRAINT_NOTNULL. The parser must
// coerce or skip malformed entries so the batch always inserts.
describe("malformed session entries", () => {
	it("coerces a missing stopReason instead of failing the NOT NULL insert", async () => {
		const file = await writeSession([
			assistantEntry("a1", { content: [{ type: "text", text: "hi" }], usage: USAGE, timestamp: 1752000000000 }),
			assistantEntry("a2", {
				content: [],
				usage: USAGE,
				timestamp: 1752000001000,
				errorMessage: "boom",
			}),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats.map(s => s.stopReason)).toEqual(["aborted", "error"]);

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(2);
	});

	it("zero-fills missing token counts and falls back to the entry timestamp", async () => {
		const file = await writeSession([
			assistantEntry("a1", {
				content: [],
				stopReason: "stop",
				usage: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			}),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats).toHaveLength(1);
		const stats = result.stats[0];
		expect(stats.usage.totalTokens).toBe(0);
		expect(stats.timestamp).toBe(Date.parse("2026-07-12T00:00:00.000Z"));

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);
	});

	// Regression: legacy session files can carry a partially-populated
	// `usage.cost` (e.g. only `total`). The parser passes such objects through
	// untouched, and the raw cost used to bind NULL into the cost_* NOT NULL
	// columns and crash the entire sync with SQLITE_CONSTRAINT_NOTNULL.
	it("normalises a partial legacy usage.cost instead of failing the NOT NULL insert", async () => {
		const file = await writeSession([
			assistantEntry("a1", {
				content: [],
				stopReason: "stop",
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 1 } },
			}),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats).toHaveLength(1);

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);

		const request = getRecentRequests(1)[0];
		expect(request?.usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 });
	});
	it("preserves partial legacy cost components when total is missing", async () => {
		const file = await writeSession([
			assistantEntry("a1", {
				content: [],
				model: "claude-sonnet-4-6",
				stopReason: "stop",
				usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 1 } },
			}),
		]);

		const result = await parseSessionFile(file);
		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);
		expect(getRecentRequests(1)[0]?.usage.cost).toEqual({
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 1,
		});
	});

	it("skips assistant entries with no usage or model attribution", async () => {
		const file = await writeSession([
			assistantEntry("a1", { content: [], stopReason: "stop" }),
			JSON.stringify({
				type: "message",
				id: "a2",
				timestamp: "2026-07-12T00:00:00.000Z",
				message: { role: "assistant", content: [], stopReason: "stop", usage: USAGE },
			}),
			assistantEntry("ok", { content: [], stopReason: "stop", usage: USAGE, timestamp: 1752000002000 }),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats.map(s => s.entryId)).toEqual(["ok"]);
	});

	it("ignores malformed content blocks without aborting later entries", async () => {
		const file = await writeSession([
			assistantEntry("a1", {
				content: [null, { type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
				usage: USAGE,
				timestamp: 1752000000000,
			}),
			assistantEntry("a2", { content: [], usage: USAGE, timestamp: 1752000001000 }),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats.map(s => s.entryId)).toEqual(["a1", "a2"]);
		expect(result.toolCalls.map(c => c.toolCallId)).toEqual(["call-1"]);
	});

	it("keeps tool_calls insertable when the turn lacks a message timestamp", async () => {
		const file = await writeSession([
			assistantEntry("a1", {
				content: [
					{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
					{ type: "toolCall", name: "broken" }, // no id: unattributable, must be skipped
				],
				usage: USAGE,
			}),
		]);

		const result = await parseSessionFile(file);
		expect(result.toolCalls.map(c => c.toolCallId)).toEqual(["call-1"]);
		expect(result.toolCalls[0].timestamp).toBe(Date.parse("2026-07-12T00:00:00.000Z"));

		await initDb();
		expect(insertToolCalls(result.toolCalls)).toBe(1);
	});
});

// Thursday 02:00 UTC, inside DeepSeek's weekday [01:00, 04:00) peak window.
const DEEPSEEK_PEAK = Date.parse("2026-09-10T02:00:00Z");

function deepseekEntry(id: string, usage: Record<string, unknown>, timestamp?: number): string {
	return assistantEntry(id, {
		provider: "deepseek",
		model: "deepseek-v4-flash",
		api: "openai-completions",
		stopReason: "stop",
		content: [],
		usage,
		...(timestamp === undefined ? {} : { timestamp }),
	});
}

// Regression: an entry that omits `usage.cost` outright was ingested with a
// synthesized zero, and `resolveStoredCost` freezes any recorded charge on a
// scheduled card — so legacy DeepSeek peak usage was stored as exactly $0 and
// `backfillMissingCatalogCosts` never revisits scheduled rows to repair it.
// Absence must stay absent until the request timestamp prices it.
describe("legacy entries without a recorded price", () => {
	it("estimates the stored cost at the request timestamp instead of freezing zero", async () => {
		const file = await writeSession([
			deepseekEntry("unpriced", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, DEEPSEEK_PEAK),
			deepseekEntry(
				"explicit-zero",
				{
					input: 1_000_000,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				DEEPSEEK_PEAK,
			),
		]);

		const result = await parseSessionFile(file);
		// The omitted counter is derived from the conversation buckets.
		expect(result.stats.map(s => s.usage.totalTokens)).toEqual([1_000_000, 1_000_000]);

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(2);

		const stored = getRecentRequests(2);
		// 1M uncached input tokens at the peak card's $0.30/M.
		expect(stored.find(request => request.entryId === "unpriced")?.usage.cost.total).toBeCloseTo(0.3, 8);
		// A recorded zero is a real charge and stays zero.
		expect(stored.find(request => request.entryId === "explicit-zero")?.usage.cost.total).toBe(0);
		expect(getOverallStats().totalCost).toBeCloseTo(0.3, 8);
		// Uncached-equivalent prompt cost 2 x $0.30 against $0.30 of recorded
		// prompt charges (the frozen zero row contributes none).
		expect(getOverallStats().cacheSavings).toBeCloseTo(0.5, 8);

		closeDb();
		await initDb();

		const reopened = getRecentRequests(2);
		expect(reopened.find(request => request.entryId === "unpriced")?.usage.cost.total).toBeCloseTo(0.3, 8);
		expect(reopened.find(request => request.entryId === "explicit-zero")?.usage.cost.total).toBe(0);
		expect(getOverallStats().totalCost).toBeCloseTo(0.3, 8);
	});

	it("leaves scheduled usage unpriced when the entry has no recoverable timestamp", async () => {
		const file = await writeSession([
			JSON.stringify({
				type: "message",
				id: "no-timestamp",
				message: {
					role: "assistant",
					provider: "deepseek",
					model: "deepseek-v4-flash",
					api: "openai-completions",
					stopReason: "stop",
					content: [],
					usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			}),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats[0].timestamp).toBe(0);

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);

		// The parser's `0` sentinel is not a 1970 request: never bill a peak or
		// off-peak card from it, and never let the missing charge report savings.
		expect(getRecentRequests(1)[0]?.usage.cost.total).toBe(0);
		expect(getOverallStats().totalCost).toBe(0);
		expect(getOverallStats().cacheSavings).toBe(0);
	});

	// Regression: the derived total is summed with `+` over runtime values a
	// foreign session can make any type. A string bucket passed the nullish
	// check and concatenated — `input: "10"` plus the six absent buckets became
	// "10000000", which SQLite coerced to ten million tokens for a ten-token
	// request. A non-numeric bucket is malformed input, not a number to parse.
	it("counts a non-numeric token bucket as absent instead of concatenating it", async () => {
		const file = await writeSession([
			deepseekEntry("string-bucket", { input: "10", output: 0, cacheRead: 0, cacheWrite: 0 }, DEEPSEEK_PEAK),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats).toHaveLength(1);

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);

		const request = getRecentRequests(1)[0];
		expect(typeof request?.usage.totalTokens).toBe("number");
		expect(request?.usage.totalTokens).toBe(0);
		expect(request?.usage.input).toBe(0);
	});
});
