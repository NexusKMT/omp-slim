import {
	type Agent,
	AgentBusyError,
	type AgentMessage,
	isSyntheticToolResultMessage,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	AssistantRetryRecovery,
	AssistantRetryRecoveryKind,
	CodexCompactionContext,
	Effort,
	Model,
	TextContent,
	ToolChoice,
} from "@oh-my-pi/pi-ai";
import { calculateRateLimitBackoffMs, isBillingCapUsageLimit, parseRateLimitReason } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { shouldDropTruncatedThinkingOnlyAssistant } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { extractProviderRetryHint } from "@oh-my-pi/pi-ai/utils/retry-after";
import { isUnexpectedSocketCloseMessage, logger, prompt, sleepLong, sleepUntil } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelStringWithRouting } from "../config/model-resolver";

import type { Settings } from "../config/settings";
import type { RetryErrorUpdate } from "../extensibility/shared-events";
import { isEvalStateContext } from "../eval/state";
import emptyStopRetryTemplate from "../prompts/system/empty-stop-retry.md" with { type: "text" };
import malformedFunctionCallRetryTemplate from "../prompts/system/malformed-function-call-retry.md" with { type: "text" };
import streamStallContinueTemplate from "../prompts/system/stream-stall-continue.md" with { type: "text" };
import thinkingLoopRedirectTemplate from "../prompts/system/thinking-loop-redirect.md" with { type: "text" };
import unexpectedStopRetryTemplate from "../prompts/system/unexpected-stop-retry.md" with { type: "text" };
import { type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { EditModeSetting } from "../edit/settings";
import type { AgentSessionEvent } from "./agent-session-events";
import type { ResetRecoveryResult } from "./codex-auto-reset";
import { assistantTurnProducedOutput, isEmptyAssistantStop, isEmptyErrorTurn, isUserAuthoredMessage } from "./messages";
import { calculateRetryBackoffDelayMs, formatRetryFallbackSelector, type ServingModel } from "./retry-fallback-chains";
import { getLatestCompactionEntry } from "./session-context";
import { type SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";
import { isUserQueuedMessage } from "./queued-messages";
import { sameMessageContent, sessionMessagePersistenceKey } from "./turn-persistence";
import { isUnexpectedStopCandidate } from "./unexpected-stop-classifier";

import { cfgFeaturesUnexpectedStopDetection, cfgModelLoopGuardEnabled, cfgRetry, cfgRetryEnabled } from "./settings";

const THINKING_LOOP_REDIRECT_TYPE = "thinking-loop-redirect";
const UNEXPECTED_STOP_MAX_RETRIES = 3;
const EMPTY_STOP_MAX_RETRIES = 3;
const MALFORMED_FUNCTION_CALL_MAX_RETRIES = 3;
const STREAM_STALL_CONTINUE_MAX_RETRIES = 3;
const SIBLING_UNBLOCK_BUFFER_MS = 1_000;
const NON_WHITESPACE_RE = /\S/;
const USAGE_PREFLIGHT_BLOCKED_PREFIX = "Usage preflight blocked:";
const STREAM_STALL_ERROR_RE = /stream stall/i;
const HTTP2_STREAM_RESET_ERROR_RE =
	/stream closed with error code\s+nghttp2_(?:internal_error|refused_stream)|nghttp2_(?:internal_error|refused_stream)|HTTP2(?:StreamReset|RefusedStream)/i;
// Gateway/provider closes a stream mid-generation without its terminal chunk
// (openai-completions "finish_reason", openai/azure responses "terminal
// response event", Codex "terminal completion event", Cursor "turnEnded" —
// an HTTP/2 reset can settle as the stream end rather than the RST error).
// Same transport-failure class as the stall/reset entries: retriable, and
// eligible for preserved-turn continuation on resolved tool turns.
const PREMATURE_STREAM_CLOSE_ERROR_RE =
	/(?:stream closed before a (?:finish_reason|terminal response event)|Codex stream ended before terminal completion event|Cursor stream ended before turnEnded)/i;

/**
 * Bare abort sentinels with no provider reason: our own `"Request was aborted"`
 * plus Node/Bun `AbortError`s (`"The operation was aborted"`) surfaced by
 * transports when an internal (non-caller) abort fires.
 */
const GENERIC_ABORT_MESSAGES: Record<string, true> = {
	"Request was aborted": true,
	"Request was aborted.": true,
	"The operation was aborted": true,
	"The operation was aborted.": true,
};

function hasNonWhitespace(value: string): boolean {
	return NON_WHITESPACE_RE.test(value);
}

/**
 * End of the conversation in `messages`, before trailing context-only custom
 * messages: eval runtime snapshots (appended at startup and on display-context
 * rebuilds) and deliveries folded in without a turn — e.g. an `async-result`
 * landing while a user interrupt suppresses auto-resume. They trail a failed
 * turn without ending it. A user-authored custom prompt is conversation.
 */
function conversationEnd(messages: readonly AgentMessage[]): number {
	let end = messages.length;
	while (end > 0 && messages[end - 1].role === "custom" && !isUserAuthoredMessage(messages[end - 1])) end--;
	return end;
}

function syntheticToolResultTailStart(messages: readonly AgentMessage[]): number {
	let index = conversationEnd(messages);
	while (index > 0 && isSyntheticToolResultMessage(messages[index - 1])) {
		index--;
	}
	return index;
}

function retryableAssistantTurnEnd(messages: readonly AgentMessage[]): number | undefined {
	const turnEnd = syntheticToolResultTailStart(messages);
	const message = messages[turnEnd - 1];
	if (message?.role !== "assistant") return undefined;
	if (message.stopReason !== "error" && message.stopReason !== "aborted") return undefined;
	return turnEnd;
}
/** An assistant turn cut off before any text or tool call; no provider replays it. */
function isCutOffAssistant(message: AgentMessage): boolean {
	return message.role === "assistant" && shouldDropTruncatedThinkingOnlyAssistant(message);
}

/**
 * The last prompt in `messages[0, end)` that no replayed assistant turn has
 * answered yet: a user prompt, or the operator's `.`/`c` continue directive.
 */
function unansweredPrompt(messages: readonly AgentMessage[], end: number): AgentMessage | undefined {
	for (let index = end - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant") {
			if (!isCutOffAssistant(message)) return undefined;
		} else if (isUserQueuedMessage(message) || (message.role === "developer" && message.userInitiated === true)) {
			return message;
		}
	}
	return undefined;
}

/** Whether `messages` ends in a failed/aborted turn whose most recent activity was a tool call. */
function abortedToolCallTail(messages: readonly AgentMessage[]): boolean {
	const turnEnd = retryableAssistantTurnEnd(messages);
	if (turnEnd === undefined) return false;
	// Synthetic tool results only ever trail a turn that emitted tool calls.
	if (isSyntheticToolResultMessage(messages[turnEnd])) return true;
	const beforeTurn = messages[turnEnd - 2];
	return beforeTurn?.role === "toolResult" && beforeTurn.isError === true;
}
/**
 * Index of the first trailing failed tool result to strip for a tool replay,
 * or undefined when the tail does not qualify.
 *
 * Qualifies when the transcript ends in a fully failed/aborted tool batch
 * whose anchor assistant turn completed with runnable arguments
 * (`toolUse`/`stop`) — optionally followed by an aborted boundary with no tool
 * calls of its own (a live Esc; a restored session has already dropped it).
 * Stripping from the returned index leaves that assistant as the transcript
 * tail, which `Agent.continue()` resumes by re-executing the calls. A
 * partially successful batch never qualifies: re-running a completed call
 * would repeat its side effects. Synthetic placeholder tails never qualify
 * either — their anchor is the aborted turn itself and its arguments may be
 * truncated, so those are re-generated via a fresh model call instead. Nor
 * does a tail carrying a delivery other than an eval snapshot: the strip
 * would erase it from history, while a fresh model call keeps it in context.
 */
function toolReplayStart(messages: readonly AgentMessage[]): number | undefined {
	let end = conversationEnd(messages);
	for (let i = end; i < messages.length; i++) {
		if (!isEvalStateContext(messages[i])) return undefined;
	}
	const tail = messages[end - 1];
	if (tail?.role === "assistant") {
		if (tail.stopReason !== "aborted" && tail.stopReason !== "error") return undefined;
		if (tail.content.some(block => block.type === "toolCall")) return undefined;
		end -= 1;
	}
	let start = end;
	while (start > 0 && messages[start - 1].role === "toolResult") start--;
	if (start === end) return undefined;
	const anchor = messages[start - 1];
	if (anchor?.role !== "assistant") return undefined;
	if (anchor.stopReason !== "toolUse" && anchor.stopReason !== "stop") return undefined;
	const callIds = new Set<string>();
	for (const block of anchor.content) {
		if (block.type === "toolCall") callIds.add(block.id);
	}
	if (end - start !== callIds.size) return undefined;
	for (let i = start; i < end; i++) {
		const result = messages[i];
		if (result.role !== "toolResult" || result.isError !== true || !callIds.has(result.toolCallId)) {
			return undefined;
		}
	}
	return start;
}

/** Result shape shared with automatic maintenance recovery. */
export interface RecoveryCompactionResult {
	continuationScheduled: boolean;
	automaticContinuationBlocked?: boolean;
	historyRewritten?: boolean;
}

type RequestBodyReadTimeoutRecovery = "not-applicable" | "handled-retry" | "handled-terminal";

/** Capabilities borrowed from the owning AgentSession. */
export interface TurnRecoveryHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	configWarnings: string[];
	model(): Model | undefined;
	/**
	 * Whether the live context fits `model`'s usable window. `excludedMessage`
	 * identifies a failed assistant turn that will be removed before retrying, so
	 * selection judges the request that will actually be sent. See
	 * `SessionMaintenance.contextFitsModel`.
	 */
	contextFitsModel(model: Model, excludedMessage?: AssistantMessage): boolean;
	/** Whether streamed text has already been committed to the active output sink. */
	textOutputCommitted(): boolean;
	thinkingLevel(): ThinkingLevel | undefined;
	configuredThinkingLevel(): ConfiguredThinkingLevel | undefined;
	setThinkingLevel(level: ConfiguredThinkingLevel | undefined): void;
	/** Hard per-session effort ceiling; fallback recovery must never raise thinking above it. */
	thinkingLevelCeiling(): Effort | undefined;
	/** The session never switches to a retry fallback model (a per-call `model` subagent). */
	modelFallbackDisabled?(): boolean;
	isDisposed(): boolean;
	isStreaming(): boolean;
	isCompacting(): boolean;
	abortInProgress(): boolean;
	streamingEditAbortTriggered(): boolean;
	promptGeneration(): number;
	promptSequence(): number;
	/**
	 * Live post-prompt abort signal; aborted when the user interrupts (Esc),
	 * the turn is superseded, or the session is torn down. The unexpected-stop
	 * judge wait links its timeout to this signal so a slow verdict never
	 * blocks the abort drain. Optional so partial test stubs that never reach
	 * the judge path need not provide it.
	 */
	unexpectedStopAbortSignal?(): AbortSignal;
	sessionId(): string;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	scheduleAgentContinue(options: {
		source: string;
		delayMs?: number;
		generation?: number;
		shouldContinue?: () => boolean;
		onError?: (error: unknown) => void;
	}): void;
	waitForSessionMessagePersistence(message: AssistantMessage): Promise<void>;
	appendSessionMessage(message: AssistantMessage): void;
	persistedAssistantEntryId(message: AssistantMessage): string | undefined;
	sessionMessageAlreadyPersisted(message: AssistantMessage): boolean;
	setModelWithProviderSessionReset(model: Model): Promise<void>;
	/** Edit mode resolved for the active model and settings, captured before a fallback swap. */
	resolveActiveEditMode(): EditModeSetting;
	/**
	 * Rebuilds the model-dependent base system prompt after a swap. Retry fallback passes
	 * `retryFallback`, which rebuilds only for an edit-mode change so the cached prompt survives.
	 */
	syncAfterModelChange(previousEditMode: EditModeSetting, options?: { retryFallback?: boolean }): Promise<void>;
	resetCurrentResponsesProviderSession(reason: string): void;
	/**
	 * Spend an eligible saved reset for the blocked provider pool.
	 * `activeBlockUnblockAtMs` is the absolute unblock time parsed from the live
	 * usage-limit error and never substitutes for live grant eligibility.
	 */
	maybeAutoRedeemReset(activeBlockUnblockAtMs?: number): Promise<ResetRecoveryResult>;
	runAutoCompaction(
		reason: "overflow" | "threshold" | "idle" | "incomplete",
		willRetry: boolean,
		options?: {
			autoContinue?: boolean;
			triggerContextTokens?: number;
			suppressContinuation?: boolean;
			suppressHandoff?: boolean;
			phase?: CodexCompactionContext["phase"];
			terminalTextAnswer?: boolean;
			/** Skip `snapcompact` — a byte/payload-limit 413 recovery must not
			 *  retry with an even larger, media-heavy request (#11482). */
			excludeMediaMethods?: boolean;
		},
	): Promise<RecoveryCompactionResult>;
	shakeForRequestBodyReadTimeout(generation: number): Promise<boolean>;
	withBashBranchTransition<T>(operation: () => T): T;
}

