import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readBenchmarkSnapshot } from "../src/benchmarks";

const cleanups: string[] = [];

function jobDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-benchmark-"));
	cleanups.push(dir);
	return dir;
}

/** Write one finished trial dir in the current per-trial result.json schema. */
function writeEditResult(dir: string, trialName: string): void {
	const trialDir = path.join(dir, trialName);
	fs.mkdirSync(trialDir, { recursive: true });
	fs.writeFileSync(
		path.join(trialDir, "result.json"),
		JSON.stringify({
			started_at: "2026-11-12T10:00:00.000Z",
			finished_at: "2026-11-12T10:01:12.000Z",
			agent_result: {
				cost_usd: 0.4,
				n_input_tokens: 100,
				n_output_tokens: 20,
				n_cache_tokens: 25,
			},
			verifier_result: { rewards: { reward: 1 } },
		}),
	);
}

afterEach(() => {
	for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("benchmark adapters", () => {
	it("normalizes edit traces, tokens, and declared metrics from trial result files", () => {
		const dir = jobDir();
		writeEditResult(dir, "rename-symbol");

		const snapshot = readBenchmarkSnapshot("edit", dir);
		expect(snapshot.metrics).toEqual({ success_rate: 1 });
		expect(snapshot.traces[0]).toMatchObject({
			name: "rename-symbol",
			status: "pass",
			reward: 1,
			tracePath: path.join("rename-symbol", "agent", "omp.txt"),
		});
		expect([snapshot.tokIn, snapshot.tokOut, snapshot.tokCache]).toEqual([100, 20, 25]);
		expect(snapshot.costUsd).toBeCloseTo(0.4);
	});

	it("links edit traces to the trial's live agent transcript by trial directory name", () => {
		const dir = jobDir();
		writeEditResult(dir, "task_weird");

		const snapshot = readBenchmarkSnapshot("edit", dir);
		expect(snapshot.traces[0]?.tracePath).toBe(path.join("task_weird", "agent", "omp.txt"));
	});

	it("normalizes SnapCompact records and weighted quality metrics", () => {
		const dir = jobDir();
		fs.writeFileSync(
			path.join(dir, "records.jsonl"),
			`${JSON.stringify({ cond: "text", chunk: 0, pos_rel: 0.2, q: "q", answer: "a", golds: ["a"], em: 1, f1: 1 })}\n`,
		);
		fs.writeFileSync(
			path.join(dir, "summary.json"),
			JSON.stringify({
				rows: [
					{ n: 2, f1: 0.75, em: 0.5, cost_usd: 1.25, tokens_in: 200, tokens_out: 30, cache_w: 10, cache_r: 20 },
				],
			}),
		);

		const snapshot = readBenchmarkSnapshot("snapcompact", dir);
		expect(snapshot.metrics).toEqual({ f1: 0.75, exact_match: 0.5 });
		expect(snapshot.traces[0]).toMatchObject({ status: "pass", reward: 1, tracePath: "record:1" });
		expect(snapshot.costUsd).toBe(1.25);
		expect(snapshot.tokCache).toBe(30);
	});
});
