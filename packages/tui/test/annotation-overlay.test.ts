import { beforeAll, beforeEach, describe, expect, afterEach, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { getKeybindings, setKeybindings, type TUI } from "@oh-my-pi/pi-tui";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { AnnotationOverlay, type AnnotationOverlayCallbacks } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import type {
	CodeReviewOverlayResult,
	ReviewDiffFile,
	TextReviewOverlayResult,
	TextReviewSource,
} from "@oh-my-pi/pi-tui/overlays/annotation-types";

const ENTER = "\r";
const TAB = "\t";
const DOWN = "\x1b[B";
const CANCEL = "\x1b";
const SHIFT_ENTER = "\x1b[13;2~";
const CTRL_U = "\x15";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const CTRL_E = "\x05";
let darkTheme: Theme | undefined;
let previousKeybindings: KeybindingsManager;

function render(overlay: AnnotationOverlay, width = 90): string {
	return overlay.render(width).map(stripVTControlCharacters).join("\n");
}

type DiffOverlayOptions = Omit<AnnotationOverlayCallbacks, "onComplete"> & {
	onComplete?: (result: CodeReviewOverlayResult | undefined) => void;
};

function makeDiffOverlay(files: readonly ReviewDiffFile[], options: DiffOverlayOptions = {}): AnnotationOverlay {
	const { onComplete = () => {}, ...callbacks } = options;
	const overlay = new AnnotationOverlay(
		makeTui(),
		darkTheme!,
		getKeybindings() as KeybindingsManager,
		files,
		"Reviewing changes",
		{ ...callbacks, onComplete },
	);
	overlay.focused = true;
	return overlay;
}

function makeTextOverlay(
	source: TextReviewSource,
	onComplete: (result: TextReviewOverlayResult | undefined) => void = () => {},
): AnnotationOverlay {
	const overlay = new AnnotationOverlay(makeTui(), darkTheme!, getKeybindings() as KeybindingsManager, source, {
		onComplete,
	});
	overlay.focused = true;
	return overlay;
}

function makeTui(): TUI {
	return {
		requestRender() {},
		stop() {},
		start() {},
	} as unknown as TUI;
}

function diffFile(path: string, hunkHeader: string, rows: ReviewDiffFile["rows"]): ReviewDiffFile {
	return {
		path,
		oldPath: path,
		newPath: path,
		occurrence: 1,
		rawDiff: [`diff --git a/${path} b/${path}`, hunkHeader, ...rows.map(row => row.raw)].join("\n"),
		rows: [{ kind: "hunk", raw: hunkHeader, hunkHeader }, ...rows],
		linesAdded: rows.filter(row => row.kind === "added").length,
		linesRemoved: rows.filter(row => row.kind === "removed").length,
		isBinary: false,
	};
}

const ONE_LINE_HUNK = "@@ -1 +1 @@";
const oneLineFiles = [
	diffFile("src/value.ts", ONE_LINE_HUNK, [
		{ kind: "removed", raw: "-old", content: "old", oldLine: 1, hunkHeader: ONE_LINE_HUNK },
		{ kind: "added", raw: "+new", content: "new", newLine: 1, hunkHeader: ONE_LINE_HUNK },
	]),
];

describe("AnnotationOverlay", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
	});
	beforeEach(() => {
		if (!darkTheme) throw new Error("dark theme unavailable");
		setThemeInstance(darkTheme);
		previousKeybindings = getKeybindings() as KeybindingsManager;
		setKeybindings(
			KeybindingsManager.inMemory({
				"tui.select.cancel": "escape",
				"app.editor.external": "ctrl+e",
			}),
		);
	});

	afterEach(() => {
		setKeybindings(previousKeybindings);
	});

	it("anchors a line note to the frozen source row and deletes it on an empty edit", () => {
		const hunkHeader = "@@ -12,2 +12,2 @@";
		const files = [
			diffFile("src/long.ts", hunkHeader, [
				{ kind: "context", raw: " context", content: "context", oldLine: 12, newLine: 12, hunkHeader },
				{ kind: "removed", raw: "-removed", content: "removed", oldLine: 13, hunkHeader },
				{ kind: "added", raw: "+added", content: "added", newLine: 13, hunkHeader },
			]),
		];
		const overlay = makeDiffOverlay(files);

		render(overlay);
		overlay.handleInput(TAB);
		overlay.handleInput(DOWN);
		overlay.handleInput("a");
		overlay.handleInput("keep this exact row");
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations()).toEqual([
			expect.objectContaining({
				scope: "line",
				path: "src/long.ts",
				oldLine: 13,
				rawLine: "-removed",
				note: "keep this exact row",
			}),
		]);
		const annotation = overlay.getAnnotations()[0];
		expect(annotation?.scope).toBe("line");
		if (annotation?.scope === "line") expect(annotation.newLine).toBeUndefined();

		overlay.handleInput("e");
		overlay.handleInput("\x15");
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations()).toEqual([]);
	});

	it("preserves a saved note when editing is cancelled", () => {
		const overlay = makeDiffOverlay(oneLineFiles);
		render(overlay);
		overlay.handleInput(TAB);
		overlay.handleInput("a");
		overlay.handleInput("saved");
		overlay.handleInput(ENTER);
		overlay.handleInput("e");
		overlay.handleInput("\x15");
		overlay.handleInput("discarded");
		overlay.handleInput(CANCEL);
		expect(overlay.getAnnotations().map(annotation => annotation.note)).toEqual(["saved"]);
	});

	it("undoes the latest change instead of dropping the newest note", () => {
		const overlay = makeDiffOverlay(oneLineFiles);
		render(overlay);
		overlay.handleInput(TAB);
		overlay.handleInput("a");
		overlay.handleInput("first");
		overlay.handleInput(ENTER);
		overlay.handleInput(DOWN);
		overlay.handleInput("a");
		overlay.handleInput("second");
		overlay.handleInput(ENTER);
		overlay.handleInput("\x1b[A");
		overlay.handleInput("e");
		overlay.handleInput(CTRL_U);
		overlay.handleInput("edited");
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations().map(annotation => annotation.note)).toEqual(["edited", "second"]);

		overlay.handleInput("u");
		expect(overlay.getAnnotations().map(annotation => annotation.note)).toEqual(["first", "second"]);

		overlay.handleInput("e");
		overlay.handleInput(CTRL_U);
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations().map(annotation => annotation.note)).toEqual(["second"]);
		overlay.handleInput("u");
		expect(overlay.getAnnotations().map(annotation => annotation.note)).toEqual(["first", "second"]);
	});

	it("preserves exact text quotes while annotating a selected line", () => {
		const source: TextReviewSource = {
			id: "reply",
			kind: "message",
			label: "Latest assistant reply",
			text: "first\r\n  exact source line  ",
		};
		const completed: Array<TextReviewOverlayResult | undefined> = [];
		const overlay = makeTextOverlay(source, result => completed.push(result));
		render(overlay);
		overlay.handleInput(DOWN);
		overlay.handleInput("a");
		overlay.handleInput("note");
		overlay.handleInput(ENTER);
		expect(overlay.getTextAnnotations()).toEqual([
			{ scope: "line", line: 2, quote: "  exact source line  ", note: "note" },
		]);
		overlay.handleInput(TAB);
		overlay.handleInput(ENTER);
		expect(completed).toEqual([{ action: "paste", annotations: overlay.getTextAnnotations() }]);
	});

	it("chooses duplicate line notes and deletes only the selected note", () => {
		const overlay = makeDiffOverlay(oneLineFiles);
		render(overlay);
		overlay.handleInput(TAB);
		overlay.handleInput("a");
		overlay.handleInput("first");
		overlay.handleInput(ENTER);
		overlay.handleInput("a");
		overlay.handleInput("second");
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations().map(annotation => annotation.note)).toEqual(["first", "second"]);

		overlay.handleInput("e");
		expect(render(overlay)).toContain("Edit annotation");
		overlay.handleInput(DOWN);
		overlay.handleInput(ENTER);
		overlay.handleInput(CTRL_U);
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations().map(annotation => annotation.note)).toEqual(["first"]);
	});
	it("keeps the selected annotation visible in a short chooser window", () => {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 12 });
		try {
			const overlay = makeDiffOverlay(oneLineFiles);
			render(overlay);
			overlay.handleInput(TAB);
			overlay.handleInput("a");
			overlay.handleInput("first");
			overlay.handleInput(ENTER);
			overlay.handleInput("a");
			overlay.handleInput("second");
			overlay.handleInput(ENTER);

			overlay.handleInput("e");
			const firstWindow = render(overlay).split("\n");
			expect(firstWindow.length).toBeLessThanOrEqual(12);
			expect(firstWindow.join("\n")).toContain("first");
			overlay.handleInput(DOWN);
			const secondWindow = render(overlay).split("\n");
			expect(secondWindow.length).toBeLessThanOrEqual(12);
			expect(secondWindow.join("\n")).toContain("second");
		} finally {
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	});

	it("supports multiline notes and treats a blank new draft as a no-op", () => {
		const overlay = makeDiffOverlay(oneLineFiles);
		render(overlay);
		overlay.handleInput(TAB);
		overlay.handleInput("a");
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations()).toEqual([]);

		overlay.handleInput("a");
		overlay.handleInput("first");
		overlay.handleInput(SHIFT_ENTER);
		overlay.handleInput("second");
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations()).toEqual([expect.objectContaining({ note: "first\nsecond" })]);
	});

	it("deletes an existing text note on blank submit and preserves it on Escape", () => {
		const source: TextReviewSource = {
			id: "reply",
			kind: "message",
			label: "Reply",
			text: "first line\nsecond line",
		};
		const overlay = makeTextOverlay(source);
		render(overlay);
		overlay.handleInput("A");
		overlay.handleInput("whole note");
		overlay.handleInput(ENTER);
		overlay.handleInput("e");
		overlay.handleInput(CTRL_U);
		overlay.handleInput("discarded");
		overlay.handleInput(CANCEL);
		expect(overlay.getTextAnnotations()).toEqual([{ scope: "text", note: "whole note" }]);

		overlay.handleInput("e");
		overlay.handleInput(CTRL_U);
		overlay.handleInput(ENTER);
		expect(overlay.getTextAnnotations()).toEqual([]);
	});

	it("commits external-editor drafts", async () => {
		const observedDrafts: string[] = [];
		const overlay = new AnnotationOverlay(
			makeTui(),
			darkTheme!,
			getKeybindings() as KeybindingsManager,
			oneLineFiles,
			"PR #1",
			{
				onAnnotationExternalEditor: (draft, commit) => {
					observedDrafts.push(draft);
					commit("external\neditor");
				},
				onComplete: () => {},
			},
		);
		overlay.focused = true;
		render(overlay);
		overlay.handleInput(TAB);
		overlay.handleInput("a");
		overlay.handleInput("draft");
		overlay.handleInput(CTRL_E);
		await Bun.sleep(0);
		expect(observedDrafts).toEqual(["draft"]);
		expect(render(overlay)).toContain("external");
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations()).toEqual([expect.objectContaining({ note: "external\neditor" })]);
	});

	it("returns undefined on cancel without a review result", () => {
		const completed: Array<CodeReviewOverlayResult | undefined> = [];
		const overlay = makeDiffOverlay(oneLineFiles, {
			onComplete: result => completed.push(result),
		});
		overlay.handleInput(CANCEL);
		expect(completed).toEqual([undefined]);
	});
	describe("diff row wrapping", () => {
		it("preserves long diff contents and aligns wrapped continuations under the code", () => {
			const content =
				"const payload = alphaOne betaTwo gammaThree deltaFour epsilonFive zetaSix etaSeven thetaEight iotaNine kappaTen lambdaEleven;";
			const overlay = makeDiffOverlay([
				diffFile("src/wrapped.ts", ONE_LINE_HUNK, [
					{ kind: "added", raw: `+${content}`, content, newLine: 17, hunkHeader: ONE_LINE_HUNK },
				]),
			]);
			const output = render(overlay, 42);

			for (const token of [
				"const",
				"payload",
				"alphaOne",
				"betaTwo",
				"gammaThree",
				"deltaFour",
				"epsilonFive",
				"zetaSix",
				"etaSeven",
				"thetaEight",
				"iotaNine",
				"kappaTen",
				"lambdaEleven;",
			]) {
				expect(output).toContain(token);
			}
			expect((output.match(/\+  17 /g) ?? []).length).toBe(1);
			const rows = output.split("\n");
			const first = rows.find(line => line.includes("const payload"));
			const continuation = rows.find(line => line.includes("betaTwo"));
			expect(first).toBeDefined();
			expect(continuation).toBeDefined();
			expect(continuation!.indexOf("betaTwo")).toBe(first!.indexOf("const payload"));
		});

		it("reflows cached diff contents when the overlay width changes", () => {
			const content = "resizeAlpha resizeBravo resizeCharlie resizeDelta resizeEcho resizeFoxtrot";
			const overlay = makeDiffOverlay([
				diffFile("src/resize.ts", ONE_LINE_HUNK, [
					{ kind: "added", raw: `+${content}`, content, newLine: 23, hunkHeader: ONE_LINE_HUNK },
				]),
			]);
			const narrow = render(overlay, 42);
			const wide = render(overlay, 140);
			const narrowRowCount = narrow
				.split("\n")
				.filter(line => /resize(?:Alpha|Bravo|Charlie|Delta|Echo|Foxtrot)/.test(line)).length;
			const wideRowCount = wide
				.split("\n")
				.filter(line => /resize(?:Alpha|Bravo|Charlie|Delta|Echo|Foxtrot)/.test(line)).length;

			expect(narrowRowCount).toBeGreaterThan(wideRowCount);
			for (const token of [
				"resizeAlpha",
				"resizeBravo",
				"resizeCharlie",
				"resizeDelta",
				"resizeEcho",
				"resizeFoxtrot",
			]) {
				expect(narrow).toContain(token);
				expect(wide).toContain(token);
			}
		});

		it("anchors a note to its logical source row after a wrapped row and resize", () => {
			const firstContent =
				"const first = FIRST_WRAP_HEAD alpha beta gamma delta epsilon zeta eta theta FIRST_WRAP_TAIL;";
			const targetContent = "const target = TARGET_LOGICAL_ROW;";
			const overlay = makeDiffOverlay([
				diffFile("src/anchor.ts", ONE_LINE_HUNK, [
					{
						kind: "added",
						raw: `+${firstContent}`,
						content: firstContent,
						newLine: 10,
						hunkHeader: ONE_LINE_HUNK,
					},
					{
						kind: "added",
						raw: `+${targetContent}`,
						content: targetContent,
						newLine: 11,
						hunkHeader: ONE_LINE_HUNK,
					},
				]),
			]);
			render(overlay, 42);
			overlay.handleInput(DOWN);
			render(overlay, 140);
			overlay.handleInput("a");
			overlay.handleInput("logical-row-note");
			overlay.handleInput(ENTER);

			expect(overlay.getAnnotations()).toEqual([expect.objectContaining({ newLine: 11, note: "logical-row-note" })]);
			const output = render(overlay, 42);
			expect(output.indexOf("FIRST_WRAP_TAIL")).toBeGreaterThanOrEqual(0);
			expect(output.indexOf("FIRST_WRAP_TAIL")).toBeLessThan(output.indexOf("logical-row-note"));
			expect(output.indexOf("logical-row-note")).toBeLessThan(output.indexOf("TARGET_LOGICAL_ROW"));
		});

		it("pages through one oversized wrapped source row and keeps its raw annotation anchor", () => {
			const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: 14 });
			try {
				const rawLine = `+START_MARKER ${"segment ".repeat(100)}TAIL_MARKER`;
				const overlay = makeDiffOverlay([
					diffFile("src/long.ts", ONE_LINE_HUNK, [
						{ kind: "added", raw: rawLine, content: rawLine.slice(1), newLine: 27, hunkHeader: ONE_LINE_HUNK },
					]),
				]);
				render(overlay, 72);
				overlay.handleInput(TAB);
				expect(render(overlay, 72)).toContain("START_MARKER");
				expect(render(overlay, 72)).not.toContain("TAIL_MARKER");

				for (let page = 0; page < 8; page++) overlay.handleInput(PAGE_DOWN);
				expect(render(overlay, 72)).toContain("TAIL_MARKER");
				overlay.handleInput("g");
				expect(render(overlay, 72)).toContain("START_MARKER");
				for (let page = 0; page < 8; page++) overlay.handleInput(PAGE_DOWN);
				expect(render(overlay, 72)).toContain("TAIL_MARKER");
				for (let page = 0; page < 8; page++) overlay.handleInput(PAGE_UP);
				expect(render(overlay, 72)).toContain("START_MARKER");
				overlay.handleInput("G");
				expect(render(overlay, 72)).toContain("TAIL_MARKER");

				overlay.handleInput("a");
				overlay.handleInput("note");
				overlay.handleInput(ENTER);
				expect(overlay.getAnnotations()).toEqual([
					expect.objectContaining({
						scope: "line",
						path: "src/long.ts",
						newLine: 27,
						rawLine,
						note: "note",
					}),
				]);
			} finally {
				if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
				else Reflect.deleteProperty(process.stdout, "rows");
			}
		});

		it("keeps the end-selected diff row anchored while the annotation editor shrinks the viewport", () => {
			const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: 14 });
			try {
				const firstContent = `FIRST_WRAP_HEAD ${"segment ".repeat(100)}`;
				const lastRaw = "+FINAL_LOGICAL_ROW";
				const overlay = makeDiffOverlay([
					diffFile("src/last.ts", ONE_LINE_HUNK, [
						{
							kind: "added",
							raw: `+${firstContent}`,
							content: firstContent,
							newLine: 1,
							hunkHeader: ONE_LINE_HUNK,
						},
						{
							kind: "added",
							raw: lastRaw,
							content: "FINAL_LOGICAL_ROW",
							newLine: 2,
							hunkHeader: ONE_LINE_HUNK,
						},
					]),
				]);
				render(overlay, 72);
				overlay.handleInput(TAB);
				overlay.handleInput("G");
				expect(render(overlay, 72)).toContain("FINAL_LOGICAL_ROW");
				overlay.handleInput("a");
				render(overlay, 72);
				overlay.handleInput("anchor-check");
				overlay.handleInput(ENTER);
				expect(overlay.getAnnotations()).toEqual([
					expect.objectContaining({
						scope: "line",
						path: "src/last.ts",
						newLine: 2,
						rawLine: lastRaw,
						note: "anchor-check",
					}),
				]);
			} finally {
				if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
				else Reflect.deleteProperty(process.stdout, "rows");
			}
		});

		it("keeps the highlighted source row and annotation anchor aligned after viewport reflow", () => {
			const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: 14 });
			try {
				const firstContent = `FIRST_ROW_MARKER ${"wrap ".repeat(16)}`;
				const firstRaw = `+${firstContent}`;
				const lastRaw = "+LAST_ROW_MARKER";
				const overlay = makeDiffOverlay([
					diffFile("src/reflow.ts", ONE_LINE_HUNK, [
						{
							kind: "added",
							raw: firstRaw,
							content: firstContent,
							newLine: 1,
							hunkHeader: ONE_LINE_HUNK,
						},
						{
							kind: "added",
							raw: lastRaw,
							content: "LAST_ROW_MARKER",
							newLine: 2,
							hunkHeader: ONE_LINE_HUNK,
						},
					]),
				]);
				render(overlay, 42);
				overlay.handleInput("G");
				render(overlay, 42);

				const wide = render(overlay, 180);
				const selectedRow = wide
					.split("\n")
					.find(
						line =>
							line.includes(darkTheme!.nav.cursor) &&
							(line.includes("FIRST_ROW_MARKER") || line.includes("LAST_ROW_MARKER")),
					);
				expect(selectedRow).toBeDefined();
				const expectedRaw = selectedRow!.includes("FIRST_ROW_MARKER") ? firstRaw : lastRaw;
				overlay.handleInput("a");
				overlay.handleInput("resize-anchor");
				overlay.handleInput(ENTER);
				expect(overlay.getAnnotations()).toEqual([
					expect.objectContaining({ rawLine: expectedRaw, note: "resize-anchor" }),
				]);
			} finally {
				if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
				else Reflect.deleteProperty(process.stdout, "rows");
			}
		});
	});
});
