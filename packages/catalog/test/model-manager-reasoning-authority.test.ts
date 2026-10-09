import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

test("opting into authoritative reasoning refreshes an old cache and preserves a live false through offline reload", async () => {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "reasoning-authority-"));
	const bundled: ModelSpec<"openai-completions"> = {
		id: "future-model",
		name: "Future model",
		provider: "custom",
		api: "openai-completions",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 8192,
		thinking: { mode: "effort", efforts: [Effort.High] },
	};
	let fetches = 0;
	const options = {
		providerId: "custom",
		staticModels: [bundled],
		cacheDbPath: path.join(tempDir, "models.db"),
		fetchDynamicModels: async () => {
			fetches++;
			return [{ ...bundled, reasoning: false, thinking: undefined }];
		},
	};
	try {
		// Default merge behavior remains additive for providers that omit capabilities.
		const legacy = await resolveProviderModels(options, "online");
		expect(legacy.models[0]?.reasoning).toBe(true);
		const authoritative = { ...options, dynamicReasoningAuthoritative: true };
		const refreshed = await resolveProviderModels(authoritative, "online-if-uncached");
		expect(fetches).toBe(2);
		expect(refreshed.models[0]?.reasoning).toBe(false);
		expect(refreshed.models[0]?.thinking).toBeUndefined();
		const offline = await resolveProviderModels(authoritative, "offline");
		expect(fetches).toBe(2);
		expect(offline.models[0]?.reasoning).toBe(false);
		expect(offline.models[0]?.thinking).toBeUndefined();
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});
