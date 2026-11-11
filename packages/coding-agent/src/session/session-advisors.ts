import { scheduler } from "node:timers/promises";
import {
	Agent,
	type AgentMessage,
	type AgentTool,
	AppendOnlyContextManager,
	type CompactionSummaryMessage,
	resolveTelemetry,
	type StreamFn,
	TERMINAL_TOOL_RESULT_ABORT_REASON,
	ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import {
	type CompactionResult,
	compact,
	compactionContextTokens,
	createCompactionSummaryMessage,
	estimateTranscriptTokens,
	prepareCompaction,
	type SessionMessageEntry,
	shouldCompact,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { extractProviderRetryHint } from "@oh-my-pi/pi-ai/utils/retry-after";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { AdvisorConfig } from "@oh-my-pi/pi-tui/overlays/advisor-config";
import {
	ADVISOR_DEFAULT_BUDGET_PER_UPDATE,
	ADVISOR_DEFAULT_TOOL_NAMES,
	ADVISOR_MAX_BUDGET_PER_UPDATE,
	ADVISOR_SYNC_BACKLOG_MODES,
	AdviseTool,
	type AdvisorAgent,
	type AdvisorReviewMode,
	AdvisorEmissionGuard,
	type AdvisorHeldUpdates,
	AdvisorLoopGuard,
	type AdvisorMessageDetails,
	type AdvisorNote,
	AdvisorOutputQuarantinedError,
	AdvisorRuntime,
	type AdvisorRuntimeStatus,
	type AdvisorSeverity,
	type AdvisorSyncBacklog,
	AdvisorTranscriptRecorder,
	advisorTranscriptFilename,
	buildAdvisorQuarantineSourceText,
	compareAdvisorNotes,
	formatAdvisorBatchContent,
	getOrCreateAdvisorProviderSessionId,
	isAdvisorInterruptImmuneTurnActive,
	meetsAdvisorSeverity,
	quarantineAdvisorUnsafeOutput,
	resolveAdvisorDeliveryChannel,
	slugifyAdvisorName,
} from "../advisor";
import { evictStaleToolResults } from "../advisor/tool-result-eviction";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString, formatModelStringWithRouting } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { estimateToolSchemaTokens } from "@oh-my-pi/pi-tui/status-line/context-usage";
import type { PlanModeState } from "../plan-mode/state";
import advisorBoundaryGuidance from "../prompts/advisor/boundary-guidance.md" with { type: "text" };
import advisorSystemPrompt from "../prompts/advisor/system.md" with { type: "text" };
import type { SecretObfuscator } from "../secrets/obfuscator";
import { resolveThinkingLevelForModel, shouldDisableReasoning, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import type { AgentSessionEvent } from "./agent-session-events";
import type { ClientBridge } from "./client-bridge";
import { resolveCompactionMethodOrder, resolveMethodSettings } from "./compaction-methods";
import { type CustomMessage, type CustomMessagePayload, isUserTurnInitiator } from "./messages";
import { isAdvisorCard, isTerminalTextAssistantAnswer } from "./queued-messages";
import { calculateRetryBackoffDelayMs } from "./retry-fallback-chains";
import { formatSessionDumpText } from "./session-dump-format";
import type { CompactionEntry, SessionEntry } from "./session-entries";
import { formatSessionHistoryMarkdown } from "./session-history-format";
import type { SessionManager } from "./session-manager";
import { buildSessionMetadata } from "./session-metadata";
import type { YieldQueue } from "./yield-queue";

import {
	cfgAdvisorContinueSeverity,
	cfgAdvisorEvictStaleResults,
	cfgAdvisorImmuneTurns,
	cfgAdvisorMaxNotesPerUpdate,
	cfgAdvisorReviewInterval,
	cfgAdvisorReviewMode,
	cfgAdvisorSyncBacklog,
} from "../advisor/settings";
import { cfgCompaction } from "./context-settings";
import { resolveModelCompactionSettings } from "./model-compaction-threshold";
import { cfgRetry } from "./settings";

/** Wait only on an explicit retry hint from this endpoint, bounded by the user's retry policy. */
export function planAdvisorUsageLimitWait(args: {
	retryAfterMs?: number;
	retry: { enabled: boolean; baseDelayMs: number; maxDelayMs: number; maxRetries: number };
	attempt: number;
}): number | undefined {
	const { retryAfterMs, retry, attempt } = args;
	if (!retry.enabled || attempt >= retry.maxRetries || retryAfterMs === undefined || !Number.isFinite(retryAfterMs))
		return undefined;
	const delayMs = Math.max(0, retryAfterMs, calculateRetryBackoffDelayMs(retry.baseDelayMs, attempt + 1));
	return retry.maxDelayMs > 0 && delayMs > retry.maxDelayMs ? undefined : delayMs;
}
/**
 * Header prepended to the merged terminal-boundary delivery, sourced from
 * `prompts/advisor/boundary-guidance.md`. The reviewed work has already
 * finished, so notes may be stale or wrong — the primary is told to treat the
 * batch critically and may silently ignore what does not apply. This is the
 * guard against #4840's spurious post-completion tool calls, enforced by
 * prompt rather than channel.
 *
 * Shown on the first merged delivery of a session, then at most once every
 * {@link ADVISOR_BOUNDARY_GUIDANCE_TURNS} primary turns: strong guidance, not
 * per-delivery noise.
 */
const ADVISOR_BOUNDARY_GUIDANCE = advisorBoundaryGuidance.trim();
const ADVISOR_BOUNDARY_GUIDANCE_TURNS = 50;

/**
 * Last genuine user-turn initiator in the transcript. Agent-attributed
 * injections (steers, asides, internal notices) never count, so an advisor
 * continuation stays attributed to the advisor until fresh user input arrives.
 * Besides plain `user` messages, user-attributed custom turn initiators count
 * too — a directly invoked `/skill:` prompt or a writable collab peer's prompt
 * starts a genuine user turn without the `user` role. Compared by object
 * identity: transcript snapshots share message instances across callbacks,
 * while a new prompt or a rewind+resubmit always introduces a new object —
 * even within the same millisecond.
 */
function lastPrimaryUserMessage(messages: readonly AgentMessage[]): AgentMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "user" && message.attribution !== "agent") return message;
		if (message.role === "custom" && isUserTurnInitiator(message)) return message;
	}
	return undefined;
}
/** Advisor statistics for the advisor status command. */
export interface AdvisorStats {
	configured: boolean;
	active: boolean;
	model?: Model;
	contextWindow: number;
	contextTokens: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	messages: {
		user: number;
		assistant: number;
		total: number;
	};
	/** Per-advisor breakdown for every configured advisor. */
	advisors: PerAdvisorStat[];
}

/** One advisor's status, token usage, cost, and message counts. */
export interface PerAdvisorStat {
	name: string;
	status: AdvisorRuntimeStatus;
	model?: Model;
	contextWindow: number;
	contextTokens: number;
	tokens: AdvisorStats["tokens"];
	cost: number;
	messages: AdvisorStats["messages"];
	sessionId?: string;
}

interface ActiveAdvisor {
	name: string;
	slug: string;
	agent: Agent;
	runtime: AdvisorRuntime;
	adviseTool: AdviseTool;
	recorder: AdvisorTranscriptRecorder;
	recorderClosed: Promise<void>;
	agentUnsubscribe?: () => void;
	model: Model;
	thinkingLevel: ThinkingLevel;
	/**
	 * The user selected `auto` for this advisor's effort. The classifier only
	 * runs for the primary turn, so the advisor tracks the level `auto` resolved
	 * to there, retuned at each review boundary.
	 */
	providerSessionId: string | undefined;
	/** Cadence overrides resolved at each boundary; `undefined` (only the
	 *  roster-less default advisor) follows `advisor.reviewMode` /
	 *  `advisor.reviewInterval` live, so editing them needs no rebuild. */
	reviewMode: AdvisorReviewMode | undefined;
	reviewInterval: number | undefined;
	/** Per-advisor catch-up policy override; `undefined` inherits the global
	 *  `advisor.syncBacklog` setting dynamically at each boundary. */
	syncBacklog: AdvisorSyncBacklog | undefined;
	/** Eligible updates since the last reset; a review is scheduled at each multiple of the interval. */
	eligibleUpdates: number;
	/** Primary-turn count when the latest review was scheduled; the update that
	 *  runs from it covers work up to this turn. Notes stamped with it so merged
	 *  deliveries can show how many turns old each review was. */
	pendingCoveredTurn: number;
	/**
	 * Consecutive provider-block waits (usage limit or timed rate limit), bounded
	 * by retry.maxRetries. Reset on turn success, abandonment, and conversation
	 * reset — never on exhaustion of a non-latching rate limit, so the runtime's
	 * 3-strike drop can fire.
	 */
	providerWaitRetries: number;
	signature: string;
}
/** First index whose provider usage may anchor the advisor's context estimate. */
function advisorAnchorSearchStart(messages: readonly AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "compactionSummary") continue;
		// Advisor summaries created before this runtime-only boundary existed have
		// no trustworthy way to distinguish retained from newly appended messages.
		// Conservatively ignore every current assistant until the next compaction.
		return (message as AdvisorCompactionSummaryMessage).advisorUsageAnchorStartIndex ?? messages.length;
	}
	return 0;
}
interface AdvisorCompactionSummaryMessage extends CompactionSummaryMessage {
	firstKeptEntryId?: string;
	advisorUsageAnchorStartIndex?: number;
	/** Extra compaction state retained for local history reconstruction. */
	preserveData?: CompactionEntry["preserveData"];
}

interface AdvisorRuntimeDescriptor {
	config: AdvisorConfig;
	name: string;
	slug: string;
	model: Model;
	thinkingLevel: ThinkingLevel;
	reviewMode: AdvisorReviewMode | undefined;
	reviewInterval: number | undefined;
	syncBacklog: AdvisorSyncBacklog | undefined;
	signature: string;
}

/** What a rebuilt advisor inherits from the runtime it replaces (keyed by slug). */
interface AdvisorCarry {
	held: AdvisorHeldUpdates | undefined;
	eligibleUpdates: number;
}

/** Options for the headless advisor drain ({@link SessionAdvisors.waitForAdvisorCatchup}). */
export interface AdvisorCatchupOptions {
	/** Keep waiting while a failed review retries or switches to its fallback model. */
	waitThroughRecovery?: boolean;
	/** Wait on `strict` advisors without the deadline (top-level headless runs only). */
	strictWithoutDeadline?: boolean;
}

/** Inputs that configure the advisor roster owned by a session. */
export interface SessionAdvisorsOptions {
	enabled: boolean;
	tools?: AgentTool[];
	watchdogPrompt?: string;
	sharedInstructions?: string;
	sharedMaxNotesPerUpdate?: number;
	contextPrompt?: string;
	configs?: AdvisorConfig[];
	/** WATCHDOG.yml problems found during discovery; surfaced once as a warning. */
	configWarnings?: string[];
	streamFn?: StreamFn;
	/** Builds each advisor's provider request transform; called once per advisor agent. */
	createTransformProviderContext?: () => (context: Context, model: Model) => Context | Promise<Context>;
}

/** Options accepted when an advisor injects a primary-session message. */
export interface AdvisorMessageDeliveryOptions {
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp" | "nextTurn";
	queueChipText?: string;
	acceptTerminalEmptyStop?: boolean;
}

/** Session capabilities borrowed by the advisor controller. */
export interface SessionAdvisorsHost {
	model(): Model | undefined;
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	yieldQueue: YieldQueue;
	obfuscator(): SecretObfuscator | undefined;
	onPayload: SimpleStreamOptions["onPayload"] | undefined;
	onResponse: SimpleStreamOptions["onResponse"] | undefined;
	onSseEvent: SimpleStreamOptions["onSseEvent"] | undefined;
	isDisposed(): boolean;
	abortInProgress(): boolean;
	allowAgentInitiatedTurns(): boolean;
	planModeState(): PlanModeState | undefined;
	clientBridge(): ClientBridge | undefined;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	sendCustomMessage(message: CustomMessagePayload, options?: AdvisorMessageDeliveryOptions): Promise<boolean>;
	extractQueuedAdvisorCards(): CustomMessage[];
	dropPendingAdvisorCards(): void;
	preserveAdvisorCard(card: CustomMessage): void;
	hasPendingNextTurnMessages(): boolean;
	convertToLlmForSideRequest(messages: AgentMessage[]): Message[];
	sessionId(): string;
	/** Whether the owning session is the top-level main session or a spawned subagent (`"main"` when omitted). */
	agentKind?(): "main" | "sub";
}

