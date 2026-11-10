import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Api, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { SearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import type { SearchResponse } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

/** Records each attempted `provider/id` and fails so the chain keeps walking. */
class RecordingProvider extends SearchProvider {
	readonly id = "openai";
	readonly label = "Recording";

	constructor(private readonly attempted: string[]) {
		super();
	}

	isAvailable(): boolean {
		return true;
	}

	async search(params: SearchParams): Promise<SearchResponse> {
		this.attempted.push(`${params.model.provider}/${params.model.id}`);
		throw new Error("try next");
	}
}

describe("single-model web search", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let attempted: string[];

	beforeEach(async () => {
		const settings = await Settings.init({ inMemory: true });
		authStorage = createInMemoryAuthStorage();
		// Paid credentials the chain must never spend unless the session already runs on them.
		for (const paid of [
			"openai",
			"openai-codex",
			"anthropic",
			"xai",
			"perplexity",
			"tavily",
			"kagi",
			"brave",
			"zai",
		]) {
			authStorage.keys.setRuntime(paid, `test-${paid}-key`);
		}
		modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		attempted = [];
		const recorder = new RecordingProvider(attempted);
		vi.spyOn(provider, "getGroundedSearchProvider").mockResolvedValue(recorder);
		vi.spyOn(provider, "getSearchProvider").mockResolvedValue(recorder);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		authStorage.close();
	});

	function sessionModel(provider: string, id: string): Model<Api> {
		const model = modelRegistry.find(provider, id);
		if (!model) throw new Error(`Missing catalog model: ${provider}/${id}`);
		return model;
	}

	it.each([
		["anthropic", "claude-sonnet-4-5"],
		["openai", "gpt-6.1-sol"],
		["openai-codex", "gpt-6.1-sol"],
	])("uses only the current %s chat model even when a cheaper search model exists", async (host, id) => {
		const current = sessionModel(host, id);
		await runSearchQuery({ query: "anything" }, { authStorage, modelRegistry, sessionModel: current });
		expect(attempted.filter(selector => !selector.startsWith("web/"))).toEqual([`${host}/${id}`]);
		expect(attempted).not.toContain("web/perplexity");
		expect(attempted).not.toContain("web/hosted");
	});

	it("never injects xAI for an X query when the current model is not xAI", async () => {
		await runSearchQuery({ query: "tern from:jack site:x.com" }, { authStorage, modelRegistry });
		expect(attempted.length).toBeGreaterThan(0);
		expect(attempted.every(selector => selector.startsWith("web/"))).toBe(true);
		expect(attempted).not.toContain("web/perplexity");
	});

	it("uses ordinary HTTP search when the current model has no hosted search", async () => {
		const current = { ...sessionModel("openai", "gpt-6.1-sol"), webSearch: undefined };
		await runSearchQuery({ query: "anything" }, { authStorage, modelRegistry, sessionModel: current });
		expect(attempted.every(selector => selector.startsWith("web/"))).toBe(true);
	});

	it("rejects retired model overrides rather than running another model", async () => {
		await expect(
			runSearchQuery({ query: "anything", model: "xai/grok-4.3" } as never, { authStorage, modelRegistry }),
		).rejects.toThrow("model overrides are not supported");
		expect(attempted).toEqual([]);
	});

	it("rejects a grounded answer without sources and retains the failure with HTTP fallback", async () => {
		vi.spyOn(provider, "getGroundedSearchProvider").mockResolvedValue({
			id: "anthropic",
			label: "Anthropic",
			isAvailable: () => true,
			isExplicitlyAvailable: () => true,
			search: async () => ({ provider: "anthropic", answer: "from weights", sources: [] }),
		});
		const result = await runSearchQuery(
			{ query: "anything" },
			{ authStorage, modelRegistry, sessionModel: sessionModel("anthropic", "claude-sonnet-4-5") },
		);
		expect(result.details.failures?.[0]?.reason).toContain("returned no sources");
	});
});
