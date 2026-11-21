import { describe, expect, test } from "bun:test";
import { OmpErrors } from "@oh-my-pi/omptype";
import { getModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema-bundle";
import { ModelsConfigSchema } from "@oh-my-pi/pi-coding-agent/config/models-config-schema";

const baseUrl = "https://api.example.invalid/v1";

describe("ModelsConfigSchema tokenizer", () => {
	test("accepts the cl100k tokenizer and rejects an unknown one", () => {
		const config = (tokenizer: string) => ({
			providers: {
				p: {
					baseUrl,
					apiKey: "K",
					models: [{ id: "legacy-test-model", api: "openai-completions" as const, tokenizer }],
				},
			},
		});
		expect(ModelsConfigSchema(config("cl100k"))).not.toBeInstanceOf(OmpErrors);
		expect(getModelsConfigSchema()(config("cl100k"))).not.toBeInstanceOf(OmpErrors);
		expect(ModelsConfigSchema(config("cl200k"))).toBeInstanceOf(OmpErrors);
	});

	test("strips undeclared and legacy compat fields without error", () => {
		const config = {
			providers: {
				ifm: {
					baseUrl,
					apiKey: "K",
					compat: {
						legacyProviderField: true,
					},
					models: [
						{
							id: "m",
							compat: {
								requiresReasoningContentForToolCalls: true,
								requiresReasoningContentForAllAssistantTurns: true,
								reasoningContentField: "reasoning_content",
								supportsStore: false,
							},
						},
					],
				},
			},
		};
		const parsed = ModelsConfigSchema(config);
		expect(parsed).not.toBeInstanceOf(OmpErrors);
		const typed = parsed as typeof config;
		expect(typed.providers.ifm.models[0].compat.supportsStore).toBe(false);
		expect("requiresReasoningContentForToolCalls" in typed.providers.ifm.models[0].compat).toBe(false);
		expect("legacyProviderField" in typed.providers.ifm.compat).toBe(false);
	});
});
