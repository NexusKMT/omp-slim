import { describe, expect, it } from "bun:test";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { xaiModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("paid xai (XAI_API_KEY) Responses contract", () => {
	it("registers xai on the catalog Responses discovery path", () => {
		const entry = CATALOG_PROVIDERS.find(provider => provider.id === "xai");
		expect(entry, "xai catalog descriptor").toBeDefined();
		expect(entry!.defaultModel).toBe("grok-4.5");
		expect(entry!.envVars).toContain("XAI_API_KEY");
		const options = xaiModelManagerOptions({ apiKey: "test-key" });
		expect(options.providerId).toBe("xai");
		expect(options.fetchDynamicModels, "live /v1/models overlay").toBeTypeOf("function");
	});

	it("bundles every paid xai chat model on openai-responses", () => {
		const models = getBundledModels("xai");
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.api, `${model.provider}/${model.id}`).toBe("openai-responses");
			expect(model.baseUrl).toBe("https://api.x.ai/v1");
		}
	});
});
