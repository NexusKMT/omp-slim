import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	CURSOR_MARKER,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
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
	markerRow: number | undefined;
	liveRows = 8;

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		const rows = Array.from({ length: this.liveRows }, (_, i) => `live-${i}`);
		if (this.markerRow !== undefined) rows[this.markerRow] = `${rows[this.markerRow]}${CURSOR_MARKER}`;
		const plan: TerminalFramePlan = { history: this.history, viewport: rows.slice(-Math.min(this.liveRows, viewport.rows)) };
		return plan;
	}
	renderResizeFrame(viewport: ViewportSize): readonly string[] {
		return Array.from({ length: Math.min(8, viewport.rows) }, (_, i) => `resize-${i}`);
	}
	acknowledgeHistory(): void {
		this.history = undefined;
	}
}

function startRig(markerRow?: number) {
	const terminal = new VirtualTerminal(40, 12);
	const provider = new FullFrameProvider();
	provider.markerRow = markerRow;
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
	return { terminal, tui, provider, renderScheduler, writes };
}

class ResizeScheduler {
	#pending = new Set<() => void>();
	/** Mutable clock: advance past the 100 ms post-settle resize suppression. */
	t = 0;
	now(): number {
		return this.t;
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

	it("falls back to the settled CPR when a coalesced burst reverses direction", () => {
		// Burst 12 -> 20 -> 6: the grow pulls the 3 committed scrollback rows
		// into the pane (parked cursor rides down 3 -> 6), then the 14-row
		// shrink discards the 13 rows below the cursor and pushes 1, leaving
		// the real viewport top at 5 — which the settled CPR reports, because
		// tmux keeps the parked cursor attached through both moves. The clip
		// model would telescope the net 12 -> 6 shrink from pre-burst state
		// (pushed=0, anchor 3) and repaint above the real viewport; the
		// `height - staleRows` bound would be worse still, dragging the anchor
		// to 0 over five retained history rows (tmux discarded stale rows
		// below the cursor rather than pushing them, so the bottom-preserving
		// bound does not hold). The reversed burst must anchor exactly where
		// the CPR reports.
		const { terminal, tui, renderScheduler, writes } = startRig();
		terminal.resize(40, 20);
		terminal.resize(40, 6);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		writes.length = 0;
		terminal.sendInput("\x1b[6;1R"); // parked cursor: real viewport top, row 5
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(6);
		tui.stop();
	});
});

