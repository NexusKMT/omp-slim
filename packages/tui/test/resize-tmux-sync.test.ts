import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PtySession } from "@oh-my-pi/pi-natives";
import { CURSOR_MARKER, Text, TUI, type TerminalFramePlan, type ViewportSize } from "@oh-my-pi/pi-tui";
import type { PrivateModeReportHandler } from "@oh-my-pi/pi-tui/terminal";
import * as capabilities from "@oh-my-pi/pi-tui/terminal-capabilities";
import * as multiplexer from "@oh-my-pi/pi-tui/terminal-multiplexer";
import { $ } from "bun";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { WidthReplayProvider } from "./width-replay-provider";

const ALT_ENTER = "\x1b[?1049h";
const ALT_EXIT = "\x1b[?1049l";
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const REBUILDING = "↻ Rebuilding…";

class RecordingTerminal extends VirtualTerminal {
	written: string[] = [];
	pendingBytes = 0;
	report?: PrivateModeReportHandler;

	onPrivateModeReport(callback: PrivateModeReportHandler): void {
		this.report = callback;
	}

	get pendingOutputBytes(): number {
		return this.pendingBytes;
	}

	override write(data: string): void {
		this.written.push(data);
		super.write(data);
	}
}

class CursorProvider extends WidthReplayProvider {
	override renderFrame(size: ViewportSize): TerminalFramePlan {
		const plan = super.renderFrame(size);
		return {
			...plan,
			history: plan.history && this.resetCount > 0 ? { ...plan.history, kind: "replay" } : plan.history,
			viewport: [`editor@${size.columns}${CURSOR_MARKER}`],
		};
	}
}

async function startRig(count = 2, supported = true, padding = 0) {
	const terminal = new RecordingTerminal(80, 24, count + 100);
	const scheduler = new VirtualRenderScheduler();
	const provider = new CursorProvider(
		Array.from(
			{ length: count },
			(_, i) => `ROW${i.toString().padStart(5, "0")} \x1b[32m한글\x1b[0m${" ".repeat(padding)}`,
		),
	);
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	tui.setResizeScrollback("rebuild");
	tui.setFrameProvider(provider);
	tui.start();
	terminal.report?.(2026, supported, true);
	await scheduler.settle(terminal);
	terminal.written = [];
	return { terminal, scheduler, provider, tui };
}

