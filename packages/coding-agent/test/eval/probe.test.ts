// Integration test: runBoundedProbe spawns and kills a real subprocess, so the
// timeout/abort teardown is inherently wall-clock bound. Fake timers cannot
// advance a child process's execution or resolve its `exited` promise, so the
// real-timer exception in ts-no-test-timers applies here.
import { describe, expect, test } from "bun:test";
import { runBoundedProbe } from "../../src/eval/probe";

// A cross-platform "hangs forever" command: re-invoke the running Bun to sleep.
const bun = process.execPath;
const HANG = [bun, "-e", "await Bun.sleep(60_000)"];
const baseEnv = (): Record<string, string | undefined> => ({ ...process.env });

describe("runBoundedProbe", () => {
	test("a hung probe is bounded by its timeout instead of hanging (regression: #9466)", async () => {
		const start = Date.now();
		const result = await runBoundedProbe(HANG, { cwd: process.cwd(), env: baseEnv(), timeoutMs: 300 });
		expect(result).toEqual({ exitCode: null, timedOut: true, aborted: false });
		expect(Date.now() - start).toBeLessThan(5_000);
	});

	test("an already-aborted signal short-circuits without spawning", async () => {
		const result = await runBoundedProbe(HANG, {
			cwd: process.cwd(),
			env: baseEnv(),
			signal: AbortSignal.abort(),
		});
		expect(result).toEqual({ exitCode: null, timedOut: false, aborted: true });
	});

	test("an in-flight probe is killed when its signal aborts", async () => {
		const start = Date.now();
		const result = await runBoundedProbe(HANG, {
			cwd: process.cwd(),
			env: baseEnv(),
			signal: AbortSignal.timeout(100),
		});
		expect(result.aborted).toBe(true);
		expect(result.exitCode).toBeNull();
		expect(Date.now() - start).toBeLessThan(5_000);
	});

	test("a fast probe reports its real exit code", async () => {
		const ok = await runBoundedProbe([bun, "-e", "process.exit(0)"], {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 5_000,
		});
		expect(ok).toEqual({ exitCode: 0, timedOut: false, aborted: false });

		const failing = await runBoundedProbe([bun, "-e", "process.exit(3)"], {
			cwd: process.cwd(),
			env: baseEnv(),
			timeoutMs: 5_000,
		});
		expect(failing).toEqual({ exitCode: 3, timedOut: false, aborted: false });
	});
});
