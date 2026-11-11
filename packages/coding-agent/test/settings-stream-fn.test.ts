/** Session limits and watchdogs must reach Chat Completions while caller options retain precedence. */
import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsAwareStreamFn } from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { getTestModel } from "../../catalog/test/fixtures/models";

function captureBase(): { fn: StreamFn; calls: Array<{ model: Model; options?: SimpleStreamOptions }> } {
	const calls: Array<{ model: Model; options?: SimpleStreamOptions }> = [];
	const fn: StreamFn = (model, _context, options) => {
		calls.push({ model, options });
		return new AssistantMessageEventStream();
	};
	return { fn, calls };
}

const stubModel = getTestModel("endpoint", "primary");
const stubContext: Context = { messages: [], tools: [], systemPrompt: [] };

describe("createSettingsAwareStreamFn", () => {
	it("applies provider settings to the forwarded options when caller omits them", () => {
		const settings = Settings.isolated({
			"providers.maxInFlightRequests": { endpoint: 4 },
			"loopGuard.enabled": true,
			"loopGuard.checkAssistantContent": true,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, { apiKey: "k" });

		const options = calls[0]?.options;
		expect(options?.maxInFlightRequests).toEqual({ endpoint: 4 });
		expect(options?.loopGuard).toEqual({ enabled: true, checkAssistantContent: true });
		// caller's own option is preserved
		expect(options?.apiKey).toBe("k");
	});
	it("forwards configured hidden thinking summaries", () => {
		const settings = Settings.isolated({ omitThinking: true });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);

		expect(calls[0]?.options?.hideThinkingSummary).toBe(true);
	});
	it("forwards configured stream watchdog budgets while preserving caller overrides", () => {
		const settings = Settings.isolated({
			"providers.streamFirstEventTimeoutSeconds": 600,
			"providers.streamIdleTimeoutSeconds": 300,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);
		wrapped(stubModel, stubContext, {
			streamFirstEventTimeoutMs: 15_000,
			streamIdleTimeoutMs: 10_000,
		});

		expect(calls[0]?.options?.streamFirstEventTimeoutMs).toBe(600_000);
		expect(calls[0]?.options?.streamIdleTimeoutMs).toBe(300_000);
		expect(calls[1]?.options?.streamFirstEventTimeoutMs).toBe(15_000);
		expect(calls[1]?.options?.streamIdleTimeoutMs).toBe(10_000);
	});
	it("forwards retry.maxDelayMs while preserving caller overrides", () => {
		const settings = Settings.isolated({ "retry.maxDelayMs": 300_000 });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);
		wrapped(stubModel, stubContext, { maxRetryDelayMs: 5_000 });

		expect(calls[0]?.options?.maxRetryDelayMs).toBe(300_000);
		expect(calls[1]?.options?.maxRetryDelayMs).toBe(5_000);
	});
	it("lets caller-supplied options override the session settings", () => {
		const settings = Settings.isolated({
			"providers.maxInFlightRequests": { endpoint: 4 },
			"loopGuard.enabled": true,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, {
			maxInFlightRequests: { endpoint: 1 },
			loopGuard: { enabled: false },
			hideThinkingSummary: false,
		});

		const options = calls[0]?.options;
		expect(options?.maxInFlightRequests).toEqual({ endpoint: 1 });
		// Loop guard merges per-field: caller wins on `enabled`, settings fill
		// the rest (the inline closure the main agent used has the same shape).
		expect(options?.loopGuard?.enabled).toBe(false);
		expect(options?.loopGuard?.checkAssistantContent).toBe(true);
		expect(options?.hideThinkingSummary).toBe(false);
	});
	it("lowers the output cap so prompt plus output fits the model's context window", () => {
		// The reported DeepSeek /btw 400: a 666k-token prompt plus the model's
		// 384k default output cap exceeded the window. Test-env counts are bytes/4.
		const largeOutputModel: Model = {
			...stubModel,
			contextWindow: 1_000_000,
			maxTokens: 384_000,
		};
		const promptTokens = 666_387;
		const context = {
			messages: [{ role: "user", content: "x".repeat(promptTokens * 4), timestamp: 0 }],
		} as unknown as Context;
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(Settings.isolated({}), base);

		wrapped(largeOutputModel, context, { apiKey: "k" });
		wrapped(largeOutputModel, stubContext, { apiKey: "k" });

		const fitted = calls[0]?.options?.maxTokens;
		expect(fitted).toBeGreaterThan(0);
		expect(promptTokens + (fitted ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(1_000_000);
		// A prompt that leaves room keeps the transport's own default.
		expect(calls[1]?.options?.maxTokens).toBeUndefined();
	});

	it("uses the current model object and its context window after a manual switch", () => {
		const initial = getTestModel("endpoint", "primary", { contextWindow: 100_000, maxTokens: 9_000 });
		const current = { ...initial, baseUrl: "https://temporary.example.invalid/v1", contextWindow: 10_000 };
		const context: Context = { messages: [{ role: "user", content: "x".repeat(28_000), timestamp: 0 }] };
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(Settings.isolated({}), base);
		wrapped(initial, context, { maxTokens: 9_000 });
		wrapped(current, context, { maxTokens: 9_000 });
		expect(calls[0]?.options?.maxTokens).toBe(9_000);
		expect(calls[1]?.model).toBe(current);
		expect(calls[1]?.options?.maxTokens).toBeLessThan(9_000);
		expect(calls[1]?.options?.maxTokens).toBeGreaterThan(0);
	});
});
