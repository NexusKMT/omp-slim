import { describe, expect, it } from "bun:test";

// Regression for the mid-session render crash (#10864): the gradient palette read the
// module-global `theme` before `initTheme`/`initThemeSync` had assigned it (resume replay,
// or a second coding-agent module graph loaded by a plugin), throwing
// `undefined is not an object (evaluating 'theme.getColorMode')` out of an editor render.
//
// The pre-init window only exists in a module graph where `theme` was never initialized.
// `bun test` shares one module registry across files, so any sibling that calls `initTheme`
// leaves `theme` defined process-wide; a fresh subprocess is the only way to exercise the
// unguarded branch deterministically, regardless of suite ordering.
describe("gradient highlight before theme init (#10864)", () => {
	it("paints magic keywords in a fresh module graph where the global theme is unassigned", async () => {
		const entry = new URL("../../src/modes/magic-keywords.ts", import.meta.url).pathname;
		const text = "please ultrathink about this";
		const script = [
			`import { highlightMagicKeywords } from ${JSON.stringify(entry)};`,
			`const text = ${JSON.stringify(text)};`,
			`const out = highlightMagicKeywords(text, undefined, 0);`,
			`if (out.replaceAll(/\\x1b\\[[0-9;]*m/g, "") !== text) { console.error("visible-text-changed"); process.exit(2); }`,
			`if (!out.includes("\\x1b[")) { console.error("no-gradient-escapes"); process.exit(3); }`,
		].join("\n");
		const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
		const stderr = await new Response(proc.stderr).text();
		const code = await proc.exited;
		expect(stderr).toBe("");
		expect(code).toBe(0);
	});
});
