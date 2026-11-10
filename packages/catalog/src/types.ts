import type { Effort } from "./effort";

export type { FetchImpl } from "@oh-my-pi/pi-utils";

/** The sole supported request protocol. Other strings may appear in old transcripts. */
export type KnownApi = "openai-completions";
export type Api = KnownApi | (string & {});
export type KnownProvider = string;
export type Provider = string;
export const MODEL_KINDS = ["chat"] as const;
/** Historical metadata may name a retired kind; executable models must be chat. */
export type ModelKind = "chat" | (string & {});

export function modelKind(model: Pick<Model, "kind">): ModelKind {
	return model.kind ?? "chat";
}

export function apiServesKind(api: Api, kind: ModelKind): boolean {
	return api === "openai-completions" && kind === "chat";
}

export function servedKinds(api: Api): readonly ModelKind[] {
	return api === "openai-completions" ? MODEL_KINDS : [];
}

export type ThinkingControlMode = "effort";
export interface ThinkingConfig {
	mode: ThinkingControlMode;
	efforts: readonly Effort[];
	defaultLevel?: Effort;
	effortMap?: Partial<Record<Effort, string>>;
	requiresEffort?: boolean;
	unverified?: boolean;
}
export type ThinkingBudgets = { [key in Effort]?: number };

/** Explicit endpoint capabilities; no provider or model-name inference applies. */
export interface OpenAICompat {
	supportsDeveloperRole?: boolean;
	supportsUsageInStreaming?: boolean;
	supportsStrictMode?: boolean;
	maxTokensField?: "max_tokens" | "max_completion_tokens";
	supportsStore?: boolean;
}
export type ResolvedOpenAICompat = OpenAICompat;
export type CompatConfigOf<_TApi extends Api> = OpenAICompat;
export type CompatOf<_TApi extends Api> = OpenAICompat;

/** Optional descriptive identity from a historical record; never used for routing. */
export interface ModelIdentity {
	class: string;
	family?: string;
	revision?: string;
}

