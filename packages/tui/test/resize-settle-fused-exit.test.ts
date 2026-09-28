import { describe, expect, it } from "bun:test";
import {
	type RenderScheduler,
	type RenderTimer,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	Text,
	TUI,
	type ViewportSize,
} from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// A settled rebuild-mode resize erases the screen and history and repaints
// from row zero, so it needs no viewport anchor. Restoring the normal buffer
// on its own write, then probing the anchor, exposed the reflowed stale screen
// for a CPR round trip before the rebuild cleared it: one visible flash per
// large resize (a tmux zoom). The restore now rides inside the rebuild write.

const ALT_ENTER = "\x1b[?1049h";
const ALT_EXIT = "\x1b[?1049l";
const ERASE_SCREEN_AND_HISTORY = "\x1b[2J\x1b[3J";
const DSR = "\x1b[6n";

/** Records every engine write and reports a settable output backlog. */
class RecordingTerminal extends VirtualTerminal {
	written: string[] = [];
	pendingBytes = 0;

	get pendingOutputBytes(): number {
		return this.pendingBytes;
	}

	override write(data: string): void {
		this.written.push(data);
		super.write(data);
	}
}

/** Manual clock: immediates run inline, timers fire only as the clock advances past them. */
class ManualScheduler implements RenderScheduler {
	#now = 0;
	#timers = new Set<{ at: number; run: () => void }>();

	now(): number {
		return this.#now;
	}

	scheduleImmediate(callback: () => void): void {
		callback();
	}

	scheduleRender(callback: () => void, delayMs: number): RenderTimer {
		const timer = { at: this.#now + Math.max(0, delayMs), run: callback };
		this.#timers.add(timer);
		return { cancel: () => this.#timers.delete(timer) };
	}

	advance(ms: number): void {
		const end = this.#now + ms;
		for (;;) {
			let next: { at: number; run: () => void } | undefined;
			for (const timer of this.#timers) {
				if (timer.at <= end && (next === undefined || timer.at < next.at)) next = timer;
			}
			if (next === undefined) break;
			this.#timers.delete(next);
			this.#now = next.at;
			next.run();
		}
		this.#now = end;
	}
}

class WidthReplayProvider implements TerminalFrameProvider {
	#nextHistoryId = 1;
	#retired = false;

	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		const width = viewport.columns;
		return {
			history: this.#retired
				? undefined
				: { id: this.#nextHistoryId, rows: [`history-one@${width}`, `history-two@${width}`] },
			viewport: [`editor@${width}`],
		};
	}

	acknowledgeHistory(id: number): void {
		if (id !== this.#nextHistoryId) return;
		this.#nextHistoryId++;
		this.#retired = true;
	}

	beginHistoryReplay(): void {
		this.#retired = false;
	}
}

function startRig() {
	const terminal = new RecordingTerminal(20, 4);
	const scheduler = new ManualScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	tui.setResizeScrollback("rebuild");
	tui.setFrameProvider(new WidthReplayProvider());
	tui.start();
	scheduler.advance(50);
	terminal.written = [];
	return { terminal, scheduler, tui };
}

function plainRows(terminal: VirtualTerminal): string[] {
	return terminal
		.getScrollBuffer()
		.map(row => row.trimEnd())
		.filter(row => row.length > 0);
}

function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("resize settle fused alt exit", () => {
	it("restores the normal buffer in the same write as the settled rebuild", () => {
		const { terminal, scheduler, tui } = startRig();
		try {
			terminal.resize(30, 4);
			scheduler.advance(500);

			// Restoring on a write of its own would expose the reflowed stale screen
			// until the rebuild lands; the anchor probe that used to fill that gap
			// has nothing to anchor for a repaint that starts at row zero.
			const exitWrites = terminal.written.filter(data => data.includes(ALT_EXIT));
			expect(exitWrites).toHaveLength(1);
			const [rebuild] = exitWrites;
			expect(rebuild!.indexOf(ERASE_SCREEN_AND_HISTORY)).toBeGreaterThan(rebuild!.indexOf(ALT_EXIT));
			expect(terminal.written.join("")).not.toContain(DSR);
			expect(plainRows(terminal)).toEqual(["history-one@30", "history-two@30", "editor@30"]);
		} finally {
			tui.stop();
		}
	});

	it("resumes the borrow when a resize lands before the fused rebuild is written", () => {
		const { terminal, scheduler, tui } = startRig();
		try {
			terminal.resize(30, 4);
			scheduler.advance(100);
			// A previous replay is still draining, so the settled rebuild — and the
			// alt exit fused into it — is deferred while the pane moves again.
			terminal.pendingBytes = Number.MAX_SAFE_INTEGER;
			scheduler.advance(600);
			terminal.resize(34, 4);
			terminal.pendingBytes = 0;
			scheduler.advance(500);

			// The terminal never left the borrowed buffer, so entering it again
			// would stack a second switch whose extra exit then lands on the
			// normal screen after the rebuild.
			const emitted = terminal.written.join("");
			expect(count(emitted, ALT_ENTER)).toBe(1);
			expect(count(emitted, ALT_EXIT)).toBe(1);
			expect(plainRows(terminal)).toEqual(["history-one@34", "history-two@34", "editor@34"]);
		} finally {
			tui.stop();
		}
	});

	it("hands the borrowed buffer to a fullscreen overlay opened before the rebuild is written", () => {
		const { terminal, scheduler, tui } = startRig();
		try {
			terminal.resize(30, 4);
			scheduler.advance(100);
			const overlay = tui.showOverlay(new Text("modal"), { fullscreen: true });
			scheduler.advance(500);

			// The overlay's first frame runs while the fused exit is still pending:
			// it must take over the buffer the terminal is already on.
			expect(count(terminal.written.join(""), ALT_ENTER)).toBe(1);

			overlay.hide();
			scheduler.advance(50);

			const emitted = terminal.written.join("");
			expect(count(emitted, ALT_EXIT)).toBe(1);
			expect(emitted.indexOf(ERASE_SCREEN_AND_HISTORY)).toBeGreaterThan(emitted.indexOf(ALT_EXIT));
			expect(plainRows(terminal)).toEqual(["history-one@30", "history-two@30", "editor@30"]);
		} finally {
			tui.stop();
		}
	});
});
