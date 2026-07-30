import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { AuthStorage, type FetchImpl, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { searchDuckDuckGo } from "@oh-my-pi/pi-coding-agent/web/search/providers/duckduckgo";

function duckResult(index: number): string {
	return `<div class="result results_links"><a class="result__a" href="https://example.com/${index}">Result ${index}</a><a class="result__snippet">Snippet ${index}</a></div>`;
}

function duckPage(indices: readonly number[], continuation = false): string {
	const results = indices.map(duckResult).join("\n");
	if (!continuation) return results;
	return `${results}
		<div class="nav-link">
			<form action="/html/" method="post">
				<input type="submit" class="btn btn--alt" value="Next" />
				<input type="hidden" name="q" value="open source software" />
				<input value="10" type="hidden" name="s" />
				<input type="hidden" name="nextParams" value="" />
				<input type="hidden" name="v" value="l" />
				<input type="hidden" name="o" value="json" />
				<input type="hidden" name="dc" value="11" />
				<input type="hidden" name="api" value="d.js" />
				<input value="test-vqd" name="vqd" type="hidden" />
				<input name="kl" value="us-en" type="hidden" />
			</form>
		</div>`;
}

describe("DuckDuckGo web search provider", () => {
	it("submits the returned continuation form to satisfy a 20-result limit", async () => {
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		const requests: URLSearchParams[] = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			expect(init?.method).toBe("POST");
			const body = new URLSearchParams(String(init?.body));
			requests.push(body);
			const html =
				requests.length === 1
					? duckPage([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], true)
					: duckPage([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
			return new Response(html, { status: 200 });
		};

		try {
			const response = await searchDuckDuckGo({
				query: "open source software",
				limit: 20,
				systemPrompt: "Test DuckDuckGo search",
				authStorage,
				fetch: fetchMock,
			});

			expect(requests).toHaveLength(2);
			expect(Object.fromEntries(requests[0])).toEqual({ q: "open source software", kl: "us-en", b: "" });
			expect(Object.fromEntries(requests[1])).toEqual({
				q: "open source software",
				s: "10",
				nextParams: "",
				v: "l",
				o: "json",
				dc: "11",
				api: "d.js",
				vqd: "test-vqd",
				kl: "us-en",
			});
			expect(response.provider).toBe("duckduckgo");
			expect(response.sources).toHaveLength(20);
			expect(response.sources[0]?.url).toBe("https://example.com/0");
			expect(response.sources.at(-1)?.url).toBe("https://example.com/19");
		} finally {
			authStorage.close();
		}
	});
});
