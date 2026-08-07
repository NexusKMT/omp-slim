import { describe, expect, it } from "bun:test";
import { toClinePassPublicModelId, toClinePassWireModelId } from "@oh-my-pi/pi-catalog/cline-pass-model-id";
import { buildOpenAICompat } from "@oh-my-pi/pi-catalog/compat/openai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	DEFAULT_MODEL_PER_PROVIDER,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
	PROVIDER_DESCRIPTORS,
} from "@oh-my-pi/pi-catalog/provider-models";
import { clinePassModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

const CLINEPASS_MODELS_DEV_FIXTURE = {
	"cline-pass": {
		models: {
			"cline-pass/kimi-k3": {
				id: "cline-pass/kimi-k3",
				name: "Kimi K3",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image"] },
				limit: { context: 1_048_576, output: 131_072 },
				cost: { input: 9, output: 12 },
				reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }],
			},
			"cline-pass/qwen3.7-max": {
				id: "cline-pass/qwen3.7-max",
				name: "Qwen3.7 Max",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text"] },
				limit: { context: 1_000_000, output: 384_000 },
				cost: { input: 5, output: 10 },
			},
		},
	},
};

const sourceModels = mapModelsDevToModels(CLINEPASS_MODELS_DEV_FIXTURE, MODELS_DEV_PROVIDER_DESCRIPTORS).filter(
	model => model.provider === "cline-pass",
);

function sourceModel(id: string): ModelSpec<"openai-completions"> {
	const model = sourceModels.find(candidate => candidate.id === id);
	if (model?.api !== "openai-completions") {
		throw new Error(`Missing ClinePass source fixture model: ${id}`);
	}
	return model as ModelSpec<"openai-completions">;
}
describe("ClinePass catalog", () => {
	it("maps source metadata into the subscription catalog contract", () => {
		const model = sourceModel("kimi-k3");
		const descriptor = PROVIDER_DESCRIPTORS.find(candidate => candidate.providerId === "cline-pass");

		expect(DEFAULT_MODEL_PER_PROVIDER["cline-pass"]).toBe("kimi-k3");
		expect(descriptor).toMatchObject({
			providerId: "cline-pass",
			dynamicModelsAuthoritative: true,
			catalogDiscovery: {
				label: "ClinePass",
				envVars: ["CLINE_API_KEY"],
				allowUnauthenticated: true,
			},
		});
		expect(descriptor?.allowUnauthenticated).toBeUndefined();
		expect(model).toMatchObject({
			id: "kimi-k3",
			name: "Kimi K3",
			api: "openai-completions",
			provider: "cline-pass",
			baseUrl: "https://api.cline.bot/api/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 131_072,
		});
	});

	it("maps Cline's full reasoning ladder from source metadata", () => {
		const model = sourceModel("kimi-k3");

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			effortMap: {
				minimal: "none",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
		});
	});

	it("uses the Cline wire namespace without exposing it in model selection", () => {
		expect(toClinePassPublicModelId("cline-pass/kimi-k3")).toBe("kimi-k3");
		expect(toClinePassPublicModelId("kimi-k3")).toBe("kimi-k3");
		expect(toClinePassWireModelId("kimi-k3")).toBe("cline-pass/kimi-k3");
		expect(toClinePassWireModelId("cline-pass/kimi-k3")).toBe("cline-pass/kimi-k3");
	});

	it("applies the verified Cline gateway request and reasoning compatibility", () => {
		const model = sourceModel("kimi-k3");
		const compat = buildOpenAICompat(model);

		expect(compat.wireModelIdMode).toBe("cline-pass");
		expect(compat.maxTokensField).toBe("max_completion_tokens");
		expect(compat.thinkingFormat).toBe("openai");
		expect(compat.reasoningDisableMode).toBe("reasoning-effort-none");
		expect(compat.reasoningEffortMap).toEqual({
			minimal: "none",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
		expect(compat.reasoningContentField).toBe("reasoning");
		expect(compat.requiresReasoningContentForToolCalls).toBe(true);
		expect(compat.supportsDeveloperRole).toBe(false);
		expect(compat.supportsStore).toBe(true);
		expect(compat.disableReasoningOnForcedToolChoice).toBe(false);
	});

	it("downgrades forced tools for ClinePass Qwen without requiring reasoning replay", () => {
		const compat = buildOpenAICompat(sourceModel("qwen3.7-max"));

		expect(compat.supportsForcedToolChoice).toBe(false);
		expect(compat.reasoningContentField).toBe("reasoning");
		expect(compat.requiresReasoningContentForToolCalls).toBe(false);
	});

	it("discovers the authoritative public roster and supports new model IDs", async () => {
		const requests: string[] = [];
		const options = clinePassModelManagerOptions({
			fetch: async input => {
				requests.push(String(input));
				return new Response(
					JSON.stringify({
						clinePass: [
							{ id: "cline-pass/kimi-k3", name: "cline-pass/kimi-k3" },
							{ id: " cline-pass/future-model ", name: "cline-pass/future-model" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			},
		});

		expect(options.providerId).toBe("cline-pass");
		expect(options.dynamicModelsAuthoritative).toBe(true);
		expect(options.fetchDynamicModels).toBeFunction();

		const models = await options.fetchDynamicModels?.();
		expect(requests).toEqual(["https://api.cline.bot/api/v1/ai/cline/recommended-models"]);
		expect(models?.map(model => model.id)).toEqual(["kimi-k3", "future-model"]);
		expect(models?.[0]?.maxTokens).toBe(131_072);
		expect(models?.[1]).toMatchObject({
			id: "future-model",
			provider: "cline-pass",
			contextWindow: 128_000,
			maxTokens: 8_192,
			reasoning: true,
			thinking: { mode: "effort" },
		});
	});

	it("rejects an empty or malformed authoritative roster so the bundled fallback remains available", async () => {
		const options = clinePassModelManagerOptions({
			fetch: async () =>
				new Response(
					JSON.stringify({
						clinePass: [
							{ id: "cline-pass/" },
							{ id: "cline-pass/   " },
							{ id: "   " },
							{ id: "other-provider/model" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
		});

		await expect(options.fetchDynamicModels?.()).rejects.toThrow("contains no valid model IDs");
	});
});
