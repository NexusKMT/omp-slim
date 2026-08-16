import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TranscriptBlock, TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { getMarkdownTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, Container, Markdown, Text, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

// Regression home: a settled tmux width resize replayed the ENTIRE transcript
// into pane history (one duplicated copy per resize; issues #8193/#7026)
// because the width-epoch boundary never resolved for real transcripts:
// - only AssistantMessageComponent implemented getTranscriptBlockVersion, and
//   the resolver rejected every versionless finalized preceding block;
// - a Container-derived epoch segment captured childBoundary === undefined
//   and resolved it to failure;
// - revisionless leading root children were validated by width-dependent
//   row counts, which change on every rewrap;
// - the app resize listener marked every SIGWINCH as "render pending",
//   arming the conservative replay-from-row-zero fallback.
// These tests pin the repaired contract: a settled multiplexer width resize
// must stay viewport-scale (no off-viewport row re-emission, no duplicate
// committed content), while queued growth and unresolvable structural
// changes stay lossless.

type DrainableScheduler = {
	now(): number;
	scheduleImmediate(cb: () => void): void;
	scheduleRender(cb: () => void, delayMs: number): { cancel(): void };
	flush(): void;
};
function makeDrainableScheduler(): DrainableScheduler {
	let clock = 0;
	const queue: Array<{ run: () => void; cancelled: boolean }> = [];
	const enqueue = (cb: () => void) => {
		const item = { run: cb, cancelled: false };
		queue.push(item);
		return item;
	};
	return {
		now: () => clock,
		scheduleImmediate(cb) {
			enqueue(cb);
		},
		scheduleRender(cb) {
			const item = enqueue(cb);
			return {
				cancel() {
					item.cancelled = true;
				},
			};
		},
		flush() {
			let guard = 0;
			while (queue.length > 0) {
				if (++guard > 100_000) throw new Error("scheduler did not settle");
				const item = queue.shift()!;
				clock += 1;
				if (!item.cancelled) item.run();
			}
		},
	};
}

// Finalized-by-default versionless block: the shape of every production block
// except AssistantMessageComponent (user messages, bash/eval executions, tool
// cards, custom messages).
class StaticBlock implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = lines;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return this.#lines;
	}
}

// Versioned finalized block (AssistantMessageComponent shape).
class VersionedBlock extends StaticBlock {
	version = 1;
	getTranscriptBlockVersion(): number {
		return this.version;
	}
}

