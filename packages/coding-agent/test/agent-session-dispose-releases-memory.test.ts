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

	it("waits for the active turn to settle before releasing memory", async () => {
		const current = createSession();
		const bulk = "y".repeat(4096);

		// Seed a captured frame that dispose must ultimately drop.
		current.rawSseDebugBuffer.recordEvent(
			{
				event: "content_block_delta",
				data: `data: ${bulk}`,
				raw: ["event: content_block_delta", `data: ${bulk}`],
			},
			current.agent.state.model,
		);

		const order: string[] = [];
		const reachedSettle = Promise.withResolvers<void>();
		const settle = Promise.withResolvers<void>();
		vi.spyOn(current.agent, "waitForIdle").mockImplementation(async () => {
			order.push("waitForIdle:start");
			reachedSettle.resolve();
			await settle.promise;
			// The aborted loop unwinds during the settle window: it appends its
			// terminal message just before dispose clears the transcript.
			current.agent.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: bulk }],
				timestamp: Date.now(),
			} as AgentMessage);
			order.push("waitForIdle:end");
		});
		const detachResp = current.agent.setProviderResponseInterceptor.bind(current.agent);
		vi.spyOn(current.agent, "setProviderResponseInterceptor").mockImplementation(fn => {
			order.push(`detach:resp:${fn === undefined ? "off" : "on"}`);
			detachResp(fn);
		});
		const reset = current.agent.reset.bind(current.agent);
		vi.spyOn(current.agent, "reset").mockImplementation(() => {
			order.push("reset");
			reset();
		});

		const disposeP = current.dispose();

		// dispose must block on the still-running turn: reaching the settle await
		// wins the race against dispose resolving. If dispose ever finished first
		// it would have cleared the transcript mid-turn (the bug under test).
		const winner = await Promise.race([
			reachedSettle.promise.then(() => "reached" as const),
			disposeP.then(() => "disposed" as const),
		]);
		expect(winner).toBe("reached");

		// The response interceptor was detached before the wait, and nothing has
		// been cleared yet.
		expect(order).toContain("detach:resp:off");
		expect(order.indexOf("detach:resp:off")).toBeLessThan(order.indexOf("waitForIdle:start"));
		expect(order).not.toContain("reset");

		settle.resolve();
		await disposeP;
		session = undefined;

		// reset ran only after the turn settled; the terminal message appended
		// during the unwind and the seeded frame were both dropped.
		expect(order.indexOf("reset")).toBeGreaterThan(order.indexOf("waitForIdle:end"));
		expect(current.agent.state.messages).toHaveLength(0);
		expect(current.rawSseDebugBuffer.snapshot().records).toHaveLength(0);
	});
});
