import { describe, expect, it, vi } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

// Kitty OSC 66 text-sizing marker and the two erase sequences the renderer
// emits for ordinary rows. A scale-`s` heading renders `s` cells tall, so the
// blank rows beneath it hold the multicell glyph's lower half — erasing them
// clears the glyph and leaves reserved-but-invisible space (issue #8318).
const OSC66 = "\x1b]66;";
const ST = "\x1b\\";
const ERASE_TO_EOL = "\x1b[K";
const ERASE_LINE = "\x1b[2K";

class RawLines implements Component {
	#lines: string[];
	constructor(lines: string[]) {
		this.#lines = lines;
	}
	invalidate(): void {}
	render(): string[] {
		return this.#lines;
	}
}
// Flush the real render scheduler. Its throttle and post-paint settle windows
// are driven by the platform clock, so these integration tests wait real time
// (the suite-wide convention in deccara/image-budget tests) rather than mock a
// scheduler that would not exercise the resize-settle full paint under test.
async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(40);
	await term.flush();
}

// A non-multiplexer resize paints the viewport immediately and defers the
// authoritative full paint until the drag settles (120 ms window).
async function settleResize(term: VirtualTerminal): Promise<void> {
	await Bun.sleep(160);
	await settle(term);
}

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

/**
 * Split the paint write that carries the sized heading into terminal rows and
 * return the heading row plus the `spacerCount` rows written directly beneath
 * it. Rows are `\r\n`-separated in the emitted buffer; the OSC 66 ST (`ESC \\`)
 * never contains a newline, so the split keeps each span intact.
 */
function headingAndSpacers(writes: string[], spacerCount: number): { heading: string; spacers: string[] } {
	const paint = writes.find(write => write.includes(OSC66));
	expect(paint).toBeDefined();
	const rows = paint!.split("\r\n");
	const idx = rows.findIndex(row => row.includes(OSC66));
	expect(idx).toBeGreaterThanOrEqual(0);
	return { heading: rows[idx]!, spacers: rows.slice(idx + 1, idx + 1 + spacerCount) };
}

describe("issue #8318: scaled OSC 66 headings survive repaint and resize", () => {
	it("re-emits the heading but never erases its reserved row on a full repaint", async () => {
		const term = new VirtualTerminal(80, 6);
		const tui = new TUI(term);
		tui.addChild(new RawLines([`${OSC66}s=2;Heading${ST}`, "", "Body"]));
		const writes = captureWrites(term);
		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			// Destructive full replay — the same gesture a redraw/session replace
			// uses, routed through the per-row erase path (#lineRewriteSequence).
			tui.requestRender(true, { clearScrollback: true });
			await settle(term);

			const { heading, spacers } = headingAndSpacers(writes, 1);
			// The glyph is re-emitted, not relied upon from a stale frame.
			expect(heading).toContain("Heading");
			// The reserved lower-half row carries no erase.
			expect(spacers[0]).toBe("");
			expect(spacers[0]).not.toContain(ERASE_TO_EOL);
			expect(spacers[0]).not.toContain(ERASE_LINE);
			// Content below the heading is still repainted.
			expect(writes.find(write => write.includes(OSC66))).toContain("Body");
		} finally {
			tui.stop();
		}
	});

	it("keeps the reserved row intact across a resize repaint", async () => {
		const term = new VirtualTerminal(80, 6);
		const tui = new TUI(term);
		tui.addChild(new RawLines([`${OSC66}s=2;Heading${ST}`, "", "Body"]));
		const writes = captureWrites(term);
		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			term.resize(70, 6);
			await settleResize(term);

			const { heading, spacers } = headingAndSpacers(writes, 1);
			expect(heading).toContain("Heading");
			expect(spacers[0]).toBe("");
			expect(spacers[0]).not.toContain(ERASE_TO_EOL);
			expect(spacers[0]).not.toContain(ERASE_LINE);
		} finally {
			tui.stop();
		}
	});

	it("protects every reserved row of a scale-3 heading (the /debug probe case)", async () => {
		const term = new VirtualTerminal(80, 6);
		const tui = new TUI(term);
		tui.addChild(new RawLines([`${OSC66}s=3;Big${ST}`, "", "", "Body"]));
		const writes = captureWrites(term);
		try {
			tui.start();
			await settle(term);
			writes.length = 0;

			tui.requestRender(true, { clearScrollback: true });
			await settle(term);

			const { heading, spacers } = headingAndSpacers(writes, 2);
			expect(heading).toContain("Big");
			// Both rows the scale-3 glyph flows into must stay untouched.
			for (const spacer of spacers) {
				expect(spacer).toBe("");
				expect(spacer).not.toContain(ERASE_TO_EOL);
				expect(spacer).not.toContain(ERASE_LINE);
			}
		} finally {
			tui.stop();
		}
	});
});