// Revisionless leading root child whose row count is width-dependent — the
// startup-banner shape that used to fail resolution on every width change.
class WrappingLeaf implements Component {
	#text: string;
	constructor(text: string) {
		this.#text = text;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const rows: string[] = [];
		for (let i = 0; i < this.#text.length; i += safeWidth) {
			rows.push(this.#text.slice(i, i + safeWidth));
		}
		return rows;
	}
}

// Streaming assistant shape: an unfinalized Container block whose Markdown
// child carries the width-epoch source contract.
class StreamingMarkdownBlock extends Container {
	done = false;
	readonly md: Markdown;
	constructor(text: string) {
		super();
		this.md = new Markdown(text, 0, 0, getMarkdownTheme());
		this.addChild(this.md);
	}
	isTranscriptBlockFinalized(): boolean {
		return this.done;
	}
}

// Stand-in for the editor + status below the transcript.
class Footer implements Component {
	#rows: number;
	constructor(rows: number) {
		this.#rows = rows;
	}
	invalidate(): void {}
	render(_width: number): string[] {
		return Array.from({ length: this.#rows }, (_, i) => `editor-${i}`);
	}
}

function markerLines(tag: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `hist-${tag}-${String(i).padStart(3, "0")}`);
}

function combinedRows(term: VirtualTerminal): string[] {
	return [...term.getScrollBuffer(), ...term.getViewport()].map(row => Bun.stripANSI(row).trimEnd());
}

function rowCount(rows: string[], marker: string): number {
	return rows.filter(row => row === marker).length;
}

const ED3 = "\x1b[3J";

describe("multiplexer width-epoch resolution honors the versionless-finalized contract", () => {
	test("resolves a real-session transcript (versionless finalized blocks before the epoch segment)", () => {
		// #given a transcript whose preceding blocks omit getTranscriptBlockVersion
		const transcript = new TranscriptContainer();
		transcript.addChild(new StaticBlock(markerLines("u", 4)));
		transcript.addChild(new StaticBlock(markerLines("t", 8)));
		transcript.addChild(new VersionedBlock(markerLines("a", 6)));
		transcript.render(100);

		// #when a width epoch is captured and the transcript re-renders at a new width
		const marker = transcript.captureNativeScrollbackWidthEpoch();
		transcript.render(80);

		// #then the boundary resolves to the full settled extent instead of failing
		// (a failure here re-enables the full-transcript replay per tmux resize)
		expect(marker).toBeDefined();
		const resolved = transcript.resolveNativeScrollbackWidthEpoch(marker);
		expect(resolved).toBeDefined();
		expect(resolved).toBe(transcript.getNativeScrollbackWidthEpochRows()!);
	});

	test("resolves when the epoch segment is a Container whose capture found no nested source", () => {
		// #given the epoch segment exposes the width-epoch methods (Container) but
		// captured childBoundary === undefined (its children have no epoch source)
		const transcript = new TranscriptContainer();
		transcript.addChild(new StaticBlock(markerLines("u", 4)));
		const bare = new TranscriptBlock();
		bare.addChild(new Text("plain tail block", 0, 0));
		transcript.addChild(bare);
		transcript.render(100);

		// #when the epoch resolves after a width change
		const marker = transcript.captureNativeScrollbackWidthEpoch();
		transcript.render(80);

		// #then whole-segment stability stands in for the missing child boundary
		const resolved = transcript.resolveNativeScrollbackWidthEpoch(marker);
		expect(resolved).toBeDefined();
		expect(resolved).toBe(transcript.getNativeScrollbackWidthEpochRows()!);
	});

	test("still fails when a preceding block's version changed inside the epoch", () => {
		// #given a versioned preceding block
		const mutating = new VersionedBlock(markerLines("m", 4));
		const transcript = new TranscriptContainer();
		transcript.addChild(mutating);
		transcript.addChild(new StaticBlock(markerLines("t", 8)));
		transcript.render(100);
		const marker = transcript.captureNativeScrollbackWidthEpoch();

		// #when the block mutates post-finalize before the settled render
		mutating.version += 1;
		transcript.render(80);

		// #then resolution stays conservative (the lossless replay fallback)
		expect(transcript.resolveNativeScrollbackWidthEpoch(marker)).toBeUndefined();
	});

	test("still fails when a block was inserted before the epoch segment", () => {
		// #given a captured epoch
		const transcript = new TranscriptContainer();
		transcript.addChild(new StaticBlock(markerLines("u", 4)));
		transcript.addChild(new StaticBlock(markerLines("t", 8)));
		transcript.render(100);
		const marker = transcript.captureNativeScrollbackWidthEpoch();

		// #when the structure changes before the epoch segment
		const inserted = new StaticBlock(markerLines("x", 2));
		transcript.children.splice(1, 0, inserted);
		transcript.render(80);

		// #then resolution stays conservative
		expect(transcript.resolveNativeScrollbackWidthEpoch(marker)).toBeUndefined();
	});
});

describe("settled tmux width resize stays viewport-scale", () => {
	let previousTmux: string | undefined;
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		await initTheme();
		previousTmux = Bun.env.TMUX;
		Bun.env.TMUX = "issue-8193";
	});
	afterAll(() => {
		resetSettingsForTest();
		if (previousTmux === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = previousTmux;
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	type Fixture = {
		term: VirtualTerminal;
		scheduler: DrainableScheduler;
		tui: TUI;
		transcript: TranscriptContainer;
	};
	async function buildSettledSession(blocks: Component[]): Promise<Fixture> {
		const term = new VirtualTerminal(100, 30, 2_000);
		const scheduler = makeDrainableScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		// Leading root children ahead of the transcript, like the startup banner:
		// one revisionless width-wrapping leaf and one Text (revision-bearing).
		tui.addChild(new WrappingLeaf(`banner ${"b".repeat(150)}`));
		tui.addChild(new Text(`tip: ${"t".repeat(140)}`, 1, 0));
		const transcript = new TranscriptContainer();
		for (const block of blocks) transcript.addChild(block);
		tui.addChild(transcript);
		tui.addChild(new Footer(3));
		tui.start();
		scheduler.flush();
		await term.flush();
		return { term, scheduler, tui, transcript };
	}

	async function settle(fixture: Fixture): Promise<void> {
		fixture.scheduler.flush();
		await fixture.term.flush();
	}

	function spyWrites(fixture: Fixture): string[] {
		const writes: string[] = [];
		const write = fixture.term.write.bind(fixture.term);
		vi.spyOn(fixture.term, "write").mockImplementation(data => {
			writes.push(data);
			write(data);
		});
		return writes;
	}

	test("idle width shrink+grow re-emits no off-viewport rows and duplicates nothing", async () => {
		// #given a settled idle session taller than the viewport, all history
		// blocks finalized and versionless (the measured production shape)
		const fixture = await buildSettledSession([
			new StaticBlock(markerLines("a", 30)),
			new StaticBlock(markerLines("b", 30)),
			new VersionedBlock(markerLines("c", 30)),
		]);
		try {
			const writes = spyWrites(fixture);

			// #when the app-style resize echo marks a render pending and the pane
			// width shrinks, then grows (tmux resize-window -x 80; -x 110)
			const historyBeforeShrink = fixture.term.getScrollBuffer().length;
			fixture.tui.requestRender();
			fixture.term.resize(80, 30);
			await settle(fixture);
			const shrinkBytes = writes.join("");
			const historyAfterShrink = fixture.term.getScrollBuffer().length;
			writes.length = 0;
			fixture.tui.requestRender();
			fixture.term.resize(110, 30);
			await settle(fixture);
			const growBytes = writes.join("");
			const historyAfterGrow = fixture.term.getScrollBuffer().length;

			// #then no ED3 reaches the pane and no off-viewport transcript row is
			// re-emitted (the full replay wrote every one of them per resize)
			for (const bytes of [shrinkBytes, growBytes]) {
				expect(bytes).not.toContain(ED3);
				expect(bytes).not.toContain("hist-a-000");
				expect(bytes).not.toContain("hist-a-015");
				expect(bytes).not.toContain("hist-b-000");
			}
			// #then history growth per settled resize is viewport-scale (host reflow
			// wraps existing rows and may push at most one screenful), never
			// transcript-scale (the replay appended the whole ~100-row frame)
			expect(historyAfterShrink - historyBeforeShrink).toBeLessThanOrEqual(40);
			expect(historyAfterGrow - historyAfterShrink).toBeLessThanOrEqual(5);
			// #then committed off-viewport content exists exactly once; rows inside
			// the viewport band may be duplicated once by the host's own shrink
			// reflow (pane history keeps its old wrap — the documented tradeoff)
			const rows = combinedRows(fixture.term);
			expect(rowCount(rows, "hist-a-000")).toBe(1);
			expect(rowCount(rows, "hist-a-029")).toBe(1);
			expect(rowCount(rows, "hist-b-015")).toBe(1);
			expect(rowCount(rows, "hist-c-029")).toBeGreaterThanOrEqual(1);
			expect(rowCount(rows, "hist-c-029")).toBeLessThanOrEqual(2);
		} finally {
			fixture.tui.stop();
			await fixture.term.flush();
		}
	});

	test("growth queued during the resize debounce commits exactly once (no loss, no replay)", async () => {
		// #given a settled session streaming into a Markdown-backed live block
		const streaming = new StreamingMarkdownBlock(
			markerLines("s", 20)
				.map(line => `${line}`)
				.join("\n\n"),
		);
		const fixture = await buildSettledSession([
			new StaticBlock(markerLines("a", 30)),
			new StaticBlock(markerLines("b", 30)),
			streaming,
		]);
		try {
			const writes = spyWrites(fixture);

			// #when a width change arrives with a render pending and more output
			// streams in during the debounce window
			fixture.tui.requestRender();
			fixture.term.resize(80, 30);
			streaming.md.setText(`${markerLines("s", 20).join("\n\n")}\n\nhist-q-000\n\nhist-q-001`);
			fixture.tui.requestRender();
			await settle(fixture);
			const bytes = writes.join("");

			// #then the queued rows surface at least once (never dropped; the host's
			// shrink reflow may duplicate a viewport-band row once), and the resize
			// did not replay the off-viewport history to deliver them
			const rows = combinedRows(fixture.term);
			for (const marker of ["hist-q-000", "hist-q-001"]) {
				expect(rowCount(rows, marker)).toBeGreaterThanOrEqual(1);
				expect(rowCount(rows, marker)).toBeLessThanOrEqual(2);
			}
			expect(bytes).not.toContain(ED3);
			expect(bytes).not.toContain("hist-a-000");
			expect(bytes).not.toContain("hist-a-015");
		} finally {
			fixture.tui.stop();
			await fixture.term.flush();
		}
	});

	test("an unresolvable structural change keeps the lossless replay fallback", async () => {
		// #given a settled session
		const fixture = await buildSettledSession([
			new StaticBlock(markerLines("a", 30)),
			new StaticBlock(markerLines("b", 30)),
			new VersionedBlock(markerLines("c", 20)),
		]);
		try {
			const writes = spyWrites(fixture);

			// #when a block is inserted before the epoch segment inside the debounce
			// (resolution cannot express the insert) with a render pending
			fixture.tui.requestRender();
			fixture.term.resize(80, 30);
			const inserted = new StaticBlock(markerLines("n", 4));
			fixture.transcript.children.splice(1, 0, inserted);
			fixture.tui.requestRender();
			await settle(fixture);

			// #then every row is still present somewhere — duplication is allowed
			// (the conservative replay), loss is not — and ED3 stays forbidden
			const rows = combinedRows(fixture.term);
			for (const marker of ["hist-a-000", "hist-b-029", "hist-n-000", "hist-n-003", "hist-c-019"]) {
				expect(rowCount(rows, marker)).toBeGreaterThanOrEqual(1);
			}
			expect(writes.join("")).not.toContain(ED3);
		} finally {
			fixture.tui.stop();
			await fixture.term.flush();
		}
	});
});