/**
 * One advisor's status-line slice: runtime status, whether it has finished
 * reviewing the current yield, its queued or in-flight review backlog, and
 * whether the live runtime is parked at the pause boundary.
 */
export interface AdvisorStatusOverviewEntry {
	name: string;
	status: AdvisorRuntimeStatus;
	yielded: boolean;
	backlog: number;
	isPaused: boolean;
}

/** Owns advisor runtimes, delivery policy, context maintenance, and status reporting. */
export class SessionAdvisors {
	readonly #host: SessionAdvisorsHost;
	#advisorEnabled: boolean;
	#advisorTools: AgentTool[] | undefined;
	#advisorWatchdogPrompt: string | undefined;
	#advisorSharedInstructions: string | undefined;
	#advisorSharedMaxNotesPerUpdate: number | undefined;
	#advisorContextPrompt: string | undefined;
	#advisorStreamFn: StreamFn | undefined;
	#createTransformProviderContext: (() => (context: Context, model: Model) => Context | Promise<Context>) | undefined;
	#advisors: ActiveAdvisor[] = [];
	#advisorConfigs: AdvisorConfig[] | undefined;
	#advisorConfigWarnings: string[];
	#advisorStatuses = new Map<string, { name: string; status: AdvisorRuntimeStatus }>();
	#advisorProviderSessionIds = new Map<string, string>();
	#advisorCosts = new Map<string, number>();
	#advisorRecorderClosed: Promise<void> = Promise.resolve();
	/** Holds recorder writes behind the active resume-cost byte snapshot. */
	#advisorCostSnapshotBarrier: Promise<void> | undefined;
	#advisorAutoResumeSuppressed = false;
	#preserveAdvisorAdvice = false;
	#preserveTerminalYieldAdvice = false;
	/** Routes late advice against a finished run through the boundary-flush continuation policy during unwind. */
	#terminalUnwindActive = false;
	#advisorPrimaryTurnsCompleted = 0;
	#advisorPrimaryWillContinue = false;
	/**
	 * Set when an advisor delivery itself starts a continuation of a finished
	 * run (a steer while idle or unwinding past a terminal boundary), stamped with
	 * the last genuine user message at that moment. Every boundary of that
	 * continuation, through its terminal one, captures without scheduling a
	 * review or advancing cadence: otherwise each advisor-triggered turn
	 * re-schedules reviewers and the session cascades advisor→primary→advisor.
	 * Continuations started by anything else (todo reminders, async wakes, live
	 * delegations) are reviewed normally. Fresh user input voids the mark.
	 */
	#advisorContinuation: { userMessage: AgentMessage | undefined } | undefined;
	/**
	 * True while a terminal-boundary {@link onPrimaryTurnEnd} callback runs
	 * (deferred flush + catch-up wait). The agent loop still reports
	 * `isStreaming` during this window; #routeAdvice uses the flag to preserve
	 * non-blocker notes as cards instead of steering a fresh turn against
	 * completed work.
	 */
	#advisorTerminalBoundaryOpen = false;
	/**
	 * Notes routed while {@link #advisorTerminalBoundaryOpen} is set. Everything
	 * raised during a terminal-boundary window — deferred flush plus reviews
	 * finishing during the catch-up wait — collects here and delivers as ONE
	 * merged message when the window closes (#flushAdvisorBoundaryNotes), so N
	 * simultaneous notes never force N separate cards or continuation turns.
	 */
	#advisorBoundaryNotes: AdvisorNote[] = [];
	/** Primary-turn count when the staleness header last shipped; `undefined`
	 *  until the first merged delivery. Gates {@link ADVISOR_BOUNDARY_GUIDANCE}
	 *  to at most once per {@link ADVISOR_BOUNDARY_GUIDANCE_TURNS} turns. */
	#advisorBoundaryGuidanceLastTurn: number | undefined;
	#advisorInterruptImmuneTurnStart: number | undefined;
	#pendingAdvisorCardEvents = new Set<Promise<void>>();
	#advisorYieldQueueUnsubscribe: (() => void) | undefined;

