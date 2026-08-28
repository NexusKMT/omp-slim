import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let tempDir = "";
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const HISTORY_STORAGE_MODULE = path.resolve(import.meta.dir, "../src/session/history-storage.ts");
const AGENT_STORAGE_MODULE = path.resolve(import.meta.dir, "../src/session/agent-storage.ts");

async function freshStorage(prefix = "omp-history-drain-"): Promise<HistoryStorage> {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const dbPath = path.join(tempDir, "history.db");
	HistoryStorage.close();
	return HistoryStorage.open(dbPath);
}

/** Drain the 100ms insert batch window, then await the pending writes. */
async function flush(...writes: Promise<void>[]): Promise<void> {
	vi.advanceTimersByTime(100);
	await Promise.all(writes);
}

beforeEach(() => {
	HistoryStorage.close();
	vi.useFakeTimers();
});

afterEach(async () => {
	HistoryStorage.close();
	vi.useRealTimers();
	if (tempDir) {
		await removeWithRetries(tempDir).catch(() => {});
		tempDir = "";
	}
});

/**
 * Contract for the history-storage async drain: multiple rapid `add()` calls
 * within the drain window are batched into a single flushed write, and the
 * returned promise resolves once the batch is persisted. This guards the
 * `Promise.withResolvers()` refactor of `AsyncDrain` — the drain must still
 * coalesce pushes and resolve its per-batch promise.
 */
describe("HistoryStorage AsyncDrain batching", () => {
	it("coalesces pushes within the drain window into one flushed write", async () => {
		const storage = await freshStorage();
		// Three rapid adds before the 100ms drain window fires.
		const p1 = storage.add("first prompt");
		const p2 = storage.add("second prompt");
		const p3 = storage.add("third prompt");
		await flush(p1, p2, p3);

		expect(storage.getRecent(10).map(r => r.prompt)).toEqual(["third prompt", "second prompt", "first prompt"]);
	});

	it("resolves the returned promise for each coalesced push", async () => {
		const storage = await freshStorage();
		const p1 = storage.add("a");
		const p2 = storage.add("b");
		await flush(p1, p2);
		// Both promises must have resolved (not hang) — flush awaited them.
		expect(storage.getRecent(10)).toHaveLength(2);
	});

	it("starts a fresh batch after the prior one flushes", async () => {
		const storage = await freshStorage();
		await flush(storage.add("batch-one"));
		// After the first batch flushes, a new add starts a new batch.
		await flush(storage.add("batch-two"));
		expect(storage.getRecent(10).map(r => r.prompt)).toEqual(["batch-two", "batch-one"]);
	});
});

describe("storage process-exit cleanup", () => {
	it("flushes queued writes and checkpoints both databases before a hard exit", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-storage-exit-"));
		const historyDbPath = path.join(tempDir, "history.db");
		const agentDbPath = path.join(tempDir, "agent.db");
		const historyModule = HISTORY_STORAGE_MODULE;
		const agentModule = AGENT_STORAGE_MODULE;
		const script = [
			`import { HistoryStorage } from ${JSON.stringify(historyModule)};`,
			`import { AgentStorage } from ${JSON.stringify(agentModule)};`,
			`const history = HistoryStorage.open(${JSON.stringify(historyDbPath)});`,
			`const agent = await AgentStorage.open(${JSON.stringify(agentDbPath)});`,
			'void history.add("queued immediately before exit", "/tmp", "exit-session");',
			'void agent.recordModelPerf("openai/repro", { outputTokens: 10, durationMs: 1000 });',
			"process.exit(0);",
		].join("\n");
		const child = Bun.spawn([process.execPath, "--eval", script], {
			cwd: REPO_ROOT,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exitCode, stderr).toBe(0);
		const historyCheckpoint = path.join(tempDir, "history-checkpoint.db");
		const agentCheckpoint = path.join(tempDir, "agent-checkpoint.db");
		await Promise.all([
			Bun.write(historyCheckpoint, Bun.file(historyDbPath)),
			Bun.write(agentCheckpoint, Bun.file(agentDbPath)),
		]);

		// Read copies of the main database files without their WALs. The queued
		// rows are visible only if process-exit cleanup checkpointed them.
		const historyDb = new Database(historyCheckpoint, { readonly: true });
		const agentDb = new Database(agentCheckpoint, { readonly: true });
		try {
			expect(historyDb.query<{ prompt: string }, []>("SELECT prompt FROM history").get()).toEqual({
				prompt: "queued immediately before exit",
			});
			expect(
				agentDb
					.query<{ samples: number; output_tokens: number; gen_ms: number }, []>(
						"SELECT samples, output_tokens, gen_ms FROM model_perf WHERE model_key = 'openai/repro'",
					)
					.get(),
			).toEqual({ samples: 1, output_tokens: 10, gen_ms: 1000 });
		} finally {
			historyDb.close();
			agentDb.close();
		}
	});

	it("keeps stores opened after manual postmortem cleanup usable", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-storage-late-open-"));
		const historyDbPath = path.join(tempDir, "history.db");
		const agentDbPath = path.join(tempDir, "agent.db");
		const script = [
			'import { postmortem } from "@oh-my-pi/pi-utils";',
			`import { HistoryStorage } from ${JSON.stringify(HISTORY_STORAGE_MODULE)};`,
			`import { AgentStorage } from ${JSON.stringify(AGENT_STORAGE_MODULE)};`,
			"await postmortem.cleanup();",
			`const history = HistoryStorage.open(${JSON.stringify(historyDbPath)});`,
			'void history.add("opened after cleanup", "/tmp", "late-session");',
			"HistoryStorage.close();",
			`const reopenedHistory = HistoryStorage.open(${JSON.stringify(historyDbPath)});`,
			"const prompts = reopenedHistory.getRecent(10).map(row => row.prompt);",
			"HistoryStorage.close();",
			`const agent = await AgentStorage.open(${JSON.stringify(agentDbPath)});`,
			'agent.recordCommandUsage("after-cleanup");',
			"const commands = agent.listCommandUsage();",
			"AgentStorage.close();",
			"console.log(JSON.stringify({ prompts, commands }));",
		].join("\n");
		const child = Bun.spawn([process.execPath, "--eval", script], {
			cwd: REPO_ROOT,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(stdout.trim()).toBe(
			JSON.stringify({ prompts: ["opened after cleanup"], commands: { "after-cleanup": 1 } }),
		);
	});
});
