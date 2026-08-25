import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ensurePersistedRoster } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { BunFile } from "bun";

/** Latch-cache bound enforced by `ensurePersistedRoster` (see MAX_PERSISTED_ROSTER_LATCHES). */
const MAX_PERSISTED_ROSTER_LATCHES = 32;

function sessionHeader(id: string): string {
	return JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-08-25T10:00:00.000Z",
		cwd: "/tmp",
	});
}

function sessionInitRecord(): string {
	return JSON.stringify({
		type: "session_init",
		id: "si",
		parentId: null,
		timestamp: "2026-08-25T10:00:01.000Z",
		systemPrompt: "review",
		task: "review the diff",
		tools: ["read"],
	});
}

/**
 * A transcript whose first record is one oversized line: a metadata read (capped
 * at MAX_METADATA_LINES records) still streams many chunks, so a stat rejection
 * that stayed pending would sit unhandled across several event-loop turns.
 */
function slowTranscript(): string {
	return `${JSON.stringify({
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "slow",
		timestamp: "2026-08-25T10:00:00.000Z",
		cwd: "/tmp",
		pad: "x".repeat(8 * 1024 * 1024),
	})}\n`;
}

/** Directory a scan reads to list a root's transcripts (`<sessionFile>` minus `.jsonl`). */
function scanDir(sessionFile: string): string {
	return sessionFile.slice(0, -".jsonl".length);
}

/** Collect unhandled-rejection reports raised while the callback runs. */
function captureUnhandledRejections(): () => string[] {
	const reports: unknown[] = [];
	const listener = (reason: unknown) => {
		reports.push(reason);
	};
	process.on("unhandledRejection", listener);
	return () => {
		process.off("unhandledRejection", listener);
		return reports.map(String);
	};
}

function countReaddirs(readdirs: string[], dir: string): number {
	return readdirs.filter(target => target === dir).length;
}

/** Spy on `fs.promises.readdir`, recording each scanned directory. */
function spyOnReaddirs(readdirs: string[], gate?: () => void): void {
	const realReaddir = fsp.readdir;
	vi.spyOn(fs.promises, "readdir").mockImplementation((async (target: fs.PathLike) => {
		readdirs.push(String(target));
		gate?.();
		return realReaddir(target, { withFileTypes: true });
	}) as unknown as typeof fsp.readdir);
}

