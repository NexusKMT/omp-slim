import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { modularModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

const BASE_URL = "https://api.modular.com/v1";

function buildModular(id: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "modular",
		baseUrl: BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: null,
	});
}

describe("Modular provider discovery", () => {
	test("keeps only live models the models.dev entry lists", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
			return new Response(
				JSON.stringify({
					data: [
						{ id: "MiniMaxAI/MiniMax-M3.1-Flash", object: "model" },
						{ id: "qwen/qwen3.8-27b", object: "model" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		const options = modularModelManagerOptions({ apiKey: "modular-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(calls).toEqual([{ url: `${BASE_URL}/models`, authorization: "Bearer modular-test-key" }]);
		expect(models?.map(model => model.id)).toEqual(["MiniMaxAI/MiniMax-M3.1-Flash"]);
	});
});

describe("Modular capability rules", () => {
	test("MiniMax M3.1 Flash takes a nested reasoning.effort and cannot turn reasoning off", () => {
		const model = buildModular("MiniMaxAI/MiniMax-M3.1-Flash");
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
		expect(model.thinking?.requiresEffort).toBe(true);
		expect(model.compat?.thinkingFormat).toBe("openrouter");
	});

	test("DeepSeek V4.1 Flash toggles thinking.type and sends reasoning_effort", () => {
		const model = buildModular("deepseek/deepseek-v4.1-flash");
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(model.compat?.reasoningDisableMode).toBe("zai-thinking-disabled");
		expect(model.compat?.supportsReasoningEffort).toBe(true);
	});

	test("MiniMax M3 and Gemma 4 toggle reasoning.enabled", () => {
		for (const id of ["minimax/minimax-m3", "google/gemma-4-31b-it"]) {
			const model = buildModular(id);
			expect(model.thinking?.efforts).toEqual([Effort.High]);
			expect(model.compat?.thinkingFormat).toBe("openrouter");
			expect(model.compat?.whenThinking?.extraBody).toEqual({ reasoning: { enabled: true } });
		}
	});
});
