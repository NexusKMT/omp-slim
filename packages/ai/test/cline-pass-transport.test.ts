import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const markerTool: Tool = {
	name: "get_marker",
	description: "Return a marker",
	parameters: {
		type: "object",
		properties: { value: { type: "number" } },
		required: ["value"],
	} as Tool["parameters"],
};

const context: Context = {
	systemPrompt: ["Use the provided tool."],
	messages: [{ role: "user", content: "Get marker 42", timestamp: 0 }],
	tools: [markerTool],
};

function completionResponse(model: string): Response {
	const events = [
		{
			id: "cline-pass-test",
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [{ index: 0, delta: { content: "ok" } }],
		},
		{
			id: "cline-pass-test",
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
		"[DONE]",
	];
	return new Response(
		`${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function toolCompletionResponse(model: string): Response {
	const events = [
		{
			id: "cline-pass-tool-test",
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [
				{
					index: 0,
					delta: {
						reasoning: "Inspect the marker.",
						tool_calls: [
							{
								index: 0,
								id: "call_marker",
								type: "function",
								function: { name: "get_marker", arguments: '{"value":42}' },
							},
						],
					},
				},
			],
		},
		{
			id: "cline-pass-tool-test",
			object: "chat.completion.chunk",
			created: 0,
			model,
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		},
		"[DONE]",
	];
	return new Response(
		`${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

async function capturePayload(options: {
	modelId?: string;
	context?: Context;
	reasoning?: Effort;
	disableReasoning?: boolean;
	toolChoice?: { type: "tool"; name: string };
}): Promise<Record<string, unknown>> {
	const model = getBundledModel<"openai-completions">(
		"cline-pass",
		options.modelId ?? "kimi-k3",
	) as Model<"openai-completions">;
	let payload: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return completionResponse(model.id);
		},
		{ preconnect: fetch.preconnect },
	);
	await streamOpenAICompletions(model, options.context ?? context, {
		apiKey: "test-key",
		fetch: fetchMock,
		maxTokens: 64,
		reasoning: options.reasoning,
		disableReasoning: options.disableReasoning,
		toolChoice: options.toolChoice,
	}).result();
	if (!payload) throw new Error("Expected ClinePass request payload");
	return payload;
}

describe("ClinePass OpenAI transport", () => {
	it("sends Cline's wire model ID, token field, max effort, and forced tool choice", async () => {
		const payload = await capturePayload({
			reasoning: Effort.Max,
			toolChoice: { type: "tool", name: "get_marker" },
		});

		expect(payload.model).toBe("cline-pass/kimi-k3");
		expect(payload.max_completion_tokens).toBe(64);
		expect(payload.max_tokens).toBeUndefined();
		expect(payload.reasoning_effort).toBe("max");
		expect(payload.thinking).toBeUndefined();
		expect(payload.tool_choice).toEqual({ type: "function", function: { name: "get_marker" } });
	});

	it("disables ClinePass reasoning with the gateway's none effort", async () => {
		const payload = await capturePayload({ disableReasoning: true });

		expect(payload.reasoning_effort).toBe("none");
		expect(payload.model).toBe("cline-pass/kimi-k3");
	});

	it("downgrades a forced ClinePass Qwen tool choice to auto while preserving reasoning", async () => {
		const payload = await capturePayload({
			modelId: "qwen3.7-max",
			reasoning: Effort.Low,
			toolChoice: { type: "tool", name: "get_marker" },
		});

		expect(payload.model).toBe("cline-pass/qwen3.7-max");
		expect(payload.reasoning_effort).toBe("low");
		expect(payload.tool_choice).toBe("auto");
	});

	it("serializes a Qwen tool continuation without requiring reasoning replay", async () => {
		const model = getBundledModel<"openai-completions">("cline-pass", "qwen3.7-max") as Model<"openai-completions">;
		const firstFetch: FetchImpl = Object.assign(async () => toolCompletionResponse(model.id), {
			preconnect: fetch.preconnect,
		});
		const assistant = await streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			fetch: firstFetch,
			maxTokens: 64,
			reasoning: Effort.Low,
		}).result();
		const payload = await capturePayload({
			modelId: "qwen3.7-max",
			context: {
				...context,
				messages: [
					...context.messages,
					assistant,
					{
						role: "toolResult",
						toolCallId: "call_marker",
						toolName: "get_marker",
						content: [{ type: "text", text: "42" }],
						isError: false,
						timestamp: 1,
					},
				],
			},
			reasoning: Effort.Low,
		});
		const messages = payload.messages as Array<Record<string, unknown>>;
		const wireAssistant = messages.find(message => message.role === "assistant");

		expect(assistant.content).toContainEqual({
			type: "thinking",
			thinking: "Inspect the marker.",
			thinkingSignature: "reasoning",
		});
		expect(wireAssistant?.tool_calls).toBeArray();
		expect(wireAssistant?.reasoning).toBeUndefined();
	});
});