	constructor(host: SessionAdvisorsHost, options: SessionAdvisorsOptions) {
		this.#host = host;
		this.#advisorEnabled = options.enabled;
		this.#advisorTools = options.tools;
		this.#advisorWatchdogPrompt = options.watchdogPrompt;
		this.#advisorSharedInstructions = options.sharedInstructions;
		this.#advisorSharedMaxNotesPerUpdate = options.sharedMaxNotesPerUpdate;
		this.#advisorContextPrompt = options.contextPrompt;
		this.#advisorConfigs = options.configs;
		this.#advisorConfigWarnings = options.configWarnings ?? [];
		this.#advisorStreamFn = options.streamFn;
		this.#createTransformProviderContext = options.createTransformProviderContext;
		if (this.#advisorEnabled) this.#buildAdvisorRuntime();
	}

	/** Queues eligible primary updates for each live advisor. */
	async onPrimaryTurnEnd(
		messages: AgentMessage[],
		willContinue: boolean | undefined,
		signal?: AbortSignal,
	): Promise<void> {
		const terminalBoundary = willContinue !== true;
		if (terminalBoundary) this.#terminalUnwindActive = true;
		// Delivery state follows primary boundaries even when review cadence skips a callback.
		this.#advisorPrimaryWillContinue = willContinue === true;
		this.#advisorPrimaryTurnsCompleted++;
		// Marks the terminal-boundary window (flush + catch-up wait) for
		// #routeAdvice: the loop still reports isStreaming here, but the turn IS
		// final, so non-blocker notes must preserve instead of steering a fresh
		// turn against completed work.
		this.#advisorTerminalBoundaryOpen = !this.#advisorPrimaryWillContinue;
		try {
			this.#retuneAdvisorThinkingLevels();
			if (!this.#advisorPrimaryWillContinue) {
				// Flush notes deferred during tool-loop steps at every terminal boundary.
				// Delivery never pauses: advice already produced against work the
				// reviewers saw still reaches the primary during an advisor continuation.
				for (const advisor of this.#advisors) advisor.adviseTool.flushDeferredNotes();
			}
			// A boundary of a continuation the advisor itself started is captured but
			// never schedules a review: the next genuinely started boundary reviews it.
			const continuation = this.#advisorContinuation;
			const advisorContinuation =
				continuation !== undefined && lastPrimaryUserMessage(messages) === continuation.userMessage;
			if (!advisorContinuation || !this.#advisorPrimaryWillContinue) this.#advisorContinuation = undefined;
			// The roster-less default advisor follows the cadence settings live.
			const defaultReviewMode = cfgAdvisorReviewMode.get(this.#host.settings);
			const configuredInterval = cfgAdvisorReviewInterval.get(this.#host.settings);
			const defaultReviewInterval =
				Number.isFinite(configuredInterval) && configuredInterval >= 1 ? Math.trunc(configuredInterval) : 1;
			let scheduledAdvisors: ActiveAdvisor[] | undefined;
			for (const advisor of this.#advisors) {
				if (advisor.runtime.disposed) continue;
				// Every advisor captures this boundary's delta now, while it matches
				// what the primary saw: the per-turn prune that runs right after this
				// callback may elide its tool results before a later review renders
				// them. Cadence only decides whether the capture is sent or held; an
				// advisor continuation holds it without advancing cadence.
				const reviewMode = advisor.reviewMode ?? defaultReviewMode;
				const eligible = !advisorContinuation && !(reviewMode === "agent-end" && willContinue === true);
				if (eligible) advisor.eligibleUpdates++;
				const scheduled =
					eligible && advisor.eligibleUpdates % (advisor.reviewInterval ?? defaultReviewInterval) === 0;
				if (scheduled) {
					scheduledAdvisors ??= [];
					scheduledAdvisors.push(advisor);
					advisor.pendingCoveredTurn = this.#advisorPrimaryTurnsCompleted;
				}
				try {
					advisor.runtime.onTurnEnd(messages, { willContinue, dispatch: scheduled });
				} catch (error) {
					logger.warn("advisor onTurnEnd threw; delta dropped", { advisor: advisor.name, err: String(error) });
				}
			}
			if (!scheduledAdvisors) return;
			// Catch-up policy resolves per advisor at each boundary: a roster
			// entry's `syncBacklog` override wins; omitted entries follow the
			// global `advisor.syncBacklog` setting live (a settings change needs
			// no rebuild). Only advisors whose review was scheduled this boundary
			// are waited on, each under its own policy — a `strict` final reviewer
			// blocks the boundary (no wall-clock cap; abort, failure, quota,
			// transition, and disposal still release it) while an asynchronous
			// turn reviewer never parks the primary.
			const globalSyncBacklog = cfgAdvisorSyncBacklog.get(this.#host.settings);
			const waits: Promise<boolean>[] = [];
			for (const scheduled of scheduledAdvisors) {
				const syncBacklog = scheduled.syncBacklog ?? globalSyncBacklog;
				if (syncBacklog === "off") continue;
				const strict = syncBacklog === "strict";
				const threshold = strict ? 1 : Number.parseInt(syncBacklog, 10);
				waits.push(scheduled.runtime.waitForCatchup(strict ? undefined : 30_000, threshold, signal));
			}
			await Promise.all(waits);
		} finally {
			this.#advisorTerminalBoundaryOpen = false;
			// Window closed: deliver everything buffered during flush + catch-up
			// wait as one merged message (one steer at most, else one card).
			this.#flushAdvisorBoundaryNotes();
			// The merge window covers only this callback. With advisor.syncBacklog
			// off the review drain can still emit after it returns; those late notes
			// deliver individually through #routeAdvice, and `#terminalUnwindActive`
			// (held until the next primary turn starts), not the merge window, is what
			// keeps them from steering finished work — only a note at or above
			// `advisor.continueSeverity` may still request a continuation.
			if (!terminalBoundary) this.#terminalUnwindActive = false;
		}
	}

	/** Rebuilds live advisors when role assignments alter their resolved runtime inputs. */
	reconcileModelRoles(): void {
		if (!this.#advisorEnabled || this.#host.isDisposed()) return;
		if (this.#advisors.length > 0 && !this.#advisorRuntimeMatchesCurrentConfig()) this.#rebuildAdvisorRuntime();
		else this.#buildAdvisorRuntime(true);
	}

	/**
	 * True when the enabled advisor roster still has an entry left at `no_model`.
	 *
	 * At construction the advisor role is resolved against whatever the model
	 * catalog holds at that instant. Discovery-backed providers (e.g. GitHub
	 * Copilot) may not have populated the registry yet, so a valid configured
	 * model can transiently fail to resolve and record `no_model`. See #9010.
	 */
	hasInactiveNoModelAdvisor(): boolean {
		if (!this.#advisorEnabled) return false;
		for (const entry of this.#advisorStatuses.values()) {
			if (entry.status === "no_model") return true;
		}
		return false;
	}

	/**
	 * Reactivate an enabled advisor stuck at `no_model` after the initial
	 * background model discovery settles, so a valid configured model that was
	 * merely late to the catalog starts without a manual `/advisor` toggle. The
	 * rebuild is quiet (no warnings) because a warning was already emitted at
	 * construction. Returns true when the rebuild brought an advisor online so the
	 * caller can refresh the status line. See #9010.
	 */
	retryAfterModelDiscovery(): boolean {
		if (this.#host.isDisposed() || !this.hasInactiveNoModelAdvisor()) return false;
		const before = this.#advisors.length;
		if (before > 0 && !this.#advisorRuntimeMatchesCurrentConfig()) this.#rebuildAdvisorRuntime(false);
		else this.#buildAdvisorRuntime(true, false);
		return this.#advisors.length > before;
	}

	/** Starts configured advisor runtimes when they are eligible. */
	buildRuntime(seedToCurrent = false): boolean {
		return this.#buildAdvisorRuntime(seedToCurrent);
	}

	/** Stops every advisor runtime and starts recorder shutdown. */
	stopRuntime(): void {
		this.#stopAdvisorRuntime();
	}

	/**
	 * Pause advisor work while old-session recorder feeds remain attached, then
	 * detach only after any active prompt has settled.
	 */
	async drainAndDetachRecorders(): Promise<void> {
		await Promise.all(this.#advisors.map(advisor => advisor.runtime.pauseForSessionTransition()));
		await this.detachAndCloseRecorders();
	}

	/** Detaches and drains recorder feeds before transcript artifacts are removed. */
	async detachAndCloseRecorders(): Promise<void> {
		const closes: Promise<void>[] = [];
		for (const advisor of this.#advisors) {
			advisor.agentUnsubscribe?.();
			advisor.agentUnsubscribe = undefined;
			advisor.recorderClosed = advisor.recorder.close();
			closes.push(advisor.recorderClosed);
		}
		await Promise.all(closes);
	}

	/** Reattach recorder feeds and resume work after a rolled-back or preserving transition. */
	reattachRecorderFeeds(): void {
		for (const advisor of this.#advisors) {
			if (!advisor.agentUnsubscribe) this.#attachAdvisorRecorderFeed(advisor);
			advisor.runtime.resumeAfterSessionTransition();
		}
	}

	/** Re-primes advisor transcript views across a conversation boundary. */
	resetSessionState(options: { preserveCost?: boolean } = {}): void {
		this.#resetAdvisorSessionState(options.preserveCost === true);
	}

	/** Drop the recorded spend once a conversation boundary has committed. */
	clearCost(): void {
		this.#advisorCosts.clear();
	}

	/** Replace the ledger with spend recorded for the session becoming active. */
	restoreCost(costs: ReadonlyMap<string, number>): void {
		this.#advisorCosts = new Map(costs);
	}

	/** Capture the current per-advisor spend ledger. */
	costSnapshot(): ReadonlyMap<string, number> {
		return new Map(this.#advisorCosts);
	}
	/**
	 * Freeze active recorder writes after everything billed so far. The returned
	 * baseline and byte snapshot therefore describe the same turn boundary.
	 */
	beginCostRestoreSnapshot(): {
		costsAtSnapshot: ReadonlyMap<string, number>;
		ready: Promise<unknown>;
		release: () => void;
	} {
		const costsAtSnapshot = this.costSnapshot();
		const gate = Promise.withResolvers<void>();
		this.#advisorCostSnapshotBarrier = gate.promise;
		const ready = Promise.all(this.#advisors.map(advisor => advisor.recorder.blockWritesUntil(gate.promise)));
		let released = false;
		return {
			costsAtSnapshot,
			ready,
			release: () => {
				if (released) return;
				released = true;
				if (this.#advisorCostSnapshotBarrier === gate.promise) this.#advisorCostSnapshotBarrier = undefined;
				gate.resolve();
			},
		};
	}

	/**
	 * Restore spend persisted at `costsAtSnapshot`, then add only the process-local
	 * delta billed after that fixed transcript snapshot. This preserves turns
	 * completed while the background scan runs without double-counting entries
	 * the scan already includes.
	 */
	restoreInitialCost(costs: ReadonlyMap<string, number>, costsAtSnapshot: ReadonlyMap<string, number>): void {
		const restored = new Map(costs);
		for (const [slug, current] of this.#advisorCosts) {
			const accrued = current - (costsAtSnapshot.get(slug) ?? 0);
			if (accrued <= 0) continue;
			restored.set(slug, (restored.get(slug) ?? 0) + accrued);
		}
		this.#advisorCosts = restored;
	}

	/**
	 * Rebind every live advisor to the active primary conversation's provider
	 * identity (session id, prompt-cache key, credential + metadata resolvers,
	 * telemetry). Invoked on every provider-session change — including branch
	 * paths that skip conversation restore — so advisors never keep emitting the
	 * previous conversation's session id/metadata (issue #6625).
	 */
	refreshProviderIdentity(): void {
		for (const advisor of this.#advisors) this.#refreshAdvisorProviderIdentity(advisor);
	}

	/**
	 * Re-primes advisor transcript views after an in-conversation history rewrite.
	 * `compacted` marks a rewrite that replaced history with a summary, which releases refusal pins.
	 */
	resetAllRuntimes(reason?: string, options?: { compacted?: boolean }): void {
		this.#resetAllAdvisorRuntimes(reason, options?.compacted === true);
	}

	/** Re-aligns advisor delivered prefixes after an in-place rewrite their contexts already cover. */
	rebaseDeliveredPrefixes(reason: string): void {
		for (const advisor of this.#advisors) advisor.runtime.rebaseDeliveredPrefix(reason);
	}

	/** Whether live runtimes still match the resolved advisor configuration. */
	runtimeMatchesCurrentConfig(): boolean {
		return this.#advisorRuntimeMatchesCurrentConfig();
	}

	/** Whether concern/blocker delivery is inside the post-interrupt immunity window. */
	isInterruptImmuneTurnActive(): boolean {
		return this.#isAdvisorInterruptImmuneTurnActive();
	}

	/** Latest aggregate recorder-close barrier. */
	recorderClosed(): Promise<void> {
		return this.#advisorRecorderClosed;
	}

	/** Whether a user interrupt currently suppresses advisor-driven auto-resume. */
	get autoResumeSuppressed(): boolean {
		return this.#advisorAutoResumeSuppressed;
	}

	set autoResumeSuppressed(value: boolean) {
		this.#advisorAutoResumeSuppressed = value;
	}

	/** Tracks persistence of a visible advisor card emitted outside the primary loop. */
	trackCardEvent(processing: Promise<void>): void {
		this.#pendingAdvisorCardEvents.add(processing);
		void processing.finally(() => this.#pendingAdvisorCardEvents.delete(processing)).catch(() => {});
	}

	/** Waits for all advisor-card persistence handlers currently in flight. */
	async waitForPendingCardEvents(): Promise<void> {
		await Promise.allSettled(this.#pendingAdvisorCardEvents);
	}

	// Advisor runtime lifecycle
	// -------------------------------------------------------------------------
	#advisorImmuneTurnLimit(): number {
		const immuneTurns = cfgAdvisorImmuneTurns.get(this.#host.settings);
		if (!Number.isFinite(immuneTurns) || immuneTurns <= 0) return 0;
		return Math.trunc(immuneTurns);
	}

	#isAdvisorInterruptImmuneTurnActive(): boolean {
		return isAdvisorInterruptImmuneTurnActive({
			completedTurns: this.#advisorPrimaryTurnsCompleted,
			immuneTurnStart: this.#advisorInterruptImmuneTurnStart,
			immuneTurns: this.#advisorImmuneTurnLimit(),
		});
	}

	#advisorMaxNotesPerUpdate(config?: AdvisorConfig): number {
		const clamp = (value: unknown): number | undefined =>
			typeof value === "number" && Number.isFinite(value) && value >= 1
				? Math.min(ADVISOR_MAX_BUDGET_PER_UPDATE, Math.trunc(value))
				: undefined;

		return (
			clamp(config?.maxNotesPerUpdate) ??
			clamp(this.#advisorSharedMaxNotesPerUpdate) ??
			clamp(cfgAdvisorMaxNotesPerUpdate.get(this.#host.settings)) ??
			ADVISOR_DEFAULT_BUDGET_PER_UPDATE
		);
	}

	// The next primary turn number starts the immune-turn window. While the
	// interrupting steer is still in flight, completedTurns is lower than this
	// start, so duplicate concern/blocker advice is also downgraded.
	#recordAdvisorInterruptDelivered(): void {
		this.#advisorInterruptImmuneTurnStart = this.#advisorPrimaryTurnsCompleted + 1;
	}

	/**
	 * One advisor's provider session id under the active primary conversation.
	 * The primary's account pools follow it: an advisor is part of that session.
	 */
	#advisorProviderSessionId(slug: string): string | undefined {
		const providerSessionId = getOrCreateAdvisorProviderSessionId(
			this.#advisorProviderSessionIds,
			this.#host.sessionId(),
			slug,
		);
		return providerSessionId;
	}

	/** Rebind one advisor to the active primary conversation's provider identity. */
	#refreshAdvisorProviderIdentity(advisor: ActiveAdvisor): void {
		const primaryProviderSessionId = this.#host.sessionId();
		const providerSessionId = this.#advisorProviderSessionId(advisor.slug);
		advisor.providerSessionId = providerSessionId;
		advisor.agent.sessionId = providerSessionId;
		advisor.agent.promptCacheKey = this.#host.agent.promptCacheKey ?? providerSessionId;
		advisor.agent.getApiKey = requestModel => this.#host.modelRegistry.resolver(requestModel, providerSessionId);
		advisor.agent.setMetadataResolver(providerSessionId ? () => buildSessionMetadata(providerSessionId) : undefined);

		const telemetry = advisor.agent.telemetry;
		if (telemetry?.agent) {
			advisor.agent.setTelemetry({
				...telemetry,
				agent: {
					...telemetry.agent,
					id: advisor.slug
						? `${primaryProviderSessionId}-advisor-${advisor.slug}`
						: `${primaryProviderSessionId}-advisor`,
				},
			});
		}
	}

	/**
	 * Re-prime the advisor across a conversation boundary: `/new`, `/branch`,
	 * `/btw`, `/tree`, and session switch/resume. Beyond {@link AdvisorRuntime.reset}
	 * (which only re-primes the advisor's transcript view and is also fired by
	 * within-conversation rewrites like compaction/shake/rewind), this clears the
	 * session-level interrupt latches so the prior conversation's cooldown cannot
	 * leak into the new one: the post-interrupt immune-turn window
	 * (`#advisorPrimaryTurnsCompleted`, `#advisorInterruptImmuneTurnStart`) and the
	 * user-interrupt auto-resume suppression flag. It also drops advisor deliveries
	 * still queued against the prior conversation — pending asides in the yield
	 * queue (advisor entries use `skipIdleFlush`, so they linger until the next
	 * `drainLazy` rather than self-flushing), interrupting cards parked in the
	 * agent steer/follow-up queues, and preserved cards deferred to the next turn —
	 * so none of them inject into the new conversation.
	 */
	#resetAdvisorSessionState(preserveCost: boolean): void {
		if (!preserveCost) {
			this.#advisorCosts.clear();
		}
		// Mute the recorder across the re-prime: AdvisorRuntime.reset() aborts the advisor
		// loop, and that abort can emit an `aborted` message_end we must not attribute to
		// either session's transcript. Detach, reset, then re-attach the live agent's feed.
		for (const a of this.#advisors) {
			a.agentUnsubscribe?.();
			a.agentUnsubscribe = undefined;
			a.runtime.reset("conversation-boundary");
			// A reset aborts any pending provider-block wait; clear its budget so the new
			// conversation starts with a fresh retry allowance (issue #11947).
			this.#resetRecoveryBudgets(a);
			// Resets the emission guard and every tool-side note state together.
			a.adviseTool.resetDeliveredNotes();
			a.eligibleUpdates = 0;
			this.#attachAdvisorRecorderFeed(a);
		}
		this.#advisorPrimaryTurnsCompleted = 0;
		this.#advisorPrimaryWillContinue = false;
		this.#advisorContinuation = undefined;
		this.#advisorInterruptImmuneTurnStart = undefined;
		this.#advisorAutoResumeSuppressed = false;
		this.#advisorBoundaryNotes = [];
		this.#advisorBoundaryGuidanceLastTurn = undefined;
		this.#host.yieldQueue.clear("advisor");
		this.#host.extractQueuedAdvisorCards();
		this.#host.dropPendingAdvisorCards();
	}

	#resolveAdvisorRuntimeDescriptors(emitWarnings: boolean): AdvisorRuntimeDescriptor[] {
		const legacy = !this.#advisorConfigs?.length;
		const roster: AdvisorConfig[] = legacy ? [{ name: "default" }] : this.#advisorConfigs!;
		const descriptors: AdvisorRuntimeDescriptor[] = [];
		const usedSlugs = new Set<string>();
		const sessionKind = this.#host.agentKind?.() ?? "main";
		for (const config of roster) {
			if (
				(config.scope === "main" && sessionKind !== "main") ||
				(config.scope === "subagent" && sessionKind !== "sub")
			) {
				continue;
			}
			let slug = legacy ? "" : slugifyAdvisorName(config.name);
			if (slug) {
				let candidate = slug;
				let n = 2;
				while (usedSlugs.has(candidate)) candidate = `${slug}-${n++}`;
				slug = candidate;
				usedSlugs.add(slug);
			}
			// Per-advisor toggle: skip disabled advisors but keep them in the
			// status map so they show `○` rather than disappearing.
			if (config.enabled === false) {
				this.#advisorStatuses.set(slug, { name: config.name, status: "paused" });
				continue;
			}
			// Roster entries default to every-turn review; the roster-less default
			// advisor leaves both unset and follows the cadence settings live.
			const reviewMode: AdvisorReviewMode | undefined = legacy
				? undefined
				: config.reviewMode === "agent-end"
					? "agent-end"
					: "turn";
			const configuredReviewInterval = config.reviewInterval;
			const reviewInterval = legacy
				? undefined
				: typeof configuredReviewInterval === "number" &&
					  Number.isSafeInteger(configuredReviewInterval) &&
					  configuredReviewInterval >= 1
					? configuredReviewInterval
					: 1;
			// Catch-up override: schema-validated for WATCHDOG.yml entries, clamped
			// defensively for editor-supplied configs. `undefined` inherits the
			// global `advisor.syncBacklog` dynamically at each boundary; an explicit
			// "off" wins over a global strict/numeric policy.
			const syncBacklog: AdvisorSyncBacklog | undefined =
				config.syncBacklog !== undefined &&
				(ADVISOR_SYNC_BACKLOG_MODES as readonly string[]).includes(config.syncBacklog)
					? config.syncBacklog
					: undefined;

			const model = this.#host.model();
			if (!model) {
				this.#advisorStatuses.set(slug, { name: config.name, status: "no_model" });
				if (emitWarnings)
					logger.debug("advisor inactive because the session has no selected model", { advisor: config.name });
				continue;
			}
			const advisorThinkingLevel =
				resolveThinkingLevelForModel(model, this.#primaryThinkingLevel()) ?? ThinkingLevel.Inherit;
			// Record the status entry now (in roster order) so the Map's insertion
			// order matches the configured roster even when earlier advisors were
			// skipped as paused/no_model. The build loop overwrites this to "running"
			// without changing insertion order.
			this.#advisorStatuses.set(slug, { name: config.name, status: "running" });
			descriptors.push({
				config,
				name: config.name,
				slug,
				model,
				thinkingLevel: advisorThinkingLevel,
				reviewMode,
				reviewInterval,
				syncBacklog,
				// Effort follows the primary at each boundary, so it does not
				// belong in the signature that rebuilds advisor context.
				// Cadence and catch-up resolve at each boundary rather than at build
				// time, so they stay out of the signature.
				signature: this.#advisorRuntimeSignature(config, slug, model),
			});
		}
		return descriptors;
	}

	#advisorRuntimeSignature(config: AdvisorConfig, slug: string, model: Model): string {
		const tools = config.tools?.length ? config.tools.join("\u001e") : "";
		const instructions = config.instructions?.trim() ?? "";
		const budget = this.#advisorMaxNotesPerUpdate(config);
		const scope = config.scope ?? "all";
		const includeReasoning = config.includeReasoning !== false ? "1" : "0";
		return [
			config.name,
			slug,
			formatModelStringWithRouting(model),
			tools,
			instructions,
			budget,
			scope,
			includeReasoning,
		].join("\u001f");
	}

	#advisorRuntimeMatchesCurrentConfig(): boolean {
		const descriptors = this.#resolveAdvisorRuntimeDescriptors(false);
		if (descriptors.length !== this.#advisors.length) return false;
		for (let i = 0; i < descriptors.length; i++) {
			// The same provider/id can carry a different endpoint, headers or header
			// resolver. A primary object replacement must reach advisor requests too.
			if (
				descriptors[i].model !== this.#advisors[i].model ||
				descriptors[i].signature !== this.#advisors[i].signature
			)
				return false;
		}
		return true;
	}

	/**
	 * Replace the live advisors in place. Each successor keeps its predecessor's
	 * cadence phase and resumes at its cursor with the captured-but-unreviewed
	 * updates, so a rebuild never drops turns the cadence skipped.
	 */
	#rebuildAdvisorRuntime(emitWarnings = true): boolean {
		const carried = new Map<string, AdvisorCarry>();
		for (const advisor of this.#advisors) {
			carried.set(advisor.slug, { held: advisor.runtime.releaseHeld(), eligibleUpdates: advisor.eligibleUpdates });
		}
		this.#stopAdvisorRuntime();
		return this.#buildAdvisorRuntime(true, emitWarnings, carried);
	}

	#buildAdvisorRuntime(
		seedToCurrent = false,
		emitWarnings = true,
		carried?: ReadonlyMap<string, AdvisorCarry>,
	): boolean {
		if (this.#host.isDisposed()) return false;
		if (this.#advisors.length > 0) return true;
		if (!this.#advisorEnabled) return false;

		// Rebuild the status map from scratch so removed/renamed advisors don't
		// leave stale entries. #resolveAdvisorRuntimeDescriptors populates every
		// entry (`paused`/`no_model`/`running`) in roster order; the build loop
		// below confirms `running` for successfully built advisors.
		this.#advisorStatuses.clear();
		const descriptors = this.#resolveAdvisorRuntimeDescriptors(emitWarnings);

		// Advisor service tier (`tier.advisor`): "none" (default) runs the advisor
		// on standard processing; "inherit" tracks the session's live per-family
		// tiers per request (like the main agent, including /fast toggles); a
		// concrete value is broadcast across families and applied to the advisor
		// model's family. One value for all advisors.

		for (const descriptor of descriptors) {
			const {
				config,
				slug,
				model: advisorModel,
				name: advisorName,
				thinkingLevel: advisorThinkingLevel,
				signature,
			} = descriptor;
			const budgetPerUpdate = this.#advisorMaxNotesPerUpdate(config);
			// The tool owns admission end-to-end: the guard decides acceptance,
			// suppression reason, and pending-note displacement; the tool routes
			// accepted notes and acknowledges truthfully. No separate accept wrapper.
			const emissionGuard = new AdvisorEmissionGuard({ budgetPerUpdate });
			const adviseTool = new AdviseTool(
				(note, severity, turn) => this.#routeAdvice(advisorRef, note, severity, turn),
				emissionGuard,
			);

			// `#advisorWatchdogPrompt` already carries WATCHDOG.md + YAML shared
			// instructions; `config.instructions` adds this advisor's specialization.
			const systemPrompt = [prompt.render(advisorSystemPrompt, { max_notes_per_update: budgetPerUpdate })];
			if (this.#advisorContextPrompt) systemPrompt.push(this.#advisorContextPrompt);
			if (this.#advisorWatchdogPrompt) systemPrompt.push(this.#advisorWatchdogPrompt);
			if (this.#advisorSharedInstructions) systemPrompt.push(this.#advisorSharedInstructions);
			if (config.instructions?.trim()) systemPrompt.push(config.instructions.trim());

			const names = config.tools === undefined ? ADVISOR_DEFAULT_TOOL_NAMES : new Set(config.tools);
			const tools = (this.#advisorTools ?? []).filter(t => names.has(t.name));
			const advisorLoopTools: AgentTool<any>[] = [adviseTool, ...tools];
			const advisorToolMap = new Map<string, AgentTool<any>>();
			for (const tool of advisorLoopTools) {
				advisorToolMap.set(tool.name, tool);
				if (tool.customWireName !== undefined) advisorToolMap.set(tool.customWireName, tool);
			}
			let quarantinedAdvisorOutput: string | undefined;
			let currentAdvisorInput = "";

			const primaryProviderSessionId = this.#host.sessionId();
			const advisorSessionLabel = slug
				? `${primaryProviderSessionId}-advisor-${slug}`
				: `${primaryProviderSessionId}-advisor`;
			const advisorProviderSessionId = this.#advisorProviderSessionId(slug);
			const appendOnlyContext = new AppendOnlyContextManager();

			// Thread the primary's telemetry into the advisor loop so the advisor
			// model's GenAI spans + usage/cost hooks fire stamped with the local advisor
			// identity. `conversationId` is cleared so provider telemetry falls back to
			// the UUIDv7 provider session id, not the local `-advisor` label.
			const advisorTelemetry = this.#host.agent.telemetry
				? {
						...this.#host.agent.telemetry,
						agent: {
							id: advisorSessionLabel,
							name: slug ? `Advisor: ${advisorName}` : "Advisor",
							description: formatModelString(advisorModel),
						},
						conversationId: undefined,
					}
				: undefined;
			// Mirror the SDK's provider-shaping options (streamFn/onPayload/...,
			// promptCacheKey, transformProviderContext) so each
			// advisor's requests cache, route, and obfuscate like the main turn.
			// `promptCacheKey` preserves an explicitly pinned provider cache key
			// unchanged so tan/shared-session advisor calls read the exact shard the
			// parent turn populated. Otherwise the advisor uses its provider UUIDv7 so
			// request identity is independent of the display label.
			const advisorPromptCacheKey = this.#host.agent.promptCacheKey ?? advisorProviderSessionId;
			const advisorStreamFn = this.#advisorStreamFn ?? streamSimple;
			const advisorAgent = new Agent({
				initialState: {
					systemPrompt,
					model: advisorModel,
					thinkingLevel: toReasoningEffort(advisorThinkingLevel),
					tools: advisorLoopTools,
				},
				appendOnlyContext,
				sessionId: advisorProviderSessionId,
				promptCacheKey: advisorPromptCacheKey,
				cwdResolver: () => this.#host.sessionManager.getCwd(),
				getApiKey: requestModel => this.#host.modelRegistry.resolver(requestModel, advisorProviderSessionId),
				streamFn: advisorStreamFn,
				serviceTierResolver: () => this.#host.agent.serviceTier,
				// Maintenance installs compactionSummary messages; the core Agent's
				// default converter drops custom roles and would discard their replay.
				convertToLlm: messages => this.#host.convertToLlmForSideRequest(messages),
				onPayload: this.#host.onPayload,
				onResponse: this.#host.onResponse,
				onSseEvent: this.#host.onSseEvent,
				// Built per advisor: the transform keeps per-conversation state (the
				// date/cwd reminder), and each advisor is a conversation of its own.
				transformProviderContext: this.#createTransformProviderContext?.(),
				intentTracing: false,
				transformAssistantMessage: message => {
					quarantinedAdvisorOutput = quarantineAdvisorUnsafeOutput(
						message,
						buildAdvisorQuarantineSourceText(currentAdvisorInput, advisorAgent.state.messages),
					);
				},
				// A turn whose only tool calls are `advise` has nothing left to do:
				// without this the model is re-invoked over the whole prefix just to
				// say "done" (measured at ~6% of advisor spend, zero notes). Stop the
				// review through the same graceful terminal path the primary's
				// `yield` tool uses — the tool batch persists and `onTurnEnd` still
				// runs. A turn that advises and keeps investigating is untouched.
				// Fire on the LAST advise block, not the first: the batch starts
				// records in index order and a not-yet-started sibling would see the
				// aborted signal and become a skipped placeholder — a lost note.
				afterToolCall: ctx => {
					if (ctx.toolCall.name !== adviseTool.name) return undefined;
					if (ctx.isError) return undefined;
					let lastAdviseId: string | undefined;
					for (const block of ctx.assistantMessage.content) {
						if (block.type !== "toolCall") continue;
						if (block.name !== adviseTool.name) return undefined;
						lastAdviseId = block.id;
					}
					if (ctx.toolCall.id === lastAdviseId) advisorAgent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
					return undefined;
				},
				telemetry: advisorTelemetry,
			});
			advisorAgent.setDisableReasoning(shouldDisableReasoning(advisorThinkingLevel));
			advisorAgent.setModelResolver(model => this.#host.modelRegistry.fitContextWindow(model, this.#host.settings));
			let advisorLoopGuardStopped = false;
			// The advisor's own loop needs the same repeated-tool-call bound the
			// primary gets from `LoopGuards`; nothing else stops it reissuing one
			// failing call until the update is abandoned.
			const advisorLoopGuard = new AdvisorLoopGuard({
				settings: this.#host.settings,
				name: advisorName,
				liveMessages: () => advisorAgent.state.messages,
				appendMessage: message => advisorAgent.appendMessage(message),
				abort: reason => {
					advisorLoopGuardStopped = true;
					advisorAgent.abort(reason);
				},
			});
			advisorAgent.setOnTurnEnd((messages, signal, context) => {
				if (signal?.aborted) return;
				advisorLoopGuard.recordTurn(messages, context);
			});

			const advisorAgentFacade: AdvisorAgent = {
				prompt: async input => {
					let quarantined: string | undefined;
					advisorLoopGuard.reset();
					advisorLoopGuardStopped = false;
					try {
						quarantinedAdvisorOutput = undefined;
						// Multi-message input (candidate 4) must serialize deterministically
						// for quarantine source text; reuse the session history formatter
						// rather than ad-hoc joins so all message kinds (text/tool/
						// custom/structured) are preserved exactly as rendered.
						currentAdvisorInput = Array.isArray(input)
							? formatSessionHistoryMarkdown(input, { watchedRoles: true })
							: input;
						// Agent.prompt's overloads accept string OR AgentMessage[] but not
						// the union, so narrow first; both branches intentionally identical.
						if (Array.isArray(input)) await advisorAgent.prompt(input);
						else await advisorAgent.prompt(input);
						quarantined = quarantinedAdvisorOutput;
					} finally {
						if (advisorLoopGuardStopped) {
							// A loop guard stop is a deliberate, bounded silent review, not
							// a provider failure for AdvisorRuntime to retry/fallback.
							advisorAgent.state.error = undefined;
							advisorLoopGuardStopped = false;
						}
						quarantinedAdvisorOutput = undefined;
						currentAdvisorInput = "";
					}
					if (quarantined) throw new AdvisorOutputQuarantinedError(quarantined);
				},
				abort: reason => advisorAgent.abort(reason),
				reset: () => {
					advisorLoopGuard.reset();
					advisorLoopGuardStopped = false;
					advisorAgent.reset();
					appendOnlyContext.log.clear();
				},
				rollbackTo: count => {
					// Drop the failed user batch + synthetic assistant-error turn
					// `Agent.#runLoop` appended for a turn ending in `stopReason: "error"`.
					const messages = advisorAgent.state.messages;
					if (count < messages.length) {
						messages.length = count;
					}
					appendOnlyContext.resetSyncCursor();
					advisorAgent.state.error = undefined;
				},
				state: advisorAgent.state,
			};

			// Persist this advisor's turns to `<session>/__advisor[.<slug>].jsonl`
			// (resolved lazily so it follows session switches) for stats attribution
			// and Agent Hub observability, without registering it as a peer.
			const recorder = new AdvisorTranscriptRecorder(
				() => this.#host.sessionManager.getSessionFile(),
				() => this.#host.sessionManager.getCwd(),
				advisorTranscriptFilename(slug),
				// On the advisor on→off→on toggle, wait for the prior recorders' closes
				// so two SessionManagers never hold the same file at once.
				this.#advisorCostSnapshotBarrier
					? Promise.all([this.#advisorRecorderClosed, this.#advisorCostSnapshotBarrier])
					: this.#advisorRecorderClosed,
			);
			const runtime = new AdvisorRuntime(advisorAgentFacade, {
				snapshotMessages: () => this.#host.agent.state.messages,
				maintainContext: (incoming, signal) => this.#maintainAdvisorContext(advisorRef, incoming, signal),
				obfuscator: this.#host.obfuscator(),
				includeReasoning: descriptor.config.includeReasoning,
				getModelIdentity: () => {
					const model = advisorRef.agent.state.model;
					return model ? formatModelString(model) : "unconfigured";
				},
				beginAdvisorUpdate: inProgress => {
					advisorRef.recorder.beginTurn();
					// Flushes the deferred backlog on the in-progress→completed
					// transition (notes already cleared admission when reserved) and
					// resets the guard's per-update budget for this prompt's live
					// notes — both owned by the tool now. A queued WIP review may
					// start after a terminal boundary flushed deferred notes; do not
					// re-arm in-progress deferral.
					advisorRef.adviseTool.beginUpdate(
						inProgress && this.#advisorPrimaryWillContinue,
						advisorRef.pendingCoveredTurn,
					);
				},
				onTurnError: (error, failedMessages, signal) =>
					this.#recoverAdvisorTurn(advisorRef, error, failedMessages, signal),
				onTurnSuccess: async () => {
					// Commit the delivered batch so retries of a failed turn stay deduped
					// while this successful turn's context is persisted once (issue #9553).
					advisorRef.recorder.commitTurn();
					// A completed turn ended the provider-block episode — start the next
					// block's bounded wait budget fresh.
					this.#resetRecoveryBudgets(advisorRef);
				},
				onTurnAbandoned: () => {
					advisorRef.recorder.abandonTurn();
					// The dropped batch ends this episode; the next batch gets a fresh budget.
					this.#resetRecoveryBudgets(advisorRef);
				},
				notifyFailure: error => {
					this.#advisorStatuses.set(slug, { name: advisorName, status: "error" });
					const message = error instanceof Error ? error.message : String(error);
					this.#host.emitNotice(
						"warning",
						`Advisor${slug ? ` "${advisorName}"` : ""} unavailable for ${advisorAgent.state.model ? formatModelString(advisorAgent.state.model) : "unconfigured"}: ${message}`,
						"advisor",
					);
				},
				notifyQuotaExhausted: () => {
					this.#advisorStatuses.set(slug, { name: advisorName, status: "quota_exhausted" });
					this.#host.emitNotice(
						"warning",
						`Advisor "${advisorName}" quota exhausted — pausing until reset.`,
						"advisor",
					);
				},
				notifyIdle: () => {
					// Repaint on every idle transition, streaming or not: the status
					// line masks `yielded` back to open while the primary streams, so
					// mid-turn drain completions stay open, while post-yield
					// completions — including the quota/halt latches, which can land
					// after the agent_end repaint — close the eye without waiting for
					// an unrelated event.
					void this.#host
						.emitSessionEvent({ type: "advisor_yielded" })
						.catch(err => logger.debug("advisor yield notification failed", { err: String(err) }));
				},
			});

			const advisorRef: ActiveAdvisor = {
				name: advisorName,
				slug,
				agent: advisorAgent,
				runtime,
				adviseTool,
				recorder,
				recorderClosed: Promise.resolve(),
				model: advisorModel,
				thinkingLevel: advisorThinkingLevel,
				providerSessionId: advisorProviderSessionId,
				reviewMode: descriptor.reviewMode,
				reviewInterval: descriptor.reviewInterval,
				syncBacklog: descriptor.syncBacklog,
				eligibleUpdates: carried?.get(slug)?.eligibleUpdates ?? 0,
				pendingCoveredTurn: 0,
				providerWaitRetries: 0,
				signature,
			};
			this.#refreshAdvisorProviderIdentity(advisorRef);
			this.#attachAdvisorRecorderFeed(advisorRef);
			const held = carried?.get(slug)?.held;
			if (held) runtime.adoptHeld(held);
			else if (seedToCurrent) runtime.seedTo(this.#host.agent.state.messages.length);
			this.#advisorStatuses.set(slug, { name: advisorName, status: "running" });
			this.#advisors.push(advisorRef);
		}

		// One shared non-blocking aside channel for all advisors; the build callback
		// aggregates every advisor's queued nits into one card (each entry already
		// carries its own `advisor` name).
		if (this.#advisors.length > 0 && !this.#advisorYieldQueueUnsubscribe) {
			this.#advisorYieldQueueUnsubscribe = this.#host.yieldQueue.register<AdvisorNote>("advisor", {
				build: entries =>
					entries.length === 0
						? null
						: ({
								role: "custom",
								customType: "advisor",
								display: true,
								attribution: "agent",
								timestamp: Date.now(),
								content: formatAdvisorBatchContent(entries),
								details: { notes: entries } satisfies AdvisorMessageDetails,
							} satisfies CustomMessage),
				skipIdleFlush: true,
			});
		}

		return this.#advisors.length > 0;
	}

	/** Whether the primary's tail (past advisor cards) is a terminal text answer with nothing queued behind it. */
	#hasTerminalTextAnswerWithoutQueuedWork(): boolean {
		if (this.#host.agent.hasQueuedMessages() || this.#host.hasPendingNextTurnMessages()) return false;
		const messages = this.#host.agent.state.messages;
		let tail = messages.length - 1;
		while (tail >= 0 && isAdvisorCard(messages[tail])) tail--;
		return isTerminalTextAssistantAnswer(messages[tail]);
	}

	/**
	 * Route one accepted advice note from `advisor` to the primary. Concern and
	 * blocker interrupt the running agent through the steering channel; a plain nit
	 * rides the non-interrupting YieldQueue aside during streaming. After a terminal
	 * text answer with no queued work, a note below `advisor.continueSeverity` is
	 * preserved as a visible advisor card, while one at or above it wakes the
	 * primary for one continuation. After a deliberate user interrupt auto-resume is
	 * suppressed while idle/unwinding (the note becomes a preserved card re-entering
	 * on resume); a live-streaming turn is steered in directly. Never re-runs
	 * admission — the note cleared the emission guard inside AdviseTool when it was
	 * emitted, so a deferred flush replays the backlog without re-filtering.
	 */
	#routeAdvice(advisor: ActiveAdvisor, note: string, severity?: AdvisorSeverity, turn?: number): void {
		// The implicit single ("default") advisor stamps no source name, so its
		// agent-facing `<advisory>` bytes stay identical to the pre-multi-advisor path.
		const source = advisor.slug ? advisor.name : undefined;
		// Inside a terminal-boundary callback (deferred flush + catch-up wait) the
		// loop still reports streaming, so a delivered note would steer a fresh turn
		// — waking the primary to act on advice produced against work that already
		// finished, and N simultaneous notes would force N separate deliveries
		// (#4840's spurious post-completion calls; N blockers = N identical "Done"
		// continuations). Buffer everything — nits, concerns, blockers — and deliver
		// once when the window closes: any note at `advisor.continueSeverity` steers
		// one merged continuation, otherwise one preserved card re-enters context on
		// the next user turn.
		if (this.#advisorTerminalBoundaryOpen) {
			this.#advisorBoundaryNotes.push({
				note,
				severity,
				advisor: source,
				turn: turn ?? this.#advisorPrimaryTurnsCompleted,
			});
			return;
		}
		const notes: AdvisorNote[] = [{ note, severity, advisor: source }];
		const terminalAnswerNoQueuedWork = this.#hasTerminalTextAnswerWithoutQueuedWork();
		// A note that lands after the boundary window closed (catch-up off, or a
		// review slower than its wait) gets exactly what the merged boundary flush
		// would have granted it. The loop may still report streaming here, and an
		// aside would be drained into an extra turn that skips the continuation latch.
		if (this.#terminalUnwindActive && terminalAnswerNoQueuedWork) {
			this.#deliverAdvisorBatch(notes, formatAdvisorBatchContent(notes), this.#continuesFinishedRun(severity));
			return;
		}
		const channel = resolveAdvisorDeliveryChannel({
			severity,
			continueSeverity: cfgAdvisorContinueSeverity.get(this.#host.settings),
			autoResumeSuppressed: this.#advisorAutoResumeSuppressed,
			preserveOnly: this.#preserveAdvisorAdvice,
			// Key on the live agent-core loop, not session `isStreaming` (which also
			// counts `#promptInFlightCount` during post-turn unwind). Only a running
			// loop consumes a steer at its next boundary.
			streaming: this.#host.agent.state.isStreaming && !this.#preserveTerminalYieldAdvice,
			aborting: this.#host.abortInProgress(),
			terminalAnswerNoQueuedWork,
			interruptImmuneTurnActive: this.#isAdvisorInterruptImmuneTurnActive(),
		});
		if (channel === "aside") {
			this.#host.yieldQueue.enqueue("advisor", { note, severity, advisor: source });
			return;
		}
		this.#deliverAdvisorBatch(notes, formatAdvisorBatchContent(notes), channel === "steer");
	}

	/**
	 * Merged delivery of everything routed during a terminal-boundary window.
	 * One message per boundary, carrying every note with per-advisor and
	 * per-severity attribution, headed by {@link ADVISOR_BOUNDARY_GUIDANCE} so
	 * the primary reads stale review output critically. Steering is decided per
	 * note by the same {@link resolveAdvisorDeliveryChannel} policy live routing
	 * uses — user-stop suppression, headless/terminal-yield preservation, and
	 * the post-interrupt cooldown all gate a final-review continuation exactly
	 * as they gate a live steer. The batch steers at most ONE continuation, only
	 * when a note qualifies on its own merits: its severity meets
	 * `advisor.continueSeverity` (the advisor continuation latch prevents a
	 * cascade). Otherwise preserves as a single visible card.
	 */
	#flushAdvisorBoundaryNotes(): void {
		if (this.#advisorBoundaryNotes.length === 0) return;
		// Newest turn first, then severity: the latest notes describe the current
		// state of the work; older ones may already be resolved by it.
		const notes = [...this.#advisorBoundaryNotes].sort(compareAdvisorNotes);
		this.#advisorBoundaryNotes = [];
		for (const n of notes) {
			if (n.turn !== undefined && this.#advisorPrimaryTurnsCompleted > n.turn) {
				n.turnsAgo = this.#advisorPrimaryTurnsCompleted - n.turn;
			}
		}
		const showGuidance =
			this.#advisorBoundaryGuidanceLastTurn === undefined ||
			this.#advisorPrimaryTurnsCompleted - this.#advisorBoundaryGuidanceLastTurn >= ADVISOR_BOUNDARY_GUIDANCE_TURNS;
		if (showGuidance) this.#advisorBoundaryGuidanceLastTurn = this.#advisorPrimaryTurnsCompleted;
		const batch = formatAdvisorBatchContent(notes, { currentTurn: this.#advisorPrimaryTurnsCompleted });
		const content = showGuidance ? `${ADVISOR_BOUNDARY_GUIDANCE}\n${batch}` : batch;
		this.#deliverAdvisorBatch(
			notes,
			content,
			notes.some(n => this.#continuesFinishedRun(n.severity)),
		);
	}

	/**
	 * Whether a note against a finished primary run may start one continuation:
	 * its severity meets `advisor.continueSeverity` (even when the tail is not a
	 * clean answer) and the shared delivery policy would steer it. `streaming` is
	 * forced false — the turn IS final even while the loop still reports
	 * streaming, so "steer" means triggering one latched continuation turn, never
	 * steering into the completed one; it also keeps user-stop suppression
	 * independent of the exact unwind state.
	 */
	#continuesFinishedRun(severity: AdvisorSeverity | undefined): boolean {
		const continueSeverity = cfgAdvisorContinueSeverity.get(this.#host.settings);
		if (!meetsAdvisorSeverity(severity, continueSeverity)) return false;
		const channel = resolveAdvisorDeliveryChannel({
			severity,
			continueSeverity,
			autoResumeSuppressed: this.#advisorAutoResumeSuppressed,
			preserveOnly: this.#preserveAdvisorAdvice,
			streaming: false,
			aborting: this.#host.abortInProgress(),
			terminalAnswerNoQueuedWork: this.#hasTerminalTextAnswerWithoutQueuedWork(),
			interruptImmuneTurnActive: this.#isAdvisorInterruptImmuneTurnActive(),
		});
		return channel === "steer";
	}

	/**
	 * Deliver one advisor batch as a steer, or as a visible card when steering
	 * is technically impossible. A steered batch only continues the run when the
	 * session can actually start (or is already running) a turn. One idle case
	 * cannot, so `sendCustomMessage({ triggerTurn: true })` would silently bury
	 * the card in `#pendingNextTurnMessages` until the next user prompt —
	 * strictly worse than the visible preserved card. Preserve instead:
	 *  - ACP bridges with `deferAgentInitiatedTurns`: the client cannot show an
	 *    agent-initiated turn as busy, so idle triggers are refused (#5628 review).
	 */
	#deliverAdvisorBatch(notes: AdvisorNote[], content: string, steer: boolean): void {
		const details = { notes } satisfies AdvisorMessageDetails;
		if (steer) {
			// Plan mode preserves would-be-steering advice as a visible card:
			// only user-driven turns converge on ask/resolve.
			const planModePreservesAdvice = this.#host.planModeState()?.enabled === true;
			const cannotAutoTrigger =
				!this.#host.agent.state.isStreaming &&
				this.#host.clientBridge()?.deferAgentInitiatedTurns === true &&
				!this.#host.allowAgentInitiatedTurns();
			if (!planModePreservesAdvice && !cannotAutoTrigger) {
				// Arm the post-interrupt immune window only now that a turn is actually
				// being steered/triggered. A merely preserved card never interrupts, so
				// arming earlier would downgrade the next `advisor.immuneTurns` worth of
				// real concerns/blockers to skip-idle-flush asides (#5628 review).
				this.#recordAdvisorInterruptDelivered();
				// A steer into a run still working only redirects it; one delivered
				// while idle or past a terminal boundary starts the continuation
				// that must not schedule another review.
				if (!this.#host.agent.state.isStreaming || this.#terminalUnwindActive) {
					this.#advisorContinuation = { userMessage: lastPrimaryUserMessage(this.#host.agent.state.messages) };
				}
				void this.#host
					.sendCustomMessage(
						{ customType: "advisor", content, display: true, attribution: "agent", details },
						{ deliverAs: "steer", triggerTurn: true },
					)
					.catch(err => logger.debug("advisor delivery failed", { err: String(err) }));
				return;
			}
		}
		this.#host.preserveAdvisorCard({
			role: "custom",
			customType: "advisor",
			content,
			display: true,
			attribution: "agent",
			details,
			timestamp: Date.now(),
		});
	}

	/** Re-prime every advisor's transcript view after an in-conversation history rewrite. */
	#resetAllAdvisorRuntimes(reason: string | undefined, _compacted: boolean): void {
		for (const a of this.#advisors) {
			a.runtime.reset(reason);
			// Match the conversation-boundary re-prime: a reset must not carry a
			// pending wait's provider-block budget into the reset conversation.
			this.#resetRecoveryBudgets(a);
		}
	}

	#stopAdvisorRuntime(): void {
		// Detach each recorder feed BEFORE aborting its advisor agent: dispose() aborts
		// the loop, and an abort emits a final `message_end` we must not enqueue against
		// a closing recorder (it would reopen and resurrect an already-released file).
		const closes: Promise<void>[] = [];
		for (const a of this.#advisors) {
			a.agentUnsubscribe?.();
			a.agentUnsubscribe = undefined;
			a.runtime.dispose();
			// Capture each close so dispose()/`/delete` can await the queued open+append+close —
			// the last advisor turn would otherwise be lost on a fast process exit.
			a.recorderClosed = a.recorder.close();
			closes.push(a.recorderClosed);
		}
		this.#advisorRecorderClosed = Promise.all(closes).then(() => {});
		this.#advisors = [];
		this.#advisorYieldQueueUnsubscribe?.();
		this.#advisorYieldQueueUnsubscribe = undefined;
	}

	#recordAdvisorCost(advisor: ActiveAdvisor, message: AssistantMessage): void {
		const cost = message.usage.cost.total;
		this.#advisorCosts.set(advisor.slug, (this.#advisorCosts.get(advisor.slug) ?? 0) + cost);
	}

	/** Subscribe the advisor agent's finalized messages into the transcript recorder.
	 *  Idempotent-by-replacement: callers detach the prior feed first. Kept separate
	 *  so the re-prime path can mute the feed across an abort-driven reset. */
	#attachAdvisorRecorderFeed(advisor: ActiveAdvisor): void {
		advisor.agentUnsubscribe = advisor.agent.subscribe(event => {
			if (event.type !== "message_end") return;
			if (event.message.role === "assistant") this.#recordAdvisorCost(advisor, event.message);
			advisor.recorder.record(event.message);
		});
	}

	/** Advisors always share the primary session's explicit effort. */
	#primaryThinkingLevel(): ThinkingLevel {
		if (this.#host.agent.state.disableReasoning) return ThinkingLevel.Off;
		return this.#host.agent.state.thinkingLevel ?? ThinkingLevel.Inherit;
	}

	#retuneAdvisorThinkingLevels(): void {
		const requested = this.#primaryThinkingLevel();
		for (const advisor of this.#advisors) {
			if (advisor.runtime.disposed) continue;
			const next = resolveThinkingLevelForModel(advisor.model, requested) ?? ThinkingLevel.Inherit;
			if (next === advisor.thinkingLevel) continue;
			advisor.agent.setThinkingLevel(toReasoningEffort(next));
			advisor.agent.setDisableReasoning(shouldDisableReasoning(next));
			advisor.thinkingLevel = next;
		}
	}

	/** Retry with credentials for this same model, or wait for its provider. */
	async #recoverAdvisorTurn(
		advisor: ActiveAdvisor,
		error: unknown,
		failedMessages: readonly AgentMessage[],
		signal: AbortSignal,
	): Promise<boolean> {
		if (error instanceof AdvisorOutputQuarantinedError) return false;

		const failedMessage = failedMessages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		const assistantFailure = failedMessage?.stopReason === "error" ? failedMessage : undefined;
		if (assistantFailure?.content.some(block => block.type === "toolCall")) return false;

		const currentModel = advisor.agent.state.model;
		if (!currentModel) return false;
		const message = assistantFailure?.errorMessage ?? (error instanceof Error ? error.message : String(error));
		const errorId = assistantFailure
			? AIError.classifyMessage({
					api: currentModel.api,
					errorId: assistantFailure.errorId,
					errorMessage: message,
					errorStatus: assistantFailure.errorStatus,
				})
			: AIError.classify(error, currentModel.api);
		if (AIError.is(errorId, AIError.Flag.Abort) || AIError.is(errorId, AIError.Flag.UserInterrupt)) return false;
		// Text-ambiguous overflows waive the veto; usage-backed do not — see AIError.isTextAmbiguousContextOverflow (#9235).
		const contextWindow = currentModel.contextWindow ?? 0;
		const overflowVeto =
			(AIError.is(errorId, AIError.Flag.ContextOverflow) ||
				(assistantFailure !== undefined && AIError.isContextOverflow(assistantFailure, contextWindow))) &&
			!AIError.isTextAmbiguousContextOverflow(errorId, assistantFailure, contextWindow);
		if (overflowVeto) {
			return false;
		}

		const retryAfterMs = extractProviderRetryHint(currentModel.provider, message);
		const usageLimit = AIError.is(errorId, AIError.Flag.UsageLimit);
		const timedRateLimit = !usageLimit && retryAfterMs !== undefined && AIError.is(errorId, AIError.Flag.Transient);
		if (!usageLimit && !timedRateLimit) return false;

		const retrySettings = cfgRetry.get(this.#host.settings);
		return this.#waitOutAdvisorProviderBlock(advisor, retrySettings, usageLimit, { retryAfterMs }, signal);
	}

	/** Start the next failing batch with a fresh provider-wait budget. */
	#resetRecoveryBudgets(advisor: ActiveAdvisor): void {
		advisor.providerWaitRetries = 0;
	}

	/**
	 * Wait out a transient provider block (usage limit or timed rate limit) and
	 * signal a retry, or decline. A declined usage limit latches
	 * {@link AdvisorRuntime}'s quota state; a declined rate limit falls to the
	 * runtime's generic 3-strike retry, so its spent budget is kept until the
	 * batch succeeds or is abandoned. See {@link planAdvisorUsageLimitWait} for
	 * the wait-vs-decline decision; the wait is abortable via `signal`
	 * (reset/dispose/session transition).
	 */
	async #waitOutAdvisorProviderBlock(
		advisor: ActiveAdvisor,
		retry: { enabled: boolean; baseDelayMs: number; maxDelayMs: number; maxRetries: number },
		latchesOnDecline: boolean,
		timing: { retryAfterMs?: number },
		signal: AbortSignal,
	): Promise<boolean> {
		const waitMs = planAdvisorUsageLimitWait({
			retryAfterMs: timing.retryAfterMs,
			retry,
			attempt: advisor.providerWaitRetries,
		});
		if (waitMs === undefined) {
			// A wait past retry.maxDelayMs or an exhausted budget. A latching usage
			// limit resets the counter so a fresh episode after a reset starts over.
			// A rate limit keeps it spent: resetting would grant a new budget on the
			// runtime's next retry and the batch would never be dropped.
			if (latchesOnDecline) advisor.providerWaitRetries = 0;
			return false;
		}
		const attempt = advisor.providerWaitRetries + 1;
		logger.debug("advisor waiting out provider block", {
			advisor: advisor.name,
			waitMs,
			attempt,
		});
		await scheduler.wait(waitMs, { signal });
		// An aborted pause/reset did not reach a provider retry and must not
		// consume budget in the resumed/reset conversation.
		advisor.providerWaitRetries = attempt;
		return true;
	}

	async #maintainAdvisorContext(
		advisor: ActiveAdvisor,
		incoming: AgentMessage,
		signal: AbortSignal,
	): Promise<boolean> {
		const agent = advisor.agent;
		// Prior reviews' `read`/`grep`/`glob` output is re-sent on every later
		// request; the deltas the advisor reviews and the notes it wrote (carried
		// in `advise` tool-call arguments) are never touched, and the latest review
		// is kept intact. Runs before the compaction gate because it is the
		// advisor's own context hygiene, not a compaction method; it has its own
		// `advisor.evictStaleResults` switch.
		//
		// On a prefix-bound thinking model the `prunedAt` marker also drops the
		// signed thinking of every assistant after the cut, the latest review
		// included. What is lost is reasoning its notes and the deltas already
		// cover.
		if (cfgAdvisorEvictStaleResults.get(this.#host.settings)) {
			const eviction = evictStaleToolResults(agent.state.messages, agent.tokenizer);
			if (eviction.evicted > 0) {
				logger.debug("advisor evicted stale tool results", {
					advisor: advisor.name,
					evicted: eviction.evicted,
					tokensSaved: eviction.tokensSaved,
				});
			}
		}
		const incomingTokens = agent.tokenizer.countMessage(incoming);

		const configuredCompaction = cfgCompaction.get(this.#host.settings);
		const methods = resolveCompactionMethodOrder(configuredCompaction.methodOrder);
		if (!configuredCompaction.enabled || methods.length === 0) {
			return false;
		}
		const compactionMethod = "soft";
		const advisorModel = agent.state.model;
		if (!advisorModel) return false;
		const compactionSettings = resolveMethodSettings(
			resolveModelCompactionSettings(this.#host.settings, advisorModel),
			compactionMethod,
		);
		const contextWindow = advisorModel.contextWindow ?? 0;
		if (contextWindow <= 0) return false;

		const messages = agent.state.messages;
		const storedConversationTokens = agent.tokenizer.countMessages(messages, { excludeEncryptedReasoning: true });
		// Provider usage (including cache reads and generated output) is the
		// trustworthy anchor for accumulated context. Add only the trailing incoming
		// delta to that arm. Floor it by a full local estimate — fixed advisor system
		// prompt, tool schemas, stored messages, and incoming delta — so provider
		// under-reporting or payload transforms cannot suppress maintenance.
		const providerContextTokens = this.#estimateAdvisorContextTokens(advisor) + incomingTokens;
		const fixedPromptTokens = agent.tokenizer.countTokens(agent.state.systemPrompt);
		const contextTokensFor = (model: Model): number =>
			compactionContextTokens(
				providerContextTokens,
				fixedPromptTokens +
					estimateToolSchemaTokens(agent.state.tools, agent.tokenizer, {
						sourceRevision: this.#host.settings.revision,
						pruneDescriptions: agent.prunesToolDescriptions(model),
					}) +
					storedConversationTokens +
					incomingTokens,
			);
		const contextTokens = contextTokensFor(advisorModel);

		if (!shouldCompact(contextTokens, contextWindow, compactionSettings)) {
			return false;
		}

		const pathEntries: SessionEntry[] = messages.map((message, i) => {
			const id = `msg-${i}`;
			const parentId = i > 0 ? `msg-${i - 1}` : null;
			const timestamp = String(message.timestamp || Date.now());

			if (message.role === "compactionSummary") {
				const advisorSummary = message as AdvisorCompactionSummaryMessage;
				return {
					type: "compaction",
					id,
					parentId,
					// ISO like every CompactionEntry: the next round reads this
					// back as previousSummaryTimestamp (the reused rewrite marker),
					// and a millis string does not survive `new Date()` (NaN marker).
					timestamp: new Date(message.historyRewriteAt ?? (message.timestamp || Date.now())).toISOString(),
					summary: message.summary,
					shortSummary: message.shortSummary,
					firstKeptEntryId: advisorSummary.firstKeptEntryId || `msg-${i + 1}`,
					tokensBefore: message.tokensBefore,
					preserveData: advisorSummary.preserveData,
				} satisfies CompactionEntry;
			}

			return {
				type: "message",
				id,
				parentId,
				timestamp,
				message,
			} satisfies SessionMessageEntry;
		});

		const advisorProviderSessionId = this.#advisorProviderSessionId(advisor.slug);
		const preparation = prepareCompaction(pathEntries, compactionSettings, advisorModel, agent.tokenizer);
		if (!preparation) return true;
		const apiKey = await this.#host.modelRegistry.getApiKey(advisorModel, advisorProviderSessionId, { signal });
		if (!apiKey) return true;
		let compactResult: CompactionResult;
		try {
			compactResult = await compact(
				preparation,
				advisorModel,
				this.#host.modelRegistry.resolver(advisorModel, advisorProviderSessionId),
				undefined,
				signal,
				{
					thinkingLevel: agent.state.disableReasoning ? ThinkingLevel.Off : agent.state.thinkingLevel,
					convertToLlm: messages => this.#host.convertToLlmForSideRequest(messages),
					telemetry: resolveTelemetry(agent.telemetry, advisorProviderSessionId),
					sessionId: advisorProviderSessionId,
					promptCacheKey: this.#host.agent.promptCacheKey,
					metadata: advisorProviderSessionId ? buildSessionMetadata(advisorProviderSessionId) : undefined,
					completeImpl: async (model, context, options) => {
						const stream = await (this.#advisorStreamFn ?? streamSimple)(model, context, options);
						return stream.result();
					},
				},
			);
		} catch (error) {
			if (signal.aborted) throw error;
			logger.warn("Advisor compaction failed, falling back to re-prime", { error: String(error) });
			return true;
		}

		const summary = compactResult.summary;
		const shortSummary = compactResult.shortSummary;
		const firstKeptEntryId = compactResult.firstKeptEntryId;
		const tokensBefore = compactResult.tokensBefore;
		const recentMessages = preparation.recentMessages;

		// The retained messages still carry provider usage from before this
		// compaction. Record their exact array boundary on the in-memory summary so
		// only assistants appended afterward can become the next usage anchor.
		const advisorUsageAnchorStartIndex = recentMessages.length + 1;
		const summaryMessage = {
			...createCompactionSummaryMessage(summary, tokensBefore, new Date().toISOString(), {
				shortSummary,
			}),
			firstKeptEntryId,
			advisorUsageAnchorStartIndex,
			preserveData: compactResult.preserveData,
		} satisfies AdvisorCompactionSummaryMessage;

		agent.replaceMessages([summaryMessage, ...recentMessages]);
		return false;
	}
	/**
	 * Prevent advisor notes from starting hidden primary turns while a headless
	 * caller prints and drains the final primary response, and send each
	 * advisor's cadence-held updates so the drain reviews a final yield the
	 * review cadence skipped.
	 */
	prepareForHeadlessAdvisorDrain(): void {
		this.#preserveAdvisorAdvice = true;
		for (const advisor of this.#advisors) advisor.runtime.flushHeld();
	}

	/** Preserve advisor output for a terminal yield whose loop is unwinding. */
	prepareForTerminalYieldAdvisorDrain(): void {
		this.#preserveAdvisorAdvice = true;
		this.#preserveTerminalYieldAdvice = true;
	}

	/** Clear terminal-unwind delivery when a new primary run starts. */
	onPrimaryAgentStart(): void {
		this.#terminalUnwindActive = false;
	}

	/** Restore normal advisor routing when the primary starts or continues work. */
	onPrimaryTurnStart(): void {
		this.#terminalUnwindActive = false;
		if (!this.#preserveTerminalYieldAdvice) return;
		this.#preserveTerminalYieldAdvice = false;
		this.#preserveAdvisorAdvice = false;
	}

	async #waitForPendingAdvisorCardEvents(timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + Math.max(0, timeoutMs);
		while (this.#pendingAdvisorCardEvents.size > 0) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) return false;
			const settled = Promise.allSettled(this.#pendingAdvisorCardEvents).then(() => true as const);
			const { promise: timedOut, resolve } = Promise.withResolvers<false>();
			const timer = setTimeout(() => resolve(false), remainingMs);
			try {
				if (!(await Promise.race([settled, timedOut]))) return false;
			} finally {
				clearTimeout(timer);
			}
		}
		return true;
	}

	/**
	 * Wait for active advisor reviews and their emitted card events before a
	 * headless caller disposes the session. Returns `false` and logs work disposal
	 * will abandon when the shared deadline expires or an advisor stops for good
	 * (halt, quota pause). A failing advisor releases the drain at once unless
	 * `waitThroughRecovery` is set: then its retry and fallback-chain recovery is
	 * waited through instead of being abandoned mid-switch. With
	 * `strictWithoutDeadline`, an advisor whose catch-up policy is `strict` is
	 * waited on without the deadline, as at every primary boundary, and its card
	 * events then get a full `timeoutMs` of their own. Callers bound by a hard
	 * teardown deadline (subagent cleanup) leave it unset.
	 */
	async waitForAdvisorCatchup(timeoutMs: number, options?: AdvisorCatchupOptions): Promise<boolean> {
		let deadline = Date.now() + timeoutMs;
		const globalSyncBacklog = cfgAdvisorSyncBacklog.get(this.#host.settings);
		const strict = this.#advisors.map(
			advisor => options?.strictWithoutDeadline === true && (advisor.syncBacklog ?? globalSyncBacklog) === "strict",
		);
		const results = await Promise.all(
			this.#advisors.map((advisor, index) =>
				advisor.runtime.waitForCatchup(strict[index] ? undefined : timeoutMs, 1, undefined, options),
			),
		);
		if (strict.includes(true)) deadline = Math.max(deadline, Date.now() + timeoutMs);
		const cardEventsCaughtUp = await this.#waitForPendingAdvisorCardEvents(Math.max(0, deadline - Date.now()));
		const abandoned = this.#advisors.filter(
			(advisor, index) => results[index] === false && advisor.runtime.backlog > 0,
		);
		if (abandoned.length > 0 || !cardEventsCaughtUp) {
			logger.warn("advisor shutdown drain incomplete; disposal will abandon reviews or cards", {
				timeoutMs,
				advisors: abandoned.map(advisor => ({ name: advisor.name, backlog: advisor.runtime.backlog })),
				pendingAdvisorCards: this.#pendingAdvisorCardEvents.size,
			});
			return false;
		}
		return true;
	}
	/**
	 * Enable or disable the advisor for this session. The setting is overridden for the session,
	 * and the runtime is started or stopped to match.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	setAdvisorEnabled(enabled: boolean): boolean {
		this.#advisorEnabled = enabled;
		if (enabled) {
			if (this.#advisors.length > 0 && !this.#advisorRuntimeMatchesCurrentConfig()) {
				return this.#rebuildAdvisorRuntime();
			}
			return this.#buildAdvisorRuntime(true);
		}
		this.#stopAdvisorRuntime();
		return false;
	}

	/**
	 * Toggle the advisor setting and start/stop the runtime accordingly.
	 *
	 * @returns true when the advisor is actively running after the call.
	 */
	toggleAdvisorEnabled(): boolean {
		return this.setAdvisorEnabled(!this.#advisorEnabled);
	}

	/**
	 * WATCHDOG.yml problems found during startup discovery (dropped entries,
	 * unparseable files). Pulled by the interactive mode AFTER the UI subscribes
	 * to session events — a constructor-time `emitNotice` would fire before any
	 * listener exists and be lost.
	 */
	get configWarnings(): readonly string[] {
		return this.#advisorConfigWarnings;
	}

	/**
	 * Replace the live advisor roster from an edited `WATCHDOG.yml` (the `/advisor
	 * configure` save path). Swaps the configs + shared baseline, then rebuilds the
	 * runtimes in place so the change applies without a restart. When the advisor is
	 * disabled the new configs are simply stored for the next enable.
	 *
	 * @returns the number of advisors active after the rebuild.
	 */
	applyAdvisorConfigs(
		advisors: AdvisorConfig[],
		sharedInstructions: string | undefined,
		sharedMaxNotesPerUpdate?: number,
	): number {
		this.#advisorConfigs = advisors;
		this.#advisorSharedInstructions = sharedInstructions;
		this.#advisorSharedMaxNotesPerUpdate = sharedMaxNotesPerUpdate;
		this.#rebuildAdvisorRuntime();
		return this.#advisors.length;
	}

	/**
	 * Swap the project context prompt handed to advisor sessions after context
	 * files change (`/reload-plugins` edit/disable). Rebuilds live runtimes in
	 * place so the next advisor turn evaluates against the current instructions;
	 * a no-op when the rendered prompt is unchanged.
	 */
	setContextPrompt(contextPrompt: string | undefined): void {
		if (contextPrompt === this.#advisorContextPrompt) return;
		this.#advisorContextPrompt = contextPrompt;
		if (!this.#advisorEnabled || this.#advisors.length === 0) return;
		this.#rebuildAdvisorRuntime();
	}

	/**
	 * Whether the advisor setting is enabled for this session.
	 */
	isAdvisorEnabled(): boolean {
		return this.#advisorEnabled;
	}

	/**
	 * Whether a live advisor agent is attached to this session. True only when
	 * `advisor.enabled` is set for this session (subagents opt in per agent via
	 * frontmatter `advisor` / `task.agentAdvisor`) AND a model resolved for the
	 * `advisor` role — i.e. the actual runtime exists, not merely the setting.
	 * Drives the status-line badge and `/dump advisor`.
	 */
	isAdvisorActive(): boolean {
		return this.#advisors.length > 0;
	}

	/**
	 * The names of the tools available to advisors this session (the pool a
	 * `/advisor configure` editor lists). The advisor is a full agent, so this is the
	 * full built tool set; a tool whose optional factory returns null (e.g. lsp with
	 * no servers) is absent.
	 */
	getAdvisorAvailableToolNames(): string[] {
		return (this.#advisorTools ?? []).map(tool => tool.name);
	}

	/**
	 * The live advisor `Agent`, or `undefined` when no advisor runtime is
	 * attached. Surfaced for diagnostics (`/dump advisor` already serializes
	 * its transcript via {@link formatAdvisorHistoryAsText}) and so callers can
	 * verify the advisor inherits the session's provider-shaping options
	 * (`streamFn`, `promptCacheKey`, `providerSessionState`, ...).
	 */
	getAdvisorAgent(): Agent | undefined {
		return this.#advisors[0]?.agent;
	}

	/**
	 * Lightweight advisor status for the status line and pause screen: the
	 * configured flag and each advisor's status, yield and pause state, and review backlog.
	 * Avoids re-tokenizing the advisor transcript on every render frame.
	 */
	getAdvisorStatusOverview(): { configured: boolean; advisors: AdvisorStatusOverviewEntry[] } {
		// Override stale map entries with live runtime status: failureNotified/quotaExhausted
		// clear on reset() but #advisorStatuses lags until the next build.
		const liveStatusBySlug = new Map<
			string,
			{ status: AdvisorRuntimeStatus; yielded: boolean; canReview: boolean; backlog: number; isPaused: boolean }
		>();
		for (const a of this.#advisors) {
			liveStatusBySlug.set(a.slug, {
				status: a.runtime.quotaExhausted ? "quota_exhausted" : a.runtime.failureNotified ? "error" : "running",
				backlog: a.runtime.backlog,
				yielded: a.runtime.yielded,
				canReview: !a.runtime.quotaExhausted && !a.runtime.halted && !a.runtime.disposed,
				isPaused: a.agent.isPaused,
			});
		}
		const advisors = [...this.#advisorStatuses.entries()].map(([slug, { name, status }]) => {
			const live = liveStatusBySlug.get(slug);
			return {
				name,
				status: live?.status ?? status,
				backlog: live?.backlog ?? 0,
				isPaused: live?.isPaused ?? false,
				// The eye only closes after the primary itself has yielded: while it
				// is streaming, an advisor that can still accept review work may
				// receive (and comment on) new deltas even when its backlog is
				// empty. Advisors that cannot accept work — no live runtime
				// (paused/no-model) or a quota-exhausted/halted runtime — stay
				// yielded regardless of the primary's stream state.
				yielded: live?.canReview && this.#host.agent.state.isStreaming ? false : (live?.yielded ?? true),
			};
		});
		return { configured: this.#advisorEnabled, advisors };
	}

	/** Return cumulative advisor cost recorded for the current session. */
	getAdvisorCost(): number {
		let cost = 0;
		for (const advisorCost of this.#advisorCosts.values()) cost += advisorCost;
		return cost;
	}
	/**
	 * Return structured advisor stats for the status command and TUI panel.
	 */
	getAdvisorStats(): AdvisorStats {
		const configured = this.#advisorEnabled;
		const liveAdvisors = this.#advisors.map(a => this.#computeAdvisorStat(a));
		// Build the complete roster from #advisorStatuses, which already has the
		// correct de-duped slugs as keys. Live advisors (from #advisors) carry full
		// token/cost data; disabled/no-model/quota-exhausted advisors appear as
		// skeleton entries with just name + status so the status line renders a dot.
		const liveStatBySlug = new Map(this.#advisors.map((a, i) => [a.slug, liveAdvisors[i]]));
		const roster: PerAdvisorStat[] = [];
		for (const [slug, entry] of this.#advisorStatuses) {
			const live = liveStatBySlug.get(slug);
			if (live) {
				roster.push(live);
			} else {
				roster.push({
					name: entry.name,
					status: entry.status,
					contextWindow: 0,
					contextTokens: 0,
					tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: this.#advisorCosts.get(slug) ?? 0,
					messages: { user: 0, assistant: 0, total: 0 },
				});
			}
		}
		const active = liveAdvisors.length > 0;
		const cost = this.getAdvisorCost();
		if (liveAdvisors.length === 0) {
			return {
				configured,
				active,
				contextWindow: 0,
				contextTokens: 0,
				tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost,
				messages: { user: 0, assistant: 0, total: 0 },
				advisors: roster,
			};
		}
		const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const messages = { user: 0, assistant: 0, total: 0 };
		let contextTokens = 0;
		for (const a of liveAdvisors) {
			tokens.input += a.tokens.input;
			tokens.output += a.tokens.output;
			tokens.reasoning += a.tokens.reasoning;
			tokens.cacheRead += a.tokens.cacheRead;
			tokens.cacheWrite += a.tokens.cacheWrite;
			tokens.total += a.tokens.total;
			messages.user += a.messages.user;
			messages.assistant += a.messages.assistant;
			messages.total += a.messages.total;
			contextTokens += a.contextTokens;
		}
		// Single-advisor displays read the top-level model/window directly; surface the
		// first advisor's so the legacy status line stays byte-identical.
		return {
			configured,
			active,
			model: liveAdvisors[0].model,
			contextWindow: liveAdvisors[0].contextWindow,
			contextTokens,
			tokens,
			cost,
			messages,
			advisors: roster,
		};
	}

	/** Compute one advisor's stats slice (tokens, cost, context, message counts). */
	#computeAdvisorStat(advisor: ActiveAdvisor): PerAdvisorStat {
		const model = advisor.agent.state.model;
		const messages = advisor.agent.state.messages;
		const contextTokens = this.#estimateAdvisorContextTokens(advisor);
		let input = 0;
		let output = 0;
		let reasoning = 0;
		let cacheRead = 0;
		let cacheWrite = 0;
		let totalTokens = 0;
		let user = 0;
		let assistant = 0;
		for (const message of messages) {
			if (message.role === "user") user++;
			if (message.role === "assistant") {
				assistant++;
				const assistantMsg = message as AssistantMessage;
				input += assistantMsg.usage.input;
				output += assistantMsg.usage.output;
				reasoning += assistantMsg.usage.reasoningTokens ?? 0;
				cacheRead += assistantMsg.usage.cacheRead;
				cacheWrite += assistantMsg.usage.cacheWrite;
				totalTokens += assistantMsg.usage.totalTokens;
			}
		}
		return {
			name: advisor.name,
			status: advisor.runtime.quotaExhausted
				? "quota_exhausted"
				: advisor.runtime.failureNotified
					? "error"
					: "running",
			model,
			contextWindow: model?.contextWindow ?? 0,
			contextTokens,
			tokens: { input, output, reasoning, cacheRead, cacheWrite, total: totalTokens },
			cost: this.#advisorCosts.get(advisor.slug) ?? 0,
			messages: { user, assistant, total: messages.length },
			sessionId: advisor.agent.sessionId,
		};
	}

	/**
	 * Format a concise advisor status line for ACP/text output.
	 */
	formatAdvisorStatus(): string {
		const stats = this.getAdvisorStats();
		if (!stats.active && stats.advisors.length === 0) {
			return stats.configured
				? "Advisor setting is enabled, but the session has no selected model."
				: "Advisor is disabled.";
		}
		if (stats.advisors.length <= 1) {
			const s = stats.advisors[0];
			if (s && s.status === "no_model") {
				return stats.configured
					? "Advisor setting is enabled, but the session has no selected model."
					: "Advisor is disabled.";
			}
			const contextLine =
				s.contextWindow > 0
					? `Context: ${s.contextTokens.toLocaleString()} / ${s.contextWindow.toLocaleString()} tokens (${Math.round((s.contextTokens / s.contextWindow) * 100)}%)`
					: `Context: ${s.contextTokens.toLocaleString()} tokens`;
			const spendParts = [`${s.tokens.input.toLocaleString()} input`, `${s.tokens.output.toLocaleString()} output`];
			if (s.tokens.cacheRead > 0) spendParts.push(`${s.tokens.cacheRead.toLocaleString()} cache read`);
			if (s.tokens.cacheWrite > 0) spendParts.push(`${s.tokens.cacheWrite.toLocaleString()} cache write`);
			const spendLine = `Spend: ${spendParts.join(", ")}, $${stats.cost.toFixed(4)}`;
			if (!s.model || s.status !== "running") return `Advisor "${s.name}" is ${s.status.replace("_", " ")}.`;
			return `Advisor is enabled (${s.model.provider}/${s.model.id}). ${contextLine}. ${spendLine}.`;
		}
		const lines = [`Advisors enabled (${stats.advisors.length}):`];
		for (const s of stats.advisors) {
			const ctx =
				s.contextWindow > 0
					? `${s.contextTokens.toLocaleString()} / ${s.contextWindow.toLocaleString()} (${Math.round((s.contextTokens / s.contextWindow) * 100)}%)`
					: `${s.contextTokens.toLocaleString()}`;
			lines.push(
				`  • ${s.name}${s.model && s.status === "running" ? ` (${s.model.provider}/${s.model.id})` : ` [${s.status}]`} — context ${ctx} tokens, $${s.cost.toFixed(4)}`,
			);
		}
		lines.push(
			`Totals: ${stats.tokens.input.toLocaleString()} input, ${stats.tokens.output.toLocaleString()} output, $${stats.cost.toFixed(4)}.`,
		);
		return lines.join("\n");
	}

	/**
	 * Estimate the advisor's current context tokens. A successful provider usage
	 * after the latest advisor compaction is ground truth for the prompt plus its
	 * generated output; only messages after that anchor are estimated. Usage from
	 * retained pre-compaction messages is stale and must not immediately retrigger
	 * maintenance on the newly compacted context.
	 * Usage reported before the newest tool-result eviction is stale the same way.
	 */
	#estimateAdvisorContextTokens(advisor: ActiveAdvisor): number {
		const messages = advisor.agent.state.messages;
		return estimateTranscriptTokens(messages, advisor.agent.tokenizer, {
			anchorFromIndex: advisorAnchorSearchStart(messages),
			// Evicted tool results were rewritten in place; usage reported before
			// the newest eviction still counts the removed bytes.
			skipPrunedAnchors: true,
			excludeEncryptedReasoning: true,
		});
	}

	/**
	 * Format the advisor agent's own transcript (its system prompt, config,
	 * tools, and the markdown deltas it received plus its thinking/advise/read
	 * calls) as plain text — the advisor-side equivalent of
	 * {@link formatSessionAsText}. Returns null when no advisor is active.
	 */
	formatAdvisorHistoryAsText(options?: { compact?: boolean }): string | null {
		if (this.#advisors.length === 0) return null;
		const dump = (a: ActiveAdvisor): string =>
			options?.compact
				? formatSessionHistoryMarkdown(a.agent.state.messages)
				: formatSessionDumpText({
						messages: a.agent.state.messages,
						systemPrompt: a.agent.state.systemPrompt,
						model: a.agent.state.model,
						thinkingLevel: a.agent.state.thinkingLevel,
						tools: a.agent.state.tools,
					});
		if (this.#advisors.length === 1) return dump(this.#advisors[0]);
		return this.#advisors
			.map(
				a =>
					`### Advisor: ${a.name} (${a.agent.state.model ? formatModelString(a.agent.state.model) : "unconfigured"})\n\n${dump(a)}`,
			)
			.join("\n\n");
	}
}
