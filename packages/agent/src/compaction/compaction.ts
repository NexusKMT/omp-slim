/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import {
	type Api,
	type ApiKey,
	type AssistantMessage,
	type Context,
	Effort,
	type FetchImpl,
	type Message,
	type MessageAttribution,
	type Model,
	type OneshotRetryOptions,
	type SimpleStreamOptions,
	type Usage,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isSurvivingAssistant } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { type AgentTelemetry, instrumentedCompleteSimple } from "../telemetry";
import { ThinkingLevel } from "../thinking";
import { Tokenizer } from "../tokenizer";
import type { AgentMessage } from "../types";
import type { CompactionEntry, SessionEntry } from "./entries";
import {
	type ConvertToLlm,
	createCompactionSummaryMessage,
	defaultConvertToLlm,
	getMessageFromEntry,
} from "./messages";
import autoHandoffThresholdFocusPrompt from "./prompts/auto-handoff-threshold-focus.md" with { type: "text" };
import compactionShortSummaryPrompt from "./prompts/compaction-short-summary.md" with { type: "text" };
import compactionSummaryPrompt from "./prompts/compaction-summary.md" with { type: "text" };
import compactionTurnPrefixPrompt from "./prompts/compaction-turn-prefix.md" with { type: "text" };
import compactionUpdateSummaryPrompt from "./prompts/compaction-update-summary.md" with { type: "text" };
import handoffDocumentPrompt from "./prompts/handoff-document.md" with { type: "text" };
import snapcompactArchiveContextPrompt from "./prompts/snapcompact-archive-context.md" with { type: "text" };

import {
	escapeSummaryBoundaryTags,
	extractFileOpsFromMessage,
	incompleteOutputError,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversationForSummary,
	stripReadSelector,
} from "./utils";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for file tracking */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): snapcompact.FileOperations {
	const fileOps = snapcompact.createFileOps();

	// Collect from previous compaction's details (if pi-generated)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromExtension && prevCompaction.details) {
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(stripReadSelector(f));
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	/** Short PR-style summary for display purposes. */
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Hook-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
	/** Hook-provided data to persist alongside compaction entry. */
	preserveData?: Record<string, unknown>;
	/**
	 * Last entry the provider-native replay history covers. Set when a remote
	 * compaction could only fit the history before the kept tail; later entries
	 * replay normally after the native history.
	 */
	providerReplayThroughEntryId?: string;
}

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	strategy?: "context-full" | "handoff" | "shake" | "snapcompact" | "off";
	thresholdPercent?: number;
	thresholdTokens?: number;
	/**
	 * Stands in for the context window when the percentage or reserve-based
	 * threshold is computed (when `> 0` and smaller than the window); a positive
	 * `thresholdTokens` still wins and is checked against the real window (at
	 * or past it, the window less its reserve applies). Set by per-model
	 * compaction limits; request and overflow budgets keep the real window.
	 */
	baseWindowTokens?: number;
	midTurnEnabled?: boolean;
	/**
	 * Tokens reserved below the context window for the next prompt + response.
	 *
	 * Leave unset to use {@link DEFAULT_RESERVE_TOKENS}; the unset state is the
	 * provenance signal that lets small-window recovery replace the default with
	 * a proportional reserve (see {@link resolveBudgetReserveTokens}). An
	 * explicit value — even one equal to the default — is always honored.
	 */
	reserveTokens?: number;
	keepRecentTokens: number;
	autoContinue?: boolean;
}

/** Reserve applied when {@link CompactionSettings.reserveTokens} is unset. */
export const DEFAULT_RESERVE_TOKENS = 16384;

/**
 * Hysteresis band under the compaction trigger. Maintenance counts as having
 * resolved threshold pressure only when residual context lands at or below
 * `COMPACTION_RECOVERY_BAND × threshold`. Re-checking against the raw threshold
 * lets a pass keep reclaiming a trickle of the previous turn's output and land
 * just under the line every turn, sustaining the auto-continue dead loop
 * reported in #2275; the same band stops the context-full / snapcompact tail
 * from re-firing on a history whose single most-recent kept turn already
 * exceeds the threshold. {@link prepareCompaction} sizes the kept tail to land
 * inside it.
 */
export const COMPACTION_RECOVERY_BAND = 0.8;

/**
 * Hard ceiling on a generated compaction summary.
 *
 * The summary budget is `floor(0.8 * reserveTokens)`, and the effective reserve is
 * at least 15% of the declared context window, so a 1M-token window authorizes a
 * ~120k-token summary. At that size the model copies rather than compresses, and
 * output is the slowest and most expensive token class. Capping absolutely keeps
 * the compression ratio improving with window size instead of degrading. The value
 * mirrors {@link DEFAULT_RESERVE_TOKENS} so this adds no new tuning constant.
 */
export const MAX_SUMMARY_TOKENS = DEFAULT_RESERVE_TOKENS;

// reserveTokens is deliberately absent: an unset reserve is what marks it as
// defaulted, which resolveBudgetReserveTokens needs to distinguish "user never
// chose a reserve" from "user explicitly configured the default value".
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	strategy: "context-full",
	thresholdPercent: -1,
	thresholdTokens: -1,
	midTurnEnabled: true,
	keepRecentTokens: 20000,
	autoContinue: true,
};

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Prefers an explicit provider-reported context occupancy when available.
 * Otherwise uses totalTokens and falls back to computing from billable
 * components. Provider-side orchestration tokens are billable but never replay
 * into the conversation prefix, so they are excluded from context sizing.
 */
export function calculateContextTokens(usage: Usage): number {
	if (usage.contextTokens !== undefined) {
		return Math.max(0, usage.contextTokens);
	}
	const orchestration = usage.orchestration;
	const orchestrationTotal = orchestration
		? (orchestration.input ?? 0) + (orchestration.output ?? 0) + (orchestration.cacheRead ?? 0)
		: 0;
	const raw = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return Math.max(0, raw - orchestrationTotal);
}

