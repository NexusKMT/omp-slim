import { describe, expect, test } from "bun:test";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { BEDROCK_MANTLE_STATIC_MODELS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { dropBedrockMantleOpenAIModels } from "../scripts/generated-policies";

const MANTLE_MODEL_IDS = [
	"openai.gpt-5.4",
	"openai.gpt-5.5",
	"openai.gpt-5.6-luna",
	"openai.gpt-5.6-sol",
	"openai.gpt-5.6-terra",
];

function bedrockModel(provider: string, id: string): ModelSpec<"bedrock-converse-stream"> {
	return {
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider,
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	};
}

describe("Amazon Bedrock OpenAI routing", () => {
	test("seeds Responses-only models under the Bedrock Mantle provider", () => {
		expect(BEDROCK_MANTLE_STATIC_MODELS.map(model => model.id)).toEqual(MANTLE_MODEL_IDS);
		for (const model of BEDROCK_MANTLE_STATIC_MODELS) {
			expect(model.provider).toBe("bedrock-mantle");
			expect(model.api).toBe("openai-responses");
			expect(model.baseUrl).toBe("https://bedrock-mantle.{region}.api.aws/openai/v1");
		}
		expect(DEFAULT_MODEL_PER_PROVIDER["bedrock-mantle"]).toBe("openai.gpt-5.6-terra");
	});

	test("drops only the unusable Converse rows for Mantle models", () => {
		const input = [
			...MANTLE_MODEL_IDS.map(id => bedrockModel("amazon-bedrock", id)),
			bedrockModel("amazon-bedrock", "openai.gpt-oss-120b"),
			bedrockModel("bedrock-mantle", "openai.gpt-5.6-sol"),
		];

		expect(dropBedrockMantleOpenAIModels(input).map(model => `${model.provider}/${model.id}`)).toEqual([
			"amazon-bedrock/openai.gpt-oss-120b",
			"bedrock-mantle/openai.gpt-5.6-sol",
		]);
	});
});
