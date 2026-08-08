import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, AppendOnlyContextManager } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
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

	it("drains in-flight event handlers so a late persist cannot repopulate a disposed session", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		// A real extension whose message_end hook blocks. This models the exact
		// gap the fix closes: agent-core dispatches the session's event handler
		// fire-and-forget, and that handler awaits extension work BEFORE it
		// persists the finished message — so agent.waitForIdle() alone is not
		// enough to know the session is quiescent.
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("message_end", async () => {
					reached.resolve();
					await release.promise;
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"block-message-end",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);

		const current = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			agentId: "Main",
			extensionRunner,
		});
		session = current;

		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "x".repeat(4096) }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		// Dispatch a real message_end: the session handler runs fire-and-forget
		// and parks in the extension hook before it can persist the entry.
		current.agent.emitExternalEvent({ type: "message_end", message });
		await reached.promise;
		expect(current.sessionManager.getEntries()).toHaveLength(0); // persist not reached yet

		// Dispose must not release memory until that in-flight handler settles.
		const reachedSettle = Promise.withResolvers<void>();
		const detach = current.agent.setProviderResponseInterceptor.bind(current.agent);
		vi.spyOn(current.agent, "setProviderResponseInterceptor").mockImplementation(fn => {
			detach(fn);
			reachedSettle.resolve();
		});
		const releaseSpy = vi.spyOn(current.sessionManager, "releaseRetainedEntries");
		const closeSpy = vi.spyOn(current.sessionManager, "close");

		const disposeP = current.dispose();
		await reachedSettle.promise;
		for (let i = 0; i < 10; i++) await Promise.resolve();

		// Blocked draining the in-flight handler: memory release has not run.
		expect(releaseSpy).not.toHaveBeenCalled();
		expect(closeSpy).not.toHaveBeenCalled();

		release.resolve();
		await disposeP;
		session = undefined;

		// The late persist landed during the drain and was then cleared, so the
		// disposed session retains neither the entry nor the message.
		expect(releaseSpy).toHaveBeenCalledTimes(1);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(current.sessionManager.getEntries()).toHaveLength(0);
		expect(current.agent.state.messages).toHaveLength(0);
	});

	it("preserves the agent_end transcript for an asynchronous extension during dispose", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const notificationDone = Promise.withResolvers<void>();
		let observedMessageCount = -1;
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("agent_end", async event => {
					reached.resolve();
					await release.promise;
					observedMessageCount = event.messages.length;
					notificationDone.resolve();
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"block-agent-end",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		const current = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			agentId: "Main",
			extensionRunner,
		});
		session = current;
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "terminal transcript" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		agent.replaceMessages([message]);
		agent.emitExternalEvent({ type: "agent_end", messages: agent.state.messages });
		await reached.promise;

		const resetDone = Promise.withResolvers<void>();
		const reset = agent.reset.bind(agent);
		vi.spyOn(agent, "reset").mockImplementation(() => {
			reset();
			resetDone.resolve();
		});
		const disposeP = current.dispose();
		await resetDone.promise;
		expect(agent.state.messages).toHaveLength(0);

		release.resolve();
		await notificationDone.promise;
		await disposeP;
		session = undefined;
		expect(observedMessageCount).toBe(1);
	});
});
