import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchProviderId } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/auth-storage";

describe("HTTP web search selection", () => {
	let authStorage: AuthStorage;
	let attempted: string[];

	beforeEach(() => {
		authStorage = createInMemoryAuthStorage();
		attempted = [];
		vi.spyOn(provider, "getSearchProvider").mockImplementation(async id => ({
			id: id as SearchProviderId,
			label: id,
			isAvailable: () => true,
			isExplicitlyAvailable: () => true,
			search: async params => {
				expect(params).not.toHaveProperty("model");
				expect(params).not.toHaveProperty("modelRegistry");
				attempted.push(id);
				throw new Error("try next");
			},
		}));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
	});

	it("walks the HTTP engine chain without any configured chat models", async () => {
		await runSearchQuery({ query: "anything" }, { authStorage });
		expect(attempted).toEqual([
			"parallel",
			"exa",
			"firecrawl",
			"searxng",
			"startpage",
			"duckduckgo",
			"ecosia",
			"google",
			"mojeek",
			"public",
		]);
	});

	it("uses a supplied registry only as the credential source", async () => {
		const modelRegistry = new ModelRegistry(authStorage, "/nonexistent/omp-web-search-models.yml", {
			settings: Settings.isolated({}),
		});
		const find = vi.spyOn(modelRegistry, "find").mockImplementation(() => {
			throw new Error("HTTP search must not select a chat model");
		});
		await runSearchQuery({ query: "anything", engine: "google" }, { modelRegistry });
		expect(attempted).toEqual(["google"]);
		expect(find).not.toHaveBeenCalled();
	});

	it("keeps an explicit engine for X site queries", async () => {
		await runSearchQuery({ query: "tern site:x.com", engine: "google" }, { authStorage });
		expect(attempted).toEqual(["google"]);
	});

	it("rejects retired model overrides before attempting a search", async () => {
		await expect(
			runSearchQuery({ query: "anything", model: "other/model" } as never, { authStorage }),
		).rejects.toThrow("model overrides are not supported");
		expect(attempted).toEqual([]);
	});

	it("rejects removed hosted-grounding identifiers", async () => {
		await expect(runSearchQuery({ query: "anything", engine: "openai" } as never, { authStorage })).rejects.toThrow(
			"Unknown HTTP search engine",
		);
		expect(attempted).toEqual([]);
	});
});
