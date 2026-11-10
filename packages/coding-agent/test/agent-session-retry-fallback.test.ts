import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
	type ProviderSessionState,
	type ToolCall,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getTestModel as getBundledModel } from "../../catalog/test/fixtures/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { __resetDirsFromEnvForTests, TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";
import { restoreEnvValue } from "./helpers/settings-test-state";

type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;
type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

function trackRetryEvents(session: AgentSession): {
	retryStartEvents: AutoRetryStartEvent[];
	retryEndEvents: AutoRetryEndEvent[];
} {
	const retryStartEvents: AutoRetryStartEvent[] = [];
	const retryEndEvents: AutoRetryEndEvent[] = [];
	session.subscribe(event => {
		if (event.type === "auto_retry_start") {
			retryStartEvents.push(event);
		}
		if (event.type === "auto_retry_end") {
			retryEndEvents.push(event);
		}
	});
	return { retryStartEvents, retryEndEvents };
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage {
	const lastMessage = session.messages.at(-1);
	if (lastMessage?.role !== "assistant") {
		throw new Error("Expected final assistant message");
	}
	return lastMessage;
}

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** A stream that terminates with a `ThinkingLoop`-flagged error, exactly as the
 *  loop guard aborts a repetitive reasoning stream (issue #8760). */
function thinkingLoopErrorStream(model: Model<Api>): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "error",
			errorMessage:
				"Thinking loop detected: the model repeated near-identical content (4 near-identical segments within the last 16). Treating as a stream stall and retrying.",
			errorId: AIError.create(AIError.Flag.ThinkingLoop),
			timestamp: Date.now(),
		};
		stream.push({ type: "error", reason: "error", error: partial });
	});
	return stream;
}

/** A stream that completes normally with a single text block. */
function recoveredTextStream(model: Model<Api>, text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "start", partial });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
		stream.push({ type: "done", reason: "stop", message: partial });
	});
	return stream;
}
function transportErrorAfterToolCallStream(
	model: Model<Api>,
	toolCall: ToolCall,
	thinkingSignature?: string,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const thinking =
			thinkingSignature === undefined
				? undefined
				: {
						type: "thinking" as const,
						thinking: "Signed reasoning before the tool call.",
						thinkingSignature,
					};
		if (thinking) partial.content.push(thinking);
		const toolCallIndex = partial.content.length;
		partial.content.push(toolCall);
		stream.push({ type: "start", partial });
		if (thinking) {
			stream.push({ type: "thinking_start", contentIndex: 0, partial });
			stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinking.thinking, partial });
			stream.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial });
		}
		stream.push({ type: "toolcall_start", contentIndex: toolCallIndex, partial });
		stream.push({
			type: "toolcall_delta",
			contentIndex: toolCallIndex,
			delta: JSON.stringify(toolCall.arguments),
			partial,
		});
		stream.push({ type: "toolcall_end", contentIndex: toolCallIndex, toolCall, partial });
		stream.push({
			type: "error",
			reason: "error",
			error: {
				...partial,
				stopReason: "error",
				errorMessage: "The socket connection was closed unexpectedly.",
				duration: 1000,
			},
		});
	});
	return stream;
}

