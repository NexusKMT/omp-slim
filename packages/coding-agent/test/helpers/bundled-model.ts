/**
 * Slim-repo stand-in for the removed `./bundled-model` bundled-model
 * registry. The slim catalog no longer ships `models.json`, so `getBundledModel`
 * returns a minimal `openai-completions` chat model keyed by the requested
 * provider/model id. Tests that only need "a model" keep working; tests that
 * asserted real bundled metadata (native apis, rate cards) must adapt separately.
 */
import { Effort, type Api, type Model, type ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/** Provider identifier accepted by the bundled model registry. */
export type GeneratedProvider = string;

/** Look up a bundled model. */
export function getBundledModel<TApi extends Api = Api>(provider: string, modelId: string): Model<TApi> {
	return buildModel({
		id: modelId,
		name: modelId,
		provider,
		api: "openai-completions",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	} as unknown as ModelSpec<TApi>) as Model<TApi>;
}

/** List a provider's bundled models (single synthetic entry). */
export function getBundledModels(provider: string): Model<Api>[] {
	return [getBundledModel(provider, `${provider}-default`)];
}
