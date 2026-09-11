/**
 * Anthropic server-side compaction (`compact-2026-01-12`).
 *
 * Verifies the provider contract the agent's compaction backend relies on:
 *   • Request — `anthropicCompaction` emits the `compact_20260112` edit beside
 *     `clear_thinking`, clamps the trigger to the API floor, and attaches the
 *     beta; requests without the option (and endpoints without context
 *     management) stay untouched.
 *   • Response — the streamed `compaction` block becomes the assistant
 *     message's `anthropicCompaction` payload, the `compaction` stop reason is
 *     a normal stop tagged in `stopDetails`, usage is the sum over
 *     `usage.iterations`, and a `null` summary yields no payload.
 *   • Replay — a user-role summary carrying this provider's payload is sent as
 *     a leading assistant `compaction` block; other providers' payloads and
 *     endpoints without context management keep the text.
 *   • The empty-completion retry does not re-issue a compaction pause.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { convertAnthropicMessages, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { AssistantMessage, Context, Model, ModelSpec, UserMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withEnv, withOfficialAnthropicEndpoint } from "./helpers";

const fableModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-fable-5",
	name: "Claude Fable 5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
});

const noContextManagementModel: Model<"anthropic-messages"> = buildModel({
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5 (proxy)",
	api: "anthropic-messages",
	provider: "custom-anthropic-proxy",
	baseUrl: "https://models.example.test",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
	compat: { supportsContextManagement: false },
} as ModelSpec<"anthropic-messages">);

const SUMMARY = "## Goal\nAudit the handlers.\n\n## Next Steps\n1. Continue with chunk 11.";

const context: Context = {
	messages: [{ role: "user", content: "Continue the audit.", timestamp: Date.now() }],
};

type MockAnthropicEvent = Record<string, unknown>;

function createMockRequest(events: MockAnthropicEvent[]) {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_mock" } });
	const stream = {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
	return {
		async withResponse() {
			return { data: stream, response, request_id: response.headers.get("request-id") };
		},
	};
}

/** The stream observed live on 2026-09-11 for a paused compaction request. */
function createPausedCompactionEvents(content: string | null): MockAnthropicEvent[] {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_compact",
				model: "claude-fable-5",
				usage: {
					input_tokens: 64,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 80_082,
				},
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "compaction", content: "" } },
		{ type: "ping" },
		{ type: "content_block_delta", index: 0, delta: { type: "compaction_delta", content } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "compaction" },
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				iterations: [
					{
						type: "compaction",
						input_tokens: 64,
						output_tokens: 2002,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 80_082,
					},
				],
			},
		},
		{ type: "message_stop" },
	];
}

async function captureRequest(
	model: Model<"anthropic-messages">,
	options: Parameters<typeof streamAnthropic>[2],
	messages: Context["messages"] = context.messages,
): Promise<{ beta: string; payload: Record<string, unknown> }> {
	let beta = "";
	const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
		beta = new Headers(init?.headers).get("anthropic-beta") ?? "";
		return new Response(
			JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;
	const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
	await streamAnthropic(
		model,
		{ systemPrompt: ["auditor"], messages },
		{
			apiKey: "sk-ant-test",
			...options,
			fetch: fetchMock,
			onPayload: payload => resolve(payload as Record<string, unknown>),
		},
	).result();
	return { beta, payload: await promise };
}

function compactionSummaryMessage(provider: string, content = SUMMARY): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text: `Prior model work available.\n\n<summary>\n${content}\n</summary>` }],
		providerPayload: { type: "anthropicCompaction", provider, content },
		timestamp: 1,
	};
}

