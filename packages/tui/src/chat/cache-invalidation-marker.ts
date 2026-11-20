import type { Usage } from "@oh-my-pi/pi-ai";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { MessageDividerComponent } from "../chrome/message-divider";
import { theme } from "../theme";

/**
 * Minimum prefix the previous turn must have READ back from cache before a
 * collapse on the current turn counts as an invalidation. Filters out tiny
 * contexts and providers below the cacheable-prefix floor, where a zero
 * `cacheRead` is expected rather than a reset.
 */
const MIN_CACHE_FOOTPRINT = 2048;

/** A prompt-cache invalidation detected from a turn's usage. */
export interface CacheInvalidation {
	/** Prompt tokens the cold turn had to (re)process instead of reading from cache. */
	reprocessedTokens: number;
}

export function detectCacheInvalidation(prev: Usage | undefined, current: Usage): CacheInvalidation | undefined {
	if (!prev) return undefined;
	// Only flag a warm→cold transition: the previous turn must have actually read
	// a meaningful prefix from cache. A write-only predecessor (first request, or
	// a re-write after expiry) has not proven the cache is live, so a cold turn
	// behind it is expected — not an invalidation worth surfacing.
	if (prev.cacheRead < MIN_CACHE_FOOTPRINT) return undefined;
	// The prefix survived when this turn read back at least half of what the
	// previous one did; normal turns read all of it plus the previous write.
	if (current.cacheRead * 2 >= prev.cacheRead) return undefined;
	// Only an explicit, prefix-controlled cache re-creates the prefix on a cold
	// turn — Anthropic/Bedrock report that as `cacheWrite`. Implicit best-effort
	// caches (Google/OpenAI/Fireworks) report `cacheWrite: 0` and drop `cacheRead`
	// to zero intermittently as propagation noise, not a real invalidation.
	if (current.cacheWrite <= 0) return undefined;
	const reprocessedTokens = current.cacheWrite + current.input;
	if (reprocessedTokens < MIN_CACHE_FOOTPRINT) return undefined;
	return { reprocessedTokens };
}

/**
 * Slim left-aligned divider rendered after an assistant turn whose request lost
 * the prompt cache. It trails streamed content because usage arrives at message
 * end, after completed rows may already be in native history.
 *
 * Mirrors the compaction divider's banner styling but spans only a short rule
 * plus label (not the full width) and carries no expandable detail:
 *
 *   ────────── ⊘ cache miss · 50.9k tokens
 */
export class CacheInvalidationMarkerComponent extends MessageDividerComponent {
	constructor(info: CacheInvalidation) {
		super({
			label: () => {
				const icon = theme.icon.cacheMiss;
				const head = icon ? `${icon} cache miss` : "cache miss";
				const tokens = info.reprocessedTokens;
				return tokens > 0 ? `${head} ${theme.sep.dot.trim()} ${formatNumber(tokens)} tokens` : head;
			},
			labelColor: "muted",
			ruleColor: "dim",
			ruleWidth: 10,
			role: "omp.marker.cache-miss",
			native: {
				icon: "database",
				label: () =>
					info.reprocessedTokens > 0
						? `Cache miss · ${formatNumber(info.reprocessedTokens)} tokens`
						: "Cache miss",
			},
			// Too narrow to frame — preserve the legacy bare label.
			truncateWhenNarrow: false,
		});
	}
}
