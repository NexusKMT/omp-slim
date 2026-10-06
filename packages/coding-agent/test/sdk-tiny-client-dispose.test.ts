import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { tinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { TempDir } from "@oh-my-pi/pi-utils";

const model = buildModel({
	id: "tiny-client-dispose",
	name: "Tiny client dispose",
	api: "test-tiny-client-dispose",
	provider: "managed-primary",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 1024,
} as ModelSpec<Api>) as Model<Api>;

// The tiny-model client is a process singleton; terminating it fails every request
// in flight, so only the session that owns process state may shut it down.
describe("tiny-model client shutdown on session dispose", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			if (!session.isDisposed) await session.dispose();
		}
		vi.restoreAllMocks();
	});

	const starter = async (tempDir: TempDir) => {
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const start = async (
			settings: Settings,
			extra: Pick<CreateAgentSessionOptions, "parentTaskPrefix" | "taskDepth" | "agentId" | "bindProcessState"> = {},
		): Promise<AgentSession> => {
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry,
				settings,
				model,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				...extra,
			});
			sessions.push(session);
			return session;
		};
		return { start, close: () => authStorage.close() };
	};

	it("only the parent session's dispose terminates the shared client", async () => {
		using tempDir = TempDir.createSync("@pi-tiny-client-dispose-");
		const { start, close } = await starter(tempDir);
		const terminate = vi.spyOn(tinyTitleClient, "terminate").mockResolvedValue();
		try {
			const parentSettings = Settings.isolated({ "compaction.enabled": false });
			const parent = await start(parentSettings);

			const sub = await start(createSubagentSettings(parentSettings), {
				parentTaskPrefix: "0-Sub",
				taskDepth: 1,
				agentId: "0-Sub",
			});
			await sub.dispose();
			expect(terminate).not.toHaveBeenCalled();

			const helper = await start(await parentSettings.cloneForCwd(tempDir.path()), { bindProcessState: false });
			await helper.dispose();
			expect(terminate).not.toHaveBeenCalled();

			await parent.dispose();
			expect(terminate).toHaveBeenCalledTimes(1);
		} finally {
			close();
		}
	});
});