withOfficialAnthropicEndpoint();

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic server-side compaction request", () => {
	it("emits the compact edit beside clear_thinking and attaches the compaction beta", async () => {
		const { beta, payload } = await captureRequest(fableModel, {
			thinkingEnabled: true,
			anthropicCompaction: { triggerInputTokens: 120_000, pauseAfterCompaction: true, instructions: "Summarize." },
		});

		expect(payload.context_management).toEqual({
			edits: [
				{ type: "clear_thinking_20251015", keep: "all" },
				{
					type: "compact_20260112",
					trigger: { type: "input_tokens", value: 120_000 },
					pause_after_compaction: true,
					instructions: "Summarize.",
				},
			],
		});
		expect(beta).toContain("compact-2026-01-12");
	});

	it("clamps the trigger to the API floor and omits unset fields", async () => {
		const { payload } = await captureRequest(fableModel, {
			thinkingEnabled: false,
			anthropicCompaction: { triggerInputTokens: 1_000 },
		});

		expect(payload.context_management).toEqual({
			edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 50_000 } }],
		});
	});

	it("sends neither the edit nor the beta without the option", async () => {
		const { beta, payload } = await captureRequest(fableModel, { thinkingEnabled: false });

		expect(payload.context_management).toBeUndefined();
		expect(beta).not.toContain("compact-2026-01-12");
	});

	it("stays inert on endpoints without context management", async () => {
		const { beta, payload } = await captureRequest(noContextManagementModel, {
			thinkingEnabled: false,
			anthropicCompaction: { triggerInputTokens: 50_000, pauseAfterCompaction: true },
		});

		expect(payload.context_management).toBeUndefined();
		expect(beta).not.toContain("compact-2026-01-12");
	});
});

