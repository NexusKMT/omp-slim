import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getEnvApiKey, streamSimple } from "@oh-my-pi/pi-ai/stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { commandCodeModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Api, FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

const originalPrimaryKey = Bun.env.COMMAND_CODE_API_KEY;
const originalLegacyKey = Bun.env.COMMANDCODE_API_KEY;

afterEach(() => {
	if (originalPrimaryKey === undefined) delete Bun.env.COMMAND_CODE_API_KEY;
	else Bun.env.COMMAND_CODE_API_KEY = originalPrimaryKey;
	if (originalLegacyKey === undefined) delete Bun.env.COMMANDCODE_API_KEY;
	else Bun.env.COMMANDCODE_API_KEY = originalLegacyKey;
	vi.restoreAllMocks();
});

describe("Command Code provider support", () => {
	test("discovers mixed-protocol models with Command Code deployment policy", async () => {
		let requestHeaders: RequestInit["headers"];
		const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			requestHeaders = init?.headers;
			return Response.json({
				object: "list",
				data: [
					{
						id: "claude-sonnet-4-6",
						name: "Claude Sonnet 4.6",
						context_length: 1_000_000,
					},
					{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", context_length: 1_050_000 },
				],
			});
		});
		const options = commandCodeModelManagerOptions({ apiKey: "user_test", fetch: fetchMock });
		const specs = await options.fetchDynamicModels?.();
		const models = (specs ?? []).map(spec => buildModel(spec as ModelSpec<Api>));

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.commandcode.ai/provider/v1/models",
			expect.objectContaining({ method: "GET" }),
		);
		expect(requestHeaders).not.toHaveProperty("Authorization");
		expect(models.find(model => model.id === "claude-sonnet-4-6")).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.commandcode.ai/provider",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 65_536,
			thinking: {
				mode: "anthropic-adaptive",
				efforts: ["low", "medium", "high", "xhigh", "max"],
			},
		});
		expect(models.find(model => model.id === "gpt-5.6-sol")).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://api.commandcode.ai/provider/v1",
			reasoning: true,
			contextWindow: 1_050_000,
			maxTokens: 65_536,
			thinking: {
				mode: "effort",
				efforts: ["low", "medium", "high", "xhigh", "max"],
			},
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				supportsStore: false,
				maxTokensField: "max_tokens",
			},
		});
	});

	test("preserves disjoint cache usage and timing through both native transports", async () => {
		const catalog = commandCodeModelManagerOptions({
			fetch: async () =>
				Response.json({
					data: [
						{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", context_length: 1_050_000 },
						{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context_length: 1_000_000 },
					],
				}),
		});
		const specs = await catalog.fetchDynamicModels?.();
		const models = (specs ?? []).map(spec => buildModel(spec as ModelSpec<Api>));
		const gpt = models.find(model => model.id === "gpt-5.6-sol");
		const claude = models.find(model => model.id === "claude-sonnet-4-6");
		if (!gpt || !claude) throw new Error("Expected Command Code transport fixtures");
		let clock = 0;
		vi.spyOn(performance, "now").mockImplementation(() => ++clock);

		const fetchMock: FetchImpl = vi.fn(async input => {
			const url = String(input);
			if (url.endsWith("/chat/completions")) {
				return new Response(
					[
						'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"gpt-5.6-sol","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
						'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"gpt-5.6-sol","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":3,"cache_write_tokens":2}}}',
						"data: [DONE]",
						"",
					].join("\n\n"),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			if (url.endsWith("/messages")) {
				return new Response(
					[
						'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}',
						'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
						'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
						'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
						'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}',
						'event: message_stop\ndata: {"type":"message_stop"}',
						"",
					].join("\n\n"),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			return new Response("unexpected route", { status: 404 });
		});
		const context = { messages: [{ role: "user" as const, content: "Reply ok", timestamp: Date.now() }] };
		const gptResult = await streamSimple(gpt, context, { apiKey: "user_test", fetch: fetchMock }).result();
		const claudeResult = await streamSimple(claude, context, { apiKey: "user_test", fetch: fetchMock }).result();

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(gptResult.usage).toMatchObject({
			input: 5,
			output: 2,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 12,
		});
		expect(claudeResult.usage).toMatchObject({
			input: 5,
			output: 2,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 12,
		});
		for (const result of [gptResult, claudeResult]) {
			expect(result.duration).toBeGreaterThan(0);
			expect(result.ttft).toBeGreaterThan(0);
			expect(result.ttft).toBeLessThanOrEqual(result.duration ?? 0);
		}
	});

	test("registers discovery, defaults, and both API key environment names", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "commandcode");
		expect(descriptor).toMatchObject({
			defaultModel: "claude-sonnet-4-6",
			allowUnauthenticated: true,
			dynamicModelsAuthoritative: true,
			catalogDiscovery: { label: "Command Code", allowUnauthenticated: true },
		});
		expect(DEFAULT_MODEL_PER_PROVIDER.commandcode).toBe("claude-sonnet-4-6");

		delete Bun.env.COMMAND_CODE_API_KEY;
		Bun.env.COMMANDCODE_API_KEY = "legacy-key";
		expect(getEnvApiKey("commandcode")).toBe("legacy-key");
		Bun.env.COMMAND_CODE_API_KEY = "primary-key";
		expect(getEnvApiKey("commandcode")).toBe("primary-key");
	});

	test("accepts a pasted Provider API key through the login selector", async () => {
		const provider = getOAuthProviders().find(item => item.id === "commandcode");
		expect(provider?.name).toBe("Command Code");
		const login = getProviderDefinition("commandcode")?.login;
		expect(login).toBeDefined();
		const onAuth = vi.fn();
		await expect(
			login?.({
				onAuth,
				onPrompt: async () => "  user_test  ",
			}),
		).resolves.toBe("user_test");
		expect(onAuth).toHaveBeenCalledWith({
			url: "https://commandcode.ai/studio",
			instructions: "Create or copy a Provider API key from Command Code Studio",
		});
	});

	test("prices live-discovered models from the Command Code rate card", async () => {
		const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect(init?.method).toBe("GET");
			return Response.json({
				data: [
					{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", context_length: 1_000_000 },
					{ id: "Qwen/Qwen3.7-Flash", name: "Qwen 3.7 Flash", context_length: 1_000_000 },
					{ id: "xai/grok-4.6", name: "Grok 4.6", context_length: 500_000 },
					{ id: "poolside/laguna-s-2.1-free", name: "Laguna S 2.1", context_length: 256_000 },
				],
			});
		});
		const options = commandCodeModelManagerOptions({ apiKey: "user_test", fetch: fetchMock });
		const specs = await options.fetchDynamicModels?.();
		const models = (specs ?? []).map(spec => buildModel(spec as ModelSpec<Api>));

		expect(models.find(model => model.id === "claude-sonnet-4-6")).toMatchObject({
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		});
		// Qwen 3.7 Flash crosses its 32K tier: request-wide rates apply from
		// input + cacheRead + cacheWrite, so cache reads alone can cross it.
		expect(models.find(model => model.id === "Qwen/Qwen3.7-Flash")).toMatchObject({
			cost: {
				input: 0.03,
				output: 0.13,
				cacheRead: 0.006,
				cacheWrite: 0.038,
				longContext: { inputThreshold: 32_000, input: 0.1, output: 0.4, cacheRead: 0.02, cacheWrite: 0.125 },
			},
		});
		// Grok 4.6's whole-request 2x tier overrides the xai class multiplier
		// rule; resolution throwing here means the priority tie regressed.
		expect(models.find(model => model.id === "xai/grok-4.6")).toMatchObject({
			cost: {
				input: 2,
				output: 6,
				cacheRead: 0.5,
				cacheWrite: 0,
				longContext: { inputThreshold: 200_000, input: 4, output: 12, cacheRead: 1, cacheWrite: 0 },
			},
		});
		// Documented-free model keeps the zero discovery default.
		expect(models.find(model => model.id === "poolside/laguna-s-2.1-free")).toMatchObject({
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});
});
