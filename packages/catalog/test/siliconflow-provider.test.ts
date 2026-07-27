import { describe, expect, test } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { GeneratedProvider } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	siliconflowCnModelManagerOptions,
	siliconflowModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

function withEnv(key: string, value: string, run: () => void): void {
	const previous = Bun.env[key];
	Bun.env[key] = value;
	try {
		run();
	} finally {
		if (previous === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = previous;
		}
	}
}

describe("siliconflow built-in providers", () => {
	test("registers dynamic-authoritative runtime descriptors with env-key discovery", () => {
		const intl = PROVIDER_DESCRIPTORS.find(item => item.providerId === "siliconflow");
		expect(intl).toBeDefined();
		expect(intl?.defaultModel).toBe("zai-org/GLM-5.1");
		expect(intl?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER.siliconflow).toBe("zai-org/GLM-5.1");

		const cn = PROVIDER_DESCRIPTORS.find(item => item.providerId === "siliconflow-cn");
		expect(cn).toBeDefined();
		expect(cn?.defaultModel).toBe("deepseek-ai/DeepSeek-V4-Pro");
		expect(cn?.dynamicModelsAuthoritative).toBe(true);
		expect(DEFAULT_MODEL_PER_PROVIDER["siliconflow-cn"]).toBe("deepseek-ai/DeepSeek-V4-Pro");
	});

	test("ships no bundled catalog — the model list is discovered live", () => {
		// Compile-time: neither provider id may appear in the bundled models.json.
		type _SiliconflowNotBundled =
			Extract<"siliconflow" | "siliconflow-cn", GeneratedProvider> extends never ? true : never;
		const _check: _SiliconflowNotBundled = true;
		expect(_check).toBe(true);
		// Runtime: no models.dev mapping may feed the generator either.
		expect(MODELS_DEV_PROVIDER_DESCRIPTORS.some(d => d.providerId === "siliconflow")).toBe(false);
		expect(MODELS_DEV_PROVIDER_DESCRIPTORS.some(d => d.providerId === "siliconflow-cn")).toBe(false);
	});

	test("registers API-key login providers", () => {
		const providers = getOAuthProviders();
		const intl = providers.find(item => item.id === "siliconflow");
		expect(intl?.name).toBe("SiliconFlow");
		expect(intl?.available).toBe(true);
		const cn = providers.find(item => item.id === "siliconflow-cn");
		expect(cn?.name).toBe("SiliconFlow (China)");
		expect(cn?.available).toBe(true);
	});

	test("resolves SILICONFLOW_API_KEY / SILICONFLOW_CN_API_KEY via env", () => {
		withEnv("SILICONFLOW_API_KEY", "siliconflow-test-key", () => {
			expect(getEnvApiKey("siliconflow")).toBe("siliconflow-test-key");
		});
		withEnv("SILICONFLOW_CN_API_KEY", "siliconflow-cn-test-key", () => {
			expect(getEnvApiKey("siliconflow-cn")).toBe("siliconflow-cn-test-key");
		});
	});

	test("dynamic discovery drops non-chat models and keeps chat completions entries", async () => {
		const seen: { url?: string; authorization?: string } = {};
		const stubFetch: FetchImpl = async (input, init) => {
			seen.url = String(input);
			const headers = new Headers(init?.headers);
			seen.authorization = headers.get("Authorization") ?? undefined;
			const payload = {
				object: "list",
				data: [
					{ id: "Qwen/Qwen3.5-397B-A17B", object: "model", created: 0, owned_by: "siliconflow" },
					{ id: "zai-org/GLM-5.1", object: "model", created: 0, owned_by: "siliconflow" },
					{ id: "BAAI/bge-m3", object: "model", created: 0, owned_by: "siliconflow" },
					{ id: "BAAI/bge-reranker-v2-m3", object: "model", created: 0, owned_by: "siliconflow" },
					{ id: "Qwen/Qwen3-Embedding-8B", object: "model", created: 0, owned_by: "siliconflow" },
					{ id: "Qwen/Qwen-Image", object: "model", created: 0, owned_by: "siliconflow" },
					{ id: "stabilityai/stable-diffusion-3-5-large", object: "model", created: 0, owned_by: "sd" },
					{ id: "Wan-AI/Wan2.2-T2V-A14B", object: "model", created: 0, owned_by: "siliconflow" },
					{ id: "TeleAI/TeleSpeechASR", object: "model", created: 0, owned_by: "siliconflow" },
					{ id: "FunAudioLLM/SenseVoiceSmall", object: "model", created: 0, owned_by: "siliconflow" },
					{ id: "IndexTeam/IndexTTS-2", object: "model", created: 0, owned_by: "siliconflow" },
				],
			};
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const options = siliconflowModelManagerOptions({ apiKey: "sk-test", fetch: stubFetch });
		expect(options.dynamicModelsAuthoritative).toBe(true);
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const ids = (models ?? []).map(model => model.id);
		expect(ids).toEqual(["Qwen/Qwen3.5-397B-A17B", "zai-org/GLM-5.1"]);
		const [first] = models ?? [];
		expect(first?.provider).toBe("siliconflow");
		expect(first?.api).toBe("openai-completions");
		expect(first?.baseUrl).toBe("https://api.siliconflow.com/v1");
		expect(seen.url).toBe("https://api.siliconflow.com/v1/models");
		expect(seen.authorization).toBe("Bearer sk-test");
	});

	test("cn variant discovers against the China endpoint", async () => {
		const seen: { url?: string } = {};
		const stubFetch: FetchImpl = async input => {
			seen.url = String(input);
			return new Response(JSON.stringify({ object: "list", data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const options = siliconflowCnModelManagerOptions({ apiKey: "sk-test", fetch: stubFetch });
		const models = await options.fetchDynamicModels?.();
		expect(models).toEqual([]);
		expect(seen.url).toBe("https://api.siliconflow.cn/v1/models");
	});
});
