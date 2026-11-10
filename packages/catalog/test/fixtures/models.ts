import { Effort } from "../../src/effort";
import type { Api, Model } from "../../src/types";

/**
 * Test-owned model metadata. Names are fixture labels, never a production
 * roster or evidence of an endpoint's capabilities. Tests for historical
 * protocol records must provide their historical API explicitly.
 */
export function getTestModel<TApi extends Api = "openai-completions">(
	provider = "test",
	id = "test-model",
	overrides: Partial<Model<TApi>> = {},
): Model<TApi> {
	return {
		id,
		name: id,
		provider,
		api: "openai-completions" as TApi,
		baseUrl: "https://models.example.invalid/v1",
		identity: { class: "unknown" },
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High], defaultLevel: Effort.Medium },
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 8192,
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		compat: {} as Model<TApi>["compat"],
		...overrides,
	};
}

/** Explicit neutral fixtures for tests which exercise listing rather than vendor catalogs. */
export function getTestModels(provider = "test"): Model[] {
	return [getTestModel(provider)];
}

export function getTestProviders(): readonly string[] {
	return ["test"];
}