// Regression coverage for the CPR probe's pre-erase stash on direct terminals:
// the stash (window + park offset) feeds both the `height - staleRows` anchor
// bound and the CPR-relative offset math, so a stale offset or a wiped stash
// silently disables the exact protections the stash exists to provide.
describe("resize anchor probe stash on a direct terminal", () => {
	// Every signal isInsideTerminalMultiplexer() recognizes; the suite itself
	// may run under tmux, screen, Zellij, CMUX, or Herdr.
	const MUX_SIGNALS = [
		"TMUX",
		"STY",
		"ZELLIJ",
		"HERDR_ENV",
		"CMUX_WORKSPACE_ID",
		"CMUX_SURFACE_ID",
		"CMUX_REMOTE_TRANSPORT",
		"TERM",
	] as const;
	let saved: Partial<Record<(typeof MUX_SIGNALS)[number], string | undefined>>;

	beforeEach(() => {
		saved = {};
		for (const key of MUX_SIGNALS) {
			saved[key] = Bun.env[key];
			delete Bun.env[key];
		}
		// TERM prefixed tmux-/screen- also flags a multiplexer.
		Bun.env.TERM = "xterm-256color";
	});
	afterEach(() => {
		for (const key of MUX_SIGNALS) {
			if (saved[key] === undefined) delete Bun.env[key];
			else Bun.env[key] = saved[key];
		}
	});

	it("zeroes the probe offset after the erase parks the cursor on the viewport top", () => {
		// A cursor marker in live row 4 parks the hardware cursor at offset 4
		// from the viewport top. The SIGWINCH-side erase re-parks the cursor on
		// the viewport's top row, so the settled CPR (row 4 -> viewport top 3)
		// must anchor at 3 (CUP row 4). Carrying the stale offset into the probe
		// would compute 3 - 4 and anchor the repaint at 0, overwriting the three
		// still-visible committed rows.
		const { terminal, tui, renderScheduler, writes } = startRig(4);
		terminal.resize(40, 11);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		writes.length = 0;
		terminal.sendInput("\x1b[4;1R"); // parked cursor: viewport top, screen row 3
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(4);
		tui.stop();
	});

	it("keeps the stash when a mid-probe SIGWINCH restarts the transaction", () => {
		// A resize landing after the settle but before the CPR reply restarts
		// the transaction with the live window already stashed and emptied. The
		// restart must not overwrite the stash with the empty window: the second
		// probe still needs the 8-row snapshot so its `height - staleRows` bound
		// (6 - 8 -> 0) overrides the reported row. A wiped stash would bound
		// nothing (staleRows 0) and anchor at the reported row 3, scroll-pushing
		// the repaint into scrollback — the original duplication bug.
		const { terminal, tui, renderScheduler, writes } = startRig();
		terminal.resize(40, 11);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		terminal.resize(40, 6); // mid-probe restart: cancels the probe, window already []
		renderScheduler.settle(); // exit the second borrow, start the second probe
		writes.length = 0;
		terminal.sendInput("\x1b[4;1R"); // canceled first probe's delayed reply: swallowed
		terminal.sendInput("\x1b[4;1R"); // second probe's reply: parked cursor still on row 3
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(1);
		tui.stop();
	});

	it("swallows the canceled probe's delayed reply after a mid-probe restart", () => {
		// The restart cancels the first probe, but its CSI 6n reply is still in
		// flight and reports the cursor row from before the second resize.
		// Matching it to the second probe would anchor the settled repaint at
		// the pre-restart row 3 (CUP row 4) and drop the real reply; the
		// serialized probe must swallow it and anchor at the second reply's
		// row 1 (CUP row 2). A 2-row window keeps the height-staleRows bound
		// (6 - 2 = 4) from masking the difference.
		const { terminal, tui, provider, renderScheduler, writes } = startRig();
		provider.liveRows = 2;
		tui.requestRender(true);
		terminal.resize(40, 11);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		terminal.resize(40, 6); // mid-probe restart: first reply still outstanding
		renderScheduler.settle(); // exit the second borrow, start the second probe
		writes.length = 0;
		terminal.sendInput("\x1b[4;1R"); // stale: cursor row before the second resize
		expect(writes.join("")).not.toMatch(/\x1b\[\d+;1H/);
		terminal.sendInput("\x1b[2;1R"); // real: parked cursor after the second resize
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(2);
		tui.stop();
	});

	it("recovers the swallowed reply when the canceled probe's reply was dropped", () => {
		// If the canceled probe's reply never arrives, the only reply the
		// second probe sees is its own — swallowed as presumed-stale. The
		// timeout must then anchor from that swallowed row (exact in this
		// drop case) instead of the pre-resize viewport top: reply row 1
		// anchors at 1 (CUP row 2), while the pre-resize fallback would
		// anchor at the stale top 3 (CUP row 4).
		const { terminal, tui, provider, renderScheduler, writes } = startRig();
		provider.liveRows = 2;
		tui.requestRender(true);
		terminal.resize(40, 11);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		terminal.resize(40, 6); // mid-probe restart: canceled reply never arrives
		renderScheduler.settle(); // exit the second borrow, start the second probe
		terminal.sendInput("\x1b[2;1R"); // the second probe's own reply: swallowed
		writes.length = 0;
		renderScheduler.settle(); // probe timeout -> settled repaint
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(2);
		tui.stop();
	});

	it("snapshots a legitimately empty viewport on a fresh transaction", () => {
		// A completed resize populates the stash; a later normal frame may
		// legitimately render an empty viewport. The next fresh transaction must
		// snapshot that empty window: keeping the old 8-row stash would clamp
		// the anchor with `height - staleRows` rows that are no longer on
		// screen (6 - 8 -> 0) and erase committed rows above the real (empty)
		// viewport. With the refreshed stash the anchor stays at the viewport
		// top (row 3, CUP row 4).
		const { terminal, tui, provider, renderScheduler, writes } = startRig();
		terminal.resize(40, 11);
		renderScheduler.settle(); // exit the resize alt borrow, start the CPR probe
		renderScheduler.settle(); // probe timeout path -> settled repaint populates the stash
		renderScheduler.t = 1000; // step past the post-settle resize suppression
		provider.liveRows = 0;
		tui.requestRender(true); // normal frame with an empty viewport
		terminal.resize(40, 6); // fresh transaction: no probe in flight
		renderScheduler.settle();
		writes.length = 0;
		renderScheduler.settle();
		const repaint = writes.join("");
		const cup = repaint.match(/\x1b\[(\d+);1H/);
		expect(cup).not.toBeNull();
		expect(Number(cup![1])).toBe(4);
		tui.stop();
	});
});
