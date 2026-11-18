import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-ai/build";
import { runModelsListing } from "../../src/cli/models-cli";
import { ModelRegistry } from "../../src/config/model-registry";

const testModel = buildModel({
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
});

describe("ModelRegistry", () => {
	let tmpDir: string;
	let registry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-reg-"));
		authStorage = await AuthStorage.create(":memory:");
		// Construct with an explicit modelsPath inside the temp dir so the
		// constructor's #loadModels read returns "not-found" rather than
		// touching the host's ~/.omp/agent/models.yaml. isBunTestRuntime()
		// auto-stubs #fetch in the constructor.
		registry = new ModelRegistry(authStorage, path.join(tmpDir, "models.yaml"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage.close();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	async function listModels(additionalExtensionPaths: string[] = []): Promise<{ stdout: string; stderr: string }> {
		let stdout = "";
		let stderr = "";
		const out = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += String(chunk);
			return true;
		});
		const err = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderr += String(chunk);
			return true;
		});
		try {
			await runModelsListing({
				modelRegistry: registry,
				cwd: tmpDir,
				json: true,
				additionalExtensionPaths,
				disableExtensionDiscovery: true,
			});
		} finally {
			out.mockRestore();
			err.mockRestore();
		}
		return { stdout, stderr };
	}

	test("resolves API keys and provider headers for legacy extensions", async () => {
		const model = testModel;
		vi.spyOn(registry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(registry, "resolveModelHeaders").mockResolvedValue({ "x-test": "value" });

		expect(await registry.getApiKeyAndHeaders(model)).toEqual({
			ok: true,
			apiKey: "test-key",
			headers: { "x-test": "value" },
		});
	});

	test("returns an error when authentication resolves without a credential", async () => {
		expect(await registry.getApiKeyAndHeaders(testModel)).toEqual({
			ok: false,
			error: 'No API key configured for "test".',
		});
	});
});
