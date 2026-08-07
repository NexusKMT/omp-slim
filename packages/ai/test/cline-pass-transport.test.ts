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

async function capturePayload(options: {
	reasoning?: Effort;
	disableReasoning?: boolean;
	toolChoice?: { type: "tool"; name: string };
}): Promise<Record<string, unknown>> {
	const model = getBundledModel<"openai-completions">("cline-pass", "kimi-k3") as Model<"openai-completions">;
	let payload: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return completionResponse(model.id);
		},
		{ preconnect: fetch.preconnect },
	);
	await streamOpenAICompletions(model, context, {
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
});
