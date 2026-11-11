import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { parseModelPattern, resolveCliModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";

// Literal slashes belong to the configured model ID unless an explicit provider/model pair matches.

const customProxyOpus = buildModel({
	id: "anthropic/claude-opus-5",
	name: "Claude Opus 5 (Custom Proxy)",
	api: "openai-completions",
	provider: "my-proxy",
	baseUrl: "https://proxy.example.com/v1",
	reasoning: true,
	thinking: {
		mode: "effort",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
	},
	input: ["text", "image"],
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	contextWindow: 200000,
	maxTokens: 32000,
});

const openRouterOpus = buildModel({
	id: "anthropic/claude-opus-5",
	name: "Claude Opus 5 (OpenRouter)",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	thinking: {
		mode: "effort",
		efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
	},
	input: ["text", "image"],
	cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	contextWindow: 200000,
	maxTokens: 32000,
});

describe("custom provider model ids containing a slash (#8800)", () => {
	test("a custom provider's literal slash id resolves to the custom provider", () => {
		const result = parseModelPattern("anthropic/claude-opus-5", [customProxyOpus]);
		expect(result.model?.provider).toBe("my-proxy");
		expect(result.model?.id).toBe("anthropic/claude-opus-5");
	});

	test("resolveCliModel routes the slash id to the custom provider", () => {
		const result = resolveCliModel({
			cliModel: "anthropic/claude-opus-5",
			modelRegistry: {
				getAll: () => [customProxyOpus],
				getAvailable: () => [customProxyOpus],
			},
		});
		expect(result.model?.provider).toBe("my-proxy");
		expect(result.model?.id).toBe("anthropic/claude-opus-5");
		expect(result.error).toBeUndefined();
	});

	test("provider names never imply an unconfigured catalog", () => {
		const result = parseModelPattern("anthropic/claude-opus-5", [openRouterOpus]);
		expect(result.model).toBe(openRouterOpus);
	});

	test("an explicit custom-provider reference keeps working", () => {
		const result = parseModelPattern("my-proxy/anthropic/claude-opus-5", [customProxyOpus]);
		expect(result.model?.provider).toBe("my-proxy");
		expect(result.model?.id).toBe("anthropic/claude-opus-5");
	});
});
