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
		provider: parts.provider ?? "custom",
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
	it("reports a different response id with its configured endpoint", () => {
		expect(
			detectServedModelMismatch(
				turn({
					model: "requested-main",
					served: "served-snapshot",
					upstreamProvider: "reported-host",
				}),
			),
		).toEqual({
			requested: "requested-main",
			served: "served-snapshot",
			provider: "custom",
			upstreamProvider: "reported-host",
		});
	});

	it("reports a different version id", () => {
		expect(detectServedModelMismatch(turn({ model: "model-v1", served: "model-v2" }))?.served).toBe("model-v2");
	});

	it("does not guess that a configured alias and response snapshot are equivalent", () => {
		expect(detectServedModelMismatch(turn({ model: "configured-alias", served: "served-snapshot" }))).toBeDefined();
	});

	it("reports opaque response ids without a provider catalogue", () => {
		expect(
			detectServedModelMismatch(turn({ model: "model-v1", served: "internal-snapshot-id", provider: "custom" })),
		).toBeDefined();
	});

	it("stays silent when no served id was recovered", () => {
		expect(detectServedModelMismatch(turn({ model: "main-model" }))).toBeUndefined();
	});
});

describe("ServedModelTracker", () => {
	it("reports each substitution pair once, and a new pair after a model switch", () => {
		const tracker = new ServedModelTracker();
		const swapped = turn({ model: "model-a", served: "model-b" });
		expect(tracker.check(swapped)).toBeDefined();
		expect(tracker.check(swapped)).toBeUndefined();
		expect(tracker.check(turn({ model: "model-a", served: "model-a" }))).toBeUndefined();
		expect(tracker.check(turn({ model: "model-c", served: "model-b" }))?.requested).toBe("model-c");
		expect(tracker.check(swapped)).toBeUndefined();
	});
});
