import { Effort, type Model, type ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-ai/build";

/** Explicit synthetic fixture; provider and model names never determine capabilities. */
export function createTestModel(options: Partial<ModelSpec> & Pick<ModelSpec, "provider" | "id">): Model {
	return buildModel({
		api: "openai-completions",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		...options,
	});
}
