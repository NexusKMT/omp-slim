import { afterEach, describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { AssistantMessage, Model } from "../src/types";
import { streamOpenAICompletions } from "../src/providers/openai-completions";

const servers: Bun.Server<undefined>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function fixture(handler: (request: Request) => Response | Promise<Response>): Model<"openai-completions"> {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
	servers.push(server);
	return buildModel({
		id: "deepseek-class",
		provider: "explicit-gateway",
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		input: ["text"],
		contextWindow: 32768,
		maxTokens: 1024,
	});
}

function sse(...chunks: unknown[]): Response {
	return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
		headers: { "content-type": "text/event-stream" },
	});
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "explicit-gateway",
		model: "explicit-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("DeepSeek-class reasoning replay", () => {
	it("echoes signed thinking back as reasoning_content on the next request", async () => {
		const requests: Record<string, unknown>[] = [];
		const model = fixture(async request => {
			requests.push((await request.json()) as Record<string, unknown>);
			return sse({ id: "chat-1", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] });
		});
		const context = {
			messages: [
				{ role: "user" as const, content: "hi", timestamp: 0 },
				assistant([
					{ type: "thinking", thinking: "step one\nstep two", thinkingSignature: "reasoning_content" },
					{ type: "text", text: "answer" },
				]),
				{ role: "user" as const, content: "again", timestamp: 2 },
			],
		};
		await streamOpenAICompletions(model, context, { apiKey: "key" }).result();
		const assistantWire = (requests[0]!.messages as Record<string, unknown>[]).find(m => m.role === "assistant");
		expect(assistantWire).toMatchObject({ content: "answer", reasoning_content: "step one\nstep two" });
	});

	it("echoes reasoning alongside tool_calls on tool-use turns", async () => {
		const requests: Record<string, unknown>[] = [];
		const model = fixture(async request => {
			requests.push((await request.json()) as Record<string, unknown>);
			return sse({ id: "chat-1", choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] });
		});
		const context = {
			messages: [
				{ role: "user" as const, content: "hi", timestamp: 0 },
				assistant([
					{ type: "thinking", thinking: "need a tool", thinkingSignature: "reasoning_content" },
					{
						type: "toolCall",
						id: "call-1",
						name: "read",
						arguments: { path: "/tmp/x" },
					},
				]),
				{
					role: "toolResult" as const,
					toolCallId: "call-1",
					toolName: "read",
					isError: false,
					content: [{ type: "text" as const, text: "content" }],
					timestamp: 2,
				},
			],
		};
		await streamOpenAICompletions(model, context, { apiKey: "key" }).result();
		const assistantWire = (requests[0]!.messages as Record<string, unknown>[]).find(m => m.role === "assistant");
		expect(assistantWire).toMatchObject({
			reasoning_content: "need a tool",
			tool_calls: [{ id: "call-1", type: "function", function: { name: "read" } }],
		});
	});

	it("does not emit reasoning_content for unsigned or foreign-signed thinking", async () => {
		const requests: Record<string, unknown>[] = [];
		const model = fixture(async request => {
			requests.push((await request.json()) as Record<string, unknown>);
			return sse({ id: "chat-1", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] });
		});
		const context = {
			messages: [
				{ role: "user" as const, content: "hi", timestamp: 0 },
				assistant([
					{ type: "thinking", thinking: "plain thinking" },
					{ type: "thinking", thinking: "signed elsewhere", thinkingSignature: "anthropic-signature" },
					{ type: "text", text: "answer" },
				]),
				{ role: "user" as const, content: "again", timestamp: 2 },
			],
		};
		await streamOpenAICompletions(model, context, { apiKey: "key" }).result();
		const assistantWire = (requests[0]!.messages as Record<string, unknown>[]).find(m => m.role === "assistant");
		expect(assistantWire).not.toHaveProperty("reasoning_content");
	});

	it("streams reasoning_content deltas as signed thinking blocks", async () => {
		const model = fixture(() =>
			sse(
				{ id: "chat-1", choices: [{ index: 0, delta: { reasoning_content: "thinking " } }] },
				{ id: "chat-1", choices: [{ index: 0, delta: { reasoning_content: "more" } }] },
				{ id: "chat-1", choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }] },
			),
		);
		const events: string[] = [];
		for await (const event of streamOpenAICompletions(model, { messages: [] }, { apiKey: "key" })) {
			events.push(event.type);
		}
		expect(events).toContain("thinking_start");
		expect(events).toContain("thinking_delta");
		expect(events).toContain("thinking_end");
		const result = await streamOpenAICompletions(model, { messages: [] }, { apiKey: "key" }).result();
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "thinking more", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "answer" },
		]);
	});
});
