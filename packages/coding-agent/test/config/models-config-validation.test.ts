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
					models: [{ id: "legacy-gpt-4", api: "openai-completions" as const, tokenizer }],
				},
			},
		});
		expect(ModelsConfigSchema(config("cl100k"))).not.toBeInstanceOf(OmpErrors);
		expect(getModelsConfigSchema()(config("cl100k"))).not.toBeInstanceOf(OmpErrors);
		expect(ModelsConfigSchema(config("cl200k"))).toBeInstanceOf(OmpErrors);
	});
});
