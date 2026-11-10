import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { formatModelSelectorValue, parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { formatModelStringWithRouting } from "../config/model-resolver";

/** Configured fallback chains keyed by role or model selector. */
export type RetryFallbackChains = Record<string, string[]>;

/** Policy controlling restoration of a fallback chain's primary model. */
export type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

/**
 * Parsed model selector used by retry fallback resolution. `thinkingLevel`
 * keeps the configured `auto` sentinel; `undefined` means the selector carried
 * no suffix, so the session's configured level applies.
 */
export interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ConfiguredThinkingLevel | undefined;
}

/** Minimal model lookup needed by fallback-chain resolution. */
export interface RetryFallbackModelLookup {
	find(provider: string, id: string): Model | undefined;
	hasProvider(provider: string): boolean;
}

/** Model a session's produced work is attributed to. */
export interface ServingModel {
	/** Full selector including routing and thinking level. */
	selector: string;
	/** Provider/id including routing, with no added thinking suffix. */
	modelIdentity?: string;
	/** Concrete thinking level captured with the attributed model. */
	thinkingLevel?: ThinkingLevel;
	/** Whether fallback routing, rather than the configured primary, owns it. */
	isFallback: boolean;
	/**
	 * Context window of the attributed model, carried verbatim from
	 * {@link Model.contextWindow} (`null` when the model declares none), so
	 * observers size context usage against the model that produced the turn
	 * instead of the one the run started on.
	 */
	contextWindow?: number | null;
}

const RETRY_BACKOFF_MAX_DELAY_MS = 8_000;

const RETRY_BACKOFF_JITTER_RATIO = 0.25;

/** Calculates capped exponential retry delay with downward jitter. */
export function calculateRetryBackoffDelayMs(baseDelayMs: number, attempt: number): number {
	const cappedDelayMs = Math.min(Math.max(0, baseDelayMs) * 2 ** Math.max(0, attempt - 1), RETRY_BACKOFF_MAX_DELAY_MS);
	const jitter = 1 - Math.random() * RETRY_BACKOFF_JITTER_RATIO;
	return cappedDelayMs * jitter;
}

/** Parses a configured retry fallback selector. */
export function parseRetryFallbackSelector(
	selector: string,
	modelLookup?: Pick<RetryFallbackModelLookup, "find">,
): RetryFallbackSelector | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const parsed = parseModelString(trimmed, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) => modelLookup?.find(provider, id) !== undefined,
	});
	if (!parsed) return undefined;
	return {
		raw: trimmed,
		provider: parsed.provider,
		id: parsed.id,
		thinkingLevel: parsed.thinkingLevel,
	};
}

/** Formats a concrete model and thinking level as a fallback selector. */
export function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
	return formatModelSelectorValue(formatModelStringWithRouting(model), thinkingLevel);
}

/** Formats the model-only portion of a parsed fallback selector (`provider/id`, no thinking level). */
export function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}

/**
 * A dynamic role pinned to one model selector with its own fallback chain.
 * Subagents own one under `subagent:<id>`; `session_init` persists it so cold
 * revival restores the same routing the spawn installed.
 */
export interface RetryFallbackRole {
	/** Selector the role is assigned (the chain's primary). */
	primary: string;
	/** Fallback selectors walked after the primary; empty explicitly disables fallbacks. */
	chain: string[];
}
