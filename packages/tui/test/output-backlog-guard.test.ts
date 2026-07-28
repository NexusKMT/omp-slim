import { describe, expect, it } from "bun:test";
import { OutputBacklogGuard } from "@oh-my-pi/pi-tui/terminal";

// Regression test for https://github.com/can1357/oh-my-pi/issues/6854
//
// A stalled-but-alive PTY consumer never throws, so ProcessTerminal.#safeWrite
// has no error to catch: process.stdout.write() just returns false and queues
// the bytes. OutputBacklogGuard turns that never-draining backlog into a bounded
// disconnect signal. These tests pin the accounting contract #safeWrite relies
// on to decide when to declare the terminal disconnected.
describe("issue #6854: OutputBacklogGuard bounds a stalled stdout", () => {
	it("never trips while the consumer keeps up (writes accepted)", () => {
		const guard = new OutputBacklogGuard(1024);
		for (let i = 0; i < 10_000; i++) {
			expect(guard.record(true, 4096)).toBe(false);
		}
		expect(guard.tracking).toBe(false);
	});

	it("starts tracking on the first refused write and accumulates the backlog", () => {
		const guard = new OutputBacklogGuard(1024);
		// First refusal: backpressure begins.
		expect(guard.record(false, 256)).toBe(false);
		expect(guard.tracking).toBe(true);
		// Bytes keep accumulating up to — but not past — the cap.
		expect(guard.record(false, 256)).toBe(false);
		expect(guard.record(false, 256)).toBe(false);
		expect(guard.record(false, 256)).toBe(false); // total 1024 == cap, not over
		// One more byte crosses the cap and signals disconnect.
		expect(guard.record(false, 1)).toBe(true);
	});

	it("keeps counting bytes while tracking even when a later write is accepted", () => {
		const guard = new OutputBacklogGuard(1024);
		// Backpressure began: the buffer is not empty until a drain resets us,
		// so a transient write() === true still adds to the pending backlog.
		expect(guard.record(false, 512)).toBe(false);
		expect(guard.tracking).toBe(true);
		expect(guard.record(true, 512)).toBe(false); // total 1024
		expect(guard.record(true, 1)).toBe(true); // crosses cap
	});

	it("clears the backlog on reset (drain) and starts fresh afterward", () => {
		const guard = new OutputBacklogGuard(1024);
		expect(guard.record(false, 1025)).toBe(true);
		guard.reset();
		expect(guard.tracking).toBe(false);
		// After a drain, accepted writes are healthy again and never trip.
		expect(guard.record(true, 100_000)).toBe(false);
		expect(guard.tracking).toBe(false);
		// A fresh stall restarts accounting from zero.
		expect(guard.record(false, 1024)).toBe(false);
		expect(guard.record(false, 1)).toBe(true);
	});
});