export function calculatePromptTokens(usage: Usage): number {
	if (usage.contextTokens !== undefined) {
		return Math.max(0, usage.contextTokens);
	}
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens > 0) {
		return promptTokens;
	}
	return calculateContextTokens(usage);
}

export function hasContextTokenUsage(usage: Usage): boolean {
	return (
		(usage.contextTokens ?? 0) > 0 ||
		usage.input + usage.cacheRead + usage.cacheWrite > 0 ||
		calculateContextTokens(usage) > usage.output
	);
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

/**
 * Effective reserve: at least 15% of context window or the configured floor
 * (defaulting to {@link DEFAULT_RESERVE_TOKENS} when unset), whichever is larger.
 */
export function effectiveReserveTokens(contextWindow: number, settings: CompactionSettings): number {
	return Math.max(Math.floor(contextWindow * 0.15), settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS);
}

/**
 * Reserve used when deciding whether a prompt still fits inside the model window.
 *
 * The default absolute reserve predates small bundled windows and can leave no
 * practical budget there; recover a DEFAULTED reserve that is impossible for
 * the window with the 15% proportional reserve (clamped to >= 1 so the derived
 * threshold stays strictly below the window even for tiny test windows).
 * Explicit valid reserves — including one that happens to equal the default —
 * still win, because they intentionally shrink the usable prompt budget;
 * provenance is carried by `settings.reserveTokens` being unset, never by
 * comparing values against the default.
 */
export function resolveBudgetReserveTokens(contextWindow: number, settings: CompactionSettings): number {
	const reserveTokens = effectiveReserveTokens(contextWindow, settings);
	const proportionalReserveTokens = Math.max(1, Math.floor(contextWindow * 0.15));
	const reserveWasDefaulted = settings.reserveTokens === undefined;
	const defaultReserveIsEffectivelyImpossible =
		reserveWasDefaulted && reserveTokens >= contextWindow - proportionalReserveTokens;
	const reserveExceedsWindow = reserveTokens >= contextWindow;

	return defaultReserveIsEffectivelyImpossible || reserveExceedsWindow ? proportionalReserveTokens : reserveTokens;
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled || settings.strategy === "off" || contextWindow <= 0) return false;
	const thresholdTokens = resolveThresholdTokens(contextWindow, settings);
	return contextTokens > thresholdTokens;
}

/**
 * Context tokens to feed the compaction decision, floored by a local estimate of
 * the stored conversation.
 *
 * The provider-reported usage is normally ground truth, but a
 * `before_provider_request` payload transform — a compression extension (e.g.
 * Headroom), an obfuscator, or inline snapcompact — can shrink the request below
 * the real stored conversation. The provider then reports deflated prompt
 * tokens, so anchoring compaction purely on that usage lets the real history
 * grow unbounded until it overflows and native compaction can no longer run.
 * Flooring by the agent's own estimate of the stored conversation keeps the
 * compaction trigger honest regardless of on-wire compression. (Display/cost
 * accounting still uses the exact provider usage; only the compaction decision
 * takes the floor.)
 */
export function compactionContextTokens(providerContextTokens: number, storedConversationEstimate: number): number {
	return Math.max(Math.max(0, providerContextTokens), Math.max(0, storedConversationEstimate));
}

/**
 * The prompt budget below `contextWindow`: the window less
 * {@link resolveBudgetReserveTokens}, capped at `contextWindow - 1` so it never
 * reaches the whole window even when the reserve resolves to 0. Independent of
 * any configured trigger; the default {@link resolveThresholdTokens} and
 * length-stop recovery's "did the window run out" check both use it.
 */
export function promptBudgetTokens(contextWindow: number, settings: CompactionSettings): number {
	return Math.max(0, Math.min(contextWindow - 1, contextWindow - resolveBudgetReserveTokens(contextWindow, settings)));
}

export function resolveThresholdTokens(contextWindow: number, settings: CompactionSettings): number {
	// Fixed token limit takes priority over percentage, and is checked against
	// the real window: `baseWindowTokens` only rescales the policies below.
	const thresholdTokens = settings.thresholdTokens;
	if (typeof thresholdTokens === "number" && Number.isFinite(thresholdTokens) && thresholdTokens > 0) {
		// A trigger at or past the window can never fire before the request
		// overflows (a provider may cap the window below the configured point);
		// fall back to the window's prompt budget, as the reserve policy does.
		// A trigger below the window is exact, as the `f` model entries promise,
		// even one inside the reserve: the user chose that headroom. The step at
		// the window is inherent; a monotone fallback would sit at window - 1.
		if (thresholdTokens >= contextWindow) return promptBudgetTokens(contextWindow, settings);
		return Math.min(contextWindow - 1, Math.max(1, thresholdTokens));
	}
	const baseWindowTokens = settings.baseWindowTokens;
	if (typeof baseWindowTokens === "number" && Number.isFinite(baseWindowTokens) && baseWindowTokens > 0) {
		contextWindow = Math.min(contextWindow, baseWindowTokens);
	}

	// Percentage-based threshold. The default absolute reserve can exceed bundled
	// small-context windows, or nearly consume a 16k-class window; in those
	// known-impossible default configurations, fall back to the proportional
	// reserve so threshold/recovery-band checks stay usable. Explicit valid
	// configured reserves still define the usable prompt budget.
	const thresholdPercent = settings.thresholdPercent;
	if (typeof thresholdPercent !== "number" || !Number.isFinite(thresholdPercent) || thresholdPercent <= 0) {
		return promptBudgetTokens(contextWindow, settings);
	}
	const clampedThresholdPercent = Math.min(99, Math.max(1, thresholdPercent));
	return Math.floor(contextWindow * (clampedThresholdPercent / 100));
}

// ============================================================================
// Cut point detection
// ============================================================================

/**
 * Find valid cut points: indices of user, assistant, custom, or bashExecution messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 * BashExecutionMessage is treated like a user message (user-initiated context).
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role as string;
				switch (role) {
					case "bashExecution":
					case "hookMessage":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
		}
		// branch_summary and custom_message are user-role messages, valid cut points
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * True for entries that begin a conversational turn (a user request, a
 * bash-execution card, a branch summary, or a custom user-role message).
 * Compaction cut alignment, turn discovery, and the collapsed display
 * transcript's orphan-head trim all share this boundary definition.
 */
