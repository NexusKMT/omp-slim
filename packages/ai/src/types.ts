import type { Type } from "@oh-my-pi/omptype";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Api, FetchImpl, Model, Provider, ThinkingBudgets, Usage } from "@oh-my-pi/pi-catalog/types";
import type { ApiKey } from "./auth-retry";
import type { OpenAICompletionsOptions } from "./providers/openai-completions";
import type { kStreamingPartialJson } from "./utils/block-symbols";
import type { AssistantMessageEventStream } from "./utils/event-stream";
export type { AssistantMessageEventStream } from "./utils/event-stream";
export type * from "@oh-my-pi/pi-catalog/types";
export const OPENAI_MAX_OUTPUT_TOKENS = 64000;
export interface ApiOptionsMap {
	"openai-completions": OpenAICompletionsOptions;
}
export type OptionsForApi<TApi extends Api> =
	| StreamOptions
	| (TApi extends keyof ApiOptionsMap ? ApiOptionsMap[TApi] : never);
export type StreamFunction<TApi extends Api> = (
	model: Model<TApi>,
	context: Context,
	options?: OptionsForApi<TApi>,
) => AssistantMessageEventStream;
export type MessageAttribution = "user" | "agent";
export type CacheRetention = "none" | "short" | "long";
export type NativeToolMarker = { type: "computer" };
export type ToolChoice =
	| "auto"
	| "none"
	| "any"
	| "required"
	| { type: "function"; name: string }
	| { type: "function"; function: { name: string } }
	| { type: "tool"; name: string };
export type ServiceTier = "auto" | "default" | "flex" | "scale" | "priority" | "ultrafast";
export type ServiceTierFamily = "openai";
export type ServiceTierByFamily = Partial<Record<ServiceTierFamily, ServiceTier>>;
export function parseServiceTier(value: unknown): ServiceTier | undefined {
	return typeof value === "string" && ["auto", "default", "flex", "scale", "priority", "ultrafast"].includes(value)
		? (value as ServiceTier)
		: undefined;
}
export function serviceTierFamily(model: Pick<Model, "api">): ServiceTierFamily | undefined {
	return model.api === "openai-completions" ? "openai" : undefined;
}
export function resolveModelServiceTier(
	tiers: ServiceTierByFamily | null | undefined,
	model: Pick<Model, "api">,
): ServiceTier | undefined {
	return serviceTierFamily(model) ? tiers?.openai : undefined;
}
export function shouldSendServiceTier(tier: ServiceTier | null | undefined): boolean {
	return tier != null;
}
export function realizesPriorityServiceTier(tier: ServiceTier | null | undefined): boolean {
	return tier === "priority" || tier === "ultrafast";
}
export function getPremiumServiceTierRequests(tier: ServiceTier | null | undefined): number {
	return realizesPriorityServiceTier(tier) ? 1 : 0;
}
export function coerceServiceTierByFamily(value: unknown): ServiceTierByFamily | undefined {
	const tier = parseServiceTier(typeof value === "object" && value !== null ? Reflect.get(value, "openai") : value);
	return tier ? { openai: tier } : undefined;
}
/** Retained for reading historical session state, never a transport selector. */
export interface ProviderSessionState {
	close(): void;
	releaseSession?(sessionId: string): void;
}
export interface ProviderResponseMetadata {
	status: number;
	headers: Record<string, string>;
	requestId?: string | null;
	metadata?: Record<string, unknown>;
}
export interface RawSseEvent {
	event: string | null;
	data: string;
	raw: string[];
}
export interface TokenTaskBudget {
	type: "tokens";
	total: number;
	remaining?: number;
}
export interface StreamOptions {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
	frequencyPenalty?: number;
	stopSequences?: string[];
	maxTokens?: number;
	signal?: AbortSignal;
	maxHttpAttempts?: number;
	apiKey?: string;
	credentialId?: number;
	headers?: Record<string, string>;
	maxRetryDelayMs?: number;
	metadata?: Record<string, unknown>;
	cacheRetention?: CacheRetention;
	sessionId?: string;
	parentSessionId?: string;
	taskBudget?: TokenTaskBudget;
	promptCacheKey?: string;
	loopGuard?: { enabled?: boolean; checkAssistantContent?: boolean };
	maxInFlightRequests?: Record<string, number>;
	beforeDispatch?: () => void;
	waitForTerminalDrain?: boolean;
	onPayload?: (payload: unknown, model?: Model<Api>, signal?: AbortSignal) => unknown | Promise<unknown>;
	onResponse?: (response: ProviderResponseMetadata, model?: Model<Api>, signal?: AbortSignal) => void | Promise<void>;
	onSseEvent?: (event: RawSseEvent, model?: Model<Api>) => void;
	streamFirstEventTimeoutMs?: number;
	streamIdleTimeoutMs?: number;
	providerRetryWait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
	acceptEmptyResponse?: boolean;
	fetch?: FetchImpl;
	cwd?: string;
	forceReasoningOff?: boolean;
}
export interface SimpleStreamOptions extends Omit<StreamOptions, "apiKey"> {
	apiKey?: ApiKey;
	reasoning?: Effort;
	disableReasoning?: boolean;
	hideThinkingSummary?: boolean;
	thinkingBudgets?: ThinkingBudgets;
	toolChoice?: ToolChoice;
	serviceTier?: ServiceTier;
}
/** Historical stop classification; no provider-specific request is generated from it. */
export type StopDetails = {
	type: string;
	category?: string | null;
	explanation?: string | null;
	fallback_credit_token?: string | null;
	fallback_has_prefill_claim?: boolean | null;
};

