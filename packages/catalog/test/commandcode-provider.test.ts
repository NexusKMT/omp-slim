import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
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
});
