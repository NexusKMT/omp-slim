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

	it("consults a configured fallback chain in goal mode before the BLOCK stands", async () => {
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

		// The honest-skip still surfaces the payload rejection and no
		// compaction runs…
		expect(endCount()).toBe(0);
		const payloadNotices = notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes("413"));
		expect(payloadNotices.length).toBe(1);
		// …but the terminal BLOCK must not pre-empt the user-configured chain:
		// active goals get the same fallback opportunity as the non-goal
		// recovery ladder.
		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5", `${fallbackModel.provider}/${fallbackModel.id}`]);
		expect(fallbackEvents).toHaveLength(1);
		expect(fallbackEvents[0].to).toBe(`${fallbackModel.provider}/${fallbackModel.id}`);
		expect(session.model?.provider).toBe(fallbackModel.provider);
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
});
