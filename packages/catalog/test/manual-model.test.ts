import { describe, expect, it } from "bun:test";
import { buildModel } from "../src/build";
import { Effort } from "../src/effort";
import { clampThinkingLevelForModel, defaultSupportedEffort, getSupportedEfforts } from "../src/model-thinking";
import { calculateUsageCost, getModelPricingStatus, getTimeBasedPricingPeriod } from "../src/models";
import type { Usage } from "../src/types";

const endpoint = { id: "my-model", provider: "my-endpoint", baseUrl: "http://127.0.0.1:9999/v1" };

function usage(input: number): Usage {
	return {
		input,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("manual Chat Completions models", () => {
	it("defaults only generic capabilities and never looks up a model name", () => {
		const model = buildModel({ ...endpoint, provider: "anthropic", id: "claude-sonnet-4-5" });
		expect(model.api).toBe("openai-completions");
		expect(model.baseUrl).toBe(endpoint.baseUrl);
		expect(model.reasoning).toBe(false);
		expect(model.thinking).toBeUndefined();
		expect(model.identity).toEqual({ class: "unknown" });
		expect(getModelPricingStatus(model)).toBe("unknown");
	});
	it("rejects retired protocols without rewriting them", () => {
		for (const api of ["openai-responses", "anthropic-messages", "ollama-chat", "pi-native", "custom"]) {
			expect(() => buildModel({ ...endpoint, api })).toThrow(/supports only "openai-completions"/);
		}
	});
	it("preserves the configured endpoint, headers and dynamic header resolver", () => {
		const headers = { "x-endpoint": "custom" };
		const resolveHeaders = async () => ({ "x-dynamic": "resolved" });
		const model = buildModel({ ...endpoint, headers, resolveHeaders, compat: { maxTokensField: "max_tokens" } });
		expect(model.baseUrl).toBe(endpoint.baseUrl);
		expect(model.headers).toBe(headers);
		expect(model.resolveHeaders).toBe(resolveHeaders);
		expect(model.compat.maxTokensField).toBe("max_tokens");
	});
	it("uses only explicitly declared thinking efforts", () => {
		const model = buildModel({
			...endpoint,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.High], defaultLevel: Effort.High },
		});
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.High]);
		expect(defaultSupportedEffort(model)).toBe(Effort.High);
		expect(clampThinkingLevelForModel(model, Effort.Medium)).toBe(Effort.Low);
	});
	it("validates endpoint and context metadata before dispatch", () => {
		expect(() => buildModel({ ...endpoint, baseUrl: "file:///tmp/model" })).toThrow(/HTTP/);
		expect(() => buildModel({ ...endpoint, maxTokens: 0 })).toThrow(/maxTokens/);
		expect(() => buildModel({ ...endpoint, contextWindow: 4096, maxContextWindow: 1024 })).toThrow(
			/maxContextWindow/,
		);
		expect(buildModel({ ...endpoint, contextWindow: null }).contextWindow).toBeNull();
	});
	it("retains explicit context pricing boundaries", () => {
		const cost = {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			longContext: { inputThreshold: 100, input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
		};
		expect(calculateUsageCost(cost, usage(100)).input).toBeCloseTo(0.0001, 10);
		expect(calculateUsageCost(cost, usage(101)).input).toBeCloseTo(0.000303, 10);
	});
	it("retains authored time-based rates for historical usage accounting", () => {
		const cost = {
			input: 2,
			output: 4,
			cacheRead: 0,
			cacheWrite: 0,
			timeBased: { offPeakMultiplier: 0.5, peakWindows: [{ weekdays: [1], startMinute: 60, endMinute: 120 }] },
		};
		const monday = Date.parse("2026-09-07T00:00:00Z");
		expect(getTimeBasedPricingPeriod(cost, monday + 60 * 60_000)).toBe("peak");
		expect(getTimeBasedPricingPeriod(cost, monday + 120 * 60_000)).toBe("off-peak");
		expect(calculateUsageCost(cost, usage(1_000_000), monday).input).toBe(1);
	});
});
