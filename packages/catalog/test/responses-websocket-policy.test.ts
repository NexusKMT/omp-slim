import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveCatalogPolicy } from "@oh-my-pi/pi-catalog/compat/catalog-policy";
import { resolveResponsesWebSocketPreference } from "@oh-my-pi/pi-catalog/compat/responses-websocket";
import type { Api, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function responsesModel(overrides: Partial<ModelSpec<Api>> = {}) {
	return buildModel({
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
		...overrides,
	});
}

describe("standard Responses WebSocket catalog policy", () => {
	test("uses the real OpenAI Responses rule without materializing it as a model preference", () => {
		const model = responsesModel();
		expect(resolveCatalogPolicy(model).preferWebsockets).toBe(true);
		expect(model.preferWebsockets).toBeUndefined();
		expect(resolveResponsesWebSocketPreference(model)).toBe(true);
	});

	test("defaults gateways and non-HTTPS endpoints to HTTP while allowing explicit gateway opt-in", () => {
		for (const baseUrl of ["https://gateway.example/v1", "http://api.openai.com/v1", "http://127.0.0.1:1234/v1"]) {
			const model = responsesModel({ baseUrl });
			expect(resolveResponsesWebSocketPreference(model)).toBe(false);
			expect(resolveResponsesWebSocketPreference(model, true)).toBe(true);
			expect(resolveResponsesWebSocketPreference(responsesModel({ baseUrl, preferWebsockets: true }))).toBe(true);
		}
	});

	test("honors request then model then endpoint preference, including explicit false", () => {
		for (const baseUrl of ["https://api.openai.com/v1", "https://gateway.example/v1"]) {
			for (const modelPreference of [undefined, false, true]) {
				const model = responsesModel({ baseUrl, preferWebsockets: modelPreference });
				expect(resolveResponsesWebSocketPreference(model)).toBe(
					modelPreference ?? baseUrl === "https://api.openai.com/v1",
				);
				expect(resolveResponsesWebSocketPreference(model, false)).toBe(false);
				expect(resolveResponsesWebSocketPreference(model, true)).toBe(true);
			}
		}
	});

	test("cannot opt providers or APIs without an enabling rule into WebSockets", () => {
		for (const overrides of [
			{ provider: "unknown-gateway" },
			{ provider: "github-copilot" },
			{ provider: "openrouter" },
			{ provider: "openrouter", api: "openrouter" },
			{ api: "openai-completions" },
			{ api: "openai-codex-responses" },
		] satisfies Partial<ModelSpec<Api>>[]) {
			const model = responsesModel({ ...overrides, preferWebsockets: true });
			expect(resolveCatalogPolicy(model).preferWebsockets).toBeUndefined();
			expect(resolveResponsesWebSocketPreference(model)).toBe(false);
			expect(resolveResponsesWebSocketPreference(model, true)).toBe(false);
		}
	});

	test("inherits providerType policy only in its declared API scope", () => {
		const gateway = responsesModel({
			provider: "custom-openai",
			providerType: "openai",
			baseUrl: "https://gateway.example/v1",
		});
		expect(resolveCatalogPolicy(gateway).preferWebsockets).toBe(true);
		expect(resolveResponsesWebSocketPreference(gateway)).toBe(false);
		expect(resolveResponsesWebSocketPreference(gateway, true)).toBe(true);
		expect(resolveResponsesWebSocketPreference({ ...gateway, preferWebsockets: true })).toBe(true);
		for (const api of ["openai-completions", "openai-codex-responses"] as const) {
			const model = responsesModel({ provider: gateway.provider, providerType: gateway.providerType, api });
			expect(resolveResponsesWebSocketPreference(model, true)).toBe(false);
		}
		const unrelated = responsesModel({ provider: "custom-copilot", providerType: "github-copilot" });
		expect(resolveResponsesWebSocketPreference(unrelated, true)).toBe(false);
	});
});
