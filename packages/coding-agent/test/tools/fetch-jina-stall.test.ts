import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderHtmlToText } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { asGlobalFetch } from "../helpers/fetch-mock";

describe("renderHtmlToText: Firecrawl response validation", () => {
	it("falls back when Firecrawl's own fetch of the page got an error status", async () => {
		const originalApiKey = process.env.FIRECRAWL_API_KEY;
		process.env.FIRECRAWL_API_KEY = "test-firecrawl-key";
		try {
			const settings = Settings.isolated({ "providers.fetch": "firecrawl" });
			const paragraph =
				"This locally rendered article contains enough meaningful prose to satisfy the shared reader quality gate. ";
			const html = `<html><body><article><h1>Fallback article</h1><p>${paragraph.repeat(4)}</p></article></body></html>`;
			const fetchMock = asGlobalFetch(() =>
				Response.json({
					success: true,
					data: {
						markdown: "The page you were looking for could not be found on this server. ".repeat(3),
						metadata: { statusCode: 404 },
					},
				}),
			);

			const result = await renderHtmlToText(
				"https://example.com/article",
				html,
				1,
				settings,
				undefined,
				null,
				fetchMock,
			);

			expect(result.method).toBe("native");
			expect(result.content).toContain("Fallback article");
		} finally {
			if (originalApiKey === undefined) delete process.env.FIRECRAWL_API_KEY;
			else process.env.FIRECRAWL_API_KEY = originalApiKey;
		}
	});
});
