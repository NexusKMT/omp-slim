import { describe, expect, test } from "bun:test";
import { Lexer, Marked, type TokenizerAndRendererExtension, type TokenizerExtension } from "../src/marked";
import goldens from "./fixtures/marked/goldens.json";

describe("marked compatibility", () => {
	for (const golden of goldens) {
		test(`matches marked tokens and HTML for ${golden.name}`, () => {
			expect([...Lexer.lex(golden.source)]).toEqual(golden.tokens);
			expect(new Marked().parse(golden.source)).toBe(golden.html);
		});
	}

	// Token-shape parity with real marked (verified against marked v15) at the
	// list/blank-line boundary. The TUI streaming lexer freezes prefixes on
	// these shapes, so a list's raw must never absorb a trailing blank run —
	// mid-document OR at end of input — and looseness must not flip with the
	// follower. The tui incremental tests compare this lexer to itself and
	// cannot catch a shape drift.
	const listBoundaryShapes: Array<[string, Array<[string, string] | [string, string, boolean]>]> = [
		[
			"- item\n\n",
			[
				["list", "- item", false],
				["space", "\n\n"],
			],
		],
		[
			"1. a\n2. b\n\n",
			[
				["list", "1. a\n2. b", false],
				["space", "\n\n"],
			],
		],
		[
			"- a\n\n\n",
			[
				["list", "- a", false],
				["space", "\n\n\n"],
			],
		],
		[
			"- [x] done\n\n",
			[
				["list", "- [x] done", false],
				["space", "\n\n"],
			],
		],
		[
			"- item\n\nhello",
			[
				["list", "- item", false],
				["space", "\n\n"],
				["paragraph", "hello"],
			],
		],
		[
			"1. a\n2. b\n\n1) x",
			[
				["list", "1. a\n2. b", false],
				["space", "\n\n"],
				["list", "1) x", false],
			],
		],
		// Same-marker continuation across the blank still merges into one loose list.
		["1. a\n2. b\n\n1. c", [["list", "1. a\n2. b\n\n1. c", true]]],
		// A blank inside an item (indented continuation) stays in the item raw.
		[
			"- a\n\n  b\n\n",
			[
				["list", "- a\n\n  b", true],
				["space", "\n\n"],
			],
		],
	];
	for (const [source, shape] of listBoundaryShapes) {
		test(`keeps the list/blank boundary shape for ${JSON.stringify(source)}`, () => {
			const tokens = [...Lexer.lex(source)].map(token =>
				token.type === "list" ? [token.type, token.raw, token.loose] : [token.type, token.raw],
			);
			expect(tokens).toEqual(shape);
		});
	}

	// Lazy-continuation boundary shapes (behavior cross-checked against marked
	// v18): an indented code block cannot interrupt a paragraph, so an indented
	// line directly attached to paragraph text stays in the paragraph even when
	// a setext/hr lookahead matches downstream — while a whitespace-padded
	// blank line detaches it, so the next indented run still opens indented
	// code. Documented divergences from marked kept as-is: marked dedents the
	// attached line inside `text` via its code-merge path, and it splits a
	// padded blank into a `space` token where this lexer keeps the padded
	// blank inside the paragraph raw.
	const lazyBoundaryShapes: Array<[string, Array<[string, string]>]> = [
		[
			"lead\n   \n    code\n",
			[
				["paragraph", "lead\n   \n"],
				["code", "    code\n"],
			],
		],
		[
			"lead\n    attached\n---\n",
			[
				["paragraph", "lead\n    attached\n"],
				["hr", "---\n"],
			],
		],
		[
			"lead\n     deeper attached\n---\n",
			[
				["paragraph", "lead\n     deeper attached\n"],
				["hr", "---\n"],
			],
		],
		[
			"lead\n   \n     deeper code\n",
			[
				["paragraph", "lead\n   \n"],
				["code", "     deeper code\n"],
			],
		],
	];
	for (const [source, shape] of lazyBoundaryShapes) {
		test(`keeps the lazy-continuation boundary shape for ${JSON.stringify(source)}`, () => {
			expect([...Lexer.lex(source)].map(token => [token.type, token.raw])).toEqual(shape);
		});
	}

	test("runs block and inline tokenizer/renderer extensions", () => {
		const latexBlock: TokenizerAndRendererExtension = {
			name: "latexBlock",
			level: "block",
			start(src) {
				const index = src.indexOf("$$\n");
				return index === -1 ? undefined : index;
			},
			tokenizer(src) {
				const match = /^\$\$\n([\s\S]+?)\n\$\$(?:\n|$)/.exec(src);
				return match ? { type: "latexBlock", raw: match[0], text: match[1] } : undefined;
			},
			renderer(token) {
				return `<math>${token.text}</math>\n`;
			},
		};
		const inlineLatex: TokenizerAndRendererExtension = {
			name: "latex",
			level: "inline",
			start(src) {
				const index = src.indexOf("$");
				return index === -1 ? undefined : index;
			},
			tokenizer(src) {
				const match = /^\$([^\n$]+)\$/.exec(src);
				return match ? { type: "latex", raw: match[0], text: match[1] } : undefined;
			},
			renderer(token) {
				return `<i>${token.text}</i>`;
			},
		};
		const marked = new Marked().use({ extensions: [latexBlock, inlineLatex] });

		expect([...marked.lexer("before $x_i$\n\n$$\ny^2\n$$\n")]).toEqual([
			{
				type: "paragraph",
				raw: "before $x_i$",
				text: "before $x_i$",
				tokens: [
					{ type: "text", raw: "before ", text: "before ", escaped: false },
					{ type: "latex", raw: "$x_i$", text: "x_i" },
				],
			},
			{ type: "space", raw: "\n\n" },
			{ type: "latexBlock", raw: "$$\ny^2\n$$\n", text: "y^2" },
		]);
		expect(marked.parse("before $x_i$\n\n$$\ny^2\n$$\n")).toBe("<p>before <i>x_i</i></p>\n<math>y^2</math>\n");
	});

	// Plain text ends where the next token could start, and the lexer reuses
	// each such stop until it passes one. Here it walks through the rejected
	// `foo@bar` (no dotted domain) and must still find the address and URL after it.
	test("finds bare addresses and URLs after an address-like run that is not a link", () => {
		const source = "see foo@bar and baz@qux.com or http://x.y";
		expect([...Lexer.lex(source)]).toEqual([
			{
				type: "paragraph",
				raw: source,
				text: source,
				tokens: [
					{ type: "text", raw: "see foo@bar and ", text: "see foo@bar and ", escaped: false },
					{
						type: "link",
						raw: "baz@qux.com",
						text: "baz@qux.com",
						href: "mailto:baz@qux.com",
						tokens: [{ type: "text", raw: "baz@qux.com", text: "baz@qux.com" }],
					},
					{ type: "text", raw: " or ", text: " or ", escaped: false },
					{
						type: "link",
						raw: "http://x.y",
						text: "http://x.y",
						href: "http://x.y",
						tokens: [{ type: "text", raw: "http://x.y", text: "http://x.y" }],
					},
				],
			},
		]);
	});

	test("an inline extension's startFrom hint tokenizes like its start hint", () => {
		const dollar = (src: string, from: number) => {
			const index = src.indexOf("$", from);
			return index === -1 ? undefined : index;
		};
		const latex = (hint: Pick<TokenizerExtension, "start" | "startFrom">) =>
			new Marked().use({
				extensions: [
					{
						name: "latex",
						level: "inline",
						...hint,
						tokenizer(src) {
							const match = /^\$(\S[^\n$]*)\$/.exec(src);
							return match ? { type: "latex", raw: match[0], text: match[1] } : undefined;
						},
					},
				],
			});
		// Two spans, then an opener the tokenizer rejects: a hint at the lexer's
		// own position is dropped, so the span after it stays text either way.
		const source = "a $x$ b $y$ c $ 5, then $z$";
		const fromHint = [...latex({ startFrom: dollar }).lexer(source)];
		expect(fromHint).toEqual([...latex({ start: src => dollar(src, 0) }).lexer(source)]);
		expect(fromHint).toEqual([
			{
				type: "paragraph",
				raw: source,
				text: source,
				tokens: [
					{ type: "text", raw: "a ", text: "a ", escaped: false },
					{ type: "latex", raw: "$x$", text: "x" },
					{ type: "text", raw: " b ", text: " b ", escaped: false },
					{ type: "latex", raw: "$y$", text: "y" },
					{ type: "text", raw: " c $ 5, then $z$", text: " c $ 5, then $z$", escaped: false },
				],
			},
		]);
	});

	// Reference labels are user-controlled and index the ref-def map. An
	// `Object.prototype` member (`constructor`, `__proto__`, `toString`, …) must
	// not resolve to a fake definition: the link falls back to literal text and
	// never yields a `href: undefined` token that crashes downstream renderers
	// (issue #10283).
	for (const label of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
		test(`treats reference label ${label} as literal text, not an inherited definition`, () => {
			const tokens = [...Lexer.lex(`[text][${label}]`)];
			const links: unknown[] = [];
			const walk = (list: readonly { type: string; tokens?: unknown[] }[]) => {
				for (const token of list) {
					if (token.type === "link") links.push(token);
					if (Array.isArray(token.tokens)) {
						walk(token.tokens as { type: string; tokens?: unknown[] }[]);
					}
				}
			};
			walk(tokens as { type: string; tokens?: unknown[] }[]);
			expect(links).toEqual([]);
			// No anchor element is produced: the label is not a reference definition.
			expect(new Marked().parse(`[text][${label}]`)).not.toContain("<a ");
		});
	}
});