// Legacy message metadata below is retained for session-file compatibility only.
export interface TextSignatureV1 {
	v: 1;
	id: string;
	phase?: "commentary" | "final_answer";
}

export interface TextContent {
	type: "text";
	text: string;
	textSignature?: string; // e.g., for OpenAI responses, message metadata (legacy id string or TextSignatureV1 JSON)
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string; // e.g., for OpenAI responses, the reasoning item ID
	itemId?: string; // item.id from output_item.added, used to match output_item.done
	/**
	 * `true`: `thinking` is a provider-written summary of the model's reasoning
	 * (OpenAI Responses `summary_text`, Gemini thought summaries). `false`: the
	 * wire delivered it as the reasoning itself, not marked as a summary
	 * (chat-completions reasoning fields, Responses `reasoning_text`, Devin
	 * `thinking`); whether that is the full trace is vouched for per family by
	 * the catalog's `portable-reasoning`. Unset when provenance is unknown,
	 * including turns recorded before parsers set it. Only `false` blocks
	 * replay natively on another host.
	 */
	summary?: boolean;
	/**
	 * `true`: the block is narration — prose the model addressed to the user
	 * between tool calls, which the provider returned as a signed thinking block
	 * (Anthropic connector-text summarization). It stays a thinking block for
	 * replay; user-facing surfaces present it as answer text.
	 */
	narration?: boolean;
}

export interface RedactedThinkingContent {
	type: "redactedThinking";
	data: string;
}

/**
 * Anthropic server-side-fallback boundary marker persisted on assistant
 * turns whose response switched models mid-stream, whether the request
 * opted into `AnthropicOptions.fallbacks` or a gateway opted in on its
 * behalf. Consumers other than the Anthropic provider MUST ignore it —
 * `transformMessages` strips the block on any non-Anthropic hop, and
 * `convertAnthropicMessages` only puts it on the wire for an opted-in
 * request to the official endpoint.
 */
export interface AnthropicFallbackContent {
	type: "fallback";
	from: { model: string };
	to: { model: string };
}

/**
 * Verbatim Anthropic web-search or tool-search call/result retained for
 * same-provider history replay. Other providers discard it in
 * `transformMessages`.
 */
export interface AnthropicServerToolContent {
	type: "anthropicServerTool";
	block:
		| {
				type: "server_tool_use";
				id: string;
				name: "web_search" | "tool_search_tool_regex" | "tool_search_tool_bm25";
				input?: Record<string, unknown> | null;
				[key: string]: unknown;
		  }
		| {
				type: "web_search_tool_result" | "tool_search_tool_result";
				tool_use_id: string;
				content: unknown;
				[key: string]: unknown;
		  };
}

