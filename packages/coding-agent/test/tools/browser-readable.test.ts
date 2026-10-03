import { describe, expect, it } from "bun:test";
import { extractReadableFromHtml } from "@oh-my-pi/pi-coding-agent/tools/browser";

describe("browser readable extraction", () => {
	it("extracts markdown content from article-style pages", async () => {
		const html = `<!doctype html>
			<html>
				<head><title>Docs</title></head>
				<body>
					<article>
						<h1>Responses API</h1>
						<p>The Responses API stores output only when you opt in.</p>
					</article>
				</body>
			</html>`;

		const result = await extractReadableFromHtml(html, "https://example.com/docs", "markdown");

		expect(result).not.toBeNull();
		expect(result?.title).toBe("Docs");
		expect(result?.markdown).toContain("Responses API");
		expect(result?.markdown).toContain("stores output only when you opt in");
	});

	it("extracts docs-style main content", async () => {
		const html = `<!doctype html>
			<html>
				<head><title>Reference</title></head>
				<body>
					<div class="app-shell">
						<nav>Navigation</nav>
						<main data-pagefind-body>
							<section>
								<h1>Apps SDK</h1>
								<p>Build once, run in many places.</p>
							</section>
						</main>
					</div>
				</body>
			</html>`;

		const result = await extractReadableFromHtml(html, "https://developers.openai.com/apps-sdk/reference", "text");

		expect(result).not.toBeNull();
		expect(result?.title).toBe("Reference");
		expect(result?.text).toContain("Apps SDK");
		expect(result?.text).toContain("Build once, run in many places");
	});

	it("scopes extraction to a selector", async () => {
		const html = `<main>
			<section id="first"><h1>First</h1><p>Keep me.</p></section>
			<section id="second"><h1>Second</h1><p>Drop me.</p></section>
		</main>`;
		const result = await extractReadableFromHtml(html, "https://example.com/", "markdown", {
			selector: "#first",
		});
		expect(result?.markdown).toContain("Keep me.");
		expect(result?.markdown).not.toContain("Drop me.");
	});

	it("returns a compact heading outline", async () => {
		const html = `<main><h1>Guide</h1><p>Intro.</p><h2>Install</h2><p>Steps.</p></main>`;
		const result = await extractReadableFromHtml(html, "https://example.com/", "markdown", { outline: true });
		expect(result?.markdown).toBe("# Guide\n## Install");
	});

	it("keeps only sections selected by heading text", async () => {
		const html = `<main>
			<h1>Guide</h1><p>Overview.</p>
			<h2>Install Linux</h2><p>Use apt.</p>
			<h2>Install macOS</h2><p>Use brew.</p>
			<h2>Troubleshooting</h2><p>Read logs.</p>
		</main>`;
		const result = await extractReadableFromHtml(html, "https://example.com/", "markdown", {
			filter: "macos",
		});
		expect(result?.markdown).toContain("Install macOS");
		expect(result?.markdown).toContain("Use brew.");
		expect(result?.markdown).not.toContain("Use apt.");
		expect(result?.markdown).not.toContain("Read logs.");
	});

	it("keeps block boundaries as line breaks in Readability text", async () => {
		const paragraph = (n: number) =>
			`<p>Paragraph ${n} explains the fare rules in enough words that Readability scores this block as article prose rather than page chrome.</p>`;
		const html = `<!doctype html><html><head><title>Fares</title></head><body><nav>Home</nav><article><h1>Fares</h1>${paragraph(1)}${paragraph(2)}${paragraph(3)}<ul><li>Adult</li><li>Senior</li></ul><p>Transfers are <em>free</em>.<br>Passes are not.</p><pre>zone  price\n1     $2.40</pre></article></body></html>`;

		const result = await extractReadableFromHtml(html, "https://example.com/fares", "text");
		const lines = result?.text?.split("\n");

		expect(lines).toContain(paragraph(1).replace(/<\/?p>/g, ""));
		expect(lines).toContain("Adult");
		expect(lines).toContain("Senior");
		expect(lines).toContain("Transfers are free.");
		expect(lines).toContain("Passes are not.");
		expect(result?.text).toContain("zone  price\n1     $2.40");
	});

	it("keeps block boundaries as line breaks in fallback text and drops scripts and styles", async () => {
		const html = `<main><style>p { color: red }</style><h1>Fares</h1><p>One way.</p><table><tr><td>Zone 1</td><td>$2.40</td></tr></table><script>track()</script></main>`;

		const result = await extractReadableFromHtml(html, "https://example.com/", "text", { selector: "main" });

		expect(result?.text).toBe("Fares\n\nOne way.\n\nZone 1\n\n$2.40");
	});
});
