import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getTestModel as getBundledModel } from "../../catalog/test/fixtures/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChainJudge, hasNativeJudge } from "@oh-my-pi/pi-coding-agent/judgment";

const CURRENT = getBundledModel("anthropic", "claude-sonnet-4-6")!;
const request = {
	state: "refactor the scheduler",
	questions: {
		level: { type: "choice" as const, instructions: "Choose effort", criteria: { low: "simple", high: "complex" } },
	},
};
function registry(): ModelRegistry {
	return {
		getAvailable: () => {
			throw new Error("unexpected model discovery");
		},
		getApiKey: async () => "test-key",
		resolver: () => async () => "test-key",
	} as unknown as ModelRegistry;
}
function reply(model: Model<Api>, text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 3,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 4,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("current-model judgments", () => {
	it("preserves the exact current model and accounts for its explicit judgment", async () => {
		const current = { ...CURRENT, baseUrl: "https://current.example/v1" };
		const onUsage = vi.fn();
		const spy = vi.spyOn(ai, "completeSimple").mockImplementation(async (model, _context, options) => {
			const response = reply(model, "level: high");
			options?.onAttempt?.(response);
			return response;
		});
		const judge = new ChainJudge({
			settings: Settings.isolated({}),
			registry: registry(),
			sessionModel: current,
			purpose: "eval",
			onUsage,
		});
		const result = await judge.judge(request);
		expect(result.answers.level.choice).toBe("high");
		expect(judge.primaryModel()).toBe(current);
		expect(spy.mock.calls[0]?.[0]).toBe(current);
		expect(spy.mock.calls[0]?.[2]?.disableServerSideFallback).toBe(true);
		expect(onUsage).toHaveBeenCalledTimes(1);
		expect(onUsage).toHaveBeenCalledWith(
			expect.objectContaining({ role: "default", provider: current.provider, model: current.id }),
		);
	});

	it("never discovers a native or local auxiliary judge", async () => {
		const models = registry();
		const settings = Settings.isolated({});
		expect(hasNativeJudge(settings, models)).toBe(false);
		await expect(new ChainJudge({ settings, registry: models, purpose: "eval" }).judge(request)).rejects.toThrow(
			"no current chat model",
		);
	});

	it("reports the current model failure without switching to a different model", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("current model unavailable"));
		const judge = new ChainJudge({
			settings: Settings.isolated({}),
			registry: registry(),
			sessionModel: CURRENT,
			purpose: "eval",
		});
		await expect(judge.judge(request)).rejects.toThrow("current model unavailable");
		expect(spy.mock.calls.every(call => call[0] === CURRENT)).toBe(true);
	});

	it("rejects images when the current model cannot accept them instead of selecting a vision model", async () => {
		const spy = vi.spyOn(ai, "completeSimple");
		const current: Model<Api> = { ...CURRENT, input: ["text"] };
		const judge = new ChainJudge({
			settings: Settings.isolated({}),
			registry: registry(),
			sessionModel: current,
			purpose: "eval",
		});
		await expect(
			judge.judge({ ...request, images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] }),
		).rejects.toThrow("current model does not support images");
		expect(spy).not.toHaveBeenCalled();
	});

	it("rejects non-chat current models without opening a native judgment transport", async () => {
		const current: Model<Api> = { ...CURRENT, kind: "judge", api: "typesafe" };
		const judge = new ChainJudge({
			settings: Settings.isolated({}),
			registry: registry(),
			sessionModel: current,
			purpose: "eval",
		});
		await expect(judge.judge(request)).rejects.toThrow("no current chat model");
	});
});