/** Provider-native uploaded file reference for image reuse without retransmitting bytes. */
export interface ProviderFileReference {
	provider: "openai" | "anthropic" | "google";
	id?: string;
	uri?: string;
	expiresAt?: number;
}

export interface ImageContent {
	type: "image";
	data: string; // base64 encoded image data
	mimeType: string; // e.g., "image/jpeg", "image/png"
	/**
	 * OpenAI-only resolution hint. `"original"` preserves native resolution
	 * (required for snapcompact frames, whose glyphs do not survive the
	 * default `auto` downscale). Providers without a detail knob ignore it.
	 */
	detail?: "auto" | "low" | "high" | "original";
	/** Provider-native file reference preferred only by its matching provider. */
	providerFile?: ProviderFileReference;
	/**
	 * Optional https mirror of `data`, served by a caller-run blob server.
	 * Providers whose API fetches remote images send this URL instead of the
	 * base64 payload; every other provider ignores it. `data` remains the
	 * source of truth — the URL must serve exactly those bytes, and callers
	 * are responsible for keeping it stable across turns (prefix caches hash
	 * the URL string, and Anthropic silently forgets images when a resent
	 * turn differs byte-wise).
	 */
	url?: string;
}

export type ComputerAction =
	| {
			type: "click";
			button: "left" | "right" | "wheel" | "back" | "forward";
			x: number;
			y: number;
			keys?: string[] | null;
	  }
	| { type: "double_click"; x: number; y: number; keys: string[] | null }
	| { type: "drag"; path: Array<{ x: number; y: number }>; keys?: string[] | null }
	| { type: "keypress"; keys: string[] }
	| { type: "move"; x: number; y: number; keys?: string[] | null }
	| { type: "screenshot" }
	| { type: "scroll"; x: number; y: number; scroll_x: number; scroll_y: number; keys?: string[] | null }
	| { type: "type"; text: string }
	| { type: "wait" };

export interface ComputerSafetyCheck {
	id: string;
	code?: string | null;
	message?: string | null;
}

export interface ComputerToolCallMetadata {
	type: "computer";
	providerItemId: string;
	actions: ComputerAction[];
	pendingSafetyChecks: ComputerSafetyCheck[];
}

export type ToolCallProviderMetadata = ComputerToolCallMetadata;

export type ComputerScreenshotRef =
	| { type: "computer_screenshot"; image_url: string; file_id?: never }
	| { type: "computer_screenshot"; file_id: string; image_url?: never };

export interface ComputerToolResultMetadata {
	type: "computer";
	screenshot: ComputerScreenshotRef;
	acknowledgedSafetyChecks: ComputerSafetyCheck[];
}

export type ToolResultProviderMetadata = ComputerToolResultMetadata;

export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	[kStreamingPartialJson]?: string;
	thoughtSignature?: string; // Google-specific: opaque signature for reusing thought context
	intent?: string; // Harness-level intent metadata extracted from traced tool arguments
	/**
	 * Verbatim in-band syntax block that produced this synthetic `ptc_*` call.
	 * Present only for owned prompt/tool-call formats; provider-native calls omit it.
	 */
	rawBlock?: string;
	/**
	 * Original wire-level name when the tool was invoked via OpenAI's custom-tool
	 * mechanism (e.g., `apply_patch`). Set by `openai-responses` on receive so
	 * the history-replay path can re-emit the call as `custom_tool_call` with
	 * its paired tool-result as `custom_tool_call_output`. Absent for regular
	 * JSON function tools.
	 */
	customWireName?: string;
	/** Responses API namespace for namespaced function and custom tools. */
	namespace?: string;
	/** Provider-native metadata required to execute and faithfully replay this call. */
	providerMetadata?: ToolCallProviderMetadata;
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface OpenAIResponsesHistoryPayload {
	type: "openaiResponsesHistory";
	provider?: string;
	dt?: boolean;
	items: Array<Record<string, unknown>>;
}

