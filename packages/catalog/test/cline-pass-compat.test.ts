import { describe, expect, it } from "bun:test";
import { toClinePassPublicModelId, toClinePassWireModelId } from "@oh-my-pi/pi-catalog/cline-pass-model-id";
import { buildOpenAICompat } from "@oh-my-pi/pi-catalog/compat/openai";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { clinePassModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

describe("ClinePass catalog", () => {
	it("bundles an offline subscription fallback under stable public IDs", () => {
		const models = getBundledModels("cline-pass");

		expect(models.map(model => model.id)).toEqual([
			"deepseek-v4-flash",
			"deepseek-v4-pro",
			"glm-5.2",
			"kimi-k2.6",
			"kimi-k2.7-code",
			"kimi-k3",
			"mimo-v2.5",
			"mimo-v2.5-pro",
			"minimax-m3",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.8-max",
		]);
		expect(DEFAULT_MODEL_PER_PROVIDER["cline-pass"]).toBe("kimi-k3");
		expect(models.every(model => model.cost.input === 0 && model.cost.output === 0)).toBe(true);
	});

	it("preserves Cline's full reasoning ladder and published Kimi K3 limits", () => {
		const model = getBundledModel<"openai-completions">("cline-pass", "kimi-k3");

		expect(model.contextWindow).toBe(1_048_576);
		expect(model.maxTokens).toBe(131_072);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.thinking?.mode).toBe("effort");
		expect(model.thinking?.efforts).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
		expect(model.thinking?.defaultLevel).toBe(Effort.Max);
	});

	it("uses the Cline wire namespace without exposing it in model selection", () => {
		expect(toClinePassPublicModelId("cline-pass/kimi-k3")).toBe("kimi-k3");
		expect(toClinePassPublicModelId("kimi-k3")).toBe("kimi-k3");
		expect(toClinePassWireModelId("kimi-k3")).toBe("cline-pass/kimi-k3");
		expect(toClinePassWireModelId("cline-pass/kimi-k3")).toBe("cline-pass/kimi-k3");
	});

	it("applies the verified Cline gateway request and reasoning compatibility", () => {
		const model = getBundledModel<"openai-completions">("cline-pass", "kimi-k3");
		const compat = buildOpenAICompat(toModelSpec(model));

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

	it("discovers the authoritative roster without credentials and supports new model IDs", async () => {
		const requests: string[] = [];
		const options = clinePassModelManagerOptions({
			fetch: async input => {
				requests.push(String(input));
				return new Response(
					JSON.stringify({
						clinePass: [
							{ id: "cline-pass/kimi-k3", name: "cline-pass/kimi-k3" },
							{ id: "cline-pass/future-model", name: "cline-pass/future-model" },
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

	it("rejects an empty authoritative roster so the bundled fallback remains available", async () => {
		const options = clinePassModelManagerOptions({
			fetch: async () =>
				new Response(JSON.stringify({ clinePass: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		});

		await expect(options.fetchDynamicModels?.()).rejects.toThrow("contains no valid model IDs");
	});
});
