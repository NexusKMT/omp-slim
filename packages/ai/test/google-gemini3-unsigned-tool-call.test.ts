import { describe, expect, it } from "bun:test";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/google-shared";
import type { Context, Model, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Regression for #9638: a Gemini 3 turn with parallel tool calls carries a
// thought signature only on the FIRST call. `convertMessages` used to substitute
// the `skip_thought_signature_validator` sentinel for the unsigned calls, which
// the public Gemini API accepts but Cloud Code Assist / Antigravity (and Vertex)
// reject with 400 INVALID_ARGUMENT. Because the offending turn is baked into the
// session history, every subsequent request replayed it and 400'd deterministically,
// permanently wedging the session. Unsigned Gemini 3 tool calls must now omit the
// field entirely instead of emitting the sentinel.

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const VALID_SIGNATURE = "QUJDRA==";
const SENTINEL = "skip_thought_signature_validator";

function buildGeminiModel(
	api: "google-generative-ai" | "google-gemini-cli",
	provider: string,
	id: string,
): Model<typeof api> {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65536,
	});
}

/** One assistant turn with three parallel tool calls; only the first is signed. */
function parallelToolCallContext(
	api: "google-generative-ai" | "google-gemini-cli",
	provider: string,
	id: string,
): Context {
	return {
		messages: [
			{ role: "user", content: "Optimize the code", timestamp: 1000 },
			{
				role: "assistant",
				provider,
				api,
				model: id,
				content: [
					{
						type: "toolCall",
						id: "call_1",
						name: "todo",
						arguments: { op: "init" },
						thoughtSignature: VALID_SIGNATURE,
					},
					{ type: "toolCall", id: "call_2", name: "grep", arguments: { pattern: "helperExec" } },
					{ type: "toolCall", id: "call_3", name: "grep", arguments: { pattern: "shift" } },
				],
				usage: ZERO_USAGE,
				stopReason: "toolUse",
				timestamp: 2000,
			},
		],
	};
}

function modelToolCallParts(model: Model<"google-generative-ai" | "google-gemini-cli">, context: Context) {
	const contents = convertMessages(model, context);
	const modelTurn = contents.find(c => c.role === "model");
	return modelTurn?.parts?.filter(part => part.functionCall) ?? [];
}

describe("Gemini 3 unsigned parallel tool calls (#9638)", () => {
	it("omits the signature on unsigned Antigravity/CCA calls instead of the rejected sentinel", () => {
		const model = buildGeminiModel("google-gemini-cli", "google-antigravity", "gemini-3.7-flash");
		const context = parallelToolCallContext("google-gemini-cli", "google-antigravity", "gemini-3.7-flash");
		const calls = modelToolCallParts(model, context);

		expect(calls).toHaveLength(3);
		expect(calls[0]?.thoughtSignature).toBe(VALID_SIGNATURE);
		expect(calls[1]?.thoughtSignature).toBeUndefined();
		expect(calls[2]?.thoughtSignature).toBeUndefined();
		// The sentinel is what CCA rejects with 400 INVALID_ARGUMENT — it must never reach the wire.
		expect(JSON.stringify(convertMessages(model, context))).not.toContain(SENTINEL);
	});

	it("also omits the sentinel on the public Gemini API path", () => {
		const model = buildGeminiModel("google-generative-ai", "google", "gemini-3-flash");
		const context = parallelToolCallContext("google-generative-ai", "google", "gemini-3-flash");
		const calls = modelToolCallParts(model, context);

		expect(calls).toHaveLength(3);
		expect(calls[0]?.thoughtSignature).toBe(VALID_SIGNATURE);
		expect(calls[1]?.thoughtSignature).toBeUndefined();
		expect(calls[2]?.thoughtSignature).toBeUndefined();
	});
});
