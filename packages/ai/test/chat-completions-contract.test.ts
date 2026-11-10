import { afterEach, describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model } from "../src/types";
import { completeSimple, stream, streamSimple } from "../src/stream";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import { withCredentialRedaction } from "../src/providers/transform-messages";

const servers: Bun.Server<undefined>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});
const context = { messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };
function fixture(handler: (request: Request) => Response | Promise<Response>): Model<"openai-completions"> {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
	servers.push(server);
	return buildModel({
		id: "explicit-model",
		provider: "explicit-gateway",
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		input: ["text", "image"],
		contextWindow: 32768,
		maxTokens: 1024,
	});
}
function sse(...chunks: unknown[]): Response {
	return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
		headers: { "content-type": "text/event-stream" },
	});
}
function answer(text = "hello back"): Response {
	return sse({ id: "chat-1", choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }] });
}

describe("explicit Chat Completions transport", () => {
	it("sends the configured model, endpoint, dynamic headers, key and standard fields", async () => {
		const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
		const model = fixture(async request => {
			requests.push({
				url: request.url,
				headers: request.headers,
				body: (await request.json()) as Record<string, unknown>,
			});
			return answer();
		});
		model.headers = { "X-Static": "static", "X-Collision": "static" };
		model.resolveHeaders = async () => ({ "X-Dynamic": "dynamic", "X-Collision": "dynamic" });
		const result = await completeSimple(model, context, {
			apiKey: "explicit-key",
			headers: { "X-Collision": "request" },
			reasoning: Effort.High,
			temperature: 0.2,
		});
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hello back" }]);
		const request = requests[0]!;
		expect(request.url).toBe(`${model.baseUrl}/chat/completions`);
		expect(request.headers.get("authorization")).toBe("Bearer explicit-key");
		expect(request.headers.get("x-static")).toBe("static");
		expect(request.headers.get("x-dynamic")).toBe("dynamic");
		expect(request.headers.get("x-collision")).toBe("request");
		expect(request.body).toMatchObject({
			model: "explicit-model",
			stream: true,
			temperature: 0.2,
			reasoning_effort: "high",
			max_completion_tokens: 1024,
		});
		expect(requests).toHaveLength(1);
	});
	it("does not infer protocol, headers, route or model variants from provider/model names", async () => {
		const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
		const model = fixture(async request => {
			requests.push({
				url: request.url,
				headers: request.headers,
				body: (await request.json()) as Record<string, unknown>,
			});
			return answer();
		});
		model.provider = "anthropic";
		model.id = "claude-opus-4-6";
		await completeSimple(model, context, {
			apiKey: "key",
			onPayload: body => ({ ...(body as object), model: "decoy" }),
		});
		expect(requests[0]!.url).toBe(`${model.baseUrl}/chat/completions`);
		expect(requests[0]!.body.model).toBe("claude-opus-4-6");
		expect(requests[0]!.headers.has("anthropic-version")).toBe(false);
		expect(requests[0]!.headers.has("x-api-key")).toBe(false);
	});
	it("rejects retired and custom API ids before any outbound request", () => {
		let calls = 0;
		const model = fixture(() => {
			calls++;
			return answer();
		});
		for (const api of [
			"openai-responses",
			"openai-codex-responses",
			"anthropic-messages",
			"google-generative-ai",
			"custom-wire",
		]) {
			expect(() => stream({ ...model, api }, context)).toThrow("Only openai-completions");
			expect(() => streamSimple({ ...model, api }, context)).toThrow("Only openai-completions");
		}
		expect(calls).toBe(0);
	});
	it("assembles interleaved streamed tool arguments and accounts for standard usage", async () => {
		const model = fixture(() =>
			sse(
				{
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "first",
										type: "function",
										function: { name: "read", arguments: '{"path":' },
									},
									{
										index: 1,
										id: "second",
										type: "function",
										function: { name: "read", arguments: '{"path":"b"}' },
									},
								],
							},
						},
					],
				},
				{
					choices: [
						{
							index: 0,
							delta: { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] },
							finish_reason: "tool_calls",
						},
					],
				},
				{
					choices: [],
					usage: {
						prompt_tokens: 100,
						completion_tokens: 12,
						total_tokens: 112,
						prompt_tokens_details: { cached_tokens: 20 },
					},
				},
			),
		);
		const events = [];
		const response = streamSimple(model, context, { apiKey: "key" });
		for await (const event of response) events.push(event.type);
		const result = await response.result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "toolCall", id: "first", name: "read", arguments: { path: "a" } },
			{ type: "toolCall", id: "second", name: "read", arguments: { path: "b" } },
		]);
		expect(result.usage).toMatchObject({ input: 80, cacheRead: 20, output: 12, totalTokens: 112 });
		expect(events.filter(type => type === "toolcall_start")).toHaveLength(2);
		expect(events.filter(type => type === "toolcall_end")).toHaveLength(2);
	});
	it("accepts a non-streaming JSON completion with tool calls", async () => {
		let sent: Record<string, unknown> | undefined;
		const model = fixture(async request => {
			sent = (await request.json()) as Record<string, unknown>;
			return Response.json({
				id: "json-1",
				choices: [
					{
						index: 0,
						message: {
							role: "assistant",
							content: null,
							tool_calls: [
								{ id: "call-1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } },
							],
						},
						finish_reason: "tool_calls",
					},
				],
			});
		});
		const result = await streamOpenAICompletions(model, context, { apiKey: "key", stream: false }).result();
		expect(sent?.stream).toBe(false);
		expect(sent?.stream_options).toBeUndefined();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content[0]).toMatchObject({ id: "call-1", arguments: { path: "a" } });
	});
	it("preserves image inputs and sends image tool results as attached user content", async () => {
		let body: Record<string, unknown> = {};
		const model = fixture(async request => {
			body = (await request.json()) as Record<string, unknown>;
			return answer();
		});
		const image = { type: "image" as const, data: "aGk=", mimeType: "image/png", detail: "high" as const };
		await completeSimple(
			model,
			{
				messages: [
					{ role: "user", content: [image], timestamp: 1 },
					{
						role: "assistant",
						api: model.api,
						model: model.id,
						provider: model.provider,
						content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }],
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: 2,
					},
					{
						role: "toolResult",
						toolCallId: "call",
						toolName: "read",
						content: [image],
						isError: false,
						timestamp: 3,
					},
				],
			},
			{ apiKey: "key" },
		);
		expect(body.messages).toMatchObject([
			{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aGk=" } }] },
			{ role: "assistant" },
			{ role: "tool", tool_call_id: "call" },
			{ role: "user", content: [{ type: "image_url" }] },
		]);
	});
	it("keeps credential redaction before HTTP serialization", async () => {
		let payload = "";
		const model = fixture(async request => {
			payload = await request.text();
			return answer();
		});
		const token = `sk-${"aB7_".repeat(14)}`;
		await withCredentialRedaction(true, () =>
			completeSimple(model, { messages: [{ role: "user", content: token, timestamp: 1 }] }, { apiKey: "key" }),
		);
		expect(payload).not.toContain(token);
		expect(payload).toContain("[openai_token_redacted]");
	});
	it("reports terminal HTTP errors without changing the requested model", async () => {
		const bodies: Record<string, unknown>[] = [];
		const model = fixture(async request => {
			bodies.push((await request.json()) as Record<string, unknown>);
			return Response.json({ error: { message: "fixture rejected request" } }, { status: 400 });
		});
		const result = await completeSimple(model, context, { apiKey: "key" });
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(400);
		expect(result.errorMessage).toContain("fixture rejected request");
		expect(bodies).toHaveLength(1);
		expect(bodies[0]!.model).toBe(model.id);
	});
	it("retries transient HTTP errors with the same model and request body", async () => {
		const bodies: string[] = [];
		const model = fixture(async request => {
			bodies.push(await request.text());
			return bodies.length === 1
				? new Response("temporary", { status: 503, headers: { "retry-after": "0" } })
				: answer();
		});
		const result = await completeSimple(model, context, { apiKey: "key", maxHttpAttempts: 2 });
		expect(result.stopReason).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toBe(bodies[1]);
	});
	it("cancels a stalled stream and closes its partial content lifecycle", async () => {
		const abort = new AbortController();
		const model = fixture(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(
								new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'),
							);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		);
		const response = streamSimple(model, context, { apiKey: "key", signal: abort.signal });
		const events: string[] = [];
		for await (const event of response) {
			events.push(event.type);
			if (event.type === "text_delta") abort.abort(new Error("cancel fixture"));
		}
		const result = await response.result();
		expect(result.stopReason).toBe("aborted");
		expect(events).toContain("text_end");
		expect(events.at(-1)).toBe("error");
	});
});
