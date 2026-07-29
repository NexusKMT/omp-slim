import { afterEach, describe, expect, test, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { generateSummary, MAX_SUMMARY_TOKENS } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function getModel(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
	return model;
}

const messages: AgentMessage[] = [
	{ role: "user", content: "start work", timestamp: 1 },
	createAssistantMessage("started"),
];

afterEach(() => {
	vi.restoreAllMocks();
});

describe("compaction summary output budget", () => {
	test("caps the summary budget for large reserves", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("summary"));
		// A 1M-token window yields a 150k reserve, which used to authorize a ~120k-token summary.
		await generateSummary(messages, getModel(), 150_000, "test-key");
		expect(spy.mock.calls[0]?.[2]?.maxTokens).toBe(MAX_SUMMARY_TOKENS);
	});

	test("leaves a reserve smaller than the cap proportional", async () => {
		const spy = vi.spyOn(ai, "completeSimple").mockResolvedValue(createAssistantMessage("summary"));
		await generateSummary(messages, getModel(), 10_000, "test-key");
		expect(spy.mock.calls[0]?.[2]?.maxTokens).toBe(8_000);
	});
});
