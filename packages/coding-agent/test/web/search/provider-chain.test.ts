import { afterEach, describe, expect, it } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveModelRoleValue, resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getSearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const originalPerplexityApiKey = process.env.PERPLEXITY_API_KEY;
const originalPerplexityCookies = process.env.PERPLEXITY_COOKIES;
const storages = new Set<AuthStorage>();

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function createRuntime(overrides: Parameters<typeof Settings.isolated>[0] = {}) {
	const authStorage = createInMemoryAuthStorage();
	storages.add(authStorage);
	const settings = Settings.isolated(overrides);
	const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
	const pool = roleCandidatePool("web", settings, modelRegistry);
	return { authStorage, settings, modelRegistry, pool };
}

afterEach(() => {
	for (const authStorage of storages) authStorage.close();
	storages.clear();
	restoreEnv("PERPLEXITY_API_KEY", originalPerplexityApiKey);
	restoreEnv("PERPLEXITY_COOKIES", originalPerplexityCookies);
});

describe("web model role resolution", () => {
	it("resolves an arbitrary pure-engine selector from the catalog pool", () => {
		const { pool, settings } = createRuntime();

		const resolved = resolveModelRoleValue("web/duckduckgo", pool, { settings });

		expect(resolved.model).toMatchObject({ provider: "web", id: "duckduckgo", kind: "search" });
	});

	it("resolves authenticated OpenRouter chat models with web grounding", () => {
		const authStorage = createInMemoryAuthStorage();
		storages.add(authStorage);
		authStorage.keys.setRuntime("openrouter", "test-openrouter-key");
		const settings = Settings.isolated();
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		const pool = roleCandidatePool("web", settings, modelRegistry);

		const resolved = resolveModelRoleValue("openrouter/google/gemini-2.5-flash", pool, { settings });

		expect(resolved.model).toMatchObject({
			provider: "openrouter",
			id: "google/gemini-2.5-flash",
			webSearch: "openrouter",
		});
	});

	it("builds the default web retry chain from catalog role priorities", () => {
		const { pool, settings } = createRuntime();

		const candidates = resolveRoleChain("web", settings, pool);

		expect(candidates.slice(0, 2).map(candidate => candidate.model.id)).toEqual(["parallel", "perplexity"]);
		expect(candidates.slice(0, 2).every(candidate => candidate.explicit === false)).toBe(true);
		expect(candidates.some(candidate => candidate.model.id === "duckduckgo")).toBe(true);
	});

	it("keeps direct OpenAI API search after available Codex OAuth candidates", async () => {
		const authStorage = createInMemoryAuthStorage();
		storages.add(authStorage);
		authStorage.keys.setRuntime("openai", "test-openai-key");
		await authStorage.credentials.set("openai-codex", {
			type: "oauth",
			access: "test-codex-access",
			refresh: "test-codex-refresh",
			expires: Date.now() + 3_600_000,
		});
		const settings = Settings.isolated();
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		const pool = roleCandidatePool("web", settings, modelRegistry).filter(
			model => model.provider === "openai-codex" || model.provider === "openai",
		);
		const candidates = resolveRoleChain("web", settings, pool);

		const lastCodexIndex = candidates.reduce(
			(last, candidate, index) => (candidate.model.provider === "openai-codex" ? index : last),
			-1,
		);
		const openAiApiIndex = candidates.findIndex(
			candidate => candidate.model.provider === "openai" && candidate.model.id === "gpt-5.6-luna",
		);

		expect(lastCodexIndex).toBeGreaterThanOrEqual(0);
		expect(openAiApiIndex).toBeGreaterThan(lastCodexIndex);
		expect(candidates[openAiApiIndex]?.explicit).toBe(false);
	});

	it("selects the bundled direct OpenAI model when it is the only eligible web candidate", () => {
		const authStorage = createInMemoryAuthStorage();
		storages.add(authStorage);
		authStorage.keys.setRuntime("openai", "test-openai-key");
		const settings = Settings.isolated();
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		const pool = roleCandidatePool("web", settings, modelRegistry).filter(
			model => model.provider === "openai" && model.id === "gpt-5.6-luna",
		);

		const candidates = resolveRoleChain("web", settings, pool);

		expect(candidates.map(candidate => `${candidate.model.provider}/${candidate.model.id}`)).toEqual([
			"openai/gpt-5.6-luna",
		]);
		expect(candidates[0]?.explicit).toBe(false);
	});

	it("marks configured primaries and configured fallbacks explicit", () => {
		const { pool, settings } = createRuntime({
			modelRoles: { web: "web/perplexity" },
			"retry.fallbackChains": { web: ["web/duckduckgo"] },
		});

		const candidates = resolveRoleChain("web", settings, pool);

		expect(candidates.map(candidate => [candidate.model.id, candidate.explicit])).toEqual([
			["perplexity", true],
			["duckduckgo", true],
		]);
	});
});

describe("web model candidate availability", () => {
	it("skips anonymous explicit-only engines in the default chain", async () => {
		delete process.env.PERPLEXITY_API_KEY;
		delete process.env.PERPLEXITY_COOKIES;
		const { authStorage, pool } = createRuntime();
		const model = pool.find(candidate => candidate.provider === "web" && candidate.id === "perplexity");
		if (!model) throw new Error("Bundled Perplexity search model missing");
		const provider = await getSearchProvider(model.id);

		expect(await provider.isAvailable(authStorage, model)).toBe(false);
		expect(await provider.isExplicitlyAvailable(authStorage, model)).toBe(true);
	});

	it("admits a configured anonymous engine through explicit availability", async () => {
		delete process.env.PERPLEXITY_API_KEY;
		delete process.env.PERPLEXITY_COOKIES;
		const { authStorage, pool, settings } = createRuntime({ modelRoles: { web: "web/perplexity" } });
		const [candidate] = resolveRoleChain("web", settings, pool);
		if (!candidate) throw new Error("Configured Perplexity candidate missing");
		const provider = await getSearchProvider(candidate.model.id);

		expect(candidate.explicit).toBe(true);
		expect(await provider.isExplicitlyAvailable(authStorage, candidate.model)).toBe(true);
	});
});