export interface Usage {
	/** Non-cached conversation input tokens (matches the bucket the provider bills as new input). */
	input: number;
	/** Total conversation output tokens for the turn, including thinking, assistant text, and tool-call argument tokens. */
	output: number;
	/** Conversation tokens read from the prompt cache. */
	cacheRead: number;
	/** Conversation tokens written to the prompt cache (cache creation). */
	cacheWrite: number;
	/** Sum of input + output + cacheRead + cacheWrite plus provider-side orchestration tokens when reported. */
	totalTokens: number;
	/** Provider-reported occupied context tokens when the value is authoritative but not a billable input/output bucket. */
	contextTokens?: number;
	/** Provider-side orchestration tokens, billed but not part of the conversation prompt/cache buckets. */
	orchestration?: {
		/** Non-cached orchestration input tokens. */
		input?: number;
		/** Orchestration tokens read from provider-side cache. */
		cacheRead?: number;
		/** Orchestration output tokens. */
		output?: number;
	};
	/** Copilot premium-request counter, when applicable. */
	premiumRequests?: number;
	/**
	 * Reasoning/thinking tokens included in `output`, when the provider reports them
	 * (OpenAI `output_tokens_details.reasoning_tokens`, Google `thoughtsTokenCount`).
	 * Always a subset of `output` — non-reasoning output is `output - reasoningTokens`.
	 *
	 * Providers that don't expose this leave it undefined rather than guessing;
	 * `undefined` means unknown, NOT zero.
	 */
	reasoningTokens?: number;
	/**
	 * Cache-write TTL breakdown (Anthropic only). When set, the components sum to
	 * `cacheWrite`. Absent providers do not populate this.
	 */
	cttl?: {
		ephemeral5m?: number;
		ephemeral1h?: number;
	};
	/**
	 * Server-side tool invocations made during this turn (Anthropic web_search /
	 * web_fetch, OpenAI built-in tools when reported). Counts requests, not tokens.
	 */
	server?: {
		webSearch?: number;
		webFetch?: number;
	};
	/** Provider-reported credit meter values for credit-based billing APIs. */
	credits?: {
		/** Uncommitted per-response credit cost, when reported. */
		cost?: number;
		/** Final committed credit cost, when reported. */
		committedCost?: number;
		/** Final committed ACU cost, when reported. */
		acuCost?: number;
	};
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface TokenCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** User-facing interpretation of a model's token-rate card. */
export type ModelPricingStatus = "fixed" | "free" | "included" | "variable" | "unknown";

/**
 * Rates applied to the full request when its prompt exceeds `inputThreshold`,
 * or reaches it when `inputThresholdInclusive` is true. Prompt input is the
 * sum of uncached, cached-read, cache-write, and provider-orchestration input
 * tokens.
 */
export interface LongContextTokenCost extends TokenCost {
	inputThreshold: number;
	/** Whether the long-context tier starts exactly at `inputThreshold`. */
	inputThresholdInclusive?: boolean;
}

/** Recurring UTC peak interval; weekdays use Sunday = 0, and the end is exclusive. */
export interface PeakPricingWindow {
	weekdays: readonly number[];
	startMinute: number;
	endMinute: number;
}

/** Complete replacement rate card effective from a Unix-millisecond timestamp. */
export interface EffectiveTokenCost extends TokenCost {
	effectiveFrom: number;
	longContext?: LongContextTokenCost;
}

/** Scheduled discounts applied after selecting the effective rate card and context tier. */
export interface TimeBasedCost {
	offPeakMultiplier: number;
	peakWindows: readonly PeakPricingWindow[];
	effectiveRates?: readonly EffectiveTokenCost[];
}

/**
 * Best-effort prompt-cache entry lifetime in seconds for each retention tier a
 * request can ask for. A missing tier means the lifetime is unknown; consumers
 * must not schedule cache warming against unknown lifetimes.
 */
export type ModelPromptCache = Partial<Record<"short" | "long", number>>;

/** Base token rates plus optional long-context and time-based pricing. */
export interface ModelCost extends TokenCost {
	longContext?: LongContextTokenCost;
	timeBased?: TimeBasedCost;
}

/**
 * Exact local content tokenizer family for a model.
 *
 * Absent means no first-party local tokenizer is known and consumers count
 * in o200k_base. The values name tokenizer
 * generations rather than providers: DeepSeek V3 through V4 share
 * `"deepseek-v3"`; Kimi K2 through K3 share `"kimi-k2"`.
 */
export type ModelTokenizer =
	| "claude-v3"
	| "claude-v47"
	| "claude-v5"
	| "claude-v5-sonnet"
	| "qwen3"
	| "deepseek-v3"
	| "kimi-k2"
	| "glm5"
	| "cl100k"
	| "o200k";

/** A manually configured endpoint and its explicit capabilities. */
export interface Model<TApi extends Api = Api> {
	id: string;
	name: string;
	provider: Provider;
	api: TApi;
	baseUrl: string;
	kind?: ModelKind;
	identity: ModelIdentity;
	reasoning: boolean;
	thinking?: ThinkingConfig;
	input: ("text" | "image")[];
	contextWindow: number | null;
	maxContextWindow?: number;
	maxTokens: number | null;
	cost: ModelCost;
	pricingStatus?: Exclude<ModelPricingStatus, "fixed">;
	supportsTools?: boolean;
	tokenizer?: ModelTokenizer;
	imageInputDecoder?: "stb";
	imageCountBudget?: number;
	omitMaxOutputTokens?: boolean;
	headers?: Record<string, string>;
	resolveHeaders?: (signal?: AbortSignal) => Promise<Record<string, string> | undefined>;
	promptCache?: ModelPromptCache;
	compat: OpenAICompat;
	compatConfig?: OpenAICompat;
	serviceTiers?: readonly string[];
	serviceTierCost?: Readonly<Partial<Record<"flex" | "priority" | "ultrafast", number>>>;
	description?: string;
	priority?: number;
	int?: number | null;
	tps?: number | null;
}

/** Required endpoint identity plus optional manually declared capabilities. */
export interface ModelSpec<TApi extends Api = Api> extends Partial<Omit<Model<TApi>, "id" | "provider" | "baseUrl">> {
	id: string;
	provider: string;
	baseUrl: string;
}
