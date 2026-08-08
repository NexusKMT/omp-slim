import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, AppendOnlyContextManager } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// Regression: a keep-alive subagent's AgentSession is disposed at park() but
// stays reachable through the lifecycle adoption record's reviver closure
// (which shares the runSubagent lexical environment that captured the live
// session). Before the fix, dispose() left the message array, append-only
// provider transcript, session-manager entries, and the raw-SSE debug buffer
// intact, so every completed subagent pinned duplicate transcripts and captured
// wire frames. dispose() must shed that heavy state so the pinned graph is only a husk.
// See issue #8003.
describe("AgentSession dispose releases retained memory", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-dispose-release-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		const current = session;
		session = undefined;
		if (current) await current.dispose();
		authStorage.close();
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	function createSession(): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			agentId: "Main",
		});
		return session;
	}

	it("releases all in-memory transcript copies and the raw-SSE buffer on dispose", async () => {
		const current = createSession();
		const bulk = "x".repeat(4096);

		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: bulk }], timestamp: Date.now() },
		];
		current.agent.replaceMessages(messages);
		const appendOnlyContext = new AppendOnlyContextManager();
		appendOnlyContext.syncMessages([{ role: "user", content: bulk }]);
		current.agent.setAppendOnlyContext(appendOnlyContext);
		current.sessionManager.appendMessage({ role: "user", content: bulk, timestamp: Date.now() });
		current.rawSseDebugBuffer.recordEvent(
			{
				event: "content_block_delta",
				data: `data: ${bulk}`,
				raw: ["event: content_block_delta", `data: ${bulk}`],
			},
			current.agent.state.model,
		);

		// Precondition: the heavy state is actually present before dispose.
		expect(current.agent.state.messages.length).toBeGreaterThan(0);
		expect(current.agent.appendOnlyContext).toBe(appendOnlyContext);
		expect(appendOnlyContext.log.length).toBeGreaterThan(0);
		expect(current.sessionManager.getEntries().length).toBeGreaterThan(0);
		expect(current.rawSseDebugBuffer.toRawText().length).toBeGreaterThan(0);

		await current.dispose();
		session = undefined;

		expect(current.agent.state.messages).toHaveLength(0);
		expect(current.sessionManager.getEntries()).toHaveLength(0);
		expect(current.rawSseDebugBuffer.toRawText()).toBe("");
		expect(current.agent.appendOnlyContext).toBeUndefined();
		expect(current.rawSseDebugBuffer.snapshot().records).toHaveLength(0);
	});
});
