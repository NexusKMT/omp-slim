import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";
import { detectServedModelMismatch, ServedModelTracker } from "@oh-my-pi/pi-tui/chat/served-model-marker";

function turn(parts: {
	model: string;
	served?: string;
	provider?: string;
	upstreamProvider?: string;
}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: parts.provider ?? "test",
		model: parts.model,
		...(parts.served ? { upstreamModel: parts.served } : {}),
		...(parts.upstreamProvider ? { upstreamProvider: parts.upstreamProvider } : {}),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("detectServedModelMismatch", () => {
	it("flags a different family served under the requested id, naming the route", () => {
		expect(
			detectServedModelMismatch(
				turn({
					model: "test/test-model",
					served: "test-model-2",
					upstreamProvider: "Test Provider",
				}),
			),
		).toEqual({
			requested: "test/test-model",
			served: "test-model-2",
			provider: "test",
			upstreamProvider: "Test Provider",
		});
	});

	it("flags a different revision of the same family", () => {
		expect(detectServedModelMismatch(turn({ model: "test-model", served: "test-model-2" }))?.served).toBe(
			"test-model-2",
		);
	});

	it("stays silent when no served id was recovered", () => {
		expect(detectServedModelMismatch(turn({ model: "test-model" }))).toBeUndefined();
	});
});

describe("ServedModelTracker", () => {
	it("reports each substitution pair once, and a new pair after a model switch", () => {
		const tracker = new ServedModelTracker();
		const swapped = turn({ model: "test-model", served: "test-model-2" });
		expect(tracker.check(swapped)).toBeDefined();
		expect(tracker.check(swapped)).toBeUndefined();
		expect(tracker.check(turn({ model: "test-model", served: "test-model" }))).toBeUndefined();
		expect(tracker.check(turn({ model: "test-model-3", served: "test-model-2" }))?.requested).toBe(
			"test-model-3",
		);
		expect(tracker.check(swapped)).toBeUndefined();
	});
});
