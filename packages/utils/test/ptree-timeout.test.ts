import { describe, expect, it } from "bun:test";
import { Process } from "@oh-my-pi/pi-natives";
import { exec, NonZeroExitError, spawn, TimeoutError } from "@oh-my-pi/pi-utils/ptree";

describe("ptree timeout", () => {
	it("contains the lifecycle rejection when the caller does not observe exited", async () => {
		const unhandled = new Set<unknown>();
		const onUnhandled = (reason: unknown) => {
			unhandled.add(reason);
		};
		process.on("unhandledRejection", onUnhandled);

		try {
			// Bun's subprocess timeout uses the platform clock; fake timers cannot drive this lifecycle.
			using child = spawn(["bun", "-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"], {
				timeout: 20,
			});
			await child.nothrow().text();
			await child.proc.exited;
			const nextTurn = Promise.withResolvers<void>();
			setImmediate(nextTurn.resolve);
			await nextTurn.promise;

			expect(child.exitReason).toBeInstanceOf(TimeoutError);
			expect(unhandled.has(child.exitReason)).toBe(false);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("clears the timeout timer once the child exits so a fast command does not hold the event loop", async () => {
		// Real subprocess timing: the probe (a static-import fixture) resolves a
		// quick command under a 10 s ptree timeout and then must exit on its own;
		// if the timeout timer were left pending it would hold the probe's event
		// loop for the full 10 s.
		const probe = `${import.meta.dir}/fixtures/ptree-timeout-probe.ts`;

		const start = performance.now();
		const child = spawn([process.execPath, probe], { timeout: 15_000 });
		const text = await child.text();
		const elapsedMs = performance.now() - start;

		expect(text).toContain("probe-done");
		expect(elapsedMs).toBeLessThan(5_000);
	});

	it.skipIf(process.platform === "win32")(
		"throws NonZeroExitError by default when the child exits nonzero",
		async () => {
			// wait()'s default contract: without allowNonZero, a nonzero exit rejects
			// instead of returning an unsuccessful result.
			let threw: unknown;
			try {
				await exec(["sh", "-c", "exit 3"]);
			} catch (err) {
				threw = err;
			}
			expect(threw).toBeInstanceOf(NonZeroExitError);
		},
	);

	it.skipIf(process.platform === "win32")("completes when an orphan holds stdout past the root's exit", async () => {
		// `sleep 30 & echo token $!`: the root exits at once but the background
		// sleep inherits the pipe, so an EOF-based read would stall for the
		// orphan's lifetime, far past the timeout budget. The orphan's pid is
		// printed so the fixture can clean it up instead of leaking it.
		let orphanPid: number | undefined;
		try {
			const start = performance.now();
			const result = await exec(["sh", "-c", "sleep 30 & echo token $!"], {
				timeout: 1_000,
				allowNonZero: true,
				allowAbort: true,
			});
			const elapsedMs = performance.now() - start;
			const match = /^token (\d+)$/.exec(result.stdout.trim());
			orphanPid = match ? Number.parseInt(match[1], 10) : undefined;
			expect(result.ok).toBe(true);
			expect(match, `stdout was: ${result.stdout}`).not.toBeUndefined();
			expect(elapsedMs).toBeLessThan(5_000);
		} finally {
			if (orphanPid) Process.fromPid(orphanPid)?.killTree(9);
		}
	});

	it.skipIf(process.platform === "win32")("completes when an orphan holds stderr past the root's exit", async () => {
		let orphanPid: number | undefined;
		try {
			const start = performance.now();
			const result = await exec(["sh", "-c", "sleep 30 >&2 & echo token2 $!"], {
				timeout: 1_000,
				allowNonZero: true,
				allowAbort: true,
			});
			const elapsedMs = performance.now() - start;
			const match = /^token2 (\d+)$/.exec(result.stdout.trim());
			orphanPid = match ? Number.parseInt(match[1], 10) : undefined;
			expect(result.ok).toBe(true);
			expect(match, `stdout was: ${result.stdout}`).not.toBeUndefined();
			expect(elapsedMs).toBeLessThan(5_000);
		} finally {
			if (orphanPid) Process.fromPid(orphanPid)?.killTree(9);
		}
	});

	it.skipIf(process.platform === "win32")("completes when a nonzero exit races an orphan holding stderr", async () => {
		// `sleep 30 >&2 & exit 1`: the nonzero-exit normalization awaits the
		// stderr drain, so a grace keyed on the normalized exit promise would
		// deadlock until the orphan closes stderr. The grace must key on the
		// raw process exit.
		let orphanPid: number | undefined;
		try {
			const start = performance.now();
			const result = await exec(["sh", "-c", "sleep 30 >&2 & echo $! >&2; exit 1"], {
				timeout: 1_000,
				allowNonZero: true,
				allowAbort: true,
			});
			const elapsedMs = performance.now() - start;
			const match = /(\d+)\s*$/.exec(result.stderr.trim());
			orphanPid = match ? Number.parseInt(match[1], 10) : undefined;
			expect(result.exitCode).toBe(1);
			expect(elapsedMs).toBeLessThan(5_000);
		} finally {
			if (orphanPid) Process.fromPid(orphanPid)?.killTree(9);
		}
	});
});
