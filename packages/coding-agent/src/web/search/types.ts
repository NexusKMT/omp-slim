import type { SearchProviderId, SearchResponse } from "@oh-my-pi/pi-tui/tools/web-search-types";

export * from "@oh-my-pi/pi-tui/tools/web-search-types";

/** One provider that failed before another answered, or before the search gave up. */
export interface SearchFailureDetail {
	/** HTTP search engine id, such as `brave` or `exa`. */
	provider: string;
	label: string;
	/** Flattened, length-capped reason, as the LLM-facing fallback note quotes it. */
	reason: string;
	/** HTTP-style status the provider error carried (204 marks a sourceless answer, e.g. a refusal). */
	status?: number;
}

export interface SearchResultDetails {
	response: SearchResponse;
	error?: string;
	/** Providers that failed, in chain order; absent when the first candidate answered. */
	failures?: SearchFailureDetail[];
}

/** Default hard timeout for each web-search provider transport. */
export const DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS = 60;

/** Maximum configurable hard timeout for each web-search provider transport. */
export const MAX_WEB_SEARCH_TIMEOUT_SECONDS = 300;

/** HTTP search engines. */
export type SearchEngineId = SearchProviderId;

/** Provider-specific error with optional HTTP status */
export class SearchProviderError extends Error {
	constructor(
		public readonly provider: SearchProviderId,
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "SearchProviderError";
	}
}
