import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchDuckDuckGo } from "@oh-my-pi/pi-coding-agent/web/search/providers/duckduckgo";
import { applyQueryConstraints, parseSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search/query";

const fakeAuthStorage = {
	async getApiKey() {
		throw new Error("DuckDuckGo search must not request API keys");
	},
	resolver() {
		throw new Error("DuckDuckGo search must not request credential resolvers");
	},
	hasAuth() {
		throw new Error("DuckDuckGo search must not check auth");
	},
} as unknown as AuthStorage;

function makeParams(query: string, fetch: FetchImpl): SearchParams {
	return {
		query,
		authStorage: fakeAuthStorage,
		systemPrompt: "DuckDuckGo search test prompt",
		fetch,
	};
}

/** One result block in the shape DuckDuckGo's no-JS HTML page renders live. */
function resultBlock(url: string, title: string, snippet: string, timestamp?: string): string {
	return `
		<div class="result results_links results_links_deep web-result ">
			<div class="links_main links_deep result__body">
				<h2 class="result__title">
					<a rel="nofollow" class="result__a" href="${url}">${title}</a>
				</h2>
				<div class="result__extras">
					<div class="result__extras__url">
						<span class="result__icon">
							<a rel="nofollow" href="${url}"><img class="result__icon__img" width="16" height="16" alt="" src="//external-content.duckduckgo.com/ip3/example.ico" name="i15" /></a>
						</span>
						<a class="result__url" href="${url}">${url}</a>
						${timestamp ? `<span>&nbsp; &nbsp; ${timestamp}</span>` : ""}
					</div>
				</div>
				<a class="result__snippet" href="${url}">${snippet}</a>
				<div class="clear"></div>
			</div>
		</div>`;
}

function resultsPage(blocks: string): string {
	return `<!DOCTYPE html><html><body><div id="links" class="results">${blocks}<div class="nav-link"></div></div></body></html>`;
}

describe("DuckDuckGo web search provider", () => {
	it("extracts result timestamps into publishedDate/ageSeconds so date bounds can be enforced", async () => {
		const html = resultsPage(
			[
				resultBlock("https://example.com/fresh", "Fresh page", "A recent article.", "2026-07-30T20:19:00.0000000"),
				resultBlock("https://example.com/undated", "Undated page", "No timestamp here."),
			].join(""),
		);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));

		const response = await searchDuckDuckGo(makeParams("weather", fetchMock));

		expect(response.provider).toBe("duckduckgo");
		expect(response.sources).toHaveLength(2);

		const dated = response.sources[0];
		expect(dated.url).toBe("https://example.com/fresh");
		expect(dated.publishedDate).toBe("2026-07-30T20:19:00.0000000");
		expect(dated.ageSeconds).toBeGreaterThan(0);

		const undated = response.sources[1];
		expect(undated.url).toBe("https://example.com/undated");
		expect(undated.publishedDate).toBeUndefined();
		expect(undated.ageSeconds).toBeUndefined();
	});

	it("honors after:/before: bounds against DuckDuckGo's extracted timestamps", async () => {
		const html = resultsPage(
			[
				resultBlock(
					"https://example.com/in-range",
					"In range",
					"Within the window.",
					"2026-07-10T09:00:00.0000000",
				),
				resultBlock(
					"https://example.com/too-new",
					"Too new",
					"After the window ends.",
					"2026-07-30T09:00:00.0000000",
				),
				resultBlock("https://example.com/undated", "Undated", "No timestamp, cannot prove violation."),
			].join(""),
		);
		const fetchMock: FetchImpl = () => Promise.resolve(new Response(html, { status: 200 }));

		const query = "weather after:2026-07-01 before:2026-07-15";
		const response = await searchDuckDuckGo(makeParams(query, fetchMock));
		const { sources } = applyQueryConstraints(response.sources, parseSearchQuery(query));

		const urls = sources.map(s => s.url);
		expect(urls).toContain("https://example.com/in-range");
		expect(urls).toContain("https://example.com/undated");
		expect(urls).not.toContain("https://example.com/too-new");
	});
});
