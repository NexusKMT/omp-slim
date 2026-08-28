import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	fetchWellKnownModels,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	modelsDevCatalogFallback,
	opencodeGoModelManagerOptions,
	opencodeZenModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import type { FetchImpl } from "@oh-my-pi/pi-utils";

const LIVE_FREE_MODEL_IDS = [
	"deepseek-v4-flash-free",
	"hy3-free",
	"mimo-v2.5-free",
	"nemotron-3-ultra-free",
	"north-mini-code-free",
] as const;

const LIVE_PAID_MODEL_IDS = ["claude-opus-4-8", "gpt-5.5"] as const;

function modelListResponse(ids: readonly string[]): Response {
	return Response.json({
		object: "list",
		data: ids.map(id => ({ id, object: "model", owned_by: "opencode" })),
	});
}

describe("Shared models.dev catalog fallback", () => {
	test("adds newly published models for a bundled provider and reuses the cached snapshot", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-models-dev-fallback-"));
		try {
			const bundledModels = getBundledModels("zai");
			const bundledModel = bundledModels[0];
			if (!bundledModel) throw new Error("ZAI bundled catalog is empty");
			const bundledModelId = bundledModel.id;
			let fetches = 0;
			const fallback = modelsDevCatalogFallback("zai");
			if (!fallback) throw new Error("ZAI did not configure a models.dev fallback");
			const modelsDev = {
				...fallback,
				fetch: async () => {
					fetches++;
					return {
						zai: {
							models: {
								"glm-5.3-flash": {
									id: "glm-5.3-flash",
									name: "GLM-5.3-Flash",
									tool_call: true,
									reasoning: true,
									limit: { context: 1_000_000, output: 131_072 },
									modalities: { input: ["text", "image"], output: ["text"] },
									provider: { npm: "@ai-sdk/anthropic" },
								},
								[bundledModelId]: {
									id: bundledModelId,
									name: "Untrusted remote override",
									tool_call: false,
									reasoning: false,
									limit: { context: 1, output: 1 },
									modalities: { input: ["text"], output: ["text"] },
									provider: { npm: "@ai-sdk/anthropic" },
								},
							},
						},
					};
				},
			};
			const options = {
				providerId: "zai" as const,
				cacheDbPath: path.join(tempDir, "models.db"),
				staticModels: bundledModels,
				modelsDev,
			};

			const online = await resolveProviderModels(options, "online");
			expect(online.stale).toBe(false);
			expect(online.source).toBe("models.dev");
			expect(online.updatedAt).toBeNumber();
			expect(online.models.find(model => model.id === bundledModelId)).toMatchObject({
				name: bundledModel.name,
				contextWindow: bundledModel.contextWindow,
				maxTokens: bundledModel.maxTokens,
				reasoning: bundledModel.reasoning,
				input: bundledModel.input,
			});
			expect(online.models.find(model => model.id === "glm-5.3-flash")).toMatchObject({
				api: "anthropic-messages",
				baseUrl: "https://api.z.ai/api/anthropic",
				contextWindow: 1_000_000,
				maxTokens: 131_072,
				reasoning: true,
				input: ["text", "image"],
			});

			const cached = await resolveProviderModels(options, "online-if-uncached");
			console.log("DBG cached", cached.source, "count", cached.models.length, "probe?", cached.models.some(m => m.id === newlyPublishedId));
			const raw = await readModelCache("zai", options.cacheDbPath);
			console.log("DBG rawcache", raw ? { n: raw.models.length, fresh: raw.fresh, auth: raw.authoritative, fp: raw.staticFingerprint, omitted: raw.headerOmittedModelIds.length, unrest: raw.unrestorableHeaderModelIds.length, legacy: raw.legacyHeaderRestoreMarkers } : null);
			expect(cached.stale).toBe(false);
			expect(cached.source).toBe("cache");
			expect(cached.updatedAt).toBe(online.updatedAt);
			expect(cached.models.some(model => model.id === "glm-5.3-flash")).toBe(true);

			const staleFallback = await resolveProviderModels(
				{
					...options,
					now: () => Date.now() + 3 * 60 * 60 * 1000,
					modelsDev: {
						...modelsDev,
						fetch: async () => {
							throw new Error("models.dev unavailable");
						},
					},
				},
				"online",
			);
			expect(staleFallback.stale).toBe(true);
			expect(staleFallback.source).toBe("cache");
			expect(staleFallback.updatedAt).toBe(online.updatedAt);
			expect(staleFallback.models.some(model => model.id === "glm-5.3-flash")).toBe(true);
			expect(fetches).toBe(1);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
