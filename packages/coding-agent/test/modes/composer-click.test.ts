import { beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "../../src/modes/composer";
import { TranscriptContainer } from "../../src/modes/components/transcript-container";
import { initTheme } from "../../src/modes/theme/theme";
import { Container, type Component } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { routeViewportClick, type ViewportClickSpan } from "../../src/modes/composer";

function span(start: number, end: number, ids: string[]): ViewportClickSpan {
	return { start, end, candidates: () => ids };
}

describe("routeViewportClick", () => {
	it("returns the hit span's candidates with the span-local row", () => {
		let local = -1;
		const spans: ViewportClickSpan[] = [
			{
				start: 0,
				end: 2,
				candidates: row => {
					local = row;
					return ["CardAgent"];
				},
			},
			{ start: 3, end: 5, candidates: () => ["HudAgent"] },
		];
		expect(routeViewportClick(spans, 1)).toEqual(["CardAgent"]);
		expect(local).toBe(1);
		expect(routeViewportClick(spans, 4)).toEqual(["HudAgent"]);
	});

	it("misses separators, out-of-range rows, and non-integer indexes", () => {
		const spans = [span(0, 2, ["A"]), span(3, 4, ["B"])];
		expect(routeViewportClick(spans, 2)).toEqual([]);
		expect(routeViewportClick(spans, -1)).toEqual([]);
		expect(routeViewportClick(spans, Number.NaN)).toEqual([]);
		expect(routeViewportClick(spans, 99)).toEqual([]);
	});

	it("lets the first overlapping span win", () => {
		const spans = [span(0, 5, ["A"]), span(2, 4, ["B"])];
		expect(routeViewportClick(spans, 3)).toEqual(["A"]);
	});
});

class ClickableBlock implements Component {
	constructor(
		private readonly rows: readonly string[],
		private readonly ids: readonly string[],
	) {}
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
	render(): readonly string[] {
		return this.rows;
	}
	getClickFocusAgentIds(): string[] {
		return [...this.ids];
	}
}

describe("composer hover band", () => {
	beforeAll(() => {
		initTheme();
	});

	it("bands only the hovered target's rows and clears byte-identically", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			transcript.addChild(new ClickableBlock(["card one", "card two"], ["AgentA"]));
			transcript.addChild(new ClickableBlock(["plain"], []));
			composer.setRuntimeChildren([transcript]);
			const plain = composer.renderFrame({ columns: 80, rows: 24 });
			expect(plain.viewport.join("\n")).not.toContain("\x1b[48");

			composer.setHoveredClickId("AgentA");
			const hovered = composer.renderFrame({ columns: 80, rows: 24 });
			const banded = hovered.viewport.filter(line => line.includes("\x1b[48"));
			expect(banded).toHaveLength(2);
			expect(Bun.stripANSI(banded.join("\n"))).toContain("card one");
			expect(Bun.stripANSI(banded.join("\n"))).toContain("card two");
			expect(hovered.viewport.filter(line => line.includes("plain") && line.includes("\x1b[48"))).toHaveLength(0);

			composer.setHoveredClickId("Nobody");
			expect(composer.renderFrame({ columns: 80, rows: 24 }).viewport).toEqual(plain.viewport);

			composer.setHoveredClickId(undefined);
			expect(composer.renderFrame({ columns: 80, rows: 24 }).viewport).toEqual(plain.viewport);
		} finally {
			composer.stop();
		}
	});
});

class RowTarget implements Component {
	constructor(
		private readonly rows: readonly string[],
		private readonly ids: readonly string[],
	) {}
	render(): readonly string[] {
		return this.rows;
	}
	getClickAgentAtRow(row: number): string | undefined {
		return this.ids[row];
	}
}

describe("composer click-span clipping", () => {
	beforeAll(() => {
		initTheme();
	});

	it("offsets hit-testing past clipped viewport rows", () => {
		const term = new VirtualTerminal(80, 24);
		const composer = new Composer({ terminal: term, preferences: { ...COMPOSER_DEFAULTS, quiet: true } });
		composer.start();
		try {
			const transcript = new TranscriptContainer();
			const chrome = new Container();
			const ids = Array.from({ length: 10 }, (_, index) => `row${index}`);
			chrome.addChild(
				new RowTarget(
					ids.map(id => `line ${id}`),
					ids,
				),
			);
			composer.setRuntimeChildren([transcript, chrome]);

			// Ten chrome rows in a six-row viewport: the first four scroll off,
			// so viewport row 0 must hit-test as component row 4.
			const frame = composer.renderFrame({ columns: 80, rows: 6 });
			expect(frame.viewport).toHaveLength(6);
			expect(composer.viewportClickCandidates(0)).toEqual(["row4"]);
			expect(composer.viewportClickCandidates(5)).toEqual(["row9"]);
		} finally {
			composer.stop();
		}
	});
});
