import { describe, expect, it } from "bun:test";
import { spawn, TimeoutError } from "@oh-my-pi/pi-utils/ptree";

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
		// Real subprocess timing: the probe below resolves a quick command under a 10 s
		// ptree timeout and then must exit on its own; if the timeout timer were left
		// pending it would hold the probe's event loop for the full 10 s.
		const ptreeSrc = `${import.meta.dir}/../src/ptree.ts`;
		const probe = [
			`const { exec } = await import(${JSON.stringify(ptreeSrc)});`,
			`const r = await exec([${JSON.stringify(process.execPath)}, "-e", "console.log('ok')"], { timeout: 10_000 });`,
			'if (r.stdout.trim() !== "ok" || !r.ok) process.exit(3);',
			'console.log("probe-done");',
		].join("\n");

		const start = performance.now();
		const child = spawn([process.execPath, "-e", probe], { timeout: 15_000 });
		const text = await child.text();
		const elapsedMs = performance.now() - start;

		expect(text).toContain("probe-done");
		expect(elapsedMs).toBeLessThan(5_000);
	});
});
