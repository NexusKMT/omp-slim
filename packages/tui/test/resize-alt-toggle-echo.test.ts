import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// Warp re-reports size when the alternate buffer toggles. The resize path
// borrows that buffer, waits 120 ms, restores it, then starts a CPR probe.
// The restore write (`CSI ?1049l`) arrives as a SIGWINCH while the probe is
// in flight, so restarting the borrow there loops:
// 1049l → SIGWINCH → 1049h → settle → 1049l → …
//
// The skip is Warp-only: every other terminal keeps the alt-borrow path.
//
// Observable contract: one real resize on Warp must not keep toggling the
// alternate buffer after the settle window.

const ALT_ENTER = "\x1b[?1049h";
const ALT_EXIT = "\x1b[?1049l";

const TERMINAL_ENV = ["TERM_PROGRAM", "PI_TUI_RESIZE_IN_PLACE"] as const;

class LineComponent implements Component {
	constructor(
		private readonly prefix: string,
		private readonly count: number,
	) {}
	invalidate(): void {}
	render(width: number): string[] {
		return Array.from({ length: this.count }, (_v, i) => `${this.prefix}${i}`.slice(0, width));
	}
}

/**
 * Models Warp's alt-toggle size echo: each 1049h/l write is followed by a
 * height-only ±1 SIGWINCH, delivered asynchronously like a PTY read.
 */
class AltToggleEchoTerminal extends VirtualTerminal {
	altEnters = 0;

	override write(data: string): void {
		const enters = countNeedle(data, ALT_ENTER);
		this.altEnters += enters;
		const exits = countNeedle(data, ALT_EXIT);
		super.write(data);
		if (enters + exits === 0) return;
		const delta = enters > 0 ? -1 : 1;
		queueMicrotask(() => {
			this.resize(this.columns, Math.max(1, this.rows + delta));
		});
	}
}

function countNeedle(haystack: string, needle: string): number {
	let count = 0;
	let from = 0;
	while (from < haystack.length) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return count;
		count++;
		from = at + needle.length;
	}
	return count;
}

withoutTerminalMultiplexer();

describe("resize on Warp, which SIGWINCHes on alt-buffer toggle", () => {
	let saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		saved = {};
		for (const key of TERMINAL_ENV) {
			saved[key] = Bun.env[key];
			delete Bun.env[key];
		}
	});

	afterEach(() => {
		for (const key of TERMINAL_ENV) {
			if (saved[key] === undefined) delete Bun.env[key];
			else Bun.env[key] = saved[key];
		}
		saved = {};
	});

	it("does not borrow the alt buffer for a Warp pane resize", async () => {
		Bun.env.TERM_PROGRAM = "WarpTerminal";
		const term = new AltToggleEchoTerminal(40, 12);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new LineComponent("row-", 8));
		try {
			tui.start();
			await scheduler.settle(term);
			term.altEnters = 0;

			term.resize(40, 20);
			// Quiet window (120) + CPR timeout (200) + another borrow cycle if
			// the echo restarted alt-paint. A loop grows altEnters past 1.
			await scheduler.advance(term, 500);

			expect(term.altEnters).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("borrows the alt buffer once when Warp in-place is forced off", async () => {
		Bun.env.TERM_PROGRAM = "WarpTerminal";
		Bun.env.PI_TUI_RESIZE_IN_PLACE = "0";
		const term = new AltToggleEchoTerminal(40, 12);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new LineComponent("row-", 8));
		try {
			tui.start();
			await scheduler.settle(term);
			term.altEnters = 0;

			term.resize(40, 20);
			await scheduler.advance(term, 500);

			// Forced borrow still happens, but the ±1 echo during the probe
			// must not restart it into a loop.
			expect(term.altEnters).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("borrows the alt buffer on non-Warp terminals", async () => {
		const term = new AltToggleEchoTerminal(40, 12);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new LineComponent("row-", 8));
		try {
			tui.start();
			await scheduler.settle(term);
			term.altEnters = 0;

			term.resize(40, 20);
			await scheduler.advance(term, 500);

			expect(term.altEnters).toBeGreaterThanOrEqual(1);
		} finally {
			tui.stop();
		}
	});
});
