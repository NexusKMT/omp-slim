import { afterEach, describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { TspHarness } from "./tsp-harness";

/** Focused component recording every keystroke the TUI hands it. */
class KeyLog implements Component {
	keys: string[] = [];
	render(): readonly string[] {
		return ["keys"];
	}
	handleInput(data: string): void {
		this.keys.push(data);
	}
	invalidate(): void {}
}

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

/** Started the way omp's prepaint starts inside Tern. */
const TERN_PREPAINT = { expected: true, deferInput: true } as const;

describe("keystrokes during a Tern startup prepaint", () => {
	it("are held until the app releases them, then replayed in order and delivered live", async () => {
		const log = new KeyLog();
		harness = await TspHarness.start(tui => tui.setFocus(log), TERN_PREPAINT);
		const h = harness;

		h.terminal.send("\x1bp");
		h.terminal.send("a");
		h.flush();
		expect(log.keys).toEqual([]);

		h.tui.releaseHeldInput();
		expect(log.keys).toEqual(["\x1bp", "a"]);

		h.terminal.send("b");
		h.flush();
		expect(log.keys).toEqual(["\x1bp", "a", "b"]);
	});

	it("are released by Ctrl+C so a stalled startup stays interruptible", async () => {
		const log = new KeyLog();
		harness = await TspHarness.start(tui => tui.setFocus(log), TERN_PREPAINT);
		const h = harness;

		h.terminal.send("a");
		h.terminal.send("\x03");
		h.flush();
		expect(log.keys).toEqual(["a", "\x03"]);
	});
});
