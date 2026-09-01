import { describe, expect, it } from "bun:test";
import { StdoutStallWatchdog } from "@oh-my-pi/pi-tui/terminal";

// The TUI must bound a never-draining stdout consumer (#6854) without killing a
// single large-but-draining frame — a `--resume` transcript repaint of many
// inline images is one multi-tens-of-MiB write (#10430). StdoutStallWatchdog
// separates the two by drain progress; these tests pin that decision, which is
// the contract ProcessTerminal#trackStdoutBacklog relies on to decide when to
// declare the terminal disconnected.
const CAP = 1024;
const STALL_MS = 2000;

describe("StdoutStallWatchdog", () => {
	it("never trips while the backlog stays at or under the cap", () => {
		const wd = new StdoutStallWatchdog(CAP, STALL_MS);
		for (let t = 0; t < 100_000; t += 1000) {
			expect(wd.sample(CAP, t)).toBe(false);
			expect(wd.sample(0, t + 1)).toBe(false);
		}
	});

	it("declares a stall once the backlog sits over the cap without draining for stallMs (#6854)", () => {
		const wd = new StdoutStallWatchdog(CAP, STALL_MS);
		expect(wd.sample(CAP + 1, 0)).toBe(false); // arms and starts the clock
		expect(wd.sample(CAP + 1, STALL_MS - 1)).toBe(false); // window not elapsed
		expect(wd.sample(CAP + 1, STALL_MS)).toBe(true); // no progress for stallMs
	});

	it("never trips while a large backlog keeps draining, even long past stallMs (#10430)", () => {
		const wd = new StdoutStallWatchdog(CAP, STALL_MS);
		let pending = 64 * 1024 * 1024; // one oversized frame
		for (let t = 0; pending > CAP && t <= STALL_MS * 8; t += 100) {
			expect(wd.sample(pending, t)).toBe(false);
			pending -= 512 * 1024; // forward progress: a new low-water mark each poll
		}
		expect(wd.sample(CAP, STALL_MS * 9)).toBe(false); // drained: disarmed
	});

	it("counts the stall window only since the last drain progress", () => {
		const wd = new StdoutStallWatchdog(CAP, STALL_MS);
		expect(wd.sample(CAP + 5000, 0)).toBe(false); // arm at t=0
		expect(wd.sample(CAP + 3000, 1500)).toBe(false); // progress: clock restarts at 1500
		expect(wd.sample(CAP + 3000, 1500 + STALL_MS - 1)).toBe(false); // measured from 1500
		expect(wd.sample(CAP + 3000, 1500 + STALL_MS)).toBe(true);
	});

	it("does not inherit a stale clock across a drained episode", () => {
		const wd = new StdoutStallWatchdog(CAP, STALL_MS);
		expect(wd.sample(CAP + 1, 0)).toBe(false);
		expect(wd.sample(0, 500)).toBe(false); // drained under cap: reset
		expect(wd.sample(CAP + 1, 10_000)).toBe(false); // fresh episode arms a new clock
		expect(wd.sample(CAP + 1, 10_000 + STALL_MS - 1)).toBe(false);
		expect(wd.sample(CAP + 1, 10_000 + STALL_MS)).toBe(true);
	});
});