/** Anthropic `output_config.effort` level. */
export type AnthropicOutputEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** One `tool_addition`/`tool_removal` block of an Anthropic mid-conversation system message. */
export interface AnthropicToolChange {
	type: "tool_addition" | "tool_removal";
	name: string;
}

/** Anthropic-only controls attached to a mid-conversation system message. */
export interface AnthropicMessagePayload {
	type: "anthropicMessage";
	clearAt?: "never" | "next_user_message";
	effort?: AnthropicOutputEffort;
	toolChanges?: AnthropicToolChange[];
}

/**
 * Controls an Anthropic request declared, recorded on its response so later
 * requests over the same transcript replay a byte-identical prefix.
 * Written by the Anthropic provider; read by it and by the Agent's inactive-tool lookup.
 */
export interface AnthropicRequestControls {
	/**
	 * `context.messages.length` of the request that produced this response, i.e. the
	 * response's own index. A record found at another index belongs to a history that was
	 * rewritten before it (compaction, dropped messages) and is not replayed as controls.
	 */
	messageIndex: number;
	/** Present when the request kept a stable tool declaration (`supportsMidConversationToolChanges`). Source tool names, not wire names. */
	tools?: {
		/** Top-level `tools` in wire order. */
		declared: string[];
		/** Subset of `declared` sent with `defer_loading: true`. */
		deferred: string[];
		/** Tools active at the end of the request, in `context.tools` order. */
		active: string[];
	};
	/** Present when the request kept a stable effort (`supportsPerMessageEffort`); `null` = API default. */
	effort?: { topLevel: AnthropicOutputEffort | null; tail: AnthropicOutputEffort | null };
}

/**
 * Anthropic on-demand compaction summary (`compact-2026-09-04` beta).
 *
 * Produced by the Anthropic provider on the assistant message of a request
 * that streamed a `compaction` content block, and attached to the user-role
 * compaction summary message that replaces the compacted history so the
 * provider can replay the block verbatim: the API drops every block that
 * precedes it. `content` is the plain-text summary, so every other provider
 * reads the message text and ignores the payload.
 */
export interface AnthropicCompactionPayload {
	type: "anthropicCompaction";
	/** Provider that produced the summary; only that provider replays it natively. */
	provider: string;
	content: string;
	/** Signature of an on-demand block; replayed verbatim. */
	signature?: string;
	/** Net tool changes across the summarized range; covered by the signature, replayed verbatim. */
	toolChanges?: Record<string, unknown>[];
	/** Legacy threshold block state (`compact-2026-01-12`); replay-only. */
	encryptedContent?: string;
	/**
	 * Harness-appended file metadata (`<files>` section) kept out of the
	 * byte-identical block. The converter replaces the summary message with the
	 * block and skips its text, so it replays this as a user message after the
	 * block's retained tail: before the first message created after the summary.
	 */
	filesText?: string;
	/**
	 * File metadata of earlier summaries whose replay position lies inside this
	 * summary's retained tail. Retained messages must reach the API unchanged,
	 * so each keeps replaying where it did: before the first message created
	 * after `after` (the earlier summary's commit time).
	 */
	retainedFiles?: AnthropicCompactionFiles[];
	/**
	 * Set on summaries whose retained tail replays unchanged: file metadata
	 * after the tail, earlier metadata at `retainedFiles`. Summaries persisted
	 * without it keep their original layout (metadata after the first retained
	 * turn), since later thinking was signed against those bytes.
	 */
	exactTail?: true;
}

/** File metadata replayed at a fixed point of a natively compacted conversation. */
export interface AnthropicCompactionFiles {
	text: string;
	/** Replays before the first message created after this time (ms). */
	after: number;
}

/**
 * Records Cursor's server wrote into the client's conversation store for one
 * assistant turn: the `rootPromptMessagesJson` entries after the user's message,
 * reasoning signatures and redacted reasoning included. Written and read by the
 * Cursor provider, which sends them back unchanged to the wire model that produced them.
 */
