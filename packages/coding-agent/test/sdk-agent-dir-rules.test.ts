import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { clearCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "agent-dir-rules-model",
		name: "Agent Dir Rules Model",
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

async function writeFile(filePath: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, content);
}

let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-agent-dir-rules-");
	// The process-global agent dir: a session given its own agentDir must not read it.
	setAgentDir(tempDir.join("default-agent"));
	clearCache();
});

afterEach(() => {
	if (originalAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
	__resetDirsFromEnvForTests();
	clearCache();
	tempDir.removeSync();
});

describe("createAgentSession with agentDir", () => {
	it.each([
		{
			lane: "rules/ directory",
			file: path.join("rules", "marker.md"),
			body: (marker: string) => `---\nalwaysApply: true\n---\n${marker}\n`,
		},
		{ lane: "RULES.md", file: "RULES.md", body: (marker: string) => `${marker}\n` },
	])("loads user rules from its agentDir's $lane, not the default agent dir", async ({ file, body }) => {
		const marker = Bun.nanoseconds().toString(36);
		const scopedRule = `SCOPED_RULE_${marker}`;
		const defaultRule = `DEFAULT_RULE_${marker}`;
		const agentDir = tempDir.join("scoped-agent");
		await writeFile(path.join(agentDir, file), body(scopedRule));
		await writeFile(tempDir.join("default-agent", file), body(defaultRule));
		const cwd = tempDir.join("project");
		await fs.mkdir(cwd, { recursive: true });

		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("managed-primary", "test-key");
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildLocalModel(`agent-dir-rules-${marker}`),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			// Session creation reads rules once; a session reset re-reads them from disk.
			const initial = session.systemPrompt.join("\n");
			expect(initial).toContain(scopedRule);
			expect(initial).not.toContain(defaultRule);

			expect(await session.newSession()).toBeTruthy();
			const rebuilt = session.systemPrompt.join("\n");
			expect(rebuilt).toContain(scopedRule);
			expect(rebuilt).not.toContain(defaultRule);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});
