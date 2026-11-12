/**
 * Central directive pipeline: executeSearch parses the query once, hands the
 * StructuredQuery to the HTTP provider, then lenient-filters the
 * returned sources — enforcing constraints the provider ignored and relaxing
 * any dimension that would eliminate every result.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchProviderId, SearchResponse, SearchSource } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/auth-storage";

const SOURCES: SearchSource[] = [
	{ title: "Docs page", url: "https://docs.example.com/guide" },
	{ title: "Blog post", url: "https://blog.other.com/post" },
];

const openAuthStorages: AuthStorage[] = [];

async function stubProvider(id: SearchProviderId, behaviour: (params: SearchParams) => Promise<SearchResponse>) {
	await Settings.init({ inMemory: true });
	const authStorage = createInMemoryAuthStorage();
	openAuthStorages.push(authStorage);
	const stub: provider.SearchProvider = {
		id,
		label: id,
		isAvailable: () => true,
		isExplicitlyAvailable: () => true,
		search: behaviour,
	};
	const getProvider = vi.spyOn(provider, "getSearchProvider").mockImplementation(async requested => {
		if (requested !== id) throw new Error(`Unexpected provider: ${requested}`);
		return stub;
	});
	return { authStorage, getProvider };
}

describe("web search directive pipeline", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		for (const authStorage of openAuthStorages.splice(0)) authStorage.close();
	});

	it("passes the parsed query to the HTTP provider and post-filters ignored constraints", async () => {
		let seen: SearchParams | undefined;
		const context = await stubProvider("google", async params => {
			seen = params;
			return { provider: "google", sources: SOURCES };
		});

		const result = await runSearchQuery({ query: "guide site:docs.example.com", engine: "google" }, context);

		expect(seen).not.toHaveProperty("model");
		expect(seen).not.toHaveProperty("modelRegistry");
		expect(seen?.parsedQuery?.sites).toEqual(["docs.example.com"]);
		expect(seen?.parsedQuery?.text).toBe("guide");
		expect(result.details.response.sources.map(source => source.url)).toEqual(["https://docs.example.com/guide"]);
		expect(result.content[0]?.text).not.toContain("Note:");
	});

	it("relaxes a constraint that matches nothing and leads the LLM text with a note", async () => {
		const context = await stubProvider("google", async () => ({ provider: "google", sources: SOURCES }));

		const result = await runSearchQuery({ query: "guide site:nowhere.example", engine: "google" }, context);

		expect(result.details.response.sources).toHaveLength(SOURCES.length);
		expect(result.content[0]?.text).toStartWith(
			"Note: no results matched `site:nowhere.example`; the constraint was relaxed",
		);
	});

	it.each<[string, string, SearchProviderId]>([
		["keeps X-only queries on the selected HTTP engine", "tern site:x.com", "google"],
		["keeps the HTTP engine for queries that are not X-only", "tern site:x.com site:github.com", "google"],
	])("%s", async (_caseName, query, expectedProvider) => {
		const context = await stubProvider("google", async () => ({ provider: "google", sources: SOURCES }));

		const result = await runSearchQuery({ query, engine: "google" }, context);

		expect(result.details.response.provider).toBe(expectedProvider);
	});

	it("allows explicit selection of an HTTP engine", async () => {
		const context = await stubProvider("google", async params => ({
			provider: "google",
			sources: [{ title: params.query, url: "https://google.example" }],
		}));
		const exaProvider: provider.SearchProvider = {
			id: "exa",
			label: "exa",
			isAvailable: () => false,
			isExplicitlyAvailable: () => true,
			search: async params => ({
				provider: "exa",
				sources: [{ title: params.query, url: "https://exa.example" }],
			}),
		};
		context.getProvider.mockImplementation(async requested => {
			if (requested === "exa") return exaProvider;
			throw new Error(`Unexpected provider: ${requested}`);
		});

		const result = await runSearchQuery({ query: "override", engine: "exa" }, context);

		expect(result.details.response.provider).toBe("exa");
		expect(result.details.response.sources[0]?.title).toBe("override");
	});
});
