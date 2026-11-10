import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { ModelRegistry, type ProviderConfigInput } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";

let directory: string;
let auth: AuthStorage;
let configPath: string;
const provider = {
	baseUrl: "https://gateway.example.invalid/v1",
	apiKey: "configured-key",
	models: [{ id: "primary" }],
};
async function write(config: unknown, file = configPath): Promise<void> {
	await Bun.write(file, JSON.stringify(config));
}

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-manual-models-"));
	configPath = path.join(directory, "models.yml");
	auth = await AuthStorage.create(":memory:");
});
afterEach(async () => {
	auth.close();
	await fs.rm(directory, { recursive: true, force: true });
});

describe("manual model registry", () => {
	it("contains no presets when no models file exists", () => {
		const registry = new ModelRegistry(auth, configPath);
		expect(registry.getAll()).toEqual([]);
		expect(registry.getAvailable()).toEqual([]);
		expect(registry.find("openai", "gpt-5")).toBeUndefined();
	});
	it("uses the exact configured endpoint, id and key", async () => {
		await write({ providers: { gateway: provider } });
		const registry = new ModelRegistry(auth, configPath);
		const model = registry.find("gateway", "primary");
		if (!model) throw new Error("Missing manual model");
		expect(model.baseUrl).toBe(provider.baseUrl);
		expect(model.api).toBe("openai-completions");
		expect(registry.getAvailable()).toEqual([model]);
		expect(await registry.getApiKey(model)).toBe("configured-key");
	});
	it("does not fall back to a preset when config specifies a retired protocol", async () => {
		await write({ providers: { gateway: { ...provider, api: "anthropic-messages" } } });
		const registry = new ModelRegistry(auth, configPath);
		expect(registry.getError()?.message).toContain("openai-completions");
		expect(registry.getAll()).toEqual([]);
	});
	it("refreshes only local config and removes deleted endpoints", async () => {
		await write({ providers: { gateway: provider } });
		const registry = new ModelRegistry(auth, configPath);
		await write({ providers: { replacement: { ...provider, baseUrl: "http://localhost:9911/v1" } } });
		await registry.refresh("online");
		expect(registry.find("gateway", "primary")).toBeUndefined();
		expect(registry.find("replacement", "primary")?.baseUrl).toBe("http://localhost:9911/v1");
		expect(auth.keys.source("gateway")).toBeUndefined();
	});
	it("requires credentials unless a configured endpoint explicitly opts out", async () => {
		await write({
			providers: {
				private: { baseUrl: provider.baseUrl, models: provider.models },
				local: { baseUrl: "http://localhost:9911/v1", auth: "none", models: provider.models },
			},
		});
		const registry = new ModelRegistry(auth, configPath);
		expect(registry.getAll()).toHaveLength(2);
		expect(registry.getAvailable().map(model => model.provider)).toEqual(["local"]);
		expect(await registry.getApiKeyForProvider("local")).toBe("N/A");
	});
	it("rejects bad runtime registration before replacing a working endpoint", () => {
		const registry = new ModelRegistry(auth, configPath);
		registry.registerProvider("extension", provider, "source");
		expect(() => registry.registerProvider("extension", { ...provider, api: "openai-responses" }, "source")).toThrow(
			/Unsupported model API/,
		);
		expect(registry.find("extension", "primary")?.api).toBe("openai-completions");
		registry.clearSourceRegistrations("source");
		expect(registry.getAll()).toEqual([]);
		expect(auth.keys.source("extension")).toBeUndefined();
	});
	it("replays overwritten registrations in sequence and follows later removals", () => {
		const owner = new ModelRegistry(auth, configPath);
		owner.registerProvider("a", provider, "first");
		owner.registerProvider("b", provider, "second");
		owner.registerProvider("a", { ...provider, models: [{ id: "updated" }] }, "first");
		const mirror = new ModelRegistry(auth, configPath, { owner });
		const subscription = owner.subscribeMirror(batch => mirror.applyMirrorBatch(batch));
		mirror.applyMirrorBatch(subscription.snapshot);
		expect(mirror.find("a", "updated")).toBeDefined();
		expect(mirror.find("b", "primary")).toBeDefined();
		owner.clearSourceRegistrations("first");
		expect(mirror.find("a", "updated")).toBeUndefined();
		expect(mirror.find("b", "primary")).toBeDefined();
		subscription.unsubscribe();
	});
	it("preserves manual transport when fitting an explicit extended context", () => {
		const registry = new ModelRegistry(auth, configPath);
		const config: ProviderConfigInput = {
			...provider,
			models: [{ id: "primary", contextWindow: 8192, maxContextWindow: 16384 }],
		};
		registry.registerProvider("gateway", config);
		const model = registry.find("gateway", "primary");
		if (!model) throw new Error("Missing model");
		const resolveHeaders = async () => ({ "x-custom": "value" });
		const active = { ...model, baseUrl: "https://temporary.example.invalid/v1", resolveHeaders };
		const fitted = registry.fitContextWindow(active, Settings.isolated({ extendedContext: true }));
		expect(fitted.contextWindow).toBe(16384);
		expect(fitted.baseUrl).toBe(active.baseUrl);
		expect(fitted.resolveHeaders).toBe(resolveHeaders);
	});
	it("uses YAML fallback and prefers canonical YAML without deleting the other file", async () => {
		await write({ providers: { fallback: provider } }, path.join(directory, "models.yaml"));
		const registry = new ModelRegistry(auth, configPath);
		expect(registry.find("fallback", "primary")).toBeDefined();
		await write({ providers: { canonical: provider } });
		await registry.refresh();
		expect(registry.find("canonical", "primary")).toBeDefined();
		expect(registry.find("fallback", "primary")).toBeUndefined();
		expect(await Bun.file(path.join(directory, "models.yaml")).exists()).toBe(true);
	});
});
