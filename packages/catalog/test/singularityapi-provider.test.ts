import { afterEach, describe, expect, test, vi } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { singularityApiModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const originalKey = Bun.env.SINGULARITYAPI_API_KEY;

afterEach(() => {
	if (originalKey === undefined) delete Bun.env.SINGULARITYAPI_API_KEY;
	else Bun.env.SINGULARITYAPI_API_KEY = originalKey;
	vi.restoreAllMocks();
});

function singularityApiModelsFetch(): { calls: string[]; authorizations: (string | null)[]; fetch: FetchImpl } {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(
			JSON.stringify({
				data: [{ id: "deepseek-v4-flash", object: "model", owned_by: "singularityapi" }],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	return { calls, authorizations, fetch };
}

describe("SingularityAPI provider support", () => {
	test("discovers the reserved-lane roster with the stored key", async () => {
		const { calls, authorizations, fetch } = singularityApiModelsFetch();
		const pending = singularityApiModelManagerOptions({ apiKey: "sk-test", fetch }).fetchDynamicModels?.();
		const models = pending ? await pending : pending;

		expect(calls).toEqual(["https://api.singularityapi.tech/v1/models"]);
		expect(authorizations).toEqual(["Bearer sk-test"]);
		expect(models?.find(model => model.id === "deepseek-v4-flash")).toMatchObject({
			provider: "singularityapi",
			api: "openai-completions",
			baseUrl: "https://api.singularityapi.tech/v1",
		});
	});
	test("registers discovery, defaults, and the API key environment name", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "singularityapi");
		expect(descriptor).toMatchObject({
			defaultModel: "deepseek-v4-flash",
			dynamicModelsAuthoritative: true,
		});
		expect(DEFAULT_MODEL_PER_PROVIDER.singularityapi).toBe("deepseek-v4-flash");

		delete Bun.env.SINGULARITYAPI_API_KEY;
		expect(getEnvApiKey("singularityapi")).toBeUndefined();
		Bun.env.SINGULARITYAPI_API_KEY = "sk-test";
		expect(getEnvApiKey("singularityapi")).toBe("sk-test");
	});

	test("pastes a key through the login selector after models-endpoint validation", async () => {
		const provider = getOAuthProviders().find(item => item.id === "singularityapi");
		expect(provider?.name).toBe("SingularityAPI");
		const login = getProviderDefinition("singularityapi")?.login;
		expect(login).toBeDefined();

		const { calls, fetch } = singularityApiModelsFetch();
		const onAuth = vi.fn();
		const previousFetch = globalThis.fetch;
		globalThis.fetch = fetch as typeof globalThis.fetch;
		try {
			await expect(
				login?.({
					onAuth,
					onPrompt: async () => "  Bearer sk-test  ",
				}),
			).resolves.toBe("sk-test");
		} finally {
			globalThis.fetch = previousFetch;
		}
		expect(onAuth).toHaveBeenCalledWith({
			url: "https://app.singularityapi.tech/compute/billing",
			instructions: "Create an API key from the SingularityAPI dashboard, then paste it here",
		});
		expect(calls).toEqual(["https://api.singularityapi.tech/v1/models"]);
	});
});
