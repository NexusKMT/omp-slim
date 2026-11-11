import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { kStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getTestModel as getBundledModel } from "../../catalog/test/fixtures/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;
type AutoRetryStartEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" }>;

const CODEX_BODY_READ_ERROR =
	"Anthropic stream error (api_error): Transport error reading Codex response body: error decoding response body";

function lastAssistant(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") {
		throw new Error("Expected trailing assistant message");
	}
	return message as AssistantMessage;
}

/**
 * Contract: when the provider asks us to wait longer than `retry.maxDelayMs`
 * and we have no credential/model fallback to switch to, the auto-retry
 * loop MUST fail fast — preserving the terminal error message in agent
 * state and skipping the long sleep entirely.
 *
 * Without this defense, an Anthropic `429 rate_limit_error` with
 * `retry-after-ms=11180000` (≈3 hours) pinned a subagent in the retry
 * sleep, leaving the parent task tool stuck on the review phase for hours
 * (see GitHub issue #607).
 */
describe("AgentSession retry delay cap", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-retry-cap-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	beforeEach(async () => {
		// A live env var now overrides a stored static api_key; these tests rotate stored Anthropic
		// credentials, so neutralize env resolution (ignores every provider's ambient env key).
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		for (const provider of ["anthropic", "openai-codex"]) {
			await authStorage.credentials.remove(provider);
		}
		for (const provider of [
			"anthropic",
			"openai",
			"openai-codex",
			"opencode-go",
			"openrouter",
			"github-copilot",
			"zai",
			"cursor",
		]) {
			authStorage.keys.removeRuntime(provider);
		}
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("bails immediately when retry-after exceeds retry.maxDelayMs", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		// 11.18M ms == ~3.1 hours, matching the report on the original incident.
		const rateLimitError =
			'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} retry-after=11180.0005';

		const mock = createMockModel({ handler: () => ({ throw: rateLimitError }) });
		const requestedModels: string[] = [];
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
			"retry.maxDelayMs": 100,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		// Spy after construction so the constructor's no-op work isn't intercepted.
		const waitSpy = mockSchedulerWaitWithClock();
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger rate limit with long retry-after");
		await session.waitForIdle();

		// Only one model call: the auto-retry MUST NOT loop into a fresh attempt
		// because the cap fired before scheduler.wait was even reached.
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		expect(retryEndEvents[0].finalError).toContain("exceeds retry.maxDelayMs");
		expect(retryEndEvents[0].finalError).toContain("Provider requested 11180001ms wait");
		// No multi-hour (or any) sleep — the cap path skips scheduler.wait entirely.
		for (const call of waitSpy.mock.calls) {
			expect(call[0]).toBeLessThanOrEqual(100);
		}

		// The terminal error stays as the last assistant message so the caller
		// (interactive UI, parent task tool, SDK consumer) can act on it.
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toContain("rate_limit_error");
		expect(session.isRetrying).toBe(false);
	});

	it("still fails fast on a long usage-limit reset when retry.waitForUsageReset is off", async () => {
		// Contract: the default is unchanged — a multi-hour usage-limit wait
		// without the opt-in (or a sibling/fallback) MUST fail fast.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const resetStamp = new Date(Date.now() + 7_200_000).toISOString().slice(0, 19).replace("T", " ");
		const usageLimitError = `429 已达到 5 小时的使用上限。您的限额将在 ${resetStamp} 重置。`;

		const mock = createMockModel({ handler: () => ({ throw: usageLimitError }) });
		const requestedModels: string[] = [];
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
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = mockSchedulerWaitWithClock();
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger long usage-limit reset without the opt-in");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		expect(retryEndEvents[0].finalError).toContain("exceeds retry.maxDelayMs");
		for (const call of waitSpy.mock.calls) {
			expect(call[0]).toBeLessThanOrEqual(100);
		}
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toContain("使用上限");
		expect(session.isRetrying).toBe(false);
	});

	it("still fails fast on a long transient retry-after when retry.waitForUsageReset is set", async () => {
		// Contract: the opt-in covers provider-stated *usage-limit* resets
		// only — a long transient retry-after (server overload, no quota
		// exhaustion) MUST still fail fast so the hung-subagent guard keeps
		// working for non-quota errors.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const overloadedError = "503 service unavailable: overloaded_error retry-after-ms=3600000";

		const mock = createMockModel({ handler: () => ({ throw: overloadedError }) });
		const requestedModels: string[] = [];
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
				return mock.stream(requestedModel, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.waitForUsageReset": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = mockSchedulerWaitWithClock();
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger long transient retry-after with the opt-in set");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		expect(retryEndEvents[0].finalError).toContain("exceeds retry.maxDelayMs");
		for (const call of waitSpy.mock.calls) {
			expect(call[0]).toBeLessThanOrEqual(100);
		}
		expect(session.isRetrying).toBe(false);
	});

	it("fails fast on a usage-limit error with no provider reset hint when retry.waitForUsageReset is set", async () => {
		// Contract: the opt-in only honors *parsed provider* reset timing. A
		// usage-limit error with no hint (e.g. 402 balance) falls back to the
		// 30-minute QUOTA_EXHAUSTED heuristic, which must NOT bypass the cap —
		// otherwise a permanent error holds the session through repeated
		// heuristic sleeps instead of surfacing.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const balanceError = "402 Insufficient balance, please top up your account";

		const mock = createMockModel({ handler: () => ({ throw: balanceError }) });
		const requestedModels: string[] = [];
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
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.modelFallback": false,
			"retry.waitForUsageReset": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = mockSchedulerWaitWithClock();
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger hintless usage-limit error with the opt-in set");
		await session.waitForIdle();

		expect(requestedModels).toEqual([`${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(0);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		// An out-of-money balance has no reset clock, so the error surfaces as the
		// provider stated it rather than as cap arithmetic about a wait that never
		// was going to help.
		expect(retryEndEvents[0].finalError).toBe(balanceError);
		for (const call of waitSpy.mock.calls) {
			expect(call[0]).toBeLessThanOrEqual(100);
		}
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toContain("Insufficient balance");
		expect(session.isRetrying).toBe(false);
	});

	it("retries promptly on a zero-valued usage-limit retry hint when retry.waitForUsageReset is set", async () => {
		// Contract: an explicit `retry-after-ms=0` is a provider "retry now"
		// signal. It must not collapse into "no hint" — that would substitute
		// the 30-minute QUOTA_EXHAUSTED heuristic, which (lacking parsed
		// provider timing) cannot authorize the opt-in and would trip
		// retry.maxDelayMs, surfacing the error instead of retrying as asked.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const zeroHintError = "429 quota exceeded. retry-after-ms=0";

		const mock = createMockModel({
			responses: [{ throw: zeroHintError }, { content: ["recovered after immediate retry"], stopReason: "stop" }],
		});
		const requestedModels: string[] = [];
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
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.modelFallback": false,
			"retry.waitForUsageReset": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = mockSchedulerWaitWithClock();
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger zero retry-after usage-limit with the opt-in set");
		await session.waitForIdle();

		// The retry ran within the cap instead of sleeping the heuristic or
		// failing fast, and the second attempt recovered.
		expect(requestedModels).toEqual([`${model.provider}/${model.id}`, `${model.provider}/${model.id}`]);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].delayMs).toBeGreaterThan(0);
		expect(retryStartEvents[0].delayMs).toBeLessThanOrEqual(100);
		for (const call of waitSpy.mock.calls) {
			expect(call[0]).toBeLessThanOrEqual(100);
		}
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(lastAssistant(session).stopReason).toBe("stop");
		expect(session.isRetrying).toBe(false);
	});

	it("continues a quota-blocked turn after sleep passes the wall deadline but not the uptime deadline", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model");
		const delayMs = 220 * 60_000;
		const mock = createMockModel({
			responses: [
				{ throw: `429 Usage limit reached. retry-after-ms=${delayMs}` },
				{ content: ["recovered after wake"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: () => "local-test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.maxDelayMs": 0,
			"retry.modelFallback": false,
			"retry.waitForUsageReset": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		let wall = Date.now();
		let monotonic = performance.now();
		let resumed = false;
		vi.spyOn(Date, "now").mockImplementation(() => wall);
		vi.spyOn(performance, "now").mockImplementation(() => monotonic);
		vi.spyOn(scheduler, "wait").mockImplementation(async (delay, options) => {
			options?.signal?.throwIfAborted();
			if (!resumed && session?.isRetrying) {
				wall += delayMs + 60_000;
				monotonic += 1_000;
				resumed = true;
			} else {
				if (resumed && delay > 1_000) throw new Error("Re-armed an expired quota deadline");
				wall += delay;
				monotonic += delay;
			}
		});

		await session.prompt("Continue after the quota reset");
		await session.waitForIdle();
		expect(lastAssistant(session).content).toEqual([{ type: "text", text: "recovered after wake" }]);
		expect(session.isRetrying).toBe(false);
	});

	it("honors the reason backoff for a transient rate-limit 429 without a provider hint", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{ throw: "429 Rate limit exceeded, too many requests" },
				{ content: ["recovered after rate-limit window"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
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
			"retry.maxDelayMs": 60_000,
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
		mockSchedulerWaitWithClock();
		const retryStartEvents: AutoRetryStartEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
		});

		await session.prompt("Trigger transient rate limit without retry-after");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].delayMs).toBe(30_000);
		expect(lastAssistant(session).content).toContainEqual({
			type: "text",
			text: "recovered after rate-limit window",
		});
	});

	it("auto-retries OpenAI Responses stream_read_error instead of stopping the conversation", async () => {
		const model = getBundledModel("openai", "gpt-5");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}
		authStorage.keys.setRuntime("openai", "openai-test-key");

		const mock = createMockModel({
			responses: [
				{ throw: "Error Code stream_read_error: stream_read_error" },
				{ content: ["recovered after stream read retry"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
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
			"retry.maxDelayMs": 5_000,
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

		mockSchedulerWaitWithClock();
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger stream read retry");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after stream read retry" });
	});

	it("auto-retries Unable to connect transport failures instead of stopping the conversation", async () => {
		const model = getBundledModel("openai", "gpt-5");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}
		authStorage.keys.setRuntime("openai", "openai-test-key");

		const mock = createMockModel({
			responses: [
				{ throw: "Unable to connect. Is the computer able to access the url?" },
				{ content: ["recovered after connection retry"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
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
			"retry.maxDelayMs": 5_000,
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

		mockSchedulerWaitWithClock();
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger unable to connect retry");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after connection retry" });
	});

	it("marks extension agent_end willContinue when auto-retry schedules a continue", async () => {
		const model = getBundledModel("openai", "gpt-5");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}
		authStorage.keys.setRuntime("openai", "openai-test-key");

		const mock = createMockModel({
			responses: [
				{ throw: "Error Code stream_read_error: stream_read_error" },
				{ content: ["recovered after stream read retry"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
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
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		const extensionEmits: Array<{ type: string; willContinue?: boolean }> = [];
		// Partial ExtensionRunner double — same pattern as sibling agent-session tests;
		// only emit surfaces used on the auto-retry path are implemented.
		const extensionRunner = {
			emit: async (event: { type: string; willContinue?: boolean }) => {
				extensionEmits.push({ type: event.type, willContinue: event.willContinue });
			},
			emitBeforeAgentStart: async () => undefined,
			hasHandlers: () => false,
			emitSessionStop: async () => undefined,
		} as unknown as ExtensionRunner;

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			extensionRunner,
		});

		mockSchedulerWaitWithClock();

		await session.prompt("Trigger stream read retry");
		await session.waitForIdle();

		const agentEnds = extensionEmits.filter(event => event.type === "agent_end");
		expect(agentEnds.length).toBeGreaterThanOrEqual(2);
		// First settle is the failed attempt that scheduled continue; final settle is terminal.
		expect(agentEnds[0]?.willContinue).toBe(true);
		expect(agentEnds.at(-1)?.willContinue).toBeFalsy();
		expect(lastAssistant(session).stopReason).toBe("stop");
	});

	it("still retries normally when the delay is under retry.maxDelayMs", async () => {
		// Sanity check: a small retry-after MUST still go through the retry
		// loop so we don't regress the existing transient-error recovery.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{ throw: "503 service unavailable: overloaded_error retry-after-ms=50" },
				{ content: ["recovered after short backoff"] },
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
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const waitSpy = mockSchedulerWaitWithClock();
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger transient with short retry-after");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0].delayMs).toBeLessThanOrEqual(5_000);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		expect(waitSpy).toHaveBeenCalled();
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
	});

	it.each([
		["a timeout after streaming a complete unexecuted write tool call", "The operation timed out.", ["complete"]],
		["a Codex body-read error with incomplete args", CODEX_BODY_READ_ERROR, ["partial"]],
		["a Codex body-read error with a completed unexecuted call", CODEX_BODY_READ_ERROR, ["complete"]],
		["a Codex body-read error with toolcall_end after partial args", CODEX_BODY_READ_ERROR, ["partial-ended"]],
		["a Codex body-read error with a complete+partial batch", CODEX_BODY_READ_ERROR, ["complete", "partial"]],
	] as const)("auto-retries %s", async (_scenario, errorMessage, callStates) => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const oldCalls: ToolCall[] = callStates.map((state, index) => ({
			type: "toolCall",
			id: `tc-old-${index}`,
			name: "write",
			arguments:
				state === "complete" ? { path: "doc/report.md", content: "large report chunk" } : { path: "doc/report.md" },
			...(state !== "complete" ? { [kStreamingPartialJson]: '{"path":"doc/report.md","content":' } : {}),
		}));
		const freshCall: ToolCall = {
			type: "toolCall",
			id: "tc-fresh",
			name: "write",
			arguments: { path: "doc/report.md", content: "complete recovered report" },
		};
		const executedIds: string[] = [];
		const countingTool: AgentTool = {
			name: "write",
			label: "Count writes",
			description: "Records invocations without writing files",
			// Accept partial args so an unsafe execution cannot hide behind schema validation.
			parameters: type({ "path?": "string", "content?": "string" }),
			execute: async id => {
				executedIds.push(id);
				return { content: [{ type: "text", text: "Counted write" }] };
			},
		};
		let streamCalls = 0;
		let resumedWithSafeHistory = false;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [countingTool],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				streamCalls += 1;
				if (streamCalls > 1) {
					if (streamCalls === 2) {
						resumedWithSafeHistory = oldCalls.every((toolCall, index) => {
							if (callStates[index] === "partial") {
								return !context.messages.some(
									message =>
										message.role === "assistant" &&
										message.content.some(block => block.type === "toolCall" && block.id === toolCall.id),
								);
							}
							return context.messages.some(
								message =>
									message.role === "toolResult" &&
									message.toolCallId === toolCall.id &&
									typeof message.details === "object" &&
									message.details !== null &&
									"executed" in message.details &&
									message.details.executed === false,
							);
						});
					}
					const recoveryModel = createMockModel({
						id: requestedModel.id,
						provider: requestedModel.provider,
					});
					recoveryModel.push({ content: streamCalls === 2 ? [freshCall] : ["Recovered after transport error"] });
					return recoveryModel.stream(recoveryModel, context, options);
				}

				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial: AssistantMessage = {
						role: "assistant",
						content: [],
						api: requestedModel.api,
						provider: requestedModel.provider,
						model: requestedModel.id,
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
					stream.push({ type: "start", partial });
					for (const [contentIndex, toolCall] of oldCalls.entries()) {
						partial.content.push(toolCall);
						stream.push({ type: "toolcall_start", contentIndex, partial });
						stream.push({
							type: "toolcall_delta",
							contentIndex,
							delta: toolCall[kStreamingPartialJson] ?? JSON.stringify(toolCall.arguments),
							partial,
						});
						if (callStates[contentIndex] !== "partial") {
							stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
						}
					}
					stream.push({
						type: "error",
						reason: "error",
						error: {
							...partial,
							stopReason: "error",
							errorMessage,
							duration: 1000,
						},
					});
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Write a large report");
		await session.waitForIdle();

		expect(streamCalls).toBe(3);
		expect(executedIds).toEqual([freshCall.id]);
		expect(resumedWithSafeHistory).toBe(true);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toContainEqual(expect.objectContaining({ success: true, attempt: 1 }));
		expect(lastAssistant(session).content).toContainEqual({
			type: "text",
			text: "Recovered after transport error",
		});
	});

	it.each([
		[
			"OpenAI-completions stall",
			"error",
			"OpenAI completions stream stalled while waiting for the next event",
			undefined,
		],
		[
			"pi-native premature close",
			"error",
			"pi-native stream read error: stream closed before a terminal response event",
			undefined,
		],
		[
			"Codex premature close",
			"error",
			"Codex stream ended before terminal completion event",
			AIError.create(AIError.Flag.Transient),
		],
		["reasonless abort", "aborted", "Request was aborted", undefined],
	] as const)(
		"resumes a %s after a synthetic unexecuted tool result",
		async (_case, stopReason, errorMessage, errorId) => {
			const model = createMockModel({
				id: "grok-4",
				provider: "openrouter",
			});
			authStorage.keys.setRuntime("openrouter", "openrouter-test-key");
			const toolCall: ToolCall = {
				type: "toolCall",
				id: "grok-write-1",
				name: "write",
				arguments: { path: "review.md", content: "partial review" },
			};
			let streamCalls = 0;
			let resumedWithSyntheticResult = false;
			const agent = new Agent({
				getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (_requestedModel, context, options) => {
					streamCalls += 1;
					if (streamCalls > 1) {
						const matchingResult = context.messages.find(
							message => message.role === "toolResult" && message.toolCallId === toolCall.id,
						);
						resumedWithSyntheticResult =
							matchingResult?.role === "toolResult" &&
							typeof matchingResult.details === "object" &&
							matchingResult.details !== null &&
							"executed" in matchingResult.details &&
							matchingResult.details.executed === false;
						model.push({ content: ["Recovered after interrupted tool call"] });
						return model.stream(model, context, options);
					}

					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const partial: AssistantMessage = {
							role: "assistant",
							content: [toolCall],
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
						stream.push({ type: "start", partial });
						stream.push({ type: "toolcall_start", contentIndex: 0, partial });
						stream.push({
							type: "toolcall_delta",
							contentIndex: 0,
							delta: JSON.stringify(toolCall.arguments),
							partial,
						});
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
						stream.push({
							type: "error",
							reason: stopReason,
							error: {
								...partial,
								stopReason,
								errorMessage,
								errorId,
							},
						});
					});
					return stream;
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
			const retryStartEvents: AutoRetryStartEvent[] = [];
			const retryEndEvents: AutoRetryEndEvent[] = [];
			session.subscribe(event => {
				if (event.type === "auto_retry_start") retryStartEvents.push(event);
				if (event.type === "auto_retry_end") retryEndEvents.push(event);
			});

			await session.prompt("Write a review");
			await session.waitForIdle();

			expect(streamCalls).toBe(2);
			expect(resumedWithSyntheticResult).toBe(true);
			expect(
				session.agent.state.messages.filter(
					message => message.role === "toolResult" && message.toolCallId === toolCall.id,
				),
			).toHaveLength(1);
			expect(retryStartEvents).toHaveLength(1);
			expect(retryEndEvents).toContainEqual(expect.objectContaining({ success: true, attempt: 1 }));
			expect(lastAssistant(session).content).toContainEqual({
				type: "text",
				text: "Recovered after interrupted tool call",
			});
		},
	);

	it.each([
		["verbose socket close", "The socket connection was closed unexpectedly"],
		["bare socket close", "Socket is closed"],
		["pi-native premature close", "pi-native stream read error: stream closed before a terminal response event"],
		["gateway 500", "auth-gateway 500: <none>"],
		["gateway 524", "auth-gateway 524: <none>"],
	])("retries a transient %s after partial text and thinking", async (_label, errorMessage) => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		let streamCalls = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: requestedModel => {
				streamCalls += 1;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const partial: AssistantMessage = {
						role: "assistant",
						content: [],
						api: requestedModel.api,
						provider: requestedModel.provider,
						model: requestedModel.id,
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

					if (streamCalls === 1) {
						const thinking = { type: "thinking" as const, thinking: "partial thought" };
						const text = { type: "text" as const, text: "partial buffered answer" };
						partial.content.push(thinking, text);
						stream.push({ type: "start", partial });
						stream.push({ type: "thinking_start", contentIndex: 0, partial });
						stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinking.thinking, partial });
						stream.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial });
						stream.push({ type: "text_start", contentIndex: 1, partial });
						stream.push({ type: "text_delta", contentIndex: 1, delta: text.text, partial });
						stream.push({
							type: "error",
							reason: "error",
							error: {
								...partial,
								stopReason: "error",
								errorMessage,
								duration: 1000,
							},
						});
						return;
					}

					const recovered = { type: "text" as const, text: "recovered after partial socket close" };
					partial.content.push(recovered);
					stream.push({ type: "start", partial });
					stream.push({ type: "text_start", contentIndex: 0, partial });
					stream.push({ type: "text_delta", contentIndex: 0, delta: recovered.text, partial });
					stream.push({ type: "text_end", contentIndex: 0, content: recovered.text, partial });
					stream.push({
						type: "done",
						reason: "stop",
						message: {
							...partial,
							stopReason: "stop",
							duration: 1000,
						},
					});
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		mockSchedulerWaitWithClock();
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		session.setTextOutputCommitted(false);
		await session.prompt("Trigger partial socket close");
		await session.waitForIdle();

		expect(streamCalls).toBe(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after partial socket close" });
	});

	it.each([
		["sub", 2, 1],
		["main", 2, 0],
	] as const)(
		"a %s session recovers the partial-text Anthropic envelope error with %s stream call(s)",
		async (agentKind, expectedStreamCalls, expectedRetryStarts) => {
			// Production 2026-09-21: `scout` subagents whose stream died with
			// "stream ended before message_stop" after streaming prose exited 1
			// instead of retrying. A subagent's streamed text reaches no output
			// sink (the parent only ever sees the yield), so it is replay-safe
			// without the print-mode `setTextOutputCommitted(false)` dance and the
			// provider replay retries it. A main session keeps the replay veto
			// because the text is already rendered, so it continues from the
			// partial answer instead — the same recovery a stall, an HTTP/2 reset
			// or a gateway's in-band `error` frame gets, and no auto-retry.
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) {
				throw new Error("Expected bundled Anthropic test model to exist");
			}
			const envelopeError = "Anthropic stream envelope error: stream ended before message_stop";

			let streamCalls = 0;
			const agent = new Agent({
				getApiKey: model => `${model.provider}-test-key`,
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: requestedModel => {
					streamCalls += 1;
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const partial: AssistantMessage = {
							role: "assistant",
							content: [],
							api: requestedModel.api,
							provider: requestedModel.provider,
							model: requestedModel.id,
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

						if (streamCalls === 1) {
							const text = { type: "text" as const, text: "I'll systematically investigate the codebase" };
							partial.content.push(text);
							stream.push({ type: "start", partial });
							stream.push({ type: "text_start", contentIndex: 0, partial });
							stream.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial });
							stream.push({
								type: "error",
								reason: "error",
								error: { ...partial, stopReason: "error", errorMessage: envelopeError, duration: 1000 },
							});
							return;
						}

						const recovered = { type: "text" as const, text: "recovered after envelope retry" };
						partial.content.push(recovered);
						stream.push({ type: "start", partial });
						stream.push({ type: "text_start", contentIndex: 0, partial });
						stream.push({ type: "text_delta", contentIndex: 0, delta: recovered.text, partial });
						stream.push({ type: "text_end", contentIndex: 0, content: recovered.text, partial });
						stream.push({
							type: "done",
							reason: "stop",
							message: { ...partial, stopReason: "stop", duration: 1000 },
						});
					});
					return stream;
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 5_000,
				"retry.maxRetries": 1,
				"retry.modelFallback": false,
			});
			settings.setModelRole("default", `${model.provider}/${model.id}`);

			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings,
				modelRegistry,
				agentKind,
			});

			mockSchedulerWaitWithClock();
			const retryStartEvents: AutoRetryStartEvent[] = [];
			session.subscribe(event => {
				if (event.type === "auto_retry_start") retryStartEvents.push(event);
			});

			await session.prompt("Trigger envelope error after partial text");
			await session.waitForIdle();

			expect(streamCalls).toBe(expectedStreamCalls);
			expect(retryStartEvents).toHaveLength(expectedRetryStarts);
			const last = lastAssistant(session);
			expect(last.stopReason).toBe("stop");
			expect(last.content).toContainEqual({ type: "text", text: "recovered after envelope retry" });
		},
	);

	it.each([
		[
			"Bun HTTP/2",
			{
				throw: 'HTTP2StreamReset fetching "https://chatgpt.com/backend-api/codex/responses". For more information, pass `verbose: true` in the second argument to fetch()',
			},
		],
		[
			"proxied Python HTTP/2",
			{
				content: [{ type: "thinking", thinking: "Checking the request." }],
				stopReason: "error",
				errorMessage:
					"Codex error event: <StreamReset stream_id:1283, error_code:2, remote_reset:True> (code=api_error)",
			},
		],
		[
			"proxied Python HTTP/1.1 chunked body",
			{
				content: [],
				stopReason: "error",
				errorMessage:
					"Codex error event: peer closed connection without sending complete message body (incomplete chunked read) (code=api_error)",
			},
		],
	] satisfies [string, MockResponse][])("retries on %s stream interruption errors", async (_label, failure) => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [failure, { content: ["recovered after stream reset"] }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		mockSchedulerWaitWithClock();
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger stream interruption");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
	});
	it("retries generic upstream_error gateway failures", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{ throw: "upstream_error: Upstream request failed" },
				{ content: ["recovered after generic gateway upstream error"] },
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
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
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
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger generic upstream_error");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after generic gateway upstream error" });
	});

	it("retries empty reasonless aborted turns", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{ stopReason: "aborted", errorMessage: "Request was aborted" },
				{ content: ["recovered after empty reasonless abort"] },
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
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
			"retry.maxRetries": 1,
			"retry.modelFallback": true,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		mockSchedulerWaitWithClock();
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});

		await session.prompt("Trigger empty aborted turn");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(1);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		expect(fallbackEvents).toHaveLength(0);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after empty reasonless abort" });
	});

	it("does not retry reasonless aborted turns that have partial content", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [{ content: ["partial"], stopReason: "aborted", errorMessage: "Request was aborted" }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
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
		const retryStartEvents: AutoRetryStartEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
		});

		await session.prompt("Trigger partial aborted turn");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("aborted");
		expect(last.content).toContainEqual({ type: "text", text: "partial" });
	});

	it("does not auto-retry empty reasonless aborts once the session is disposing", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		// A dispose-driven abort produces the same empty/reason-less shape as a
		// transient provider abort. It MUST settle the turn instead of entering
		// auto-retry: a retry here schedules a continuation that the disposed guard
		// skips without resolving #retryPromise, hanging prompt() during shutdown.
		const mock = createMockModel({
			responses: [
				{ stopReason: "aborted", errorMessage: "Request was aborted" },
				{ content: ["should not be reached after dispose"] },
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
			streamFn: mock.stream,
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 5_000,
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
		const retryStartEvents: AutoRetryStartEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
		});

		// Enter the disposing window before the empty abort lands. Without the
		// #isDisposed guard this prompt would hang on an orphaned retry promise.
		session.beginDispose();
		await session.prompt("Trigger empty aborted turn while disposing");
		await session.waitForIdle();

		expect(retryStartEvents).toHaveLength(0);
		// No retry continuation fired, so the second scripted response is untouched.
		expect(mock.calls).toHaveLength(1);
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("aborted");
	});

	async function expectThinkingStreamCloseRetryCap(options: {
		model: Model;
		errorMessage: string;
		prompt: string;
	}): Promise<void> {
		authStorage.keys.setRuntime(options.model.provider, `${options.model.provider}-test-key`);
		let calls = 0;
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model: options.model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: requestedModel => {
				calls++;
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const usage: AssistantMessage["usage"] = {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
					if (calls > 2) {
						const text: TextContent = { type: "text", text: "must remain unused" };
						const message: AssistantMessage = {
							role: "assistant",
							content: [text],
							api: requestedModel.api,
							provider: requestedModel.provider,
							model: requestedModel.id,
							usage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: message });
						stream.push({ type: "text_start", contentIndex: 0, partial: message });
						stream.push({ type: "text_delta", contentIndex: 0, delta: text.text, partial: message });
						stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: message });
						stream.push({ type: "done", reason: "stop", message });
						return;
					}
					const thinking: ThinkingContent = { type: "thinking", thinking: "" };
					const message: AssistantMessage = {
						role: "assistant",
						content: [thinking],
						api: requestedModel.api,
						provider: requestedModel.provider,
						model: requestedModel.id,
						usage,
						stopReason: "error",
						errorMessage: options.errorMessage,
						errorId: AIError.create(AIError.Flag.Transient),
						timestamp: Date.now(),
					};
					const delta = `reasoning attempt ${calls}`;
					stream.push({ type: "start", partial: message });
					stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
					thinking.thinking = delta;
					stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: message });
					stream.push({ type: "thinking_end", contentIndex: 0, content: thinking.thinking, partial: message });
					stream.push({ type: "error", reason: "error", error: message });
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 10,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${options.model.provider}/${options.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		mockSchedulerWaitWithClock();
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt(options.prompt);
		await session.waitForIdle();

		expect(calls).toBe(2);
		expect(retryStartEvents).toHaveLength(1);
		expect(retryStartEvents[0]).toMatchObject({ attempt: 1, maxAttempts: 1 });
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false, attempt: 1 });
		expect(lastAssistant(session).errorMessage).toBe(`Retry budget exhausted after 1 retry: ${options.errorMessage}`);
		expect(session.isRetrying).toBe(false);
	}

	it("caps repeated OpenRouter stream closes after streamed thinking at one retry", async () => {
		const model = getBundledModel("openrouter", "~google/gemini-flash-latest");
		if (!model) {
			throw new Error("Expected bundled OpenRouter Gemini test model to exist");
		}
		await expectThinkingStreamCloseRetryCap({
			model,
			errorMessage: "server_error: stream closed with reason: error",
			prompt: "Trigger OpenRouter reasoning transition failure",
		});
	});

	it("defaults 502 auto-retry to ten capped backoff attempts", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel();
		let attempts = 0;
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				attempts += 1;
				mock.push(
					attempts <= 10
						? { throw: "502 Bad Gateway upstream_error" }
						: { content: ["recovered after default 502 retry budget"] },
				);
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({ "compaction.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		vi.spyOn(Math, "random").mockReturnValue(0);
		mockSchedulerWaitWithClock();
		const retryStartEvents: AutoRetryStartEvent[] = [];
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_start") retryStartEvents.push(event);
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger repeated 502s");
		await session.waitForIdle();

		expect(attempts).toBe(11);
		expect(retryStartEvents).toHaveLength(10);
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		expect(retryStartEvents.map(event => event.maxAttempts)).toEqual(new Array(10).fill(10));
		expect(retryStartEvents.map(event => event.delayMs)).toEqual([
			500, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000,
		]);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 10 });
		const last = lastAssistant(session);
		expect(last.stopReason).toBe("stop");
		expect(last.content).toContainEqual({ type: "text", text: "recovered after default 502 retry budget" });
	});
});
