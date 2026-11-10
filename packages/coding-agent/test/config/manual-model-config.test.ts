import { describe, expect, it } from "bun:test";
import { ModelsConfigSchema } from "../../src/config/models-config-schema";
import { validateProviderConfiguration } from "../../src/config/models-config";
import { buildCustomModels } from "../../src/config/custom-models";

const config = {
	baseUrl: "https://gateway.example.invalid/v1",
	apiKey: "MANUAL_MODEL_KEY",
	models: [{ id: "my-model" }],
};

describe("manual model configuration", () => {
	it("accepts baseUrl, apiKey and one id with an omitted API", () => {
		expect(ModelsConfigSchema.allows({ providers: { gateway: config } })).toBe(true);
		validateProviderConfiguration("gateway", config, "models-config");
		const [model] = buildCustomModels("gateway", config);
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe(config.baseUrl);
		expect(model.id).toBe("my-model");
	});
	it("rejects other protocols at either provider or model level", () => {
		for (const api of ["anthropic-messages", "openai-responses", "ollama-chat", "openrouter"]) {
			expect(ModelsConfigSchema.allows({ providers: { gateway: { ...config, api } } })).toBe(false);
			expect(
				ModelsConfigSchema.allows({ providers: { gateway: { ...config, models: [{ id: "my-model", api }] } } }),
			).toBe(false);
			expect(() => validateProviderConfiguration("gateway", { ...config, api }, "runtime-register")).toThrow(
				/Unsupported model API/,
			);
		}
	});
	it("refuses retired discovery, gateway and vendor-auth configuration", () => {
		for (const field of [
			{ discovery: { type: "openai-models-list" } },
			{ transport: "pi-native" },
			{ auth: "oauth" },
			{ remoteCompaction: { api: "openai-responses" } },
		]) {
			expect(ModelsConfigSchema.allows({ providers: { gateway: { ...config, ...field } } })).toBe(false);
		}
	});
	it("requires explicit endpoint identity and rejects duplicate model ids", () => {
		expect(ModelsConfigSchema.allows({ providers: { gateway: { models: [{ id: "my-model" }] } } })).toBe(false);
		expect(ModelsConfigSchema.allows({ providers: { gateway: { ...config, models: [] } } })).toBe(false);
		expect(() =>
			validateProviderConfiguration(
				"gateway",
				{ ...config, models: [{ id: "same" }, { id: "same" }] },
				"models-config",
			),
		).toThrow(/duplicate/);
	});
	it("composes headers lazily and preserves explicit model endpoint overrides", async () => {
		const [model] = buildCustomModels("gateway", {
			...config,
			headers: { "x-provider": "configured" },
			models: [{ id: "custom", baseUrl: "http://127.0.0.1:9000/v1", headers: { "x-model": "custom" } }],
		});
		expect(model.baseUrl).toBe("http://127.0.0.1:9000/v1");
		expect(await model.resolveHeaders?.()).toEqual({ "x-provider": "configured", "x-model": "custom" });
	});
});
