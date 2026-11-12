import { afterAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { streamOpenAICompletions } from "../../src/providers/openai-completions";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Message,
	Model,
	Tool,
} from "../../src/types";

/**
 * Live integration tests against a real Chat Completions endpoint.
 *
 * Gate: skipped unless LIVE_OPENAI_BASE_URL and LIVE_OPENAI_API_KEY are set.
 * Run explicitly (never in default CI):
 *   LIVE_OPENAI_BASE_URL=https://… LIVE_OPENAI_API_KEY=sk-… bun test test/live
 *
 * Coverage targets the surface the single-transport cutover (0d73ddd567) owns:
 * reasoning decode/echo, tool-call streaming, usage, and the exact wire payload
 * (max_tokens field, developer→system demotion, stream_options).
 */
const BASE_URL = process.env.LIVE_OPENAI_BASE_URL;
const API_KEY = process.env.LIVE_OPENAI_API_KEY;
const live = Boolean(BASE_URL && API_KEY);

function liveModel(): Model<"openai-completions"> {
	return buildModel({
		api: "openai-completions",
		provider: "moxuna",
		id: "deepseek-v4-pro",
		baseUrl: BASE_URL!,
		input: ["text"],
		contextWindow: 128000,
		maxTokens: 16384,
		reasoning: true,
		compat: { supportsDeveloperRole: false, supportsStore: false, maxTokensField: "max_tokens" },
	});
}

function liveCall(model: Model<"openai-completions">, context: Context): AssistantMessageEventStream {
	return streamOpenAICompletions(model, context, { apiKey: API_KEY! });
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessage> {
	let message: AssistantMessage | undefined;
	for await (const event of stream) {
		if (event.type === "done") message = event.message;
		if (event.type === "error") throw new Error(`live stream errored: ${JSON.stringify(event.error)}`);
	}
	if (!message) throw new Error("live stream finished without a done message");
	return message;
}

function user(text: string): Message {
	return { role: "user", content: text, timestamp: Date.now() };
}

const recordTool: Tool = {
	name: "record",
	description: "Record a value",
	parameters: type({ value: type("string") }),
};

/** Forwards to BASE_URL while recording every request body for wire assertions. */
function recordingProxy(): {
	baseUrl: string;
	bodies: Record<string, unknown>[];
	stop: () => void;
} {
	const bodies: Record<string, unknown>[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const upstream = new URL(`${BASE_URL}${url.pathname}${url.search}`);
			const body =
				request.method === "GET"
					? undefined
					: ((await request.json().catch(() => undefined)) as Record<string, unknown> | undefined);
			if (body) bodies.push(body);
			const headers = new Headers(request.headers);
			headers.delete("host");
			const response = await fetch(upstream, {
				method: request.method,
				headers,
				body: body ? JSON.stringify(body) : undefined,
			});
			return new Response(response.body, { status: response.status, headers: response.headers });
		},
	});
	return { baseUrl: `http://127.0.0.1:${server.port}`, bodies, stop: () => server.stop(true) };
}

const proxies: ReturnType<typeof recordingProxy>[] = [];
afterAll(() => {
	for (const proxy of proxies.splice(0)) proxy.stop();
});

