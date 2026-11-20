import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-ai/build";
import {
	resolveCliModel,
	resolveModelFromString,
	resolveModelValue,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { describe, expect, test } from "bun:test";

function model(provider: string, id: string): Model {
	return buildModel({
		provider,
		id,
		name: `${provider}/${id}`,
		api: "openai-completions",
		baseUrl: `https://${provider}.example.com`,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

describe("issue #980 provider-qualified model resolution", () => {
	test("prefers the explicit anthropic provider when the exact pair exists", () => {
		const availableModels = [model("amazon-bedrock", "claude-3-7-sonnet"), model("anthropic", "claude-3-7-sonnet")];
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/claude-3-7-sonnet" },
		});

		const resolved = resolveModelFromString(settings.getModel()!, availableModels);
		expect(resolved?.provider).toBe("anthropic");
		expect(resolved?.id).toBe("claude-3-7-sonnet");
	});

	test("does not silently fall back to bedrock when a provider-qualified role misses", () => {
		const availableModels = [model("amazon-bedrock", "claude-3-7-sonnet"), model("anthropic", "claude-sonnet-4-5")];
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/claude-3-7-sonnet" },
		});

		const roleValue = settings.getModel();
		const roleResolved = resolveModelValue(roleValue, availableModels, { settings });
		expect(roleResolved.model).toBeUndefined();

		const settingsResolved = resolveModelFromString(settings.getModel()!, availableModels);
		expect(settingsResolved).toBeUndefined();

		const cliResolved = resolveCliModel({
			cliModel: "anthropic/claude-3-7-sonnet",
			modelRegistry: {
				getAll: () => availableModels,
				getAvailable: () => availableModels,
			},
		});
		expect(cliResolved.model).toBeUndefined();
		expect(cliResolved.error).toBe(
			'Model "anthropic/claude-3-7-sonnet" is not configured. Configure the endpoint baseUrl, apiKey and model id in models.yml.',
		);
	});
});
