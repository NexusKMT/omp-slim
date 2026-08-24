import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type TerminalFramePlan, type TerminalFrameProvider, TUI, type ViewportSize } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Regression coverage for tmux pane zoom corrupting scrollback (duplication and
// committed-row loss). Multiplexers re-lay the pane on their own schedule
// relative to SIGWINCH delivery and do not keep the parked cursor attached
// through a height shrink, so:
// - the SIGWINCH-side erase must not run (it races the re-layout and blanks
//   pulled-back committed rows, destroying popped scrollback), and
// - the settled anchor must come from the deterministic clip model (blank rows
//   below the viewport clip first, then top rows push, moving the viewport up
//   by exactly the pushed count) instead of CPR-relative math.

class FullFrameProvider implements TerminalFrameProvider {
	history: { id: number; rows: string[] } | undefined;

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		const rows = Array.from({ length: 8 }, (_, i) => `live-${i}`);
		const plan: TerminalFramePlan = { history: this.history, viewport: rows.slice(-Math.min(8, viewport.rows)) };
		return plan;
	}
	renderResizeFrame(viewport: ViewportSize): readonly string[] {
		return Array.from({ length: Math.min(8, viewport.rows) }, (_, i) => `resize-${i}`);
	}
	acknowledgeHistory(): void {
		this.history = undefined;
	}
}

class ResizeScheduler {
	#pending = new Set<() => void>();
	now(): number {
		return 0;
	}
	scheduleImmediate(callback: () => void): void {
		callback();
	}
	scheduleRender(callback: () => void, _delayMs?: number) {
		this.#pending.add(callback);
		return { cancel: () => this.#pending.delete(callback) };
	}
	settle(): void {
		const pending = [...this.#pending];
		this.#pending.clear();
		for (const callback of pending) callback();
	}
}

describe("resize anchoring inside a terminal multiplexer", () => {
	let previousTmux: string | undefined;

	beforeEach(() => {
		previousTmux = Bun.env.TMUX;
		Bun.env.TMUX = "/tmp/tmux-1000/default,1,0";
	});
	afterEach(() => {
		if (previousTmux === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = previousTmux;
	});

	function startRig() {
		const terminal = new VirtualTerminal(40, 12);
		const provider = new FullFrameProvider();
		provider.history = { id: 1, rows: Array.from({ length: 3 }, (_, i) => `committed-${i}`) };
		const renderScheduler = new ResizeScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler });
		const writes: string[] = [];
		const originalWrite = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			writes.push(data);
			originalWrite(data);
		};
		tui.setFrameProvider(provider);
		tui.start();
		return { terminal, tui, renderScheduler, writes };
	}

	it("skips the SIGWINCH-side erase so a racing re-layout cannot blank popped scrollback", () => {
		const { terminal, tui, renderScheduler, writes } = startRig();
		writes.length = 0;
		terminal.resize(40, 20);
		const beforeAlt = writes.join("").split("\x1b[?1049h")[0] ?? "";
		// No ED (erase-below) may be emitted on the normal screen before the alt
		// borrow: the pane may already have been re-laid, so any erase addressed
		// with stale coordinates can destroy pulled-back committed rows.
		expect(beforeAlt.includes("\x1b[J")).toBe(false);
		renderScheduler.settle();
		renderScheduler.settle();
		tui.stop();
	});

	it("anchors a settled single-step shrink from the parked cursor, not content depth", () => {
		const { terminal, tui, renderScheduler, writes } = startRig();
		// Baseline: 3 committed rows above an 8-row live frame, viewport top = 3,
		// cursor parked at the viewport top (no marker). tmux discards rows below
		// the cursor before pushing anything (measured: even non-blank rows), so
		// a shrink by 6 is absorbed entirely by the 8 below-cursor rows: nothing
		// pushes and the anchor must stay at row 3. A content-depth model would
		// compute pushed=5 and anchor at 0, overwriting the still-visible
		// committed rows.
		terminal.resize(40, 6);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		writes.length = 0;
		renderScheduler.settle(); // probe timeout path -> settled repaint
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(4);
		tui.stop();
	});

	it("treats a coalesced multi-step shrink burst cumulatively from pre-burst state", () => {
		const { terminal, tui, renderScheduler, writes } = startRig();
		// Burst 12 -> 6 -> 2 with no settle in between: cumulative shrink 10,
		// below-cursor rows 8 (cursor parked at viewport top 3), so pushed = 2
		// and the anchor lands at 3 - 2 = 1 (CUP row 2). Per-step recomputation
		// against refreshed state would double-count the below-cursor budget.
		terminal.resize(40, 6);
		terminal.resize(40, 2);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		writes.length = 0;
		renderScheduler.settle(); // probe timeout path -> settled repaint
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(2);
		tui.stop();
	});
});