export interface CursorHistoryPayload {
	type: "cursorHistory";
	/** Wire route the records were written under, as sent (requested model, details id, max mode, parameters). */
	wireRoute: string;
	/** Digest of the turn's opening user message, content and paired tool results when recorded; a rewritten turn rebuilds instead. */
	digest: string;
	/** Record bytes (UTF-8 JSON) in conversation order; each blob id is the SHA-256 of its bytes. */
	records: string[];
}

/**
 * The `candidates[0].content` a Gemini model streamed for one turn, every part
 * (thought text, signatures, call ids) merged in arrival order. Written and read
 * by the Factory Droid Gemini transport, which replays it unchanged to the same
 * model while the turn's content still matches `digest`.
 */
export interface GeminiNativeContentPayload {
	type: "geminiNativeContent";
	/** Digest of the turn's text, thinking and tool calls when recorded; a rewritten turn rebuilds instead. */
	digest: string;
	content: { role?: string; parts: Record<string, unknown>[]; [key: string]: unknown };
}

export type ProviderPayload =
	| OpenAIResponsesHistoryPayload
	| AnthropicMessagePayload
	| AnthropicCompactionPayload
	| CursorHistoryPayload
	| GeminiNativeContentPayload;

/** Provider-reported rewrite applied to request content before inference. */
export interface ProviderInputTransformation {
	type: string;
	path?: string;
	reason?: string;
	[key: string]: unknown;
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	/** Original sender and body of a parent-agent IRC steer, for transcript presentation only. */
	parentIrc?: { from: string; body: string };
	/** True if the message was injected by the system (e.g., auto-continue). */
	synthetic?: boolean;
	/** True when injected mid-turn as a steer; consumed by the agent's pre-LLM transform to wrap it for emphasis. Never rendered. */
	steering?: boolean;
	/** True when the provider delivered this steer into the response it was streaming (`response.steer`). Display-only; never sent. */
	liveSteered?: boolean;
	/** Timestamp of a client-side history rewrite represented by this message. */
	historyRewriteAt?: number;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
}

export interface DeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent)[];
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** True if the message was injected by the system (e.g., auto-continue) and initiates a fresh run rather than continuing the current one. */
	synthetic?: boolean;
	/** True when the synthetic prompt was a deliberate operator action (`.`, `c` continue shortcut) rather than an automatic continuation — its timestamp is the turn's prompt time. */
	userInitiated?: boolean;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
}

/** How an automatic retry recovered or ultimately settled a failed attempt. */
export type AssistantRetryRecoveryKind = "credential" | "model" | "wait" | "plain";

/** Persisted presentation state for an assistant error superseded by an automatic retry saga. */
export type AssistantRetryRecovery =
	| {
			kind: "auto-retry";
			status: "recovered";
			attempt: number;
			recoveredAt: string;
			recovery: AssistantRetryRecoveryKind;
			note: string;
			supersededBy?: {
				timestamp: number;
				responseId?: string;
				provider: string;
				model: string;
			};
	  }
	| {
			kind: "auto-retry";
			status: "superseded";
			attempt: number;
			recovery: AssistantRetryRecoveryKind;
			note: string;
	  };