describe("AgentSession same-model recovery", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sharedRegistry: ModelRegistry;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	// Restored in afterEach after any test that redirects the agent dir.
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalPiProfile = process.env.PI_PROFILE;
	const originalOmpProfile = process.env.OMP_PROFILE;

	// The model registry is an immutable fixture whose construction builds a
	// canonical index over ~2.7k bundled models (~100ms). Build it (and the
	// auth DB) once for the whole file instead of per-test; reset only the
	// mutable retry-fallback cooldown state between tests.
	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-fallback-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		authStorage.keys.setRuntime("fireworks", "fireworks-test-key");
		authStorage.keys.setRuntime("google", "google-test-key");
		authStorage.keys.setRuntime("google-vertex", "google-vertex-test-key");
		authStorage.keys.setRuntime("openrouter", "openrouter-test-key");
		authStorage.keys.setRuntime("devin", "devin-test-key");
		authStorage.keys.setRuntime("openai-codex", "openai-codex-test-key");
		sharedRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		// Reset to the shared registry (a few tests reassign it to a scoped
		// instance) and clear cooldown suppressions left by fallback-path tests
		// (default 5-minute suppression) so state never leaks between tests.
		modelRegistry = sharedRegistry;
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
		restoreEnvValue("PI_CODING_AGENT_DIR", originalAgentDir);
		restoreEnvValue("PI_PROFILE", originalPiProfile);
		restoreEnvValue("OMP_PROFILE", originalOmpProfile);
		__resetDirsFromEnvForTests();
	});

	it("does not reschedule a queued drain after a dequeue hook rejects", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled queued-drain model");
		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return createMockModel().stream(model, context, options);
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false });
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const hookRan = Promise.withResolvers<void>();
		let attempts = 0;
		const failingHook = vi.fn(() => {
			hookRan.resolve();
			if (++attempts === 1) throw new Error("blocked before dequeue");
		});
		agent.addBeforeQueuedMessageDequeueHook(failingHook);

		await session.sendUserMessage("Keep this queued", { deliverAs: "steer" });
		await hookRan.promise;
		await session.waitForIdle();

		expect(failingHook).toHaveBeenCalledTimes(1);
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(requestedModels).toEqual([]);
	});

	it("rotates sibling credentials on 402 Payment is required and status-only 402 without invoking model fallback", async () => {
		const primaryModel = getBundledModel("openai", "gpt-4o") ?? getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("google", "gemini-1.5-pro") ?? getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		// The mock model reduces a thrown error to its message text (a `status`
		// property never reaches the AssistantMessage), so carry the 402 inside
		// the message: the first iteration exercises the quota-worded body, the
		// second an opaque status-only body.
		for (const errorToThrow of [new Error("HTTP 402 Payment is required"), new Error("HTTP 402")]) {
			const requestedCalls: Array<{ model: string; apiKey: string | undefined }> = [];
			let currentKey = "key-A";
			const mock = createMockModel();
			const agent = new Agent({
				getApiKey: () => currentKey,
				initialState: {
					model: primaryModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (model, context, options) => {
					const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
					requestedCalls.push({ model: `${model.provider}/${model.id}`, apiKey });
					if (requestedCalls.length === 1) {
						mock.push({ throw: errorToThrow });
					} else {
						mock.push({ content: ["ok:sibling-credential-success"] });
					}
					return mock.stream(model, context, options);
				},
			});

			// `vi.spyOn` on an already-spied method returns the existing spy with
			// its accumulated call history, so clear it between the parameterized
			// iterations — each must observe exactly one credential rotation.
			const markUsageLimitSpy = vi
				.spyOn(modelRegistry.authStorage.limits, "markReached")
				.mockClear()
				.mockImplementation(async () => {
					currentKey = "key-B";
					return { switched: true };
				});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 1,
				"retry.maxRetries": 2,
				"retry.modelFallback": true,
				"retry.fallbackChains": {
					[`${primaryModel.provider}/${primaryModel.id}`]: [`${fallbackModel.provider}/${fallbackModel.id}`],
				},
			});

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
			});

			await session.prompt("Prompt requiring credential rotation");
			await session.waitForIdle();

			expect(markUsageLimitSpy).toHaveBeenCalledTimes(1);
			expect(requestedCalls).toHaveLength(2);
			expect(requestedCalls[0]).toEqual({
				model: `${primaryModel.provider}/${primaryModel.id}`,
				apiKey: "key-A",
			});
			expect(requestedCalls[1]).toEqual({
				model: `${primaryModel.provider}/${primaryModel.id}`,
				apiKey: "key-B",
			});
			expect(session.model?.provider).toBe(primaryModel.provider);
			expect(session.model?.id).toBe(primaryModel.id);
			await session.dispose();
			session = undefined;
		}
	});

	it("surfaces immutable Anthropic thinking errors without retry fallback", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("anthropic", "claude-opus-4-5");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled Anthropic test models to exist");
		}

		const immutableThinkingError =
			"400 invalid_request_error: messages.1.content.5: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified";
		const mock = createMockModel();
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		let requestCount = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestCount++;
				requestedModels.push(`${model.provider}/${model.id}`);
				if (requestCount === 1) {
					mock.push({
						content: [
							{ type: "thinking", thinking: "Signed Sonnet reasoning.", thinkingSignature: "sonnet-signature" },
							"Seeded turn",
						],
					});
				} else {
					mock.push({ throw: immutableThinkingError });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": {
				"anthropic/*": [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents } = trackRetryEvents(session);
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Seed signed thinking");
		await session.waitForIdle();
		await session.prompt("Continue");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([]);
		expect(retryStartEvents).toEqual([]);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(getLastAssistantMessage(session)).toMatchObject({
			stopReason: "error",
			errorMessage: immutableThinkingError,
		});
	});

	it("keeps signed Anthropic thinking on its source model during transient retry", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("anthropic", "claude-opus-4-5");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled Anthropic test models to exist");
		}

		const mock = createMockModel();
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		let requestCount = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestCount++;
				requestedModels.push(`${model.provider}/${model.id}`);
				if (requestCount === 1) {
					mock.push({
						content: [
							{ type: "thinking", thinking: "Signed Sonnet reasoning.", thinkingSignature: "sonnet-signature" },
							"Seeded turn",
						],
					});
				} else if (requestCount === 2) {
					mock.push({ throw: "503 overloaded_error: provider returned error" });
				} else {
					mock.push({ content: ["Recovered on Sonnet"] });
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				"anthropic/*": [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Seed signed thinking");
		await session.waitForIdle();
		const seededAssistant = agent.state.messages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		if (!seededAssistant) throw new Error("Expected seeded assistant message");
		seededAssistant.api = primaryModel.api;
		seededAssistant.provider = primaryModel.provider;
		seededAssistant.model = primaryModel.id;
		await session.prompt("Retry a transient failure");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true })]);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(getLastAssistantMessage(session).stopReason).toBe("stop");
	});

	it("keeps signed thinking in a preserved transport-error turn on its source Anthropic model", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("anthropic", "claude-opus-4-5");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled Anthropic test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "signed-transport-call",
			name: "bash",
			arguments: { command: "ssh host" },
		};
		let requestCount = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestCount++;
				requestedModels.push(`${model.provider}/${model.id}`);
				if (requestCount === 1) {
					return transportErrorAfterToolCallStream(model, toolCall, "sonnet-signature");
				}
				const mock = createMockModel({ id: model.id, provider: model.provider });
				mock.push({ content: ["Recovered on Sonnet"] });
				return mock.stream(mock, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				"anthropic/*": [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackAppliedEvents.push(event);
		});

		await session.prompt("Run a signed tool turn");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(fallbackAppliedEvents).toEqual([]);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(getLastAssistantMessage(session).stopReason).toBe("stop");
	});

	it("surfaces a non-retryable error without same-model retries when no fallback candidate has a credential", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation((model, sessionId) =>
			model.provider === fallbackModel.provider ? Promise.resolve(undefined) : originalGetApiKey(model, sessionId),
		);

		const mock = createMockModel();
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				mock.push({ throw: "unrecoverable model quirk" });
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": {
				"anthropic/*": [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});

		await session.prompt("Fail hard with no fallback credential");
		await session.waitForIdle();

		// The switch could not happen and the error is non-retryable: surface it
		// after a single attempt instead of backoff-retrying the failing model.
		expect(requestedModels).toEqual([`${primaryModel.provider}/${primaryModel.id}`]);
		expect(fallbackAppliedEvents).toEqual([]);
		expect(getLastAssistantMessage(session).stopReason).toBe("error");
	});

	it("drops classifier refusal messages before later prompts", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) {
			throw new Error("Expected bundled test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{
					content: ["Classifier declined this turn."],
					stopReason: "error",
					stopDetails: {
						type: "refusal",
						category: "bio",
						explanation: "Classifier declined this turn.",
					},
					errorMessage: "Refusal (bio): Classifier declined this turn.",
				},
				context => {
					const replayedAssistantText = context.messages
						.filter((message): message is AssistantMessage => message.role === "assistant")
						.flatMap(message => message.content)
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n");
					return {
						content: [replayedAssistantText.includes("Classifier declined this turn.") ? "polluted" : "clean"],
					};
				},
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => mock.stream(model, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		const sessionStopCalls: number[] = [];
		const sessionStopLastAssistantMessages: Array<AssistantMessage | undefined> = [];
		const extensionRunner = {
			emit: vi.fn().mockResolvedValue(undefined),
			emitBeforeAgentStart: vi.fn().mockResolvedValue(undefined),
			hasHandlers: vi.fn((eventType: string) => eventType === "session_stop"),
			emitSessionStop: vi.fn((event: { last_assistant_message?: AssistantMessage }) => {
				sessionStopCalls.push(mock.calls.length);
				sessionStopLastAssistantMessages.push(event.last_assistant_message);
				return Promise.resolve(undefined);
			}),
		} as unknown as ExtensionRunner;

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			extensionRunner,
		});

		await session.prompt("Trigger classifier refusal");
		await session.waitForIdle();
		await session.prompt("Next prompt should not replay the refusal");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		const replayedAssistantText = mock.calls[1]?.context.messages
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.flatMap(message => message.content)
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(replayedAssistantText).not.toContain("Classifier declined this turn.");
		expect(getLastAssistantMessage(session).content).toEqual([{ type: "text", text: "clean" }]);
		// session_stop hooks must fire after each settled turn — including the
		// refusal turn (regression: prior to PR #3594's review fix, the refusal
		// branch short-circuited before `#emitSessionStopEvent`).
		expect(sessionStopCalls).toEqual([1, 2]);
		expect(sessionStopLastAssistantMessages[0]?.stopReason).toBe("error");
		expect(sessionStopLastAssistantMessages[0]?.stopDetails).toEqual({
			type: "refusal",
			category: "bio",
			explanation: "Classifier declined this turn.",
		});
	});

	it("keeps the pruned refusal visible to getLastAssistantMessage until the next run", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) {
			throw new Error("Expected bundled test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{
					stopReason: "error",
					stopDetails: { type: "refusal", category: "cyber", explanation: "Declined." },
					errorMessage: "Refusal (cyber): Declined.",
				},
				{ content: ["recovered"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => mock.stream(model, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		await session.prompt("Trigger classifier refusal");
		await session.waitForIdle();

		// The refusal turn is pruned from active context (no assistant tail)…
		expect(session.agent.state.messages.at(-1)?.role).toBe("user");
		// …but terminal-outcome consumers (print mode, task executor) must still
		// see the settled error instead of a silently successful-looking state.
		const settled = session.getLastAssistantMessage();
		expect(settled?.stopReason).toBe("error");
		expect(settled?.errorMessage).toBe("Refusal (cyber): Declined.");
		expect(settled?.stopDetails).toEqual({ type: "refusal", category: "cyber", explanation: "Declined." });

		await session.prompt("Next prompt supersedes the pruned refusal");
		await session.waitForIdle();

		const recovered = session.getLastAssistantMessage();
		expect(recovered?.stopReason).toBe("stop");
		expect(recovered?.content).toEqual([{ type: "text", text: "recovered" }]);
	});

	it("emits auto_retry_end when a mid-saga classifier refusal has no fallback to switch to", async () => {
		// Regression: `#handleRetryableError`'s classifier-refusal branch used to
		// return `false` without emitting `auto_retry_end` whenever no fallback
		// model was available to switch to. A saga that already announced
		// `auto_retry_start` on an earlier (non-refusal) attempt would then never
		// get a matching `auto_retry_end` — leaving any subscriber tracking
		// "retry outstanding" state (e.g. suppressing a duplicate error toast)
		// latched open forever. With `retry.maxRetries: 2` and no fallback chain
		// configured, the second attempt's classifier refusal hits that branch
		// while `retryAttempt (2) <= maxRetries (2)`, so it can't fall through
		// the pre-existing maxRetries-exceeded path (which already emits
		// `auto_retry_end`) — isolating the branch this regression covers.
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) {
			throw new Error("Expected bundled test model to exist");
		}

		const requestedModels: string[] = [];
		const refusalMessage = "Refusal (cyber): Classifier declined this retried turn.";
		const mock = createMockModel();
		let calls = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				calls += 1;
				if (calls === 1) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else if (calls === 2) {
					mock.push({
						stopReason: "error",
						stopDetails: { type: "refusal", category: "cyber", explanation: "Classifier declined." },
						errorMessage: refusalMessage,
					});
				} else {
					throw new Error(`Unexpected model call after the classifier refusal settled: call ${calls}`);
				}
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 2,
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry once, then hit a classifier refusal with no fallback");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]?.attempt).toBe(1);
		expect(retryEndEvents).toEqual([
			{
				type: "auto_retry_end",
				success: false,
				attempt: 1,
				finalError: refusalMessage,
			},
		]);
	});

	it("uses Google retry hints in quota errors before quota backoff", async () => {
		const model = getBundledModel("google", "gemini-1.5-flash");
		if (!model) {
			throw new Error("Expected bundled Google test model to exist");
		}

		const errorMessage =
			"Google API error (429): Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000. Please retry in 0.05s.";
		const requestedModels: string[] = [];
		const mock = createMockModel({
			responses: [{ throw: errorMessage }, { content: ["Recovered after Google quota retry"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		mockSchedulerWaitWithClock();
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry Google token quota");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			delayMs: 50,
			errorMessage,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after Google quota retry" });
	});

	it("ignores a legacy enabled fallback chain and retries the current model", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const fallbackSucceededEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];
		const mock = createMockModel({
			responses: [{ throw: "rate limit exceeded retry-after-ms=200" }, { content: ["Recovered on primary retry"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: primaryModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": true,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${primaryModel.provider}/${primaryModel.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		mockSchedulerWaitWithClock();
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
			if (event.type === "retry_fallback_succeeded") {
				fallbackSucceededEvents.push(event);
			}
		});

		await session.prompt("Retry rate limit without switching models");
		await session.waitForIdle();

		expect(requestedModels).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			delayMs: 200,
			errorMessage: "rate limit exceeded retry-after-ms=200",
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		expect(fallbackAppliedEvents).toHaveLength(0);
		expect(fallbackSucceededEvents).toHaveLength(0);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered on primary retry" });
	});

	it("auto-retries preserved OpenAI first-event timeout errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const timeoutMessage = "OpenAI responses stream timed out while waiting for the first event";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: timeoutMessage }, { content: ["Recovered after OpenAI timeout"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry preserved OpenAI timeout");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: timeoutMessage,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after OpenAI timeout" });
	});

	it("auto-retries stream stall errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const stallMessage = "Provider stream stalled while waiting for the next event";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: stallMessage }, { content: ["Recovered after stream stall"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry stream stall");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: stallMessage,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after stream stall" });
	});

	it("auto-retries OpenAI processing-request transient errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const processingError =
			"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 4a4c6b73-a07c-4de0-aaaf-82560f9f626a in your message.";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: processingError }, { content: ["Recovered after OpenAI processing error"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry OpenAI processing-request error");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: processingError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({
			type: "text",
			text: "Recovered after OpenAI processing error",
		});
	});

	it("restarts Responses provider state before retrying stale item-id replay errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		const staleReplayError = "Item with id 'rs_stale' not found.";
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const mock = createMockModel({
			responses: [{ throw: staleReplayError }, { content: ["Recovered after Responses state reset"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});
		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-responses:openai", {
			close: closeSpy,
		} satisfies ProviderSessionState);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry stale OpenAI replay");
		await session.waitForIdle();

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.has("openai-responses:openai")).toBe(true);
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(fallbackAppliedEvents).toHaveLength(0);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			delayMs: 0,
			errorMessage: staleReplayError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({
			type: "text",
			text: "Recovered after Responses state reset",
		});
	});

	it("restarts Responses provider state before retrying Zero Data Retention errors", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}

		// Mirrors the live wire error from OpenAI ZDR orgs after the in-provider
		// retry has already exhausted itself; the higher-level retry must still
		// classify the failure as a stale-replay event so the session reset and
		// zero-delay backoff fire instead of a model fallback.
		const zdrReplayError = "400 Previous response cannot be used for this organization due to Zero Data Retention.";
		const requestedModels: string[] = [];
		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const mock = createMockModel({
			responses: [{ throw: zdrReplayError }, { content: ["Recovered after ZDR reset"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.fallbackChains": {
				default: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") {
				fallbackAppliedEvents.push(event);
			}
		});
		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-responses:openai", {
			close: closeSpy,
		} satisfies ProviderSessionState);
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry ZDR replay");
		await session.waitForIdle();

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.has("openai-responses:openai")).toBe(true);
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(fallbackAppliedEvents).toHaveLength(0);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			delayMs: 0,
			errorMessage: zdrReplayError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after ZDR reset" });
	});

	it("auto-retries Anthropic stream-envelope failures before message_stop", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const envelopeError = "Anthropic stream envelope error: stream ended before message_stop";
		const requestedModels: string[] = [];

		const mock = createMockModel({
			responses: [{ throw: envelopeError }, { content: ["Recovered after Anthropic envelope retry"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("Retry Anthropic envelope failure before message_stop");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({
			attempt: 1,
			maxAttempts: 1,
			errorMessage: envelopeError,
		});
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const lastAssistant = getLastAssistantMessage(session);
		expect(lastAssistant.stopReason).toBe("stop");
		expect(lastAssistant.content).toContainEqual({ type: "text", text: "Recovered after Anthropic envelope retry" });
	});

	it("closes the retry lifecycle when a retried turn ends with a non-retryable error", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled OpenAI test model to exist");

		const retryableError = "rate limit exceeded retry-after-ms=5";
		const terminalError = "invalid request: schema violation";
		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				mock.push({ throw: requestedModels.length === 1 ? retryableError : terminalError });
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);
		mockSchedulerWaitWithClock();

		await session.prompt("Retry once, then surface a terminal validation failure");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([
			expect.objectContaining({ success: false, attempt: 1, finalError: terminalError }),
		]);
		expect(session.retryAttempt).toBe(0);
		expect(getLastAssistantMessage(session).stopReason).toBe("error");
	});

	it("resolves awaitInitialBackgroundRefresh for a refresh started after the waiter is armed", async () => {
		const modelsConfigPath = path.join(tempDir.path(), "late-refresh-models.json");
		await Bun.write(
			modelsConfigPath,
			JSON.stringify({
				providers: {
					litellm: {
						baseUrl: "https://litellm.example.net/v1",
						api: "openai-completions",
						discovery: { type: "litellm" },
					},
				},
			}),
		);
		const registry = new ModelRegistry(authStorage, modelsConfigPath);
		const cancelled = new AbortController();
		const cancelledWaiter = registry.awaitInitialBackgroundRefresh(cancelled.signal);
		cancelled.abort();
		await cancelledWaiter;

		// The CLI starts background discovery only after the session — and thus
		// this awaiter — is constructed, so a waiter armed before any refresh must
		// still resolve when the later refresh settles (#10048).
		let settled = false;
		const waiter = registry.awaitInitialBackgroundRefresh().then(() => {
			settled = true;
		});
		await scheduler.wait(10);
		expect(settled).toBe(false);

		registry.refreshInBackground("offline");
		await waiter;
		expect(settled).toBe(true);

		// Once settled, a fresh waiter resolves immediately.
		await registry.awaitInitialBackgroundRefresh();
	});

	it("rebinds the active model to its post-discovery same-selector window (#10488)", async () => {
		// A discovery-backed provider whose live catalog caps a selector below the
		// window the pre-discovery snapshot carried at startup — the same class as
		// the GitHub Copilot gpt-5.6-sol split, where the bundled base ships the
		// full long-context window and discovery caps it to the default tier.
		authStorage.keys.setRuntime("ollama-cloud", "ollama-cloud-test-key");
		const buildTieredModel = (contextWindow: number, input: Model<"ollama-chat">["input"]): Model<"ollama-chat"> =>
			buildModel({
				id: "deepseek-v4-tiered",
				name: "DeepSeek V4 Tiered",
				api: "ollama-chat",
				provider: "ollama-cloud",
				baseUrl: "https://ollama.com",
				reasoning: true,
				input,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow,
				maxTokens: 32_000,
			});
		// Post-discovery catalog: the capped entry the registry resolves for the
		// selector once background discovery settles.
		writeModelCache(
			"ollama-cloud",
			Date.now(),
			[buildTieredModel(400_000, ["text"])],
			true,
			"",
			path.join(tempDir.path(), "models.db"),
		);
		const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.json"));

		// The startup-bound model is the pre-discovery snapshot for the SAME
		// selector with the full long-context window — what buildSessionOptions
		// pins as options.model before discovery runs.
		const staleModel = buildTieredModel(1_050_000, ["text", "image"]);
		const settings = Settings.isolated({ "compaction.enabled": false });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: staleModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: () => {
				throw new Error("Not exercised");
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
			rebindModelAfterDiscovery: true,
		});

		// Stale until discovery settles: the active model and its context-usage
		// derivation both carry the 1.05M window that contradicts the catalog.
		expect(session.model?.contextWindow).toBe(1_050_000);
		expect(session.getContextUsage()?.contextWindow).toBe(1_050_000);

		const { promise: modelChanged, resolve: resolveModelChanged } = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "model_changed") {
				unsubscribe();
				resolveModelChanged();
			}
		});

		// The CLI starts discovery only after the session is built; the rebind
		// waiter armed in the constructor resolves once this settles.
		registry.refreshInBackground("offline");
		await Promise.race([
			modelChanged,
			scheduler.wait(5_000).then(() => {
				throw new Error("model_changed was not emitted after discovery settled");
			}),
		]);

		// Rebound to the same selector's refreshed 400K window without a manual
		// re-selection; get_state / contextUsage now agree with the catalog.
		expect(session.model?.id).toBe("deepseek-v4-tiered");
		expect(session.model?.contextWindow).toBe(400_000);
		expect(session.getContextUsage()?.contextWindow).toBe(400_000);
	});

	it("auto-retries Gemini MALFORMED_FUNCTION_CALL after an unexecuted tool call", async () => {
		const model = getBundledModel("google", "gemini-1.5-flash");
		if (!model) {
			throw new Error("Expected bundled Google test model to exist");
		}

		const malformedError = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL";
		const requestedModels: string[] = [];
		let toolExecutions = 0;
		const toolSchema = type({ value: type("string") });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "record",
			label: "Record",
			description: "Record a value",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				toolExecutions += 1;
				return { content: [{ type: "text", text: params.value }], details: params };
			},
		};

		const mock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "malformed-call",
							name: "record",
							arguments: { value: "must-not-execute" },
						},
					],
					stopReason: "error",
					errorMessage: malformedError,
				},
				{ content: ["Recovered after Gemini malformed function call"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [tool],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				requestedModels.push(`${requestedModel.provider}/${requestedModel.id}`);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("recover from Gemini malformed error");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(toolExecutions).toBe(0);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		const messages = session.agent.state.messages;
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const failedAssistant = messages[1];
		if (failedAssistant.role !== "assistant") {
			throw new Error(`Expected failed assistant message, got ${failedAssistant.role}`);
		}
		expect(failedAssistant.errorMessage).toBe(malformedError);
		const syntheticResult = messages[2];
		if (syntheticResult.role !== "toolResult") {
			throw new Error(`Expected synthetic tool result, got ${syntheticResult.role}`);
		}
		expect(syntheticResult.toolCallId).toBe("malformed-call");
		expect(syntheticResult.details).toMatchObject({ executed: false, source: "assistant_stop_error" });
		const recoveredAssistant = messages[3];
		if (recoveredAssistant.role !== "assistant") {
			throw new Error(`Expected recovered assistant message, got ${recoveredAssistant.role}`);
		}
		const contentBlock = recoveredAssistant.content[0];
		if (contentBlock.type !== "text") {
			throw new Error(`Expected text content block, got ${contentBlock.type}`);
		}
		expect(contentBlock.text).toBe("Recovered after Gemini malformed function call");
	});

	it("continues a Gemini MALFORMED_FUNCTION_CALL transcribed as text with a corrective reminder", async () => {
		const model = getBundledModel("google", "gemini-1.5-flash");
		if (!model) {
			throw new Error("Expected bundled Google test model to exist");
		}

		const malformedError = "Generation failed with finish reason: MALFORMED_FUNCTION_CALL";
		const transcribedCall = "```call:default_api:read{i:Read call_frame.rs,path:src/call_frame.rs:215-320}```";
		const requestContexts: Message[][] = [];
		const mock = createMockModel({
			responses: [
				{ content: [transcribedCall], stopReason: "error", errorMessage: malformedError },
				{ content: ["Recovered after transcribed function call"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			// agent-core's default converter drops developer messages; the CLI wires
			// the coding-agent converter, which is what carries the reminder.
			convertToLlm,
			streamFn: (requestedModel, context, options) => {
				requestContexts.push([...context.messages]);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents } = trackRetryEvents(session);

		await session.prompt("recover from a transcribed function call");
		await session.waitForIdle();

		// The committed text vetoes the replay retry; the preserved-turn continuation
		// must carry the failed turn plus the corrective reminder to the provider.
		expect(retryStartEvents).toHaveLength(0);
		expect(requestContexts).toHaveLength(2);
		const secondRequest = requestContexts[1];
		expect(secondRequest.map(message => message.role)).toEqual(["user", "assistant", "developer"]);
		const failedTurn = secondRequest[1];
		if (failedTurn.role !== "assistant") throw new Error(`Expected assistant, got ${failedTurn.role}`);
		expect(failedTurn.content).toEqual([{ type: "text", text: transcribedCall }]);
		const reminder = secondRequest[2];
		if (reminder.role !== "developer") throw new Error(`Expected developer, got ${reminder.role}`);
		const reminderText =
			typeof reminder.content === "string"
				? reminder.content
				: reminder.content.map(part => (part.type === "text" ? part.text : "")).join("");
		expect(reminderText).toContain("malformed");

		const messages = session.agent.state.messages;
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "developer", "assistant"]);
		const recovered = messages[3];
		if (recovered.role !== "assistant") throw new Error(`Expected assistant, got ${recovered.role}`);
		expect(recovered.content).toEqual([{ type: "text", text: "Recovered after transcribed function call" }]);
	});

	it("injects a corrective developer reminder when retrying a content-less MALFORMED_RESPONSE on the same model", async () => {
		const model = getBundledModel("google", "gemini-1.5-flash");
		if (!model) {
			throw new Error("Expected bundled Google test model to exist");
		}

		const malformedError = "Provider returned error (native_finish_reason: MALFORMED_RESPONSE); response ID: gen-1";
		const requestContexts: Message[][] = [];
		const mock = createMockModel({
			responses: [
				{ content: [], stopReason: "error", errorMessage: malformedError },
				{ content: ["Recovered after malformed response reminder"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: (requestedModel, context, options) => {
				requestContexts.push([...context.messages]);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("recover from an empty malformed response");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(requestContexts).toHaveLength(2);
		const secondRequest = requestContexts[1];
		expect(secondRequest.map(message => message.role)).toEqual(["user", "developer"]);
		const reminder = secondRequest[1];
		if (reminder.role !== "developer") throw new Error(`Expected developer, got ${reminder.role}`);
		const reminderText =
			typeof reminder.content === "string"
				? reminder.content
				: reminder.content.map(part => (part.type === "text" ? part.text : "")).join("");
		expect(reminderText).toContain("malformed");
		expect(reminderText).toContain("Attempt #1/1");
	});

	it("auto-retries provider finish_reason errors after partial text", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const errorMessage = "Provider returned error finish_reason";
		const mock = createMockModel({
			responses: [
				{ content: ["   "], stopReason: "error", errorMessage },
				{ content: ["Recovered after provider finish_reason error"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		await session.prompt("recover from provider finish_reason error");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].errorMessage).toBe(errorMessage);
		expect(retryEndEvents).toHaveLength(1);
		expect(session.agent.state.messages).toHaveLength(2);
		const assistantMsg = session.agent.state.messages[1];
		if (assistantMsg.role !== "assistant") {
			throw new Error(`Expected assistant message, got ${assistantMsg.role}`);
		}
		const contentBlock = assistantMsg.content[0];
		if (contentBlock.type !== "text") {
			throw new Error(`Expected text content block, got ${contentBlock.type}`);
		}
		expect(contentBlock.text).toBe("Recovered after provider finish_reason error");
	});

	it("reaches the provider and closes the saga when the failed assistant tail was recreated mid-retry", async () => {
		// Issue #5382: a context rebuild can recreate the failed turn's message
		// object between settle and retry (fresh identity, same failed tail), so
		// the identity-keyed removal misses (`agent active context assistant
		// removal missed ... lastRole=assistant lastStopReason=error`). The
		// scheduled continue() then rejected the assistant tail locally before
		// any provider request, auto_retry_end never fired, and the in-flight
		// prompt() hung forever behind the pending retryPromise.
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const errorMessage = "Provider returned error finish_reason";
		const mock = createMockModel({
			responses: [
				{ content: ["   "], stopReason: "error", errorMessage },
				{ content: ["Recovered after tail rebuild"] },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		const { retryStartEvents, retryEndEvents } = trackRetryEvents(session);

		// Recreate the failed tail with a fresh object identity while the retry is
		// being scheduled, reproducing the removal-miss state from the issue.
		session.subscribe(event => {
			if (event.type !== "auto_retry_start") return;
			const messages = agent.state.messages;
			const tail = messages.at(-1);
			if (tail?.role !== "assistant" || tail.stopReason !== "error") return;
			agent.replaceMessages([...messages.slice(0, -1), { ...tail, timestamp: tail.timestamp + 1 }]);
		});

		const outcome = await Promise.race([
			session.prompt("recover after the failed tail is rebuilt").then(() => "completed" as const),
			scheduler.wait(3_000).then(() => "stuck" as const),
		]);

		expect(outcome).toBe("completed");
		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toEqual([expect.objectContaining({ success: true, attempt: 1 })]);
		expect(session.isRetrying).toBe(false);
		expect(getLastAssistantMessage(session).stopReason).toBe("stop");
	});

	it("retries the same model on a thinking-loop error instead of switching via fallback", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!primaryModel || !fallbackModel) {
			throw new Error("Expected bundled test models to exist");
		}
		const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
		const fallbackSelector = `${fallbackModel.provider}/${fallbackModel.id}`;

		const requestedModels: string[] = [];
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: model => {
				requestedModels.push(`${model.provider}/${model.id}`);
				return requestedModels.length === 1
					? thinkingLoopErrorStream(model)
					: recoveredTextStream(model, "Recovered on the same model.");
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 0,
			"retry.maxRetries": 2,
			"retry.modelFallback": true,
			"retry.fallbackChains": { default: [fallbackSelector] },
			"model.loopGuard.enabled": true,
		});
		settings.setModelRole("default", primarySelector);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const fallbackAppliedEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const retryStartEvents: AutoRetryStartEvent[] = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackAppliedEvents.push(event);
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
		});
		mockSchedulerWaitWithClock();

		await session.prompt("Plan the ticket, then act");
		await session.waitForIdle();

		// The fallback chain lists a different family, but the thinking-loop abort
		// re-samples the SAME model: no chain consult, no model switch.
		expect(requestedModels).toEqual([primarySelector, primarySelector]);
		expect(session.model?.provider).toBe(primaryModel.provider);
		expect(session.model?.id).toBe(primaryModel.id);
		expect(fallbackAppliedEvents).toHaveLength(0);
		// The abort is a thinking-loop, and the retry stayed on the same model.
		expect(retryStartEvents).toHaveLength(1);
		expect(AIError.is(retryStartEvents[0].errorId, AIError.Flag.ThinkingLoop)).toBe(true);
		// The selector must not be parked on a fallback cooldown by the abort.
		expect(modelRegistry.isSelectorSuppressed(primarySelector)).toBe(false);
		const finalAssistant = getLastAssistantMessage(session);
		expect(finalAssistant.content).toEqual([{ type: "text", text: "Recovered on the same model." }]);
	});
});