export function isTurnStartEntry(entry: SessionEntry): boolean {
	if (entry.type === "branch_summary" || entry.type === "custom_message") {
		return true;
	}
	if (entry.type === "message") {
		const role = entry.message.role as string;
		return role === "user" || role === "bashExecution";
	}
	return false;
}

/**
 * Find the user message (or bashExecution) that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 * BashExecutionMessage is treated like a user message for turn boundaries.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isTurnStartEntry(entries[i])) {
			return i;
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the oldest complete recent-history suffix that fits `keepRecentTokens`.
 *
 * Walk backwards by valid cut points, measuring whole assistant/tool groups.
 * Keep the newest group even when it alone exceeds the budget; never retain
 * an additional older group that would push an otherwise fitting suffix over.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	tokenizer: Tokenizer,
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// Evaluate the budget only at valid boundaries, after counting all results
	// belonging to an assistant. Checking individual messages can either retain
	// the oversized older assistant or miss its boundary and retain all history.
	let accumulatedTokens = 0;
	// The latest surviving assistant turn replays byte-for-byte, signatures of
	// abandoned tool calls included, so it is counted as the latest.
	let latestTurnIndex = -1;
	for (let i = entries.length - 1; i >= 0 && latestTurnIndex < 0; i--) {
		const message = getMessageFromEntry(entries[i]);
		if (message?.role === "assistant" && isSurvivingAssistant(message)) latestTurnIndex = i;
	}
	let cutPointIndex = cutPoints.length - 1;
	let cutIndex = cutPoints[cutPointIndex];

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (message) {
			accumulatedTokens +=
				i === latestTurnIndex ? tokenizer.countLatestTurn(message) : tokenizer.countMessage(message);
		}
		if (i !== cutPoints[cutPointIndex]) continue;
		if (accumulatedTokens > keepRecentTokens) break;
		cutIndex = i;
		cutPointIndex--;
	}

	const isTurnStart = isTurnStartEntry(entries[cutIndex]);
	const turnStartIndex = isTurnStart ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	// Scan backwards from cutIndex to include any non-message entries (settings changes, etc.)
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at session header, compaction, or reset boundaries
		if (prevEntry.type === "compaction" || prevEntry.type === "reset_boundary") {
			break;
		}
		if (getMessageFromEntry(prevEntry)) {
			// Stop if we hit any entry that contributes a message
			break;
		}
		// Include this non-message entry (settings change, label, etc.)
		cutIndex--;
	}

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isTurnStart && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = prompt.render(compactionSummaryPrompt);

const UPDATE_SUMMARIZATION_PROMPT = prompt.render(compactionUpdateSummaryPrompt);

const SHORT_SUMMARY_PROMPT = prompt.render(compactionShortSummaryPrompt);

const HANDOFF_DOCUMENT_PROMPT = prompt.render(handoffDocumentPrompt);

export const AUTO_HANDOFF_THRESHOLD_FOCUS = prompt.render(autoHandoffThresholdFocusPrompt);

function formatAdditionalContext(context: string[] | undefined): string {
	if (!context || context.length === 0) return "";
	const lines = context.map(line => `- ${line}`).join("\n");
	return `<additional-context>\n${lines}\n</additional-context>\n\n`;
}

/**
 * Maps the non-special `ThinkingLevel` values to their `Effort` counterparts.
 * Exhaustive over the union; throws for `Off`/`Inherit` to surface logic
 * errors in callers that forgot to filter those out. Never use a TS cast for
 * this — `ThinkingLevel` is a string-union over distinct concepts (Off /
 * Inherit are not Efforts), and a cast hides the contract.
 */
function effortFromThinkingLevel(level: ThinkingLevel): Effort {
	switch (level) {
		case ThinkingLevel.Minimal:
			return Effort.Minimal;
		case ThinkingLevel.Low:
			return Effort.Low;
		case ThinkingLevel.Medium:
			return Effort.Medium;
		case ThinkingLevel.High:
			return Effort.High;
		case ThinkingLevel.XHigh:
			return Effort.XHigh;
		case ThinkingLevel.Max:
			return Effort.Max;
		case ThinkingLevel.Off:
		case ThinkingLevel.Inherit:
			throw new Error(`effortFromThinkingLevel: ${level} must be handled by caller`);
	}
}

/**
 * Resolves the reasoning effort to send on a compaction LLM call.
 *
 * - Explicit `Off` → `undefined` (omit reasoning entirely; the user said no thinking).
 * - `undefined` / `Inherit` → historical `Effort.High` default → clamped per model
 *   (preserves current behavior for users who never touched the dial).
 * - Explicit effort → respect user choice → clamped per model.
 *
 * The clamp routes through `clampThinkingLevelForModel`, which returns
 * `undefined` for reasoning models without a thinking config — the build-time
 * encoding of `compat.supportsReasoningEffort: false` (e.g.
 * `xai-oauth/grok-build`). That `undefined` then flows through to the
 * openai-responses mapper, which omits the wire param — no
 * `requireSupportedEffort` throw.
 */
function resolveCompactionEffort(model: Model, level: ThinkingLevel | undefined): Effort | undefined {
	if (level === ThinkingLevel.Off) return undefined;
	const requested: Effort =
		level === undefined || level === ThinkingLevel.Inherit ? Effort.High : effortFromThinkingLevel(level);
	return clampThinkingLevelForModel(model, requested);
}

/**
 * Build the error thrown when an LLM summarization call ends with
 * `stopReason === "error"`. Carries the provider's HTTP `errorStatus`
 * onto a top-level `.status` field so callers (notably
 * `AgentSession.#isCompactionAuthFailure`) can branch on 401/403 without
 * regex-scraping `error.message`. The `auth_unavailable` synthetic
 * (pi-native gateway) does not populate `errorStatus`, hence the legacy
 * message-based check is still required upstream — see issue #986.
 */
