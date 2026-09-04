// Same-model tool-call ids are opaque provider correlation tokens and must
// round-trip verbatim on the anthropic-messages send path: a custom
// `api: anthropic-messages` proxy fronting Gemini encodes the thought
// signature in the id, so enforcing Anthropic's `^[a-zA-Z0-9_-]{1,64}$` rule
// unconditionally breaks the round-trip (#10753). Cross-model (foreign-origin)
// ids still get sanitized to a valid Anthropic id, mirroring the same-model
// opaque-id preservation already done for openai-completions (#8642) and
// openai-responses (#10749).
import { describe, expect, it } from "bun:test";
import { transformMessages } from "@oh-my-pi/pi-ai/providers/transform-messages";
import type { AssistantMessage, Message, Model, ModelSpec, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const ANTHROPIC_TOOL_CALL_ID = /^[a-zA-Z0-9_-]{1,64}$/;

// A Gemini-over-anthropic-messages id: exceeds 64 chars and carries `/` and `=`,
// none of which Anthropic's id charset permits.
const GEMINI_ID = `call_abc123/thoughtSignature=CiQBxY9z${"a".repeat(80)}==`;

function makeModel(): Model<"anthropic-messages"> {
	return buildModel({
		api: "anthropic-messages",
		provider: "custom-gemini",
		id: "gemini-3-pro",
		name: "Gemini via anthropic-messages proxy",
		baseUrl: "https://proxy.example.com/anthropic",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 8_192,
		contextWindow: 1_000_000,
		reasoning: true,
	} as ModelSpec<"anthropic-messages">);
}

function assistantWithCall(id: string, source: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "get_weather", arguments: { location: "Paris" } }],
		api: "anthropic-messages",
		provider: "custom-gemini",
		model: "gemini-3-pro",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
		...source,
	};
}

function toolResult(id: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "get_weather",
		content: [{ type: "text", text: "15C" }],
		isError: false,
		timestamp: 0,
	} as ToolResultMessage;
}

function emittedIds(messages: Message[], model: Model<"anthropic-messages">) {
	const transformed = transformMessages(messages, model);
	const callId = transformed
		.filter((m): m is AssistantMessage => m.role === "assistant")
		.flatMap(m => m.content)
		.find(b => b.type === "toolCall") as { id: string } | undefined;
	const resultId = transformed.find((m): m is ToolResultMessage => m.role === "toolResult")?.toolCallId;
	return { callId: callId?.id, resultId };
}

describe("anthropic-messages tool-call id normalization", () => {
	it("round-trips a same-model opaque id verbatim, keeping call/result paired", () => {
		const model = makeModel();
		const messages: Message[] = [
			{ role: "user", content: "weather?", timestamp: 0 },
			assistantWithCall(GEMINI_ID, { provider: "custom-gemini", model: "gemini-3-pro" }),
			toolResult(GEMINI_ID),
		];

		const { callId, resultId } = emittedIds(messages, model);

		expect(callId).toBe(GEMINI_ID);
		expect(resultId).toBe(GEMINI_ID);
	});

	it("sanitizes a foreign-origin id to a valid Anthropic id on cross-model replay", () => {
		const model = makeModel();
		const messages: Message[] = [
			{ role: "user", content: "weather?", timestamp: 0 },
			// Different provider/model than the target: the id is not the target's
			// own correlation token, so it must be normalized to Anthropic's charset.
			assistantWithCall(GEMINI_ID, { provider: "openai", model: "gpt-4", api: "anthropic-messages" }),
			toolResult(GEMINI_ID),
		];

		const { callId, resultId } = emittedIds(messages, model);

		expect(callId).not.toBe(GEMINI_ID);
		expect(callId).toMatch(ANTHROPIC_TOOL_CALL_ID);
		// The result must follow the call onto the sanitized id.
		expect(resultId).toBe(callId);
	});
});