describe("anthropic server-side compaction response", () => {
	it("surfaces the summary as the assistant payload with a tagged stop and iteration-summed usage", async () => {
		const create = vi
			.spyOn(AnthropicMessages.prototype, "create")
			.mockImplementation(() => createMockRequest(createPausedCompactionEvents(SUMMARY)) as never);

		const s = streamAnthropic(fableModel, context, {
			apiKey: "sk-ant-test",
			anthropicCompaction: { triggerInputTokens: 50_000, pauseAfterCompaction: true },
		});
		for await (const _ of s) {
			// drain
		}
		const result = await s.result();

		expect(result.providerPayload).toEqual({ type: "anthropicCompaction", provider: "anthropic", content: SUMMARY });
		expect(result.content).toEqual([]);
		expect(result.stopReason).toBe("stop");
		expect(result.stopDetails).toEqual({ type: "compaction" });
		expect(result.errorMessage).toBeUndefined();
		// The top-level counts exclude the compaction iteration; the iteration
		// list is the billed total (64 input, 2002 output, 80,082 cache write).
		expect(result.usage.input).toBe(64);
		expect(result.usage.output).toBe(2002);
		expect(result.usage.cacheWrite).toBe(80_082);
		expect(result.usage.cacheRead).toBe(0);
		expect(result.usage.totalTokens).toBe(64 + 2002 + 80_082);
		expect(result.usage.cost.output).toBeCloseTo((2002 * 50) / 1_000_000, 10);
		expect(result.usage.cost.cacheWrite).toBeCloseTo((80_082 * 12.5) / 1_000_000, 10);
		// A compaction pause is a legitimate empty stop: no empty-completion retry.
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("yields no payload when the model called a tool instead of summarizing", async () => {
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation(
			() => createMockRequest(createPausedCompactionEvents(null)) as never,
		);

		const s = streamAnthropic(fableModel, context, {
			apiKey: "sk-ant-test",
			anthropicCompaction: { triggerInputTokens: 50_000, pauseAfterCompaction: true },
		});
		for await (const _ of s) {
			// drain
		}
		const result = await s.result();

		expect(result.providerPayload).toBeUndefined();
		expect(result.stopDetails).toEqual({ type: "compaction" });
		expect(result.errorMessage).toBeUndefined();
	});
});

describe("anthropic server-side compaction replay", () => {
	it("replays this provider's summary as a leading assistant compaction block", () => {
		const params = convertAnthropicMessages(
			[compactionSummaryMessage("anthropic"), { role: "user", content: "next", timestamp: 2 }],
			fableModel,
			false,
			{ replayCompaction: true },
		);

		expect(params).toEqual([
			{ role: "assistant", content: [{ type: "compaction", content: SUMMARY }] },
			{ role: "user", content: "next" },
		]);
	});

	it("keeps the summary text for another provider's payload and when replay is off", () => {
		const foreign = convertAnthropicMessages(
			[compactionSummaryMessage("umans"), { role: "user", content: "next", timestamp: 2 }],
			fableModel,
			false,
			{ replayCompaction: true },
		);
		const replayOff = convertAnthropicMessages(
			[compactionSummaryMessage("anthropic"), { role: "user", content: "next", timestamp: 2 }],
			fableModel,
			false,
		);

		for (const params of [foreign, replayOff]) {
			expect(params[0]?.role).toBe("user");
			expect(JSON.stringify(params[0]?.content)).toContain("<summary>");
			expect(params.some(param => JSON.stringify(param.content).includes('"compaction"'))).toBe(false);
		}
	});

	it("attaches the compaction beta when the context replays a summary, and keeps the text elsewhere", async () => {
		const official = await captureRequest(fableModel, { thinkingEnabled: false }, [
			compactionSummaryMessage("anthropic"),
			{ role: "user", content: "next", timestamp: 2 },
		]);
		expect(official.beta).toContain("compact-2026-01-12");
		// The API rejects a replayed block without a strategy; the replay edit's
		// trigger sits at the context window so the live turn never compacts.
		expect(official.payload.context_management).toEqual({
			edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 1_000_000 } }],
		});
		// Both tail breakpoints land here: the API accepts cache_control on a
		// compaction block, so a short post-compaction tail caches the summary.
		expect(official.payload.messages).toEqual([
			{
				role: "assistant",
				content: [{ type: "compaction", content: SUMMARY, cache_control: { type: "ephemeral" } }],
			},
			{ role: "user", content: [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }] },
		]);

		const proxy = await captureRequest(noContextManagementModel, { thinkingEnabled: false }, [
			compactionSummaryMessage("custom-anthropic-proxy"),
			{ role: "user", content: "next", timestamp: 2 },
		]);
		expect(proxy.beta).not.toContain("compact-2026-01-12");
		expect(JSON.stringify(proxy.payload.messages)).not.toContain('"compaction"');
		expect(JSON.stringify(proxy.payload.messages)).toContain("<summary>");
	});

	it("keeps the text and sends no beta once the same model is rerouted to a gateway, unless the route opts in", async () => {
		// compat.officialEndpoint is built from the catalog URL, so the reroute
		// is only visible at request time — the gate must resolve the URL the
		// way the transport does.
		await withEnv({ ANTHROPIC_BASE_URL: "https://gateway.example.com" }, async () => {
			const rerouted = await captureRequest(fableModel, { thinkingEnabled: false }, [
				compactionSummaryMessage("anthropic"),
				{ role: "user", content: "next", timestamp: 2 },
			]);
			expect(rerouted.beta).not.toContain("compact-2026-01-12");
			expect(rerouted.payload.context_management).toBeUndefined();
			expect(JSON.stringify(rerouted.payload.messages)).not.toContain('"compaction"');
			expect(JSON.stringify(rerouted.payload.messages)).toContain("<summary>");

			const optedIn = await captureRequest(
				buildModel({ ...fableModel, remoteCompaction: { enabled: true } } as ModelSpec<"anthropic-messages">),
				{ thinkingEnabled: false },
				[compactionSummaryMessage("anthropic"), { role: "user", content: "next", timestamp: 2 }],
			);
			expect(optedIn.beta).toContain("compact-2026-01-12");
			expect(JSON.stringify(optedIn.payload.messages)).toContain('"compaction"');
		});
	});

	it("opens the retained assistant turn with the block instead of padding a synthetic user turn", () => {
		const retainedAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Reading chunk 11 now." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-fable-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		};
		const params = convertAnthropicMessages(
			[compactionSummaryMessage("anthropic"), retainedAssistant, { role: "user", content: "next", timestamp: 3 }],
			fableModel,
			false,
			{ replayCompaction: true },
		);

		expect(params).toEqual([
			{
				role: "assistant",
				content: [
					{ type: "compaction", content: SUMMARY },
					{ type: "text", text: "Reading chunk 11 now." },
				],
			},
			{ role: "user", content: "next" },
		]);
	});
});
