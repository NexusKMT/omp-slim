import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "context-reload-model",
		name: "Context Reload Model",
		api,
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

describe("AgentSession context-file reload on session reset", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Regression for #9273: /clear and /new (both go through newSession) must
	// re-read AGENTS.md from disk. Context-file discovery reads through the
	// process-lifetime cache in capability/fs.ts; before the fix that cache was
	// only cleared on chdir, so an edited AGENTS.md stayed stale until restart.
	it("re-reads an edited AGENTS.md into the base prompt after newSession()", async () => {
		using tempDir = TempDir.createSync("@pi-context-reload-");
		const marker = Bun.nanoseconds().toString(36);
		const original = `ORIGINAL_RULES_${marker}`;
		const updated = `UPDATED_RULES_${marker}`;
		const agentsMd = path.join(tempDir.path(), "AGENTS.md");
		await fs.writeFile(agentsMd, original);

		const api = `context-reload-${marker}`;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildLocalModel(api),
			disableExtensionDiscovery: true,
			skills: [],
			// contextFiles intentionally omitted so discovery runs against disk.
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			await session.refreshBaseSystemPrompt();
			expect(session.systemPrompt.join("\n")).toContain(original);

			// User edits AGENTS.md mid-session.
			await fs.writeFile(agentsMd, updated);

			// /clear and /new both funnel through newSession().
			expect(await session.newSession()).toBe(true);

			const rebuilt = session.systemPrompt.join("\n");
			expect(rebuilt).toContain(updated);
			expect(rebuilt).not.toContain(original);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