/** Spy on `fs.promises.stat`, failing `childFile` with a transient coded fault. */
function spyOnStatFault(childFile: string, code: string): void {
	const realStat = fsp.stat;
	vi.spyOn(fs.promises, "stat").mockImplementation((async (target: fs.PathLike) => {
		if (target === childFile) {
			throw Object.assign(new Error(`${code}: ${childFile}`), { code });
		}
		return realStat(target);
	}) as typeof fs.promises.stat);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("persisted roster metadata fault settling", () => {
	it("settles an eager stat fault instead of leaving a rejecting promise pending", async () => {
		using tempDir = TempDir.createSync("@omp-roster-stat-fault-");
		const dir = tempDir.path();
		const rootFile = path.join(dir, "main.jsonl");
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(rootFile, `${sessionHeader("main")}\n`);
		// The metadata read on this file streams many chunks while the stat fault
		// is immediate: the old code left the stat rejection unhandled for the
		// whole stream, which Bun reports (and can terminate on).
		await Bun.write(childFile, slowTranscript());
		spyOnStatFault(childFile, "EMFILE");
		const unhandled = captureUnhandledRejections();
		try {
			const registry = new AgentRegistry();
			const root = await ensurePersistedRoster(registry, rootFile);
			expect(root).toBe(rootFile);
		} finally {
			expect(unhandled()).toEqual([]);
		}
	}, 10_000);

	it("still degrades gracefully when the stream and the stat fail together", async () => {
		using tempDir = TempDir.createSync("@omp-roster-simultaneous-");
		const dir = tempDir.path();
		const rootFile = path.join(dir, "main.jsonl");
		const childFile = path.join(dir, "main", "Worker.jsonl");
		await Bun.write(rootFile, `${sessionHeader("main")}\n`);
		await Bun.write(childFile, `${sessionHeader("worker")}\n${sessionInitRecord()}\n`);
		spyOnStatFault(childFile, "EMFILE");
		// The stream-open error fires before the stat result is consumed: the
		// eager stat must already be settled so its fault is not abandoned.
		const realBunFile = Bun.file;
		vi.spyOn(Bun, "file").mockImplementation((target: string | URL | Uint8Array | ArrayBufferLike | number) => {
			if (target === childFile) {
				return {
					exists: async () => false,
					stream: () => {
						throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
					},
				} as unknown as BunFile;
			}
			return realBunFile(target as string | URL);
		});
		const readdirs: string[] = [];
		spyOnReaddirs(readdirs);
		const unhandled = captureUnhandledRejections();
		try {
			const registry = new AgentRegistry();
			const first = await ensurePersistedRoster(registry, rootFile);
			expect(first).toBe(rootFile);
			// The failed scan dropped its latch, so a retry re-scans instead of
			// sticking to the degraded result.
			const second = await ensurePersistedRoster(registry, rootFile);
			expect(second).toBe(rootFile);
			expect(countReaddirs(readdirs, scanDir(rootFile))).toBe(2);
		} finally {
			expect(unhandled()).toEqual([]);
		}
	}, 10_000);
});

describe("persisted roster latch semantics", () => {
	it("shares one scan across concurrent same-root calls", async () => {
		using tempDir = TempDir.createSync("@omp-roster-single-flight-");
		const dir = tempDir.path();
		const rootFile = path.join(dir, "main.jsonl");
		await Bun.write(rootFile, `${sessionHeader("main")}\n`);
		const readdirs: string[] = [];
		spyOnReaddirs(readdirs);
		const registry = new AgentRegistry();
		const [first, second] = await Promise.all([
			ensurePersistedRoster(registry, rootFile),
			ensurePersistedRoster(registry, rootFile),
		]);
		expect(first).toBe(rootFile);
		expect(second).toBe(rootFile);
		expect(countReaddirs(readdirs, scanDir(rootFile))).toBe(1);
	});

	it("keeps distinct roots latched independently", async () => {
		using tempDir = TempDir.createSync("@omp-roster-two-roots-");
		const dir = tempDir.path();
		const rootA = path.join(dir, "a", "main.jsonl");
		const rootB = path.join(dir, "b", "main.jsonl");
		await Bun.write(rootA, `${sessionHeader("a")}\n`);
		await Bun.write(rootB, `${sessionHeader("b")}\n`);
		const readdirs: string[] = [];
		spyOnReaddirs(readdirs);
		const registry = new AgentRegistry();
		const firstA = ensurePersistedRoster(registry, rootA);
		const firstB = ensurePersistedRoster(registry, rootB);
		// Root A's scan is still in flight when a second A call arrives; it must
		// join that scan (the single-slot design evicted A here and re-scanned).
		const secondA = ensurePersistedRoster(registry, rootA);
		const [ra1, rb1, ra2] = await Promise.all([firstA, firstB, secondA]);
		expect(ra1).toBe(rootA);
		expect(rb1).toBe(rootB);
		expect(ra2).toBe(rootA);
		expect(countReaddirs(readdirs, scanDir(rootA))).toBe(1);
		expect(countReaddirs(readdirs, scanDir(rootB))).toBe(1);
	});

	it("bounds remembered latches by evicting only settled ones", async () => {
		using tempDir = TempDir.createSync("@omp-roster-latch-bound-");
		const dir = tempDir.path();
		const rootFor = (index: number) => path.join(dir, `root-${index}`, "main.jsonl");
		const rootCount = MAX_PERSISTED_ROSTER_LATCHES + 1;
		const readdirs: string[] = [];
		const realReaddir = fsp.readdir;
		let releaseScans = () => {};
		const scansHeld = new Promise<void>(resolve => {
			releaseScans = resolve;
		});
		vi.spyOn(fs.promises, "readdir").mockImplementation((async (target: fs.PathLike) => {
			readdirs.push(String(target));
			// Hold every scan at its first directory read until all roots are
			// latched, so the bound overflow happens while scans are in flight.
			if (readdirs.length === rootCount) releaseScans();
			await scansHeld;
			return realReaddir(target, { withFileTypes: true });
		}) as unknown as typeof fsp.readdir);
		const registry = new AgentRegistry();
		const roots = Array.from({ length: rootCount }, (_, index) => rootFor(index));
		await Promise.all(roots.map(root => Bun.write(root, "")));
		const scans = await Promise.all(roots.map(root => ensurePersistedRoster(registry, root)));
		for (const root of scans) expect(root).toBeDefined();
		// All 33 scans were in flight when the 33rd latch was inserted; none was
		// evicted, so root 0's settled latch still dedupes a repeated call.
		await ensurePersistedRoster(registry, rootFor(0));
		expect(countReaddirs(readdirs, scanDir(rootFor(0)))).toBe(1);
		// A new root pushes the cache over its bound; only settled entries are
		// forgotten (oldest first), so roots 0 and 1 are evicted...
		await ensurePersistedRoster(registry, rootFor(rootCount));
		// ...a still-latched root does not re-scan...
		await ensurePersistedRoster(registry, rootFor(2));
		expect(countReaddirs(readdirs, scanDir(rootFor(2)))).toBe(1);
		// ...while a repeated call for an evicted root re-scans.
		await ensurePersistedRoster(registry, rootFor(0));
		expect(countReaddirs(readdirs, scanDir(rootFor(0)))).toBe(2);
	}, 10_000);
});
