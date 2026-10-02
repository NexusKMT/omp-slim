import { describe, expect, it, vi } from "bun:test";
import { clearRenderCache, Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { getMarkdownTheme, getMarkdownThemeWithLinkTargets, theme } from "@oh-my-pi/pi-tui/theme";
import { TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { Lexer } from "@oh-my-pi/pi-utils/marked";
import { defaultMarkdownTheme } from "./test-themes.js";

// E2 contract: the streaming incremental lexer (lex(prefix) ++ lex(tail), reusing
// frozen blank-line-bounded blocks) must produce BYTE-IDENTICAL output to a fresh
// full lex of the same text at every growth step. A faster-but-divergent render is
// a regression, so this is the gate that keeps E2 honest.
//
// Masking hazard: Markdown's module-level L2 render cache keys on (text, width),
// so a streaming render that produced WRONG lines would cache them and the "fresh"
// oracle would read the same wrong lines back. We `clearRenderCache()` around the
// oracle so it always cold-lexes, and again so the next streaming render cannot
// hit a stale entry — the streaming instance must go through its own incremental
// `#lexTokens` path every step.

const THEME = defaultMarkdownTheme;

function renderCold(text: string, width: number): readonly string[] {
	clearRenderCache();
	const out = new Markdown(text, 0, 0, THEME).render(width);
	clearRenderCache();
	return out;
}
/** Cold render in transient mode — same masking-safe pattern as renderCold. */
function renderColdTransient(text: string, width: number, markdownTheme = THEME): readonly string[] {
	clearRenderCache();
	const out = new Markdown(text, 0, 0, markdownTheme);
	out.transientRenderCache = true;
	const lines = out.render(width);
	clearRenderCache();
	return lines;
}

/** Reveal `full` in `step`-char increments through ONE reused (streaming) instance
 *  and assert each step matches a cold full-lex render of the same prefix. */
function assertIdenticalGrowth(full: string, width = 60, step = 13): void {
	const streaming = new Markdown("", 0, 0, THEME);
	for (let len = 1; len <= full.length; len += step) {
		const slice = full.slice(0, len);
		clearRenderCache();
		streaming.setText(slice);
		const streamLines = streaming.render(width);
		const oracle = renderCold(slice, width);
		expect(streamLines).toEqual(oracle);
	}
	clearRenderCache();
	streaming.setText(full);
	const streamLines = streaming.render(width);
	expect(streamLines).toEqual(renderCold(full, width));
}

/** Same as {@link assertIdenticalGrowth} but with a TRANSIENT streaming instance,
 *  which activates Markdown's render-prefix cache (the transient path caches
 *  content lines for the stable lex-prefix tokens and re-renders only the tail).
 *  The split render must still be byte-identical to a cold full render at every
 *  step — a faster-but-divergent split is a regression. */
function assertIdenticalGrowthTransient(full: string, width = 60, step = 13, markdownTheme = THEME): void {
	const streaming = new Markdown("", 0, 0, markdownTheme);
	streaming.transientRenderCache = true;
	for (let len = 1; len <= full.length; len += step) {
		const slice = full.slice(0, len);
		clearRenderCache();
		streaming.setText(slice);
		const streamLines = streaming.render(width);
		const oracle = renderColdTransient(slice, width, markdownTheme);
		expect(streamLines).toEqual(oracle);
	}
	clearRenderCache();
	streaming.setText(full);
	const streamLines = streaming.render(width);
	expect(streamLines).toEqual(renderColdTransient(full, width, markdownTheme));
}

const PROSE =
	"Para one with **bold** and _italic_ words and a `code span` for flavor.\n\n" +
	"Para two continues the document with more sentences so the lexer has real\n" +
	"block structure to chew on, then a third paragraph grows at the tail end as\n\n" +
	"the stream appends additional content token by token over many frames here.";

const FENCED =
	"Intro paragraph before the code block begins streaming in slowly.\n\n" +
	"```ts\nconst x: number = compute(a, b) + delta;\nfor (let i = 0; i < x; i++) {\n  emit(i);\n}\nreturn x.toFixed(2);\n```\n\n" +
	"Trailing prose after the fence keeps growing with more and more sentences.";

const LIST =
	"Lead-in sentence before the list.\n\n" +
	"- first bullet item with `inline`\n- second bullet item in **bold**\n- third bullet item\n\n" +
	"1. ordered one\n2. ordered two\n3. ordered three\n\n" +
	"Closing paragraph that keeps streaming additional words to the very end here.";

const HEADINGS =
	"# Title heading\n\nIntro text under the title with some detail.\n\n" +
	"## Section two\n\nBody of section two grows over time.\n\n" +
	"### Subsection\n\nDeeper content that streams in at the tail as the reveal advances.";

const MIXED = (() => {
	const para =
		"The quick brown fox jumps over the lazy dog while a `code span` and **bold** _italic_ exercise things. ";
	const cb = "\n```ts\nconst x = compute(a, b);\nreturn x;\n```\n\n";
	const list = "\n- one\n- two `inline`\n- three\n\n";
	let out = "";
	for (let i = 1; i <= 6; i++) out += `## Section ${i}\n\n${para}${para}${cb}${list}`;
	return out;
})();

const TABLE = (() => {
	// Table rows stream in as the tail grows: a growing table in the unfrozen
	// tail must render byte-identically (the tail row cache excludes `table`
	// tokens, so these frames exercise the exclusion path under
	// assertIdenticalGrowthTransient).
	const para = "Intro paragraph before the table streams in, with a `code span` and **bold** for flavor. ";
	let out = `${para}\n\n| col_a | col_b |\n| ----- | ----- |\n`;
	for (let i = 1; i <= 4; i++) out += `| row_${i}_a | row_${i}_b |\n`;
	out += "\n\nTrailing prose after the table keeps growing with more sentences.";
	return out;
})();

describe("Markdown incremental streaming lex (E2)", () => {
	it("tight list streaming tokenizes a bounded mutable suffix instead of every completed item", () => {
		const document = Array.from(
			{ length: 256 },
			(_, index) => `- Item ${index} has **emphasis**, a \`code span\`, and enough text to wrap across rows.`,
		).join("\n");
		let lexedCharacters = 0;
		const blockTokens = Lexer.prototype.blockTokens;
		const spy = vi.spyOn(Lexer.prototype, "blockTokens").mockImplementation(function (this: Lexer, source, tokens) {
			lexedCharacters += source.length;
			return blockTokens.call(this, source, tokens);
		});
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		let rendered: readonly string[] = [];
		try {
			for (let length = 256; length < document.length; length += 256) {
				streaming.setText(document.slice(0, length));
				rendered = streaming.render(60);
			}
			streaming.setText(document);
			rendered = streaming.render(60);
		} finally {
			spy.mockRestore();
		}
		expect(rendered).toEqual(renderColdTransient(document, 60));
		expect(lexedCharacters).toBeLessThan(document.length * 12);
	});

	it("prose growth is byte-identical to full lex", () => {
		assertIdenticalGrowth(PROSE);
	});

	it("fenced code growth (open then close) is byte-identical", () => {
		assertIdenticalGrowth(FENCED);
	});

	it("list growth is byte-identical", () => {
		assertIdenticalGrowth(LIST);
	});

	it("heading growth is byte-identical", () => {
		assertIdenticalGrowth(HEADINGS);
	});

	it("mixed multi-section corpus growth is byte-identical", () => {
		assertIdenticalGrowth(MIXED, 80, 29);
	});

	it("transient render-prefix cache: prose split render is byte-identical", () => {
		assertIdenticalGrowthTransient(PROSE);
	});

	it("transient render-prefix cache: fenced code split render is byte-identical", () => {
		assertIdenticalGrowthTransient(FENCED);
	});

	it("transient render-prefix cache: mixed multi-section split render is byte-identical", () => {
		assertIdenticalGrowthTransient(MIXED, 80, 29);
	});

	it("transient growing lists retain byte-identical rows across item and list-shape changes", () => {
		const bullets = Array.from(
			{ length: 18 },
			(_, index) => `- item ${index} has **styled text** and a long sentence that wraps onto another row`,
		).join("\n");
		const lists =
			`${bullets}\n  - nested child with _emphasis_\n\n` +
			"1. [ ] ordered task with a long description\n\n" +
			"2. [x] next task with a `code span`\n\n" +
			"A paragraph closes the growing list.";
		assertIdenticalGrowthTransient(lists, 46, 11);
	});

	it("transient list cache falls back when a reference definition changes earlier links", () => {
		const list =
			"- Follow [the guide][guide] when the first item is rendered.\n" +
			"- Another item wraps at this width and keeps the list growing.\n\n" +
			"[guide]: https://example.com/guide\n\nClosing text.";
		assertIdenticalGrowthTransient(list, 42, 7);
	});

	it("incremental list items preserve nested indentation and continuation paragraphs", () => {
		const list =
			"- first\n  - nested\n    - deep child\n  continuation\n" +
			"- second\n\n  paragraph after the blank\n- third\n" +
			"  - last nested child\n- fourth";
		assertIdenticalGrowthTransient(list, 34, 1);
	});

	it("incremental list items preserve ordered starts, marker changes, and incomplete markers", () => {
		const list =
			"8. eighth\n9. ninth\n10. tenth wraps onto the next row at this width\n\n" +
			"11. eleventh\n12) a different delimiter\n13) last\n\n" +
			"- bullet\n* different bullet\n+ final bullet";
		assertIdenticalGrowthTransient(list, 24, 1);
	});

	it("incremental list items preserve fenced and indented code and task checkboxes", () => {
		const list =
			"- [ ] first task\n- [x] second task\n  ```ts\n  const x = 1;\n  ```\n" +
			"- third\n\n      indented code\n- fourth";
		assertIdenticalGrowthTransient(list, 30, 1);
	});

	it("a nested reference definition refreshes links in earlier completed list items", () => {
		const list =
			"- Follow [the guide][guide] in the first item\n- second\n- third\n\n" +
			"    [guide]: https://example.com/guide\n- fourth";
		assertIdenticalGrowthTransient(list, 32, 1);
	});

	it("a late display-math closer can absorb the mutable block preceding a list", () => {
		assertIdenticalGrowthTransient("  $$\n1. one\n  $$", 60, 1);
	});

	it("a list checkpoint does not freeze preceding paragraph escapes or quote continuations", () => {
		assertIdenticalGrowthTransient("foo\\\n \n- *", 60, 1);
		assertIdenticalGrowthTransient("> quote\n      - six\n- $", 60, 1);
	});

	it("a late bare-math closer can absorb earlier list items after an equation prefix", () => {
		assertIdenticalGrowthTransient("- a=\n  \\begin{align}\n- b\n  \\end{align}", 60, 1);
	});

	for (const [container, definition] of [
		["bullet", "- [x]: https://example.com/late"],
		["ordered", "1. [x]: https://example.com/late"],
		["quote", "  > [x]: https://example.com/late"],
		["task", "- [ ] [x]: https://example.com/late"],
		["nested containers", "- > 1. [x]: https://example.com/late"],
	]) {
		it(`a late ${container} reference definition refreshes completed list links`, () => {
			const terminalState = TERMINAL as { hyperlinks: boolean };
			const originalHyperlinks = terminalState.hyperlinks;
			const document = `- [foo][x]\n- second\n${definition}`;
			try {
				terminalState.hyperlinks = true;
				for (const markdownTheme of [THEME, getMarkdownTheme()]) {
					assertIdenticalGrowthTransient(document, 80, 1, markdownTheme);
					const rows = renderColdTransient(document, 80, markdownTheme);
					expect(rows.join("\n")).toContain("\x1b]8;;https://example.com/late\x07");
				}
			} finally {
				terminalState.hyperlinks = originalHyperlinks;
			}
		});
	}

	it("completed list code gains full highlighting when its list joins the stable prefix", () => {
		const markdownTheme = getMarkdownTheme();
		assertIdenticalGrowthTransient("- a\n  ```ts\n  let x = true\n- b\n\n* c", 60, 1, markdownTheme);
		assertIdenticalGrowthTransient("- a\n\n      let x = true\n- b\n\n* c", 60, 1, markdownTheme);
	});

	it("a nested definition preserves a reference label containing a backslash", () => {
		const document = "- [foo][a\\b]\n- second\n- [a\\b]: https://example.com/escaped";
		assertIdenticalGrowthTransient(document, 80, 1);
		const terminalState = TERMINAL as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		try {
			terminalState.hyperlinks = true;
			expect(renderColdTransient(document, 80).join("\n")).toContain("\x1b]8;;https://example.com/escaped\x07");
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	it("transient list rows rewrap after a width change", () => {
		const list = Array.from({ length: 12 }, (_, index) => `- item ${index} wraps this long descriptive line`).join(
			"\n",
		);
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		streaming.setText(list.slice(0, -12));
		streaming.render(80);
		streaming.setText(list);
		clearRenderCache();
		expect(streaming.render(36)).toEqual(renderColdTransient(list, 36));
		clearRenderCache();
		expect(streaming.render(80)).toEqual(renderColdTransient(list, 80));
	});

	it("transient list rows update after an earlier item is edited", () => {
		const original = "- first **bold** item\n- second item\n- third item";
		const edited = "- first _italic_ item\n- second item\n- third item";
		const streaming = new Markdown(original, 0, 0, THEME);
		streaming.transientRenderCache = true;
		streaming.render(40);
		streaming.setText(edited);
		clearRenderCache();
		expect(streaming.render(40)).toEqual(renderColdTransient(edited, 40));
		streaming.setText(`${edited}\n- fourth item`);
		clearRenderCache();
		expect(streaming.render(40)).toEqual(renderColdTransient(`${edited}\n- fourth item`, 40));
	});

	it("transient list at the start reuses earlier item styling with the managed theme", () => {
		let styledBullets = 0;
		const markdownTheme = getMarkdownTheme();
		const originalFg = theme.fg.bind(theme);
		const spy = vi.spyOn(theme, "fg").mockImplementation((color, text) => {
			if (color === "mdListBullet") styledBullets++;
			return originalFg(color, text);
		});
		const first = Array.from({ length: 20 }, (_, index) => `- item ${index}`).join("\n");
		const next = `${first}\n- item 20`;
		try {
			const streaming = new Markdown(first, 0, 0, markdownTheme);
			streaming.transientRenderCache = true;
			streaming.render(60);
			styledBullets = 0;
			streaming.setText(next);
			const rendered = streaming.render(60);
			expect(styledBullets).toBeLessThan(6);
			clearRenderCache();
			const cold = new Markdown(next, 0, 0, markdownTheme);
			cold.transientRenderCache = true;
			expect(rendered).toEqual(cold.render(60));
		} finally {
			spy.mockRestore();
		}
	});

	it("transient ordered list restyles an earlier marker when a custom callback changes", () => {
		let markTen = false;
		const customTheme = {
			...THEME,
			listBullet: (bullet: string) => (markTen && bullet === "10. " ? `[${bullet}]` : bullet),
		};
		const first = Array.from({ length: 12 }, (_, index) => `${index + 1}. item ${index + 1}`).join("\n");
		const next = `${first}\n13. item 13`;
		const streaming = new Markdown(first, 0, 0, customTheme);
		streaming.transientRenderCache = true;
		streaming.render(60);
		markTen = true;
		streaming.setText(next);
		const rendered = streaming.render(60);
		clearRenderCache();
		const cold = new Markdown(next, 0, 0, customTheme);
		cold.transientRenderCache = true;
		expect(rendered).toEqual(cold.render(60));
		expect(rendered.some(line => line.includes("[10. ]item 10"))).toBe(true);
	});

	it("transient list restyles earlier bold text when a custom callback changes", () => {
		let decorate = false;
		const customTheme = { ...THEME, bold: (text: string) => (decorate ? `{${text}}` : text) };
		const first = "- **one**\n- **two**";
		const next = `${first}\n- three`;
		const streaming = new Markdown(first, 0, 0, customTheme);
		streaming.transientRenderCache = true;
		streaming.render(60);
		decorate = true;
		streaming.setText(next);
		const rendered = streaming.render(60);
		clearRenderCache();
		const cold = new Markdown(next, 0, 0, customTheme);
		cold.transientRenderCache = true;
		expect(rendered).toEqual(cold.render(60));
		expect(rendered.some(line => line.includes("{one}"))).toBe(true);
	});

	it("transient list restyles when a managed theme callback is replaced", () => {
		const markdownTheme = getMarkdownTheme();
		const originalBold = markdownTheme.bold;
		const first = "- **one**\n- **two**";
		const next = `${first}\n- three`;
		const streaming = new Markdown(first, 0, 0, markdownTheme);
		streaming.transientRenderCache = true;
		streaming.render(60);
		try {
			markdownTheme.bold = (text: string) => `{${text}}`;
			streaming.setText(next);
			const rendered = streaming.render(60);
			clearRenderCache();
			const cold = new Markdown(next, 0, 0, markdownTheme);
			cold.transientRenderCache = true;
			expect(rendered).toEqual(cold.render(60));
		} finally {
			markdownTheme.bold = originalBold;
		}
	});

	it("transient list updates earlier links when a managed theme gains a resolver", () => {
		const terminalState = TERMINAL as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		const markdownTheme = getMarkdownTheme();
		const originalResolveLink = markdownTheme.resolveLink;
		const first = "- [one](https://example.com)\n- two";
		const next = `${first}\n- three`;
		try {
			terminalState.hyperlinks = true;
			const streaming = new Markdown(first, 0, 0, markdownTheme);
			streaming.transientRenderCache = true;
			streaming.render(60);
			markdownTheme.resolveLink = () => "https://changed.example";
			streaming.setText(next);
			const rendered = streaming.render(60);
			clearRenderCache();
			const cold = new Markdown(next, 0, 0, markdownTheme);
			cold.transientRenderCache = true;
			expect(rendered).toEqual(cold.render(60));
			expect(rendered.join("\n")).toContain("https://changed.example");
		} finally {
			if (originalResolveLink === undefined) delete markdownTheme.resolveLink;
			else markdownTheme.resolveLink = originalResolveLink;
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	it("transient list reuses rows with a stable resolved-link theme", () => {
		const target = "https://example.com";
		const targets = new Map([[target, "https://resolved.example"]]);
		const markdownTheme = getMarkdownThemeWithLinkTargets(targets);
		const first = Array.from({ length: 20 }, (_, index) => `- [item ${index}](${target})`).join("\n");
		const next = `${first}\n- item 20`;
		let styledBullets = 0;
		const terminalState = TERMINAL as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		const originalFg = theme.fg.bind(theme);
		const spy = vi.spyOn(theme, "fg").mockImplementation((color, text) => {
			if (color === "mdListBullet") styledBullets++;
			return originalFg(color, text);
		});
		try {
			terminalState.hyperlinks = true;
			const streaming = new Markdown(first, 0, 0, markdownTheme);
			streaming.transientRenderCache = true;
			streaming.render(60);
			styledBullets = 0;
			targets.set(target, "https://changed.example");
			streaming.setText(next);
			const rendered = streaming.render(60);
			expect(styledBullets).toBeLessThan(6);
			expect(rendered.join("\n")).toContain("https://resolved.example");
			expect(rendered.join("\n")).not.toContain("https://changed.example");
			clearRenderCache();
			const cold = new Markdown(next, 0, 0, markdownTheme);
			cold.transientRenderCache = true;
			expect(rendered).toEqual(cold.render(60));
			const refreshed = getMarkdownThemeWithLinkTargets(targets);
			expect(new Markdown(next, 0, 0, refreshed).render(60).join("\n")).toContain("https://changed.example");
		} finally {
			spy.mockRestore();
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	it("transient list restyles when a caller text-style callback changes", () => {
		let prefix = "A";
		const markdownTheme = getMarkdownTheme();
		const textStyle = { color: (text: string) => prefix + text };
		const first = "- one\n- two";
		const next = `${first}\n- three`;
		const streaming = new Markdown(first, 0, 0, markdownTheme, textStyle);
		streaming.transientRenderCache = true;
		streaming.render(60);
		prefix = "B";
		streaming.setText(next);
		const rendered = streaming.render(60);
		clearRenderCache();
		const cold = new Markdown(next, 0, 0, markdownTheme, textStyle);
		cold.transientRenderCache = true;
		expect(rendered).toEqual(cold.render(60));
	});

	it("transient render-prefix cache: table growing in the tail is byte-identical", () => {
		assertIdenticalGrowthTransient(TABLE, 60, 7);
	});

	it("a width change mid-stream still matches a cold render at the new width", () => {
		const streaming = new Markdown("", 0, 0, THEME);
		// Warm the stream cache at width 80 across the whole message.
		for (let len = 1; len <= MIXED.length; len += 41) {
			clearRenderCache();
			streaming.setText(MIXED.slice(0, len));
			streaming.render(80);
		}
		// Now render the full text at a NARROWER width: frozen tokens are width-
		// independent, so output must match a cold full lex at the new width.
		clearRenderCache();
		streaming.setText(MIXED);
		const narrow = streaming.render(40);
		expect(narrow).toEqual(renderCold(MIXED, 40));
		// And back to a wider width.
		clearRenderCache();
		const wide = streaming.render(100);
		expect(wide).toEqual(renderCold(MIXED, 100));
	});

	it("reference-link definitions (fallback path) still render correctly while growing", () => {
		const refDoc =
			"See [the docs][d] and [the spec][s] for details on the protocol.\n\n" +
			"A middle paragraph with ordinary prose that keeps growing here.\n\n" +
			"[d]: https://example.com/docs\n[s]: https://example.com/spec\n\n" +
			"Closing paragraph streamed at the tail with extra sentences appended.";
		assertIdenticalGrowth(refDoc);
	});

	// Regression: HAS_REF_DEF must also catch labels with backslash-escaped
	// brackets (`[a\]b]: …`). marked resolves such a definition document-wide,
	// so if the detector misses it the already-frozen paragraph keeps its plain
	// text inline tokens while a cold lex rewrites `[a\]b]` into a link.
	it("an escaped-bracket reference definition falls back to a correct full render", () => {
		const escapedRef =
			"See [a\\]b] for details in the long discussion that follows below.\n\n" +
			"More prose streams in before the definition finally arrives down here.\n\n" +
			"[a\\]b]: https://example.com/escaped\n\n" +
			"Trailing paragraph after the definition keeps the stream going on.";
		assertIdenticalGrowth(escapedRef, 60, 1);
		assertIdenticalGrowth(escapedRef, 60, 13);
	});

	// Regression: marked merges a list with a following same-marker list across a
	// blank line into one renumbered loose list (CommonMark loose-list
	// continuation). Freezing across that "\n\n" cut keeps them separate and
	// renumbers/spaces wrong. These cases must hold at the production reveal
	// granularity (MIN_STEP=3) and at step=1 — the divergence is phase-sensitive.
	it("two consecutive ordered lists stay merged/renumbered while growing", () => {
		const twoLists = "1. a\n2. b\n\n1. c\n2. d";
		assertIdenticalGrowth(twoLists, 60, 1);
		assertIdenticalGrowth(twoLists, 60, 3);
	});

	it("a loose ordered list (blank lines between items) stays correct while growing", () => {
		const loose =
			"Intro line before the numbered list begins here.\n\n" +
			"1. First point with enough words to wrap nicely.\n\n" +
			"2. Second point also with sufficient words here.\n\n" +
			"3. Third and final point streamed at the tail end.";
		assertIdenticalGrowth(loose, 60, 1);
		assertIdenticalGrowth(loose, 60, 3);
	});

	it("a loose bullet list stays correct while growing", () => {
		const loose =
			"Lead-in before the bullets.\n\n" +
			"- alpha item with several words to wrap\n\n" +
			"- beta item with several words to wrap\n\n" +
			"- gamma item streamed at the tail end here.";
		assertIdenticalGrowth(loose, 60, 1);
		assertIdenticalGrowth(loose, 60, 3);
	});

	it("a non-append change (text replaced) falls back to a correct full render", () => {
		const streaming = new Markdown("", 0, 0, THEME);
		clearRenderCache();
		streaming.setText("# First document\n\nOriginal body paragraph one.\n\nOriginal body paragraph two.\n");
		streaming.render(60);
		// Replace with unrelated content that is NOT a prefix-extension.
		clearRenderCache();
		streaming.setText("## Different\n\nCompletely new content replacing the old buffer entirely.\n");
		const replaced = streaming.render(60);
		expect(replaced).toEqual(
			renderCold("## Different\n\nCompletely new content replacing the old buffer entirely.\n", 60),
		);
	});

	it("a transient non-append replacement with no block boundary is not served stale prefix lines", () => {
		// Regression: the render-prefix cache guards on #streamPrefixText, which
		// #freezeStablePrefix leaves untouched when the new text has no freezable
		// "\n\n" boundary. Without clearing it on the fallback path, a transient
		// replacement by single-line content emitted the OLD prefix's rendered lines.
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		clearRenderCache();
		streaming.setText("# First document\n\nOriginal body paragraph one.\n\nOriginal body paragraph two.\n");
		streaming.render(60);
		// Replace with unrelated single-line content — no "\n\n" boundary to freeze.
		clearRenderCache();
		streaming.setText("a flat replacement with no double newline at all");
		const replaced = streaming.render(60);
		expect(replaced).toEqual(renderCold("a flat replacement with no double newline at all", 60));
	});

	it("CRLF text (fallback path) renders identically to a cold lex", () => {
		const streaming = new Markdown("", 0, 0, THEME);
		const crlf = "Para one with content.\r\n\r\nPara two with `code`.\r\n\r\nPara three tail.\r\n";
		for (let len = 1; len <= crlf.length; len += 11) {
			clearRenderCache();
			streaming.setText(crlf.slice(0, len));
			const streamLines = streaming.render(60);
			expect(streamLines).toEqual(renderCold(crlf.slice(0, len), 60));
		}
	});

	// Closed-list lookahead: a "\n\n" boundary directly after a list token is
	// freezable iff the tail cannot start a continuation item of that list
	// (same bullet char, or 1-9 digits + same delimiter — marked's
	// listItemRegex). These corpora cross list/non-list and
	// list/incompatible-list boundaries; the divergence (and the freeze
	// opportunity) is phase-sensitive, so each runs at step=1 and the
	// production reveal granularity (step=3).
	it("bullet list followed by a paragraph grows byte-identically", () => {
		const doc =
			"- alpha item with words\n- beta item with words\n- gamma item\n\n" +
			"Closing paragraph that keeps streaming additional words to the end.";
		assertIdenticalGrowth(doc, 60, 1);
		assertIdenticalGrowth(doc, 60, 3);
		assertIdenticalGrowthTransient(doc, 60, 3);
	});

	it("bullet list followed by a different-marker list stays two lists", () => {
		const doc = "- alpha\n- beta\n\n* starred one\n* starred two\n\n+ plus one\n+ plus two";
		assertIdenticalGrowth(doc, 60, 1);
		assertIdenticalGrowth(doc, 60, 3);
	});

	it("ordered list followed by a paren-delimited list stays two lists", () => {
		const doc = "1. dot one\n2. dot two\n\n1) paren one\n2) paren two";
		assertIdenticalGrowth(doc, 60, 1);
		assertIdenticalGrowth(doc, 60, 3);
		assertIdenticalGrowthTransient(doc, 60, 3);
	});

	it("list followed by blockquote grows byte-identically", () => {
		const doc = "- alpha\n- beta\n\n> quoted line one with words\n> quoted line two here";
		assertIdenticalGrowth(doc, 60, 1);
		assertIdenticalGrowth(doc, 60, 3);
	});

	it("list followed by heading grows byte-identically", () => {
		const doc = "1. one\n2. two\n\n# Heading after the list\n\nTail prose keeps going on.";
		assertIdenticalGrowth(doc, 60, 1);
		assertIdenticalGrowth(doc, 60, 3);
	});

	it("list followed by fenced code grows byte-identically", () => {
		const doc = "- alpha\n- beta\n\n```ts\nconst x = compute(a, b);\nreturn x;\n```\n\ntail text";
		assertIdenticalGrowth(doc, 60, 1);
		assertIdenticalGrowth(doc, 60, 3);
	});

	it("a same-marker list across a blank line still merges while growing", () => {
		const bullets = "- a\n- b\n\n- c\n- d";
		assertIdenticalGrowth(bullets, 60, 1);
		assertIdenticalGrowth(bullets, 60, 3);
	});

	it("orphan-fence repair starting mid-stream keeps growth byte-identical", () => {
		// Final-mode repairOrphanClosingFence deletes an unmatched bare fence
		// once both a heading and a GFM table delimiter follow it. The raw text
		// grows append-only across the transition while the NORMALIZED text
		// (with the fence deleted) is no longer an append-extension of the
		// previous frame's, so the guard-scan memo's byte alignment is put to
		// the test: the trigger either brings "\n" into the delta (suspicious
		// path re-scans) or shortens the text (length gate re-derives). The
		// cold-render oracle must match at every step.
		const doc =
			"Intro paragraph before the stray fence lands in the stream.\n\n" +
			"```\n" +
			"# Heading after the orphan fence\n\n" +
			"| col a | col b |\n" +
			"| --- | --- |\n\n" +
			"Trailing paragraph that keeps streaming after the table ends.";
		assertIdenticalGrowth(doc, 60, 1);
		assertIdenticalGrowth(doc, 60, 3);
		assertIdenticalGrowth(doc, 60, 13);
	});

	it("a document that is one still-growing list never freezes mid-list", () => {
		// No (b)-style intra-list freezing shipped: loose/tight and ordered
		// renumbering are whole-list properties, so no prefix of an open list
		// is byte-stable. Settled rows must stay 0 for a pure-list document.
		const doc = "- one two three\n- four five six\n\n- seven eight nine";
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		for (let len = 1; len <= doc.length; len += 1) {
			clearRenderCache();
			streaming.setText(doc.slice(0, len));
			const streamLines = streaming.render(60);
			expect(streamLines).toEqual(renderCold(doc.slice(0, len), 60));
		}
	});

	it("flipping transientRenderCache re-derives the guard memo", () => {
		// Regression: final mode normalized this document through
		// repairOrphanClosingFence, which deleted the bare fence line carrying
		// the text's only "\r". Memoized in final mode the verdict is
		// canStream=true (no CR, no ref defs) with #lastScanLength taken from
		// the REPAIRED buffer. Flipping to transient mode re-introduces the
		// raw "\r" (transient skips repair); if the memo survived the flip, a
		// clean-suffix append would reuse canStream=true and stream the
		// CR-containing tail. The mode flip must invalidate the memo so the
		// next frame re-derives and falls back to the full lex.
		const crlfFence =
			"Intro paragraph before the stray fence with a CRLF line end.\n\n" +
			"```\r\n" +
			"# Heading after the fence\n\n" +
			"| a | b |\n" +
			"| --- | --- |\n\n" +
			"Tail prose that only streams in after the table.";
		const streaming = new Markdown("", 0, 0, THEME);
		clearRenderCache();
		streaming.setText(crlfFence);
		streaming.render(60); // final mode: repair deletes the fence + its CR
		// Switch to transient streaming on the same instance and append only
		// CLEAN suffixes (no newline/bracket/colon): a stale memo would be
		// reused on each of these and stream the CR-containing tail against
		// the repaired-buffer prefix, diverging from the cold render.
		streaming.transientRenderCache = true;
		let grown = crlfFence;
		for (const suffix of [" tail-a", " tail-b", " tail-c"]) {
			grown += suffix;
			clearRenderCache();
			streaming.setText(grown);
			const streamLines = streaming.render(60);
			expect(streamLines).toEqual(renderColdTransient(grown, 60));
		}
	});

	it("never mutates returned frames and stays byte-identical across finalize and resume", () => {
		// Streaming reuses private row/highlight caches across frames; a frame
		// already handed to a caller must never change afterwards. Finalizing
		// mid-fence (then resuming the stream) releases those caches and must
		// rebuild byte-identical output.
		const theme = {
			...THEME,
			highlightCode: (code: string): string[] => code.split("\n").map(line => `H<${line}>`),
			createHighlightStream: () => ({
				push: (chunk: string): string =>
					chunk
						.split("\n")
						.map((line, i, all) => (i === all.length - 1 ? line : `H<${line}>`))
						.join("\n"),
			}),
		};
		const renderColdWith = (text: string, transient: boolean): readonly string[] => {
			clearRenderCache();
			const md = new Markdown(text, 0, 0, theme);
			md.transientRenderCache = transient;
			const lines = md.render(60);
			clearRenderCache();
			return lines;
		};
		const code = Array.from({ length: 24 }, (_, i) => `const value_${i} = compute(${i});`).join("\n");
		const doc =
			"Intro paragraph that freezes first.\n\nSecond paragraph grows the frozen prefix.\n\n" +
			`\`\`\`ts\n${code}\n\`\`\`\n\nTail prose after the fence keeps streaming on.`;
		const finalizeAt = doc.indexOf("value_12");
		const streaming = new Markdown("", 0, 0, theme);
		streaming.transientRenderCache = true;
		const handed: Array<{ lines: readonly string[]; snapshot: string[] }> = [];
		let finalized = false;
		for (let len = 1; len <= doc.length; len += 5) {
			const slice = doc.slice(0, len);
			clearRenderCache();
			streaming.setText(slice);
			const lines = streaming.render(60);
			expect(lines).toEqual(renderColdWith(slice, true));
			handed.push({ lines, snapshot: [...lines] });
			if (!finalized && len >= finalizeAt) {
				finalized = true;
				streaming.transientRenderCache = false;
				clearRenderCache();
				expect(streaming.render(60)).toEqual(renderColdWith(slice, false));
				streaming.transientRenderCache = true;
			}
		}
		expect(finalized).toBe(true);
		for (const frame of handed) expect(frame.lines).toEqual(frame.snapshot);
	});
});

describe("Markdown OSC 8 tail normalization across streaming appends", () => {
	const ST = "\x1b\\";
	const LINK = "\x1b]8;;https://example.com";

	/** Append `chunks` one by one through a single streaming instance and
	 *  assert each step's render is byte-identical to a cold full-lex render. */
	function assertChunkedGrowth(chunks: string[], width = 60): void {
		const streaming = new Markdown("", 0, 0, THEME);
		let text = "";
		for (const chunk of chunks) {
			text += chunk;
			clearRenderCache();
			streaming.setText(text);
			expect(streaming.render(width)).toEqual(renderCold(text, width));
		}
	}

	it("normalizes an OSC 8 escape split across appends like a cold render", () => {
		// The escape prefix, its body, and the ST terminator arrive in separate
		// setText calls: the crossing match (started in the memoized pending
		// suffix, completed in the delta) must be rewritten (ST → BEL) exactly
		// like the full-document pass, and the following appends (now desynced
		// from the caller's raw text) must fall back to the cold path and stay
		// byte-identical.
		assertChunkedGrowth(["\x1b]8;;", "https://example.com", ST, "`example.ts`", `\x1b]8;;${ST}`]);
	});

	it("keeps a BEL-terminated escape and an invalid ESC tail byte-identical", () => {
		// A BEL closes the escape early (nothing to carry), and `\x1bX` is not a
		// completable ST — neither may hold stale pending-suffix state across
		// the following append.
		assertChunkedGrowth([`${LINK}\x07`, "more", "\x1b]8;;https://example.com\x1bX", "tail"]);
	});

	it("falls back to the full-document pass on a truncating edit and stays correct", () => {
		const full = `${LINK}${ST}link${"\x1b]8;;"}${ST}`;
		const streaming = new Markdown(full, 0, 0, THEME);
		// Non-append (shorter) edit: full pass re-normalizes and re-memoizes.
		const truncated = full.slice(0, 12);
		clearRenderCache();
		streaming.setText(truncated);
		expect(streaming.render(60)).toEqual(renderCold(truncated, 60));
		// Subsequent append re-enters the fast path against the NEW memo.
		clearRenderCache();
		streaming.setText(`${truncated}|${ST}`);
		expect(streaming.render(60)).toEqual(renderCold(`${truncated}|${ST}`, 60));
	});
});