export interface ContextSnapshot {
	promptTokens: number; // authoritative provider prompt/input tokens
	nonMessageTokens: number; // estimated non-message total at send time
	/**
	 * Estimated tool-schema tokens included in `nonMessageTokens` (0 when the
	 * model defers schemas server-side). Lets a later model whose schema policy
	 * differs rebase the provider anchor instead of inheriting its schemas.
	 */
	toolSchemaTokens?: number;
	/** Estimated prompt tokens removed by local history rewrites after this provider snapshot was recorded. */
	historyRewriteTokensRemoved?: number;
	/**
	 * Compaction epoch current when this snapshot's provider request was recorded.
	 * A later compaction bumps the session epoch, so an anchor whose epoch is
	 * older than the current in-flight snapshot describes pre-compaction history
	 * and must not override the rebased estimate.
	 */
	compactionEpoch?: number;
	lastMessageTimestamp?: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: (
		| TextContent
		| ThinkingContent
		| RedactedThinkingContent
		| AnthropicFallbackContent
		| AnthropicServerToolContent
		| ImageContent
		| ToolCall
	)[];
	api: Api;
	provider: Provider;
	model: string;
	/** Stored credential row that produced this turn; absent for external or unknown keys. */
	credentialId?: number;
	contextSnapshot?: ContextSnapshot;
	retryRecovery?: AssistantRetryRecovery;
	responseId?: string; // Provider-specific response/message identifier when the upstream API exposes one
	/**
	 * Name of the upstream provider an aggregator routed this request to, as
	 * reported in the response (e.g. OpenRouter's top-level `provider` field:
	 * `"OpenAI"`, `"Anthropic"`, `"Together"`). Distinct from `provider`, which
	 * is the configured gateway we called (`"openrouter"`). Undefined for direct
	 * providers that expose no such field.
	 */
	upstreamProvider?: string;
	/**
	 * Concrete model that produced this turn when it is knowable independently
	 * of the requested id: reported by a router that selected one, or recovered
	 * from a signed thinking block (Anthropic signatures name the serving
	 * model). Compared against `model` to notice a gateway serving something
	 * other than what was requested.
	 */
	upstreamModel?: string;
	/**
	 * Service tier the provider reported serving this turn, when the API echoes
	 * one (`response.service_tier`), falling back to the tier the request carried
	 * when the response omits the echo. Absent when the provider reports no tier
	 * or the echo cannot be trusted (proxies). This is the tier the turn actually
	 * ran on, which is what cost, premium-request, and speed accounting key on —
	 * the session's live setting may already have changed.
	 */
	serviceTier?: ServiceTier;
	usage: Usage;
	/**
	 * Visible output tokens a history rewrite (shake) has since removed from
	 * `content`. `usage.output` still counts them, so a replay estimate subtracts
	 * them to keep the turn's reasoning without recharging the removed text.
	 */
	elidedOutputTokens?: number;
	stopReason: StopReason;
	stopDetails?: StopDetails | null;
	errorMessage?: string;
	/** Stable recovery-classification text when errorMessage includes display-only diagnostics. */
	errorClassificationMessage?: string;
	/** True only when an exact request-body-read timeout failed on a full Responses replay, not a previous-response delta. */
	requestBodyReadTimeoutFullReplay?: boolean;
	/** Per-tool abort messages used when an aborted assistant turn needs different placeholder results per tool call. */
	toolCallAbortMessages?: Record<string, string>;
	/** HTTP status surfaced by the provider when the request failed. Populated by every provider's catch block alongside `errorMessage` so consumers (auth retry, telemetry, UI) can branch without regex-scraping the message. */
	errorStatus?: number;
	/** Structured machine-readable error classifier; see `utils/error-id.ts` for bit layout and helpers. */
	errorId?: number;
	/**
	 * Stable identifiers for request features the provider silently dropped
	 * during this turn (e.g. `"priority"`). Set when a server-side rejection
	 * triggered an in-provider fallback retry that succeeded without the
	 * feature. Callers can use this to sync user-facing toggles back to the
	 * server's actual state.
	 */
	disabledFeatures?: string[];
	/** Provider-reported input rewrites such as dropped bound-thinking blocks. */
	inputTransformations?: ProviderInputTransformation[];
	/**
	 * Controls an Anthropic request declared, recorded on its response so later
	 * requests over the same transcript replay a byte-identical prefix.
	 */
	requestControls?: AnthropicRequestControls;
	/** Provider-specific opaque payload used to reconstruct transport-native history. */
	providerPayload?: ProviderPayload;
	timestamp: number; // Unix timestamp in milliseconds
	duration?: number; // Request duration in milliseconds
	ttft?: number; // Time to first token in milliseconds
	/** Local wall-clock time the response finished streaming (ms since epoch); stamped by the session at message_end so prompt→yield timing never depends on provider-reported duration. */
	completedAt?: number;
}

