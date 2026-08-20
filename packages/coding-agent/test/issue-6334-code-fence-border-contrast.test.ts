import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * Regression test for #6334: markdown code fence header lines (mdCodeBlockBorder)
 * were nearly invisible on the default dark theme (and several bundled dark themes)
 * because the token was mapped to a near-background surface color.
 *
 * The fence border paints the whole ```lang / ```start:end:path info-string line
 * (see getMarkdownTheme() -> codeBlockBorder in modes/theme/theme.ts), so it carries
 * real navigation info and must stay legible as secondary chrome. This test resolves
 * the token for each affected theme and asserts a minimum WCAG contrast ratio against
 * the theme's own page background, so a palette change can't silently regress it back
 * below the legibility floor.
 */

const THEME_DIR = join(import.meta.dir, "../src/modes/theme");

/** Themes flagged in #6334 as pinning mdCodeBlockBorder to a near-bg surface tone. */
const AFFECTED_THEMES: { name: string; file: string }[] = [
	{ name: "dark", file: "dark.json" },
	{ name: "dark-catppuccin", file: "defaults/dark-catppuccin.json" },
	{ name: "dark-nord", file: "defaults/dark-nord.json" },
	{ name: "dark-eclipse", file: "defaults/dark-eclipse.json" },
	{ name: "dark-retro", file: "defaults/dark-retro.json" },
];

/**
 * Legibility floor. The issue suggests ~3:1 for secondary chrome; dark-nord's
 * darkest legible palette entry (the official brightened nord3, #616e88, which the
 * Nord spec designates for secondary content like comments) reaches 2.43:1 against
 * nord0, so the floor is set just under that. Every previous broken value sat at
 * 1.06:1-2.25:1, well below this line.
 */
const MIN_CONTRAST = 2.4;

interface ThemeJson {
	vars?: Record<string, string>;
	colors: Record<string, string | number>;
	export?: Record<string, string>;
}

function loadTheme(file: string): ThemeJson {
	return JSON.parse(readFileSync(join(THEME_DIR, file), "utf8")) as ThemeJson;
}

/** Resolve a theme color value: either a var name from `vars` or a literal hex. */
function resolveColor(theme: ThemeJson, value: string): string {
	const fromVars = theme.vars?.[value];
	if (fromVars !== undefined) return fromVars;
	return value;
}

function relativeLuminance(hex: string): number {
	const h = hex.replace("#", "");
	const channel = (i: number) => {
		const c = Number.parseInt(h.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrastRatio(a: string, b: string): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

describe("code fence border contrast (#6334)", () => {
	for (const { name, file } of AFFECTED_THEMES) {
		test(`${name}: mdCodeBlockBorder is legible against the theme page background`, () => {
			const theme = loadTheme(file);
			const borderToken = theme.colors.mdCodeBlockBorder;
			expect(typeof borderToken).toBe("string");
			const border = resolveColor(theme, borderToken as string);
			expect(border).toMatch(/^#[0-9a-fA-F]{6}$/);

			const pageBgToken = theme.export?.pageBg;
			expect(typeof pageBgToken).toBe("string");
			const pageBg = resolveColor(theme, pageBgToken as string);
			expect(pageBg).toMatch(/^#[0-9a-fA-F]{6}$/);

			const ratio = contrastRatio(border, pageBg);
			expect(ratio).toBeGreaterThanOrEqual(MIN_CONTRAST);
		});
	}
});
