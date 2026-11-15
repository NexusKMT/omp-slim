import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("convertToLlm empty user-interrupted assistant", () => {
	const interrupted: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-fable-5-1",
		usage: emptyUsage(),
		stopReason: "aborted",
		errorMessage: USER_INTERRUPT_LABEL,
		timestamp: 1,
	};
	const requestControls: AssistantMessage["requestControls"] = {
		messageIndex: 0,
		tools: { declared: ["read", "grep"], deferred: [], active: ["read"] },
	};

	it("keeps it with its request controls so the tool control that request sent is replayed", () => {
		const llm = convertToLlm([{ ...interrupted, requestControls }]);
		expect(llm).toHaveLength(1);
		expect(llm[0]?.role === "assistant" && llm[0].requestControls).toEqual(requestControls);
	});

	it("still drops it when its request declared no controls", () => {
		expect(convertToLlm([interrupted])).toEqual([]);
	});
});