function createSummarizationError(prefix: string, response: AssistantMessage): Error {
	const text = `${prefix}: ${response.errorMessage || "Unknown error"}`;
	return response.errorStatus === undefined
		? new Error(text)
		: new AIError.ProviderHttpError(text, response.errorStatus);
}

function shouldRetryHandoffWithAutoToolChoice(response: AssistantMessage): boolean {
	if (response.errorStatus !== 400) return false;
	const message = response.errorMessage ?? "";
	return /\btool_choice\b/i.test(message) && /\bauto\b/i.test(message) && /\bsupported\b/i.test(message);
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export interface SummaryOptions {
	promptOverride?: string;
	extraContext?: string[];
	loadExtraContext?: () => Promise<string[] | undefined>;
	initiatorOverride?: MessageAttribution;
	metadata?: Record<string, unknown>;
	convertToLlm?: ConvertToLlm;
	telemetry?: AgentTelemetry;
	thinkingLevel?: ThinkingLevel;
	sessionId?: string;
	promptCacheKey?: string;
	fetch?: FetchImpl;
	onPayload?: SimpleStreamOptions["onPayload"];
	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
	/** Disable when the caller already retries the whole compaction attempt. */
	oneshotRetry?: OneshotRetryOptions | false;
}

/**
 * Resolve the oneshot retry policy for a summarization call. Enabled by default
 * so a lone transient blip cannot abort compaction; `false` opts out for callers
 * that already retry the whole attempt (see `SummaryOptions.oneshotRetry`).
 */
function summaryOneshotRetry(options: SummaryOptions | undefined): OneshotRetryOptions | undefined {
	const configured = options?.oneshotRetry;
	if (configured === false) return undefined;
	return configured ?? {};
}

function formatPreviousSnapcompactArchive(archiveText: string): string {
	return prompt.render(snapcompactArchiveContextPrompt, { archiveText });
}

function mergePreviousSummaryWithSnapcompactArchive(
	previousSummary: string | undefined,
	archiveText: string | undefined,
): string | undefined {
	if (!archiveText) return previousSummary;
	const archiveSummary = formatPreviousSnapcompactArchive(archiveText);
	return previousSummary ? `${previousSummary}\n\n${archiveSummary}` : archiveSummary;
}

/**
 * Fallback window for a model whose catalog entry carries no usable context
 * window; matches the smallest window any compaction-capable model ships with.
 */
const DEFAULT_SUMMARY_INPUT_WINDOW = 200_000;

/**
 * Floor for one summarization window, so a tiny model still makes progress.
 * Scaled down (never below 1k) for models whose window cannot host the full
 * floor next to the carried summary and output reserves.
 */
const MIN_SUMMARY_INPUT_TOKENS = 16_384;

/** Smallest window worth planning for `model`; below this, overflow recovery gives up. */
function minSummaryInputTokens(model: Model): number {
	const window = model.contextWindow && model.contextWindow > 0 ? model.contextWindow : DEFAULT_SUMMARY_INPUT_WINDOW;
	return Math.min(MIN_SUMMARY_INPUT_TOKENS, Math.max(1_024, Math.floor(window / 8)));
}

/**
 * Usable conversation input for ONE summarization call: the summarizer's window
 * minus the summary it must emit, the previous summary it carries forward, and
 * prompt scaffolding. Providers tokenize differently from the local cl100k
 * estimate, so the window is discounted before the fixed reserves come off.
 */
function summaryInputBudgetTokens(model: Model, maxTokens: number): number {
	const window = model.contextWindow && model.contextWindow > 0 ? model.contextWindow : DEFAULT_SUMMARY_INPUT_WINDOW;
	// 0.8, not "window minus reserves": provider tokenizers disagree with the
	// local cl100k estimate by a few percent, and being wrong here is a hard
	// 400 on the one call that is supposed to rescue an oversized session.
	return Math.max(minSummaryInputTokens(model), Math.floor(window * 0.8) - maxTokens - MAX_SUMMARY_TOKENS);
}

/**
 * Clamp one serialized window to the budget. Only reachable when a SINGLE
 * message serializes above the budget (an oversized paste): the alternative is
 * a provider rejection that no retry can clear, which strands the session with
 * a full window forever.
 */
function clampConversationToBudget(text: string, budgetTokens: number, tokens: number): string {
	if (tokens <= budgetTokens) return text;
	const keep = Math.max(1024, Math.floor((text.length * budgetTokens * 0.95) / tokens));
	if (keep >= text.length) return text;
	return `${text.slice(0, keep)}\n\n[... ${text.length - keep} more characters truncated]`;
}

/** One planned summarization call: its messages and the budget they were packed for. */
interface SummaryWindow {
	messages: Message[];
	budgetTokens: number;
	/** Serialization reused from the fit check, so the common path serializes once. */
	text?: string;
}

/**
 * Partition a conversation into windows that each fit `budgetTokens`, splitting
 * on message boundaries. Only called when the whole conversation does not fit —
 * the common single-window path never pays this per-message sizing pass.
 */
function planSummaryWindows(messages: Message[], tokenizer: Tokenizer, budgetTokens: number): Message[][] {
	const windows: Message[][] = [];
	let current: Message[] = [];
	let currentTokens = 0;
	for (const message of messages) {
		const tokens = tokenizer.countTokens(serializeConversationForSummary([message]));
		if (currentTokens > 0 && currentTokens + tokens > budgetTokens) {
			windows.push(current);
			current = [];
			currentTokens = 0;
		}
		current.push(message);
		currentTokens += tokens;
	}
	if (current.length > 0) windows.push(current);
	return windows;
}

export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model,
	reserveTokens: number,
	apiKey: ApiKey,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	options?: SummaryOptions,
): Promise<string> {
	const maxTokens = Math.min(Math.floor(0.8 * reserveTokens), MAX_SUMMARY_TOKENS);

	// Serialize conversation to text so model doesn't try to continue it
	// Convert to LLM messages first (handles custom app messages when caller provides a transformer).
	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(currentMessages);
	const tokenizer = new Tokenizer(model);
	const wholeConversation = serializeConversationForSummary(llmMessages);
	const budgetTokens = summaryInputBudgetTokens(model, maxTokens);
	// A span that outgrew the summarizer's window is summarized as a fold: each
	// window updates the summary carried out of the previous one, which is the
	// same contract the update prompt already implements for iterative
	// compaction. The alternative is a hard provider rejection on a prompt no
	// retry can shrink — the state a cross-provider compaction boundary
	// (see `prepareCompaction`) puts a long session into. One window is the
	// common case and costs exactly the one call it always did.
	const pending: SummaryWindow[] = tokenizer.checkTokenBudget(wholeConversation, budgetTokens).fits
		? [{ messages: llmMessages, budgetTokens, text: wholeConversation }]
		: planSummaryWindows(llmMessages, tokenizer, budgetTokens).map(messages => ({
				messages,
				budgetTokens,
			}));

	let carriedSummary = previousSummary;
	while (pending.length > 0) {
		const window = pending[0];
		const text = window.text ?? serializeConversationForSummary(window.messages);
		// A budget probe, not a raw count: a window whose bytes already fit needs
		// neither an exact count nor the clamp, and the bust path hands back the
		// exact count the proportional clamp needs as its denominator.
		const budget = tokenizer.checkTokenBudget(text, window.budgetTokens);
		try {
			carriedSummary = await summarizeConversationWindow(
				budget.fits ? text : clampConversationToBudget(text, window.budgetTokens, budget.tokens),
				carriedSummary,
				model,
				maxTokens,
				apiKey,
				signal,
				customInstructions,
				options,
			);
		} catch (error) {
			// The catalog window can overstate what the provider actually accepts:
			// `claude-sonnet-4-5` advertises 1M but is beta-gated to 200k on OAuth
			// credentials (see `anthropic.ts` — the 1M beta is never advertised).
			// Halve and re-plan rather than failing the whole compaction on a
			// window size only the provider can tell us is wrong.
			// Halve what was actually SENT, not the budget it was planned against:
			// the rejection proves the plan was fiction, so converging on the real
			// cap must not spend a call per level of an imaginary ladder. The cheap
			// fit path never counted this window, so pay for the exact size here —
			// one tokenization is nothing against the provider round trip already lost.
			const sentTokens = budget.exact ? budget.tokens : tokenizer.countTokens(text, "strict");
			const halved = Math.floor(Math.min(window.budgetTokens, sentTokens) / 2);
			if (
				!AIError.is(AIError.classify(error), AIError.Flag.ContextOverflow) ||
				halved < minSummaryInputTokens(model)
			) {
				throw error;
			}
			pending.splice(
				0,
				1,
				...planSummaryWindows(window.messages, tokenizer, halved).map(messages => ({
					messages,
					budgetTokens: halved,
				})),
			);
			continue;
		}
		pending.shift();
	}
	return carriedSummary ?? "";
}

