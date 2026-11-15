/**
 * Central directive pipeline: executeSearch parses the query once, hands the
 * StructuredQuery to the parallel provider, then lenient-filters the returned
 * sources — enforcing constraints the provider ignored and relaxing any
 * dimension that would eliminate every result.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchResponse, SearchSource } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const SOURCES: SearchSource[] = [
	{ title: "Docs page", url: "https://docs.example.com/guide" },
	{ title: "Blog post", url: "https://blog.other.com/post" },
];

const openAuthStorages: AuthStorage[] = [];

function stubParallelProvider(behaviour: (params: SearchParams) => Promise<SearchResponse>) {
	const authStorage = createInMemoryAuthStorage();
	openAuthStorages.push(authStorage);
	const stub: provider.SearchProvider = {
		id: "parallel",
		label: "Parallel",
		isAvailable: () => true,
		isExplicitlyAvailable: () => true,
		search: behaviour,
	};
	const getProvider = vi.spyOn(provider, "getSearchProvider").mockImplementation(async requested => {
		if (requested !== "parallel") throw new Error(`Unexpected provider: ${requested}`);
		return stub;
	});
	return { authStorage, getProvider };
}

describe("web search directive pipeline", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		for (const authStorage of openAuthStorages.splice(0)) authStorage.close();
	});

	it("passes the parsed query to the provider and post-filters ignored constraints", async () => {
		let seen: SearchParams | undefined;
		const { authStorage } = stubParallelProvider(async params => {
			seen = params;
			return { provider: "parallel", sources: SOURCES };
		});

		const result = await runSearchQuery({ query: "guide site:docs.example.com" }, { authStorage });

		expect(seen?.parsedQuery?.sites).toEqual(["docs.example.com"]);
		expect(seen?.parsedQuery?.text).toBe("guide");
		expect(result.details.response.sources.map(source => source.url)).toEqual(["https://docs.example.com/guide"]);
		expect(result.content[0]?.text).not.toContain("Note:");
	});

	it("relaxes a constraint that matches nothing and leads the LLM text with a note", async () => {
		const { authStorage } = stubParallelProvider(async () => ({ provider: "parallel", sources: SOURCES }));

		const result = await runSearchQuery({ query: "guide site:nowhere.example" }, { authStorage });

		expect(result.details.response.sources).toHaveLength(SOURCES.length);
		expect(result.content[0]?.text).toStartWith(
			"Note: no results matched `site:nowhere.example`; the constraint was relaxed",
		);
	});
});
