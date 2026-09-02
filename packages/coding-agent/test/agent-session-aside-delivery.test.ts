import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("AgentSession aside delivery", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-aside-delivery-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	it("an aside delivered mid-run neither aborts the in-flight tool nor waits for the run to end", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];

		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let abortedDuringTool = false;
		let abortSeen = false;

		const slowTool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Blocks until released",
			parameters: type({}),
			execute: async (_id, _params, signal) => {
				started.resolve();
				abortedDuringTool = signal?.aborted ?? false;
				signal?.addEventListener("abort", () => {
					abortSeen = true;
				});
				await release.promise;
				return { content: [{ type: "text", text: "SLOW_DONE" }] };
			},
		};

		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [slowTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const isFirstCall = callCount === 0;
				callCount++;
				const message: AssistantMessage = isFirstCall
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: "tc-0", name: "slow", arguments: {} }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Done." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: isFirstCall ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[slowTool.name, slowTool]]),
		});

		const run = session.prompt("go");
		await started.promise;

		await session.sendCustomMessage(
			{ customType: "ext-aside", content: "ASIDE_BODY", display: false, attribution: "agent" },
			{ deliverAs: "aside" },
		);

		expect(abortSeen).toBe(false);
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);

		release.resolve();
		await run;
		await session.waitForIdle();

		expect(abortedDuringTool).toBe(false);
		expect(JSON.stringify(contexts[1]!.messages)).toContain("SLOW_DONE");
		expect(JSON.stringify(contexts[1]!.messages)).toContain("ASIDE_BODY");
		const asides = session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "ext-aside",
		);
		expect(asides).toHaveLength(1);
	});

	it("sendUserMessage delivered as an aside mid-run injects at the next step boundary without draining agent-core queues", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];

		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();

		const slowTool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Blocks until released",
			parameters: type({}),
			execute: async () => {
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "SLOW_DONE" }] };
			},
		};

		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [slowTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const isFirstCall = callCount === 0;
				callCount++;
				const message: AssistantMessage = isFirstCall
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: "tc-0", name: "slow", arguments: {} }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "Done." }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: isFirstCall ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[slowTool.name, slowTool]]),
		});

		const run = session.prompt("go");
		await started.promise;

		await session.sendUserMessage("USER_ASIDE_BODY", { deliverAs: "aside" });

		// Not a steer/follow-up: neither agent-core queue drained the aside, so the tool batch
		// keeps running uninterrupted.
		expect(session.agent.hasQueuedMessages()).toBe(false);
		expect(session.agent.peekSteeringQueue()).toHaveLength(0);
		expect(session.agent.peekFollowUpQueue()).toHaveLength(0);

		release.resolve();
		await run;
		await session.waitForIdle();

		expect(JSON.stringify(contexts[1]!.messages)).toContain("SLOW_DONE");
		expect(JSON.stringify(contexts[1]!.messages)).toContain("USER_ASIDE_BODY");
		const userAsides = session.agent.state.messages.filter(
			message => message.role === "user" && JSON.stringify(message.content).includes("USER_ASIDE_BODY"),
		);
		expect(userAsides).toHaveLength(1);
	});

	it("a user aside stranded past run completion resumes as a wake turn carrying the user text", async () => {
		const modelRegistry = new ModelRegistry(authStorage);
		const started = Promise.withResolvers<void>();
		const mock = createMockModel({
			provider: "openai",
			id: "gpt-test",
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
				{ content: ["peer reply"] },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		let observedRecords: unknown[] | undefined;
		session.setIrcWakeTurnObserver(records => {
			observedRecords = records;
			return undefined;
		});

		const run = session.prompt("go");
		await started.promise;
		await session.sendUserMessage("STRANDED_USER_ASIDE", { deliverAs: "aside" });

		// A non-user abort (e.g. an internal mode transition) does not suppress auto-resume like
		// a user Esc does; it just skips the loop's final aside poll on the way out, stranding the
		// aside with no loop left to drain it — exactly the settle race #resumeStrandedIrcAsides /
		// #queueUserMessage's post-queueAside call cover.
		await session.abort({ reason: "internal" });
		await session.waitForIdle();
		await run.catch(() => {});

		expect(observedRecords).toBeDefined();
		expect(JSON.stringify(observedRecords)).toContain("STRANDED_USER_ASIDE");
		const persisted = session.agent.state.messages.some(
			message => message.role === "user" && JSON.stringify(message.content).includes("STRANDED_USER_ASIDE"),
		);
		expect(persisted).toBe(true);
		expect(mock.calls.length).toBe(2);
	});

	it("an idle session receiving an aside starts a turn", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "Acknowledged." }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map(),
		});

		const startedTurn = await session.sendCustomMessage(
			{ customType: "ext-aside", content: "IDLE_ASIDE_BODY", display: false, attribution: "agent" },
			{ deliverAs: "aside" },
		);
		await session.waitForIdle();

		expect(startedTurn).toBe(true);
		expect(contexts).toHaveLength(1);
		expect(JSON.stringify(contexts[0]!.messages)).toContain("IDLE_ASIDE_BODY");
	});
});
