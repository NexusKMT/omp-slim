import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { CompactionPreparation } from "@oh-my-pi/pi-agent-core/compaction";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

/**
 * Regression tests for #9235: a byte/media-driven HTTP 413 ("request body
 * exceeds the configured payload limit ... param=request_too_large") carries
 * overflow-shaped text, so it used to be routed into token-context compaction —
 * which cannot shrink bytes or vision-media budgets. When the local token gauge
 * still shows real headroom, the payload rejection must be surfaced honestly
 * (a warning naming image frames / body limits) instead of compacting.
 */

const PAYLOAD_ERROR_MESSAGE =
	"413 request body exceeds the configured payload limit (type=invalid_request_error param=request_too_large)";
const NO_PROGRESS_FRAGMENT = "Compaction freed too little context to make progress";
const TRANSIENT_ERROR_MESSAGE = "503 Service Unavailable: upstream connect error";

describe("AgentSession payload-rejection 413 handling", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	const NOTICE_SOURCE = "compaction";

	beforeAll(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	beforeEach(() => {
		sessionManager = SessionManager.inMemory();
	});

	afterEach(async () => {
		await session?.dispose();
		// Fallback cooldowns are recorded on the shared ModelRegistry with a
		// 5-minute TTL; without this reset one test's retry bookkeeping would
		// suppress selectors for every later test in the file.
		modelRegistry.clearSuppressedSelectors();
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage?.close();
	});
	async function createSession(
		contextWindow: number | null,
		seed?: { toolText: string },
		options?: {
			streamFn?: NonNullable<ConstructorParameters<typeof Agent>[0]>["streamFn"];
			extraSettings?: Parameters<typeof Settings.isolated>[0];
		},
	): Promise<void> {
		// The payload-rejection tests exercise SessionMaintenance's overflow
		// routing, not extension discovery. Keep the production hook boundary
		// while short-circuiting summarization, mirroring the progress-guard
		// harness.
		const extensionRunner = {
			hasHandlers: (type: string) => type === "session_before_compact",
			emit: async (event: { type: string; preparation?: CompactionPreparation }) => {
				if (event.type !== "session_before_compact" || !event.preparation) return undefined;
				return {
					compaction: {
						summary: "compacted",
						shortSummary: undefined,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				};
			},
			emitBeforeAgentStart: async () => undefined,
		};

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) {
			throw new Error("Expected built-in anthropic model to exist");
		}
		const model = {
			...bundled,
			contextWindow,
			// Custom/discovered models legitimately carry `contextWindow: null`;
			// keep the bundled maxTokens there instead of deriving NaN.
			maxTokens: contextWindow ? Math.min(64_000, Math.floor(contextWindow / 2)) : bundled.maxTokens,
		};

		// Seed the LIVE agent messages (not just branch entries): the honest-skip
		// arbitration reads #estimateStoredContextTokens, which counts
		// agent-state messages plus non-message overhead.
		const initialMessages: AgentMessage[] = [
			{ role: "user", content: "hello", timestamp: Date.now() } as AgentMessage,
			...(seed
				? [
						{
							role: "toolResult",
							toolCallId: "call-big",
							toolName: "bash",
							content: [{ type: "text", text: seed.toolText }],
							isError: false,
							timestamp: Date.now(),
						} as AgentMessage,
					]
				: []),
		];
		for (const message of initialMessages) {
			sessionManager.appendMessage(message as never);
		}
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: initialMessages,
			},
			...(options?.streamFn ? { streamFn: options.streamFn } : {}),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.autoContinue": true,
				// Promotion would silently absorb the overflow before compaction
				// could run; these tests pin the compaction-vs-honest-skip fork.
				"contextPromotion.enabled": false,
				...options?.extraSettings,
			}),
			modelRegistry,
			extensionRunner: extensionRunner as never,
		});
	}

	function collectNotices() {
		const notices: { level: string; message: string; source?: string }[] = [];
		session.subscribe(event => {
			if (event.type === "notice") {
				notices.push({ level: event.level, message: event.message, source: event.source });
			}
		});
		return notices;
	}

	function countCompactionEvents(type: "auto_compaction_start" | "auto_compaction_end") {
		let count = 0;
		session.subscribe(event => {
			if (event.type === type) count++;
		});
		return () => count;
	}

	function payloadRejectionAssistant(): AssistantMessage {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "error",
			errorMessage: PAYLOAD_ERROR_MESSAGE,
			usage: {
				input: 1000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as AssistantMessage;
		// Stamp errorId exactly like the transport boundary does (finalize →
		// classifyMessage) instead of hand-forging flags: the ninfer-style
		// body classifies PayloadRejected-ONLY, which is precisely the shape
		// the maintenance pre-gate must catch without an overflow flag
		// (AGENTS.md: drive the real failure path, assert the surfaced
		// contract).
		message.errorId = AIError.classifyMessage(message);
		return message;
	}

	function statusOnlyPayloadAssistant(): AssistantMessage {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "error",
			errorStatus: 413,
			errorMessage: "Content Too Large",
			usage: {
				input: 1000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as AssistantMessage;
		// Stamp exactly like the transport boundary: classifyMessage consumes
		// errorStatus, so the bare reason phrase classifies PayloadRejected
		// via the status fallback under test.
		message.errorId = AIError.classifyMessage(message);
		return message;
	}

	function mediaBudgetPayloadAssistant(): AssistantMessage {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "error",
			errorMessage: "request_too_large: image count exceeds the limit of 20",
			usage: {
				input: 1000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as AssistantMessage;
		message.errorId = AIError.classifyMessage(message);
		return message;
	}

	function usageBackedMediaBudgetAssistant(): AssistantMessage {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "error",
			errorMessage: "request_too_large: image count exceeds the limit of 20",
			usage: {
				input: 250_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 250_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as AssistantMessage;
		// Same media-budget body as mediaBudgetPayloadAssistant, but the
		// provider accounting reports input tokens above the model window:
		// authoritative overflow evidence that outranks the payload wording.
		message.errorId = AIError.classifyMessage(message);
		return message;
	}

	it("honestly skips token compaction for a low-token payload-shaped 413", async () => {
		await createSession(200_000);
		const checkSpy = vi.spyOn(SessionMaintenance.prototype, "checkCompaction");
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const notices = collectNotices();
		const endCount = countCompactionEvents("auto_compaction_end");

		const assistantMsg = payloadRejectionAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		// No recovery compaction ran at all: the local gauge has headroom, so a
		// token-context pass cannot address a byte/media budget.
		expect(endCount()).toBe(0);
		expect(prepareSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();

		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(1);
		expect(payloadNotices[0].level).toBe("warning");
		expect(payloadNotices[0].message).not.toContain(NO_PROGRESS_FRAGMENT);

		// The honest-skip blocks automatic continuation of the identical
		// failing payload.
		const checkResults = await Promise.all(
			checkSpy.mock.results.map(r => r.value as { automaticContinuationBlocked?: boolean }),
		);
		expect(checkResults.some(r => r.automaticContinuationBlocked === true)).toBe(true);
	});

	it("falls through to overflow recovery when the local gauge shows no headroom", async () => {
		await createSession(8_000, { toolText: "y".repeat(60_000) });
		// ~15k estimated tokens against the 8k window — over the 90% headroom
		// bar, so the provider's accounting may still be right: trust it and
		// run the normal overflow recovery instead of skipping.

		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const notices = collectNotices();
		const startCount = countCompactionEvents("auto_compaction_start");
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = payloadRejectionAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		// Recovery compaction ran; no payload-specific notice fired.
		expect(startCount()).toBeGreaterThanOrEqual(1);
		expect(prepareSpy).toHaveBeenCalled();
		expect(notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413")).length).toBe(0);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("keeps genuine token-worded overflows on the normal overflow path", async () => {
		await createSession(200_000);
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const notices = collectNotices();
		const startCount = countCompactionEvents("auto_compaction_start");
		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});
		const assistantMsg = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "error",
			errorMessage: "prompt is too long: 300000 tokens > 200000 maximum",
			usage: {
				input: 1000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as AssistantMessage;
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		// Precedence pin: token evidence wins over the low-token gauge — the
		// standard overflow recovery runs and no payload notice appears.
		expect(startCount()).toBeGreaterThanOrEqual(1);

		expect(prepareSpy).toHaveBeenCalled();
		expect(notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413")).length).toBe(0);
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("treats a payload-only 413 as terminal without a local context window", async () => {
		await createSession(null);
		const checkSpy = vi.spyOn(SessionMaintenance.prototype, "checkCompaction");
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const notices = collectNotices();
		const endCount = countCompactionEvents("auto_compaction_end");

		const assistantMsg = payloadRejectionAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		// A missing gauge (custom/discovered models carry contextWindow: null)
		// must not resurrect the ineffective-compaction path: the unambiguous
		// payload rejection still surfaces and blocks the resend.
		expect(endCount()).toBe(0);
		expect(prepareSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();

		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(1);
		expect(payloadNotices[0].level).toBe("warning");
		// Gauge-less notice variant: no headroom claim, no dead-end fragment.
		expect(payloadNotices[0].message).not.toContain("headroom");
		expect(payloadNotices[0].message).not.toContain(NO_PROGRESS_FRAGMENT);

		const checkResults = await Promise.all(
			checkSpy.mock.results.map(r => r.value as { automaticContinuationBlocked?: boolean }),
		);
		expect(checkResults.some(r => r.automaticContinuationBlocked === true)).toBe(true);
	});

	it("reports a usage-backed payload-shaped dead end as a token-context problem", async () => {
		// Media-budget wording (dual-classified) with provider-reported input
		// tokens above the window: the accounting routes this into overflow
		// recovery, and with no promotion target and compaction disabled the
		// dead-end notice must diagnose token context — not parrot the payload
		// wording's "NOT a token-context problem" (#9235 review).
		await createSession(200_000, undefined, { extraSettings: { "compaction.enabled": false } });
		const checkSpy = vi.spyOn(SessionMaintenance.prototype, "checkCompaction");
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const notices = collectNotices();

		const assistantMsg = usageBackedMediaBudgetAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		expect(prepareSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();

		const deadEndNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.level === "warning");
		expect(deadEndNotices.length).toBe(1);
		expect(deadEndNotices[0].message).toContain("IS a token-context problem");
		expect(deadEndNotices[0].message).not.toContain("NOT a token-context problem");

		const checkResults = await Promise.all(
			checkSpy.mock.results.map(r => r.value as { automaticContinuationBlocked?: boolean }),
		);
		expect(checkResults.some(r => r.automaticContinuationBlocked === true)).toBe(true);
	});

	function activateOngoingGoal(id: string): void {
		const now = Date.now();
		session.setGoalModeState({
			enabled: true,
			mode: "active",
			goal: {
				id,
				objective: "finish the ongoing work",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			},
		});
	}

	it("consults a configured fallback chain in goal mode before any maintenance outcome stands", async () => {
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!fallbackModel) {
			throw new Error("Expected bundled openai fallback model to exist");
		}

		const requestedModels: string[] = [];
		// One mock per model identity: the mock stamps its own id/provider
		// onto emitted AssistantMessages, and `sameModel` arbitration in
		// checkCompaction compares those against the session model.
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		const fallbackMock = createMockModel({ id: fallbackModel.id, provider: fallbackModel.provider });
		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		await createSession(200_000, undefined, {
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === "anthropic") {
					primaryMock.push({ throw: PAYLOAD_ERROR_MESSAGE });
					return primaryMock.stream(model, context, options);
				}
				fallbackMock.push({ content: ["recovered on configured fallback"] });
				return fallbackMock.stream(model, context, options);
			},
			extraSettings: {
				"retry.baseDelayMs": 5,
				"retry.modelFallback": true,
				"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
			},
		});
		activateOngoingGoal("goal-fallback");
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});

		const notices = collectNotices();
		const endCount = countCompactionEvents("auto_compaction_end");

		await session.prompt("work on the goal");
		await session.waitForIdle();

		// The chain consult happens BEFORE checkCompaction, mirroring the
		// non-goal ladder: a successful switch means maintenance never runs,
		// so no honest-skip notice fires (parity with non-goal mode) and no
		// compaction ever starts.
		expect(endCount()).toBe(0);
		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(0);
		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5", `${fallbackModel.provider}/${fallbackModel.id}`]);
		expect(fallbackEvents).toHaveLength(1);
		expect(fallbackEvents[0].to).toBe(`${fallbackModel.provider}/${fallbackModel.id}`);
		expect(session.model?.provider).toBe(fallbackModel.provider);
	});

	it("consults a configured fallback chain for dual-flag bare-413 rejections", async () => {
		// Bare "413 status code (no body)" classifies as BOTH PayloadRejected
		// and ContextOverflow. The overflow co-flag must not bar model
		// switching: a different provider's byte budget can accept the very
		// request the primary rejected, so the configured chain is consulted
		// before any maintenance outcome stands (#9235 review).
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!fallbackModel) {
			throw new Error("Expected bundled openai fallback model to exist");
		}

		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		const fallbackMock = createMockModel({ id: fallbackModel.id, provider: fallbackModel.provider });
		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		await createSession(200_000, undefined, {
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === "anthropic") {
					primaryMock.push({ throw: "413 status code (no body)" });
					return primaryMock.stream(model, context, options);
				}
				fallbackMock.push({ content: ["recovered on configured fallback"] });
				return fallbackMock.stream(model, context, options);
			},
			extraSettings: {
				"retry.baseDelayMs": 5,
				"retry.modelFallback": true,
				"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
			},
		});
		activateOngoingGoal("goal-dual-flag-fallback");
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});

		const notices = collectNotices();
		const endCount = countCompactionEvents("auto_compaction_end");

		await session.prompt("work on the goal");
		await session.waitForIdle();

		expect(endCount()).toBe(0);
		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(0);
		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5", `${fallbackModel.provider}/${fallbackModel.id}`]);
		expect(fallbackEvents).toHaveLength(1);
		expect(fallbackEvents[0].to).toBe(`${fallbackModel.provider}/${fallbackModel.id}`);
		expect(session.model?.provider).toBe(fallbackModel.provider);
	});

	it("routes goal-mode transient failures exactly like the non-goal ladder", async () => {
		// The pre-compaction chain consult is scoped to payload rejections
		// (#9235 review): every other failure follows the standard ladder, so a
		// transient 5xx in goal mode reaches handleRetryableError through the
		// retryable rung and gets the same configured-chain consult the non-goal
		// path applies — the early consult must neither add nor skip rungs.
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!fallbackModel) {
			throw new Error("Expected bundled openai fallback model to exist");
		}

		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		const chainMock = createMockModel({ id: fallbackModel.id, provider: fallbackModel.provider });
		await createSession(200_000, undefined, {
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === "anthropic") {
					primaryMock.push({ throw: TRANSIENT_ERROR_MESSAGE });
					return primaryMock.stream(model, context, options);
				}
				chainMock.push({ content: ["recovered on configured fallback"] });
				return chainMock.stream(model, context, options);
			},
			extraSettings: {
				"retry.baseDelayMs": 5,
				"retry.modelFallback": true,
				"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
			},
		});
		activateOngoingGoal("goal-transient-ladder");

		await session.prompt("work on the goal");
		await session.waitForIdle();

		// Same-model request first, then the configured candidate — identical
		// to the non-goal ladder for this error class.
		expect(requestedModels.slice(0, 2)).toEqual([
			"anthropic/claude-sonnet-4-5",
			`${fallbackModel.provider}/${fallbackModel.id}`,
		]);
		expect(session.model?.provider).toBe(fallbackModel.provider);
	});

	it("keeps usage-backed payload overflows off the configured chain", async () => {
		// Provider-reported input tokens above the window are authoritative
		// overflow evidence: maintenance's arbitration owns them like pure
		// overflows, so payload wording must not convert a token excess into a
		// model switch when a viable chain candidate exists (#9235 review).
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!fallbackModel) {
			throw new Error("Expected bundled openai fallback model to exist");
		}

		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		let failedOnce = false;
		await createSession(200_000, undefined, {
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				primaryMock.push(
					failedOnce
						? { content: ["made progress after compaction"] }
						: {
								content: [],
								stopReason: "error",
								errorMessage: "request_too_large: image count exceeds the limit of 20",
								usage: { input: 250_000 },
							},
				);
				failedOnce = true;
				return primaryMock.stream(model, context, options);
			},
			extraSettings: {
				"retry.baseDelayMs": 5,
				"retry.modelFallback": true,
				"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
			},
		});
		activateOngoingGoal("goal-usage-backed");
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});
		const startCount = countCompactionEvents("auto_compaction_start");

		await session.prompt("work on the goal");
		await session.waitForIdle();

		expect(fallbackEvents).toHaveLength(0);
		expect(requestedModels.every(m => m.startsWith("anthropic/"))).toBe(true);
		// Maintenance actually ran its overflow remedy instead of ceding the
		// turn to the configured chain.
		expect(startCount()).toBeGreaterThanOrEqual(1);
	});

	it("keeps the goal-mode BLOCK terminal when no fallback chain is configured", async () => {
		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		await createSession(200_000, undefined, {
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				primaryMock.push({ throw: PAYLOAD_ERROR_MESSAGE });
				return primaryMock.stream(model, context, options);
			},
		});
		activateOngoingGoal("goal-terminal");

		const notices = collectNotices();

		await session.prompt("work on the goal");
		await session.waitForIdle();

		// Without a configured chain there is no fresh chance to grant: the
		// payload rejection stays terminal — exactly one request, honest
		// warning surfaced, no resend and no compaction detour.
		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5"]);
		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(1);
		expect(payloadNotices[0].level).toBe("warning");
	});
	it("does not blind-resend a transient-wrapped payload rejection before maintenance sees it", async () => {
		// "Provider returned error: 413 ..." classifies as PayloadRejected +
		// Transient. The transient flag must not buy a same-model retry: the
		// unchanged oversized request cannot succeed, so the failure must fall
		// through the retry ladder straight into payload arbitration.
		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		await createSession(
			200_000,
			{ toolText: "seed" },
			{
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					primaryMock.push({ throw: "Provider returned error: 413 Payload Too Large" });
					return primaryMock.stream(model, context, options);
				},
				extraSettings: { "retry.baseDelayMs": 5 },
			},
		);

		const notices = collectNotices();
		const startCount = countCompactionEvents("auto_compaction_start");
		await session.prompt("hello");
		await session.waitForIdle();

		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5"]);
		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(1);
		expect(payloadNotices[0].level).toBe("warning");
		expect(startCount()).toBe(0);
	});
	it("consults the chain before overflow maintenance absorbs a high-occupancy payload rejection", async () => {
		const fallbackModel = getBundledModel("openai", "gpt-4o-mini");
		if (!fallbackModel) {
			throw new Error("Expected bundled openai fallback model to exist");
		}

		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		const fallbackMock = createMockModel({ id: fallbackModel.id, provider: fallbackModel.provider });
		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		// Stored context far above 90% of the tiny window forces the
		// payload-only 413 down checkCompaction's overflow gate (not the
		// trusted-BLOCK pre-gate). That gate applies its remedy — here a
		// context-promotion model switch — BEFORE returning a continuation
		// result, so goal mode must consult the configured chain before
		// calling checkCompaction at all; consulting on the result would let
		// promotion absorb the failure first, an ordering non-goal mode
		// never applies (its ladder consults the chain pre-compaction).
		await createSession(
			2_000,
			{ toolText: "x".repeat(40_000) },
			{
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					if (model.provider === "anthropic") {
						primaryMock.push({ throw: PAYLOAD_ERROR_MESSAGE });
						return primaryMock.stream(model, context, options);
					}
					fallbackMock.push({ content: ["recovered on configured fallback"] });
					return fallbackMock.stream(model, context, options);
				},
				extraSettings: {
					"retry.baseDelayMs": 5,
					"retry.modelFallback": true,
					"retry.fallbackChains": { default: [`${fallbackModel.provider}/${fallbackModel.id}`] },
					// The larger-window candidate is also a valid promotion
					// target; the chain must win the race from INSIDE the
					// goal branch (fallback event proves it was the chain,
					// not promotion, that switched models).
					"contextPromotion.enabled": true,
					// Compaction fully off: the tiny window would otherwise fire
					// independent threshold passes (their trigger clamps to
					// window-1, so no threshold value can silence them). With
					// compaction off, any auto_compaction event seen below can
					// only come from the post-error remedy ordering under test.
					"compaction.enabled": false,
				},
			},
		);
		activateOngoingGoal("goal-high-occupancy");
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});
		const notices = collectNotices();
		const startCount = countCompactionEvents("auto_compaction_start");
		const endCount = countCompactionEvents("auto_compaction_end");
		await session.prompt("work on the goal");
		await session.waitForIdle();

		// The chain wins before any overflow remedy can: switched via the
		// configured candidate, no compaction started or finished, and no
		// maintenance notice surfaced.
		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5", `${fallbackModel.provider}/${fallbackModel.id}`]);
		expect(fallbackEvents).toHaveLength(1);
		expect(session.model?.provider).toBe(fallbackModel.provider);
		expect(startCount()).toBe(0);
		expect(endCount()).toBe(0);
		expect(notices.filter(n => n.source === NOTICE_SOURCE)).toHaveLength(0);
	});
	it("believes provider-reported usage when it contradicts a payload-only body", async () => {
		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		await createSession(
			200_000,
			{ toolText: "seed" },
			{
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					// In-run error (not `throw`): only this shape carries the
					// provider-reported usage through to the assistant message.
					primaryMock.push({
						stopReason: "error",
						errorMessage: PAYLOAD_ERROR_MESSAGE,
						usage: { input: 250_000 },
					});
					return primaryMock.stream(model, context, options);
				},
			},
		);
		const overflowStarts: Array<Extract<AgentSessionEvent, { type: "auto_compaction_start" }>> = [];
		session.subscribe(event => {
			if (event.type === "auto_compaction_start" && event.reason === "overflow") overflowStarts.push(event);
		});
		const notices = collectNotices();
		await session.prompt("trigger usage-backed overflow");
		await session.waitForIdle();

		// Reported usage (250k > 200k window) is authoritative overflow
		// evidence: the failure must route into the recovery gate instead of
		// the terminal payload BLOCK, with no payload notice surfaced.
		expect(requestedModels[0]).toBe("anthropic/claude-sonnet-4-5");
		expect(overflowStarts.length).toBeGreaterThanOrEqual(1);
		expect(notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"))).toHaveLength(0);
	});

	it("blocks automatic continuation when a high-occupancy payload rejection has no runnable recovery", async () => {
		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		await createSession(
			2_000,
			{ toolText: "x".repeat(40_000) },
			{
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					primaryMock.push({ throw: PAYLOAD_ERROR_MESSAGE });
					return primaryMock.stream(model, context, options);
				},
				extraSettings: {
					// No remedy may exist: compaction off, no promotion
					// target, no fallback chain. The BLOCK (with its honest
					// warning) is then the only correct outcome — a silent
					// NONE would let an automatic goal continuation resend
					// the identical rejected payload forever.
					"compaction.enabled": false,
					"contextPromotion.enabled": false,
				},
			},
		);
		activateOngoingGoal("goal-no-runnable-recovery");
		const notices = collectNotices();
		const startCount = countCompactionEvents("auto_compaction_start");
		await session.prompt("work on the goal");
		await session.waitForIdle();

		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5"]);
		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(1);
		expect(payloadNotices[0].level).toBe("warning");
		expect(startCount()).toBe(0);
	});
	it("persists the terminal payload 413 when an active goal dead ends", async () => {
		// #9235 review: the goal-mode BLOCK early return skips the standard
		// error tail that records skipped empty error turns — without an
		// explicit persist, the session JSONL ends at the last tool result and
		// a reopened session shows no trace of why the run stopped.
		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		await createSession(
			2_000,
			{ toolText: "x".repeat(40_000) },
			{
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					primaryMock.push({ throw: PAYLOAD_ERROR_MESSAGE });
					return primaryMock.stream(model, context, options);
				},
				extraSettings: {
					"compaction.enabled": false,
					"contextPromotion.enabled": false,
				},
			},
		);
		activateOngoingGoal("goal-persist-terminal-413");
		await session.prompt("work on the goal");
		await session.waitForIdle();

		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5"]);
		const terminalErrors = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => (entry as { message?: AssistantMessage }).message)
			.filter(message => message?.role === "assistant" && message.stopReason === "error");
		expect(terminalErrors).toHaveLength(1);
		expect(terminalErrors[0]?.errorMessage).toContain("413");
	});
	it("blocks dual-flag bare-413 dead ends even though overflow evidence is present", async () => {
		// Bare "413 status code (no body)" classifies as BOTH PayloadRejected
		// and ContextOverflow. High occupancy forces the gate entry and
		// overflowEvidence is true, but with no runnable remedy the failure
		// must still BLOCK: resending is futile regardless of which truth
		// the ambiguity hides.
		const requestedModels: string[] = [];
		const primaryMock = createMockModel({ id: "claude-sonnet-4-5", provider: "anthropic" });
		await createSession(
			2_000,
			{ toolText: "x".repeat(40_000) },
			{
				streamFn: (model, context, options) => {
					requestedModels.push(`${model.provider}/${model.id}`);
					primaryMock.push({ throw: "413 status code (no body)" });
					return primaryMock.stream(model, context, options);
				},
				extraSettings: {
					"compaction.enabled": false,
					"contextPromotion.enabled": false,
				},
			},
		);
		activateOngoingGoal("goal-dual-flag-dead-end");
		const notices = collectNotices();
		const startCount = countCompactionEvents("auto_compaction_start");
		await session.prompt("work on the goal");
		await session.waitForIdle();

		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5"]);
		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(1);
		expect(payloadNotices[0].level).toBe("warning");
		expect(startCount()).toBe(0);
	});

	it("blocks status-only Content Too Large rejections with no context window", async () => {
		// Adapters that surface request-size rejections as HTTP 413 plus an
		// opaque reason phrase classify PayloadRejected via the status
		// fallback; the identical request must never be blind-resent
		// (#9235 review).
		await createSession(null);
		const checkSpy = vi.spyOn(SessionMaintenance.prototype, "checkCompaction");
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const notices = collectNotices();
		const startCount = countCompactionEvents("auto_compaction_start");

		const assistantMsg = statusOnlyPayloadAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		expect(startCount()).toBe(0);
		expect(prepareSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(1);
		const checkResults = await Promise.all(
			checkSpy.mock.results.map(r => r.value as { automaticContinuationBlocked?: boolean }),
		);
		expect(checkResults.some(r => r.automaticContinuationBlocked === true)).toBe(true);
	});

	it("honestly skips compaction for media-budget numeric-limit rejections", async () => {
		// "request_too_large + image count exceeds the limit of 20" keeps its
		// payload flag now that generic numeric limits no longer veto it, and
		// local usage shows real headroom: no compaction may run against a
		// budget token compaction cannot shrink (#9235 review).
		await createSession(200_000);
		const checkSpy = vi.spyOn(SessionMaintenance.prototype, "checkCompaction");
		const prepareSpy = vi.spyOn(compactionModule, "prepareCompaction");
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const notices = collectNotices();
		const startCount = countCompactionEvents("auto_compaction_start");

		const assistantMsg = mediaBudgetPayloadAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await session.waitForIdle();

		expect(startCount()).toBe(0);
		expect(prepareSpy).not.toHaveBeenCalled();
		expect(promptSpy).not.toHaveBeenCalled();
		expect(continueSpy).not.toHaveBeenCalled();
		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(1);
		const checkResults = await Promise.all(
			checkSpy.mock.results.map(r => r.value as { automaticContinuationBlocked?: boolean }),
		);
		expect(checkResults.some(r => r.automaticContinuationBlocked === true)).toBe(true);
	});
});