describe.skipIf(!live)("live Chat Completions (reasoning + wire contract)", () => {
	it("decodes reasoning_content into signed thinking blocks and populates usage", async () => {
		const model = liveModel();
		const message = await collect(
			liveCall(model, { messages: [user("Think briefly about why the sky is blue, then answer with the single word: blue.")] }),
		);
		expect(message.stopReason).toBe("stop");
		const thinking = message.content.filter(
			(block): block is Extract<typeof block, { type: "thinking" }> => block.type === "thinking",
		);
		expect(thinking.length).toBeGreaterThan(0);
		for (const block of thinking) {
			expect(block.thinkingSignature).toBe("reasoning_content");
			expect(block.thinking.length).toBeGreaterThan(0);
		}
		expect(message.usage && message.usage.totalTokens).toBeGreaterThan(0);
	}, 120_000);

	it("round-trips a tool call and echoes reasoning_content on the follow-up turn", async () => {
		const model = liveModel();
		// Turn 1: force a tool call, keep whatever reasoning the model emits.
		const turn1: Message[] = [
			{
				role: "developer",
				content: "You are a test assistant. Always call the record tool with the exact value you are given.",
				timestamp: Date.now(),
			},
			user("Call the record tool with value 'live-echo-check' right now. Call the tool and nothing else."),
		];
		let assistant1 = await collect(liveCall(model, { messages: turn1, tools: [recordTool] }));
		if (!assistant1.content.some(block => block.type === "toolCall")) {
			// One retry: reasoning models occasionally answer instead of calling.
			assistant1 = await collect(
				liveCall(model, {
					messages: [
						...turn1,
						assistant1,
						user("You must call the record tool with value 'live-echo-check' now. Emit the tool call."),
					],
					tools: [recordTool],
				}),
			);
		}
		expect(assistant1.stopReason).toBe("toolUse");
		const toolCall = assistant1.content.find(
			(block): block is Extract<typeof block, { type: "toolCall" }> => block.type === "toolCall",
		);
		expect(toolCall).toBeTruthy();
		expect(toolCall!.name).toBe("record");

		// Turn 2: follow-up through the recording proxy; the request must carry reasoning_content.
		const proxy = recordingProxy();
		proxies.push(proxy);
		const proxied = liveModel();
		proxied.baseUrl = proxy.baseUrl;
		const toolResult: Message = {
			role: "toolResult",
			toolCallId: toolCall!.id,
			toolName: toolCall!.name,
			content: [{ type: "text", text: "recorded:live-echo-check" }],
			isError: false,
			timestamp: Date.now(),
		};
		const assistant2 = await collect(
			liveCall(proxied, {
				messages: [...turn1, assistant1, toolResult, user("Confirm with the single word: done.")],
			}),
		);
		expect(assistant2.stopReason).toBe("stop");
		expect(
			assistant2.content
				.map(block => (block.type === "text" ? block.text : ""))
				.join(" ")
				.toLowerCase(),
		).toContain("done");

		expect(proxy.bodies.length).toBe(1);
		const wire = proxy.bodies[0]!;
		const messages = wire.messages as Array<{ role: string; reasoning_content?: string }>;
		const assistantWire = messages.find(entry => entry.role === "assistant");
		expect(assistantWire).toBeTruthy();
		expect(assistantWire!.reasoning_content).toBeTruthy();
		expect((assistantWire!.reasoning_content as string).length).toBeGreaterThan(0);
	}, 300_000);

	it("sends the cutover wire contract: max_tokens, include_usage, developer→system, no store", async () => {
		const proxy = recordingProxy();
		proxies.push(proxy);
		const model = liveModel();
		model.baseUrl = proxy.baseUrl;
		await collect(
			liveCall(model, {
				messages: [
					{ role: "developer", content: "Reply with the single word: ok.", timestamp: Date.now() },
					user("go"),
				],
				tools: [recordTool],
			}),
		);
		expect(proxy.bodies.length).toBe(1);
		const body = proxy.bodies[0]!;
		expect(body.model).toBe("deepseek-v4-pro");
		expect(body.stream).toBe(true);
		expect(body.stream_options).toEqual({ include_usage: true });
		// maxTokensField: max_tokens (not the OpenAI default max_completion_tokens).
		expect(body.max_tokens).toBe(16384);
		expect(body.max_completion_tokens).toBeUndefined();
		// supportsStore: false → no store field at all.
		expect(body.store).toBeUndefined();
		// supportsDeveloperRole: false → developer demoted to system.
		const messages = body.messages as Array<{ role: string }>;
		expect(messages[0]!.role).toBe("system");
		expect(messages[1]!.role).toBe("user");
		expect(body.tools).toBeTruthy();
		expect((body.tools as Array<{ type: string; function: { name: string } }>)[0]).toMatchObject({
			type: "function",
			function: { name: "record" },
		});
	}, 300_000);
});