/** One summarization call over a single conversation window. */
async function summarizeConversationWindow(
	conversationText: string,
	previousSummary: string | undefined,
	model: Model,
	maxTokens: number,
	apiKey: ApiKey,
	signal: AbortSignal | undefined,
	customInstructions: string | undefined,
	options: SummaryOptions | undefined,
): Promise<string> {
	// Use update prompt if we have a previous summary, otherwise initial prompt
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (options?.promptOverride) {
		basePrompt = options.promptOverride;
	}
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// Build the prompt with conversation wrapped in tags
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${escapeSummaryBoundaryTags(previousSummary)}\n</previous-summary>\n\n`;
	}
	promptText += formatAdditionalContext(options?.extraContext);
	promptText += basePrompt;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const response = await instrumentedCompleteSimple(
		model,
		{ systemPrompt: [SUMMARIZATION_SYSTEM_PROMPT], messages: summarizationMessages },
		{
			maxTokens,
			signal,
			apiKey,
			reasoning: resolveCompactionEffort(model, options?.thinkingLevel),
			initiatorOverride: options?.initiatorOverride,
			metadata: options?.metadata,
			fetch: options?.fetch,
			sessionId: options?.sessionId,
			promptCacheKey: options?.promptCacheKey,
		},
		{
			telemetry: options?.telemetry,
			oneshotKind: "compaction_summary",
			completeImpl: options?.completeImpl,
			retry: summaryOneshotRetry(options),
		},
	);

	if (response.stopReason === "error") {
		throw createSummarizationError("Summarization failed", response);
	}
	if (response.stopReason === "length") {
		throw new Error(incompleteOutputError("Summarization failed"));
	}

	const textContent = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");

	return textContent;
}

// ============================================================================
// Handoff generation
// ============================================================================

export interface HandoffOptions {
	/** Live agent system prompt — passed verbatim so providers hit the cached prefix. */
	systemPrompt: string[];
	/** Live agent tool list — same purpose. Forced to `toolChoice: "none"`. */
	tools?: Tool[];
	customInstructions?: string;
	convertToLlm?: ConvertToLlm;
	initiatorOverride?: MessageAttribution;
	metadata?: Record<string, unknown>;
	/**
	 * Optional telemetry handle. When provided, the handoff LLM call is
	 * wrapped in an OTEL chat span tagged with `omp.gen_ai.oneshot.kind = "handoff"`.
	 */
	telemetry?: AgentTelemetry;
	/**
	 * Active session thinking level. Threaded from `agent-session.ts` so
	 * handoff generation honors the user's `/model` thinking selection
	 * instead of silently overriding it with `Effort.High`. See
	 * `resolveCompactionEffort` for the conversion contract.
	 */
	thinkingLevel?: ThinkingLevel;
}

export function renderHandoffPrompt(customInstructions?: string): string {
	if (!customInstructions) return HANDOFF_DOCUMENT_PROMPT;
	return prompt.render(handoffDocumentPrompt, {
		additionalFocus: customInstructions,
	});
}

export interface HandoffFromContextOptions {
	/**
	 * Stream options mirrored from the live agent turn: `apiKey`, `signal`, the
	 * `sessionId`/`promptCacheKey` cache-routing pair, `serviceTier`, and the
	 * session's payload/response hooks. Sending the same routing + payload shape
	 * the main loop uses is what lets the handoff oneshot READ the provider
	 * prompt cache the live turn populated instead of cold-missing the whole
	 * prefix. `reasoning` and `toolChoice` are set internally and override
	 * anything provided here.
	 */
	streamOptions: SimpleStreamOptions;
	/** Optional completion transport override for host-level request wrappers. */
	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
	/** See {@link HandoffOptions.telemetry}. */
	telemetry?: AgentTelemetry;
	/** See {@link HandoffOptions.thinkingLevel}. */
	thinkingLevel?: ThinkingLevel;
}

/**
 * Run the handoff oneshot against a fully-built provider {@link Context}.
 *
 * The caller assembles `context` exactly like a live agent turn — same system
 * prompt, normalized tools, transformed + obfuscated message history, with the
 * trailing handoff-prompt message already appended — and supplies
 * `streamOptions` that mirror the live turn's cache routing. That keeps the
 * cache-preserving context construction in the host (which owns the transform
 * pipeline) while this function centralizes the handoff request contract:
 * cache-first `toolChoice: "none"`, clamped reasoning effort, one retry for
 * auto-only `tool_choice` providers, oneshot telemetry, text-only extraction,
 * and provider-error mapping.
 */
export async function generateHandoffFromContext(
	context: Context,
	model: Model,
	options: HandoffFromContextOptions,
): Promise<string> {
	const requestOptions = {
		...options.streamOptions,
		reasoning: resolveCompactionEffort(model, options.thinkingLevel),
		toolChoice: "none" as const,
	};
	let response = await instrumentedCompleteSimple(model, context, requestOptions, {
		telemetry: options.telemetry,
		oneshotKind: "handoff",
		completeImpl: options.completeImpl,
		retry: {},
	});
	if (response.stopReason === "error" && shouldRetryHandoffWithAutoToolChoice(response)) {
		response = await instrumentedCompleteSimple(
			model,
			context,
			{ ...requestOptions, toolChoice: "auto" },
			{ telemetry: options.telemetry, oneshotKind: "handoff", completeImpl: options.completeImpl, retry: {} },
		);
	}

	if (response.stopReason === "error") {
		throw createSummarizationError("Handoff generation failed", response);
	}
	if (response.stopReason === "length") {
		throw new Error(incompleteOutputError("Handoff generation failed"));
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

export async function generateHandoff(
	messages: AgentMessage[],
	model: Model,
	apiKey: ApiKey,
	options: HandoffOptions,
	signal?: AbortSignal,
): Promise<string> {
	const llmMessages = (options.convertToLlm ?? defaultConvertToLlm)(messages);
	const requestMessages: Message[] = [
		...llmMessages,
		{
			role: "user",
			content: [{ type: "text", text: renderHandoffPrompt(options.customInstructions) }],
			attribution: "agent",
			timestamp: Date.now(),
		},
	];

	return generateHandoffFromContext(
		{ systemPrompt: options.systemPrompt, messages: requestMessages, tools: options.tools },
		model,
		{
			streamOptions: {
				apiKey,
				signal,
				initiatorOverride: options.initiatorOverride,
				metadata: options.metadata,
			},
			telemetry: options.telemetry,
			thinkingLevel: options.thinkingLevel,
		},
	);
}

/** Result of the short-summary request before it is mapped to the optional field. */
type ShortSummaryOutcome = { kind: "text"; text: string } | { kind: "failed"; error: string } | { kind: "aborted" };

/**
 * Generate the optional display summary. Cancellation propagates as an
 * `AbortError`; every other failure or an empty answer yields `undefined`, so
 * a completed full summary is never discarded for this display-only field.
 */
async function generateShortSummary(
	recentMessages: AgentMessage[],
	historySummary: string | undefined,
	model: Model,
	reserveTokens: number,
	apiKey: ApiKey,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<string | undefined> {
	const maxTokens = Math.min(512, Math.floor(0.2 * reserveTokens));
	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(recentMessages);
	const conversationText = serializeConversationForSummary(llmMessages);

	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (historySummary) {
		promptText += `<previous-summary>\n${escapeSummaryBoundaryTags(historySummary)}\n</previous-summary>\n\n`;
	}
	promptText += formatAdditionalContext(options?.extraContext);
	promptText += SHORT_SUMMARY_PROMPT;

	let outcome: ShortSummaryOutcome;
	try {
		const response = await instrumentedCompleteSimple(
			model,
			{
				systemPrompt: [SUMMARIZATION_SYSTEM_PROMPT],
				messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
			},
			{
				maxTokens,
				signal,
				apiKey,
				reasoning: resolveCompactionEffort(model, options?.thinkingLevel),
				initiatorOverride: options?.initiatorOverride,
				metadata: options?.metadata,
				fetch: options?.fetch,
				sessionId: options?.sessionId,
				promptCacheKey: options?.promptCacheKey,
			},
			{
				telemetry: options?.telemetry,
				oneshotKind: "compaction_short_summary",
				completeImpl: options?.completeImpl,
				retry: summaryOneshotRetry(options),
			},
		);
		switch (response.stopReason) {
			case "aborted":
				outcome = { kind: "aborted" };
				break;
			case "error":
				outcome = { kind: "failed", error: response.errorMessage || "Unknown error" };
				break;
			case "length":
				outcome = { kind: "failed", error: incompleteOutputError("Short summary failed") };
				break;
			case "stop":
			case "toolUse":
				outcome = {
					kind: "text",
					text: response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map(c => c.text)
						.join("\n"),
				};
				break;
		}
	} catch (err) {
		outcome = signal?.aborted
			? { kind: "aborted" }
			: { kind: "failed", error: err instanceof Error ? err.message : String(err) };
	}

	if (signal?.aborted) outcome = { kind: "aborted" };
	switch (outcome.kind) {
		case "aborted":
			throw new AIError.AbortError("Short summary aborted", { cause: signal?.reason });
		case "failed":
			logger.warn("Compaction short summary skipped", {
				error: outcome.error,
				model: model.id,
				provider: model.provider,
			});
			return undefined;
		case "text":
			if (outcome.text.trim() === "") {
				logger.warn("Compaction short summary skipped", {
					error: "empty answer",
					model: model.id,
					provider: model.provider,
				});
				return undefined;
			}
			return outcome.text;
	}
}

// ============================================================================
// Compaction Preparation (for hooks)
// ============================================================================

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Messages kept in full after compaction (recent history) */
	recentMessages: AgentMessage[];
	/** Entry IDs parallel to recentMessages, for an Anthropic-safe keep-tail boundary. */
	recentEntryIds?: string[];
	/** Last entry before the kept tail; a remote compaction that cannot fit the tail covers history through it. */
	lastSummarizedEntryId?: string;
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** ISO timestamp of the previous compaction entry, for iterative update */
	previousSummaryTimestamp?: string;
	/** Preserved opaque compaction payload from the previous compaction, if any. */
	previousPreserveData?: Record<string, unknown>;
	/** File operations extracted from messagesToSummarize */
	fileOps: snapcompact.FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

/** Whether an old compaction contains an opaque Responses replay payload. */
export function hasOpaqueCompaction(preserveData: Record<string, unknown> | undefined): boolean {
	return preserveData?.openaiRemoteCompaction !== undefined;
}

/** Drop retired transport payloads while retaining extension-owned metadata. */
export function stripLegacyCompactionData(
	preserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!preserveData) return undefined;
	const { openaiRemoteCompaction: _openai, anthropicCompaction: _anthropic, ...rest } = preserveData;
	return Object.keys(rest).length > 0 ? rest : undefined;
}

/** The newest readable summary; opaque legacy entries do not cover their original messages. */
export function findReadableCompactionIndex(pathEntries: SessionEntry[]): number {
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		const entry = pathEntries[i];
		if (entry.type === "compaction" && !hasOpaqueCompaction(entry.preserveData)) return i;
	}
	return -1;
}

/**
 * Pass the caller's warm `tokenizer` (the Agent's for the active model) so the
 * full-branch estimate walk hits its memo; the cold default is for one-shot
 * callers that have no live agent.
 */
export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	activeModel?: Model,
	tokenizer: Tokenizer = new Tokenizer(activeModel),
): CompactionPreparation | undefined {
	const lastEntry = pathEntries[pathEntries.length - 1];
	// A speculative native record may leave uncovered messages before the record.
	// A trailing boundary this preparation re-expands covers nothing yet.
	if (
		lastEntry?.type === "compaction" &&
		!lastEntry.providerReplayThroughEntryId &&
		!hasOpaqueCompaction(lastEntry.preserveData)
	) {
		return undefined;
	}

	let prevCompactionIndex = findReadableCompactionIndex(pathEntries);

	// A newer reset clears the previous summary. An older reset bounds both
	// the local retained tail and the native snapshot-to-commit interval.
	let resetBoundaryIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "reset_boundary") {
			resetBoundaryIndex = i;
			break;
		}
	}
	if (resetBoundaryIndex > prevCompactionIndex) {
		prevCompactionIndex = -1;
	}
	const previousCompaction =
		prevCompactionIndex >= 0 ? (pathEntries[prevCompactionIndex] as CompactionEntry) : undefined;
	let boundaryStart = Math.max(prevCompactionIndex, resetBoundaryIndex) + 1;
	if (previousCompaction) {
		// Readable summaries exclude the retained tail, whose
		// original entries precede the compaction record.
		for (let i = resetBoundaryIndex + 1; i < prevCompactionIndex; i++) {
			if (pathEntries[i].id === previousCompaction.firstKeptEntryId) {
				boundaryStart = i;
				break;
			}
		}
		if (previousCompaction.firstKeptEntryId === "" && previousCompaction.providerReplayThroughEntryId) {
			// An empty snapshot tail can still have turns appended during
			// background compaction; those start after the summarized snapshot.
			const snapshotIdx = pathEntries.findIndex(
				entry => entry.id === previousCompaction.providerReplayThroughEntryId,
			);
			if (snapshotIdx >= 0 && snapshotIdx < prevCompactionIndex) boundaryStart = snapshotIdx + 1;
		}
	}

	// Keep original IDs beside the converted messages so estimation, cutting,
	// and all three output regions share one sequence without journal metadata.
	const compactionEntries: SessionEntry[] = [];
	const compactionMessages: AgentMessage[] = [];
	for (let i = boundaryStart; i < pathEntries.length; i++) {
		const entry = pathEntries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;
		compactionEntries.push(entry);
		compactionMessages.push(message);
	}

	const postCompactionStart = Math.max(prevCompactionIndex, resetBoundaryIndex) + 1;
	const lastUsage = getLastAssistantUsage(
		postCompactionStart > 0 ? pathEntries.slice(postCompactionStart) : pathEntries,
	);
	const tokensBefore = lastUsage ? calculateContextTokens(lastUsage) : 0;
	let keepRecentTokens = settings.keepRecentTokens;
	if (activeModel?.contextWindow && activeModel.contextWindow > 0) {
		// The compacted context (kept tail + summary/prompt overhead) must land in
		// the recovery band under the configured trigger, or it fires again at once.
		// The trigger is the user's choice, so the kept tail gives way, not the trigger:
		// it gets what the band leaves after the reserve floor (an upper bound on the
		// summary), or half the band when the floor alone fills it.
		const contextWindow = activeModel.contextWindow;
		const recoveryBand = Math.floor(resolveThresholdTokens(contextWindow, settings) * COMPACTION_RECOVERY_BAND);
		const reserveFloor = Math.min(
			resolveBudgetReserveTokens(contextWindow, settings),
			settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
		);
		const tailBudget = recoveryBand > reserveFloor ? recoveryBand - reserveFloor : Math.floor(recoveryBand / 2);
		keepRecentTokens = Math.min(keepRecentTokens, Math.max(1, tailBudget));
	}
	if (lastUsage) {
		const estimatedTokens = tokenizer.countMessages(compactionMessages);
		const promptTokens = calculatePromptTokens(lastUsage);
		const ratio = estimatedTokens > 0 ? promptTokens / estimatedTokens : 0;
		if (Number.isFinite(ratio) && ratio > 1) {
			keepRecentTokens = Math.max(1, Math.floor(keepRecentTokens / ratio));
		}
	}

	const cutPoint = findCutPoint(compactionEntries, tokenizer, 0, compactionEntries.length, keepRecentTokens);

	// Get ID of first kept entry
	const firstKeptEntry = compactionEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	const messagesToSummarize = compactionMessages.slice(0, historyEnd);
	const turnPrefixMessages = cutPoint.isSplitTurn
		? compactionMessages.slice(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex)
		: [];
	const recentMessages = compactionMessages.slice(cutPoint.firstKeptEntryIndex);
	// Nothing to summarize means compaction would be a no-op.
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return undefined;
	}

	const recentEntryIds: string[] = [];
	for (let i = cutPoint.firstKeptEntryIndex; i < compactionEntries.length; i++) {
		recentEntryIds.push(compactionEntries[i].id);
	}

	// Extract file operations from messages and previous compaction
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		recentMessages,
		lastSummarizedEntryId: compactionEntries[cutPoint.firstKeptEntryIndex - 1]?.id,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary: previousCompaction?.summary,
		previousSummaryTimestamp: previousCompaction?.timestamp,
		previousPreserveData: previousCompaction?.preserveData,
		fileOps,
		settings,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = prompt.render(compactionTurnPrefixPrompt);
/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds id/parentId when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model,
	apiKey: ApiKey,
	customInstructions?: string,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		recentMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		previousPreserveData,
		fileOps,
		settings,
	} = preparation;

	const reserveTokens = settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS;

	const summaryOptions: SummaryOptions = { ...options };
	let extraContextLoaded = false;
	const ensureExtraContext = async (): Promise<void> => {
		if (extraContextLoaded || !options?.loadExtraContext) return;
		const context = await options.loadExtraContext();
		signal?.throwIfAborted();
		if (context?.length) summaryOptions.extraContext = [...(summaryOptions.extraContext ?? []), ...context];
		extraContextLoaded = true;
	};

	const previousSnapcompactArchive = snapcompact.getPreservedArchive(previousPreserveData);
	const previousSummaryForReader = previousSummary;
	const previousSnapcompactArchiveText = previousSnapcompactArchive
		? snapcompact.archiveSourceText(previousSnapcompactArchive)
		: undefined;
	const previousSummaryForCompaction = mergePreviousSummaryWithSnapcompactArchive(
		previousSummaryForReader,
		previousSnapcompactArchiveText,
	);
	const preserveData = stripLegacyCompactionData(previousPreserveData);
	await ensureExtraContext();

	// Generate summaries (can be parallel if both needed) and merge into one
	let summary: string;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		// Generate both summaries in parallel
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0 || previousSummaryForCompaction
				? generateSummary(
						messagesToSummarize,
						model,
						reserveTokens,
						apiKey,
						signal,
						customInstructions,
						previousSummaryForCompaction,
						summaryOptions,
					)
				: Promise.resolve("No prior history."),
			generateTurnPrefixSummary(turnPrefixMessages, model, reserveTokens, apiKey, signal, summaryOptions),
		]);
		// Merge into single summary
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else if (messagesToSummarize.length > 0) {
		// Generate history summary from messages to summarize
		summary = await generateSummary(
			messagesToSummarize,
			model,
			reserveTokens,
			apiKey,
			signal,
			customInstructions,
			previousSummaryForCompaction,
			summaryOptions,
		);
	} else if (previousSummaryForCompaction) {
		// No new messages to summarize, preserve previous summary
		summary = previousSummaryForCompaction;
	} else {
		// No messages and no previous summary
		summary = "No prior history.";
	}

	const shortSummary = await generateShortSummary(
		recentMessages,
		summary,
		model,
		reserveTokens,
		apiKey,
		signal,
		summaryOptions,
	);

	// Compute file lists and append to summary
	const { readFiles, modifiedFiles } = snapcompact.computeFileLists(fileOps);
	summary = snapcompact.upsertFileOperations(summary, readFiles, modifiedFiles, fileOps.read);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no ID - session may need migration");
	}

	// This LLM-summary path migrated any prior snapcompact frames into the summary
	// text above; strip the now-stale frame archive from preserveData so it cannot
	// re-attach to the rebuilt context. Only the legacy-frame case needs stripping —
	// when there was no previous archive, preserveData carries no frames to drop.
	const finalPreserveData = previousSnapcompactArchive
		? snapcompact.stripPreservedArchive(preserveData)
		: preserveData;

	return {
		summary,
		...(shortSummary !== undefined ? { shortSummary } : {}),
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
		preserveData: finalPreserveData,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model,
	reserveTokens: number,
	apiKey: ApiKey,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<string> {
	const maxTokens = Math.min(Math.floor(0.5 * reserveTokens), MAX_SUMMARY_TOKENS); // Smaller budget for turn prefix

	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(messages);
	const conversationText = serializeConversationForSummary(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${formatAdditionalContext(options?.extraContext)}${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const response = await instrumentedCompleteSimple(
		model,
		{ systemPrompt: [SUMMARIZATION_SYSTEM_PROMPT], messages: summarizationMessages },
		{
			maxTokens,
			signal,
			apiKey,
			reasoning: resolveCompactionEffort(model, options?.thinkingLevel),
			initiatorOverride: options?.initiatorOverride,
			metadata: options?.metadata,
			fetch: options?.fetch,
			sessionId: options?.sessionId,
			promptCacheKey: options?.promptCacheKey,
		},
		{
			telemetry: options?.telemetry,
			oneshotKind: "compaction_turn_prefix",
			completeImpl: options?.completeImpl,
			retry: summaryOneshotRetry(options),
		},
	);

	if (response.stopReason === "error") {
		throw createSummarizationError("Turn prefix summarization failed", response);
	}
	if (response.stopReason === "length") {
		throw new Error(incompleteOutputError("Turn prefix summarization failed"));
	}

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}