type PendingRetryError = {
	entryId: string;
	persistenceKey: string;
	recovery: AssistantRetryRecoveryKind;
	attempt: number;
	note: string;
};

/** How a retry saga's pending error entries are annotated when it closes. */
type RetryErrorCompletion = { status: "recovered"; supersedingMessage: AssistantMessage } | { status: "superseded" };

/** The `auto_retry_end` a closing retry saga publishes; its `retryErrors` come from the close itself. */
type RetrySagaEnd = Omit<Extract<AgentSessionEvent, { type: "auto_retry_end" }>, "type" | "retryErrors">;

/** How {@link TurnRecovery.handleRetryableError} may recover a failed turn. */
type RetryPolicyOptions = {
	preserveFailedTurn?: boolean;
};

type UsageLimitOutcome = {
	switchedCredential: boolean;
	retryAfterMs: number;
	retryAtMs: number | undefined;
	blockedUntilMs: number | undefined;
	priorBlockedUntilMs: number | undefined;
	priorBlockedUntilTimed: boolean | undefined;
	reportResetAtMs: number | undefined;
};

/** Owns terminal-stop recovery and retries of the current model. */
export class TurnRecovery {
	readonly #host: TurnRecoveryHost;

	#retryAbortController: AbortController | undefined;
	#retryAttempt = 0;

	/** Per-model account walk allowance, snapshotted once and cleared when the retry saga ends. */
	readonly #accountPolicyRotationsRemaining = new Map<string, number>();
	#requestBodyReadTimeoutRecoveryPromptSequence: number | undefined;
	#retryPromise: Promise<void> | undefined;
	#retryResolve: (() => void) | undefined;

	#pendingRetryErrors: PendingRetryError[] = [];
	#usageLimitOutcomes = new WeakMap<AssistantMessage, Promise<UsageLimitOutcome>>();
	#emptyStopRetryCount = 0;
	#unexpectedStopRetryCount = 0;
	#malformedFunctionCallRetryCount = 0;
	#streamStallContinueCount = 0;
	#acceptTerminalEmptyStopForPrompt = false;
	/**
	 * Attribution of the newest turn that produced output, tagged with the
	 * session it belongs to. Anchoring rather than resetting follows
	 * `#ensurePersistedMessageKeys`: every real switch mints a new session id, so
	 * stale attribution drops itself and no mutation call site has to remember to
	 * clear it. The id — not the file — is the anchor because an unpersisted
	 * session has no file, and comparing two `undefined`s would never invalidate.
	 */
	#lastServed: { attribution: ServingModel; sessionId: string } | undefined;

	/** Memoized bootstrap answer, for the window before anything has served. */
	#bootstrapCache: { model: Model; level: ThinkingLevel | undefined; value: ServingModel } | undefined;

	constructor(host: TurnRecoveryHost) {
		this.#host = host;
	}

	/** Current automatic retry attempt. */
	get attempt(): number {
		return this.#retryAttempt;
	}

	/** Promise settled when the active retry saga finishes. */
	get retryPromise(): Promise<void> | undefined {
		return this.#retryPromise;
	}

	/**
	 * Model this session's produced work is attributed to.
	 *
	 * A model switch is a routing decision, not evidence the target can produce
	 * anything: a candidate that errors on its first request produced none of the
	 * turns already in this session. So attribution only ever names a model that
	 * has settled a turn here, and a switch — into a fallback, back to a restored
	 * primary, or anywhere else — moves it only once the new model answers.
	 *
	 * Before anything has served there is no earlier work to miscredit, so the
	 * configured model is both the only available answer and a safe one.
	 */
	get servingModel(): ServingModel | undefined {
		const served = this.#lastServed;
		if (served && served.sessionId === this.#host.sessionManager.getSessionId()) return served.attribution;
		const model = this.#host.model();
		if (!model) return undefined;
		// Polled per streaming event and per render, so the pre-first-turn window
		// must not format a selector on every call.
		const level = this.#host.thinkingLevel();
		const cached = this.#bootstrapCache;
		if (cached && cached.model === model && cached.level === level) {
			return cached.value;
		}
		const value: ServingModel = {
			selector: formatRetryFallbackSelector(model, level),
			modelIdentity: formatModelStringWithRouting(model),
			thinkingLevel: level,
			isFallback: false,
			contextWindow: model.contextWindow,
		};
		this.#bootstrapCache = { model, level, value };
		return value;
	}

	/**
	 * Carries attribution onto a new session id that continues this conversation.
	 *
	 * The session-id anchor assumes a new id means an unrelated transcript, which
	 * holds for `/new` and for resuming something else. A fork breaks that
	 * assumption on purpose: it clones the transcript and keeps running the same
	 * recovery state under a fresh id. Dropping attribution there would bootstrap
	 * an unproven fallback as the primary and re-credit it with the work the
	 * previous model did — the very bug the anchor exists to prevent.
	 *
	 * Only state belonging to `previousSessionId` moves, so an id left behind by
	 * an earlier switch stays expired.
	 */
	reanchorServedAttribution(previousSessionId: string): void {
		const sessionId = this.#host.sessionManager.getSessionId();
		if (this.#lastServed?.sessionId === previousSessionId) {
			this.#lastServed = { ...this.#lastServed, sessionId };
		}
	}

	/** Resets per-prompt recovery counters and terminal-stop acceptance. */
	resetForNewPrompt(): void {
		this.#emptyStopRetryCount = 0;
		this.#unexpectedStopRetryCount = 0;
		this.#malformedFunctionCallRetryCount = 0;
		this.#streamStallContinueCount = 0;
		this.#acceptTerminalEmptyStopForPrompt = false;
	}

	/** Sets whether one terminal empty stop is accepted for the current prompt. */
	setAcceptTerminalEmptyStop(accept: boolean): void {
		this.#acceptTerminalEmptyStopForPrompt = accept;
	}

	/**
	 * Records which model produced this turn, re-arms the one-shot Responses
	 * request-body-timeout recovery, then closes a successful retry saga and annotates recovered persisted
	 * errors.
	 */
	async onAssistantSettledSuccessfully(message: AssistantMessage): Promise<void> {
		if (!assistantTurnProducedOutput(message)) {
			return;
		}
		// A turn that produced output is forward progress: later history growth is
		// new, so the next exact full-replay body-read timeout gets its own single
		// shake-and-retry. Back-to-back timeouts never reach this point, so the
		// one-shot bound on an unchanged-request loop is unaffected.
		this.#requestBodyReadTimeoutRecoveryPromptSequence = undefined;
		const model = this.#host.model();
		if (model) {
			const level = this.#host.thinkingLevel();
			this.#lastServed = {
				attribution: {
					selector: formatRetryFallbackSelector(model, level),
					modelIdentity: formatModelStringWithRouting(model),
					thinkingLevel: level,
					isFallback: false,
					contextWindow: model.contextWindow,
				},
				sessionId: this.#host.sessionManager.getSessionId(),
			};
		}
		if (this.#retryAttempt === 0) {
			return;
		}
		await this.#closeRetrySaga(
			{ success: true, attempt: this.#retryAttempt },
			{ retryErrors: { status: "recovered", supersedingMessage: message } },
		);
	}