export interface ToolResultMessage<TDetails = unknown> {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[]; // Supports text and images
	details?: TDetails;
	isError: boolean;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	/** Timestamp when output was pruned (ms since epoch). Undefined if unpruned. */
	prunedAt?: number;
	/** Provider-native metadata required to faithfully replay this result. */
	providerMetadata?: ToolResultProviderMetadata;
	/**
	 * Tool-declared: this result carried no information worth retaining once
	 * consumed (zero matches, elapsed wait). Compaction passes may elide it.
	 * Never set together with isError.
	 */
	useless?: boolean;
	timestamp: number; // Unix timestamp in milliseconds
}

export type Message = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage;

export type TJsonSchema = Record<string, unknown>;

/**
 * Schema type accepted by the {@link Tool} interface.
 *
 * Canonical authoring uses ArkType. Extension compat may supply a JSON Schema
 * object (including TypeBox static schema objects).
 */
export type TSchema = Type | TJsonSchema;

/** Resolve parameter types for tool execution / handlers. */
export type Static<S> = S extends Type ? S["infer"] : S extends { static: infer T } ? T : unknown;

export interface ToolCallExample<TArgs = Record<string, unknown>> {
	caption?: string;
	call: TArgs;
}
export interface ToolCompareExample<TArgs = Record<string, unknown>> {
	caption?: string;
	bad: TArgs;
	good: TArgs;
}
export interface ToolNoteExample {
	caption: string;
	note?: string;
}
export type ToolExample<TArgs = Record<string, unknown>> =
	| ToolCallExample<TArgs>
	| ToolCompareExample<TArgs>
	| ToolNoteExample;

export interface Tool<TParameters extends TSchema = TSchema> {
	name: string;
	description: string;
	parameters: TParameters;
	/** If true, tool is strictly typed and validated against the parameters schema before execution */
	strict?: boolean;
	/** Withhold this Anthropic tool until a `tool_addition` message references it. */
	deferLoading?: boolean;
	/**
	 * Optional grammar constraint for OpenAI custom-tool emission.
	 * When set, providers that support grammar-constrained tools (currently only
	 * `openai-responses` against models with the right capability flag) may emit
	 * this tool as `{type: "custom", format: {type: "grammar", …}}` instead of a
	 * JSON function tool. Other providers ignore the field.
	 */
	customFormat?: { syntax: "lark" | "regex"; definition: string };
	/**
	 * Optional wire-level name used when this tool is emitted as a custom tool
	 * (e.g. OpenAI's `{type: "custom"}` shape). Models trained on specific tool
	 * names — like GPT-5 on `apply_patch` — need to see that exact name on the
	 * wire, but it may differ from the harness-internal `name`. The agent-loop
	 * dispatcher matches both `name` and `customWireName` so returned tool
	 * calls route correctly. Absent for regular JSON function tools.
	 */
	customWireName?: string;
	/** Selects a provider-native hosted tool instead of a JSON-schema function tool. */
	native?: NativeToolMarker;
	/**
	 * Illustrative calls/notes; the AI layer renders them into an `<examples>`
	 * block in the model's native tool-call syntax and appends to the wire
	 * description. Author `call`/`bad`/`good` as plain argument objects WITHOUT
	 * `i` — when intent tracing injects `i` into the schema, the renderer adds
	 * a placeholder `i` automatically. Type each tool's `examples` against its
	 * own schema (e.g. `readonly ToolExample<typeof schema["type"]>[]`).
	 */
	examples?: readonly ToolExample[];
}

export interface Context {
	systemPrompt?: string[];
	messages: Message[];
	tools?: Tool[];
	/** Definitions of tools the transcript's latest Anthropic request declared but that are no longer in `tools`; only the Anthropic provider reads it. */
	inactiveTools?: Tool[];
}

export type AssistantMessageEvent =
	| { type: "start"; contentIndex?: undefined; partial: AssistantMessage }
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	| { type: "image_end"; contentIndex: number; content: ImageContent; partial: AssistantMessage }
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	| {
			type: "done";
			contentIndex?: undefined;
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			message: AssistantMessage;
	  }
	| {
			type: "error";
			contentIndex?: undefined;
			reason: Extract<StopReason, "aborted" | "error">;
			error: AssistantMessage;
	  };