describe("tmux synchronized rebuild", () => {
	beforeEach(() => {
		spyOn(multiplexer, "classifyTerminalMultiplexer").mockReturnValue("tmux");
		spyOn(capabilities, "isInsideTerminalMultiplexer").mockReturnValue(true);
		spyOn(capabilities, "shouldEnableSynchronizedOutputByDefault").mockReturnValue(false);
		spyOn(capabilities, "synchronizedOutputUserOverride").mockReturnValue(null);
	});
	afterEach(() => vi.restoreAllMocks());

	it("shows delayed feedback without moving the cursor, then replaces it with the settled rebuild", async () => {
		const { terminal, scheduler, provider, tui } = await startRig(1000);
		try {
			terminal.resize(100, 30);
			// Apply the harness's deferred native reflow before observing the
			// notice; resizing itself can move both content and the cursor.
			terminal.write("");
			terminal.written = [];
			await scheduler.settle(terminal, 79);
			expect(terminal.written).toEqual([]);
			const cursor = terminal.getCursor();
			const before = terminal.getViewport();
			await scheduler.settle(terminal, 80);
			expect(terminal.getViewport().at(-1)?.trim()).toBe(REBUILDING);
			expect(terminal.getViewport().slice(0, -1)).toEqual(before.slice(0, -1));
			expect(terminal.getCursor()).toEqual(cursor);
			terminal.resize(90, 26);
			await scheduler.settle(terminal, 80);
			expect(terminal.getViewport().at(-1)?.trim()).toBe(REBUILDING);
			expect(provider.resetCount).toBe(0);
			await scheduler.advance(terminal, 80);
			const output = terminal.written.join("");
			expect(output).not.toContain(ALT_ENTER);
			expect(output).not.toContain(ALT_EXIT);
			expect(output).not.toContain("\x1b[6n");
			expect(provider.resetCount).toBe(1);
			expect(
				terminal
					.getScrollBuffer()
					.map(row => row.trimEnd())
					.filter(Boolean),
			).toEqual([
				...Array.from({ length: 1000 }, (_, i) => `ROW${i.toString().padStart(5, "0")} 한글@90`),
				"editor@90",
			]);
			expect(terminal.getCursor()).toEqual({ row: 25, col: 9 });
		} finally {
			tui.stop();
		}
	});

	it("replays compact padding with identical cells, colors, links, and scrollback", async () => {
		const terminal = new RecordingTerminal(40, 6);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const url = "https://example.test/a        b";
		const history = [
			`\x1b]8;;${url}\x07linked        text\x1b]8;;\x07`,
			"older".padEnd(40),
			"\x1bPignored        payload\x1b\\older-dcs",
		];
		const viewport = [
			`\x1b[4;48;2;35;40;48m한글${" ".repeat(32)}끝\x1b[0m`,
			"plain        tail",
			"combining e\u0301        끝",
			"",
			`\x1b[31m${" ".repeat(40)}\x1b[0m`,
			"editor",
		];
		let id = 0;
		let pending = false;
		tui.setFrameProvider({
			beginHistoryReplay() {
				id++;
				pending = true;
			},
			acknowledgeHistory() {
				pending = false;
			},
			renderFrame() {
				return {
					history: pending ? { id, rows: history, kind: "replay" } : undefined,
					viewport,
				};
			},
		});
		tui.start();
		try {
			await scheduler.settle(terminal);
			// A prior colored frame must not tint the initial clear or the fresh
			// rows that scroll into view after replaying past the screen height.
			terminal.write("\x1b[41m\x1b[2J");
			terminal.written = [];
			tui.requestRender(true, { clearScrollback: true });
			await scheduler.settle(terminal);
			const expected = new VirtualTerminal(40, 6);
			expected.write("\x1b[?7l" + [...history, ...viewport].map(row => `${row}\x1b[0m\x1b]8;;\x07\r`).join("\n"));
			expect(terminal.getScrollBuffer()).toEqual(expected.getScrollBuffer());
			for (let row = 0; row < 6; row++) {
				expect(terminal.getViewportRowBackgroundValues(row)).toEqual(expected.getViewportRowBackgroundValues(row));
				expect(terminal.getViewportRowForegroundColumns(row)).toEqual(
					expected.getViewportRowForegroundColumns(row),
				);
				expect(terminal.getViewportRowUnderlineColumns(row)).toEqual(expected.getViewportRowUnderlineColumns(row));
			}
			const output = terminal.written.join("");
			// Padding text is encoded, while OSC/DCS payload spaces keep their
			// protocol meaning. Hyperlink targets must never be rewritten as REP.
			expect(output).toContain(" \x1b[31b");
			expect(output).toContain(`\x1b]8;;${url}\x07`);
			expect(output).toContain("\x1bPignored        payload\x1b\\");
		} finally {
			tui.stop();
		}
	});

	it("renews tmux's hold across a large UTF-8 replay and releases only after the editor cursor", async () => {
		const { terminal, scheduler, tui } = await startRig(10000);
		try {
			terminal.resize(100, 30);
			await scheduler.advance(terminal, 160);
			const output = terminal.written.find(data => data.includes("\x1b[3J"))!;
			const segments = output.split(SYNC_BEGIN);
			// Bound the transmitted work between renewals. One complete row can
			// cross the threshold; no renewal may bisect its SGR/OSC framing.
			expect(segments.length).toBeGreaterThan(10);
			for (const segment of segments) expect(Buffer.byteLength(segment)).toBeLessThan(17 * 1024);
			expect(output.split(SYNC_END)).toHaveLength(2);
			expect(output.indexOf(SYNC_END)).toBeGreaterThan(output.indexOf("editor@100"));
			expect(terminal.getCursor()).toEqual({ row: 29, col: 10 });
			expect(terminal.getScrollBuffer().filter(row => row.includes("ROW"))).toHaveLength(10000);
		} finally {
			tui.stop();
		}
	});

	it("uses the latest width when a queued rebuild is blocked by older output", async () => {
		const { terminal, scheduler, tui } = await startRig();
		try {
			terminal.resize(100, 30);
			terminal.pendingBytes = Number.MAX_SAFE_INTEGER;
			await scheduler.advance(terminal, 160);
			expect(terminal.written).toEqual([]);
			terminal.resize(90, 26);
			terminal.pendingBytes = 0;
			await scheduler.advance(terminal, 160);
			const output = terminal.written.join("");
			expect(output).not.toContain("@100");
			expect(output).toContain("editor@90");
			expect(output.split("\x1b[3J")).toHaveLength(2);
		} finally {
			tui.stop();
		}
	});

	it("shows feedback when a drained output pump still reports a small cached backlog", async () => {
		const { terminal, scheduler, tui } = await startRig();
		try {
			// ProcessTerminal caches small backlog bounds even after the native
			// writer drains. This is not an exact outstanding byte count.
			terminal.pendingBytes = 4096;
			terminal.resize(100, 30);
			await scheduler.settle(terminal, 80);
			expect(terminal.getViewport().at(-1)?.trim()).toBe(REBUILDING);
			await scheduler.advance(terminal, 80);
			expect(terminal.getViewport().join("\n")).toContain("editor@100");
			expect(terminal.getScrollBuffer().join("\n")).not.toContain(REBUILDING);
		} finally {
			tui.stop();
		}
	});

	it("keeps height-only grows on the short settle without replaying history", async () => {
		const { terminal, scheduler, provider, tui } = await startRig(1000);
		try {
			terminal.resize(80, 30);
			await scheduler.advance(terminal, 160);
			expect(terminal.written.join("")).toContain("editor@80");
			expect(provider.resetCount).toBe(0);
			terminal.resize(80, 36);
			await scheduler.advance(terminal, 160);
			expect(provider.resetCount).toBe(0);
			expect(terminal.written.join("")).not.toContain(ALT_ENTER);
			expect(terminal.written.join("")).not.toContain(REBUILDING);
		} finally {
			tui.stop();
		}
	});

	it("recovers history overwritten by a stale frame before a grow notification", async () => {
		const { terminal, scheduler, provider, tui } = await startRig(1000);
		try {
			terminal.resize(80, 30);
			// tmux has grown, but a frame queued before SIGWINCH still addresses
			// the old bottom row. Its erase destroys pulled-down history and its
			// cursor makes the later CPR look like a valid, low viewport anchor.
			terminal.write("\x1b[24;1H\x1b[Jstale-editor\x1b[24;1H");
			terminal.written = [];
			await scheduler.advance(terminal, 160);
			expect(provider.resetCount).toBe(1);
			expect(terminal.getViewport().at(-1)?.trim()).toBe("editor@80");
			expect(terminal.getScrollBuffer().filter(row => row.includes("ROW"))).toEqual(
				Array.from({ length: 1000 }, (_, i) => `ROW${i.toString().padStart(5, "0")} 한글@80`),
			);
			expect(terminal.getScrollBuffer().join("\n")).not.toContain("stale-editor");
		} finally {
			tui.stop();
		}
	});

	it("rebuilds once after a height burst containing a shrink even when it ends taller", async () => {
		const { terminal, scheduler, provider, tui } = await startRig(1000);
		try {
			for (const height of [12, 40, 16, 55]) {
				terminal.resize(80, height);
				await scheduler.advance(terminal, 35);
			}
			expect(provider.resetCount).toBe(0);
			await scheduler.advance(terminal, 160);
			expect(provider.resetCount).toBe(1);
			expect(terminal.getViewport().at(-1)?.trim()).toBe("editor@80");
			expect(terminal.getScrollBuffer().filter(row => row.includes("ROW"))).toEqual(
				Array.from({ length: 1000 }, (_, i) => `ROW${i.toString().padStart(5, "0")} 한글@80`),
			);
		} finally {
			tui.stop();
		}
	});

	it("retains the alternate-screen fallback when tmux reports no synchronized output", async () => {
		const { terminal, scheduler, tui } = await startRig(2, false);
		try {
			terminal.resize(100, 30);
			await scheduler.advance(terminal, 160);
			const output = terminal.written.join("");
			expect(output).toContain(ALT_ENTER);
			expect(output).toContain(ALT_EXIT);
			expect(output).not.toContain(SYNC_BEGIN);
			expect(output).toContain("editor@100");
		} finally {
			tui.stop();
		}
	});

	it("honors a synchronized-output opt-out even when tmux reports support", async () => {
		spyOn(capabilities, "synchronizedOutputUserOverride").mockReturnValue(false);
		const { terminal, scheduler, tui } = await startRig();
		try {
			terminal.resize(100, 30);
			await scheduler.advance(terminal, 160);
			const output = terminal.written.join("");
			expect(output).toContain(ALT_ENTER);
			expect(output).not.toContain(SYNC_BEGIN);
			expect(output).toContain("editor@100");
		} finally {
			tui.stop();
		}
	});

	it("restores the rebuilt conversation after an overlay opens during settling", async () => {
		const { terminal, scheduler, tui } = await startRig();
		try {
			terminal.resize(100, 30);
			await scheduler.settle(terminal, 80);
			expect(terminal.getViewport().join("\n")).toContain(REBUILDING);
			const overlay = tui.showOverlay(new Text("modal"), { fullscreen: true });
			await scheduler.advance(terminal, 160);
			expect(terminal.getViewport().join("\n")).toContain("modal");
			overlay.hide();
			await scheduler.settle(terminal);
			expect(terminal.getViewport().join("\n")).toContain("editor@100");
			expect(terminal.getScrollBuffer().join("\n")).not.toContain(REBUILDING);
			expect(terminal.written.join("").split(ALT_ENTER)).toHaveLength(2);
			expect(terminal.written.join("").split(ALT_EXIT)).toHaveLength(2);
		} finally {
			tui.stop();
		}
	});

	it("cancels a pending rebuild on stop without later writes or buffer switches", async () => {
		const { terminal, scheduler, provider, tui } = await startRig();
		terminal.resize(100, 30);
		tui.stop();
		const stopped = terminal.written.join("");
		await scheduler.advance(terminal, 160);
		expect(terminal.written.join("")).toBe(stopped);
		expect(stopped).not.toContain(ALT_ENTER);
		expect(stopped).not.toContain(ALT_EXIT);
		expect(provider.resetCount).toBe(0);
	});

	it("removes an already visible notice on stop and does not resurrect its timer on restart", async () => {
		const { terminal, scheduler, tui } = await startRig();
		terminal.resize(100, 30);
		await scheduler.settle(terminal, 80);
		expect(terminal.getViewport().join("\n")).toContain(REBUILDING);
		tui.stop();
		expect(terminal.getScrollBuffer().join("\n")).not.toContain(REBUILDING);
		tui.start();
		try {
			await scheduler.advance(terminal, 160);
			expect(terminal.getViewport().join("\n")).toContain("editor@100");
			expect(terminal.getScrollBuffer().join("\n")).not.toContain(REBUILDING);
		} finally {
			tui.stop();
		}
	});

	it("fits feedback in a narrow pane without wrapping it into history", async () => {
		const { terminal, scheduler, tui } = await startRig();
		try {
			terminal.resize(5, 2);
			terminal.write("");
			await scheduler.settle(terminal, 79);
			const before = terminal.getScrollBuffer().slice(0, -1);
			const cursor = terminal.getCursor();
			await scheduler.settle(terminal, 80);
			expect(terminal.getViewport().at(-1)?.trim()).toBe("↻ Reb");
			expect(terminal.getScrollBuffer().slice(0, -1)).toEqual(before);
			expect(terminal.getCursor()).toEqual(cursor);
		} finally {
			tui.stop();
		}
	});

	// Requires tmux with application-side DEC 2026 support (e.g. next-3.9).
	// PI_TEST_TMUX_SYNC=1 bun test packages/tui/test/resize-tmux-sync.test.ts
	// A detached capture-pane alone cannot catch intermediate frames: attach a
	// real PTY client and inspect everything tmux actually sends it during replay.
	it.skipIf(Bun.env.PI_TEST_TMUX_SYNC !== "1")(
		"keeps the real Composer at the bottom through rapid height growth and later oscillation",
		async () => {
			const tmux = Bun.which("tmux");
			if (!tmux) throw new Error("PI_TEST_TMUX_SYNC requires tmux");
			const args = ["-L", `tui-height-${process.pid}-${Date.now()}`, "-f", "/dev/null"];
			await $`${tmux} ${args} new-session -d -s probe -x 100 -y 70 sleep 60`.quiet();
			try {
				await $`${tmux} ${args} set-option -g history-limit 10000`.quiet();
				await $`${tmux} ${args} split-window -v -l 30 -t probe:0.0 ${process.execPath} ${path.join(import.meta.dir, "fixtures/tmux-resize-composer.ts")}`.quiet();
				const verify = async (height: number, resets?: number): Promise<void> => {
					const deadline = performance.now() + 5000;
					while (true) {
						const title = await $`${tmux} ${args} display-message -p -t probe:0.1 ${"#{pane_title}"}`
							.quiet()
							.text();
						if (title.startsWith("{")) {
							const state: { height: number; resets: number } = JSON.parse(title);
							if (state.height === height && (resets === undefined || state.resets === resets)) break;
						}
						if (performance.now() > deadline) throw new Error(`Unsettled height ${height}: ${title}`);
						await Bun.sleep(20);
					}
					const visible = await $`${tmux} ${args} capture-pane -p -t probe:0.1`.quiet().text();
					expect(visible.split("\n").slice(0, height).at(-1)?.trim()).toBe("EDITOR-BOTTOM");
					const history = await $`${tmux} ${args} capture-pane -p -S - -t probe:0.1`.quiet().text();
					expect([...history.matchAll(/block-(\d+)/g)].map(match => Number(match[1]))).toEqual(
						Array.from({ length: 1000 }, (_, i) => i),
					);
				};
				await verify(30, 0);
				// Let the initial PTY-size throttle expire. The first grow must
				// reach the app immediately, while subsequent grows race its CPR
				// inside tmux's 250 ms SIGWINCH throttle window.
				await Bun.sleep(300);
				for (const height of [35, 45, 55, 65]) {
					await $`${tmux} ${args} resize-pane -y ${height} -t probe:0.1`.quiet();
					await Bun.sleep(35);
				}
				await verify(65, 0);
				await $`${tmux} ${args} resize-pane -y 20 -t probe:0.1`.quiet();
				await verify(20, 1);
				// Grow immediately after the replay: queued retirement frames can
				// reach the enlarged tmux grid before its throttled SIGWINCH. The
				// recovery may need a replay; the contract is intact history and a
				// bottom-anchored editor, independent of signal delivery timing.
				await $`${tmux} ${args} resize-pane -y 45 -t probe:0.1`.quiet();
				await verify(45);
				for (const height of [12, 40, 16, 55]) {
					await $`${tmux} ${args} resize-pane -y ${height} -t probe:0.1`.quiet();
					await Bun.sleep(35);
				}
				await verify(55);
			} finally {
				await $`${tmux} ${args} kill-server`.quiet().nothrow();
			}
		},
		15000,
	);

	it.skipIf(Bun.env.PI_TEST_TMUX_SYNC !== "1")(
		"shows only the final history tail to an attached tmux client across slow zoom/unzoom rebuilds",
		async () => {
			const tmux = Bun.which("tmux");
			if (!tmux) throw new Error("PI_TEST_TMUX_SYNC requires tmux");
			const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tui-tmux-sync-"));
			const socket = `tui-sync-${process.pid}-${Date.now()}`;
			const args = ["-L", socket, "-f", "/dev/null"];
			const client = new PtySession();
			const screen = new VirtualTerminal(100, 30);
			let output = "";
			const errors: Error[] = [];
			// Start with a split window so actual zoom/unzoom changes the width.
			await $`${tmux} ${args} new-session -d -s probe -x 100 -y 30`.quiet();
			try {
				await $`${tmux} ${args} set-option -g status off`.quiet();
				await $`${tmux} ${args} set-option -g history-limit 20000`.quiet();
				await $`${tmux} ${args} split-window -h -l 49 -t probe:0.0 ${process.execPath} ${path.join(import.meta.dir, "fixtures/tmux-slow-output.ts")} ${directory}`.quiet();
				const attached = client.startArgv(
					{
						application: tmux,
						args: [...args, "-T", "sync", "attach-session", "-t", "probe"],
						env: { TERM: "xterm-256color" },
						cols: 100,
						rows: 30,
						timeoutMs: 30000,
					},
					(error, chunk) => {
						if (error) errors.push(error);
						output += chunk;
						screen.write(chunk);
					},
				);
				try {
					await Bun.sleep(300);
					// Answer startup queries like the outer terminal. Leaving DA
					// unanswered causes a capability-timeout redraw mid-replay.
					client.write("\x1b[?1;2c\x1b[>0;0;0c\x1b[?2026;2$y");
					await Bun.sleep(100);
					let frame = 0;
					const sendFrame = async (data: string, observeHold = false): Promise<number> => {
						const started = performance.now();
						await Bun.write(`${directory}/${frame}.pending`, data);
						await fs.rename(`${directory}/${frame}.pending`, `${directory}/${frame}.frame`);
						let observedHold = false;
						while (!(await Bun.file(`${directory}/${frame}.done`).exists())) {
							const elapsed = performance.now() - started;
							if (elapsed > 10000) throw new Error("tmux replay timed out");
							if (observeHold && !observedHold && elapsed > 500) {
								expect(screen.getViewport().join("\n")).toContain(REBUILDING);
								observedHold = true;
							}
							await Bun.sleep(20);
						}
						if (observeHold) expect(observedHold).toBe(true);
						frame++;
						return performance.now() - started;
					};
					for (const count of [1000, 10000]) {
						const { terminal, scheduler, tui } = await startRig(count, true, 12);
						try {
							for (let toggle = 0; toggle < 2; toggle++) {
								await $`${tmux} ${args} resize-pane -Z -t probe:0.1`.quiet();
								const size =
									await $`${tmux} ${args} display-message -p -t probe:0.1 ${"#{pane_width},#{pane_height}"}`
										.quiet()
										.text();
								const [columns, rows] = size.trim().split(",").map(Number) as [number, number];
								terminal.written = [];
								terminal.resize(columns, rows);
								await scheduler.settle(terminal, 80);
								// Let tmux finish the native layout redraw before observing
								// the application's settled replay, as in the real debounce.
								await Bun.sleep(80);
								output = "";
								await sendFrame(terminal.written.join(""));
								await Bun.sleep(20);
								expect(screen.getViewport().join("\n")).toContain(REBUILDING);
								terminal.written = [];
								await scheduler.advance(terminal, 80);
								output = "";
								const elapsed = await sendFrame(terminal.written.join(""), count === 10000);
								if (count === 10000) expect(elapsed).toBeGreaterThan(1000);
								await Bun.sleep(200);
								expect(screen.getViewport().join("\n")).not.toContain(REBUILDING);
								const observed = [...output.matchAll(/ROW(\d{5})/g)].map(match => Number(match[1]));
								expect(observed.length).toBeGreaterThan(0);
								expect(observed.filter(index => index < count - rows)).toEqual([]);
								expect(output).toContain(`editor@${columns}`);
								const history = await $`${tmux} ${args} capture-pane -p -S - -t probe:0.1`.quiet().text();
								expect(history.trimEnd().split("\n")).toEqual([
									...Array.from(
										{ length: count },
										(_, i) => `ROW${i.toString().padStart(5, "0")} 한글${" ".repeat(12)}@${columns}`,
									),
									`editor@${columns}`,
								]);
							}
						} finally {
							tui.stop();
						}
					}
					expect(errors).toEqual([]);
				} finally {
					client.kill();
					await attached;
				}
			} finally {
				await $`${tmux} ${args} kill-server`.quiet().nothrow();
				await fs.rm(directory, { recursive: true, force: true });
			}
		},
		30000,
	);
});