	/** Closes a failed retry saga when no compaction continuation took ownership. */
	async onErrorSettledWithoutRetry(message: AssistantMessage, compaction: RecoveryCompactionResult): Promise<void> {
		if (message.stopReason !== "error" || this.#retryAttempt === 0 || compaction.continuationScheduled) return;
		const attempt = this.#retryAttempt;
		this.#retryAttempt = 0;
		await this.#host.emitSessionEvent({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: message.errorMessage,
		});
		this.#clearPendingRetryErrors();
	}

	/** Persists an otherwise skipped terminal empty error turn. */
	persistTerminalEmptyErrorTurn(message: AssistantMessage): Promise<void> {
		return this.#persistTerminalEmptyErrorTurn(message);
	}

	/** Handles empty terminal assistant turns and schedules bounded recovery. */
	handleEmptyAssistantStop(message: AssistantMessage): Promise<"continue" | "terminal" | undefined> {
		return this.#handleEmptyAssistantStop(message);
	}

	/** Classifies suspicious terminal stops and schedules bounded recovery. */
	handleUnexpectedAssistantStop(message: AssistantMessage): Promise<boolean> {
		return this.#handleUnexpectedAssistantStop(message);
	}

	/**
	 * Continue past a provider-rejected function call that the replay-based
	 * retry declined. Gemini reports `MALFORMED_FUNCTION_CALL` when the model
	 * transcribes the call as text (`call:default_api:read{…}`, a tool_code
	 * fence) instead of emitting a structured call; the text is already
	 * rendered, so {@link isRetryableError} refuses to replay the turn and the
	 * session stopped on a pinned error. Nothing ran and nothing needs
	 * replaying: keep the failed turn in context so the model sees its own
	 * output, append a corrective developer message, and resume. Bounded per
	 * prompt; past the cap the error surfaces as before.
	 */
	handleMalformedFunctionCallStop(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const id = this.#classifyRetryMessage(message);
		if (!AIError.is(id, AIError.Flag.MalformedFunctionCall)) {
			this.#malformedFunctionCallRetryCount = 0;
			return false;
		}
		if (this.#host.abortInProgress() || this.#host.isDisposed()) return false;

		this.#malformedFunctionCallRetryCount++;
		if (this.#malformedFunctionCallRetryCount > MALFORMED_FUNCTION_CALL_MAX_RETRIES) {
			logger.warn("Assistant kept emitting malformed function calls after retry cap", {
				attempts: this.#malformedFunctionCallRetryCount - 1,
				model: message.model,
				provider: message.provider,
			});
			this.#malformedFunctionCallRetryCount = 0;
			return false;
		}

		logger.info("Malformed function call; continuing with corrective reminder", {
			attempt: this.#malformedFunctionCallRetryCount,
			model: message.model,
			provider: message.provider,
		});
		this.#host.agent.appendMessage({
			role: "developer",
			content: [
				{
					type: "text",
					text: prompt.render(malformedFunctionCallRetryTemplate, {
						retryCount: this.#malformedFunctionCallRetryCount,
						maxRetries: MALFORMED_FUNCTION_CALL_MAX_RETRIES,
					}),
				},
			],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.scheduleAgentContinue({
			source: "malformed-function-call-retry",
			generation: this.#host.promptGeneration(),
		});
		return true;
	}

	/**
	 * Continue past a mid-stream transport failure (idle stall, HTTP/2 reset,
	 * premature close, socket closed mid-body) that hit a text-only turn after
	 * its text rendered. {@link isRetryableError} refuses to replay committed
	 * text, and {@link classifyResolvedInterruptedToolTurn} only resumes turns
	 * with tool calls, so the session used to stop on a pinned error. Resuming
	 * from the trailing assistant message would be a prefill, which newer Claude
	 * models reject: keep the partial turn in context, append a developer
	 * reminder to pick up where the text stopped, and continue. Honors
	 * `retry.enabled`; bounded per prompt, past the cap the error surfaces as before.
	 * A socket close counts here but not for tool turns: without tool calls there
	 * is no executed side effect whose resumption policy it could change. So does a
	 * Codex native-lane steer rejection: the server dropped the response over our
	 * own `response.steer`, and the rejected steer drains as ordinary input next.
	 */
	handleCommittedTextStreamStall(message: AssistantMessage): boolean {
		const id = this.#classifyRetryMessage(message);
		const socketClosed =
			message.stopReason === "error" &&
			AIError.retriable(id) &&
			!this.#host.streamingEditAbortTriggered() &&
			isUnexpectedSocketCloseMessage(message.errorMessage ?? "");
		if (!socketClosed && !AIError.isCodexSteerRejection(message) && !this.#isMidStreamTransportFailure(message, id)) {
			this.#streamStallContinueCount = 0;
			return false;
		}
		if (!this.autoRetryEnabled || this.#host.abortInProgress() || this.#host.isDisposed()) return false;
		if (!this.#host.textOutputCommitted()) return false;
		let hasText = false;
		for (const block of message.content) {
			if (block.type === "toolCall" || block.type === "image" || block.type === "anthropicServerTool") return false;
			if (block.type === "text" && hasNonWhitespace(block.text)) hasText = true;
		}
		if (!hasText) return false;

		this.#streamStallContinueCount++;
		if (this.#streamStallContinueCount > STREAM_STALL_CONTINUE_MAX_RETRIES) {
			logger.warn("Stream kept stalling after committed text past retry cap", {
				attempts: this.#streamStallContinueCount - 1,
				model: message.model,
				provider: message.provider,
			});
			this.#streamStallContinueCount = 0;
			return false;
		}

		logger.info("Stream failed after committed text; continuing with resume reminder", {
			attempt: this.#streamStallContinueCount,
			model: message.model,
			provider: message.provider,
			errorMessage: message.errorMessage,
		});
		this.#host.agent.appendMessage({
			role: "developer",
			content: [
				{
					type: "text",
					text: prompt.render(streamStallContinueTemplate, {
						retryCount: this.#streamStallContinueCount,
						maxRetries: STREAM_STALL_CONTINUE_MAX_RETRIES,
					}),
				},
			],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.scheduleAgentContinue({
			source: "stream-stall-continue",
			generation: this.#host.promptGeneration(),
		});
		return true;
	}

	/** Removes a persisted failed assistant turn after its persistence slot settles; returns the dropped branch entry id. */
	dropPersistedAssistantTurn(message: AssistantMessage): Promise<string | undefined> {
		return this.#dropPersistedAssistantTurn(message);
	}

	/** Runs recovery compaction and restores the failed turn when no rewrite occurs. */
	runRecoveryCompactionWithRollback(
		reason: "overflow" | "incomplete",
		message: AssistantMessage,
		options: { autoContinue: boolean; triggerContextTokens?: number; excludeMediaMethods?: boolean },
	): Promise<RecoveryCompactionResult> {
		return this.#runRecoveryCompactionWithRollback(reason, message, options);
	}

	/** Applies current-model retry and credential rotation. */
	handleRetryableError(message: AssistantMessage, options?: RetryPolicyOptions): Promise<boolean> {
		return this.#handleRetryableError(message, options);
	}

	/**
	 * Records a usage-limit failure before replay eligibility decides whether the
	 * failed turn may be discarded. Returns whether credential recovery switched
	 * the active account.
	 */
	async recordUsageLimitOutcome(message: AssistantMessage): Promise<boolean> {
		if (message.stopReason !== "error") return false;
		const id = this.#classifyRetryMessage(message);
		const activeModel = this.#host.model();
		if (!activeModel || !AIError.is(id, AIError.Flag.UsageLimit)) return false;

		let recorded = this.#usageLimitOutcomes.get(message);
		if (!recorded) {
			const errorMessage = message.errorMessage || "Unknown error";
			const parsedRetryAfterMs = this.#parseRetryAfterMsFromError(errorMessage);
			const retryAfterMs = parsedRetryAfterMs ?? calculateRateLimitBackoffMs(parseRateLimitReason(errorMessage));
			recorded = (async (): Promise<UsageLimitOutcome> => {
				const outcome = await this.#host.modelRegistry.authStorage.limits.markReached(
					activeModel.provider,
					this.#host.sessionId(),
					{
						retryAfterMs,
						// Provider-stated timing only when the error text parsed;
						// the 30-minute fallback is a guess.
						providerTimed: parsedRetryAfterMs !== undefined,
						baseUrl: activeModel.baseUrl,
						modelId: activeModel.id,
					},
				);
				return {
					switchedCredential: outcome.switched,
					retryAfterMs,
					retryAtMs: outcome.retryAtMs,
					blockedUntilMs: outcome.blockedUntilMs,
					priorBlockedUntilMs: outcome.priorBlockedUntilMs,
					priorBlockedUntilTimed: outcome.priorBlockedUntilTimed,
					reportResetAtMs: outcome.reportResetAtMs,
				};
			})();
			this.#usageLimitOutcomes.set(message, recorded);
		}
		return (await recorded).switchedCredential;
	}

	/** Prompts after transient overlap with a prior agent run. `onClaimed` fires synchronously
	 *  right after a successful `agent.prompt` claim (before the run is awaited), letting the
	 *  caller mark the exact moment its own run went live. */
	promptAgentWithIdleRetry(
		messages: AgentMessage[],
		options?: { toolChoice?: ToolChoice },
		onClaimed?: () => void,
	): Promise<void> {
		return this.#promptAgentWithIdleRetry(messages, options, onClaimed);
	}

	/** Parses provider retry and rate-limit reset hints into a delay. */
	parseRetryAfterMsFromError(errorMessage: string): number | undefined {
		return this.#parseRetryAfterMsFromError(errorMessage);
	}

	/** Resolve the pending retry promise; the saga is over, and so is its refusal walk. */
	resolveRetry(): void {
		this.#accountPolicyRotationsRemaining.clear();
		if (this.#retryResolve) {
			this.#retryResolve();
			this.#retryResolve = undefined;
			this.#retryPromise = undefined;
		}
	}

	/**
	 * Ends a retry saga: records its outcome in the session (the terminal empty
	 * error turn, the annotations on the attempts it retried), publishes
	 * `auto_retry_end`, then resets the saga and resolves `retryPromise`.
	 * Publishing and releasing run in `finally`, so a session write that throws
	 * (a full disk, an unwritable transcript) still ends the saga before its
	 * error propagates. Left pending, `retryPromise` keeps the in-flight prompt
	 * waiting for a retry that never runs: the session reports streaming for
	 * good and queues every later message as a steer that never drains.
	 */
	async #closeRetrySaga(
		end: RetrySagaEnd,
		record: { terminalTurn?: AssistantMessage; retryErrors?: RetryErrorCompletion },
	): Promise<void> {
		let retryErrors: RetryErrorUpdate[] | undefined;
		try {
			if (record.terminalTurn) await this.persistTerminalEmptyErrorTurn(record.terminalTurn);
			if (record.retryErrors) retryErrors = await this.#markPendingRetryErrors(record.retryErrors);
		} finally {
			try {
				await this.#host.emitSessionEvent({
					type: "auto_retry_end",
					...end,
					...(retryErrors ? { retryErrors } : {}),
				});
			} finally {
				this.#clearPendingRetryErrors();
				this.#retryAttempt = 0;
				this.resolveRetry();
			}
		}
	}

	#clearPendingRetryErrors(): void {
		this.#pendingRetryErrors = [];
	}

	/**
	 * Durably record a terminal empty error turn (`stopReason: "error"` with no
	 * substantive content) that `#persistSessionMessageIfMissing` skipped, so the
	 * session JSONL keeps a record of why the run stopped instead of ending at the
	 * last tool result. A no-op for non-empty/non-error turns and idempotent via
	 * the already-persisted guard; the turn is dropped from active context by the
	 * caller (or `isProviderRefusalMessage`/`isEmptyErrorTurn` filters) so it is
	 * never replayed on the wire. Used by the retry-lifecycle dead-ends and the
	 * non-retry terminal error tail.
	 */
	async #persistTerminalEmptyErrorTurn(message: AssistantMessage): Promise<void> {
		await this.#host.waitForSessionMessagePersistence(message);
		if (!isEmptyErrorTurn(message)) return;
		if (this.#host.sessionMessageAlreadyPersisted(message)) return;
		this.#host.appendSessionMessage(message);
	}

	#retryRecoveryKind(id: number, switchedCredential: boolean, delayMs: number): AssistantRetryRecoveryKind {
		if (switchedCredential) return "credential";
		if (AIError.is(id, AIError.Flag.UsageLimit) && delayMs > 0) return "wait";
		return "plain";
	}

	#retryRecoveryNote(recovery: AssistantRetryRecoveryKind, rateLimited: boolean): string {
		const parts: string[] = [];
		if (rateLimited) {
			parts.push("rate-limited");
		} else if (recovery === "plain") {
			parts.push("error");
		}
		if (recovery === "credential") {
			parts.push("switched account");
		} else if (recovery === "model") {
			parts.push("switched model");
		} else if (recovery === "wait") {
			parts.push("waited");
		}
		parts.push("retried");
		return parts.join("; ");
	}

	async #recordPendingRetryError(
		message: AssistantMessage,
		id: number,
		options: { switchedCredential: boolean; delayMs: number },
	): Promise<void> {
		await this.persistTerminalEmptyErrorTurn(message);
		const persistenceKey = sessionMessagePersistenceKey(message);
		if (!persistenceKey) return;
		const branch = this.#host.sessionManager.getBranchView();
		const branchEntry = branch.findLast(
			entry =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				sessionMessagePersistenceKey(entry.message) === persistenceKey &&
				(sameMessageContent(entry.message, message) || this.#isSameAssistantMessage(entry.message, message)),
		);
		if (!branchEntry) return;
		if (this.#pendingRetryErrors.some(error => error.entryId === branchEntry.id)) return;
		const rateLimited = AIError.is(id, AIError.Flag.UsageLimit);
		const recovery = this.#retryRecoveryKind(id, options.switchedCredential, options.delayMs);
		const note = this.#retryRecoveryNote(recovery, rateLimited);
		this.#pendingRetryErrors.push({
			entryId: branchEntry.id,
			persistenceKey,
			recovery,
			attempt: this.#retryAttempt,
			note,
		});
	}

	async #markPendingRetryErrors(completion: RetryErrorCompletion): Promise<RetryErrorUpdate[]> {
		if (this.#pendingRetryErrors.length === 0) return [];
		const branch = this.#host.sessionManager.getBranchView();
		const branchById = new Map<string, SessionEntry>();
		for (const entry of branch) {
			branchById.set(entry.id, entry);
		}
		const retryErrors: RetryErrorUpdate[] = [];
		for (const pending of this.#pendingRetryErrors) {
			let entry = branchById.get(pending.entryId);
			if (entry?.type !== "message" || entry.message.role !== "assistant") {
				entry = branch.findLast(
					candidate =>
						candidate.type === "message" &&
						candidate.message.role === "assistant" &&
						sessionMessagePersistenceKey(candidate.message) === pending.persistenceKey,
				);
			}
			if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
			let retryRecovery: AssistantRetryRecovery;
			if (completion.status === "recovered") {
				retryRecovery = {
					kind: "auto-retry",
					status: "recovered",
					attempt: pending.attempt,
					recoveredAt: new Date().toISOString(),
					recovery: pending.recovery,
					note: pending.note,
					supersededBy: {
						timestamp: completion.supersedingMessage.timestamp,
						...(completion.supersedingMessage.responseId === undefined
							? {}
							: { responseId: completion.supersedingMessage.responseId }),
						provider: completion.supersedingMessage.provider,
						model: completion.supersedingMessage.model,
					},
				};
			} else {
				retryRecovery = {
					kind: "auto-retry",
					status: "superseded",
					attempt: pending.attempt,
					recovery: pending.recovery,
					note: pending.note,
				};
			}
			entry.message.retryRecovery = retryRecovery;
			retryErrors.push({
				entryId: entry.id,
				persistenceKey: pending.persistenceKey,
				note: retryRecovery.note,
				retryRecovery,
			});
		}
		if (retryErrors.length > 0) {
			await this.#host.sessionManager.rewriteEntries();
		}
		return retryErrors;
	}

	#isRecoverableProviderEmptyOutput(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const id = this.#classifyRetryMessage(message);
		if (!AIError.is(id, AIError.Flag.EmptyResponse)) return false;
		return message.content.every(
			block => block.type === "thinking" || (block.type === "text" && !hasNonWhitespace(block.text)),
		);
	}

	async #handleEmptyAssistantStop(assistantMessage: AssistantMessage): Promise<"continue" | "terminal" | undefined> {
		const providerEmptyOutput = this.#isRecoverableProviderEmptyOutput(assistantMessage);
		if (!isEmptyAssistantStop(assistantMessage) && !providerEmptyOutput) {
			this.#emptyStopRetryCount = 0;
			return undefined;
		}

		if (this.#acceptTerminalEmptyStopForPrompt && assistantMessage.stopReason === "stop") {
			this.#acceptTerminalEmptyStopForPrompt = false;
			this.#discardAcceptedTerminalEmptyStop(assistantMessage);
			this.#emptyStopRetryCount = 0;
			return undefined;
		}

		this.#emptyStopRetryCount++;
		if (this.#emptyStopRetryCount > EMPTY_STOP_MAX_RETRIES) {
			const attempts = this.#emptyStopRetryCount - 1;
			const outputTokens = assistantMessage.usage.output;
			const outputTokensExcludingKnownReasoning = Math.max(
				0,
				outputTokens - (assistantMessage.usage.reasoningTokens ?? 0),
			);
			let finalError: string;
			if (providerEmptyOutput) {
				finalError = "Assistant returned no final output after retry cap; try switching models";
			} else if (outputTokensExcludingKnownReasoning > 0 && assistantMessage.content.length === 0) {
				// Report the usage without inferring why no deliverable content arrived.
				const reasoningTokens = assistantMessage.usage.reasoningTokens;
				const reasoningDetail =
					reasoningTokens === undefined
						? ""
						: ` (${reasoningTokens} reasoning token${reasoningTokens === 1 ? "" : "s"})`;
				finalError = `Assistant returned an empty stop after retry cap; provider reported ${outputTokens} output token${outputTokens === 1 ? "" : "s"}${reasoningDetail}, but no text or tool calls were delivered. Usage alone does not establish the cause`;
			} else {
				finalError =
					"Assistant returned empty stop after retry cap; try switching models or `/shake images` to remove archived frames";
			}
			assistantMessage.errorMessage = finalError;
			if (providerEmptyOutput) assistantMessage.errorId = AIError.create();
			logger.warn(finalError, {
				attempts,
				model: assistantMessage.model,
				provider: assistantMessage.provider,
				outputTokens,
			});
			await this.#host.emitSessionEvent({
				type: "auto_retry_end",
				success: false,
				attempt: this.#retryAttempt > 0 ? this.#retryAttempt : attempts,
				finalError,
			});
			this.#clearPendingRetryErrors();
			this.#retryAttempt = 0;
			this.resolveRetry();
			// A turn with no actionable output carries no transcript value, while its
			// provider usage can anchor the next prompt at the full failed-request size
			// and re-trigger compaction at the same boundary. Remove every capped
			// empty output; toolUse orphans still need this for Anthropic history.
			await this.#dropAssistantTurnDurably(assistantMessage);
			return "terminal";
		}
		// The reparented leaf must be durably persisted before the retry continues:
		// the loader rebuilds the active branch from the last physical entry, so an
		// in-memory-only reparent lets the empty stop resurface on reload or after
		// a mid-retry process kill.
		await this.#dropAssistantTurnDurably(assistantMessage);
		this.#host.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: this.#emptyStopRetryReminder() }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.scheduleAgentContinue({
			source: "empty-stop-retry",
			generation: this.#host.promptGeneration(),
		});
		return "continue";
	}

	#emptyStopRetryReminder(): string {
		return prompt.render(emptyStopRetryTemplate, {
			retryCount: this.#emptyStopRetryCount,
			maxRetries: EMPTY_STOP_MAX_RETRIES,
		});
	}
	async #handleUnexpectedAssistantStop(assistantMessage: AssistantMessage): Promise<boolean> {
		const mode = cfgFeaturesUnexpectedStopDetection.get(this.#host.settings);
		if (mode === "none") {
			return false;
		}
		if (!isUnexpectedStopCandidate(assistantMessage)) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		const text = assistantMessage.content
			.filter((content): content is TextContent => content.type === "text")
			.map(content => content.text)
			.join("\n");

		// Visible text is a completed response; automatic model judgments are disabled.
		if (hasNonWhitespace(text)) {
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		this.#unexpectedStopRetryCount++;
		if (this.#unexpectedStopRetryCount > UNEXPECTED_STOP_MAX_RETRIES) {
			logger.warn("Assistant returned unexpected stop after retry cap", {
				attempts: this.#unexpectedStopRetryCount - 1,
				model: assistantMessage.model,
				provider: assistantMessage.provider,
			});
			this.#unexpectedStopRetryCount = 0;
			return false;
		}

		this.#host.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: this.#unexpectedStopRetryReminder() }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.scheduleAgentContinue({
			source: "unexpected-stop-retry",
			generation: this.#host.promptGeneration(),
		});
		return true;
	}

	#unexpectedStopRetryReminder(): string {
		return prompt.render(unexpectedStopRetryTemplate, {
			retryCount: this.#unexpectedStopRetryCount,
			maxRetries: UNEXPECTED_STOP_MAX_RETRIES,
		});
	}

	removeAssistantMessageFromActiveContext(
		assistantMessage: AssistantMessage,
		reason = "assistant-context-cleanup",
	): void {
		const messages = this.#host.agent.state.messages;
		const lastMessage = messages[messages.length - 1];
		const lastAssistant: AssistantMessage | undefined = lastMessage?.role === "assistant" ? lastMessage : undefined;
		if (lastAssistant !== undefined && this.#isSameAssistantMessage(lastAssistant, assistantMessage)) {
			this.#host.agent.replaceMessages(messages.slice(0, -1));
			return;
		}
		// A miss means the failed turn is still in active context (or was never
		// there); log just enough to explain why the identity check failed.
		logger.debug("agent active context assistant removal missed", {
			reason,
			lastRole: lastMessage?.role,
			candidateTimestamp: assistantMessage.timestamp,
			lastTimestamp: lastAssistant?.timestamp,
			candidateStopReason: assistantMessage.stopReason,
			lastStopReason: lastAssistant?.stopReason,
		});
	}

	/**
	 * Drop a recoverable assistant turn from the persisted session branch once a
	 * recovery path (context promotion or compaction) is committed. Waits for the
	 * in-flight `message_end` persistence slot first so the branch entry exists
	 * before we reparent past it. Active context removal is the caller's
	 * responsibility — recovery paths clear it eagerly so the retry never
	 * replays the failed turn, while no-recovery paths leave the persisted entry
	 * (and the user-visible transcript line) in place.
	 */
	async #dropPersistedAssistantTurn(assistantMessage: AssistantMessage): Promise<string | undefined> {
		await this.#host.waitForSessionMessagePersistence(assistantMessage);
		return this.discardAssistantTurn(assistantMessage);
	}

	/**
	 * Drop the failed turn from active context and the persisted branch, then
	 * durably persist the reparented leaf so the empty stop cannot resurface on
	 * reload or after a mid-retry process kill.
	 */
	async #dropAssistantTurnDurably(assistantMessage: AssistantMessage): Promise<void> {
		const droppedEntryId = await this.#dropPersistedAssistantTurn(assistantMessage);
		if (droppedEntryId) await this.#host.sessionManager.discardEntryDurably(droppedEntryId);
	}

	/**
	 * Drop the failed assistant turn from persisted history, run
	 * {@link #runAutoCompaction} for an `overflow` / `incomplete` recovery, and
	 * restore the assistant entry if compaction did not actually commit
	 * anything (no usable model/preparation, hook cancel, compaction error,
	 * or a no-progress automatic-continuation block before any summary was
	 * written).
	 *
	 * Compaction has to see a clean branch — otherwise its `prepareCompaction`
	 * pass would keep the failed turn in the kept region and the retry would
	 * replay it. But a return that was not paired with a fresh compaction
	 * summary or a successful history rewrite means no recovery is in progress,
	 * even if queued user input gets drained next. Restoring the failed turn
	 * before that continuation preserves the visible stop reason and rebuilds the
	 * active assistant tail that `Agent.continue()` needs to dequeue follow-ups.
	 */
	async #runRecoveryCompactionWithRollback(
		reason: "overflow" | "incomplete",
		assistantMessage: AssistantMessage,
		options: { autoContinue: boolean; triggerContextTokens?: number; excludeMediaMethods?: boolean },
	): Promise<RecoveryCompactionResult> {
		const compactionEntryBefore = getLatestCompactionEntry(this.#host.sessionManager.getBranch());
		await this.dropPersistedAssistantTurn(assistantMessage);
		const result = await this.#host.runAutoCompaction(reason, true, {
			autoContinue: options.autoContinue,
			triggerContextTokens: options.triggerContextTokens,
			phase: "mid_turn",
			excludeMediaMethods: options.excludeMediaMethods,
		});
		const compactionEntryAfter = getLatestCompactionEntry(this.#host.sessionManager.getBranch());
		if (result.historyRewritten !== true && compactionEntryAfter === compactionEntryBefore) {
			this.#restoreFailedAssistantTurn(assistantMessage);
		}
		return result;
	}

	#restoreFailedAssistantTurn(assistantMessage: AssistantMessage): void {
		if (!isEmptyErrorTurn(assistantMessage)) this.#host.sessionManager.appendMessage(assistantMessage);
		const lastMessage = this.#host.agent.state.messages.at(-1);
		if (
			lastMessage?.role === "assistant" &&
			this.#isSameAssistantMessage(lastMessage as AssistantMessage, assistantMessage)
		) {
			return;
		}
		this.#host.agent.appendMessage(assistantMessage);
	}

	#discardAcceptedTerminalEmptyStop(assistantMessage: AssistantMessage): void {
		const branch = this.#host.sessionManager.getBranchView();
		const branchIndex = branch.findLastIndex(
			entry =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				this.#isSameAssistantMessage(entry.message, assistantMessage),
		);
		const branchEntry = branchIndex >= 0 ? branch[branchIndex] : undefined;
		// A branch entry's parent is the entry before it on the branch.
		const parentEntry =
			branchEntry?.parentId === null || branchEntry?.parentId === undefined ? undefined : branch[branchIndex - 1];
		const prunePrompt = parentEntry?.type === "custom_message";

		this.removeAssistantMessageFromActiveContext(assistantMessage, "accepted-terminal-empty-stop");
		if (prunePrompt && this.#host.agent.state.messages.at(-1)?.role === "custom") {
			this.#host.agent.replaceMessages(this.#host.agent.state.messages.slice(0, -1));
		}

		if (!branchEntry) return;
		const targetParentId = prunePrompt ? parentEntry.parentId : branchEntry.parentId;
		this.#host.withBashBranchTransition(() => {
			if (targetParentId === null) {
				this.#host.sessionManager.resetLeaf();
			} else {
				this.#host.sessionManager.branch(targetParentId);
			}
		});
		this.#host.sessionManager.appendCustomEntry("accepted-terminal-empty-stop");
	}

	/**
	 * Drop an assistant turn from BOTH the live agent context and the persisted
	 * session branch (reparenting the leaf to the turn's parent), so a discarded
	 * turn does not resurface on reload. Used for empty/reasoning-only stops and
	 * the Gemini header-runaway interrupt, which must not replay a partial,
	 * loop-fueling thinking block.
	 */
	discardAssistantTurn(assistantMessage: AssistantMessage): string | undefined {
		this.removeAssistantMessageFromActiveContext(assistantMessage);

		const branch = this.#host.sessionManager.getBranchView();
		const persistedEntryId = this.#host.persistedAssistantEntryId(assistantMessage);
		const branchEntry =
			(persistedEntryId === undefined
				? undefined
				: branch.find(
						entry =>
							entry.id === persistedEntryId && entry.type === "message" && entry.message.role === "assistant",
					)) ??
			branch.findLast(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					this.#isSameAssistantMessage(entry.message as AssistantMessage, assistantMessage),
			);
		if (!branchEntry) {
			return undefined;
		}
		this.#host.withBashBranchTransition(() => {
			if (branchEntry.parentId === null) {
				this.#host.sessionManager.resetLeaf();
			} else {
				this.#host.sessionManager.branch(branchEntry.parentId);
			}
		});
		return branchEntry.id;
	}

	#isSameAssistantMessage(left: AssistantMessage, right: AssistantMessage): boolean {
		return (
			left === right ||
			(left.timestamp === right.timestamp &&
				left.provider === right.provider &&
				left.model === right.model &&
				left.stopReason === right.stopReason &&
				left.errorMessage === right.errorMessage &&
				Bun.hash(JSON.stringify(left.content)) === Bun.hash(JSON.stringify(right.content)))
		);
	}

	/**
	 * Classify retry decisions against the active session model. Test stream
	 * shims and provider adapters can emit generic assistant metadata, but retry
	 * policy belongs to the model that was actually requested for this turn.
	 */
	#classifyRetryMessage(message: AssistantMessage): number {
		const activeModel = this.#host.model();
		if (!activeModel || message.api === activeModel.api) {
			return AIError.classifyMessage(message);
		}

		const id = AIError.classifyMessage({
			api: activeModel.api,
			errorId: message.errorId,
			errorMessage: message.errorMessage,
			errorStatus: message.errorStatus,
		});
		message.errorId = id;
		return id;
	}

	#isUsagePreflightBlocked(message: AssistantMessage): boolean {
		return message.errorMessage?.startsWith(USAGE_PREFLIGHT_BLOCKED_PREFIX) === true;
	}
	/**
	 * Retry an empty, reason-less provider abort: a turn with no content that
	 * carries the generic sentinel (bare `abort()`), whether the provider
	 * finalized it as `stopReason: "aborted"` or leaked it as `stopReason:
	 * "error"` (a stalled/dropped stream reported as an error rather than an
	 * abort — issue #5375). Only fires while the session is neither aborting nor
	 * tearing down. A user/lifecycle abort (`#abortInProgress`), a dispose-driven
	 * abort (`#isDisposed`), or a session-induced streaming-edit guard abort
	 * (`StreamingEditGuard.abortTriggered` — failed-patch
	 * preview) is deliberate and MUST settle the turn instead: routing it through
	 * retry would orphan `#retryPromise` on a continuation the guard skips
	 * (hanging the in-flight `prompt()`) or silently undo the guard's intended
	 * abort. Deliberate user interrupts (`UserInterrupt`) and silent aborts carry
	 * their own marker, not the generic sentinel, so they never match here.
	 */
	isRetryableReasonlessAbort(message: AssistantMessage): boolean {
		if (
			(message.stopReason !== "aborted" && message.stopReason !== "error") ||
			// A `fallback` boundary is bookkeeping, not output: a stream aborted
			// right after a mid-turn server-side fallback persists `[fallback]`,
			// which is as replay-safe to retry as an empty turn (`isEmptyErrorTurn`
			// already counts the marker as no output).
			message.content.some(block => block.type !== "fallback") ||
			this.#host.abortInProgress() ||
			this.#host.isDisposed() ||
			this.#host.streamingEditAbortTriggered()
		) {
			return false;
		}

		const id = this.#classifyRetryMessage(message);
		if (message.stopReason === "aborted" && AIError.is(id, AIError.Flag.Abort)) return true;
		if (message.errorMessage === undefined || !Object.hasOwn(GENERIC_ABORT_MESSAGES, message.errorMessage)) {
			return false;
		}

		message.errorId = AIError.create(AIError.Flag.Abort);
		return true;
	}

	/**
	 * Own the exact Responses request-body-read timeout so terminal special outcomes
	 * cannot fall through to the generic 408 replay path.
	 */
	async handleResponsesRequestBodyReadTimeout(message: AssistantMessage): Promise<RequestBodyReadTimeoutRecovery> {
		if (message.stopReason !== "error" || !AIError.isResponsesRequestBodyReadTimeout(message)) {
			return "not-applicable";
		}
		const generation = this.#host.promptGeneration();
		const promptSequence = this.#host.promptSequence();
		const replayUnsafe = this.#hasReplayUnsafeOutput(message);
		const terminal = (): RequestBodyReadTimeoutRecovery => {
			if (!replayUnsafe) this.removeAssistantMessageFromActiveContext(message, "request-body-timeout-terminal");
			return "handled-terminal";
		};
		const retrySettings = cfgRetry.get(this.#host.settings);
		if (
			this.#requestBodyReadTimeoutRecoveryPromptSequence === promptSequence ||
			!retrySettings.enabled ||
			retrySettings.maxRetries <= this.#retryAttempt ||
			this.#host.isDisposed() ||
			this.#host.abortInProgress() ||
			this.#host.isCompacting() ||
			replayUnsafe
		) {
			return terminal();
		}

		this.#requestBodyReadTimeoutRecoveryPromptSequence = promptSequence;
		const shook = await this.#host.shakeForRequestBodyReadTimeout(generation);
		if (
			!shook ||
			this.#host.promptGeneration() !== generation ||
			this.#host.isDisposed() ||
			this.#host.abortInProgress()
		) {
			return terminal();
		}
		return (await this.#handleRetryableError(message)) ? "handled-retry" : terminal();
	}

	/**
	 * Check if an error is retryable (transient errors, usage limits, or
	 * account-scoped policy denials that can rotate credentials).
	 * Context overflow is NOT retryable (handled by compaction instead).
	 */
	isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		if (this.#isUsagePreflightBlocked(message)) return false;
		if (AIError.isResponsesRequestBodyReadTimeout(message)) return false;
		const model = this.#host.model();
		const immutableAnthropicThinkingError =
			model?.api === "anthropic-messages" &&
			(message.errorStatus === 400 ||
				message.errorId === 400 ||
				message.errorMessage?.startsWith("400 ") === true) &&
			AIError.isImmutableLatestThinkingText(message.errorMessage ?? "");
		if (immutableAnthropicThinkingError) return false;

		const id = this.#classifyRetryMessage(message);
		// Context overflow is handled by compaction, not retry.
		const contextWindow = this.#host.model()?.contextWindow ?? 0;
		if (AIError.isContextOverflow(message, contextWindow)) return false;

		// Credential rotation and classifier fallbacks are safe only before
		// committed text, images, tool calls, or server tools. Thinking-only
		// output remains replay-safe. A classifier refusal, malformed-function
		// response, or retriable transport error (the provider stream died
		// mid-turn after a complete tool call — e.g. a socket close — and every
		// emitted call was paired with a synthetic `executed: false` result) may
		// also be replayed when every emitted tool call is paired with positive
		// proof that it never executed.
		const replaySafeUnexecutedTools =
			(this.isClassifierRefusal(message) ||
				AIError.is(id, AIError.Flag.MalformedFunctionCall) ||
				AIError.retriable(id)) &&
			this.#unexecutedToolCallsReplaySafe(message);
		if (this.#hasReplayUnsafeOutput(message) && !replaySafeUnexecutedTools) return false;
		if (AIError.is(id, AIError.Flag.AccountPolicy) || this.isClassifierRefusal(message)) return true;
		return AIError.retriable(id);
	}

	/**
	 * True when every emitted tool call provably never executed and no other
	 * replay-unsafe output exists. The caller restricts this exception to
	 * classifier refusals, malformed-function responses, and retriable
	 * transport errors.
	 *
	 * Gemini can report `MALFORMED_FUNCTION_CALL` after streaming an earlier,
	 * well-formed call. Anthropic classifiers can likewise refuse after a call.
	 * The agent loop pairs each emitted-but-unrun call with a synthetic
	 * `executed: false` result, which proves `tool.execute()` never ran.
	 *
	 * Any uncertainty keeps the replay veto in place: the assistant must exist
	 * in state, every call must have a later synthetic result, every result must
	 * say `executed === false`, and the turn must contain no image, server tool,
	 * or committed non-whitespace text.
	 */
	#unexecutedToolCallsReplaySafe(message: AssistantMessage): boolean {
		const emittedToolCallIds = new Set<string>();
		for (const block of message.content) {
			if (block.type === "toolCall") {
				emittedToolCallIds.add(block.id);
				continue;
			}
			if (block.type === "image" || block.type === "anthropicServerTool") return false;
			if (block.type === "text" && this.#host.textOutputCommitted() && hasNonWhitespace(block.text)) return false;
		}
		if (emittedToolCallIds.size === 0) return false;

		// The errored assistant message is NOT the tail of state: the agent loop
		// appends the synthetic results after it before the turn ends, so locate it
		// by walking backwards exactly as `classifyResolvedInterruptedToolTurn` does.
		const messages = this.#host.agent.state.messages;
		let assistantIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const candidate = messages[i];
			if (candidate.role === "assistant" && this.#isSameAssistantMessage(candidate, message)) {
				assistantIndex = i;
				break;
			}
		}
		if (assistantIndex < 0) return false;

		const unexecutedToolCallIds = new Set<string>();
		for (let i = assistantIndex + 1; i < messages.length; i++) {
			const candidate = messages[i];
			if (candidate.role !== "toolResult" || !emittedToolCallIds.has(candidate.toolCallId)) continue;
			// Every result for an emitted call is inspected, not just the first: a
			// real result anywhere in the tail means the tool ran.
			if (!isSyntheticToolResultMessage(candidate) || candidate.details?.executed !== false) return false;
			unexecutedToolCallIds.add(candidate.toolCallId);
		}
		return unexecutedToolCallIds.size === emittedToolCallIds.size;
	}

	/**
	 * Classify a reasonless abort, idle stream stall, HTTP/2 stream reset, or
	 * premature stream close whose emitted tool calls all have results. The failed
	 * assistant/tool-result pair stays in context so continuation cannot replay
	 * completed side effects; synthetic results tell the next turn that an
	 * unexecuted call must be reissued.
	 */
	classifyResolvedInterruptedToolTurn(message: AssistantMessage): "reasonless-abort" | "stream-stall" | undefined {
		const id = this.#classifyRetryMessage(message);
		const genericAbort =
			message.errorMessage !== undefined && Object.hasOwn(GENERIC_ABORT_MESSAGES, message.errorMessage);
		const reasonlessAbort =
			(message.stopReason === "aborted" || message.stopReason === "error") &&
			!this.#host.abortInProgress() &&
			!this.#host.isDisposed() &&
			!this.#host.streamingEditAbortTriggered() &&
			((message.stopReason === "aborted" && AIError.is(id, AIError.Flag.Abort)) || genericAbort);
		if (!reasonlessAbort && !this.#isMidStreamTransportFailure(message, id)) return undefined;
		if (reasonlessAbort && genericAbort) message.errorId = AIError.create(AIError.Flag.Abort);

		// Idle stall and HTTP/2 RST both close the Cursor Connect stream:
		// the lazy watchdog aborts the request signal, and cursor.ts then
		// calls `h2Request.close()`. There is no in-flight server exec to
		// race, so unmarked MCP/todo blocks can continue once every emitted
		// call has a matching result. A reasonless abort ends the turn and
		// the agent loop pairs leftover calls with `executed: false`.
		const resolvedToolCallIds: string[] = [];
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			resolvedToolCallIds.push(block.id);
		}
		if (resolvedToolCallIds.length === 0) return undefined;

		const messages = this.#host.agent.state.messages;
		let assistantIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const candidate = messages[i];
			if (candidate.role === "assistant" && this.#isSameAssistantMessage(candidate, message)) {
				assistantIndex = i;
				break;
			}
		}
		if (assistantIndex < 0) return undefined;

		const unresolvedToolCallIds = new Set(resolvedToolCallIds);
		for (let i = assistantIndex + 1; i < messages.length; i++) {
			const candidate = messages[i];
			if (candidate.role === "toolResult") unresolvedToolCallIds.delete(candidate.toolCallId);
		}
		if (unresolvedToolCallIds.size > 0) return undefined;
		return reasonlessAbort ? "reasonless-abort" : "stream-stall";
	}

	/**
	 * Mid-generation transport death: the local idle watchdog's stream stall, an
	 * HTTP/2 stream reset, a gateway close without the terminal event, or a
	 * truncated stream envelope. A premature close (no finish_reason/terminal
	 * event) and an envelope that never reached its terminal frame — including a
	 * gateway's in-band `error` frame, which the provider reports as the same
	 * envelope truncation — are the same failure class as a stall or reset.
	 * Resets and closes are ignored while a deliberate abort, disposal, or
	 * streaming-edit abort owns the stream.
	 */
	#isMidStreamTransportFailure(message: AssistantMessage, id: number): boolean {
		if (message.stopReason !== "error" || !AIError.retriable(id)) return false;
		const errorMessage = message.errorMessage ?? "";
		if (STREAM_STALL_ERROR_RE.test(errorMessage)) return true;
		if (this.#host.abortInProgress() || this.#host.isDisposed() || this.#host.streamingEditAbortTriggered()) {
			return false;
		}
		return (
			AIError.isStreamEnvelopeTruncationText(errorMessage) ||
			HTTP2_STREAM_RESET_ERROR_RE.test(errorMessage) ||
			AIError.PYTHON_HTTP2_STREAM_RESET_PATTERN.test(errorMessage) ||
			AIError.PYTHON_HTTP_INCOMPLETE_CHUNK_PATTERN.test(errorMessage) ||
			PREMATURE_STREAM_CLOSE_ERROR_RE.test(errorMessage)
		);
	}
	/**
	 * Retried turns remove the failed assistant message from active context.
	 * Thinking-only partials are safe to discard and replay: reasoning models
	 * routinely stall after long thinking with no visible output, and duplicated
	 * thinking display is materially lower harm than duplicated final text.
	 * Whitespace-only and buffered text are likewise safe since nothing meaningful
	 * reached the user. Committed text, generated images, server tools, and retained
	 * tool calls are NOT safe: each has already rendered or may have side effects,
	 * so replaying the turn can duplicate user-visible output or work.
	 */
	#hasReplayUnsafeOutput(message: AssistantMessage): boolean {
		return message.content.some(
			block =>
				block.type === "toolCall" ||
				block.type === "image" ||
				block.type === "anthropicServerTool" ||
				(block.type === "text" && this.#host.textOutputCommitted() && block.text.trim().length > 0),
		);
	}

	/**
	 * Known provider routes can repeatedly close after completing an expensive
	 * reasoning phase. One retry covers a transient edge failure; the normal
	 * ten-retry budget would otherwise replay the same reasoning cycle unchanged.
	 */
	#isBoundedThinkingStreamClose(message: AssistantMessage): boolean {
		if (!message.content.some(block => block.type === "thinking" && block.thinking.trim().length > 0)) {
			return false;
		}
		const errorMessage = message.errorMessage ?? "";
		return (
			(message.provider === "openrouter" &&
				/server_error:\s*stream closed with reason:\s*error/i.test(errorMessage)) ||
			(message.provider === "github-copilot" &&
				message.model === "grok-4.6" &&
				message.api === "openai-responses" &&
				/OpenAI responses stream closed before a terminal response event was received/i.test(errorMessage))
		);
	}

	/** Checks whether a provider error represents a classifier refusal. */
	isClassifierRefusal(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const stopType = message.stopDetails?.type;
		return stopType === "refusal" || stopType === "sensitive";
	}

	#parseRetryAfterMsFromError(errorMessage: string): number | undefined {
		// Single call into the provider-aware parser: it merges every supported
		// form (account resets, retry-after-ms, legacy retry-after /
		// x-ratelimit-reset text) by longest-wins, so a shorter reset phrase
		// can never shadow a longer retry signal carried in the same message.
		return extractProviderRetryHint(this.#host.model()?.provider, errorMessage);
	}

	/** Retries the current model with backoff and credential rotation. */
	async #handleRetryableError(message: AssistantMessage, options?: RetryPolicyOptions): Promise<boolean> {
		try {
			return await this.#applyRetryPolicy(message, options);
		} catch (error) {
			// The policy's dead ends close their own saga through
			// #closeRetrySaga, so a write that throws there has already closed
			// it. A throw anywhere else on the way, such as recording an attempt
			// before its retry is scheduled, leaves the saga open, and nothing
			// else would close it.
			if (this.#retryPromise) {
				await this.#closeRetrySaga(
					{ success: false, attempt: this.#retryAttempt, finalError: message.errorMessage },
					{},
				);
			}
			throw error;
		}
	}

	/**
	 * The retry policy {@link #handleRetryableError} applies. A throw outside
	 * its dead ends leaves the saga for the caller to close.
	 */
	async #applyRetryPolicy(message: AssistantMessage, options?: RetryPolicyOptions): Promise<boolean> {
		const retrySettings = cfgRetry.get(this.#host.settings);
		if (this.#host.abortInProgress() || this.#host.isDisposed()) return false;
		if (!retrySettings.enabled) return false;
		const classifierRefusal = this.isClassifierRefusal(message);

		const generation = this.#host.promptGeneration();
		this.#retryAttempt++;

		// Create retry promise on first attempt so waitForRetry() can await it
		// Ensure only one promise exists (avoid orphaned promises from concurrent calls)
		if (!this.#retryPromise) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#retryPromise = promise;
			this.#retryResolve = resolve;
		}

		const maxRetries = this.#isBoundedThinkingStreamClose(message)
			? Math.min(retrySettings.maxRetries, 1)
			: retrySettings.maxRetries;
		const retryBudgetExhausted = this.#retryAttempt > maxRetries;

		const errorMessage = message.errorMessage || "Unknown error";
		const id = this.#classifyRetryMessage(message);
		const preserveFailedTurn =
			options?.preserveFailedTurn === true ||
			((classifierRefusal || AIError.is(id, AIError.Flag.MalformedFunctionCall) || AIError.retriable(id)) &&
				this.#unexecutedToolCallsReplaySafe(message));
		const rateLimitReason = parseRateLimitReason(errorMessage);
		const staleOpenAIResponsesReplayError = AIError.is(id, AIError.Flag.StaleResponsesItem);
		const accountPolicyDenial = AIError.is(id, AIError.Flag.AccountPolicy);
		const recordedUsageLimitOutcome = await this.#usageLimitOutcomes.get(message);
		const parsedRetryAfterMs = this.#parseRetryAfterMsFromError(errorMessage);
		let delayMs = staleOpenAIResponsesReplayError
			? 0
			: calculateRetryBackoffDelayMs(retrySettings.baseDelayMs, this.#retryAttempt);
		// Transient rate/concurrency caps stay on the same credential, but must
		// honor their reason-specific windows. The default exponential base
		// (≈500ms, capped at 8s) otherwise re-hits the cap and burns the retry
		// budget before either window can clear. An explicit provider
		// retry-after is authoritative in both directions, so the heuristic
		// window only applies when the error carries no parsed timing.
		if (
			!staleOpenAIResponsesReplayError &&
			!AIError.is(id, AIError.Flag.UsageLimit) &&
			parsedRetryAfterMs === undefined &&
			(rateLimitReason === "CONCURRENT_LIMIT" ||
				rateLimitReason === "RATE_LIMIT_EXCEEDED" ||
				(rateLimitReason === "MODEL_CAPACITY_EXHAUSTED" &&
					(AIError.isUsageLimitStatus(message.errorStatus) ||
						/\b(?:429|MODEL_CAPACITY_EXHAUSTED|MODEL_CAPACITY_EXCEEDED|resource.?exhausted)\b/i.test(
							errorMessage,
						))))
		) {
			const reasonBackoffMs = calculateRateLimitBackoffMs(rateLimitReason);
			if (reasonBackoffMs > delayMs) delayMs = reasonBackoffMs;
		}
		let switchedCredential = false;
		// Set when a usage-limit error pinned the wait to credential
		// availability — suppresses the generic retry-after bump below.
		let usageLimitWaitMs: number | undefined;
		const siblingAvailabilityWaitMs =
			recordedUsageLimitOutcome?.retryAtMs === undefined
				? undefined
				: Math.max(0, recordedUsageLimitOutcome.retryAtMs - Date.now()) + SIBLING_UNBLOCK_BUFFER_MS;

		if (staleOpenAIResponsesReplayError) {
			this.#host.resetCurrentResponsesProviderSession("stale replay error");
		}

		// Rotation can spend the same-route retry budget before the last account
		// hits its quota. Past the budget only a confirmed reset may continue: a
		// rotation that keeps claiming a usable sibling would otherwise retry forever.
		if (!staleOpenAIResponsesReplayError && recordedUsageLimitOutcome) {
			const rotated = recordedUsageLimitOutcome.switchedCredential && !retryBudgetExhausted;
			let restored = false;
			if (!rotated) {
				const resetAbortController = new AbortController();
				this.#retryAbortController?.abort();
				this.#retryAbortController = resetAbortController;
				const startedAtMs = Date.now();
				const unblockAtMs = parsedRetryAfterMs === undefined ? undefined : startedAtMs + parsedRetryAfterMs;
				try {
					for (let attempt = 0; ; attempt++) {
						const result = await this.#host.maybeAutoRedeemReset(unblockAtMs);
						resetAbortController.signal.throwIfAborted();
						if (result.restored) {
							restored = true;
							break;
						}
						if (result.retryAfterMs === undefined || attempt >= maxRetries) break;
						// Only retry the safe eligibility read, never the reset mutation or
						// model request. Respect provider pacing within the configured wait cap.
						const readDelayMs = Math.max(
							1_000,
							result.retryAfterMs,
							calculateRetryBackoffDelayMs(retrySettings.baseDelayMs, attempt + 1),
						);
						if (retrySettings.maxDelayMs > 0 && Date.now() - startedAtMs + readDelayMs > retrySettings.maxDelayMs)
							break;
						await sleepLong(readDelayMs, resetAbortController.signal);
					}
				} catch (error) {
					if (!resetAbortController.signal.aborted) throw error;
					if (this.#retryAbortController !== resetAbortController) return false;
					return this.#endCancelledRetry();
				} finally {
					if (this.#retryAbortController === resetAbortController) this.#retryAbortController = undefined;
				}
			}
			if (rotated || restored) {
				switchedCredential = true;
				delayMs = 0;
			} else {
				// No sibling credential is usable right now. Wait for whichever
				// comes first: the current account's actual unblock deadline, or
				// the earliest moment a temporarily blocked sibling frees up
				// (e.g. a 60s post-401 block or a 5-min usage-probe block) — the
				// next attempt's getApiKey re-ranks and picks it up. Without the
				// sibling minimum, one short-lived sibling block escalates a
				// recoverable situation into the provider's multi-hour wait and
				// trips the fail-fast cap below.
				// The deadline merges every independent provider signal by
				// longest-wins (mirroring extractRetryHint): the error-text hint
				// (or heuristic fallback when hintless), the credential block
				// the mark call persisted, and — when the usage report is a
				// complete authority — its own reset, which replaces the
				// heuristic instead of sleeping a guess.
				usageLimitWaitMs = recordedUsageLimitOutcome.retryAfterMs;
				if (recordedUsageLimitOutcome.reportResetAtMs !== undefined && parsedRetryAfterMs === undefined) {
					// A hintless error can still carry an authoritative
					// usage-report window: it replaces THIS call's 30-minute
					// heuristic guess in both directions — sleeping the guess
					// past a shorter reported reset overshoots, and vice
					// versa.
					usageLimitWaitMs = Math.max(0, recordedUsageLimitOutcome.reportResetAtMs - Date.now());
				}
				if (
					recordedUsageLimitOutcome.priorBlockedUntilMs !== undefined &&
					recordedUsageLimitOutcome.priorBlockedUntilTimed === true
				) {
					// The merged deadline below masks a pre-existing block
					// shorter than this call's heuristic fallback (longest-wins
					// in the mark). The prior deadline is that block's own
					// provenance — an earlier response's provider-stated
					// window — and must survive this call's heuristic guess:
					// waking before it retries a still-blocked credential. A
					// prior deadline that was itself only a heuristic guess
					// carries no such authority and must not extend the wait
					// past an authoritative report window.
					const priorRemainingMs = Math.max(0, recordedUsageLimitOutcome.priorBlockedUntilMs - Date.now());
					if (priorRemainingMs > usageLimitWaitMs) usageLimitWaitMs = priorRemainingMs;
				}
				if (recordedUsageLimitOutcome.blockedUntilMs !== undefined) {
					// The stored deadline merges every mark call for this
					// credential (longest-wins). Only a deadline past what
					// THIS call requested — a longer report window, or a
					// longer block an earlier sibling-session response stored
					// for the shared credential — may override the wait:
					// retrying before the credential's actual unblock time
					// re-hits the cap, but this call's own heuristic
					// contribution must not re-inflate over the authoritative
					// report window above.
					const requestedBlockedUntilMs = Date.now() + (recordedUsageLimitOutcome.retryAfterMs ?? 0);
					if (recordedUsageLimitOutcome.blockedUntilMs > requestedBlockedUntilMs) {
						const blockedRemainingMs = Math.max(0, recordedUsageLimitOutcome.blockedUntilMs - Date.now());
						if (blockedRemainingMs > usageLimitWaitMs) usageLimitWaitMs = blockedRemainingMs;
					}
				}
				if (siblingAvailabilityWaitMs !== undefined && siblingAvailabilityWaitMs < usageLimitWaitMs) {
					usageLimitWaitMs = siblingAvailabilityWaitMs;
				}
				if (usageLimitWaitMs > delayMs) {
					delayMs = usageLimitWaitMs;
				}
			}
		}

		const currentModel = this.#host.model();
		if (accountPolicyDenial && currentModel) {
			const accountPolicyKey = `${currentModel.provider}/${currentModel.id}`;
			const rotationsRemaining =
				this.#accountPolicyRotationsRemaining.get(accountPolicyKey) ??
				Math.max(0, this.#host.modelRegistry.authStorage.credentials.list(currentModel.provider).length - 1);
			this.#accountPolicyRotationsRemaining.set(accountPolicyKey, Math.max(0, rotationsRemaining - 1));
			// `rotate` may sleep out a sibling's short block; register its signal
			// as the retry controller so `abortRetry()` cancels that wait exactly
			// like the backoff sleep below.
			const rotateAbortController = new AbortController();
			this.#retryAbortController?.abort();
			this.#retryAbortController = rotateAbortController;
			try {
				switchedCredential = (
					await this.#host.modelRegistry.authStorage.limits.rotate(currentModel.provider, this.#host.sessionId(), {
						error: errorMessage,
						modelId: currentModel.id,
						signal: rotateAbortController.signal,
						waitForSibling: rotationsRemaining > 0,
					})
				).switched;
				// Rotation is advisory: expired blocks or a repeatedly offered sibling
				// must not retry beyond one pool traversal in this saga.
				switchedCredential &&= rotationsRemaining > 0;
			} catch (error) {
				if (!rotateAbortController.signal.aborted) throw error;
				if (this.#retryAbortController !== rotateAbortController) return false;
				return this.#endCancelledRetry();
			} finally {
				if (this.#retryAbortController === rotateAbortController) this.#retryAbortController = undefined;
			}
			if (switchedCredential) delayMs = 0;
		}
		const effectiveUsageLimitWaitMs =
			usageLimitWaitMs ??
			(siblingAvailabilityWaitMs === undefined
				? (recordedUsageLimitOutcome?.retryAfterMs ?? parsedRetryAfterMs)
				: Math.min(
						recordedUsageLimitOutcome?.retryAfterMs ?? parsedRetryAfterMs ?? Infinity,
						siblingAvailabilityWaitMs,
					));

		// Fail-fast cap: if the provider asks us to wait longer than
		// retry.maxDelayMs and we have no fallback credential or model to
		// switch to, surface the error instead of sleeping. Defends against
		// 3-hour Anthropic rate-limit windows that would otherwise leave a
		// subagent (or interactive session) silently hung. The original
		// assistant error message is preserved in agent state so the caller
		// can act on it.
		// Opt-out: retry.waitForUsageReset lets a provider-stated usage-limit
		// reset (Flag.UsageLimit — 5h/weekly quota windows, CN 使用上限, spend
		// caps, … on any provider) sleep past the cap. Gated on authoritative
		// provider timing: either a parsed reset hint from the error text, or
		// a complete usage-report window (every exhausted limit carries a
		// future reset). Usage-limit errors with neither fall back to the
		// 30-minute QUOTA_EXHAUSTED heuristic, and sleeping on that for a
		// permanent error (402 balance, dead spend cap) would hold the session
		// through repeated heuristic sleeps instead of surfacing it. Bounded
		// by the stated wait so an unrelated large backoff cannot sneak
		// through.
		const maxDelayMs = retrySettings.maxDelayMs;
		// An account out of money has no reset to wait for: the QUOTA_EXHAUSTED
		// heuristic backoff is a guess at a clock that does not exist, and a
		// `retry.maxDelayMs` set at or above it (the 30-minute default ceiling
		// users raise) would sleep through the whole guess. Surface the provider
		// error instead, so the user tops up and the error frame's Retry
		// re-attempts at once rather than idling in a retry the session cannot
		// finish.
		const billingCap = isBillingCapUsageLimit(message.errorStatus, errorMessage);
		const exceedsDelayCap = (waitMs: number): boolean => {
			if (billingCap) return true;
			const waitForUsageReset =
				retrySettings.waitForUsageReset === true &&
				recordedUsageLimitOutcome !== undefined &&
				(parsedRetryAfterMs !== undefined || recordedUsageLimitOutcome.reportResetAtMs !== undefined) &&
				effectiveUsageLimitWaitMs !== undefined &&
				waitMs <= effectiveUsageLimitWaitMs;
			return maxDelayMs > 0 && waitMs > maxDelayMs && !waitForUsageReset;
		};

		if (
			!staleOpenAIResponsesReplayError &&
			!switchedCredential &&
			usageLimitWaitMs === undefined &&
			parsedRetryAfterMs &&
			parsedRetryAfterMs > delayMs
		) {
			delayMs = parsedRetryAfterMs;
		}

		if (retryBudgetExhausted) {
			if (!switchedCredential) {
				const attempt = this.#retryAttempt - 1;
				message.errorMessage = `Retry budget exhausted after ${attempt} ${attempt === 1 ? "retry" : "retries"}: ${errorMessage}`;
				await this.#closeRetrySaga(
					{ success: false, attempt, finalError: errorMessage },
					{ terminalTurn: message, retryErrors: { status: "superseded" } },
				);
				return false;
			}
		}
		if ((classifierRefusal || accountPolicyDenial) && !switchedCredential) {
			// A prior attempt in this saga already announced `auto_retry_start`
			// (retryAttempt was incremented for each call to this method, so > 1
			// means at least one earlier attempt started the loop) but this
			// attempt is not going to retry — the saga must close with its own
			// `auto_retry_end` so subscribers tracking retry-outstanding state
			// (e.g. suppressing a duplicate error toast) don't stay latched on
			// an announcement that never resolves.
			if (this.#retryAttempt > 1) {
				await this.#closeRetrySaga(
					{ success: false, attempt: this.#retryAttempt - 1, finalError: errorMessage },
					{ terminalTurn: message },
				);
			}
			this.#retryAttempt = 0;
			this.resolveRetry();
			return false;
		}

		// The fail-fast cap (`exceedsDelayCap`, defined above).
		if (exceedsDelayCap(delayMs) && !switchedCredential) {
			const attempt = this.#retryAttempt;
			this.#retryAttempt = 0;
			await this.#closeRetrySaga(
				{
					success: false,
					attempt,
					// A billing cap has no wait to report — the account is out of
					// money — so the message the user acts on is the provider's own.
					finalError: billingCap
						? errorMessage
						: `Provider requested ${Math.ceil(delayMs)}ms wait, exceeds retry.maxDelayMs (${maxDelayMs}ms). Original error: ${errorMessage}`,
				},
				{ terminalTurn: message },
			);
			return false;
		}

		await this.#recordPendingRetryError(message, id, { switchedCredential, delayMs });
		// Quota resets elapse while the machine sleeps; capture the deadline before event delivery.
		const usageResetDeadline = AIError.is(id, AIError.Flag.UsageLimit) ? Date.now() + delayMs : undefined;

		await this.#host.emitSessionEvent({
			type: "auto_retry_start",
			attempt: this.#retryAttempt,
			maxAttempts: maxRetries,
			delayMs,
			errorMessage,
			errorId: message.errorId,
		});
		if (this.#host.abortInProgress() || this.#host.promptGeneration() !== generation) {
			return this.#endCancelledRetry();
		}

		// Resolved stream-stall tools and proven-unexecuted malformed/refused
		// calls keep their assistant/result pair. Continuation then sees explicit
		// synthetic results and cannot repeat a side effect.
		if (!preserveFailedTurn) {
			this.removeAssistantMessageFromActiveContext(message, "auto-retry");
		}

		// A thinking/response loop retried into identical context loops again. Inject a
		// hidden redirect so the retried turn sees a directive to break the repeated
		// pattern instead of re-sampling the same stalled reasoning.
		this.#maybeInjectThinkingLoopRedirect(id);
		this.#maybeInjectMalformedFunctionCallRedirect(id, maxRetries, preserveFailedTurn);

		// Quota waits follow the wall clock; ordinary backoff stays monotonic.
		const retryAbortController = new AbortController();
		this.#retryAbortController?.abort();
		this.#retryAbortController = retryAbortController;
		try {
			if (usageResetDeadline !== undefined) {
				await sleepUntil(usageResetDeadline, retryAbortController.signal);
			} else {
				await sleepLong(delayMs, retryAbortController.signal);
			}
		} catch {
			if (this.#retryAbortController !== retryAbortController) {
				return false;
			}
			// Aborted during sleep - emit end event so UI can clean up
			return this.#endCancelledRetry();
		}
		if (this.#retryAbortController === retryAbortController) {
			this.#retryAbortController = undefined;
		}

		// The identity-keyed removal above can miss when a context rebuild
		// recreated the failed turn's message object between settle and retry
		// (fresh identity, same failed tail — issue #5382). Agent.continue()
		// rejects any assistant tail, so a missed removal fails the scheduled
		// retry locally before a provider request is ever made. Re-check the
		// tail after the backoff (covering rebuilds during the sleep too) and
		// strip a still-failed assistant tail by position. Never when preserving
		// the failed turn — the kept turn ends in synthetic tool results that
		// continue() accepts — and never once a newer prompt owns the session.
		if (!preserveFailedTurn && this.#host.promptGeneration() === generation) {
			this.#stripFailedAssistantTail();
		}

		// Retry via continue() outside the agent_end event callback chain. A
		// continuation that still fails locally must close the retry saga —
		// otherwise auto_retry_end never fires, retryPromise stays pending, and
		// the in-flight prompt() (and the TUI retry indicator) hang forever.
		this.#host.scheduleAgentContinue({
			source: "automatic-retry",
			delayMs: 1,
			generation,
			shouldContinue: () => this.#retryAttempt > 0,
			onError: error =>
				void this.#failRetryAfterLocalContinueError(message, error).catch(failure =>
					logger.error("Closing a retry saga after a failed local continuation threw", {
						error: failure instanceof Error ? failure.message : String(failure),
					}),
				),
		});

		return true;
	}

	/** Closes a retry saga whose credential wait or backoff sleep was aborted. */
	async #endCancelledRetry(): Promise<false> {
		const attempt = this.#retryAttempt;
		this.#retryAttempt = 0;
		this.#retryAbortController = undefined;
		await this.#host.emitSessionEvent({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: "Retry cancelled",
		});
		this.#clearPendingRetryErrors();
		this.resolveRetry();
		return false;
	}

	/**
	 * Positional backstop for {@link removeAssistantMessageFromActiveContext}:
	 * when the identity check missed, the failed assistant turn is still the
	 * active tail and the scheduled continue() would reject it. An
	 * error/aborted-stopped assistant tail is never legal continuation input
	 * and no recovery path wants it replayed on the wire, so drop it by
	 * position; any healthy tail is left untouched.
	 */
	#stripFailedAssistantTail(): void {
		const messages = this.#host.agent.state.messages;
		const tail = messages[messages.length - 1];
		if (tail?.role !== "assistant") return;
		if (tail.stopReason !== "error" && tail.stopReason !== "aborted") return;
		logger.debug("agent active context failed assistant tail stripped positionally", {
			stopReason: tail.stopReason,
			timestamp: tail.timestamp,
		});
		this.#host.agent.replaceMessages(messages.slice(0, -1));
	}

	/**
	 * Close the retry saga when the scheduled continue() failed locally (no
	 * provider request was made). Mirrors the other retry dead-ends: emit the
	 * closing `auto_retry_end` so subscribers stop showing retry progress, and
	 * resolve the retry promise so the in-flight prompt() unwinds (issue #5382).
	 */
	async #failRetryAfterLocalContinueError(message: AssistantMessage, error: unknown): Promise<void> {
		if (this.#retryAttempt === 0) return;
		const attempt = this.#retryAttempt;
		this.#retryAttempt = 0;
		const localError = error instanceof Error ? error.message : String(error);
		await this.#closeRetrySaga(
			{
				success: false,
				attempt,
				finalError: `Retry continuation failed locally: ${localError}. Original error: ${message.errorMessage ?? "Unknown error"}`,
			},
			{ terminalTurn: message },
		);
	}

	/**
	 * Inject a hidden redirect notice when a thinking/response loop is being retried, so
	 * the retried turn carries an instruction to break the repeated pattern instead of
	 * re-sampling the same stalled context. Injected on every {@link AIError.Flag.ThinkingLoop}
	 * retry (the failed assistant is dropped each attempt, so the notice does not accumulate
	 * unboundedly). No-op unless `id` carries the ThinkingLoop flag and the loop guard is
	 * enabled. The notice is generic on purpose — the detector's detail can quote raw model
	 * text, which must not be interpolated into a higher-priority developer message.
	 */
	#maybeInjectThinkingLoopRedirect(id: number): void {
		if (!AIError.is(id, AIError.Flag.ThinkingLoop)) return;
		if (cfgModelLoopGuardEnabled.get(this.#host.settings) !== true) return;
		this.#host.agent.appendMessage({
			role: "custom",
			customType: THINKING_LOOP_REDIRECT_TYPE,
			content: thinkingLoopRedirectTemplate,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		});
		this.#host.sessionManager.appendCustomMessageEntry(
			THINKING_LOOP_REDIRECT_TYPE,
			thinkingLoopRedirectTemplate,
			false,
			undefined,
			"agent",
		);
	}
	#maybeInjectMalformedFunctionCallRedirect(id: number, maxRetries: number, preserveFailedTurn: boolean): void {
		if (!AIError.is(id, AIError.Flag.MalformedFunctionCall)) return;
		if (preserveFailedTurn) return;
		const reminder = prompt.render(malformedFunctionCallRetryTemplate, {
			retryCount: this.#retryAttempt,
			maxRetries,
		});
		this.#host.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		});
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this.#retryAbortController?.abort();
		// Note: _retryAttempt is reset in the catch block of _autoRetry
		this.resolveRetry();
	}

	async #promptAgentWithIdleRetry(
		messages: AgentMessage[],
		options?: { toolChoice?: ToolChoice },
		onClaimed?: () => void,
	): Promise<void> {
		const deadline = Date.now() + 30_000;
		for (;;) {
			// A claim whose synchronous prefix throws (busy agent, missing
			// model) returns an already-rejected promise. Probe for that
			// before firing `onClaimed`: a busy-retry parked behind an
			// autonomous run must not report that run's streaming as ours
			// going live. The rejection handler rethrows, so the error
			// still surfaces at the await below.
			let claimFailed = false;
			try {
				const claim = this.#host.agent.prompt(messages, options).then(undefined, error => {
					claimFailed = true;
					throw error;
				});
				// One microtask turn: an already-rejected promise's reaction
				// job is queued ahead of this await's continuation, so
				// `claimFailed` is settled by the time we resume.
				await Promise.resolve();
				if (!claimFailed) onClaimed?.();
				await claim;
				return;
			} catch (err) {
				if (!(err instanceof AgentBusyError)) {
					throw err;
				}
				if (Date.now() >= deadline) {
					throw new Error("Timed out waiting for prior agent run to finish before prompting.");
				}
				await this.#host.agent.waitForIdle();
			}
		}
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this.#retryPromise !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return cfgRetryEnabled.get(this.#host.settings);
	}

	/**
	 * Toggle auto-retry. When `persist` is false (the default) the change is a
	 * session-scoped runtime override rather than a durable global write, so the
	 * `set_auto_retry` RPC command configures only its own session instead of
	 * mutating the machine-global `config.yml`.
	 */
	setAutoRetryEnabled(enabled: boolean, persist = false): void {
		if (persist) {
			cfgRetryEnabled.set(this.#host.settings, enabled);
			cfgRetryEnabled.clearOverride(this.#host.settings);
		} else {
			cfgRetryEnabled.override(this.#host.settings, enabled);
		}
	}
	/**
	 * Whether the transcript tail is a failed/aborted assistant turn whose most
	 * recent activity was a tool call: synthetic placeholder results trail the
	 * failed turn (stream died mid-tool-call), or the message right before the
	 * aborted boundary is an errored/aborted tool result (Esc landed during
	 * tool execution). Drives the TUI's idle "F5 to Retry" status row;
	 * {@link retry} is the matching action.
	 */
	get hasAbortedToolCallTail(): boolean {
		const active = this.#host.agent.state.messages;
		if (abortedToolCallTail(active)) return true;
		// A trailing assistant message is authoritative for a live session: a
		// settled successful turn leaves nothing to retry.
		if (active[conversationEnd(active) - 1]?.role === "assistant") return false;
		// A restored session omits the failed turn (and its synthetic results)
		// from provider context, so — mirroring retry() — the persisted display
		// transcript decides whether a retryable tool-call tail exists.
		return abortedToolCallTail(this.#host.sessionManager.buildSessionContext({ transcript: true }).messages);
	}
	/**
	 * Manually retry the last failed assistant turn.
	 * Removes the error message from active agent state when present and
	 * re-attempts with a fresh retry budget.
	 *
	 * A stream that stalls or aborts mid-tool-call ends the turn with
	 * `stopReason: "error" | "aborted"` and then appends one synthetic
	 * {@link isSyntheticToolResultMessage tool_result} per emitted tool call to
	 * preserve the provider's tool_use/tool_result pairing (see
	 * `createAbortedToolResult` in `agent-loop.ts`). Those placeholders trail the
	 * failed assistant turn, so the retry lookback walks back over them before
	 * checking the assistant message; it strips both the placeholders and the
	 * failed turn before re-attempting.
	 *
	 * A restored session deliberately omits failed assistant turns from provider
	 * context. In that case, the persisted display transcript remains the source
	 * of truth for whether the current branch has a retryable failed tail.
	 *
	 * When the failure is a fully failed/aborted tool batch with complete
	 * arguments (see {@link toolReplayStart}), the retry strips the failed
	 * results (and the aborted boundary) instead of the whole turn, leaving the
	 * tool-calling assistant as the tail — the continuation then re-executes
	 * the same tool calls directly rather than paying a model call to re-issue
	 * them.
	 *
	 * @returns true if retry was initiated, false if no failed turn to retry or agent is busy
	 */
	async retry(): Promise<boolean> {
		if (this.#host.isStreaming() || this.#host.isCompacting() || this.isRetrying) return false;

		const messages = this.#host.agent.state.messages;
		const activeTurnEnd = retryableAssistantTurnEnd(messages);
		if (activeTurnEnd !== undefined) {
			const replayStart = toolReplayStart(messages);
			if (replayStart !== undefined) {
				await this.#stripForToolReplay(messages, replayStart);
			} else {
				// Remove the failed/aborted assistant message plus its synthetic tool
				// results (same as auto-retry does before re-attempting), keeping the
				// trailing context deliveries the continuation is sent with.
				this.#host.agent.replaceMessages([
					...messages.slice(0, activeTurnEnd - 1),
					...messages.slice(conversationEnd(messages)),
				]);
			}
		} else {
			// A restored session already dropped the failed assistant turn (and its
			// paired synthetic tool results) from provider context, so the persisted
			// display transcript is the source of truth for a retryable failed tail.
			const transcriptMessages = this.#host.sessionManager.buildSessionContext({ transcript: true }).messages;
			if (retryableAssistantTurnEnd(transcriptMessages) === undefined) return false;
			// The boundary is already gone from active context; when the intact
			// failed batch is still the tail, replay the tools directly.
			const replayStart = toolReplayStart(messages);
			if (replayStart !== undefined) await this.#stripForToolReplay(messages, replayStart);
		}

		// Reset retry budget for a fresh attempt
		this.#retryAttempt = 0;

		// Re-attempt the turn
		this.#host.scheduleAgentContinue({ source: "manual-retry", delayMs: 1 });

		return true;
	}
	/**
	 * Ready a bare resume of the prompt the model still owes a reply — an Esc or
	 * a failure cut its turn off before any text or tool call. Drops the trailing
	 * cut-off turns from active context, as {@link retry} drops a failed turn (no
	 * provider replays them anyway), so `Agent.continue()` answers the prompt as is.
	 *
	 * @returns the prompt to resume; undefined while busy, or when an assistant
	 * turn already answers the last prompt.
	 */
	prepareResume(): AgentMessage | undefined {
		if (this.#host.isStreaming() || this.#host.isCompacting() || this.isRetrying) return undefined;
		const messages = this.#host.agent.state.messages;
		const end = conversationEnd(messages);
		let tail = end;
		while (tail > 0 && isCutOffAssistant(messages[tail - 1])) tail--;
		const prompt = unansweredPrompt(messages, tail);
		if (prompt && tail < end) {
			this.#host.agent.replaceMessages([...messages.slice(0, tail), ...messages.slice(end)]);
		}
		return prompt;
	}
	/**
	 * Strip the failed tool batch (and any aborted boundary) for a tool replay:
	 * reparent the persisted leaf onto the anchor assistant entry — so the
	 * dropped results cannot resurface on reload or pair duplicate toolCallIds
	 * on replay — then cut the active context to the same point. Trailing eval
	 * snapshots go too: none may sit between the calls and their re-run results.
	 */
	async #stripForToolReplay(messages: readonly AgentMessage[], replayStart: number): Promise<void> {
		const tail = messages[conversationEnd(messages) - 1];
		if (tail?.role === "assistant") {
			try {
				await this.#host.waitForSessionMessagePersistence(tail);
			} catch (err) {
				logger.debug("Tool replay: boundary persistence wait failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		const anchor = messages[replayStart - 1] as AssistantMessage;
		const branch = this.#host.sessionManager.getBranchView();
		const persistedEntryId = this.#host.persistedAssistantEntryId(anchor);
		const anchorEntry =
			(persistedEntryId === undefined
				? undefined
				: branch.find(
						entry =>
							entry.id === persistedEntryId && entry.type === "message" && entry.message.role === "assistant",
					)) ??
			branch.findLast(
				entry =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					this.#isSameAssistantMessage(entry.message as AssistantMessage, anchor),
			);
		if (anchorEntry) {
			this.#host.withBashBranchTransition(() => {
				this.#host.sessionManager.branch(anchorEntry.id);
			});
		}
		this.#host.agent.replaceMessages(messages.slice(0, replayStart));
	}
}
