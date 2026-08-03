import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions, withStatsSyncLock } from "@oh-my-pi/omp-stats/aggregator";
import { getOverallStats } from "@oh-my-pi/omp-stats/db";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-sync-serial-");

afterEach(() => {
	vi.restoreAllMocks();
});

async function writeSessionFile(options?: { includeCost?: boolean }): Promise<void> {
	const sessionDir = path.join(getSessionsDir(), "--tmp--sync-serial");
	await fs.mkdir(sessionDir, { recursive: true });
	const timestamp = new Date().toISOString();
	const sessionFile = path.join(sessionDir, "session.jsonl");
	const includeCost = options?.includeCost ?? true;
	const assistant = {
		type: "message",
		id: "assistant-1",
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				...(includeCost ? { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } : {}),
			},
			stopReason: "stop",
			timestamp: Date.now(),
			duration: 10,
			ttft: 5,
		},
	};
	await Bun.write(sessionFile, `${JSON.stringify(assistant)}\n`);
}

describe("stats sync serial mode", () => {
	it("honors workers: 1 without spawning a worker", async () => {
		await writeSessionFile();
		const workerSpy = vi.spyOn(globalThis, "Worker");

		const synced = await syncAllSessions({ workers: 1 });
		const overall = getOverallStats();

		expect(synced.files).toBe(1);
		expect(overall.totalRequests).toBe(1);
		expect(workerSpy).not.toHaveBeenCalled();
	});

	it("syncs legacy session usage without a cost breakdown", async () => {
		await writeSessionFile({ includeCost: false });

		const synced = await syncAllSessions({ workers: 1 });
		const overall = getOverallStats();

		expect(synced).toEqual({ processed: 1, files: 1 });
		expect(overall.totalRequests).toBe(1);
		expect(overall.totalCost).toBeGreaterThan(0);
	});

	it("uses the serial parser by default on macOS", async () => {
		await writeSessionFile();
		vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
		const workerSpy = vi.spyOn(globalThis, "Worker");

		const synced = await syncAllSessions();
		const overall = getOverallStats();

		expect(synced.files).toBe(1);
		expect(overall.totalRequests).toBe(1);
		expect(workerSpy).not.toHaveBeenCalled();
	});

	it("spawns a worker pool when callers explicitly request workers: 2 with a single file", async () => {
		await writeSessionFile();
		const workerProbe = new Error("worker probe");
		const workerSpy = vi.spyOn(globalThis, "Worker").mockImplementation(() => {
			throw workerProbe;
		});

		await expect(syncAllSessions({ workers: 2 })).rejects.toBe(workerProbe);
		expect(workerSpy).toHaveBeenCalled();
	});

	it("reclaims a dead owner's abandoned stale breaker", async () => {
		const dbPath = path.join(getSessionsDir(), "stats-lock.db");
		const lockPath = `${dbPath}.sync.lock`;
		const breakerPath = `${lockPath}.break`;
		const deadPid = 424_242;
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		await Bun.write(lockPath, `${deadPid}\n1\nprimary\n`);
		await Bun.write(breakerPath, `${deadPid}\n1\nbreaker\n`);
		const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await fs.utimes(lockPath, staleTime, staleTime);
		await fs.utimes(breakerPath, staleTime, staleTime);
		vi.spyOn(process, "kill").mockImplementation(pid => {
			if (pid === deadPid) throw Object.assign(new Error("dead owner"), { code: "ESRCH" });
			return true;
		});

		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		const result = await withStatsSyncLock(dbPath, async () => "acquired");

		expect(result).toBe("acquired");
		expect(await Bun.file(lockPath).exists()).toBe(false);
		expect(await Bun.file(breakerPath).exists()).toBe(false);
	});

	it("reclaims an unstamped lock after the acquisition grace period", async () => {
		const dbPath = path.join(getSessionsDir(), "stats-unstamped-lock.db");
		const lockPath = `${dbPath}.sync.lock`;
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		await Bun.write(lockPath, "");
		const staleTime = new Date(Date.now() - 11_000);
		await fs.utimes(lockPath, staleTime, staleTime);
		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);

		const result = await withStatsSyncLock(dbPath, async () => "acquired");

		expect(result).toBe("acquired");
		expect(await Bun.file(lockPath).exists()).toBe(false);
	});

	it("never reclaims a live owner-stamped breaker even when its mtime is stale", async () => {
		const dbPath = path.join(getSessionsDir(), "stats-live-breaker.db");
		const lockPath = `${dbPath}.sync.lock`;
		const breakerPath = `${lockPath}.break`;
		const deadPid = 424_243;
		const liveBreakerToken = `${process.pid}\n1\nlive-breaker\n`;
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		await Bun.write(lockPath, `${deadPid}\n1\nprimary\n`);
		await Bun.write(breakerPath, liveBreakerToken);
		const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await fs.utimes(lockPath, staleTime, staleTime);
		await fs.utimes(breakerPath, staleTime, staleTime);
		vi.spyOn(process, "kill").mockImplementation(pid => {
			if (pid === deadPid) throw Object.assign(new Error("dead owner"), { code: "ESRCH" });
			return true;
		});
		const retryScheduled = Promise.withResolvers<void>();
		const resumeRetry = Promise.withResolvers<void>();
		let breakerReleased = false;
		vi.spyOn(Bun, "sleep").mockImplementation(async () => {
			if (breakerReleased) return;
			retryScheduled.resolve();
			await resumeRetry.promise;
		});

		let acquired = false;
		const pending = withStatsSyncLock(dbPath, async () => {
			acquired = true;
		});
		try {
			await retryScheduled.promise;
			expect(acquired).toBe(false);
			expect(await Bun.file(breakerPath).text()).toBe(liveBreakerToken);
		} finally {
			breakerReleased = true;
			await fs.rm(breakerPath, { force: true });
			resumeRetry.resolve();
			await pending;
		}
		expect(acquired).toBe(true);
	});
});
